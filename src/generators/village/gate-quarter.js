import * as THREE from 'three';
import * as G from '../../core/math/geom2.js';
import { mergeStatic } from '../../village/instancing.js';
import {
  GATE_QUARTER_KIND,
  GATE_QUARTER_PLAN_SCHEMA_VERSION,
  validateGateQuarterPlan,
} from '../../village/gate-quarter-plan.js';

// 성벽 안면 부속 밴드의 Three 어댑터. 계획(gate-quarter-plan.js)이 세계 좌표·치수·표고를 모두
// 소유하므로 이 모듈은 배치를 **추론하지 않는다** — 레코드를 읽어 부재를 세우고 한 번 병합한다.
//
// 재질은 전부 호출자(마을 팔레트) 소유의 기존 역할을 빌려 쓴다: 흙벽=mud, 볏짚=thatch,
//   용마름=jipjul, 막돌 축대·기단=fieldstone. 새 재질·텍스처·프로그램 계열이 0 이므로
//   드로우콜 증가는 병합 후 재질 수(최대 4)뿐이다.
//
// 로컬 좌표: +x = 성벽 접선(폭), +z = 도성 안쪽(정면), +y = 위. 원점은 (center, baseY).

const lifecycleByRoot = new WeakMap();
const REQUIRED_MATERIALS = Object.freeze(['wall', 'roof', 'ridge', 'stone']);
// 선택 역할과 그 대체선. 팔레트에 백골 목재(기둥·인방)와 널문 재질이 배선되면 개구부가 목재로
//   읽히지만, 없으면 흙벽·볏짚으로 떨어진다 — 어느 쪽이든 새 재질을 만들지 않는다.
const OPTIONAL_MATERIALS = Object.freeze({ post: 'wall', door: 'roof' });
const RIDGE_OVERHANG = 0.15;
// 초가 처마는 벽 위선보다 조금 내려앉는다(PRESETS.choga eaveDrop 0.30 의 절반 급).
const EAVE_DROP = 0.15;
// 기둥(칸 경계 세로 부재) 단면과 벽면 밖 돌출. 벽선을 칸마다 끊어 열이 하나의 무창 매스로
//   읽히지 않게 하는 구조 부재다(2026-08-05 비전 ①).
const POST_WIDTH = 0.16;
const POST_DEPTH = 0.14;
const POST_OUT = 0.10;
// 겹치는 부재끼리 같은 평면을 공유하지 않게 두는 물림. 미감 수치가 아니라 z-fighting 방지 여유다.
const SKIN_BITE = 0.03;
// 집줄(눌림 새끼) 단면. 초가 지붕은 이엉을 새끼 그물로 눌러 매므로 지붕면에 결이 생긴다 —
//   같은 jipjul 재질을 용마름 롤과 나눠 쓰므로 재질·드로우콜 증가가 0 이다.
const ROPE_SECTION = 0.055;
const ROPE_LIFT = 0.012;
// 텍스처 한 타일이 덮는 실제 길이(m). 초가 지붕면(builder/roof.js)이 쓰는 1.25m 와 같은 값이라
//   부속채 볏짚 결이 필지 초가와 같은 축척으로 읽힌다.
const TEX_TILE = 1.25;

function requireMaterial(materials, role) {
  const material = materials?.[role];
  if (!material?.isMaterial) {
    throw new TypeError(`gate quarter materials.${role} must be a Three.js material`);
  }
  return material;
}

function resolveMaterials(materials) {
  const resolved = Object.fromEntries(
    REQUIRED_MATERIALS.map((role) => [role, requireMaterial(materials, role)]),
  );
  for (const [role, fallback] of Object.entries(OPTIONAL_MATERIALS)) {
    const supplied = materials?.[role];
    if (supplied && !supplied.isMaterial) {
      throw new TypeError(`gate quarter materials.${role} must be a Three.js material`);
    }
    resolved[role] = supplied || resolved[fallback];
  }
  return resolved;
}

function addBox(group, unitBox, material, name, x, y, z, width, height, depth) {
  const mesh = new THREE.Mesh(unitBox, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(x, y, z);
  mesh.scale.set(width, height, depth);
  group.add(mesh);
  return mesh;
}

// 우진각 볏짚 지붕 한 덩이. 바닥 사각(처마 끝) → 용마루 선분으로 모으는 닫힌 솔리드 8삼각형이다.
//   개별 이엉을 모델링하지 않는 이유는 이 밴드가 성문 지구 배경 열이기 때문이고, 두툼한 실루엣은
//   thatch 텍스처와 프로파일이 만든다(docs/look-grammar.md silhouette-first).
//
// **UV 를 직접 쓴다**: v1 은 uv 속성이 없어 mergeStatic 의 normalizeGeo 가 0 으로 채웠고(그
//   경로는 uv 없는 지오에 영폭 uv 를 붙인다), 결과적으로 thatch 텍스처가 한 텍셀로 눌려 지붕이
//   결 없는 단색 갈색 덩이로 렌더됐다. u = 용마루 방향, v = 경사 하강 거리 / TEX_TILE 로
//   초가 지붕면(builder/roof.js)과 같은 규약·축척을 쓴다.
function hipRoofGeometry(halfWidth, halfDepth, height) {
  const ridgeHalf = Math.max(0, halfWidth - halfDepth);
  const positions = [];
  const uvs = [];
  // 정점 = [x, y, z, u(m), v(m)]. 면마다 uv 규약이 달라 non-indexed 로 펼친다.
  const tri = (...corners) => {
    for (const [x, y, z, u, v] of corners) {
      positions.push(x, y, z);
      uvs.push(u / TEX_TILE, v / TEX_TILE);
    }
  };
  // 경사면 하강 길이(용마루 → 처마 끝). 앞뒤 사다리꼴과 좌우 모임면이 서로 다르다.
  const slopeMain = Math.hypot(halfDepth, height);
  const slopeHip = Math.hypot(halfWidth - ridgeHalf, height);
  const w = halfWidth, d = halfDepth, h = height, r = ridgeHalf;
  // 감기는 바깥 법선 기준으로 손계산해 맞췄다(DoubleSide 로 덮지 않는다 — 팔레트 재질을
  //   빌려 쓰므로 side 를 바꾸면 다른 소비자까지 바뀐다).
  // 밑면(처마 소프릿, −y) — 아래에서 올려다볼 때 열려 보이지 않게 닫는다.
  tri([-w, 0, -d, -w, -d], [w, 0, -d, w, -d], [w, 0, d, w, d]);
  tri([-w, 0, -d, -w, -d], [w, 0, d, w, d], [-w, 0, d, -w, d]);
  // 앞(+z) 사다리꼴: v=0 이 용마루, v=slopeMain 이 처마 끝.
  tri([-w, 0, d, -w, slopeMain], [w, 0, d, w, slopeMain], [r, h, 0, r, 0]);
  tri([-w, 0, d, -w, slopeMain], [r, h, 0, r, 0], [-r, h, 0, -r, 0]);
  // 뒤(−z) 사다리꼴
  tri([w, 0, -d, w, slopeMain], [-w, 0, -d, -w, slopeMain], [-r, h, 0, -r, 0]);
  tri([w, 0, -d, w, slopeMain], [-r, h, 0, -r, 0], [r, h, 0, r, 0]);
  // 좌(−x)·우(+x) 모임면 삼각 — u 를 깊이 방향으로 돌려 결이 경사를 따라 흐르게 한다.
  tri([-w, 0, -d, -d, slopeHip], [-w, 0, d, d, slopeHip], [-r, h, 0, 0, 0]);
  tri([w, 0, -d, d, slopeHip], [r, h, 0, 0, 0], [w, 0, d, -d, slopeHip]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

// 용마름 롤 — 새끼로 엮어 능선에 얹는 볏짚 덮개. v1 은 각진 박스라 크림색 콘크리트 보처럼
//   튀었다(비전 ④): 눌린 원통으로 바꾸고 UV 를 롤 길이에 맞춰 타일링해 감김 결이 살게 한다.
function ridgeRollGeometry(length, radius) {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 8, 1);
  geometry.rotateZ(Math.PI / 2);          // 축을 +x(용마루 방향)로
  const uv = geometry.attributes.uv;
  const tiles = Math.max(2, Math.round(length / (TEX_TILE * 0.36)));
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * tiles);
  uv.needsUpdate = true;
  return geometry;
}

function buildUnit(record, materials, unitBox, ownedGeometries) {
  const { heights, stone, door } = record;
  const unit = new THREE.Group();
  unit.name = `gate-quarter-${record.id}`;

  // 막돌 축대 + 외벌대 기단. 접선 스팬은 계획이 준 비대칭 값을 그대로 쓴다 — 군집 이웃 쪽으로
  //   늘어난 축대가 중간에서 만나 사이에 지형이 들여다보이는 노치를 없애고(비전 ③),
  //   밑동은 접지 면적의 지형 최저점보다 아래(bottomY)여서 리턴면이 노출되지 않는다.
  const stoneWidth = stone.spanNegX + stone.spanPosX;
  addBox(
    unit, unitBox, materials.stone, 'gate-quarter-plinth',
    (stone.spanPosX - stone.spanNegX) / 2,
    (stone.topY + stone.bottomY) / 2 - record.baseY, 0,
    stoneWidth, stone.topY - stone.bottomY, stone.depth,
  );

  // 몸통 흙벽 — 정면 한 겹(doorRecess)만 남기고 뒤쪽을 통짜로 세운다. 남긴 한 겹을 좌우
  //   벽선 + 상부 인방으로 세우면 문 칸이 그늘진 음각 구멍이 된다(개구부, 비전 ①).
  const recess = door.recess;
  // 뒤 통짜 몸통을 정면 한 겹 안으로 SKIN_BITE 만큼 파고들게 한다 — 그러지 않으면 몸통 앞면과
  //   정면 벽선 뒷면이 정확히 같은 평면에 놓여 z-fighting 한다(법선이 반대라 명암이 깜빡인다).
  const core = record.d - recess + SKIN_BITE;
  addBox(
    unit, unitBox, materials.wall, 'gate-quarter-body',
    0, heights.plinth + heights.body / 2, (SKIN_BITE - recess) / 2,
    record.w, heights.body, core,
  );
  const skinZ = record.d / 2 - recess / 2;
  const doorLeft = door.offsetX - door.w / 2;
  const doorRight = door.offsetX + door.w / 2;
  for (const [from, to] of [[-record.w / 2, doorLeft], [doorRight, record.w / 2]]) {
    const span = to - from;
    if (span <= 1e-6) continue;
    addBox(
      unit, unitBox, materials.wall, 'gate-quarter-front-wall',
      (from + to) / 2, heights.plinth + heights.body / 2, skinZ,
      span, heights.body, recess,
    );
  }
  const headerHeight = heights.body - door.h;
  if (headerHeight > 1e-6) {
    addBox(
      unit, unitBox, materials.wall, 'gate-quarter-door-header',
      door.offsetX, heights.plinth + door.h + headerHeight / 2, skinZ,
      door.w, headerHeight, recess,
    );
  }

  // 기둥(칸 경계) — 벽면 밖으로 조금 나와 열을 칸마다 끊는다.
  for (let index = 0; index <= record.bays; index++) {
    const edge = index === 0 ? POST_WIDTH / 2
      : index === record.bays ? -POST_WIDTH / 2 : 0;
    addBox(
      unit, unitBox, materials.post, 'gate-quarter-post',
      -record.w / 2 + (record.w / record.bays) * index + edge,
      heights.plinth + heights.body / 2,
      record.d / 2 + POST_OUT - POST_DEPTH / 2,
      POST_WIDTH, heights.body, POST_DEPTH,
    );
  }

  // 거적문(짚을 엮어 문틀에 걷어 올린 헛간 문). 음각 안쪽에 걸려 구멍의 아래쪽은 그늘로 남는다.
  const matHeight = door.h * 0.45;
  addBox(
    unit, unitBox, materials.door, 'gate-quarter-door',
    door.offsetX, heights.plinth + door.h - matHeight / 2, record.d / 2 - recess * 0.55,
    door.w, matHeight, recess * 0.3,
  );

  const halfWidth = record.w / 2 + record.eave;
  const halfDepth = record.d / 2 + record.eave;
  const roofBottomY = heights.plinth + heights.body - EAVE_DROP;
  const roofHeight = heights.roofRise + heights.thatchThick;
  const roofGeometry = hipRoofGeometry(halfWidth, halfDepth, roofHeight);
  ownedGeometries.add(roofGeometry);
  const roof = new THREE.Mesh(roofGeometry, materials.roof);
  roof.name = 'gate-quarter-roof';
  roof.castShadow = true;
  roof.receiveShadow = true;
  roof.position.y = roofBottomY;
  unit.add(roof);

  // 용마름(새끼 감은 볏짚 롤). 모임지붕이라 용마루가 폭−깊이 만큼만 남는다. 눌린 원통이라
  //   각진 캡처럼 튀지 않고, 같은 jipjul 재질을 아래 집줄과 나눠 쓰므로 재질 수는 그대로다.
  const rollRadius = heights.thatchThick * 0.72;
  const ridgeHalf = Math.max(0, halfWidth - halfDepth);
  const rollLength = ridgeHalf * 2 + RIDGE_OVERHANG * 2;
  const rollGeometry = ridgeRollGeometry(rollLength, rollRadius);
  ownedGeometries.add(rollGeometry);
  const roll = new THREE.Mesh(rollGeometry, materials.ridge);
  roll.name = 'gate-quarter-ridge';
  roll.castShadow = true;
  roll.receiveShadow = true;
  roll.scale.y = 0.72;                     // 살짝 눌린 단면(완전 원통 아님)
  roll.position.y = roofBottomY + roofHeight - rollRadius * 0.3;
  unit.add(roll);

  // 집줄(눌림 새끼) — 앞뒤 경사면을 능선에서 처마로 내려오며 이엉을 눌러 맨다. 초가 지붕이
  //   한 장의 매끈한 갈색 면으로 읽히지 않게 하는 결이다.
  const slope = Math.hypot(halfDepth, roofHeight);
  const ropeXs = record.bays === 1 ? [0] : [-record.w * 0.22, record.w * 0.22];
  for (const ropeX of ropeXs) {
    for (const zSign of [1, -1]) {
      const rope = addBox(
        unit, unitBox, materials.ridge, 'gate-quarter-rope',
        ropeX,
        roofBottomY + roofHeight / 2 + (halfDepth / slope) * (ROPE_SECTION / 2 + ROPE_LIFT),
        zSign * (halfDepth / 2 + (roofHeight / slope) * (ROPE_SECTION / 2 + ROPE_LIFT)),
        ROPE_SECTION, ROPE_SECTION, slope,
      );
      // 경사면에 눕힌다: 박스의 +z 를 능선 방향으로 돌린다(앞면은 −z 쪽으로 올라간다).
      rope.rotation.x = zSign * Math.atan2(roofHeight, halfDepth);
    }
  }

  unit.position.set(record.center.x, record.baseY, record.center.z);
  unit.rotation.y = G.facingY(record.frontDir);
  return unit;
}

function disposeInputGeometries(root, additional = []) {
  const geometries = new Set(additional);
  root.traverse((object) => {
    if (object.geometry?.dispose) geometries.add(object.geometry);
  });
  for (const geometry of geometries) geometry.dispose();
}

/**
 * Build one merged low-draw gate-quarter band from a validated plan.
 *
 * `materials` is a semantic, caller-owned set: `{ wall, roof, ridge, stone }`.
 * The result borrows those materials and owns only its merged geometry. Remove it
 * from the scene before calling disposeGateQuarter(); caller materials stay valid.
 */
export function buildGateQuarter(plan, { materials } = {}) {
  validateGateQuarterPlan(plan);
  const resolved = resolveMaterials(materials);
  const source = new THREE.Group();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const ownedGeometries = new Set([unitBox]);

  try {
    for (const record of plan.records) {
      source.add(buildUnit(record, resolved, unitBox, ownedGeometries));
    }
    const root = mergeStatic([source], 'village-gate-quarter');
    root.userData.gateQuarter = {
      kind: GATE_QUARTER_KIND,
      schemaVersion: GATE_QUARTER_PLAN_SCHEMA_VERSION,
      ids: plan.records.map((record) => record.id),
      count: plan.records.length,
      gates: [...new Set(plan.records.map((record) => record.gate))],
      materialOwnership: 'caller',
      geometryOwnership: 'renderer',
    };
    lifecycleByRoot.set(root, { disposed: false });
    return root;
  } finally {
    // mergeStatic bakes cloned world-space geometry; the source members are never
    // part of its result and must be released on success and failure alike.
    disposeInputGeometries(source, [...ownedGeometries]);
    source.clear();
  }
}

/** Dispose renderer-owned geometry exactly once. Caller materials are preserved. */
export function disposeGateQuarter(root) {
  const lifecycle = root && lifecycleByRoot.get(root);
  if (!lifecycle || lifecycle.disposed) return false;
  lifecycle.disposed = true;
  const geometries = new Set();
  root.traverse((object) => {
    if (object.geometry?.dispose) geometries.add(object.geometry);
  });
  for (const geometry of geometries) geometry.dispose();
  return true;
}
