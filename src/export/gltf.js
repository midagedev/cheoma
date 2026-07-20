import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// ─────────────────────────────────────────────────────────────────────────
// glTF(.glb) 익스포트 (#104)
//
//   exportGLB(target, opts) → Promise<ArrayBuffer | GuidanceObject>
//     target ① buildParcel/buildBuilding 결과(단일 건물 + 마당)
//            ② populateVillage() root(마을 전체)
//   반환은 성공 시 ArrayBuffer(.glb). 삼각형 예산 초과 시엔 던지지 않고(에러 대신)
//   { overBudget:true, ... } 안내 객체를 반환한다 — 호출부는 `r instanceof ArrayBuffer` 로 분기.
//
// 좌표 규약: 앱과 동일하게 미터 단위·Y-up·+z=남(South). glTF 도 Y-up 이라 좌표계 변환 없이 그대로
//   내보낸다(문서화만) — DCC/뷰어에서 방위를 읽을 땐 +z 가 남쪽임에 유의.
//
// three(GLTFExporter) 특성상 자동으로 처리되는 것 / 우리가 처리해야 하는 것:
//   · canvas 절차 텍스처(CanvasTexture, image=HTMLCanvasElement) → processImage 가 drawImage 로
//     네이티브 임베드. 별도 toDataURL 전처리 불필요(단, DOM 필요 → 브라우저 컨텍스트에서 실행).
//   · onBeforeCompile 셰이더 확장(림/계절/적설/수면) → 익스포터는 표준 PBR 속성만 직렬화하므로
//     자동으로 base PBR 로만 나간다. 방어적으로 클론 재질에서 onBeforeCompile/customProgramCacheKey 제거.
//   · InstancedMesh(공포·마을 집) → EXT_mesh_gpu_instancing 플러그인이 기본 등록되어 네이티브 지원.
//     instanceColor 는 확장의 _COLOR_0 로 나간다(three GLTFLoader 는 복원, 일부 외부 뷰어는 미지원).
//   · userData(role 태그·layout·materials 등) → serializeUserData 가 extras 로 새어 나가고 무거운
//     THREE 객체는 JSON 직렬화 경고를 낸다 → 클론 노드/재질의 userData 를 비운다.
// ─────────────────────────────────────────────────────────────────────────

// 연출(staging) 오브젝트 — 항상 제외. 대부분은 어댑터/엔진이 씬에 붙이므로 populate root 엔 없지만
//   방어적으로 이름 필터. 입자/스프라이트/라인은 타입으로도 잡는다.
const STAGING_NAME_RE = /^(skyDome|moon|clouds|edge-mist-ring|ridge-mist|focusRing|worldedge|village-nightlights|nightlight-points|flare|lensflare|dust|motes|lanternGlow)/;
// 지형·물·논 — opts.includeTerrain 게이트(기본 true).
const TERRAIN_NAME_RE = /^(village-terrain|village-stream|village-paddies)$/;
// 수목·정원·소동물 — opts.includeScenery(=pretty) 게이트(기본 true).
const SCENERY_NAME_RE = /^(trees|village-flora|animals|cow)$/;
// 원경 청크 임포스터(저폴리 박스 매스) — 항상 제외.
const IMPOSTOR_NAME_RE = /^impostor-/;
// 숨겨둔 풀디테일 청크(visible=false) — opts.fullDetail 이면 승격(실지오 확보).
const CHUNK_FULL_RE = /^chunk-full-/;

const DEFAULTS = {
  binary: true,           // true → .glb(ArrayBuffer), false → glTF JSON 객체
  includeTerrain: true,   // 지형 메시 + 개울 + 논
  includeScenery: true,   // 수목·정원·보호수·소동물 (pretty 의 실질)
  pretty: true,           // includeScenery 의 별칭(true 면 수목/정원/동물 포함). false 면 건축+지형만.
  fullDetail: true,       // 원경 청크 숨은 풀디테일을 승격(임포스터 대신 실지오). 완전한 마을.
  instancing: 'gpu',      // 'gpu'(EXT_mesh_gpu_instancing, 작은 파일·instanceColor 보존)
                          //   | 'bake'(인스턴스를 개별 노드로 전개, 범용 호환·instanceColor 소실)
  maxTriangles: 3_000_000, // 유효(전개) 삼각형 상한. 초과 시 GLB 를 만들지 않고 안내 반환.
};

// ── 한 메시의 유효(전개) 삼각형 수: 인스턴스는 base × count. ─────────────────
function meshTriangles(mesh) {
  const g = mesh.geometry;
  if (!g) return 0;
  const idx = g.getIndex();
  const posAttr = g.getAttribute('position');
  const baseTris = idx ? idx.count / 3 : (posAttr ? posAttr.count / 3 : 0);
  const count = mesh.isInstancedMesh ? mesh.count : 1;
  return baseTris * count;
}

// ── 노드 분류: 'skip' | 'keep' | 'keep-hidden'(승격된 숨은 청크) ─────────────
function classify(node, opts) {
  const name = node.name || '';
  if (node.isPoints || node.isSprite || node.isLine || node.isLineSegments) return 'skip';
  if (IMPOSTOR_NAME_RE.test(name)) return 'skip';
  if (STAGING_NAME_RE.test(name)) return 'skip';
  if (node.visible === false) {
    // 숨은 노드는 기본 제외. 단 원경 청크 풀디테일은 fullDetail 이면 승격(실지오).
    if (opts.fullDetail && CHUNK_FULL_RE.test(name)) return 'keep-hidden';
    return 'skip';
  }
  if (TERRAIN_NAME_RE.test(name)) return opts.includeTerrain ? 'keep' : 'skip';
  if (SCENERY_NAME_RE.test(name)) return opts.includeScenery ? 'keep' : 'skip';
  return 'keep';
}

// ── 재질 정화: 원본을 훼손하지 않고 userData·셰이더 확장을 털어낸 base PBR 클론.
//    원본↔클론 1:1 캐시로 dedup(익스포터 재질 캐시가 uuid 기준)을 보존한다.
function cleanMaterial(material, cache) {
  if (Array.isArray(material)) return material.map((m) => cleanMaterial(m, cache));
  if (!material) return material;
  if (cache.has(material)) return cache.get(material);
  const c = material.clone();          // 새 uuid. map/텍스처 참조는 공유 → 이미지 임베드 dedup 유지.
  c.userData = {};                     // role/hanjiGlow 등 태그 제거(extras 누출 차단).
  c.onBeforeCompile = () => {};        // 셰이더 확장 무력화(익스포터는 무시하지만 방어적).
  c.customProgramCacheKey = undefined;
  cache.set(material, c);
  return c;
}

// ── 인스턴스 베이크: InstancedMesh → 지오/재질 공유 개별 Mesh N개(instanceColor 소실).
//    지오·재질을 공유하므로 GLB 는 지오를 1회만 저장(노드 N개). 예산 가드 이후에만 호출.
function bakeInstanced(node, matCache) {
  const g = new THREE.Group();
  const mat = cleanMaterial(node.material, matCache);
  const m = new THREE.Matrix4();
  for (let i = 0; i < node.count; i++) {
    node.getMatrixAt(i, m);
    const mesh = new THREE.Mesh(node.geometry, mat);
    mesh.applyMatrix4(m);              // 인스턴스 로컬 변환을 노드 변환으로.
    g.add(mesh);
  }
  return g;
}

// ── 순회 재구성: 필터를 통과한 노드만 새 경량 트리로 복제(지오는 참조 공유).
//    clone(true) 를 피하는 이유: Object3D.copy 가 userData 를 JSON 왕복 복제하는데
//    building.userData.materials/layout 에 THREE 객체가 있어 무겁고 위험하다.
function sanitize(node, opts, matCache) {
  const verdict = classify(node, opts);
  if (verdict === 'skip') return null;

  let out;
  if (node.isInstancedMesh) {
    if (opts.instancing === 'bake') {
      out = bakeInstanced(node, matCache);
    } else {
      const im = new THREE.InstancedMesh(node.geometry, cleanMaterial(node.material, matCache), node.count);
      im.instanceMatrix = node.instanceMatrix;             // 읽기 전용 공유.
      if (node.instanceColor) im.instanceColor = node.instanceColor;
      out = im;
    }
  } else if (node.isMesh) {
    out = new THREE.Mesh(node.geometry, cleanMaterial(node.material, matCache));
  } else {
    out = new THREE.Group();
  }

  out.name = node.name || '';
  // 로컬 변환 보존(계층 유지 → world 는 부모 체인으로 재구성). trs=false 익스포트는 matrix 를
  //   쓰고 matrixAutoUpdate=true 면 pos/quat/scale 로 재계산하므로 이 셋만 복사하면 충분.
  out.position.copy(node.position);
  out.quaternion.copy(node.quaternion);
  out.scale.copy(node.scale);
  // userData 는 의도적으로 비운 채 유지(extras 누출 방지).

  for (const child of node.children) {
    const c = sanitize(child, opts, matCache);
    if (c) out.add(c);
  }

  // 빈 그룹(메시 없는 껍데기)은 제거해 출력 정돈.
  if (!node.isMesh && !node.isInstancedMesh && out.children.length === 0) return null;
  return out;
}

// ── 사전 분석(경량 순회): 노드/지오 생성 없이 유효 삼각형·메시·재질 수를 센다.
//    bake 전개 전에 예산 가드를 걸기 위한 값(전개하면 hanyang 규모는 노드 폭발).
export function analyzeExport(target, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.pretty === false) o.includeScenery = false;
  let triangles = 0, meshes = 0, instanced = 0, instanceCount = 0;
  const mats = new Set();
  const walk = (node) => {
    const verdict = classify(node, o);
    if (verdict === 'skip') return;
    if (node.isMesh || node.isInstancedMesh) {
      const t = meshTriangles(node);
      // 빈 지오(삼각형 0) 메시는 익스포터가 노드를 만들지 않으므로 카운트에서 제외 —
      //   라운드트립 메시 수와 일치시키기 위함.
      if (t > 0) {
        triangles += t;
        meshes += 1;
        if (node.isInstancedMesh) { instanced += 1; instanceCount += node.count; }
        // glTF 재질 수는 익스포터 캐시 키 규칙과 동일하게 센다: normalMap 재질은 지오의 tangent
        //   유무별로 갈라져 별개 glTF 재질이 된다(GLTFExporter.processMaterialAsync cacheKey).
        //   cleanMaterial 클론은 uuid 만 바꿀 뿐 normalMap·지오 공유라 키 개수는 원본과 동일.
        const geo = node.geometry;
        const hasTangent = !!(geo && geo.hasAttribute && geo.hasAttribute('tangent'));
        const mm = Array.isArray(node.material) ? node.material : [node.material];
        for (const m of mm) if (m) mats.add(m.normalMap ? m.uuid + ':' + hasTangent : m.uuid);
      }
    }
    for (const c of node.children) walk(c);
  };
  walk(target);
  return { triangles, meshes, instancedMeshes: instanced, instances: instanceCount, materials: mats.size, limit: o.maxTriangles };
}

// ── 익스포트용 정화 씬(연출 제외·재질/userData 정화·인스턴싱 모드 반영)을 THREE.Group 으로 반환.
//    exportGLB 가 내부적으로 쓰지만, 미리보기·커스텀 파이프라인용으로도 공개한다.
export function buildExportScene(target, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.pretty === false) o.includeScenery = false;
  if (!target) throw new Error('buildExportScene: target 이 없습니다');
  target.updateMatrixWorld(true);
  const matCache = new Map();
  const root = sanitize(target, o, matCache);
  if (!root) throw new Error('buildExportScene: 익스포트할 지오가 없습니다(전부 필터됨)');
  return root;
}

// ── 프레임 양보(#117): 마을 전체(수백 노드)를 한 번에 정화하면 메인스레드가 통째로 멈춘다(부감
//    마을 익스포트 ~0.6s 블록). sanitize 를 노드 예산 단위로 끊어 requestAnimationFrame 사이사이
//    양보하면 rAF·입력·베일 애니가 살아있는 채로 트리가 재구성된다. 출력 트리·순서·재질 dedup 은
//    동기 sanitize 와 완전 동일(같은 재귀 순서, 같은 matCache) — GLB 바이트 동일성 보존.
function nextFrame() {
  if (typeof requestAnimationFrame === 'function') return new Promise((r) => requestAnimationFrame(() => r()));
  return new Promise((r) => setTimeout(r, 0));
}
async function sanitizeChunked(node, opts, matCache, budget) {
  const verdict = classify(node, opts);
  if (verdict === 'skip') return null;

  let out;
  if (node.isInstancedMesh) {
    if (opts.instancing === 'bake') {
      out = bakeInstanced(node, matCache);
    } else {
      const im = new THREE.InstancedMesh(node.geometry, cleanMaterial(node.material, matCache), node.count);
      im.instanceMatrix = node.instanceMatrix;
      if (node.instanceColor) im.instanceColor = node.instanceColor;
      out = im;
    }
  } else if (node.isMesh) {
    out = new THREE.Mesh(node.geometry, cleanMaterial(node.material, matCache));
  } else {
    out = new THREE.Group();
  }

  out.name = node.name || '';
  out.position.copy(node.position);
  out.quaternion.copy(node.quaternion);
  out.scale.copy(node.scale);

  // 노드 예산 소진 시 다음 프레임으로 양보(자식 순회 전에 검사해 깊은 서브트리도 균등 분할).
  if (--budget.left <= 0) { budget.left = budget.size; await nextFrame(); }

  for (const child of node.children) {
    const c = await sanitizeChunked(child, opts, matCache, budget);
    if (c) out.add(c);
  }

  if (!node.isMesh && !node.isInstancedMesh && out.children.length === 0) return null;
  return out;
}

// ── 메인 익스포트. 성공 시 ArrayBuffer(binary) / glTF JSON(binary:false),
//    예산 초과 시 안내 객체(overBudget).
export async function exportGLB(target, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.pretty === false) o.includeScenery = false;
  if (!target) throw new Error('exportGLB: target 이 없습니다');

  target.updateMatrixWorld(true);

  const stats = analyzeExport(target, o);
  if (stats.triangles > o.maxTriangles) {
    return {
      overBudget: true,
      triangles: stats.triangles,
      limit: o.maxTriangles,
      meshes: stats.meshes,
      instances: stats.instances,
      suggestions: [
        `maxTriangles 를 ${stats.triangles} 이상으로 올려 강제 익스포트`,
        'pretty:false (수목·정원·소동물 제외)로 삼각형 축소',
        'fullDetail:false (원경 청크 제외)로 근경만 익스포트',
        'includeTerrain:false (지형·물 제외)',
        "instancing:'gpu' 유지 — bake 전개는 노드 폭발",
      ],
    };
  }

  // 정화 트리 구성 — 프레임 양보 청킹(#117)으로 큰 마을(수백 노드)의 sanitize(~0.65s)를 여러 프레임에
  //   나눠 rAF·베일 애니를 살린다. 소규모(단일 집)는 예산 안에 끝나 사실상 동기(양보 0회). 출력 트리·
  //   순서·재질 dedup 은 동기 sanitize 와 동일 → GLB 바이트 불변. (익스포트 총시간의 대부분은
  //   GLTFExporter.parseAsync 의 동기 이미지 임베딩·버퍼 패킹으로, 그건 애드온 내부라 여기서 청킹 불가.)
  const matCache = new Map();
  const root = await sanitizeChunked(target, o, matCache, { left: o.chunkNodes || 500, size: o.chunkNodes || 500 });
  if (!root) throw new Error('exportGLB: 익스포트할 지오가 없습니다(전부 필터됨)');

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, {
    binary: o.binary,
    onlyVisible: true,       // 남은 숨은 노드(있다면) 제외.
    trs: false,
    includeCustomExtensions: false,
    maxTextureSize: o.maxTextureSize || Infinity,
  });
  return result;             // binary:true → ArrayBuffer, false → glTF JSON 객체.
}

// ── 파일명 규약: cheoma-<kind>[-<변형>].glb ──────────────────────────────────
//    단일 건물: cheoma-building-<style>.glb / 필지: cheoma-parcel-<style>.glb
//    마을:      cheoma-village-<scale>.glb
export function filenameFor(target, ext = 'glb') {
  const name = (target && target.name) || '';
  const ud = (target && target.userData) || {};
  let base = 'cheoma-model';
  let m;
  if ((m = /^village-(.+)$/.exec(name))) base = m[1] === 'village' ? 'cheoma-village' : `cheoma-village-${m[1]}`;
  else if ((m = /^parcel-(.+)$/.exec(name))) base = `cheoma-parcel-${m[1]}`;
  else if (name === 'building') base = `cheoma-building-${ud.layout ? (ud.style || 'giwa') : 'giwa'}`;
  else if ((m = /^hero-(.+)$/.exec(name))) base = `cheoma-hero-${m[1]}`;
  else if (name) base = `cheoma-${name}`;
  return `${base}.${ext}`;
}

// ── 브라우저 다운로드 트리거(앱 배선 편의). ArrayBuffer → Blob('model/gltf-binary').
//    앱은 이 헬퍼를 import 하거나 자체 배선해도 된다(배선 명세는 보고 참조).
export function triggerDownload(buffer, filename) {
  const blob = buffer instanceof ArrayBuffer
    ? new Blob([buffer], { type: 'model/gltf-binary' })
    : new Blob([JSON.stringify(buffer)], { type: 'model/gltf+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'cheoma-model.glb';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke 는 클릭 처리 후 지연.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
