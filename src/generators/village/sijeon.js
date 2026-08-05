import * as THREE from 'three';
import * as G from '../../core/math/geom2.js';
import { mergeStatic } from '../../village/instancing.js';
import {
  SIJEON_FACADE_SCHEMA_VERSION,
  SIJEON_SIGN_POLICY,
  isSijeonShop,
  planSijeonFacade,
} from '../../village/sijeon-plan.js';

// Three renderer for the renderer-free sijeon facade contract.
//
// The caller owns every material and the terrain sampler. This module owns only
// the geometries baked into its merged result, so a host can share one palette
// across a village or substitute another visual system without hidden textures,
// materials, site globals, or renderer RNG.

const lifecycleByRoot = new WeakMap();
// v4: `thatch` 가 추가된 이유 — 계획이 점포별로 초가/기와를 고르므로 renderer 가 두 지붕 표면 재질을
//   모두 받아야 한다. 새 텍스처를 만들지 않고 호출자(마을 어댑터)가 **이미 가진** 팔레트의 이엉 재질을
//   빌려 준다(docs/sijeon.md §3.5 재질 차입 계약). 용마루·용마름은 각 지붕 표면 재질을 그대로 쓴다 —
//   역할·재질·프로그램 추가 0.
const REQUIRED_MATERIALS = Object.freeze([
  'frame',
  'opening',
  'bench',
  'storage',
  'roof',
  'thatch',
]);
const BENCH_TOP_THICKNESS = 0.12;
const BENCH_LEG_WIDTH = 0.12;
const ROOF_UV_UNIT = 'unit-slope';

function requireMaterial(materials, role) {
  const material = materials?.[role];
  if (!material?.isMaterial) {
    throw new TypeError(`sijeon materials.${role} must be a Three.js material`);
  }
  return material;
}

function resolveMaterials(materials) {
  return Object.fromEntries(REQUIRED_MATERIALS.map((role) => [
    role,
    requireMaterial(materials, role),
  ]));
}

function requireHeightAt(heightAt) {
  if (typeof heightAt !== 'function') {
    throw new TypeError('sijeon heightAt must be a function');
  }
  return heightAt;
}

function setPhysicalMesh(mesh, name) {
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addBox(group, unitBox, part, material, name = part.role) {
  const mesh = setPhysicalMesh(new THREE.Mesh(unitBox, material), name);
  mesh.position.set(part.center.x, part.center.y, part.center.z);
  mesh.scale.set(part.size.width, part.size.height, part.size.depth);
  group.add(mesh);
  return mesh;
}

function addDisplayBench(group, unitBox, part, material) {
  const bottomY = part.center.y - part.size.height / 2;
  const topHeight = Math.min(BENCH_TOP_THICKNESS, part.size.height * 0.28);
  const top = {
    ...part,
    center: {
      ...part.center,
      y: part.center.y + part.size.height / 2 - topHeight / 2,
    },
    size: { ...part.size, height: topHeight },
  };
  addBox(group, unitBox, top, material, `${part.role}-top`);

  const legHeight = Math.max(0, part.size.height - topHeight);
  const legWidth = Math.min(
    BENCH_LEG_WIDTH,
    part.size.width * 0.16,
  );
  const legInset = Math.max(0, part.size.width / 2 - legWidth * 1.35);
  for (const side of [-1, 1]) {
    addBox(group, unitBox, {
      role: part.role,
      center: {
        x: part.center.x + side * legInset,
        y: bottomY + legHeight / 2,
        z: part.center.z,
      },
      size: {
        width: legWidth,
        height: legHeight,
        depth: part.size.depth * 0.82,
      },
    }, material, `${part.role}-leg`);
  }
}

// 압출 프리즘(#54 → v4). 계획이 준 로컬 `(u, y)` 다각형을 `extent` 만큼 한 수평축으로 압출한다.
//   박공벽·처마 폐합·용마루·용마름이 모두 이 한 가지 프리미티브다 — renderer 는 축과 배치만 읽고
//   형상을 다시 추론하지 않는다.
//   axis 'x': shape 좌표 (u, y) = (z, y). 압출축 +sz 는 rotateY(-90°) 로 -x 에 대응하므로 extent 의
//             절반을 옮기면 프리즘 중심이 계획된 center 에 온다.
//   axis 'z': shape 좌표 (u, y) = (x, y). 압출은 그대로 +z.
function addPrism(group, part, material, name = part.role) {
  const shape = new THREE.Shape();
  part.profile.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.u, point.y);
    else shape.lineTo(point.u, point.y);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: part.extent,
    bevelEnabled: false,
  });
  if (part.axis === 'x') {
    geometry.rotateY(-Math.PI / 2);
    geometry.translate(part.center + part.extent / 2, 0, 0);
  } else {
    geometry.translate(0, 0, part.center - part.extent / 2);
  }
  const mesh = setPhysicalMesh(new THREE.Mesh(geometry, material), name);
  group.add(mesh);
  return mesh;
}

// 방향 안전 삼각형 방출. 계획 격자의 winding 을 renderer 가 손으로 맞추면 유형·축마다 부호를 틀리기
//   쉽고, 우진각 마구리처럼 반폭이 0 으로 수렴하는 자리에서는 면적 0 삼각형이 남는다. 목표 법선과의
//   내적으로 뒤집고, 퇴화 삼각형은 버린다.
function pushTriangle(index, position, a, b, c, refX, refY, refZ) {
  const ux = position[b * 3] - position[a * 3];
  const uy = position[b * 3 + 1] - position[a * 3 + 1];
  const uz = position[b * 3 + 2] - position[a * 3 + 2];
  const vx = position[c * 3] - position[a * 3];
  const vy = position[c * 3 + 1] - position[a * 3 + 1];
  const vz = position[c * 3 + 2] - position[a * 3 + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  if (nx * nx + ny * ny + nz * nz < 1e-14) return;
  if (nx * refX + ny * refY + nz * refZ >= 0) index.push(a, b, c);
  else index.push(a, c, b);
}

// 지붕 표면(v4). 계획의 단면 격자를 (a) 지붕면 (b) 두께만큼 내린 밑면 (c) 격자 경계 테두리로
//   로프트한다. 상·하면은 부드럽게, 테두리는 각지게 셰이딩되도록 테두리만 정점을 따로 갖는다.
//   깊은 처마 아래에서 밑면이 보이므로 밑면을 생략할 수 없다(종전 슬래브도 두께 있는 박스였다).
// 지붕 계열 격자의 공통 정점 싱크. 지붕면과 용마름 캡이 같은 UV 규약을 쓴다.
//   기와: 지붕 폭·경사 길이로 반복수를 계산한 재질이므로 면당 0..1. 이엉: 팔레트 이엉 텍스처가
//   world 반복(1.25m 타일)을 전제하므로 실측 좌표를 그대로 쓴다(src/builder/roof.js 와 동일).
function createLatticeSink(roof) {
  const halfWidth = roof.width / 2;
  const halfDepth = roof.depth / 2;
  const unitUv = roof.surface.uv?.mode === ROOF_UV_UNIT;
  const tile = Number.isFinite(roof.surface.uv?.tile) && roof.surface.uv.tile > 0
    ? roof.surface.uv.tile
    : 1;
  const position = [];
  const uv = [];
  const index = [];
  const emit = (x, y, z) => {
    const slot = position.length / 3;
    position.push(x, y, z);
    if (unitUv) uv.push((x + halfWidth) / roof.width, Math.abs(z) / halfDepth);
    else uv.push(x / tile, z / tile);
    return slot;
  };
  const finish = () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    return geometry;
  };
  return { position, uv, index, emit, finish };
}

// 격자 한 장을 위를 향하게 로프트한다(단면열 → 사각형 띠). 퇴화 삼각형은 pushTriangle 이 버린다.
function loftUpward(sink, lines) {
  const grid = lines.map((line) => line.points.map((point) => sink.emit(line.x, point.y, point.z)));
  for (let i = 0; i < grid.length - 1; i++) {
    for (let j = 0; j < grid[i].length - 1; j++) {
      pushTriangle(sink.index, sink.position, grid[i][j], grid[i][j + 1], grid[i + 1][j], 0, 1, 0);
      pushTriangle(
        sink.index, sink.position,
        grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j],
        0, 1, 0,
      );
    }
  }
  return grid;
}

// 용마름 캡(v4 R2). 이엉을 말아 능선에 얹은 볼륨이고, 계획이 준 단면열의 양끝은 지붕면 격자에
//   정확히 붙어 있다 — 아랫면은 이엉 안에 묻히므로 단면(單面)으로 충분하다.
function ridgeCapGeometry(ridge, roof) {
  const sink = createLatticeSink(roof);
  loftUpward(sink, ridge.lines);
  return sink.finish();
}

function roofSurfaceGeometry(roof) {
  const lines = roof.surface.lines;
  const rows = lines.length;
  const cols = lines[0].points.length;
  const thickness = roof.thickness;
  const sink = createLatticeSink(roof);
  const { position, index, emit } = sink;

  const top = [];
  const bottom = [];
  for (let i = 0; i < rows; i++) {
    const row = [];
    for (let j = 0; j < cols; j++) {
      const point = lines[i].points[j];
      row.push(emit(lines[i].x, point.y, point.z));
    }
    top.push(row);
  }
  for (let i = 0; i < rows; i++) {
    const row = [];
    for (let j = 0; j < cols; j++) {
      const point = lines[i].points[j];
      row.push(emit(lines[i].x, point.y - thickness, point.z));
    }
    bottom.push(row);
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      pushTriangle(index, position, top[i][j], top[i][j + 1], top[i + 1][j], 0, 1, 0);
      pushTriangle(index, position, top[i][j + 1], top[i + 1][j + 1], top[i + 1][j], 0, 1, 0);
      pushTriangle(index, position, bottom[i][j], bottom[i][j + 1], bottom[i + 1][j], 0, -1, 0);
      pushTriangle(
        index, position,
        bottom[i][j + 1], bottom[i + 1][j + 1], bottom[i + 1][j],
        0, -1, 0,
      );
    }
  }

  // 테두리(처마 끝·박공 마구리). 경계 네 변을 각각 바깥 방향과 함께 돌린다.
  const edges = [
    { fixedJ: 0, ref: [0, 0, -1] },
    { fixedJ: cols - 1, ref: [0, 0, 1] },
    { fixedI: 0, ref: [-1, 0, 0] },
    { fixedI: rows - 1, ref: [1, 0, 0] },
  ];
  for (const edge of edges) {
    const along = edge.fixedJ === undefined ? cols : rows;
    for (let k = 0; k < along - 1; k++) {
      const i0 = edge.fixedI === undefined ? k : edge.fixedI;
      const j0 = edge.fixedJ === undefined ? k : edge.fixedJ;
      const i1 = edge.fixedI === undefined ? k + 1 : edge.fixedI;
      const j1 = edge.fixedJ === undefined ? k + 1 : edge.fixedJ;
      const pA = lines[i0].points[j0];
      const pB = lines[i1].points[j1];
      if (Math.abs(lines[i0].x - lines[i1].x) < 1e-9
        && Math.abs(pA.z - pB.z) < 1e-9) continue;
      const a = emit(lines[i0].x, pA.y, pA.z);
      const b = emit(lines[i1].x, pB.y, pB.z);
      const c = emit(lines[i1].x, pB.y - thickness, pB.z);
      const d = emit(lines[i0].x, pA.y - thickness, pA.z);
      const [rx, ry, rz] = edge.ref;
      pushTriangle(index, position, a, b, c, rx, ry, rz);
      pushTriangle(index, position, a, c, d, rx, ry, rz);
    }
  }

  return sink.finish();
}

function roofSurfaceMaterial(roof, materials) {
  return roof.kind === 'choga' ? materials.thatch : materials.roof;
}

function addRoof(group, facade, materials) {
  const { roof } = facade;
  const material = roofSurfaceMaterial(roof, materials);
  const mesh = setPhysicalMesh(new THREE.Mesh(roofSurfaceGeometry(roof), material), roof.role);
  group.add(mesh);
  const { ridge } = roof;
  if (!ridge) return;
  if (ridge.kind === 'ridge-cap') {
    const cap = setPhysicalMesh(new THREE.Mesh(ridgeCapGeometry(ridge, roof), material), ridge.role);
    group.add(cap);
    return;
  }
  addPrism(group, ridge, material);
}

function buildShopUnit(shop, materials, unitBox) {
  const facade = planSijeonFacade(shop);
  const unit = new THREE.Group();
  unit.name = `sijeon-${shop.id ?? 'shop'}`;
  const signs = Array.isArray(facade.signs) ? facade.signs : [];

  for (const column of facade.columns) {
    addBox(unit, unitBox, column, materials.frame);
  }
  for (const lintel of facade.lintels) {
    addBox(unit, unitBox, lintel, materials.frame);
  }
  for (const opening of facade.openings) {
    addBox(unit, unitBox, opening, materials.opening);
    // 판문 한 짝(plan 파생 순수값). 기존 frame 재질을 빌려 쓰므로 새 재질·텍스처·드로우콜이 없다.
    if (opening.panel) addBox(unit, unitBox, opening.panel, materials.frame);
  }
  for (const bench of facade.benches) {
    addDisplayBench(unit, unitBox, bench, materials.bench);
  }
  const signMaterial = materials[SIJEON_SIGN_POLICY.materialRole] || materials.frame;
  for (const sign of signs) {
    if (sign.emissive) throw new Error('sijeon marker boards must be non-emissive');
    addBox(unit, unitBox, sign, signMaterial, sign.role);
  }
  // 벽체(#54): 배면·측면·전면 상벽은 벽 mass 이므로 이미 그 의미로 쓰이는 `storage` 역할 재질을
  //   빌려 쓴다(새 역할·재질·텍스처 0). 벽 상단~지붕면 폐합(v4)은 프리즘이라 unitBox 를 쓸 수 없다.
  for (const wall of facade.walls) {
    addBox(unit, unitBox, wall, materials.storage, wall.role);
  }
  for (const closure of facade.closures) {
    addPrism(unit, closure, materials.storage);
  }
  addBox(unit, unitBox, facade.storage, materials.storage);
  addRoof(unit, facade, materials);
  unit.userData.sijeonSignCount = signs.length;
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
 * Build one low-draw sijeon row renderer.
 *
 * `materials` is a semantic, caller-owned set:
 * `{ frame, opening, bench, storage, roof, thatch }`.
 * `roof` skins 기와 shops (and their 용마루), `thatch` skins 초가 shops (and their 용마름);
 * the plan decides which shop gets which, so both are required.
 * `heightAt(x, z)` is also caller-owned and is the sole terrain dependency.
 *
 * The result borrows those materials and owns its merged geometries. Remove it
 * from the scene before calling disposeSijeon(); caller materials remain valid.
 */
export function buildSijeon(shops, { materials, heightAt } = {}) {
  if (!Array.isArray(shops)) throw new TypeError('sijeon shops must be an array');
  const resolvedMaterials = resolveMaterials(materials);
  const terrainHeightAt = requireHeightAt(heightAt);
  const source = new THREE.Group();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  try {
    const builtShops = [];
    let breakCount = 0;
    let signCount = 0;
    for (const shop of shops) {
      // Reserved break footprints stay in the plan as parcel blockers but own no
      // solid mass — that is the #218 row-break product read (not a missing mesh).
      if (!isSijeonShop(shop)) {
        breakCount++;
        continue;
      }
      const unit = buildShopUnit(
        shop,
        resolvedMaterials,
        unitBox,
      );
      const x = shop?.center?.x;
      const z = shop?.center?.z;
      const frontDir = shop?.frontDir;
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        throw new TypeError('sijeon shop center must contain finite x/z');
      }
      if (!Number.isFinite(frontDir?.x) || !Number.isFinite(frontDir?.z)) {
        throw new TypeError('sijeon shop frontDir must contain finite x/z');
      }
      if (Math.hypot(frontDir.x, frontDir.z) < 1e-9) {
        throw new RangeError('sijeon shop frontDir must be non-zero');
      }
      const y = terrainHeightAt(x, z);
      if (!Number.isFinite(y)) {
        throw new TypeError(`sijeon heightAt returned a non-finite height for ${shop.id ?? 'shop'}`);
      }
      unit.position.set(x, y, z);
      unit.rotation.y = G.facingY(frontDir);
      signCount += unit.userData.sijeonSignCount || 0;
      source.add(unit);
      builtShops.push(shop);
    }

    const root = mergeStatic([source], 'village-sijeon');
    root.userData.sijeon = {
      schemaVersion: SIJEON_FACADE_SCHEMA_VERSION,
      shopIds: builtShops.map((shop) => shop.id).filter((id) => id != null),
      shopCount: builtShops.length,
      signCount,
      breakCount,
      footprintCount: shops.length,
      materialOwnership: 'caller',
      geometryOwnership: 'renderer',
    };
    lifecycleByRoot.set(root, { disposed: false });
    return root;
  } finally {
    // mergeStatic bakes cloned world-space geometry. The temporary unit geometry
    // is never part of its result and must be released on success and failure.
    disposeInputGeometries(source, [unitBox]);
    source.clear();
  }
}

/**
 * Dispose renderer-owned geometry exactly once. Caller materials are preserved.
 * Scene detachment remains the caller's responsibility.
 */
export function disposeSijeon(root) {
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
