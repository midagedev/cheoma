import * as THREE from 'three';
import { makeCityGateDancheong } from '../builder/palette.js';
import { mergeStatic } from './instancing.js';
import {
  CITY_STONE_BOND,
  CITY_STONE_VALUES,
  CITY_WALL_COURSES,
  CITY_WALL_DIMENSIONS,
  cityGateMasonryProfile,
  cityGatePavilionProfile,
  cityGateStructureProfile,
  cityStoneBondPlan,
  cityStoneTone,
  cityWallCourseProfile,
  cityWallMerlonLoophole,
  cityWallMerlonPlan,
  cityWallMerlonSpans,
  cityWaterGateProfile,
  sampleCityWallSegments,
} from './citywall-contour.js';

// 성곽(도성 성벽) + 사대문(숭례·흥인·숙정·돈의) 렌더 — 한양 전용(#47).
//   스펙(순수 데이터)은 citywall-contour.js 가 만든다. 여기서는 그 단일 contour를 따라 화면
//   terrain-grid 삼각면에 밀착한 석성 리본을 두르고, 게이트 자리엔 문루(석축 홍예 + 중층 문루)를
//   세운다. 배치·치수·줄눈·총안은 전부 순수 profile 에서 내려오고 이 파일은 좌표를 다시 만들지 않는다.
//
//   #19 R3-A: 여장 타·타구 톱니 + 총안, 성벽 몸통 2켜, 반원 홍예, 배터 육축, 중층 문루.
//   #19 R3-B(근경 표면): 석재 재질은 **화강암 하나**뿐이고 켜 위계·줄눈·홍예 그늘은 전부 정점색이다.
//     육축이 성벽과 다른 자산처럼 보였던 원인은 색이 아니라 노멀이었다 — 정점을 공유하는 프리즘에
//     computeVertexNormals 를 걸면 수직면 노멀이 윗면 쪽으로 기울어(측정: 성벽 평균 21°, 여장 30°,
//     수직면의 51~65%가 위로 기움) 성벽만 하늘빛을 받아 밝게 뜨고 여장 톱니는 중·원경에서 둥근
//     혹덩어리로 뭉갠다. flatShading 이 그 둘을 함께 없앤다(성곽은 원경 전용 모듈 없이 전 거리
//     같은 병합 메시라, 원경 어휘가 달라질 다른 경로가 없다).
//
//   buildCityWall(spec, site) → THREE.Group (스스로 큰 바운딩이라 컬링 이득은 적으나 드로우콜 소수).

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const V = CITY_STONE_VALUES;
const B = CITY_STONE_BOND;
// 홍예 그늘·총안은 석면에 밀착한 두께 0 판이다. 그림자를 던지면 바로 뒤 석면에 자기 그림자를 찍어
// 통로가 앞으로 튀어나온 원통처럼 보이므로 캐스터에서 뺀다(기하 돌출은 없다 — 측정으로 확인).
const SHADE_CASTS_SHADOW = false;

// 사변형(bl, br, tr, tl) 안의 (u, v) 점. 배터로 기운 면에도 같은 블록 격자를 씌운다.
function bilinear(quad, u, v) {
  const [bl, br, tr, tl] = quad;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const low = bl[k] + (br[k] - bl[k]) * u;
    const high = tl[k] + (tr[k] - tl[k]) * u;
    out[k] = low + (high - low) * v;
  }
  return out;
}

// 임의 4점 면을 바깥 방향에 맞춰 와인딩해 누적. 손으로 감은 스윕에서 컬링 구멍이 생기지 않게
// 정점 순서를 코드가 정한다. values 는 정점별 화강암 값(그레이스케일 정점색 곱).
function pushQuad(P, I, C, points, outward, values) {
  const base = P.length / 3;
  for (let k = 0; k < 4; k++) {
    const p = points[k];
    P.push(p[0], p[1], p[2]);
    const value = values ? values[k] : 1;
    C.push(value, value, value);
  }
  const [a, b, c] = points;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) {
    I.push(base, base + 2, base + 1, base, base + 3, base + 2);
  } else {
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// 한 석면을 대형 방형 블록 격자로 쪼개고 블록별 값 변주 + 블록 밑변 줄눈 그림자를 정점색에 싣는다.
// 텍스처 없이 1m급 화강암 분절을 만드는 유일한 수단이며, 블록마다 정점을 따로 써 값이 번지지 않는다.
function pushBondFace(P, I, C, quad, outward, {
  value = 1, seed = 0, stream = 0, width, height, rows = 0,
}) {
  const plan = cityStoneBondPlan(width, height, { rows });
  for (const course of plan.courses) {
    for (let s = 0; s < course.spans.length; s++) {
      const span = course.spans[s];
      const tone = value * cityStoneTone(seed, stream + s, course.index);
      pushQuad(P, I, C, [
        bilinear(quad, span.u0, course.v0), bilinear(quad, span.u1, course.v0),
        bilinear(quad, span.u1, course.v1), bilinear(quad, span.u0, course.v1),
      ], outward, [
        tone * (1 - B.jointShade), tone * (1 - B.jointShade),
        tone * (1 + B.crownLift), tone * (1 + B.crownLift),
      ]);
    }
  }
  return plan;
}

// 지형을 따르는 켜 하나. 아래·위 footprint 가 달라(배터) 옆면이 사다리꼴이 되고, 바깥 면만 줄눈
// 격자를 쓴다(안쪽 면은 도성 안에서 원경으로만 보인다 — 삼각형 예산 절제). 바닥은 땅속이라 생략.
function pushWallCourse(P, I, C, course, caps, { value, seed, index, bondRows }) {
  const b = course.corners, t = course.topCorners;
  const by = course.groundY.map((ground) => ground + course.bottomOffset);
  const ty = course.topGroundY.map((ground) => ground + course.topOffset);
  const low = (i) => [b[i].x, by[i], b[i].z];
  const high = (i) => [t[i].x, ty[i], t[i].z];
  let cx = 0, cz = 0;
  for (let i = 0; i < 4; i++) { cx += b[i].x * 0.25; cz += b[i].z * 0.25; }
  const tone = value * cityStoneTone(seed, index, 7);
  const flat = [tone * (1 - B.jointShade), tone * (1 - B.jointShade),
    tone * (1 + B.crownLift), tone * (1 + B.crownLift)];
  for (const i of [0, 1, 2, 3]) {
    if ((i === 0 && !caps.capStart) || (i === 2 && !caps.capEnd)) continue;
    const j = (i + 1) % 4;
    const quad = [low(i), low(j), high(j), high(i)];
    const outward = [(b[i].x + b[j].x) * 0.5 - cx, 0, (b[i].z + b[j].z) * 0.5 - cz];
    if (i === 1) {                                  // 바깥 면(성 밖): 줄눈 격자
      pushBondFace(P, I, C, quad, outward, {
        value, seed, stream: index * 3, rows: bondRows,
        width: Math.hypot(b[j].x - b[i].x, b[j].z - b[i].z),
        height: (ty[i] - by[i] + ty[j] - by[j]) * 0.5,
      });
      continue;
    }
    pushQuad(P, I, C, quad, outward, flat);
  }
  pushQuad(P, I, C, [high(0), high(1), high(2), high(3)], [0, 1, 0], [tone, tone, tone, tone]);
}

// 여장 타 한 조각(지형 추종 프리즘). 타마다 값이 조금씩 달라 원경에서도 개별 블록으로 읽힌다.
function pushMerlonBlock(P, I, C, block, value, seed) {
  const c = block.corners, base = block.baseY;
  const low = (i) => [c[i].x, base[i], c[i].z];
  const high = (i) => [c[i].x, base[i] + block.height, c[i].z];
  let cx = 0, cz = 0;
  for (let i = 0; i < 4; i++) { cx += c[i].x * 0.25; cz += c[i].z * 0.25; }
  const tone = value * cityStoneTone(seed, block.merlonIndex, block.runIndex);
  const shade = [tone * (1 - B.jointShade), tone * (1 - B.jointShade),
    tone * (1 + B.crownLift), tone * (1 + B.crownLift)];
  const crown = tone * (1 + B.crownLift);
  for (const i of [0, 1, 2, 3]) {
    if ((i === 0 && !block.startCap) || (i === 2 && !block.endCap)) continue;
    const j = (i + 1) % 4;
    pushQuad(P, I, C, [low(i), low(j), high(j), high(i)],
      [(c[i].x + c[j].x) * 0.5 - cx, 0, (c[i].z + c[j].z) * 0.5 - cz], shade);
  }
  pushQuad(P, I, C, [high(0), high(1), high(2), high(3)], [0, 1, 0], [crown, crown, crown, crown]);
}

// 총안: 타 전면에 살짝 띄운 어두운 가로 슬릿(실제 구멍은 삼각형만 늘리고 원경에서 구분되지 않는다).
function pushLoophole(P, I, C, hole, normal) {
  const ox = normal.x * hole.relief, oz = normal.z * hole.relief;
  const y0a = hole.baseA + hole.bottom, y0b = hole.baseB + hole.bottom;
  const deep = V.loophole * 0.84;
  pushQuad(P, I, C, [
    [hole.a.x + ox, y0a, hole.a.z + oz],
    [hole.b.x + ox, y0b, hole.b.z + oz],
    [hole.b.x + ox, y0b + hole.height, hole.b.z + oz],
    [hole.a.x + ox, y0a + hole.height, hole.a.z + oz],
  ], [normal.x, 0, normal.z], [deep, deep, V.loophole, V.loophole]);
}

// 아래·위 사각 단면이 다른 프리즘(육축 배터, 여장 타). skip 은 이웃 덩이에 가려 보이지 않는 한 면.
function pushRectPrism(P, I, C, bottom, top, y0, y1, {
  skip = null, withTop = true, withBottom = false,
  value = 1, seed = 0, stream = 0, bond = false,
} = {}) {
  const b = [
    [bottom.x0, y0, bottom.z0], [bottom.x1, y0, bottom.z0],
    [bottom.x1, y0, bottom.z1], [bottom.x0, y0, bottom.z1],
  ];
  const t = [
    [top.x0, y1, top.z0], [top.x1, y1, top.z0],
    [top.x1, y1, top.z1], [top.x0, y1, top.z1],
  ];
  const tone = value * cityStoneTone(seed, stream, 11);
  const flat = [tone * (1 - B.jointShade), tone * (1 - B.jointShade),
    tone * (1 + B.crownLift), tone * (1 + B.crownLift)];
  const faces = [
    ['zMin', [b[0], b[1], t[1], t[0]], [0, 0, -1], Math.abs(bottom.x1 - bottom.x0)],
    ['xMax', [b[1], b[2], t[2], t[1]], [1, 0, 0], Math.abs(bottom.z1 - bottom.z0)],
    ['zMax', [b[2], b[3], t[3], t[2]], [0, 0, 1], Math.abs(bottom.x1 - bottom.x0)],
    ['xMin', [b[3], b[0], t[0], t[3]], [-1, 0, 0], Math.abs(bottom.z1 - bottom.z0)],
  ];
  for (let f = 0; f < faces.length; f++) {
    const [key, quad, outward, width] = faces[f];
    if (skip === key) continue;
    if (bond) {
      pushBondFace(P, I, C, quad, outward, {
        value, seed, stream: stream + f * 13, width, height: y1 - y0,
      });
      continue;
    }
    pushQuad(P, I, C, quad, outward, flat);
  }
  if (withTop) pushQuad(P, I, C, [t[0], t[1], t[2], t[3]], [0, 1, 0], flat);
  if (withBottom) pushQuad(P, I, C, [b[0], b[1], b[2], b[3]], [0, -1, 0], flat);
}

// 문루 우진각 지붕(#78 근경 격상) — 평슬래브 대신 지붕 어휘로 읽히게: 처마 반전(코너 들림)·
//   처마 곡(중앙 처짐)·용마루(main ridge)·내림마루(hip ridges, 능선 끝→4코너). 저폴리 유지.
//   반환 THREE.Group(면=tileMat, 마루=ridgeMat). 문 4기 한정이라 병합 후 드로우콜 소폭↑ 허용.
//   roof-rank = city-gate (#150 C): 궁 잡상·취두 등 palace ornament를 절대 붙이지 않는다.
//   중층의 하층 차양은 상층 벽에 붙는 스커트라 실제로는 용마루가 없다(ridge=false). 코너 내림마루는
//   바깥에서 보이므로 두 단 모두 남긴다.
function buildGateRoof(w, d, h, M, { ridge = true } = {}) {
  const g = new THREE.Group();
  g.name = 'city-gate-roof';
  g.userData.roofRank = 'city-gate';
  const hw = w / 2, hd = d / 2;
  const tw = w * 0.15;               // 용마루 반길이(짧은 능선)
  const cl = h * 0.20;               // 처마 반전(코너 들림) — 한식 지붕 실루엣
  const sag = h * 0.06;              // 처마 중앙 처짐(오목 곡선)
  const P = [], I = [];
  const add = (x, y, z) => { P.push(x, y, z); return P.length / 3 - 1; };
  const RL = add(-tw, h, 0), RR = add(tw, h, 0);              // 용마루 두 끝
  const flC = add(-hw, cl, hd), frC = add(hw, cl, hd), fMid = add(0, cl - sag, hd); // 앞 처마
  const blC = add(-hw, cl, -hd), brC = add(hw, cl, -hd), bMid = add(0, cl - sag, -hd); // 뒤 처마
  // 앞면(+z): 처마(fl·fMid·fr) → 용마루(RL·RR)
  I.push(flC, fMid, RL, fMid, RR, RL, fMid, frC, RR);
  // 뒷면(-z)
  I.push(brC, bMid, RR, bMid, RL, RR, bMid, blC, RL);
  // 좌·우 우진각 삼각
  I.push(flC, RL, blC);
  I.push(frC, brC, RR);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setIndex(I); geo.computeVertexNormals();
  const surf = new THREE.Mesh(geo, M.tileMat);
  surf.castShadow = surf.receiveShadow = true; g.add(surf);
  // 용마루: 능선 위 두툼한 어두운 기와마루.
  if (ridge) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(tw * 2 + w * 0.05, h * 0.16, d * 0.11), M.ridgeMat);
    beam.position.set(0, h + h * 0.04, 0); beam.castShadow = true; g.add(beam);
  }
  const xAxis = new THREE.Vector3(1, 0, 0);
  for (const [ex, ez] of [[hw, hd], [hw, -hd], [-hw, hd], [-hw, -hd]]) {
    const rx = Math.sign(ex) * tw;                            // 능선 끝
    const dir = new THREE.Vector3(ex - rx, cl - h, ez);
    const len = dir.length(); dir.normalize();
    const hip = new THREE.Mesh(new THREE.BoxGeometry(len, h * 0.10, d * 0.07), M.ridgeMat);
    hip.quaternion.setFromUnitVectors(xAxis, dir);
    hip.position.set((rx + ex) / 2, (h + cl) / 2, ez / 2);
    hip.castShadow = true; g.add(hip);
  }
  return g;
}

export function buildCityWall(spec, site) {
  const group = new THREE.Group(); group.name = 'city-wall-work';
  if (!spec) { group.name = 'city-wall'; return group; }
  const { gates } = spec;
  const { thickness: thk } = CITY_WALL_DIMENSIONS;
  const seed = spec.seed >>> 0;

  const stoneP = [], stoneI = [], stoneC = [];   // 화강암 전체(켜 위계·줄눈은 정점색)
  const darkP = [], darkI = [], darkC = [];      // 총안·홍예 그늘(그림자를 던지지 않는 면)

  const segments = sampleCityWallSegments(spec, site, { thickness: thk });
  for (const [index, segment] of segments.entries()) {
    const caps = { capStart: !segment.joinedStart, capEnd: !segment.joinedEnd };
    // 석재 위계: 아래 대석 켜는 검증된 두께 그대로, 위 몸통은 배터로 좁아지며 얕은 수평 단차를 만든다.
    // 대석 켜는 절반이 땅속이라 가로 줄눈 없이 큰 돌 한 켜(rows=1)로 두고, 가로 리듬은 켜 경계와
    // 몸통의 자동 분할이 만든다(성벽 줄눈은 절제 — 예산은 근경 주역인 육축에 쓴다).
    for (const course of cityWallCourseProfile(segment).courses) {
      const isBase = course.key === CITY_WALL_COURSES.keys[0];
      pushWallCourse(stoneP, stoneI, stoneC, course, caps, {
        value: isBase ? V.base : V.body,
        seed, index, bondRows: isBase ? 1 : 0,
      });
    }
  }
  // 여장: 연속 프리즘이 아니라 타/타구 반복. run 단위 arc-length 분배와 miter 승계는 순수 plan 이 한다.
  const merlons = cityWallMerlonPlan(segments, { thickness: thk * 0.7, seed });
  for (const block of merlons.blocks) {
    pushMerlonBlock(stoneP, stoneI, stoneC, block, V.parapet, seed);
    if (block.loophole) pushLoophole(darkP, darkI, darkC, block.loophole, block.normal);
  }

  // 석재는 재질 하나뿐이다 — 성벽과 육축이 톤으로 갈릴 수 없고, 켜 위계는 정점색 값(5~8%)만으로 준다.
  // flatShading: 정점 공유 프리즘의 스무딩이 수직면을 하늘 쪽으로 기울여 밝게 띄우던 것을 끊는다.
  // DoubleSide: 수작업 스윕 벽면의 와인딩 불일치로 인한 컬링 구멍 방지(벽 두께라 비용 미미).
  const masonryMat = new THREE.MeshStandardMaterial({
    color: 0x8e887c, roughness: 1, metalness: 0, side: THREE.DoubleSide,
    vertexColors: true, flatShading: true,
  });
  // 그늘 판은 같은 화강암을 짙게 쓴 면이라 색이 겉돌지 않는다. 그림자를 던지면 밀착한 석면에 자기
  // 그림자를 찍어 홍예가 앞으로 튀어나온 원통처럼 보이므로 캐스터에서 뺀다(진단: archMat 과
  // 육축 전면은 y 밴드마다 최대 |z| 가 소수점 3자리까지 동일 — 실제 돌출은 없었다).
  const shadeMat = new THREE.MeshStandardMaterial({
    color: 0x8e887c, roughness: 1, metalness: 0, side: THREE.DoubleSide,
    vertexColors: true, flatShading: true,
  });
  const mk = (P, I, C, mat, name, cast) => {
    if (!I.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setIndex(I); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.name = name;
    m.castShadow = cast; m.receiveShadow = cast; group.add(m);
  };
  mk(stoneP, stoneI, stoneC, masonryMat, 'wall-stone', true);
  mk(darkP, darkI, darkC, shadeMat, 'wall-shade', SHADE_CASTS_SHADOW);

  // ── 사대문(홍예 석축 + 중층 문루) ── 석재는 위와 같은 재질을 공유한다.
  const tileMat = new THREE.MeshStandardMaterial({ color: linCol(0x3b4048), roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
  const ridgeMat = new THREE.MeshStandardMaterial({ color: linCol(0x262b32), roughness: 0.85, metalness: 0 }); // 용마루·내림마루(짙은 기와마루)
  const woodMat = new THREE.MeshStandardMaterial({ color: linCol(0x8a4a3a), roughness: 0.9, metalness: 0 });
  const plaqueMat = new THREE.MeshStandardMaterial({ color: linCol(0xd8d1c2), roughness: 0.85, metalness: 0 });
  // 문루 단청(2026-07-31 사용자 승인): 색을 여기서 정하지 않고 dancheong rank 정책의 'city-gate'
  // 격식을 그대로 받아온다. 성문 4기가 이 두 재질을 공유하므로 병합 후 +2 콜이다.
  const dancheong = makeCityGateDancheong();
  const M = {
    masonryMat, shadeMat, tileMat, ridgeMat, woodMat, plaqueMat,
    dancheongBeam: dancheong?.beam || woodMat,
    dancheongBracket: dancheong?.bracket || woodMat,
  };
  for (const gate of gates) group.add(buildGate(gate, site, M, seed));
  // 수문(오간수문): 개천이 성벽을 지나는 통과부. 석재·그늘 재질을 성벽과 그대로 공유하므로
  //   병합 후 드로우콜 증가는 0이다.
  for (const waterGate of (spec.waterGates || [])) group.add(buildWaterGate(waterGate, M, seed));

  // 벽·문의 다수 메시(문루 기둥·석축 등)를 재질별 병합 → 소수 드로우콜(정적이라 손실 없음).
  const merged = mergeStatic([group], 'city-wall');
  merged.userData.isCityWall = true;
  merged.userData.segmentCount = segments.length;
  merged.userData.merlonCount = merlons.runs.reduce((sum, run) => sum + run.count, 0);
  merged.userData.waterGateCount = (spec.waterGates || []).length;
  return merged;
}

// 수문 한 기: 하상 석축 문턱 + 홍예 5개(실제로 뚫린 통로) + 돌기둥·어깨 + 수평 상면 + 여장 링.
//   성벽 리본은 이 자리에서 끊겨 있고(cityWallAngleInAperture), 이 석축이 그 구멍을 채운다.
//   좌표는 순수 profile 이 준 것(로컬 x=성벽 접선, 로컬 z=성 바깥, y=절대)을 그대로 쓴다.
function buildWaterGate(waterGate, M, wallSeed) {
  const g = new THREE.Group(); g.name = `water-gate-${waterGate.index}`;
  const p = cityWaterGateProfile(waterGate);
  g.position.set(waterGate.x, 0, waterGate.z);
  g.rotation.y = Math.atan2(waterGate.dirX, waterGate.dirZ);
  const seed = ((wallSeed >>> 0) ^ Math.round(waterGate.angle * 1000) ^ 0x5eed) >>> 0;

  const stoneP = [], stoneI = [], stoneC = [];
  const darkP = [], darkI = [], darkC = [];
  const hd = p.halfDepth;
  const mouth = V.shadeMouth, deep = V.shadeDeep;

  // 하상 문턱 슬래브: 홍예 밑을 지나는 석축 바닥. 물은 이 위를 흐르고 돌기둥은 여기서 선다.
  const sillRect = { x0: -p.span * 0.5, x1: p.span * 0.5, z0: -hd, z1: hd };
  // 기초 저면을 닫는다. 지형 절단 에지 근처 저각에서 밑면이 열려 두께 없는 셸로 읽혔다
  //   (비전 판정 2026-08-01). 삼각형 +2 로 끝나는 마감이다.
  pushRectPrism(stoneP, stoneI, stoneC, sillRect, sillRect, p.bottomY, p.sillY, {
    value: V.base, seed, stream: 3, bond: true, withBottom: true,
  });

  // 어깨·돌기둥: 성벽과 같은 2켜(대석/몸통) 위계.
  for (const [zoneIndex, zone] of [...p.shoulders, ...p.piers].entries()) {
    const rect = { x0: zone.x0, x1: zone.x1, z0: -hd, z1: hd };
    for (const [courseIndex, band] of [
      [CITY_WALL_COURSES.keys[0], p.sillY, p.courseSplitY],
      [CITY_WALL_COURSES.keys[1], p.courseSplitY, p.topY],
    ].entries()) {
      const [key, y0, y1] = band;
      if (y1 - y0 <= 1e-4) continue;
      pushRectPrism(stoneP, stoneI, stoneC, rect, rect, y0, y1, {
        value: key === CITY_WALL_COURSES.keys[0] ? V.base : V.body,
        seed, stream: (zoneIndex * 2 + courseIndex) * 37, bond: true,
      });
    }
  }

  // 홍예: 안쪽 곡면(그늘)은 실제로 뚫린 통로의 배럴이고, 그 위 스팬드럴 석면이 상면까지 채운다.
  //   기석 아래는 수직 문협(jamb)이라 통로가 문턱까지 온전히 뚫린다.
  for (const opening of p.openings) {
    if (p.jamb.height > 1e-4) {
      for (const [side, x] of [[-1, opening.x0], [1, opening.x1]]) {
        pushQuad(darkP, darkI, darkC, [
          [x, p.jamb.y0, -hd], [x, p.jamb.y0, hd],
          [x, p.jamb.y1, hd], [x, p.jamb.y1, -hd],
        ], [-side, 0, 0], [mouth, mouth, deep, deep]);
      }
    }
  }
  for (const opening of p.openings) {
    for (let i = 0; i < opening.intrados.length - 1; i++) {
      const a = opening.intrados[i], b = opening.intrados[i + 1];
      const mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5;
      const inward = [-(mx - opening.centerX), -(my - p.springY), 0];
      pushQuad(darkP, darkI, darkC, [
        [a.x, a.y, -hd], [b.x, b.y, -hd], [b.x, b.y, 0], [a.x, a.y, 0],
      ], inward, [mouth, mouth, deep, deep]);
      pushQuad(darkP, darkI, darkC, [
        [a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, hd], [a.x, a.y, hd],
      ], inward, [deep, deep, mouth, mouth]);
      const tone = V.body * cityStoneTone(seed, opening.index * 17 + i, 5);
      for (const sz of [-1, 1]) {
        pushQuad(stoneP, stoneI, stoneC, [
          [a.x, a.y, sz * hd], [b.x, b.y, sz * hd],
          [b.x, p.topY, sz * hd], [a.x, p.topY, sz * hd],
        ], [0, 0, sz], [tone * (1 - B.jointShade), tone * (1 - B.jointShade),
          tone * (1 + B.crownLift), tone * (1 + B.crownLift)]);
      }
    }
  }

  // 여장 링: 성벽과 같은 톱니·총안 규칙으로 성가퀴가 수문 위로 이어진다.
  const par = p.parapet;
  const half = par.thickness * 0.5;
  for (const [merlonIndex, span] of cityWallMerlonSpans(par.length).spans.entries()) {
    const x0 = -par.length * 0.5 + span.start, x1 = -par.length * 0.5 + span.end;
    const rect = { x0, x1, z0: -half, z1: half };
    pushRectPrism(stoneP, stoneI, stoneC, rect, rect, par.y, par.y + par.height, {
      value: V.parapet, seed, stream: 211 + merlonIndex,
    });
    const slit = cityWallMerlonLoophole(seed, 24, merlonIndex);
    if (!slit) continue;
    const hx = -par.length * 0.5 + span.loophole.start, gx = -par.length * 0.5 + span.loophole.end;
    pushLoophole(darkP, darkI, darkC, {
      a: { x: hx, z: half }, b: { x: gx, z: half },
      baseA: par.y, baseB: par.y,
      bottom: slit.bottom, height: slit.height, relief: slit.relief,
    }, { x: 0, z: 1 });
  }

  const mk = (P, I, C, mat, name, cast) => {
    if (!I.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setIndex(I); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat); mesh.name = name;
    mesh.castShadow = cast; mesh.receiveShadow = cast; g.add(mesh);
  };
  mk(stoneP, stoneI, stoneC, M.masonryMat, 'water-gate-stone', true);
  mk(darkP, darkI, darkC, M.shadeMat, 'water-gate-arch-shade', SHADE_CASTS_SHADOW);
  return g;
}

// 문루 한 층: 기둥열 + (하층)판벽 / (상층)난간·편액 + 다포계 공포대. 실루엣 우선 — 창살 없음.
//   기둥은 층 상단까지 서지 않는다: 층 y밴드의 위 bracket.height 는 공포대가 쓰고, 기둥은 그 밑까지만
//   선다(#23 R3-①). 층 높이·지붕 y·상층 바닥은 그래서 이 격상에 흔들리지 않는다.
function addPavilionStorey(g, storey, M) {
  const hw = storey.width * 0.5, hd = storey.depth * 0.5;
  const radius = storey.columnRadius;
  const colH = storey.height - storey.bracket.height;
  const columns = storey.columnX;
  for (const x of columns) for (const sz of [-1, 1]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.88, radius, colH, 6), M.woodMat);
    col.position.set(x, storey.y0 + colH / 2, sz * hd);
    col.castShadow = true; g.add(col);
  }
  // 기둥 머리초: 기둥 상부를 감는 짧은 채색 띠. 원통 uv 라 머리초 색선이 둘레로 돈다.
  // 기둥머리가 곧 창방 밑면이므로 띠를 그 자리에 붙인다(예전엔 공포 힌트 밴드가 기둥 위쪽에
  // 겹쳐 있어 머리초를 radius*2.2 내려 달았다).
  const headBandH = Math.min(colH * 0.22, radius * 4);
  for (const x of columns) for (const sz of [-1, 1]) {
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.04, radius * 1.04, headBandH, 8, 1, true),
      M.dancheongBeam);
    band.position.set(x, storey.y0 + colH - headBandH * 0.5, sz * hd);
    band.castShadow = true; g.add(band);
  }
  addPavilionBrackets(g, storey, M);
  if (storey.rail > 0) {
    // 난간: 상층 둘레 낮은 띠(원경에서는 상층 바닥선을 만드는 실루엣 요소).
    for (const [w, d, x, z] of [
      [storey.width, 0.14, 0, hd], [storey.width, 0.14, 0, -hd],
      [0.14, storey.depth, hw, 0], [0.14, storey.depth, -hw, 0],
    ]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w, storey.rail, d), M.woodMat);
      rail.position.set(x, storey.y0 + storey.rail * 0.5, z);
      rail.castShadow = true; g.add(rail);
    }
    // 편액: 상층 정면 흰 판 하나(글씨·단청 없음 — 기하만).
    const plaqueW = Math.min(storey.width * 0.34, 3.2);
    const plaque = new THREE.Mesh(new THREE.BoxGeometry(plaqueW, plaqueW * 0.42, 0.14), M.plaqueMat);
    plaque.position.set(0, storey.y0 + colH * 0.6, hd + 0.1);
    plaque.castShadow = true; g.add(plaque);
    return;
  }
  // 하층 벽체: 기둥 사이 판벽(판문·회벽으로 읽히는 면). 기둥 뒤로 물러나 기둥열이 살아난다.
  //   높이는 계획이 준다 — 창방 밑면까지 올라가 위 포벽과 함께 하층 파사드를 폐합한다(#23 R3-①
  //   후속: 예전 0.86·colH 는 공포대 격상으로 짧아진 기둥 위에 가로 슬릿을 남겼다).
  const panelH = storey.panel.height;
  const panelY = storey.panel.y0 + panelH * 0.5;
  for (let i = 0; i < columns.length - 1; i++) {
    const span = columns[i + 1] - columns[i] - radius * 2;
    if (span <= 0.1) continue;
    for (const sz of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(span, panelH, 0.2), M.woodMat);
      panel.position.set((columns[i] + columns[i + 1]) * 0.5, panelY, sz * (hd - radius * 0.6));
      panel.castShadow = panel.receiveShadow = true; g.add(panel);
    }
  }
  for (const sx of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.2, panelH, storey.depth - radius * 2), M.woodMat);
    panel.position.set(sx * (hw - radius * 0.6), panelY, 0);
    panel.castShadow = panel.receiveShadow = true; g.add(panel);
  }
}

// 다포계 공포대 한 층(#23 R3-①). 예전 구현은 창방·평방 두 켜 + 기둥머리 소로 블록뿐이어서, 처마는
//   깊은데 그 아래 받치는 것이 없어 지붕이 기둥에 직결된 것처럼 읽혔다(구한말 성문 사진 대비 R3
//   비전 심각도 1위). 여기서는 그 밴드를 실제 포열로 바꾼다:
//     · 기둥 위 **주포** + 주칸 등분 **간포**(하층 1구/칸, 상층 2구/칸 — 포 밀도가 상층 위계)
//     · 출목마다 밖으로 더 나가는 **살미** + 그 끝 **소로** → 계단형 돌출이 측면 실루엣을 만든다
//     · 출목 단마다 수평 **행공** 런, 최외 출목 위에 **외목도리** 런 → 처마 밑 명암이 층으로 갈린다
//     · 하층만 포 사이를 **포벽**으로 막는다(상층은 개방 정자라 포 사이 하늘이 정당하다)
//   부재 수를 아끼기 위해 첨차·행공은 포마다가 아니라 면당 연속 런 하나다(중경에서 같은 수평선으로
//   읽히고, 포 하나당 상자 5개로 4문 반복 예산에 들어간다). 재질은 기존 dancheong 두 개만 쓰므로
//   병합 후 드로우콜·프로그램 델타는 0 이다 — 새 재질은 절대 만들지 않는다.
function addPavilionBrackets(g, storey, M) {
  const B = storey.bracket;
  const hw = storey.width * 0.5, hd = storey.depth * 0.5;
  const box = (w, h, d, x, y, z, mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true; g.add(mesh);
  };
  // ── 수평 런: 창방·평방(기둥열 위) + (하층)포벽 + 출목별 행공 + 외목도리. 네 면 모두 두르므로
  //    코너에서 밴드가 끊기지 않는다(x런과 z런이 out 만큼 겹치지만 같은 불투명 목부재라 무해하다).
  //    grow = 면 방향 길이 여장, out = 기둥 중심선 밖 오프셋. 포벽만 둘이 다르다 — 길이는 코너
  //    기둥 바깥면까지 늘리되(파사드 폐합) 벽면은 기둥 중심선에 서서 포가 그 앞으로 나온다.
  const runs = [
    { y: B.changbang.y + B.changbang.height * 0.5, h: B.changbang.height, t: B.changbang.thickness, out: B.changbang.overhang, grow: B.changbang.grow, mat: M.dancheongBeam },
    { y: B.pyeongbang.y + B.pyeongbang.height * 0.5, h: B.pyeongbang.height, t: B.pyeongbang.thickness, out: B.pyeongbang.overhang, grow: B.pyeongbang.grow, mat: M.dancheongBeam },
  ];
  if (B.infill) {
    // 포벽: 판벽과 같은 재질이라 하층 벽면이 창방·평방 뒤로 그대로 이어져 올라간 것으로 읽힌다.
    runs.push({
      y: B.infill.y + B.infill.height * 0.5, h: B.infill.height, t: B.infill.thickness,
      out: B.infill.overhang, grow: B.infill.grow, mat: M.woodMat,
    });
  }
  for (const step of B.steps) {
    // 행공: 소로 위에 얹혀 도리 방향으로 교차하는 가로 부재.
    runs.push({
      y: step.y + step.height * (B.haenggong.base + B.haenggong.height * 0.5),
      h: step.height * B.haenggong.height, t: B.arm, out: step.out, grow: step.grow,
      mat: M.dancheongBracket,
    });
  }
  runs.push({ y: B.purlin.y + B.purlin.height * 0.5, h: B.purlin.height, t: B.purlin.thickness, out: B.purlin.out, grow: B.purlin.grow, mat: M.dancheongBeam });
  for (const run of runs) {
    for (const sz of [-1, 1]) {
      box(storey.width + run.grow * 2, run.h, run.t, 0, run.y, sz * (hd + run.out), run.mat);
    }
    for (const sx of [-1, 1]) {
      box(run.t, run.h, storey.depth + run.grow * 2, sx * (hw + run.out), run.y, 0, run.mat);
    }
  }
  // ── 포 유닛: 주두 하나 + 출목마다 살미 + 소로. 간포는 주포와 같은 부재를 쓰되 배치만 주칸 등분이다.
  const unit = (x, z, outX, outZ) => {
    box(B.judu.width, B.judu.height, B.judu.width, x, B.judu.y + B.judu.height * 0.5, z, M.dancheongBracket);
    for (const step of B.steps) {
      const tail = B.arm;                       // 평방 안쪽으로 물린 살미 꼬리
      const len = step.out + tail;
      const armH = step.height * B.salmi.height;
      const cy = step.y + step.height * (B.salmi.base + B.salmi.height * 0.5);
      const mid = (step.out - tail) * 0.5;
      if (outZ) {
        box(B.arm, armH, len, x, cy, z + outZ * mid, M.dancheongBracket);
      } else {
        box(len, armH, B.arm, x + outX * mid, cy, z, M.dancheongBracket);
      }
      // 살미 끝 소로: 그 위 행공을 받는 작은 받침 블록. 근경에서 포 하나하나를 낱개로 읽게 한다.
      const sw = B.soro.width;
      box(sw, step.height * B.soro.height, sw,
        x + (outX ? outX * step.out : 0),
        step.y + step.height * (B.soro.base + B.soro.height * 0.5),
        z + (outZ ? outZ * step.out : 0), M.dancheongBracket);
    }
  };
  for (const post of B.posts.x) for (const sz of [-1, 1]) unit(post.at, sz * hd, 0, sz);
  for (const post of B.posts.z) for (const sx of [-1, 1]) unit(sx * hw, post.at, sx, 0);
}

// 한 성문: 지형에 앉힌 배터 석축 육축(2켜 + 코니스) + 반원 홍예 통로 + 중층 문루 + 육축 둘레 여장.
function buildGate(gate, site, M, wallSeed) {
  const g = new THREE.Group(); g.name = `gate-${gate.name}`;
  const structure = cityGateStructureProfile(gate, site);
  const masonry = cityGateMasonryProfile(gate, site, structure);
  const pavilion = cityGatePavilionProfile(gate, structure, masonry);
  // 문이 성벽 링에 직교하도록 회전 — dir(반경 방향)을 문루 정면(로컬 +z)으로.
  g.position.set(gate.x, 0, gate.z);
  g.rotation.y = Math.atan2(gate.dirX, gate.dirZ);
  const seed = ((wallSeed >>> 0) ^ Math.round(gate.angle * 1000)) >>> 0;

  const stoneP = [], stoneI = [], stoneC = [];   // 육축·코니스·마루·홍예 스팬드럴·여장 링
  const darkP = [], darkI = [], darkC = [];      // 홍예 그늘(문협·홍예 안쪽면)·총안

  const arch = masonry.arch;
  const batter = masonry.batter;
  // 배터 램프: profile 이 공개한 (bottomY, topY, inset) 을 그대로 평가한다. 육축 전체가 한 램프를
  // 쓰므로 좌우 지반이 달라도 상단 폭이 어긋나지 않고, 홍예 면도 같은 램프를 써 전면과 정확히 같은
  // 평면에 놓인다(통로 원통이 앞으로 튀어나오지 않는다).
  const insetAt = (y) => batter.inset
    * Math.max(0, Math.min(1, (y - batter.bottomY) / Math.max(1e-6, batter.topY - batter.bottomY)));
  const mouth = V.shadeMouth, deep = V.shadeDeep;

  // 육축 두 덩이: 홍예 개구 밖 전체 폭이 석면이 된다(옛 열린 도로 폭도 석축으로 덮인다).
  for (const zone of masonry.zones) {
    const skip = zone.side > 0 ? 'xMin' : 'xMax';   // 안쪽 면은 통로 그늘이 맡는다
    for (const [courseIndex, course] of zone.courses.entries()) {
      const isBase = course.key === CITY_WALL_COURSES.keys[0];
      pushRectPrism(stoneP, stoneI, stoneC, course.bottom, course.top, course.y0, course.y1, {
        skip, value: isBase ? V.base : V.body, seed,
        stream: (zone.index * 2 + courseIndex) * 29, bond: true,
      });
      // 문협(통로 벽): 어두운 면으로 홍예 안쪽 깊이를 만든다 — 통로 자체는 뚫려 있다. 입구 쪽이
      // 밝고(shadeMouth) 안으로 갈수록 떨어져(shadeDeep), 통과 시야가 실틈처럼 새까맣지 않다.
      const x = zone.side > 0 ? course.bottom.x0 : course.bottom.x1;
      const outward = [-zone.side, 0, 0];
      pushQuad(darkP, darkI, darkC, [
        [x, course.y0, course.bottom.z0], [x, course.y0, 0],
        [x, course.y1, 0], [x, course.y1, course.top.z0],
      ], outward, [mouth, deep, deep, mouth]);
      pushQuad(darkP, darkI, darkC, [
        [x, course.y0, 0], [x, course.y0, course.bottom.z1],
        [x, course.y1, course.top.z1], [x, course.y1, 0],
      ], outward, [deep, mouth, mouth, deep]);
    }
  }

  // 반원 홍예: 안쪽 곡면(그늘) + 그 위 스팬드럴 석면. 통로는 실제로 뚫려 있어 문 너머 지형·길이 보인다.
  for (let i = 0; i < arch.intrados.length - 1; i++) {
    const p = arch.intrados[i], q = arch.intrados[i + 1];
    const pd = arch.halfDepth - insetAt(p.y), qd = arch.halfDepth - insetAt(q.y);
    const mx = (p.x + q.x) * 0.5, my = (p.y + q.y) * 0.5;
    const inward = [-mx, -(my - arch.springY), 0];   // 홍예 중심을 향한 안쪽 면
    pushQuad(darkP, darkI, darkC, [
      [p.x, p.y, -pd], [q.x, q.y, -qd], [q.x, q.y, 0], [p.x, p.y, 0],
    ], inward, [mouth, mouth, deep, deep]);
    pushQuad(darkP, darkI, darkC, [
      [p.x, p.y, 0], [q.x, q.y, 0], [q.x, q.y, qd], [p.x, p.y, pd],
    ], inward, [deep, deep, mouth, mouth]);
    const topInset = arch.halfDepth - insetAt(arch.spandrelTopY);
    const tone = V.body * cityStoneTone(seed, i, 3);
    for (const sz of [-1, 1]) {
      pushQuad(stoneP, stoneI, stoneC, [
        [p.x, p.y, sz * pd], [q.x, q.y, sz * qd],
        [q.x, arch.spandrelTopY, sz * topInset], [p.x, arch.spandrelTopY, sz * topInset],
      ], [0, 0, sz], [tone * (1 - B.jointShade), tone * (1 - B.jointShade),
        tone * (1 + B.crownLift), tone * (1 + B.crownLift)]);
    }
  }

  // 상단 코니스 켜: 배터로 좁아진 면에서 다시 예약 폭까지 내밀어 수평 그림자선을 만든다.
  const cornice = masonry.cornice;
  const corniceRect = {
    x0: -cornice.halfWidth, x1: cornice.halfWidth,
    z0: -cornice.halfDepth, z1: cornice.halfDepth,
  };
  pushRectPrism(stoneP, stoneI, stoneC, corniceRect, corniceRect, cornice.y0, cornice.y1, {
    withBottom: true, value: V.cornice, seed, stream: 71, bond: true,
  });
  // 문루 마루(육축 상면): 여장 링과 문루가 함께 앉는 낮은 대.
  const deck = pavilion.deck;
  const deckRect = {
    x0: -deck.halfWidth, x1: deck.halfWidth, z0: -deck.halfDepth, z1: deck.halfDepth,
  };
  pushRectPrism(stoneP, stoneI, stoneC, deckRect, deckRect, deck.y0, deck.y1, {
    value: V.deck, seed, stream: 97,
  });

  // 육축 둘레 여장: 성벽과 같은 톱니 패턴·높이·총안 규칙을 써서 성가퀴가 문으로 이어지는 것처럼 읽힌다.
  const parapet = pavilion.parapet;
  const half = parapet.thickness * 0.5;
  for (const [sideIndex, side] of parapet.sides.entries()) {
    if (side.length <= 0) continue;
    const dirX = (side.to.x - side.from.x) / side.length;
    const dirZ = (side.to.z - side.from.z) / side.length;
    const outward = side.axis === 'x' ? { x: 0, z: side.sign } : { x: side.sign, z: 0 };
    for (const [merlonIndex, span] of cityWallMerlonSpans(side.length).spans.entries()) {
      const ax = side.from.x + dirX * span.start, az = side.from.z + dirZ * span.start;
      const bx = side.from.x + dirX * span.end, bz = side.from.z + dirZ * span.end;
      const rect = {
        x0: Math.min(ax, bx) - (side.axis === 'z' ? half : 0),
        x1: Math.max(ax, bx) + (side.axis === 'z' ? half : 0),
        z0: Math.min(az, bz) - (side.axis === 'x' ? half : 0),
        z1: Math.max(az, bz) + (side.axis === 'x' ? half : 0),
      };
      pushRectPrism(stoneP, stoneI, stoneC, rect, rect, parapet.y, parapet.y + parapet.height, {
        value: V.parapet, seed, stream: 131 + sideIndex * 17 + merlonIndex,
      });
      const slit = cityWallMerlonLoophole(seed, 8 + sideIndex, merlonIndex);
      if (!slit) continue;
      const hx = side.from.x + dirX * span.loophole.start, hz = side.from.z + dirZ * span.loophole.start;
      const gx = side.from.x + dirX * span.loophole.end, gz = side.from.z + dirZ * span.loophole.end;
      pushLoophole(darkP, darkI, darkC, {
        a: { x: hx + outward.x * half, z: hz + outward.z * half },
        b: { x: gx + outward.x * half, z: gz + outward.z * half },
        baseA: parapet.y, baseB: parapet.y,
        bottom: slit.bottom, height: slit.height, relief: slit.relief,
      }, outward);
    }
  }

  const mk = (P, I, C, mat, name, cast) => {
    if (!I.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setIndex(I); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat); mesh.name = name;
    mesh.castShadow = cast; mesh.receiveShadow = cast; g.add(mesh);
  };
  mk(stoneP, stoneI, stoneC, M.masonryMat, 'gate-stone', true);
  mk(darkP, darkI, darkC, M.shadeMat, 'gate-arch-shade', SHADE_CASTS_SHADOW);

  // 중층 문루: 하층 기둥열+판벽, 상층은 폭·깊이를 체감한 기둥열+난간. 지붕 2단(하층 차양 + 상층 본지붕).
  for (const storey of pavilion.storeys) addPavilionStorey(g, storey, M);
  for (const roof of pavilion.roofs) {
    const built = buildGateRoof(roof.width, roof.depth, roof.height, M, { ridge: roof.tier === 'upper' });
    built.position.set(0, roof.y, 0);
    g.add(built);
    addEaveDancheongBand(g, roof, M);
  }
  return g;
}

// 처마 밑 채색 띠: 처마선 바로 안쪽을 도리·부연 채색 밴드로 두른다. 지붕면 자체는 손으로 감은
// uv 없는 지오메트리라 단청 map 을 붙일 수 없으므로, uv 가 있는 박스 네 개로 처마 밑면을 대신한다.
function addEaveDancheongBand(g, roof, M) {
  const lift = roof.height * 0.20;              // buildGateRoof 의 처마 반전 높이
  const inset = 0.55, thickness = 0.3, height = 0.24;
  const hw = roof.width * 0.5 - inset, hd = roof.depth * 0.5 - inset;
  if (hw <= thickness || hd <= thickness) return;
  const y = roof.y + lift - height * 0.45;
  for (const [w, d, x, z] of [
    [hw * 2, thickness, 0, hd], [hw * 2, thickness, 0, -hd],
    [thickness, hd * 2, hw, 0], [thickness, hd * 2, -hw, 0],
  ]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), M.dancheongBeam);
    band.position.set(x, y, z);
    band.castShadow = true; g.add(band);
  }
}
