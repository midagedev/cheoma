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
// 기단 밖으로 나오는 축대 어깨(막돌 축대는 몸통보다 조금 넓다). 미감 수치가 아니라 벽 밑선이
//   기단 모서리와 겹쳐 z-fighting 하지 않게 두는 구조 여유다.
const PLINTH_MARGIN = 0.25;
const RIDGE_SECTION = 0.26;
const RIDGE_OVERHANG = 0.15;
// 초가 처마는 벽 위선보다 조금 내려앉는다(PRESETS.choga eaveDrop 0.30 의 절반 급).
const EAVE_DROP = 0.15;

function requireMaterial(materials, role) {
  const material = materials?.[role];
  if (!material?.isMaterial) {
    throw new TypeError(`gate quarter materials.${role} must be a Three.js material`);
  }
  return material;
}

function resolveMaterials(materials) {
  return Object.fromEntries(REQUIRED_MATERIALS.map((role) => [role, requireMaterial(materials, role)]));
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
function hipRoofGeometry(halfWidth, halfDepth, height) {
  const ridgeHalf = Math.max(0, halfWidth - halfDepth);
  const positions = [
    -halfWidth, 0, -halfDepth,
    halfWidth, 0, -halfDepth,
    halfWidth, 0, halfDepth,
    -halfWidth, 0, halfDepth,
    -ridgeHalf, height, 0,
    ridgeHalf, height, 0,
  ];
  // 감기는 바깥 법선 기준으로 손계산해 맞췄다(DoubleSide 로 덮지 않는다 — 팔레트 재질을
  //   빌려 쓰므로 side 를 바꾸면 다른 소비자까지 바뀐다).
  const indices = [
    // 밑면(처마 소프릿, −y) — 아래에서 올려다볼 때 열려 보이지 않게 닫는다.
    0, 1, 2, 0, 2, 3,
    // 앞(+z)·뒤(−z) 사다리꼴
    3, 2, 5, 3, 5, 4,
    1, 0, 4, 1, 4, 5,
    // 좌(−x)·우(+x) 모임지붕 삼각
    0, 3, 4,
    1, 5, 2,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildUnit(record, materials, unitBox, ownedGeometries) {
  const { heights } = record;
  const unit = new THREE.Group();
  unit.name = `gate-quarter-${record.id}`;

  // 막돌 축대 + 외벌대 기단. baseY(가장 높은 지형 귀) 위로 기단만 나오고, 사면 낙차(pad)는
  //   아래로 내려가 슬롯을 수평으로 앉힌다 — 필지 성토 패드·축대와 같은 어휘다.
  const stoneHeight = heights.pad + heights.plinth;
  addBox(
    unit, unitBox, materials.stone, 'gate-quarter-plinth',
    0, heights.plinth - stoneHeight / 2, 0,
    record.w + PLINTH_MARGIN * 2, stoneHeight, record.d + PLINTH_MARGIN * 2,
  );
  addBox(
    unit, unitBox, materials.wall, 'gate-quarter-body',
    0, heights.plinth + heights.body / 2, 0,
    record.w, heights.body, record.d,
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

  // 용마름(새끼 감은 볏짚 롤). 모임지붕이라 용마루가 폭−깊이 만큼만 남는다.
  const ridgeLength = Math.max(0, halfWidth - halfDepth) * 2 + RIDGE_OVERHANG * 2;
  if (ridgeLength > RIDGE_SECTION) {
    addBox(
      unit, unitBox, materials.ridge, 'gate-quarter-ridge',
      0, roofBottomY + roofHeight - RIDGE_SECTION * 0.35, 0,
      ridgeLength, RIDGE_SECTION, RIDGE_SECTION,
    );
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
