// 마을 리롤 웨이브 연출(#56) — 프레임워크 무관 ES 모듈(코어).
//
//   createRerollWave({ oldRoot, newRoot, center, heightAt, seed, duration }) →
//     { update(dt) → progress, seek(t01), isDone(), cancel(), dispose(), duration, progress }
//
// 리롤(새 시드) 순간을 3막으로 연출한다:
//   ① 해체  기존 마을이 중심에서 바깥으로 좌르르륵 사라진다(집=인스턴스 단위 방사 스태거).
//           두부 물리 역재생 — 제자리에서 눌렸다 접히며 지면으로 오므라들어 사라진다(산산이 아님).
//   ② 지형  옛 지형·개울·논·도로·기단·담이 페이드아웃, 새 지형이 페이드인(크로스페이드/재생성).
//   ③ 조립  새 마을이 중심에서 방사형으로 주루루룩 솟는다(밖으로 퍼지는 웨이브, 두부 스쿼시 안착).
//
// 웨이브 단위(방사 스태거 딜레이 = 중심에서의 반경 거리):
//   · 정규 주택 = **인스턴스 단위**. #47 청크(링×섹터)는 ≤70호면 단일 청크라 청크 단위로는 소규모에서
//     리플이 안 생긴다 → 청크 안 InstancedMesh 의 인스턴스마다 제 반경으로 스태거해 25호에서도 340호에서도
//     한 채씩 물결친다. 인스턴스 행렬(instanceMatrix)만 트랜스폼(지오 재생성·드로우콜 증가 없음).
//   · 원경 임포스터(far) 청크·랜드마크(궁·절·정자)·히어로(종가) 그룹·성곽·시전 = **그룹 단위**(제 바운딩
//     중심 반경으로 스태거). 병합/월드좌표 그룹이라 그룹 트랜스폼(pivot=바운딩 하단)만으로 솟게 한다.
//   · 담장·기단·도로·논·지형·개울·물안개 = 지면 확립 레이어(크로스페이드, 트랜스폼 아님). 수목·정원·야경
//     발광은 건물 웨이브에 맞춰 페이드(집과 함께 사라지고 집과 함께 돋는다).
//
// 이징 언어는 조립 애니(src/anim/assembly.js)의 두부 물리(tofuScale/tofuBob)를 그대로 재사용한다
// — 수묵 정적 위에 통통 튀는 두부 대비가 이 앱의 시그니처(assembly-semantic-chunks). 낙하/착지
// 문법(fallOffset·IMPACT)은 동일 상수로 로컬 재현(assembly.js 는 미export).
//
// 결정론: 인스턴스·그룹별 미세 스태거 지터는 seed 기반 makeRng(Math.random 미사용).
// 원상복구: dispose()·완료 시 newRoot 를 완전 정상 상태(트랜스폼 항등·재질 플래그 원복)로 되돌려
// 픽킹·편집·env 전파가 곧바로 정상 동작한다.

import * as THREE from 'three';
import { tofuScale, tofuBob } from '../anim/assembly.js';
import { waveFadeController } from '../core/lod.js';
import { isSharedResource } from '../core/three-resources.js';
import { makeRng } from '../rng.js';

// ── 이징(assembly.js 와 동일 상수) ──
const IMPACT = 0.5;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
// 낙하 오프셋 계수(1→0): 착지(IMPACT)까지 감속하며 내려앉고, 이후 0.
const fallOffset = (u) => (u >= IMPACT ? 0 : 1 - easeOutCubic(u / IMPACT));

// ── 타임라인 윈도(전체 progress 0..1 대비 구간) ──
//   해체 → (지형 크로스페이드) → 조립. 구간이 살짝 겹쳐 흐름이 끊기지 않는다.
const PH = {
  disasm:    [0.00, 0.42],   // 옛 집·랜드마크 방사 해체(중심→밖)
  decorOut:  [0.02, 0.40],   // 옛 수목·정원·야경 페이드아웃(집과 함께)
  groundOut: [0.30, 0.58],   // 옛 지형·개울·논·도로·기단·담 페이드아웃
  groundIn:  [0.40, 0.66],   // 새 지형·개울·논·도로·기단·담 페이드인
  asm:       [0.55, 1.00],   // 새 집·랜드마크 방사 조립(중심→밖)
  decorIn:   [0.62, 0.98],   // 새 수목·정원·야경 페이드인(집 뒤따라)
};

// 방사 스태거: 반경 정규화값(0=최내곽,1=최외곽)에 이 비율만큼 시작 시각을 벌린다. 나머지(1-SPREAD)는
//   개별 유닛 애니 길이 → 중심 유닛이 끝나갈 즈음 외곽 유닛이 시작하며 웨이브가 밖으로 흐른다.
//   반경은 루트 전체의 [rmin,rmax] 로 정규화한다(0=중심 집·1=최외곽 집) — 집이 중앙 광장을 두른
//   링 배치라 절대반경 편차가 작아도 스태거를 스케줄 전폭에 펼쳐 25호에서도 물결이 또렷하다.
const SPREAD = 0.72;
const JITTER = 0.05;         // 유닛별 결정론 미세 지터(기계적 균일함 완화)

// 낙하 거리·두부 진폭(assembly.js PART_DROP/PART_TOFU 계열 감성).
const HOUSE_DROP = 2.4, HOUSE_TOFU = 0.26;
const GROUP_DROP = 3.2, GROUP_TOFU = 0.30;
// 조립 초입 등장 스케일 하한(0 스케일 행렬=퇴화 방지, 사실상 비가시).
const GS_MIN = 0.02;

const phaseLocal = (t, [a, b]) => clamp01((t - a) / (b - a));

// ── 루트 자식 분류(이름 규약 기반) ──
const isChunk = (n) => n.startsWith('village-chunk-');
const isWalls = (n) => n.startsWith('village-walls-');
const GROUND_NAMES = new Set([
  'village-terrain', 'village-stream', 'edge-mist-ring', 'ridge-mist',
  'village-pads', 'village-roads', 'village-paddies',
]);
const DECOR_NAMES = new Set(['village-trees', 'village-flora', 'village-nightlights']);
const GROUP_NAMES = new Set(['village-landmarks', 'village-sijeon', 'city-wall', 'city-wall-work']);
// 어댑터가 populate 뒤 붙이는 헬퍼(편집 오버레이·하이라이트) — 웨이브 대상 아님.
const SKIP_NAMES = new Set(['village-overrides', 'village-highlight']);

// 재질 페이드 컨트롤러 — 대상 하위 트리 재질의 opacity 를 램프한다(트랜스폼 아님).
//   pads·등롱처럼 모듈 수명 재질을 구/신 마을이 함께 쓰는 경우가 있다. 원본 opacity 를 직접 쓰면
//   뒤에 적용한 new fade가 old 쪽까지 덮어쓰므로, 서로 다른 fade phase에서 실제로 겹치는 재질만
//   루트별 임시 clone으로 격리한다. 나머지는 원본을 유지해 핸들의 계절·시간대 업데이트 경로를 보존한다.
function splitFadeObjects(objs) {
  const owned = [];
  const staticObjs = [];
  for (const o of objs) {
    const controller = waveFadeController(o);
    if (controller) owned.push(controller);
    else staticObjs.push(o);
  }
  return { owned, staticObjs };
}

function sharedFadeMaterials(collections) {
  const phases = new Map();
  for (let phase = 0; phase < collections.length; phase++) {
    const { staticObjs } = splitFadeObjects(collections[phase]);
    for (const o of staticObjs) {
      o.traverse((node) => {
        const materials = Array.isArray(node.material)
          ? node.material : (node.material ? [node.material] : []);
        for (const material of materials) {
          let owners = phases.get(material);
          if (!owners) { owners = new Set(); phases.set(material, owners); }
          owners.add(phase);
        }
      });
    }
  }
  // markSharedResource는 LOD groupUnit·scene-direct helper처럼 fader 바깥 소비자도 있다는 뜻이다.
  // 현재 네 collection에서 한 번만 보여도 원본 opacity를 쓰면 그 외 소비자에 새므로 격리한다.
  return new Set([...phases]
    .filter(([material, owners]) => owners.size > 1 || isSharedResource(material))
    .map(([material]) => material));
}

function syncSharedMaterial(source, target) {
  for (const key of ['color', 'emissive', 'specular', 'sheenColor', 'attenuationColor', 'normalScale']) {
    if (source[key]?.copy && target[key]?.copy) target[key].copy(source[key]);
  }
  for (const key of [
    'emissiveIntensity', 'roughness', 'metalness', 'envMapIntensity', 'lightMapIntensity',
    'aoMapIntensity', 'bumpScale', 'displacementScale', 'displacementBias', 'alphaTest',
  ]) {
    if (key in source && key in target) target[key] = source[key];
  }
  if (source.uniforms && target.uniforms) {
    for (const [key, uniform] of Object.entries(source.uniforms)) {
      const dst = target.uniforms[key];
      if (!dst) continue;
      if (uniform?.value?.copy && dst.value?.copy) dst.value.copy(uniform.value);
      else dst.value = uniform?.value;
    }
  }
}

function makeFader(objs, isolatedMaterials) {
  const { owned, staticObjs } = splitFadeObjects(objs);
  const tops = staticObjs.map((o) => ({ o, vis0: o.visible }));
  const assignments = [];
  const clones = new Map();
  const cloneSources = new Map();
  const seenNodes = new Set();
  const cloneMaterial = (source) => {
    if (!source?.isMaterial || !isolatedMaterials.has(source)) return source;
    let clone = clones.get(source);
    if (clone) return clone;
    clone = source.clone();
    // Material.copy intentionally omits shader hooks. Village materials use chained
    // onBeforeCompile patches for rim/season/snow, so preserve the exact program contract.
    clone.onBeforeCompile = source.onBeforeCompile;
    clone.customProgramCacheKey = source.customProgramCacheKey;
    clones.set(source, clone);
    cloneSources.set(clone, source);
    return clone;
  };
  for (const o of staticObjs) {
    o.traverse((node) => {
      if (!node.material || seenNodes.has(node)) return;
      seenNodes.add(node);
      const original = node.material;
      const replacement = Array.isArray(original)
        ? original.map(cloneMaterial)
        : cloneMaterial(original);
      if (replacement !== original
        && (!Array.isArray(original) || replacement.some((material, i) => material !== original[i]))) {
        node.material = replacement;
        assignments.push({ node, original });
      }
    });
  }
  const recs = new Map();
  for (const o of staticObjs) {
    o.traverse((n) => {
      const m = n.material;
      if (!m) return;
      const arr = Array.isArray(m) ? m : [m];
      for (const mm of arr) {
        if (!recs.has(mm.uuid)) recs.set(mm.uuid, {
          mat: mm,
          source: cloneSources.get(mm) || null,
          opacity: mm.opacity,
          transparent: mm.transparent,
          depthWrite: mm.depthWrite,
        });
      }
    });
  }
  const baseState = (record) => record.source || record;
  const restoreMats = () => {
    for (const r of recs.values()) {
      if (r.source) syncSharedMaterial(r.source, r.mat);
      const base = baseState(r);
      r.mat.opacity = base.opacity;
      r.mat.transparent = base.transparent;
      r.mat.depthWrite = base.depthWrite;
    }
  };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    restoreMats();
    for (const { node, original } of assignments) node.material = original;
    for (const clone of clones.values()) clone.dispose();
  };
  return {
    set(v) {
      // LOD-owned layers compose the wave multiplier internally. Their visibility and base
      // opacity remain camera-detail state, so a scale reframe cannot be overwritten by vis0.
      for (const controller of owned) controller.setWeight(v);
      if (v <= 0.001) { for (const t of tops) t.o.visible = false; return; }
      for (const t of tops) t.o.visible = t.vis0;
      if (v >= 0.999) { restoreMats(); return; }
      for (const r of recs.values()) {
        if (r.source) syncSharedMaterial(r.source, r.mat);
        const base = baseState(r);
        r.mat.transparent = true;
        r.mat.opacity = base.opacity * v;
        r.mat.depthWrite = false;
      }
    },
    release,
  };
}

function classifyRoot(root, center, rng) {
  const instMeshes = [];   // { mesh, count, rest:Float32Array, rad:Float32Array, jit:Float32Array, rmin, rmax, _st }
  const groupUnits = [];   // { obj, pivot, radius, vis0, jit, _st }
  const groundObjs = [];
  const decorObjs = [];

  const addInstMesh = (mesh) => {
    const count = mesh.count | 0;
    if (!count) return;
    const rest = mesh.instanceMatrix.array.slice(0, count * 16);
    const rad = new Float32Array(count), jit = new Float32Array(count);
    let rmin = Infinity, rmax = 0;
    for (let i = 0; i < count; i++) {
      const px = rest[i * 16 + 12], pz = rest[i * 16 + 14];
      const r = Math.hypot(px - center.x, pz - center.z);
      rad[i] = r; if (r < rmin) rmin = r; if (r > rmax) rmax = r;
      jit[i] = (rng() - 0.5) * JITTER;
    }
    instMeshes.push({ mesh, count, rest, rad, jit, rmin, rmax, _st: '' });
  };

  const addGroupUnit = (obj) => {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    // 스태거 반경 = 중심에서 뻗은 도달거리(중심까지 거리 + 반너비). 성곽·시전처럼 마을 중심에
    //   포개진 링/광폭 구조물도 제 외연만큼 뒤로 밀려 외곽 집들과 함께 마지막에 선다(중심 콤팩트
    //   랜드마크는 반경이 작아 일찍). 스케일 pivot 은 바운딩 하단(제자리서 위로 솟음).
    const reach = Math.hypot(cx - center.x, cz - center.z)
      + 0.5 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    groupUnits.push({
      obj, pivot: { x: cx, y: box.min.y, z: cz }, radius: reach,
      vis0: obj.visible, jit: (rng() - 0.5) * JITTER, _st: '',
    });
  };

  for (const child of root.children) {
    const n = child.name || '';
    if (n === '' || SKIP_NAMES.has(n)) continue;
    if (isChunk(n)) {
      if (child.userData?.chunk?.lod || child.userData?.chunk?.far) {
        // 다단계 청크는 숨은 MID/FULL까지 개별 인스턴스로 만지지 않는다. 현재 LOD root 하나를
        // 품은 청크 전체가 한 유닛으로 움직여 웨이브와 거리 LOD의 표현 소유권을 분리한다.
        addGroupUnit(child);
      } else {
        child.traverse((o) => { if (o.isInstancedMesh) addInstMesh(o); });   // 집 = 인스턴스 단위
        for (const cc of child.children) if (isWalls(cc.name || '')) groundObjs.push(cc);  // 담 = 지면 확립 페이드
      }
      continue;
    }
    if (n.startsWith('hero-') || n.startsWith('parcel-')) { addGroupUnit(child); continue; }
    if (GROUP_NAMES.has(n)) { addGroupUnit(child); continue; }
    if (GROUND_NAMES.has(n)) { groundObjs.push(child); continue; }
    if (DECOR_NAMES.has(n)) { decorObjs.push(child); continue; }
    decorObjs.push(child);                    // 미분류(소동물 등) → 데코 페이드(팝 방지 안전 기본)
  }

  // 루트 전체 [rmin,rmax] — 정규화 기준(집·랜드마크·히어로 통합). 링 배치라도 스태거를 전폭에 편다.
  let rmin = Infinity, rmax = 0;
  for (const m of instMeshes) { if (m.rmin < rmin) rmin = m.rmin; if (m.rmax > rmax) rmax = m.rmax; }
  for (const g of groupUnits) { if (g.radius < rmin) rmin = g.radius; if (g.radius > rmax) rmax = g.radius; }
  if (!isFinite(rmin)) rmin = 0;
  const span = rmax - rmin || 1;

  return { instMeshes, groupUnits, rmin, span, groundObjs, decorObjs };
}

// ── 인스턴스 행렬 쓰기(원 rest 기준 상대) ──
//   pivot = rest 병진(집 지면 앵커). 그 점을 축으로 스케일 → 병진 불변, y 에만 낙하 dy 가산.
//   scaled linear = S·L (행별 스케일). 스크래치 객체 없이 타입배열 직접 산술(수천 인스턴스 대비).
function writeInst(dst, src, o, uu) {
  if (uu >= 0.999) { for (let k = 0; k < 16; k++) dst[o + k] = src[o + k]; return; }
  if (uu <= 0.001) {                              // 퇴화(0 스케일) → 비가시
    for (let k = 0; k < 12; k++) dst[o + k] = 0;
    dst[o + 12] = src[o + 12]; dst[o + 13] = src[o + 13]; dst[o + 14] = src[o + 14]; dst[o + 15] = 1;
    return;
  }
  const ts = tofuScale(uu, HOUSE_TOFU);
  const grow = uu < IMPACT ? smoothstep(uu / IMPACT) : 1;   // 등장 스케일(0→1)
  const gs = GS_MIN + (1 - GS_MIN) * grow;
  const sxz = ts.sxz * gs, sy = ts.sy * gs;
  const dy = -fallOffset(uu) * HOUSE_DROP + tofuBob(uu, HOUSE_TOFU) * HOUSE_DROP * 0.6;
  dst[o] = src[o] * sxz;     dst[o + 1] = src[o + 1] * sy;   dst[o + 2] = src[o + 2] * sxz;   dst[o + 3] = src[o + 3];
  dst[o + 4] = src[o + 4] * sxz; dst[o + 5] = src[o + 5] * sy; dst[o + 6] = src[o + 6] * sxz; dst[o + 7] = src[o + 7];
  dst[o + 8] = src[o + 8] * sxz; dst[o + 9] = src[o + 9] * sy; dst[o + 10] = src[o + 10] * sxz; dst[o + 11] = src[o + 11];
  dst[o + 12] = src[o + 12]; dst[o + 13] = src[o + 13] + dy; dst[o + 14] = src[o + 14]; dst[o + 15] = src[o + 15];
}

function setMeshHidden(m) {
  m.mesh.visible = false;                 // 그리기 대상서 제외(미착공/완전해체 = 드로우콜 0)
  if (m._st === 'hid') return;
  const dst = m.mesh.instanceMatrix.array, src = m.rest;
  for (let i = 0; i < m.count; i++) writeInst(dst, src, i * 16, 0);
  m.mesh.instanceMatrix.needsUpdate = true; m._st = 'hid';
}
function setMeshRest(m) {
  m.mesh.visible = true;
  if (m._st === 'rest') return;
  m.mesh.instanceMatrix.array.set(m.rest);
  m.mesh.instanceMatrix.needsUpdate = true; m._st = 'rest';
}

// tp: 해당 위상 로컬 진행(0..1). disassemble=true 면 유닛 진행을 1→0(역재생)으로 뒤집는다.
function applyInstances(rootC, tp, disassemble) {
  const { rmin, span } = rootC;
  for (const m of rootC.instMeshes) {
    const nrmin = (m.rmin - rmin) / span, nrmax = (m.rmax - rmin) / span;
    const startMin = nrmin * SPREAD - JITTER;
    const endMax = nrmax * SPREAD + (1 - SPREAD) + JITTER;
    if (tp <= startMin) { disassemble ? setMeshRest(m) : setMeshHidden(m); continue; }
    if (tp >= endMax) { disassemble ? setMeshHidden(m) : setMeshRest(m); continue; }
    m.mesh.visible = true;
    const dst = m.mesh.instanceMatrix.array, src = m.rest;
    for (let i = 0; i < m.count; i++) {
      const start = ((m.rad[i] - rmin) / span) * SPREAD + m.jit[i];
      let uu = clamp01((tp - start) / (1 - SPREAD));
      if (disassemble) uu = 1 - uu;
      writeInst(dst, src, i * 16, uu);
    }
    m.mesh.instanceMatrix.needsUpdate = true; m._st = 'act';
  }
}

function applyGroupUnit(u, uu) {
  const g = u.obj;
  if (uu <= 0.001) { g.visible = false; u._st = 'hid'; return; }
  g.visible = u.vis0;
  if (uu >= 0.999) { g.position.set(0, 0, 0); g.scale.set(1, 1, 1); u._st = 'rest'; return; }
  const ts = tofuScale(uu, GROUP_TOFU);
  const grow = uu < IMPACT ? smoothstep(uu / IMPACT) : 1;
  const gs = GS_MIN + (1 - GS_MIN) * grow;
  const sxz = ts.sxz * gs, sy = ts.sy * gs;
  const dy = -fallOffset(uu) * GROUP_DROP + tofuBob(uu, GROUP_TOFU) * GROUP_DROP * 0.6;
  const P = u.pivot;
  g.scale.set(sxz, sy, sxz);
  g.position.set(P.x * (1 - sxz), P.y * (1 - sy) + dy, P.z * (1 - sxz));
  u._st = 'act';
}
function applyGroups(rootC, tp, disassemble) {
  const { rmin, span } = rootC;
  for (const u of rootC.groupUnits) {
    const start = ((u.radius - rmin) / span) * SPREAD + u.jit;
    let uu = clamp01((tp - start) / (1 - SPREAD));
    if (disassemble) uu = 1 - uu;
    applyGroupUnit(u, uu);
  }
}

// 위상 경계(미시작/완료) 터미널 스냅 — 지터가 스케줄을 [0,1] 밖으로 밀어도 잔여 없이 깔끔히.
//   built=true 전부 온전, false 전부 소거. 위상 밖 죽은구간·시작/완료 시점을 확정한다.
function settleWave(rootC, built) {
  for (const m of rootC.instMeshes) (built ? setMeshRest : setMeshHidden)(m);
  for (const u of rootC.groupUnits) applyGroupUnit(u, built ? 1 : 0);
}

export function createRerollWave({ oldRoot, newRoot, center, heightAt, seed = 1, duration = 3.4 } = {}) {
  const c = center || { x: 0, z: 0 };
  const rng = makeRng((seed ^ 0x5eed56) >>> 0);
  const oldC = classifyRoot(oldRoot, c, rng);
  const newC = classifyRoot(newRoot, c, rng);
  const isolatedMaterials = sharedFadeMaterials([
    oldC.groundObjs, oldC.decorObjs, newC.groundObjs, newC.decorObjs,
  ]);
  oldC.ground = makeFader(oldC.groundObjs, isolatedMaterials);
  oldC.decor = makeFader(oldC.decorObjs, isolatedMaterials);
  newC.ground = makeFader(newC.groundObjs, isolatedMaterials);
  newC.decor = makeFader(newC.decorObjs, isolatedMaterials);

  function applyAt(t) {
    // ① 옛 마을 해체(중심→밖). 위상 전=온전·위상 후=소거 스냅, 그 사이만 방사 애니.
    if (t <= PH.disasm[0]) settleWave(oldC, true);
    else if (t >= PH.disasm[1]) settleWave(oldC, false);
    else { const tp = phaseLocal(t, PH.disasm); applyInstances(oldC, tp, true); applyGroups(oldC, tp, true); }
    // ③ 새 마을 조립(중심→밖). 위상 전=미착공·위상 후=완성 스냅.
    if (t <= PH.asm[0]) settleWave(newC, false);
    else if (t >= PH.asm[1]) settleWave(newC, true);
    else { const tp = phaseLocal(t, PH.asm); applyInstances(newC, tp, false); applyGroups(newC, tp, false); }
    // ② 지면(지형·개울·논·도로·기단·담) 크로스페이드 + 수목·정원·야경 페이드(건물과 동반).
    oldC.ground.set(1 - phaseLocal(t, PH.groundOut));
    newC.ground.set(phaseLocal(t, PH.groundIn));
    oldC.decor.set(1 - phaseLocal(t, PH.decorOut));
    newC.decor.set(phaseLocal(t, PH.decorIn));
  }

  let elapsed = 0, prog = 0, done = false;
  applyAt(0);   // 시작 상태: 옛 마을 온전, 새 마을 미착공

  return {
    duration,
    get progress() { return prog; },
    isDone() { return done; },
    update(dt) {
      if (done) return 1;
      elapsed += dt;
      prog = clamp01(elapsed / duration);
      applyAt(prog);
      if (prog >= 1) done = true;
      return prog;
    },
    seek(t01) { prog = clamp01(t01); elapsed = prog * duration; applyAt(prog); },
    // 중도 취소는 완료 dispose와 반대다. 옛 마을은 원래 행렬·가시성으로, 새 마을은 미착공
    // 상태로 돌리고 양쪽 임시 투명 재질 플래그를 회수한다. 엔진 이탈/API 취소가 사용한다.
    cancel() {
      settleWave(oldC, true);
      settleWave(newC, false);
      oldC.ground.set(1); oldC.decor.set(1);
      newC.ground.set(0); newC.decor.set(0);
      oldC.ground.release(); oldC.decor.release();
      newC.ground.release(); newC.decor.release();
      elapsed = 0; prog = 0; done = true;
    },
    dispose() {
      applyAt(1);                 // 새 마을 완전 정상화(트랜스폼 항등·재질 원복)
      oldC.ground.release(); oldC.decor.release();   // 원 material identity + 임시 clone 수명 회수
      newC.ground.release(); newC.decor.release();
      elapsed = duration; prog = 1; done = true;
    },
  };
}
