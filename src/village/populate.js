import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { makeMaterials, applyThatchAge, injectVillageCloudShadow } from '../builder/palette.js';
import { buildBuilding } from '../builder/index.js';
import { PRESETS } from '../params.js';
import { buildHanok } from '../layout/hanok.js';
import { buildPavilion } from '../builder/pavilion.js';
import { buildBridge } from '../builder/bridge.js';
import { buildParcel } from '../layout/parcel.js';
import { buildPalaceCompound } from './palace.js';
import { buildProp } from '../props/index.js';
import { injectWaterLook, createWaterUniforms } from '../env/water.js';
import {
  createCloudUniforms, buildEdgeMistRing, buildRidgeMist,
  CLOUD_SHADOW_FRAG_DECL, CLOUD_SHADOW_FRAG_BODY,
  CLOUD_SHADOW_VERT_DECL, CLOUD_SHADOW_VERT_BODY,
} from '../env/clouds.js';
import { buildHouseInstances, buildChunkImpostor, mergeStatic, parcelMatrix, parcelRotY, decomposeByMaterial, mirrorDecomp, shareMaterials } from './instancing.js';
import { partitionParcels, combineHouseHandles, combineWallHandles } from './chunks.js';
import { buildCityWall } from './citywall.js';
import { buildVillageWall } from './walls.js';
import { CHOGA_VARIANTS, GIWA_VARIANTS } from './variants.js';
import { setupTreeOccluder } from '../env/tree-occluder.js';
import { buildVillageFlora } from './gardens.js';
import { buildSpringBloom } from '../layout/bloom.js';
import { buildForest, GRANITE, makeEcotoneField } from './forest.js';
// #123: forest 입력 빌더(마스크·거리필드·외곽신축·고정반경)는 워커 공유 위해 forest-crunch 로 이설.
import { makeEdgeWarp, computeFixedRadius, makeTreeMask, makeClearance, makeRockExposure } from './forest-crunch.js';
import { buildNightLights } from './nightlights.js';
import { setupAnimals } from '../env/animals.js';
import * as G from './geom.js';

// VillagePlan(순수 데이터) → THREE.Group 인스턴스화.
//   자연(지형·개울·논·수목) → 도로 → 필지(집·담·문) → 공용(정자·다리·소품) → 절·궁 순으로 쌓는다.
//   집은 프로토타입 1벌을 clone(지오메트리·재질 공유)해 대량 배치(메모리 고정, 스틸 렌더 충분).

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// 마을 지형 엣지 헤이즈(mist) 강도 — env/terrain.js EDGE_HAZE_AMT.mist 와 동일 계수(마을도 mist 채택).
const V_EDGE_HAZE_AMT = 0.62;

// 지형 최외곽 신축 매핑(makeEdgeWarp)·고정반경(computeFixedRadius)·나무마스크(makeTreeMask)·구조물
//   거리필드(makeClearance)는 #123 에서 forest-crunch.js 로 이설(워커 공유). 위 import 참조.

// ───────────────────────── 지형 메시 ─────────────────────────
// site.heightAt 를 격자로 샘플 → vertexColors(마당·풀·숲·물가·원경 대기). terrain.js 톤 계열.
//   + 비정형 외곽선(site.edge): warpInner 밖 최외곽 정점만 edgeRadiusAt(theta) 로 신축(내부 불변).
//   + 엣지 소실 헤이즈(aEdge) + 흐르는 구름 그림자(cloudU) 셰이더 패치(단일 씬 terrain.js 와 동형).
// 반환 { mesh, setHaze(color) } — setHaze 는 엣지 헤이즈색을 대기(fog)색과 동기화(어댑터 fog 훅이 호출).
function buildSiteTerrain(site, cloudU, warpInner, clearDist) {
  const R = site.R;
  const TR = site.terrainR || R;               // 지형 메시 범위(마을보다 넓게)
  const edge = site.edge;
  const N = Math.max(150, Math.min(260, Math.round(TR / 1.4)));
  const cCourt = linCol(0x8a7f66);   // 마을 바닥(밟힌 흙)
  const cGrass = linCol(0x676f45);   // 초지
  const cGrassDry = linCol(0x7a7c4c);   // 볕 좋은 마른 초지(#115 모틀링) — 균일 초록 원반(어두운 타원) 깨기
  const cForest = linCol(0x435a2a);  // 숲(능선) — 산 덩어리가 읽히되 사면이 검게 안 죽게
  const cScrub = linCol(0x566a38);   // 초지↔숲 사이 관목 올리브(#115 재작업) — 접합부 3단 페더로 경계 완화
  const cFar = linCol(0x6a7c70);     // 원경 대기 감쇠
  const cBank = linCol(0x6d6249);    // 물가 축축한 흙
  const cGranite = linCol(GRANITE);  // 화강암 밝은 회백(급경사·상부 노출, #113) — forest.js 와 공유 톤
  // #137 이끼 낀 회록 화강암 — 순수 화강암 100%가 아니라 숲색 쪽으로 살짝 섞어(레퍼런스: 바위에 낀 이끼)
  //   회색 노출이 너무 죽지 않게. 실제 페인트는 이 색을 기준으로 rock 강도만큼 섞는다.
  const cGraniteMoss = linCol(GRANITE).lerp(cForest, 0.26);
  const cWinterDry = linCol(0x8a8168); // 겨울 마른 갈회(#115 F) — 초지·완사면을 갈회로 이동(겨울감)
  const tmp = new THREE.Color();
  const tmpW = new THREE.Color();
  // #115 에코톤 공유 필드(캐노피 쉘과 동일) — 숲 톤 onset 을 쉘 시작선과 일치시킨다(색·기하 경계 일치).
  const ecotone = makeEcotoneField(site);
  // 마을 흙터(court) 가장자리 노이즈 페더 — 밟힌 흙 원반이 깔끔한 원으로 읽히지 않게(전용 시드, 공유 rng 불침해).
  const courtN = makeClump(((site.seed || 0) ^ 0xc0f7) >>> 0);
  // 해석 경사 |∇높이| — 화강암 노출 게이트(상부 급경사만). forest.js makeSlopeAt 과 동형.
  const slopeAt = (x, z) => {
    const d = 2.0;
    const hx = (site.heightAt(x + d, z) - site.heightAt(x - d, z)) / (2 * d);
    const hz = (site.heightAt(x, z + d) - site.heightAt(x, z - d)) / (2 * d);
    return Math.hypot(hx, hz);
  };
  // #137 화강암 노출장 — forest-crunch 와 "같은" 함수(동일 site.seed 파생). 지형 회색 페인트가 여기서
  //   칠하는 곳 = 나무 rockAvoid 가 걷는 곳으로 정확히 일치한다(나무 걷힌 자리에 회색이 드러남).
  const rockExp = makeRockExposure(site);

  // 비정형 외곽선 신축(공유 헬퍼 makeEdgeWarp): warpInner 안쪽 고정, 바깥 밴드만 유기적 재매핑.
  //   scatterTrees 도 같은 warp 로 나무를 앉혀 메시-수목 신축면이 정확히 일치한다(#86 부유 차단).
  const warp = makeEdgeWarp(site, warpInner);

  const pos = [], col = [], edgeK = [];
  const idx = [];
  const stream = site.stream;
  const streamDistK = (x, z) => {
    if (!stream) return 0;
    const cz = site.streamZat(x);
    return smoothstep(site.streamHalf + 6, site.streamHalf * 0.4, Math.abs(z - cz));
  };
  // outBase 에 기본(봄·여름·가을) 색을, outWinter(있으면)에 겨울 갈회 버퍼 색을 쓴다.
  const colorAt = (x, z, outBase, outWinter) => {
    const hill = site.hillAt(x, z);
    const rC = Math.hypot(x - site.center.x, z - site.center.z);
    // #115: 밟힌 흙(court)을 반경 원반 → "구조물로부터의 거리"(clearDist) 기반으로 전환. 황토가 집·길
    //   윤곽을 따라 앉아(비원형) 원형 마을터 인상을 해소한다. 노이즈 페더로 경계선을 흔든다.
    //   clearDist 없을 때(하위호환)만 구 반경식 폴백.
    const cw = (courtN(x / 24, z / 24) - 0.5) * 9;   // 페더(m)
    let court;
    if (clearDist) {
      const cd = clearDist(x, z);
      court = smoothstep(22 + cw, 2 + cw, cd) * (1 - hill);   // cd 작음(구조물 인접)=황토, 멀면 초지
    } else {
      const cwR = (courtN(x / 24, z / 24) - 0.5) * site.bowlR * 0.14;
      court = smoothstep(site.bowlR * 0.42 + cwR, site.bowlR * 0.08, rC) * (1 - hill);
    }
    outBase.copy(cGrass).lerp(cCourt, court * 0.55);
    // #115 초지 모틀링: 개활 초지에 저주파 마른-초지 얼룩을 섞어 균일 초록 원반(어두운 타원)을 깬다.
    //   황토(court) 위·깊은 숲 아래에서만 약하게(hill/court 로 게이트) — 지형 색 비정형화.
    const mott = smoothstep(0.36, 0.72, courtN(x / 68 + 40, z / 68 - 25));
    outBase.lerp(cGrassDry, mott * (1 - court) * (1 - smoothstep(0.28, 0.6, hill)) * 0.5);
    // #115 에코톤: 숲 톤 전이를 순수 hill 게이트에서 쉘과 동일한 에코톤 필드(반경+노이즈)로 교체 —
    //   색 경계가 캐노피 쉘 시작선과 일치(두드러진 원형 경계 해소). 평지 녹패치 방지 hillGate 로 게이트하고,
    //   깊은 능선(고지)은 반경 무관 완전 숲 톤 보장(max).
    const eco = ecotone(x, z);
    const hillGate = smoothstep(0.04, 0.20, hill);
    const forestT = Math.max(eco * hillGate, smoothstep(0.45, 0.72, hill));
    // #115 재작업: 초지→관목(scrub)→숲 3단 페더 — 접합부가 좁은 선으로 읽히지 않게 전이 폭 확대.
    //   두 겹침 램프(0~0.55, 0.30~1.0)로 넓고 완만한 그라데이션. 깊은 숲(forestT→1)은 최종 cForest.
    outBase.lerp(cScrub, smoothstep(0.0, 0.55, forestT));
    outBase.lerp(cForest, smoothstep(0.30, 1.0, forestT));
    // 화강암 노출(#137 재균형): 구 연속 회색 띠(smoothstep(0.58,1.25,slope)·(0.44,0.74,hill))가 상부
    //   사면을 넓게 회색으로 칠해 "민짜 암벽"으로 읽혔다 → rockExp 로 노이즈 게이트된 불규칙 줄무늬 패치
    //   (상부 지릉·골, 표면 ~10–20%)로 교체하고 이끼 낀 회록으로 섞는다. 나무 rockAvoid 와 동일 필드라
    //   나무가 걷힌 자리에만 회색이 드러난다(정합). 하부 사면·완사면·평지 무변(순수 숲).
    if (hill > 0.55) {
      const rock = rockExp(x, z, slopeAt(x, z), hill);
      if (rock > 0) outBase.lerp(cGraniteMoss, Math.min(1, rock) * 0.86);
    }
    // 물가
    const bank = streamDistK(x, z);
    if (bank > 0) outBase.lerp(cBank, bank * 0.7);
    // 원경 대기(먼 능선일수록 옅게)
    const far = smoothstep(TR * 0.6, TR, Math.hypot(x, z)) * 0.45;
    outBase.lerp(cFar, far);
    // 겨울 버퍼(#115 F): 기저색을 마른 갈회로 이동. 분지 초지·완사면 강, 깊은 숲(상록 잔존) 약, 물가 유지.
    //   지형 정점색은 정적이므로 forest.js 계절 버퍼 방식과 동형으로 겨울 전용 버퍼를 만들어 setSeason 스왑.
    if (outWinter) {
      const wAmt = 0.55 * (1 - 0.5 * forestT) * (1 - 0.7 * bank) * (1 - far);
      outWinter.copy(outBase).lerp(cWinterDry, wAmt);
    }
  };

  const colW = [];   // 겨울 전용 정점색 버퍼(#115 F)
  const grid = [];
  for (let i = 0; i <= N; i++) {
    grid[i] = [];
    for (let j = 0; j <= N; j++) {
      const gx = -TR + (2 * TR) * (i / N);
      const gz = -TR + (2 * TR) * (j / N);
      const [x, z] = warp(gx, gz);               // 외곽만 유기적으로 신축(내부는 그대로)
      const y = site.heightAt(x, z);
      pos.push(x, y, z);
      colorAt(x, z, tmp, tmpW);
      col.push(tmp.r, tmp.g, tmp.b);
      colW.push(tmpW.r, tmpW.g, tmpW.b);
      edgeK.push(edge ? edge.edgeK(x, z) : 0);   // 외곽 밴드 0(안)→1(경계선) — 엣지 소실 마스크
      grid[i][j] = i * (N + 1) + j;
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const a = grid[i][j], b = grid[i][j + 1], c = grid[i + 1][j], d = grid[i + 1][j + 1];
    idx.push(a, b, c, b, d, c);   // 상향 법선(윗면이 정면)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const colBaseArr = new Float32Array(col), colWinterArr = new Float32Array(colW);
  geo.setAttribute('color', new THREE.BufferAttribute(colBaseArr.slice(), 3));   // 라이브 버퍼(계절 스왑)
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edgeK, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });

  // ── 셰이더 패치: 흐르는 구름 그림자 + 엣지 소실 헤이즈 ──────────────────────
  // 단일 씬 terrain.js 와 동형(고유 심볼 uCloud*/vEdge/uEdgeHazeV). 마을 지형엔 현재 계절·적설
  // 패치가 없어 체인 충돌은 없으나, 향후 패치가 얹혀도 color_fragment '뒤'에 삽입되도록 앵커 사용.
  const uEdgeHaze = { value: new THREE.Vector3(0.8, 0.8, 0.85) };  // 대기색 — setHaze 가 갱신
  const useCloud = !!cloudU;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uEdgeHazeV = uEdgeHaze;
    if (useCloud) {
      shader.uniforms.uCloudTime = cloudU.uCloudTime;
      shader.uniforms.uCloudStr = cloudU.uCloudStr;
      shader.uniforms.uCloudBlobs = cloudU.uCloudBlobs;   // 빌보드 대응 그림자 블롭(#68)
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>\nattribute float aEdge;\nvarying float vEdgeV;\n${useCloud ? CLOUD_SHADOW_VERT_DECL : ''}`)
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>\nvEdgeV = aEdge;\n${useCloud ? CLOUD_SHADOW_VERT_BODY : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nuniform vec3 uEdgeHazeV;\nvarying float vEdgeV;\n${useCloud ? CLOUD_SHADOW_FRAG_DECL : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${useCloud ? CLOUD_SHADOW_FRAG_BODY : ''}
        {
          // 엣지 소실: 외곽 밴드(vEdgeV)에서 지형색을 대기(fog)색으로 밀어 여백으로 녹임(mist).
          float e = smoothstep(0.12, 1.0, vEdgeV);
          diffuseColor.rgb = mix(diffuseColor.rgb, uEdgeHazeV, ${V_EDGE_HAZE_AMT.toFixed(3)} * e);
        }`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'village-terrain';
  mesh.receiveShadow = true;
  // Vector3.copy(Color)=NaN 함정 회피 → 채널 직접 대입.
  const setHaze = (c) => { if (c) uEdgeHaze.value.set(c.r, c.g, c.b); };
  // 계절 정점색 스왑(#115 F): 겨울만 마른 갈회 버퍼, 그 외(봄·여름·가을)는 기저 버퍼(현행 색 불변).
  const colAttr = geo.getAttribute('color');
  let shownWinter = false;
  const setSeason = (name) => {
    const w = name === 'winter';
    if (w === shownWinter) return;
    colAttr.array.set(w ? colWinterArr : colBaseArr);
    colAttr.needsUpdate = true;
    shownWinter = w;
  };
  return { mesh, setHaze, setSeason };
}


// 배산 능선 물안개 앵커 — 뒤(북) 반원 각 방위에서 site.center(분지 중심) 기준으로 밖으로 표고를
//   스캔해 목표 중턱높이의 "안쪽(분지를 바라보는) 사면" 첫 교차점을 찾는다(원점 아닌 center 기준 —
//   분지가 북으로 물려 있어 원점 스캔은 능선 먼 쪽에 놓여 근사면에 가려짐). 그 지형면 살짝 위에
//   카메라 대면 뱅크를 얹고 분지쪽으로 조금 당겨 아이레벨 진입 시점에서 능선에 걸친 원경 물안개로 읽힌다.
function computeRidgeMistAnchors(site) {
  const R = site.R, Hmax = site.Hmax;
  const C = site.center;
  const targetH = Hmax * 0.34;                 // 중턱 목표 표고
  const arc = [Math.PI * 1.12, Math.PI * 1.9]; // center 기준 북(-z) 중심 뒤쪽 호
  const count = R > 150 ? 4 : 3;
  const rMax = R * 1.35;
  const anchors = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    const th = arc[0] + (arc[1] - arc[0]) * t;
    const cxu = Math.cos(th), czu = Math.sin(th);
    // center 에서 밖으로 스캔 → 표고가 targetH 를 처음 넘는 반경(분지쪽 근사면).
    let hitR = null;
    for (let r = R * 0.35; r <= rMax; r += R * 0.02) {
      if (site.heightAt(C.x + cxu * r, C.z + czu * r) >= targetH) { hitR = r; break; }
    }
    if (hitR == null) continue;                 // 이 방위에 뚜렷한 능선 없음(개활) → 생략
    const x = C.x + cxu * hitR, z = C.z + czu * hitR;
    const gy = site.heightAt(x, z);
    // 분지쪽으로 살짝 당겨(뱅크가 사면 앞에 걸리게) + 지형 위 소량 리프트.
    const pull = R * 0.05;
    anchors.push({
      x: x - cxu * pull, y: gy + Hmax * 0.08, z: z - czu * pull,
      w: R * 0.72, h: Hmax * 0.6, op: 0.36,
    });
  }
  return anchors;
}

// ───────────────────────── 개울(명당수) ─────────────────────────
// env/water.js 의 injectWaterLook 을 재사용해 앱 물과 같은 하늘 반사·글린트 룩.
function buildWaterRibbon(site, uniforms) {
  if (!site.stream) return null;
  const pts = site.stream.pts;
  const pos = [], uv = [], idx = [];
  const N = pts.length - 1;
  const tmpT = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)];
    tmpT.set(b.x - a.x, 0, b.z - a.z).normalize();
    const nx = -tmpT.z, nz = tmpT.x;
    const hw = site.streamHalf;
    const y = site.streamY(p.x);
    pos.push(p.x + nx * hw, y, p.z + nz * hw);
    pos.push(p.x - nx * hw, y, p.z - nz * hw);
    uv.push(0, i / N * 10, 1, i / N * 10);
  }
  for (let i = 0; i < N; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x35566a, metalness: 0.35, roughness: 0.17 });
  mat.onBeforeCompile = (shader) => injectWaterLook(shader, uniforms);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'village-stream';
  mesh.renderOrder = 1;
  mesh.receiveShadow = true;
  return mesh;
}

// ───────────────────────── 개울 물 시간대 톤 ─────────────────────────
// env/water.js 셰이더(injectWaterLook)는 uSky(프레넬 하늘반사)·uGlint(반짝임)를 additive
// emissive 로 더한다. 그런데 이 값들이 시간대 무연동이면 밤·석양의 어두운 씬에서도 낮 밝기로
// 남아 bloom(night threshold 0.32)에 흰 띠로 피어오른다(uiv-env-night·uiv-sunset-capital).
//   → 시간대별로 하향: 야간은 달빛 은은(어둠에 가라앉되 존재감), 석양은 시안 대신 금빛 은은.
//   env WATER_GLINT 계열 색을 참고하되, 마을 개울이 길고 부감에서 grazing(프레넬↑)이라 강도를
//   더 눌러 bloom 임계 아래로 유지한다. env/water.js 는 수정 금지 — 여기 uniform 만 갈아끼운다.
const V_WATER_GLINT = {
  dawn:   [0.44, 0.42, 0.36],
  day:    [0.85, 0.74, 0.48],   // 기존 낮 룩 유지(회귀 없음)
  sunset: [0.58, 0.38, 0.20],   // 금빛 윤슬(시안 아님) — 흰 blowout 은 uRough 로 잡고 emissive 는 금빛 유지
  night:  [0.10, 0.13, 0.19],   // 성긴 은빛 달빛 — 하향(bloom 임계 아래 유지, 은은)
};
const V_WATER_SKY = {
  dawn:   0x7a8496,
  day:    0xaecbe0,             // WATER_SKY(기존 낮 하늘반사) 유지
  sunset: 0x6e5643,             // 따뜻한 저채도 → 금빛 반사 은은(살짝 더 눌러 흰띠 방지)
  night:  0x232f42,             // 어두운 달빛 청 → 프레넬 반사가 어둠에 가라앉음
};
// 시간대별 거칠기 가산(env/water.js uRough, 0=기본). 야간·석양 부감에서 저각 광원(달빛·석양)이
// 저거칠기 수면에 뾰족한 스펙큘러 리본을 만들어 bloom 을 타므로, 그 시간대만 수면을 거칠게 해
// 하이라이트를 넓고 은은한 시트로 퍼뜨린다(peak↓ → bloom 임계 아래). 낮·새벽은 기존 하이라이트
// 유지(0). 마을 개울은 길고 부감 grazing 이라 이 완화가 특히 필요(단일 씬 env 물은 불변).
const V_WATER_ROUGH = {
  dawn:   0.0,
  day:    0.0,
  sunset: 0.30,                 // 금빛 윤슬은 남기되 흰 blowout 리본만 완화
  night:  0.55,                 // 달빛 스펙큘러를 은은한 시트로(뾰족 리본 제거)
};
export function setVillageWaterTime(waterU, name) {
  if (!waterU) return;
  const g = V_WATER_GLINT[name] || V_WATER_GLINT.day;
  waterU.uGlint.value.set(g[0], g[1], g[2]);
  const skyHex = (name in V_WATER_SKY) ? V_WATER_SKY[name] : V_WATER_SKY.day;
  waterU.uSky.value.setHex(skyHex, THREE.SRGBColorSpace);
  waterU.uRough.value = (name in V_WATER_ROUGH) ? V_WATER_ROUGH[name] : 0.0;
}

// ───────────────────────── 수목(숲·능선) ─────────────────────────
// hillAt 로 능선·산에만 밀집. mask(x,z)=true 인 자리(마을·도로·논)는 제외.
function makeTreeProtos() {
  // 소나무(상록): 짧은 갈색 줄기 + 짙은 청록 원뿔 2~3층.
  const pine = [];
  const trunkP = new THREE.CylinderGeometry(0.16, 0.24, 2.0, 5); trunkP.translate(0, 1.0, 0);
  pine.push(tintGeo(trunkP, 0x6a4a2e));
  for (let k = 0; k < 3; k++) {
    const c = new THREE.ConeGeometry(2.1 - k * 0.5, 2.4, 7); c.translate(0, 2.4 + k * 1.5, 0);
    pine.push(tintGeo(c, [0x2f4428, 0x35492d, 0x273a21][k % 3]));
  }
  // 활엽(잡목): 줄기 + 둥근 덩어리.
  const broad = [];
  const t2 = new THREE.CylinderGeometry(0.14, 0.2, 2.4, 5); t2.translate(0, 1.2, 0);
  broad.push(tintGeo(t2, 0x6b5540));
  const blob = new THREE.IcosahedronGeometry(2.4, 1); blob.scale(1.1, 0.92, 1.1); blob.translate(0, 4.3, 0);
  broad.push(tintGeo(blob, 0x4e6d34));
  return {
    pine: mergeGeometries(pine, false),
    broad: mergeGeometries(broad, false),
  };
}
function tintGeo(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count, arr = new Float32Array(n * 3), c = linCol(hex);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
// 결정론적 저주파 value-noise(수목 군집 마스크) — site.js makeNoise 와 동형이되 이 함수 자립.
//   군집(숲)과 빈터가 교대하는 유기적 분포를 만든다(균일 담요 방지).
function makeClump(seed) {
  const rng = makeRng(seed);
  const perm = new Uint8Array(512), base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = base[i]; base[i] = base[j]; base[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  const lat = (ix, iz) => perm[(perm[ix & 255] + (iz & 255)) & 255] / 255;
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, z) => {
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const v00 = lat(x0, z0), v10 = lat(x0 + 1, z0), v01 = lat(x0, z0 + 1), v11 = lat(x0 + 1, z0 + 1);
    const sx = sm(fx), sz = sm(fz);
    return (v00 + (v10 - v00) * sx) + ((v01 + (v11 - v01) * sx) - (v00 + (v10 - v00) * sx)) * sz;
  };
}

// warpInner: buildSiteTerrain 과 동일 값을 넘겨받아 나무를 메시와 같은 신축면에 앉힌다(#86).
function scatterTrees(site, mask, seed, warpInner, treeDensityK = 1) {
  const group = new THREE.Group(); group.name = 'village-trees';
  const protos = makeTreeProtos();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });
  const rng = makeRng(seed ^ 0x77ee);
  const R = site.R;
  const TR = site.terrainR || R;
  const C = site.center, bowlR = site.bowlR, Hmax = site.Hmax;
  const pine = [], broad = [];
  const M4 = () => new THREE.Matrix4();

  // ── 나무를 지형 메시면에 정확히 앉히는 격자 샘플러(부유 원천 차단, #86) ──
  //   메시(buildSiteTerrain)는 정사각 격자(gx,gz)를 warp 로 신축한 정점의 heightAt 를 잇는다.
  //   나무도 (a) 같은 warp 로 좌표를 신축하고(디스크 밖·코너 부유 제거) (b) 같은 격자정점 높이를
  //   이중선형 보간해 앉힌다(신축밴드 급사면 서브버텍스 부유 제거) → 나무=메시 표면 위 정확.
  const N = Math.max(150, Math.min(260, Math.round(TR / 1.4)));   // 메시와 동일 해상도
  const warp = makeEdgeWarp(site, warpInner);
  const vCache = new Map();
  const vert = (i, j) => {                       // 격자정점 (i,j) → 신축 월드XZ·메시높이(지연 캐시)
    const key = i * (N + 3) + j;
    let v = vCache.get(key);
    if (!v) {
      const gx = -TR + (2 * TR) * (i / N), gz = -TR + (2 * TR) * (j / N);
      const [wx, wz] = warp(gx, gz);
      v = { x: wx, z: wz, y: site.heightAt(wx, wz) };
      vCache.set(key, v);
    }
    return v;
  };
  const onMesh = (gu, gv) => {                   // 연속 격자좌표 → 메시면 위 점(월드)
    const i = Math.min(N - 1, Math.max(0, Math.floor(gu))), j = Math.min(N - 1, Math.max(0, Math.floor(gv)));
    const fu = gu - i, fv = gv - j;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
    const lx = (p, q) => p + (q - p) * fu;
    const lerpXZ = (k) => (lx(a[k], b[k]) + (lx(c[k], d[k]) - lx(a[k], b[k])) * fv);
    return { x: lerpXZ('x'), y: lerpXZ('y'), z: lerpXZ('z') };
  };

  // ── 밀도장(#86): 마을 경계 밖에서 거리감쇠 + 군집 노이즈 + 능선 너머(가림) 컷 ──
  //   균일 담요(구 밀도=hillAt) → 마을 가까이 성글게·산기슭 군집·크레스트 성글되 실루엣 유지.
  const clump = makeClump((seed ^ 0x5c1a) >>> 0);
  const CF = 1 / 46;                              // 군집 파장 ~46m
  const density = (x, z, hill) => {
    if (hill < 0.06) return 0;                    // 분지 평지: 나무 없음
    const rC = Math.hypot(x - C.x, z - C.z);
    const outBand = smoothstep(bowlR * 0.98, bowlR * 1.34, rC);          // 마을 경계 밖으로 램프
    const slope = smoothstep(0.06, 0.28, hill) * (1 - 0.4 * smoothstep(0.72, 1.0, hill)); // 크레스트 성글
    const grove = 0.15 + 0.85 * smoothstep(0.40, 0.72, clump(x * CF, z * CF)); // 숲/빈터 교대
    // #113 R4 역할 전환("숲은 면, 나무는 가장자리"): 캐노피 쉘이 사면을 연속 면으로 덮으므로, 사면 위
    //   개체 나무는 오직 능선 crest 실루엣(암봉 사이 짙은 침엽 — 레퍼런스 01·02)만 남긴다. 중·하사면
    //   싱글은 쉘 위에 떠 보이고 가을에 초록으로 계절 불일치(게이트 결함) → 전면 제거. crest 나무는 상록
    //   소나무라 사철 짙은 녹(가을에도 자연스러운 침엽 실루엣). 총수 ≤ 현행(대폭 감소).
    const crest = smoothstep(0.62, 0.9, hill);                         // 능선 상부만 보존
    return outBand * slope * grove * crest;
  };
  // #115 에코톤 점묘: 마을 가장자리 ~ 캐노피 쉘 시작선 사이 전이 밴드에 성긴 낱개 나무(숲 치마).
  //   #113 R4 가 사면 낱개 나무를 crest 로 물려 전이대가 텅 비었다("벽처럼 시작하는 숲") → 쉘 앞에
  //   소나무 위주 + 소량 활엽을 흩뿌려 숲이 마을로 자연스레 번지게. 쉘과 동일 필드로 시작선 정합.
  const ecoField = makeEcotoneField(site);
  const CF2 = 1 / 38;                                                  // 점묘 군집 파장(숲 치마 뭉치)
  const bandDensity = (x, z, hill) => {
    if (hill < 0.05) return 0;
    const f = ecoField(x, z);                                          // 0(마을)~1(숲 내부)
    // 쉘 시작 직전(f 낮~중)에 점묘, 숲 내부(f 높음)는 쉘이 덮으니 감쇠 — 전이 밴드에 집중.
    //   #115 재작업: 밴드 창 확대 + grove 하한↑ + 배율↑ 로 "성긴 숲" 인상 강화(전이대 채움).
    const band = smoothstep(0.02, 0.30, f) * (1 - smoothstep(0.54, 0.94, f));
    if (band <= 0) return 0;
    const grove = 0.42 + 0.58 * smoothstep(0.30, 0.68, clump(x * CF2 + 11, z * CF2 - 7));
    return band * grove * 1.15;                                        // 전이대 점묘 밀도 상향(0.7→1.15)
  };
  // 능선 너머(far downslope): 중심→점 사이에 더 높은 능선이 있으면 부감·아이레벨 모두 안 보임 → 0.
  //   실루엣에 기여하는 크레스트·근사면(사이에 더 높은 능선 없음)은 남긴다. 고지(hill↑)만 검사(비용).
  const hidden = (x, z, yHere) => {
    const dx = x - C.x, dz = z - C.z;
    let mx = -Infinity;
    for (let k = 1; k <= 4; k++) { const t = k / 5; const h = site.heightAt(C.x + dx * t, C.z + dz * t); if (h > mx) mx = h; }
    return mx > yHere + 1.5;
  };

  // 밀도 목표(상한). #86: 담요 대폭 감소 — 구(TR/120)²·320 대비 절반 수준 + 밀도장 추가 감쇠.
  //   hanyang(TR>480)은 3000→1600, capital 이하도 캡 하향.
  //   #91 나무 밀도 배율(treeDensityK, 기본 1=현행): 목표수만 배율하고 Math.min 캡은 유지 → 상한 고정
  //   (성능 파탄 방지). 나무는 자체 rng(seed^0x77ee)라 공유 시퀀스 미소비 → 밀도 변경이 배치·필지 불간섭.
  const tK = Math.min(2, Math.max(0, treeDensityK));
  //   #115(재작업): 전이 밴드 점묘 몫으로 목표수 상향(200→260, 캡↑). 밴드는 마을 인접 숲 치마라
  //   외곽 밀도 대폭 감소(#86, 먼 산) 기조와 무관 — crest 실루엣 나무는 그대로, 앞에 점묘만 더한다.
  const target = Math.min(TR > 480 ? 2050 : 3500, Math.round((TR / 138) ** 2 * 260 * tK));
  let attempts = 0;
  const pts = [];
  const minD = 4.8;
  // 최소간격 이웃검사 공간해시(O(n²) 회피). 셀=minD → 인접 9셀만 대조.
  const tgrid = new Map();
  const tkey = (x, z) => Math.floor(x / minD) * 92821 ^ Math.floor(z / minD);
  const tooClose = (x, z) => {
    const cx = Math.floor(x / minD), cz = Math.floor(z / minD);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const arr = tgrid.get(ix * 92821 ^ iz); if (!arr) continue;
      for (const p of arr) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minD * minD) return true;
    }
    return false;
  };
  while (pts.length < target && attempts < target * 26) {
    attempts++;
    // 격자좌표로 샘플 → 자동으로 메시 디스크 안에 갇힘(코너 부유 제거).
    const gu = rng() * N, gv = rng() * N;
    const p = onMesh(gu, gv);
    const x = p.x, z = p.z;
    const hill = site.hillAt(x, z);
    const crestD = density(x, z, hill);
    const bandD = bandDensity(x, z, hill);            // #115 전이 밴드 점묘
    const dens = Math.min(1, crestD + bandD);
    if (rng() > dens) continue;                       // 거리감쇠·군집·에코톤 밴드 밀도장 기각
    if (mask && mask(x, z)) continue;
    if (tooClose(x, z)) continue;
    if (hill > 0.45 && hidden(x, z, p.y)) continue;   // 능선 너머(안 보임) → 심지 않음
    const isBand = bandD > crestD;                    // 이 점이 전이 밴드 점묘인지(밴드 우세)
    pts.push({ x, z });
    { const k = tkey(x, z); let arr = tgrid.get(k); if (!arr) { arr = []; tgrid.set(k, arr); } arr.push({ x, z }); }
    const s = rng.range(0.8, 1.5);
    // #115: crest 나무는 상록 소나무만(#113 R4, 사철 짙은 침엽 실루엣). 전이 밴드 점묘는 소나무 위주에
    //   소량(≈28%) 활엽 혼합 — 숲 치마의 혼효림 인상. 밴드 나무는 쉘 앞(맨 지면) 위라 가을 계절 불일치
    //   착시 없음(쉘 위에 뜬 게 아님). rng() 1회 소비는 기존 자리와 동일 → 시퀀스 정합 유지.
    const broadTree = (rng() < 0.34) && isBand;   // rng() 무조건 1회 소비 / 밴드 혼효림 활엽 비율 소폭↑
    // 급사면 시각 하드닝(#86 재라운드): 나무 밑동을 국소 경사에 비례해 지면에 박는다. 배치 y 는
    //   메시면 위(레이캐스트 검증 편차<0.1m)이나, 저각(grazing) 매끈한 사면에서는 다운슬로프 그림자
    //   오프셋과 겹쳐 '둥치가 떠 보이는' 착시가 난다 → 밑동을 묻어 둥치가 지면을 뚫고 나오게 한다.
    const e = 0.7;
    const su = onMesh(Math.min(N, gu + e), gv), sd = onMesh(Math.max(0, gu - e), gv);
    const sr = onMesh(gu, Math.min(N, gv + e)), sl = onMesh(gu, Math.max(0, gv - e));
    const runU = Math.hypot(su.x - sd.x, su.z - sd.z) || 1, runV = Math.hypot(sr.x - sl.x, sr.z - sl.z) || 1;
    const slopeR = Math.hypot((su.y - sd.y) / runU, (sr.y - sl.y) / runV);   // |∇높이| (rise/run)
    // #142 활엽 접지: 롤리팝 활엽은 캐노피 하단이 밑동보다 ~2.1·s 높다. 가는 줄기(원경 비가시) 위
    //   넓은 캐노피라 급사면에서 내리막 가장자리가 공중에 뜬다("공 부유", #137 잔여). 경사에 비례해
    //   나무 전체를 내려 앉혀 캐노피 하단을 사면에 밀착시킨다(완사면=롤리팝 유지, 급사면=지면 밀착 —
    //   크런치 활엽과 동조). 소나무는 종전대로 밑동 매립 하드닝만.
    let sink;
    if (broadTree) {
      const canopyBottom = 2.09 * s;                                   // 프로토 blob 하단(스케일 반영)
      // 완경사부터 캐노피 하단을 지면에 밀착(smoothstep 조기 포화) + 급사면 내리막 가장자리 매립 마진.
      sink = smoothstep(0.04, 0.22, slopeR) * canopyBottom + 1.4 * s * slopeR;
    } else {
      sink = Math.min(1.1, 1.0 * slopeR);
    }
    const m = M4().makeTranslation(x, p.y - sink, z);
    m.multiply(M4().makeRotationY(rng.range(0, 6.28)));
    m.multiply(M4().makeScale(s, s * rng.range(0.9, 1.2), s));
    (broadTree ? broad : pine).push(m);
  }
  for (const [proto, mats, tint] of [[protos.pine, pine, null], [protos.broad, broad, null]]) {
    if (!mats.length) continue;
    const inst = new THREE.InstancedMesh(proto, mat, mats.length);
    mats.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = false;
    group.add(inst);
  }
  group.userData.count = pts.length;
  // 전경 나무 오클루더 페이드: 궤도 회전 중 카메라와 마을 중심 사이 근경 나무를 dithered 반투명화.
  // app 렌더 루프가 카메라를 넘겨주지 않으므로 mesh.onBeforeRender 로 자가 구동(카메라 제공). 마을은
  // 원점 기준으로 authored 라 캐노피 월드좌표는 그룹 추가 전에도 인스턴스 행렬 그대로.
  const occSubject = new THREE.Vector3(0, 4, 0);
  const occ = setupTreeOccluder({ getSubject: () => occSubject });
  occ.register(group, { canopyY: 4.0 });
  occ.enableSelfDrive();
  group.userData.occluder = occ;
  return group;
}

// ───────────────────────── 도로 ─────────────────────────
// 도로 폴리라인을 지면에 밟힌 흙 리본으로. 등급별 폭(경국대전). 지형에 살짝 띄워 z-fighting 방지.
// 로드 톤 뮤트(#78): 도로가 급사면(좌청룡·우백호 측면 능선 등)을 직선으로 오를 때 생기는
//   인위적 "베이지 띠"를 없앤다. vertexColors 로 평지=밟힌 흙(기존색 그대로), 급사면일수록 주변
//   지형색(초지→숲)에 근접시켜 산자락에 녹인다. 완사면(대부분 도로)은 무변 → 타 규모 룩 회귀 0.
const R_BEIGE = linCol(0x9a8b70);   // 평지 도로(밟힌 흙) — 기존값
const R_GRASS = linCol(0x676f45);   // 지형 초지(buildSiteTerrain 과 동일 톤)
const R_FOREST = linCol(0x435a2a);  // 지형 숲(능선)
function buildRoads(site, roads) {
  const group = new THREE.Group(); group.name = 'village-roads';
  // color=white + vertexColors: 색은 정점에 실어 평지는 기존 베이지 그대로, 급사면만 지형에 뮤트.
  const roadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 0 });
  const tmp = new THREE.Color(), terr = new THREE.Color();
  const roadColAt = (x, z, out) => {
    const hill = site.hillAt(x, z);
    const mute = smoothstep(0.30, 0.60, hill) * 0.9;   // 완사면 0 → 급사면 0.9
    if (mute <= 0) return out.copy(R_BEIGE);
    terr.copy(R_GRASS).lerp(R_FOREST, smoothstep(0.06, 0.55, hill));
    return out.copy(R_BEIGE).lerp(terr, mute);
  };
  for (const road of roads) {
    const pts = road.pts;
    if (pts.length < 2) continue;
    const hw = road.width / 2;
    const pos = [], col = [], idx = [];
    const N = pts.length - 1;
    for (let i = 0; i <= N; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)];
      const tan = G.norm(G.sub(b, a));
      const nx = -tan.z, nz = tan.x;
      const xL = p.x + nx * hw, zL = p.z + nz * hw, xR = p.x - nx * hw, zR = p.z - nz * hw;
      const yL = site.heightAt(xL, zL) + 0.06;
      const yR = site.heightAt(xR, zR) + 0.06;
      pos.push(xL, yL, zL); pos.push(xR, yR, zR);
      roadColAt(xL, zL, tmp); col.push(tmp.r, tmp.g, tmp.b);
      roadColAt(xR, zR, tmp); col.push(tmp.r, tmp.g, tmp.b);
    }
    for (let i = 0; i < N; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, roadMat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// ───────────────────────── 필지 성토 패드 + 축대 ─────────────────────────
// 실물 계단식 마을: 완경사 지형 위에 필지마다 흙을 돋운 평탄 패드(마당·집·담이 한 레벨)를
//   앉히고, 지형이 패드보다 낮게 떨어지는 가장자리는 낮은 축대(장대석·막돌 옹벽)로 마감한다.
//   인접 필지끼리 지형 낙차만큼 단차가 생겨 계단식 감성이 난다.
const PAD_LIFT = 0.06;     // 패드 상면이 지형을 살짝 덮는 여유(관통 방지)
const PAD_MARGIN = 0.6;    // 담장 밖으로 살짝 나온 기단 턱
const PAD_STEP_MIN = 0.1;  // 이보다 낮은 스커트 세그먼트는 생략(퇴화 삼각 방지)
const PAD_SINK = 0.06;     // 축대 밑단을 지형 아래로 살짝 박아 틈 방지

const cPadTop = 0x8a7f66;  // 마당 흙(기단 상면) — 밟힌 흙
const cPadStone = 0x8d857a; // 축대(막돌·장대석) 화강 회갈
// 패드 재질은 모듈 공유(필지 패드·feature 패드 공통) — 드로우콜·재질 수 최소화.
const padTopMat = new THREE.MeshStandardMaterial({ color: cPadTop, roughness: 1, metalness: 0 });
const padStoneMat = new THREE.MeshStandardMaterial({ color: cPadStone, roughness: 1, metalness: 0 });

// 필지 성토 높이 = footprint(중심·모서리·변중점) 지형 높이의 최댓값 + 여유.
//   최댓값을 쓰면 오르막 모서리도 지형 위로 덮여 집·담이 땅에 파묻히지 않는다.
export function computePadY(parcel, site) {
  const poly = parcel.poly;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let maxH = site.heightAt(parcel.center.x, parcel.center.z);
  // 코너 + 변중점(경계 극점) + 내부 그리드(언듈레이션 융기) 를 모두 덮는 최댓값.
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (a.x < minX) minX = a.x; if (a.x > maxX) maxX = a.x; if (a.z < minZ) minZ = a.z; if (a.z > maxZ) maxZ = a.z;
    let h = site.heightAt(a.x, a.z); if (h > maxH) maxH = h;
    h = site.heightAt((a.x + b.x) / 2, (a.z + b.z) / 2); if (h > maxH) maxH = h;
  }
  const N = 5;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = minX + (maxX - minX) * i / N, z = minZ + (maxZ - minZ) * j / N;
    if (!G.pointInPoly({ x, z }, poly)) continue;
    const h = site.heightAt(x, z); if (h > maxH) maxH = h;
  }
  return maxH + PAD_LIFT;
}

function makeBufMesh(pos, idx, mat, name) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.name = name; m.castShadow = true; m.receiveShadow = true;
  return m;
}

// 하나의 패드(CCW 폴리곤, padY)를 상면·스커트 정점 버퍼에 누적한다.
//   topP/topI: 상면(+y 법선), skP/skI: 축대 옆면(외향 법선). site 로 스커트 밑단을 지형에 밀착.
function emitPad(poly, padY, site, topP, topI, skP, skI) {
  const pad = G.offsetPoly(G.ensureCCW(poly), PAD_MARGIN);
  // 상면(팬) — CCW 폴리곤은 역순 삼각이라야 +y 법선(윗면 정면).
  const base = topP.length / 3;
  for (const c of pad) topP.push(c.x, padY, c.z);
  for (let i = 1; i < pad.length - 1; i++) topI.push(base, base + i + 1, base + i);
  // 스커트(기단·축대): 각 변을 세분해 지형까지 내린다. 높이 클수록 축대로 읽힘.
  for (let i = 0; i < pad.length; i++) {
    const a = pad[i], b = pad[(i + 1) % pad.length];
    const SEG = 4;
    for (let s = 0; s < SEG; s++) {
      const t0 = s / SEG, t1 = (s + 1) / SEG;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const g0 = site.heightAt(p0.x, p0.z), g1 = site.heightAt(p1.x, p1.z);
      if (padY - g0 < PAD_STEP_MIN && padY - g1 < PAD_STEP_MIN) continue;   // 거의 평평 → 생략
      const bot0 = Math.min(g0, padY) - PAD_SINK, bot1 = Math.min(g1, padY) - PAD_SINK;
      const bi = skP.length / 3;
      skP.push(p0.x, padY, p0.z);   // 0 a_top
      skP.push(p0.x, bot0, p0.z);   // 1 a_bot
      skP.push(p1.x, padY, p1.z);   // 2 b_top
      skP.push(p1.x, bot1, p1.z);   // 3 b_bot
      skI.push(bi, bi + 1, bi + 2, bi + 2, bi + 1, bi + 3);   // 외향면(CCW 변 → perpR 법선)
    }
  }
}

// 모든 필지 패드 → 상면·축대 2메시 그룹(재질 2개 → 드로우콜 2). baseY 는 사전 계산됨.
function buildParcelPads(parcels, site) {
  const group = new THREE.Group(); group.name = 'village-pads';
  const topP = [], topI = [], skP = [], skI = [];
  for (const p of parcels) {
    if (!p.poly) continue;
    emitPad(p.poly, p.baseY != null ? p.baseY : computePadY(p, site), site, topP, topI, skP, skI);
  }
  if (topI.length) group.add(makeBufMesh(topP, topI, padTopMat, 'pad-top'));
  if (skI.length) group.add(makeBufMesh(skP, skI, padStoneMat, 'pad-skirt'));
  return group;
}

// 회전 사각 footprint 아래 단독 패드(궁·절 등 feature 컴파운드용) → { group, padY }.
//   poly 를 갖지 않는 feature 를 위해 center·치수·회전으로 사각 폴리곤을 구성한다.
function buildPadRect(site, cx, cz, w, d, rotY = 0, cap = 3.2) {
  const hw = w / 2, hd = d / 2;
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  // 로컬(lx,lz) → 월드: three rotation.y 규약(로컬 +z 를 dir 로). x'=lx*cos+lz*sin, z'=-lx*sin+lz*cos
  const local = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  const poly = local.map(([lx, lz]) => ({ x: cx + lx * cos + lz * sin, z: cz - lx * sin + lz * cos }));
  let padY = site.heightAt(cx, cz), lo = padY;
  for (const c of poly) { const h = site.heightAt(c.x, c.z); if (h > padY) padY = h; if (h < lo) lo = h; }
  // 산기슭 컴파운드(절·궁)는 석축 테라스로 앉되, 낙차가 과하면 캡(거대 옹벽 방지).
  //   기본 3.2m(궁·평지 코어). 절은 배산 사면에 앉아 낙차가 커 Hmax 비례 석축 캡을 별도로 넘긴다(#94).
  padY = Math.min(padY, lo + cap) + PAD_LIFT;
  const group = new THREE.Group(); group.name = 'feature-pad';
  const topP = [], topI = [], skP = [], skI = [];
  emitPad(poly, padY, site, topP, topI, skP, skI);
  if (topI.length) group.add(makeBufMesh(topP, topI, padTopMat, 'feat-pad-top'));
  if (skI.length) group.add(makeBufMesh(skP, skI, padStoneMat, 'feat-pad-skirt'));
  return { group, padY };
}

// ───────────────────────── 집 프로토타입 ─────────────────────────
// buildBuilding(초가/기와) 로 프로토타입을 만들어 clone. 종가·궁·절은 풀디테일 별도.
export function makeHouseProtos() {
  return {
    choga: buildBuilding(PRESETS.choga),
    giwa: buildBuilding(PRESETS.giwa),
  };
}

// 평면 변주 풀 → 변주 인덱스별 decompose 결과 배열(미러 포함). 재질셋은 kind당 1벌로 통일(shareMaterials)
//   → 텍스처·재질 수 고정, 드로우콜은 변주×재질 규모. matset(=canon 프로토 재질)은 야간 창호광용.
function buildKindDecomps(kind) {
  const VAR = kind === 'giwa' ? GIWA_VARIANTS : CHOGA_VARIANTS;
  const base = PRESETS[kind];
  const isChoga = kind !== 'giwa';
  const decomps = new Array(VAR.length);
  let canon = null, matset = null;
  for (let i = 0; i < VAR.length; i++) {
    if (VAR[i].mirrorOf != null) continue;                 // 미러 항목은 2패스에서
    const proto = buildBuilding({ ...base, ...(VAR[i].ov || {}) });
    const M = proto.userData.materials;
    // 재질 공유 제외(변주별 고유 유지): (1) choga 이엉 상태 채(thatch/yongmaru/jipjul, 민가=낡음↔부농=신선),
    //   (2) giwa 창호 살 패턴(#55, 변주별 doorPattern 텍스처 — 공유 시 g-base 띠살이 g-wide 를 덮어씀).
    //   choga 창호는 패턴 단일이라 공유 유지(텍스처 절약).
    let ownSet = null;
    if (isChoga) {
      applyThatchAge(M, VAR[i].thatchAge != null ? VAR[i].thatchAge : 0.5);
      ownSet = new Set([M.thatch, M.yongmaru, M.jipjul]);
    }
    const keepOwn = (m) => (ownSet && ownSet.has(m))
      || (!isChoga && m && m.userData && m.userData.role === 'opening');
    if (!matset) matset = M;                                // canon 재질셋(창호광)
    let d = decomposeByMaterial(proto);                     // 프로토로컬 병합(지오 clone)
    d = canon ? shareMaterials(canon, d, keepOwn) : d;      // 재질 refs 를 canon 으로 통일(이엉 제외)
    if (!canon) canon = d;
    decomps[i] = d;
  }
  for (let i = 0; i < VAR.length; i++) {
    if (VAR[i].mirrorOf != null) decomps[i] = mirrorDecomp(decomps[VAR[i].mirrorOf]);
  }
  return { decomps, matset };
}

// 가벼운 마당 담장(저해상 박스 링) + 남측(로컬 +z) 대문 개구. buildFence 는 무거워 히어로만.
export function lightCourtyard(plotW, plotD, mats, rng, wallH = 1.7) {
  const g = new THREE.Group();
  const hw = plotW / 2, hd = plotD / 2, th = 0.28;
  const gap = Math.min(plotW * 0.32, 2.6);          // 대문 개구 폭(+z 앞면 중앙)
  const wallMat = mats.plaster;
  const seg = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
    m.position.set(x, wallH / 2, z); m.castShadow = m.receiveShadow = true; g.add(m);
  };
  seg(plotW, th, 0, -hd);                            // 북(뒤)
  seg(th, plotD, -hw, 0);                            // 서
  seg(th, plotD, hw, 0);                             // 동
  const side = (plotW - gap) / 2;                    // 남(앞) 양쪽 짧은 단
  seg(side, th, -(gap / 2 + side / 2), hd);
  seg(side, th, (gap / 2 + side / 2), hd);
  // 대문 기둥 2 + 인방(간이 사립/판문 힌트)
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, wallH + 0.5, 6), mats.wood);
    post.position.set(sx * gap / 2, (wallH + 0.5) / 2, hd); post.castShadow = true; g.add(post);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(gap + 0.3, 0.2, 0.2), mats.woodDark);
  lintel.position.set(0, wallH + 0.35, hd); g.add(lintel);
  return g;
}

// 필지 → 컴파운드(집 + 마당 담). rot 은 로컬 +z 를 도로쪽(frontDir+yaw)으로. 비최적화(디버그) 경로.
export function placeParcel(parcel, protos, wallMats, rng, char01 = 0.5) {
  const g = new THREE.Group();
  g.name = `parcel-${parcel.kind}`;
  const kind = parcel.kind;
  // 집 본체(디버그 경로는 기본 프로토만 — 변주 스케일은 반영, 평면 변주는 최적화 경로 전용)
  const house = (kind === 'giwa' ? protos.giwa : protos.choga).clone(true);
  const back = -parcel.plotD / 2 + (kind === 'giwa' ? 5.2 : 3.4);
  house.position.set(0, 0, back);
  house.scale.set(parcel.sx || 1, parcel.sy || 1, parcel.sz || 1);
  g.add(house);
  // 마당 담 — 유형(tile/stone/brush)·부속채 어휘. 필지 부정형 shape 를 따라 변별 담.
  g.add(buildVillageWall(parcel.shape, wallMats, {
    style: parcel.wallType || 'stone', kind: parcel.kind, seed: parcel.seed, char01,
    aux: parcel.aux, plotW: parcel.plotW, plotD: parcel.plotD,
    wallHeightK: parcel.wallHeightK, jangdok: parcel.jangdok,
    yardStack: parcel.yardStack, clothesline: parcel.clothesline, vegBed: parcel.vegBed,
  }));
  g.rotation.y = parcelRotY(parcel);
  g.position.set(parcel.center.x, parcel.baseY || 0, parcel.center.z);
  g.userData.parcel = parcel;
  return g;
}

// ───────────────────────── 최상위 ─────────────────────────
// populateVillage(plan, { optimize })
//   optimize(기본 true): 정규 주택 → 재질별 InstancedMesh, 담·도로·논·랜드마크 → 재질별
//     정적 병합. 드로우콜을 "재질 수" 규모로 눌러 60fps 확보(instancing.js). userData 로
//     인스턴스 핸들·재질셋을 노출해 adapter.js 가 픽킹·편집·야간광에 쓴다.
//   optimize=false: 기존 필지별 clone 경로(디버그·개별 검증용).
// 원경 청크 런타임 LOD 스왑 — 카메라가 다가오면 저폴리 임포스터 → 풀디테일 전환.
//   #92 자유 줌 이후 한양 스케일에서 줌인해도 원경 박스 매스가 그대로 보이던 문제 해소.
//   카메라-청크중심 거리를 매 프레임 판정해 visible 토글. 히스테리시스(진입/복귀 분리)로
//   경계 왕복 플리커 방지. far 청크만 대상(near 청크는 항상 풀디테일).
const _lodCenter = new THREE.Vector3();   // 매 프레임 재사용 (GC 방지)
function attachChunkLodSwap(chunkGroup, impostor, fullDetail, chunkCenter, bowlR) {
  // 스왑 임계: farDist(bowlR*0.62) 안쪽 0.72배 지점에서 풀디테일 진입,
  //   0.85배 지점에서 임포스터 복귀 — 히스테리시스 폭 ≈ bowlR*0.08.
  const swapIn  = bowlR * 0.62 * 0.72;   // 풀디테일 전환 거리(가까움)
  const swapOut = bowlR * 0.62 * 0.85;   // 임포스터 복귀 거리(멀어짐)
  let showFull = false;

  // 반환: 이 프레임에 스왑(임포스터↔풀디테일 토글)이 일어나면 true — 렌더 루프(#140-E)가 그림자 캐시
  //   모드에서 캐스터 구성 변경(임포스터 castShadow=false ↔ 풀디테일 캐스팅)을 1프레임 반영하는 데 쓴다.
  chunkGroup.userData.lodUpdate = (camera) => {
    _lodCenter.set(chunkCenter.x, camera.position.y, chunkCenter.z);   // Y 는 카메라 높이로 맞춰 수직 거리 무시(부감 줌)
    const d = _lodCenter.distanceTo(camera.position);
    if (!showFull && d < swapIn) {
      impostor.visible = false;
      fullDetail.visible = true;
      showFull = true;
      return true;
    } else if (showFull && d > swapOut) {
      impostor.visible = true;
      fullDetail.visible = false;
      showFull = false;
      return true;
    }
    return false;
  };
}

// 동기 진입점(기존 계약 불변) — 아래 제너레이터를 완전 소진해 root 를 반환한다.
//   shoot/verify 도구·adapter sync 경로가 이 시그니처를 그대로 쓴다(결정론·픽셀 동일).
export function populateVillage(plan, opts = {}) {
  const it = populateVillageSteps(plan, opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

// 조립 제너레이터(#123) — 마을 조립을 "의미 단위 스텝"으로 쪼개, 각 스텝 뒤 yield 로 제어를 넘긴다.
//   · 동기 소진(populateVillage) == 기존 body 를 일직선 실행 → 픽셀·결정론 완전 동일(리팩터 등가).
//   · createVillageAsync(adapter) 는 이 스텝들을 rAF 프레임에 분산 구동(롱프레임 스파이크 해소).
//   yield 값(라벨)은 진행 리포트·프레임 예산 판정용. 전역 Math.random 소비 스텝(parcels/features 등)은
//   adapter 가 매 .next() 슬라이스를 시드창으로 감싸 소비 순서를 동기 경로와 byte-identical 하게 유지한다.
export function* populateVillageSteps(plan, opts = {}) {
  const optimize = opts.optimize !== false;
  const site = plan.site;
  const root = new THREE.Group();
  root.name = `village-${plan.opts.scale}`;
  const rng = makeRng((plan.seed ^ 0xbeef) >>> 0);
  const char01 = typeof plan.opts.char01 === 'number' ? plan.opts.char01 : 0.5;

  // 물 uniform(개울 공유)
  const waterU = createWaterUniforms();
  // 흐르는 구름 그림자 uniform(지형 재질 ↔ clouds 빌보드 공유). 빌보드 자체는 sun 이 필요해
  //   어댑터가 마을 진입 시 붙인다(populate 는 uniform·그림자 패치·운해 링까지만 — sun 무관 결정론).
  const cloudU = createCloudUniforms();

  // 1) 지형 · 2) 개울 (단일 메시 — 병합 대상 아님)
  //   지형 최외곽은 site.edge 로 신축(비정형 테두리). warpInner 안쪽(마을·논·개울·필지·랜드마크)은 불변.
  // #143 R*0.9 바닥을 terrainR 안으로 캡 — 한양(R*0.9=450 > terrainR=380)서 신축밴드 소멸→사각 테두리 해소.
  //   ★ forest-crunch.js crunchForest 의 warpInner 와 동일식 유지(워커=동기 byte-identical 필수).
  const warpInner = Math.max(computeFixedRadius(plan, site) + 6, Math.min(site.R * 0.9, (site.terrainR || site.R) - 6));
  // 구조물 거리 필드(#115) — 지형 황토색·숲 침투 식재가 공유(개활지=집 윤곽, 비원형).
  const clearDist = makeClearance(plan, site);
  yield 'setup+clearance';
  const terrain = buildSiteTerrain(site, cloudU, warpInner, clearDist);
  root.add(terrain.mesh);
  yield 'terrain';
  // 저층 운해 링 — 비정형 외곽선을 따라 지형 등고에 밀착(groundY)해 배산 능선 사면을 감고 분지
  //   가장자리에 얕게 고인다. rIn 을 안으로 넓혀(≈0.58) 능선 중턱까지 걸치므로 부감에선 "감는 운해",
  //   아이레벨에선 "사면 원경 물안개"로 함께 읽힌다. lift 는 지형 위 소량(등고 위로 살짝 뜸).
  const mist = site.edge
    ? buildEdgeMistRing(site.edge, {
        groundY: site.heightAt,
        rIn: 0.58, rMid: 0.84, rOut: 1.12,
        yBase: Math.max(5, site.Hmax * 0.09), yAmp: Math.max(2.5, site.Hmax * 0.05),
        thickness: Math.max(4, site.Hmax * 0.12), opacity: 0.5,
        seed: (plan.seed ^ 0x3117) >>> 0,
      })
    : null;
  if (mist) root.add(mist.mesh);
  // 배산 능선 물안개(아이레벨 원경) — 뒤(북) 반원의 "분지를 바라보는 근사면" 중턱에 카메라 대면
  //   소프트 뱅크. 각 방위에서 안쪽(bowl)→밖으로 표고를 스캔해 목표 중턱높이 첫 교차점(근사면)을
  //   찾아 그 지형면 살짝 위에 얹는다 → 진입 시점에서 능선에 걸친 원경 물안개로 읽힌다.
  const ridgeMistAnchors = site.edge ? computeRidgeMistAnchors(site) : [];
  const ridgeMist = ridgeMistAnchors.length
    ? buildRidgeMist(ridgeMistAnchors, { opacity: 0.34, seed: (plan.seed ^ 0x5a3d) >>> 0 })
    : null;
  if (ridgeMist) root.add(ridgeMist.group);
  const water = buildWaterRibbon(site, waterU);
  if (water) root.add(water);
  yield 'mist+water';

  const landmarks = [];    // 유일 지오(정자·다리·소품·궁·절) → 재질별 정적 병합
  const matSets = [];      // 야간 창호광 등 env 패치 대상 공유 재질셋
  const houseHandle = { giwa: null, choga: null };
  // 히어로 필지(종가·반가 대형)만 병합 제외·개별 그룹 — 어댑터가 visible 토글 + buildParcel 오버레이로
  //   교체(랜딩 조립·클로즈업·편집, #62). 키=parcel.id(=`p${i}`, 픽킹·rebuildParcel 과 동일 키공간).
  const heroHandle = new Map();

  // 3) 도로 · 4) 논 (병합 후 추가)
  const roadsGroup = (plan.roads && plan.roads.length) ? buildRoads(site, plan.roads) : null;
  const paddyGroup = plan.paddies ? buildPaddyFields(site, plan.paddies) : null;
  yield 'roads+paddy';

  // 5) 필지(집·담·문)
  if (plan.parcels && plan.parcels.length) {
    // 담장 공유 재질셋(전 필지 1벌) — 유형(tile/stone/brush) 무관 단일 팔레트라 병합 후 드로우콜 최소.
    const wallMats = makeMaterials('giwa');
    // 필지 성토 패드 높이(집·마당·담이 한 레벨). 인접 필지 낙차 → 계단식 단차.
    for (const p of plan.parcels) p.baseY = computePadY(p, site);
    root.add(buildParcelPads(plan.parcels, site));   // 기단 상면 + 축대(옹벽) — 2 드로우콜

    // 원경 청크 런타임 LOD 스왑(#92 자유 줌: 임포스터는 부감 전용인데 다가가도 박스 매스가 남던 문제).
    //   구현은 모듈 스코프 attachChunkLodSwap(L818) — chunkGroup.userData.lodUpdate 에 부착하고 렌더 루프
    //   (engine → adapter.updateLod → root.updateChunkLod)가 매 프레임 카메라로 구동한다. (구 onBeforeRender
    //   방식은 imp 가 Group 이라 three 렌더러가 콜백을 안 불러 무동작 → #140-E 에서 제거·이관 완결.)
    const heroes = plan.parcels.filter((p) => p.hero);
    const regular = plan.parcels.filter((p) => !p.hero);
    const regGiwa = regular.filter((p) => p.kind === 'giwa');
    const regChoga = regular.filter((p) => p.kind !== 'giwa');

    if (optimize) {
      // ── 링-청크 인스턴싱(#47) ── 정규 주택·담을 앵커 방사 청크로 분할해 각 청크를 독립 그룹으로
      //   짓는다(청크별 InstancedMesh + 청크별 병합 담) → 바운딩이 좁아져 frustum culling 이 살아난다.
      //   재질셋(변주 decomp)은 kind당 1벌 재사용(청크 간 공유) — 텍스처·재질 수는 불변, 드로우콜만
      //   청크 수만큼 분할된다. 소규모(≤70호)는 단일 청크라 기존 룩·드로우콜 회귀 없음(chunks.sectorsFor).
      const giwaPool = regGiwa.length ? buildKindDecomps('giwa') : null;
      const chogaPool = regChoga.length ? buildKindDecomps('choga') : null;
      if (giwaPool) matSets.push(giwaPool.matset);
      if (chogaPool) matSets.push(chogaPool.matset);
      // 그림자 캐스터 다이어트 + 원경 임포스터: 원경 청크(중심에서 farDist 초과)는 castShadow off /
      //   저폴리 임포스터로 대체 — 부감 원경 집 디테일·그림자는 픽셀 이하라 무영향이고 지오 제출을 크게
      //   줄인다. 대규모(#89 연속: R≥340)에서 적용 — capital 앵커(R250)=Infinity·hanyang(R500)=diet 로
      //   양 앵커 불변. 임계를 375→340 로 낮춰 R340~400 대형 도성(무성곽)의 삼각형 스파이크를 흡수한다.
      const farDist = site.R >= 340 ? site.bowlR * 0.62 : Infinity;
      const chunks = partitionParcels(regular, site.center, { farDist });
      const chunkMeta = [];
      const giwaGroups = [], chogaGroups = [], wallGroups = [];
      for (const chunk of chunks) {
        const cg = new THREE.Group();
        cg.name = `village-chunk-${chunk.ring}-${chunk.sector}`;
        cg.userData.chunk = { ring: chunk.ring, sector: chunk.sector, order: chunk.order, dist: chunk.dist, center: chunk.center, far: chunk.far };
        const buildFullDetail = (into) => {
          const cGiwa = chunk.parcels.filter((p) => p.kind === 'giwa');
          const cChoga = chunk.parcels.filter((p) => p.kind !== 'giwa');
          if (cGiwa.length && giwaPool) { const hg = buildHouseInstances('giwa', cGiwa, giwaPool.decomps); into.add(hg); giwaGroups.push(hg); }
          if (cChoga.length && chogaPool) { const hg = buildHouseInstances('choga', cChoga, chogaPool.decomps); into.add(hg); chogaGroups.push(hg); }
          const walls = chunk.parcels.map((p) => buildCourtyard(p, wallMats, char01));
          // #148: ids 로 필지별 정점 레인지 기록 → focus 오버레이가 그 필지 병합 담만 접어 이중 렌더 제거.
          const wg = mergeStatic(walls, `village-walls-${chunk.ring}-${chunk.sector}`, { ids: chunk.parcels.map((p) => p.id) });
          into.add(wg); wallGroups.push(wg);
        };
        if (chunk.far) {
          // 원경 청크: 저폴리 임포스터 + 숨겨둔 풀디테일 — 카메라가 다가오면 스왑(런타임 LOD).
          //   임포스터만 두면 줌인해도 박스 매스가 그대로 보인다(#92 자유 줌 이후 사용자 지적).
          const imp = buildChunkImpostor(chunk.parcels, `impostor-${chunk.ring}-${chunk.sector}`);
          cg.add(imp);
          const full = new THREE.Group();
          full.name = `chunk-full-${chunk.ring}-${chunk.sector}`;
          buildFullDetail(full);
          full.visible = false;
          cg.add(full);
          attachChunkLodSwap(cg, imp, full, chunk.center, site.bowlR);   // #140-E lodUpdate 를 cg 에 부착(모듈 스코프)
        } else {
          // 근경 청크: 풀디테일 변주 인스턴싱 + 병합 담.
          buildFullDetail(cg);
        }
        root.add(cg);
        chunkMeta.push(cg.userData.chunk);
      }
      // 결합 은닉 핸들(픽킹·편집이 id 로 필지 은닉 — 청크 가로질러 dispatch). scene 추가 안 함(청크가 담음).
      //   far 청크 풀디테일도 giwaGroups/chogaGroups 에 포함되므로 스왑 후 은닉 dispatch 정상.
      houseHandle.giwa = giwaGroups.length ? { userData: combineHouseHandles('giwa', giwaGroups) } : null;
      houseHandle.choga = chogaGroups.length ? { userData: combineHouseHandles('choga', chogaGroups) } : null;
      houseHandle.chunks = chunkMeta;
      // #148: 병합 담 필지별 은닉 핸들 — focus 오버레이가 자기 필지 병합 담을 접어 이중 렌더 제거.
      houseHandle.walls = wallGroups.length ? combineWallHandles(wallGroups) : null;
    } else {
      const protos = makeHouseProtos();
      matSets.push(protos.giwa.userData.materials, protos.choga.userData.materials);
      for (const p of regular) root.add(placeParcel(p, protos, wallMats, rng, char01));
    }
    // 히어로(종가·반가 대형) — landmarks 전체 병합에선 빼되 "히어로별 개별 병합" 그룹으로 root 직속.
    //   개별 그룹이라 어댑터가 하나씩 visible 토글 + buildParcel 풀디테일 오버레이로 교체(랜딩·클로즈업·
    //   편집, #62). 히어로별 병합(mergeStatic)이라 컴파운드 수십 메시가 재질별로 접혀 드로우콜은 소수.
    //   병합 전 원본에서 재질셋(door/hanji) 수집(야간 창호광) — 병합 후 메시엔 userData.materials 없음.
    for (const p of heroes) {
      const raw = buildHeroParcel(p, site, rng);
      collectMatSets(raw, matSets);
      const g = mergeStatic([raw], `hero-${p.id}`);
      root.add(g);
      heroHandle.set(p.id, g);
    }
  }
  yield 'parcels/houses';

  // 6) 공용: 정자·다리·소품·절·궁 (유일 지오 → 랜드마크 병합군)
  //   단, 궁(palace-core)은 히어로(종가)처럼 랜드마크 병합에서 제외한다 — mergeStatic 이 일곽 그룹·
  //   palaceHandle 구조를 재질별로 접으면 편집 핸들이 소멸하므로 미병합으로 root 직속(#93). palace.js 가
  //   이미 일곽 단위 내부 병합(궁역 ~778콜)이라 미병합 노출해도 net 드로우콜 동등. 재질셋(야간 창호광)은
  //   병합 여부와 무관하게 병합 전 원본에서 그대로 수집(parity). 절 등 나머지 랜드마크는 그대로 병합.
  let palaceCore = null;
  if (plan.features) {
    for (const o of buildFeatureObjects(plan, site, waterU, rng)) {
      collectMatSets(o, matSets);
      if (o.name === 'palace-core') palaceCore = o;
      else landmarks.push(o);
    }
  }

  // 6.5) 성곽·사대문 + 시전행랑(한양) — 링 전체를 두르는 큰 오브젝트라 랜드마크 병합(중심 바운딩)에
  //   넣지 않고 자체 그룹으로 추가한다(성곽은 소수 재질, 시전은 자체 병합).
  if (plan.features && plan.features.cityWall) root.add(buildCityWall(plan.features.cityWall, site));
  if (plan.features && plan.features.sijeon && plan.features.sijeon.length) root.add(buildSijeon(plan.features.sijeon, site));
  yield 'features+wall+sijeon';

  // 병합 반영(optimize) — 로드·논·랜드마크를 재질별로 접는다.
  if (optimize) {
    if (roadsGroup) root.add(mergeStatic([roadsGroup], 'village-roads'));
    if (paddyGroup) root.add(mergeStatic([paddyGroup], 'village-paddies'));
    if (landmarks.length) root.add(mergeStatic(landmarks, 'village-landmarks'));
  } else {
    if (roadsGroup) root.add(roadsGroup);
    if (paddyGroup) root.add(paddyGroup);
    for (const o of landmarks) root.add(o);
  }

  // 궁 코어 — 부감=전곽 재질별 병합본(드로우콜 −350), focus/편집=미병합 오버레이(#140-B, 히어로 #62 동형).
  //   #88 이 palace.js 에서 일곽 단위로만 병합해 palace-core 는 여전히 ~428 메시(편집 핸들 보존 #93)로
  //   부감에도 상시 미병합이었다. 여기서 optimize 시 전곽을 한 번 더 재질별로 접어(mergeStatic) 부감엔
  //   병합본만 렌더하고, 미병합 palace-core 는 편집 오버레이의 메타데이터(핸들·변환·재질) 소스로만 보존한다
  //   (씬 미추가). 병합은 지오를 clone 하므로 원본 지오는 dispose 해 힙 중복을 없앤다(재질은 공유 — 오버레이·
  //   병합본이 같은 재질 refs 를 재사용하므로 야간 창호광·#129 앵커·픽셀 정합 불변). 어댑터가
  //   palaceMerged.visible 을 부감↔focus 로 토글하고, palaceCore.userData(palaceCompound 핸들)로 오버레이를 짓는다.
  let palaceMerged = null;
  if (palaceCore) {
    if (optimize) {
      palaceMerged = mergeStatic([palaceCore], 'palace-merged');
      palaceCore.traverse((o) => { if (o.isMesh || o.isInstancedMesh) o.geometry?.dispose?.(); });
      root.add(palaceMerged);
    } else {
      root.add(palaceCore);   // 디버그(비최적화) 경로: 미병합 그대로 노출
    }
  }
  yield 'merges';

  // 7) 수목(맨 마지막: 건물 마스크 확정 후) — 이미 InstancedMesh(vertexColors)라 병합 제외
  //    warpInner 를 넘겨 나무를 지형 메시와 동일한 신축면에 앉힌다(#86 부유 차단).
  const mask = makeTreeMask(plan, site);
  const treeDensityK = (plan.opts.tuning && plan.opts.tuning.treeDensityK != null) ? plan.opts.tuning.treeDensityK : 1;
  root.add(scatterTrees(site, mask, plan.seed, warpInner, treeDensityK));
  yield 'trees';

  // 7.5) 산 숲(#113) — 캐노피 쉘(빽빽한 활엽 사면) + 화강암 암괴 노두. 배산 사면을 "듬성한 나무 꽂힌
  //     언덕"이 아니라 "숲으로 덮인 한국 산"으로. 나무와 동일 신축면(warp)·마스크(도로·필지·논 제외).
  //     쉘 1 + 바위 1 = 신규 +2 드로우콜, 쉘은 구름 그림자·엣지 헤이즈를 지형과 동형으로 수신.
  // #123 워커 오프로드: createVillageAsync 가 워커에서 미리 계산한 forest 크런치 버퍼를 opts.forestCrunchRef
  //   로 주입하면 그 버퍼로 조립만(메인 스레드 배치 루프 생략 → 롱프레임 제거). 없으면 메인에서 크런치
  //   (동기 createVillage·?worker=0·shoot 도구 — 결정론 동일, warp/mask/clearDist 재사용).
  const preForest = opts.forestCrunchRef ? opts.forestCrunchRef.value : (opts.forestCrunch || null);
  const forest = buildForest(plan, site, makeEdgeWarp(site, warpInner), mask, cloudU, clearDist, preForest);
  root.add(forest.group);
  yield 'forest';

  // 8) 마당 과실수·반가 정원·마을 보호수(당산나무) — 레이어별 정적 병합(드로우콜 ~5), 계절 토글.
  const flora = buildVillageFlora(plan, site, plan.seed);
  root.add(flora.group);
  yield 'flora';

  // 9) 소동물(마당 닭·논 소) — 필지 마당·논 앵커 재사용, 필지별 시드 결정론·과밀 금지.
  const animals = buildVillageAnimals(root, plan, site);

  // 10) 원경 창불 발광 포인트(#60) — 부감 야경 점점이 창불. 단일 Points 1 드로우콜,
  //     점등 곡선은 adapter vnight(0..1)를 매 틱 받아 반영(크로스페이드 자동 정합).
  const nightLights = buildNightLights(plan, site);
  root.add(nightLights.group);

  // 11) 봄 개화 관목(진달래·개나리, #107) — 봄을 가을만큼의 백미로. 진달래는 나무와 동일 신축면(warp)
  //     위 뒷산 사면 군락, 개나리는 담장 밖·길가(고샅 가장자리) 노랑 띠. 봄에만 가시(setSeason).
  //     종별 단일 InstancedMesh + instanceColor → +2 드로우콜. 나무 마스크 재사용(도로·필지 회피).
  const bloom = buildSpringBloom(plan, site, makeEdgeWarp(site, warpInner), mask);
  root.add(bloom.group);

  // 12) 지붕 구름 그림자(#110) — 지형과 같은 cloudU 를 지붕 재질에 얹어 밀집 부감(한양)에서도 그늘이
  //     지붕 위를 흐르게 한다. 어댑터 진입 시 setupClouds 가 이 cloudU 를 갱신하므로 지형·지붕·빌보드가
  //     한 uniform 으로 정합. 순수 셰이더 패치라 드로우콜·재질 수 불변, 첫 렌더 전(반환 전) 수행.
  injectVillageCloudShadow(root, cloudU);
  yield 'animals+night+bloom+cloudshadow';

  root.userData = {
    plan, waterU, matSets, houseHandle, heroHandle, optimize, flora, animals, nightLights, bloom, forest,
    palaceCore,   // 궁 편집 핸들(#93) — 미병합 palace-core 그룹(궁 없으면 null), userData.palaceCompound 로 일곽 접근
    palaceMerged, // #140-B 부감 병합본(궁 없거나 비최적화면 null) — 어댑터가 focus-in 시 가리고 오버레이로 교체(히어로 #62 동형)

    // 흐르는 구름 그림자 공유 uniform(어댑터가 진입 시 setupClouds 에 넘겨 빌보드가 갱신) + 외곽선.
    cloudUniforms: cloudU, edge: site.edge, terrainMax: site.terrainR,
    setWaterTime: (name) => setVillageWaterTime(waterU, name),   // 개울 물 시간대 톤(어댑터 setTime 이 호출)
    setAnimalsTime: (name) => { for (const a of animals.handles) a.setTime(name); },
    setSeason: (name) => { terrain.setSeason(name); flora.setSeason(name); bloom.setSeason(name); forest.setSeason(name); for (const a of animals.handles) a.setSeason(name); },
    // 엣지 헤이즈·운해 링·능선 물안개 색을 대기(fog)색과 동기화 — 어댑터 fog 모디파이어가 매 틱 호출(#50 정합).
    setEnvHaze: (fogColor) => { terrain.setHaze(fogColor); forest.setHaze(fogColor); mist?.update(fogColor); ridgeMist?.update(fogColor); },
    // 검증 앵커(하네스 프레이밍용)
    guardianAnchors: flora.guardianAnchors, yardTreeAnchors: flora.yardTreeAnchors,
    gardenAnchors: flora.gardenAnchors,
    flockCenters: animals.flockCenters, cowAnchors: animals.cowAnchors,
    debugFlockCenter: () => animals.flockCenters[0] || null,
    debugCowAnchor: () => animals.cowAnchors[0] || null,
    // 창불 발광 포인트 점등 레벨 갱신(어댑터 stepNightGlow 가 vnight 를 넘겨줌, #60/#50 정합).
    updateNightLights: (dt, level) => nightLights.update(dt, level),
    update: (dt) => { waterU.uTime.value += dt; for (const a of animals.handles) a.update(dt); },
    // 런타임 LOD 스왑 — 원경 청크 임포스터↔풀디테일(매 프레임, 카메라 필요).
    //   engine.js 렌더 루프에서 camera 넘겨 호출. far 청크가 없으면(R<340) 빈 배열라 no-op.
    updateChunkLod: (camera) => {
      let swaps = 0;   // #140-E 이 프레임에 임포스터↔풀디테일 스왑이 일어난 청크 수(그림자 1프레임 갱신 트리거)
      for (const child of root.children) {
        if (child.userData.lodUpdate?.(camera)) swaps++;
      }
      return swaps;
    },
  };
  return root;
}

// 소동물 배치: 초가 마당(닭 무리)·논(소). setupAnimals(env/animals.js) API 재사용.
//   과밀·드로우콜 방지로 규모별 상한. 지면 Y 는 필지 성토 패드(baseY)·논면(f.y) 상수로 얹는다.
function buildVillageAnimals(root, plan, site) {
  const scale = plan.opts.scale;
  const rng = makeRng((plan.seed ^ 0x0a2117) >>> 0);
  const handles = [], flockCenters = [], cowAnchors = [];
  // 닭: 초가 필지 ~1/4, 규모별 상한(초가 있으면 최소 1 보장·결정론적 분산 선택).
  const chickenCap = { hamlet: 1, village: 2, town: 3, capital: 4 }[scale] || 2;
  const choga = (plan.parcels || []).filter((p) => !p.hero && p.kind !== 'giwa' && p.poly);
  const nWant = Math.min(chickenCap, Math.max(choga.length ? 1 : 0, Math.round(choga.length * 0.25)));
  const scored = choga.map((p) => ({ p, k: makeRng((p.seed ^ 0xc4c0) >>> 0)() })).sort((a, b) => a.k - b.k);
  for (let i = 0; i < nWant; i++) {
    const p = scored[i].p;
    const lx = p.plotW * 0.08, lz = p.plotD * 0.24;                  // 앞마당(대문 안쪽) 살짝 off-axis
    const pm = new THREE.Matrix4().makeTranslation(p.center.x, p.baseY || 0, p.center.z)
      .multiply(new THREE.Matrix4().makeRotationY(parcelRotY(p)));
    const v = new THREE.Vector3(lx, 0, lz).applyMatrix4(pm);
    const baseY = p.baseY != null ? p.baseY : site.heightAt(p.center.x, p.center.z);
    handles.push(setupAnimals(root, { heightAt: () => baseY, yard: { x: v.x, z: v.z, r: 1.6 }, seed: (p.seed ^ 0x6b17) >>> 0 }));
    flockCenters.push({ x: v.x, y: baseY + 0.4, z: v.z });
  }
  // 소: 논 필지 1~2(규모별) — 큰 논 우선, 분산 선택.
  const cowCap = (scale === 'town' || scale === 'capital') ? 2 : 1;
  const paddies = (plan.paddies || []).slice().sort((a, b) => Math.abs(G.polyArea(b.poly)) - Math.abs(G.polyArea(a.poly)));
  const nCow = Math.min(cowCap, paddies.length);
  for (let i = 0; i < nCow; i++) {
    const f = paddies[Math.floor(i * paddies.length / nCow)];
    const c = G.polyCentroid(f.poly);
    handles.push(setupAnimals(root, { heightAt: () => f.y, cowSite: { x: c.x, z: c.z, yaw: rng.range(0, Math.PI * 2) }, seed: (plan.seed ^ (0x50 + i)) >>> 0, chickens: false }));
    cowAnchors.push({ x: c.x, y: f.y + 1.0, z: c.z });
  }
  return { handles, flockCenters, cowAnchors };
}

// 필지 담·마당(어휘 격상: tile/stone/brush + 부속채) 을 필지 배치 변환까지 얹어 반환 — mergeStatic 이 구워 붙인다.
export function buildCourtyard(parcel, wallMats, char01) {
  const g = buildVillageWall(parcel.shape, wallMats, {
    style: parcel.wallType || 'stone', kind: parcel.kind, seed: parcel.seed, char01,
    aux: parcel.aux, plotW: parcel.plotW, plotD: parcel.plotD,
    // #55: 담 높이 연속 변주 + 마당 부속 소품(신분 상관). 전부 공유 재질 → 병합 후 드로우콜 불변.
    wallHeightK: parcel.wallHeightK, jangdok: parcel.jangdok,
    yardStack: parcel.yardStack, clothesline: parcel.clothesline, vegBed: parcel.vegBed,
  });
  g.applyMatrix4(parcelMatrix(parcel));
  return g;
}

// 시전행랑(선형 상업, 한양) — 간선 파사드 연립 점포. 각 칸을 기와 맞배 소옥으로 짓고 재질별 병합.
//   연이어 놓여 벽식 상가 열로 읽힌다. 자체 기와 팔레트(소수 재질)로 병합 후 드로우콜 소수.
function buildSijeon(shops, site) {
  const mats = makeMaterials('giwa');
  const bodyMat = mats.plaster, beamMat = mats.woodDark;
  const tileMat = mats.tileFlat.clone(); tileMat.side = THREE.DoubleSide;   // 수작업 지붕 와인딩 컬링 방지
  const grp = new THREE.Group();
  for (const s of shops) {
    const unit = new THREE.Group();
    const w = s.w * 0.96, d = s.d * 0.86, bodyH = 3.0;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, bodyH, d), bodyMat);
    body.position.y = bodyH / 2; body.castShadow = body.receiveShadow = true; unit.add(body);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.4, d + 0.1), beamMat);
    beam.position.y = bodyH - 0.2; unit.add(beam);
    const roof = gableRoof(w + 1.4, d + 1.6, 1.7, tileMat);   // 맞배 기와(용마루 도로 평행)
    roof.position.y = bodyH; roof.castShadow = true; roof.receiveShadow = true; unit.add(roof);
    unit.position.set(s.center.x, site.heightAt(s.center.x, s.center.z), s.center.z);
    unit.rotation.y = G.facingY(s.frontDir);
    grp.add(unit);
  }
  return mergeStatic([grp], 'village-sijeon');
}

// 맞배(gable) 지붕 프리즘 — 용마루가 로컬 x축, 앞뒤(±z)로 흘러내림. 외향 노멀(수동 와인딩 검증).
function gableRoof(w, d, h, mat) {
  const hw = w / 2, hd = d / 2;
  const P = [-hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd, -hw, h, 0, hw, h, 0];
  const I = [3, 2, 5, 3, 5, 4, 1, 0, 4, 1, 4, 5, 0, 3, 4, 2, 1, 5];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I); g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

// 컴파운드 내부의 공유 재질셋(door/hanji 등)을 수집 — 야간 창호광 패치 대상.
function collectMatSets(obj, into) {
  obj.traverse((o) => {
    const m = o.userData && (o.userData.materials || o.userData.mats);
    if (m && m.door && !into.includes(m)) into.push(m);
  });
}

// (makeTreeMask·makeClearance 는 #123 에서 forest-crunch.js 로 이설 — 워커 공유. 상단 import 참조.)

// 다랑이 논(간이): 필드 폴리곤을 평평한 계단면으로. 계절색은 여름 초록 기본.
function buildPaddyFields(site, paddies) {
  const group = new THREE.Group(); group.name = 'village-paddies';
  const matCache = new Map();
  const fieldMatFor = (tone) => {
    if (!matCache.has(tone)) matCache.set(tone, new THREE.MeshStandardMaterial({ color: tone, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
    return matCache.get(tone);
  };
  // 논둑 어휘: 도성(big=hanyang)만 #78 top-down 가독용으로 격상(밝은 마른흙·수평 상면 캡).
  //   타 규모(hamlet~capital)는 기존 낮은 어두운 리본 그대로 — 룩 무회귀.
  const big = site.R > 300;
  const bundMat = big
    ? new THREE.MeshStandardMaterial({ color: 0x94875a, roughness: 1, metalness: 0, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: 0x7a7048, roughness: 1, metalness: 0 });
  const BUND_H = big ? 0.34 : 0.22;    // 논둑 높이(부감 그림자선)
  const BUND_TOP = 1.1;                 // 논둑 상면 폭(수평 캡) — top-down 격자 가독(도성)
  for (const f of paddies) {
    const y = f.y;
    // 논면(폴리곤 팬)
    const shape = new THREE.Shape();
    f.poly.forEach((p, i) => (i ? shape.lineTo(p.x, -p.z) : shape.moveTo(p.x, -p.z)));
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, fieldMatFor(f.tone || 0x6a7b3f));
    mesh.position.y = y;
    mesh.receiveShadow = true;
    group.add(mesh);
    // 논둑(테두리) 리본. 도성은 수직 옹벽(그림자선) + 수평 상면(top-down 밝은 격자선).
    const ring = [...f.poly, f.poly[0]];
    const yt = y + BUND_H;
    const pos = [], idx = [];
    if (big) {
      const cen = { x: 0, z: 0 };
      for (const p of f.poly) { cen.x += p.x; cen.z += p.z; }
      cen.x /= f.poly.length; cen.z /= f.poly.length;
      // 각 정점마다 3점: 외곽(밑·위) + 안쪽 캡(위). 안쪽은 중심으로 BUND_TOP 만큼 당김.
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        let dx = cen.x - p.x, dz = cen.z - p.z; const dl = Math.hypot(dx, dz) || 1;
        const step = Math.min(BUND_TOP, dl * 0.45);   // 작은 배미에서 중심 넘지 않게
        dx = dx / dl * step; dz = dz / dl * step;
        pos.push(p.x, y, p.z);            // 0: 외곽 밑
        pos.push(p.x, yt, p.z);           // 1: 외곽 위
        pos.push(p.x + dx, yt, p.z + dz); // 2: 안쪽 캡(위)
      }
      for (let i = 0; i < ring.length - 1; i++) {
        const a = i * 3, b = a + 3;
        idx.push(a, b, a + 1, a + 1, b, b + 1);             // 수직 외벽
        idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); // 수평 캡
      }
    } else {
      // 기존 낮은 리본(수직만) — 타 규모 무회귀.
      for (let i = 0; i < ring.length; i++) { const p = ring[i]; pos.push(p.x, y, p.z, p.x, yt, p.z); }
      for (let i = 0; i < ring.length - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    bg.setIndex(idx); bg.computeVertexNormals();
    group.add(new THREE.Mesh(bg, bundMat));
  }
  return group;
}

// 히어로 필지(종가·반가 대형): buildParcel 풀디테일. 지면에 앉히고 도로쪽으로 회전.
export function buildHeroParcel(parcel, site, rng) {
  const g = new THREE.Group();
  const style = parcel.heroStyle || 'hanok';
  // lanterns:false — 병합(mergeStatic) 히어로. 등롱(PointLight)은 병합에 유실되고 bulb 는 발광 재질
  //   그룹을 하나 더 만들어 부감 드로우콜을 늘린다. 부감 히어로 야간 등불은 flora-lantern(정적 병합,
  //   parcel.lantern)이 담당하고, 흔들리는 풀디테일 등롱은 focus 오버레이(adapter buildParcel 기본)가 갖는다.
  const compound = buildParcel({ seed: parcel.seed || 7, style, plotW: parcel.plotW, plotD: parcel.plotD, lanterns: false });
  g.add(compound);
  g.rotation.y = G.facingY(parcel.frontDir);
  // 히어로도 정규 필지와 같은 성토 패드 높이에 앉힌다(패드는 buildParcelPads 가 이미 깖).
  const baseY = parcel.baseY != null ? parcel.baseY : computePadY(parcel, site);
  g.position.set(parcel.center.x, baseY, parcel.center.z);
  g.userData.parcel = parcel;
  return g;
}

// 공용부: 정자·다리·소품·절·궁 → 배치된 THREE.Object3D 배열(호출부가 병합/직접추가 결정).
function buildFeatureObjects(plan, site, waterU, rng) {
  const F = plan.features;
  const out = [];
  // 정자(마을 중심/초입)
  if (F.pavilion) {
    const pav = buildPavilion({ sides: F.pavilion.sides || 6 });
    pav.position.set(F.pavilion.x, site.heightAt(F.pavilion.x, F.pavilion.z), F.pavilion.z);
    pav.rotation.y = F.pavilion.rot || 0;
    out.push(pav);
  }
  // 돌다리(개울 위) — 양안 높이에 맞춰 앉힘(뜸/파묻힘 방지).
  for (const b of (F.bridges || [])) {
    const br = buildBridge({ type: b.type || 'slab', span: b.span || 5, width: b.width || 1.8 });
    const bz = site.streamZat(b.x);
    const bank = Math.max(
      site.heightAt(b.x, bz - (site.streamHalf + 3)),
      site.heightAt(b.x, bz + (site.streamHalf + 3)));
    // 홍예교는 수면에서 솟고(봉긋 노면), 판석교는 노면을 양안 높이에 맞춘다.
    const y = (b.type === 'arch') ? site.streamY(b.x) : Math.max(site.streamY(b.x), bank - 0.35);
    br.position.set(b.x, y, b.z);
    br.rotation.y = b.rot || 0;
    out.push(br);
  }
  // 소품
  for (const p of (F.props || [])) {
    const prop = buildProp(p.name, { seed: p.seed || 3, scale: p.scale });
    prop.position.set(p.x, site.heightAt(p.x, p.z), p.z);
    prop.rotation.y = p.rot || 0;
    out.push(prop);
  }
  // 절 클러스터
  if (F.temple) out.push(buildTempleCluster(F.temple, site));
  // 궁
  if (F.palace) out.push(buildPalaceCore(F.palace, site));
  return out;
}

function buildTempleCluster(T, site) {
  // v1: temple 프리셋 대웅전 + 일주문 + 석탑·석등 (진입축 남향). 후속 정교화.
  //   산기슭 완경사에 앉으므로 성토 패드를 깔고 그 위에 컴파운드를 올린다(관통·부양 방지).
  const g = new THREE.Group(); g.name = 'temple-cluster';
  const w = 30, d = 30, rotY = G.facingY(T.frontDir || { x: 0, z: 1 });
  // 산사 석축 대지: 배산 사면 완사 벤치라도 30m footprint 엔 낙차가 있어(규모 비례) 넉넉한 석축으로
  //   앉힌다. Hmax 비례(자기유사 지형이라 절대 낙차가 규모 따라 커짐)에 상한 클램프(거대 옹벽 방지).
  //   #147: 캡을 12→18 로 상향 — buildPadRect 의 padY 는 min(maxCorner, lo+cap) 이라 캡이 footprint 낙차보다
  //   작으면 오르막(뒤쪽) 지형이 대지 위로 솟아 대웅전 뒷면이 산에 파묻힌다(사용자 보고). 미세 기복 여유까지
  //   덮도록 캡을 키워 padY=maxCorner(전면 석축 테라스)를 보장 → 뒷면 파묻힘 제거, 앞면은 석축이 접지.
  const templeCap = Math.min(18, Math.max(5, (site.Hmax || 68) * 0.16));
  const { group: pad, padY } = buildPadRect(site, T.x, T.z, w + 3, d + 3, rotY, templeCap);
  g.add(pad);
  const inner = new THREE.Group();
  inner.add(buildParcel({ seed: T.seed || 11, style: 'temple', plotW: w, plotD: d, lanterns: false }));
  inner.rotation.y = rotY;
  inner.position.set(T.x, padY, T.z);
  g.add(inner);
  return g;
}

function buildPalaceCore(Pl, site) {
  const g = new THREE.Group(); g.name = 'palace-core';
  const w = Pl.plotW || 40, d = Pl.plotD || 34, rotY = G.facingY(Pl.frontDir || { x: 0, z: 1 });
  const { group: pad, padY } = buildPadRect(site, Pl.x, Pl.z, w + 4, d + 4, rotY);
  g.add(pad);
  const inner = new THREE.Group();
  // 다일곽 궁궐 컴파운드(#88): 행각으로 담을 공유하는 일곽 축선 스택. tier 로 규모 분기.
  //   tier 미지정(구 데이터)이면 단일 일곽 buildParcel 로 폴백(회귀 안전).
  if (Pl.tier) {
    inner.add(buildPalaceCompound({ w, d, tier: Pl.tier, variant: Pl.variant || 'axial', seed: Pl.seed || 5 }));
  } else {
    inner.add(buildParcel({ seed: Pl.seed || 5, style: 'palace', plotW: w, plotD: d, lanterns: false }));
  }
  inner.rotation.y = rotY;
  inner.position.set(Pl.x, padY, Pl.z);
  g.add(inner);
  g.userData.palaceCompound = inner.children[0];   // 편집 승격: 컴파운드 핸들 노출
  return g;
}
