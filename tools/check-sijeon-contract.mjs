// Pure sijeon placement/facade contract. This intentionally imports the domain
// module directly so the planner can be developed before village integration.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as G from '../src/core/math/geom2.js';
import {
  SIJEON_FACADE_BAYS,
  SIJEON_FACADE_SCHEMA_VERSION,
  SIJEON_SIGN_POLICY,
  SIJEON_KIND_BREAK,
  SIJEON_KIND_SHOP,
  SIJEON_PLACEMENT,
  isSijeonShop,
  planSijeon,
  planSijeonFacade,
} from '../src/village/sijeon-plan.js';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function withoutGlobalRandom(build, label) {
  const original = Math.random;
  Math.random = () => {
    throw new Error(`${label} consumed global Math.random`);
  };
  try {
    return build();
  } finally {
    Math.random = original;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boxBounds(part) {
  return {
    minX: part.center.x - part.size.width / 2,
    maxX: part.center.x + part.size.width / 2,
    minY: part.center.y - part.size.height / 2,
    maxY: part.center.y + part.size.height / 2,
    minZ: part.center.z - part.size.depth / 2,
    maxZ: part.center.z + part.size.depth / 2,
  };
}

function boxesOverlap(a, b, epsilon = 1e-6) {
  return a.minX < b.maxX - epsilon && a.maxX > b.minX + epsilon
    && a.minY < b.maxY - epsilon && a.maxY > b.minY + epsilon
    && a.minZ < b.maxZ - epsilon && a.maxZ > b.minZ + epsilon;
}

function assertFiniteTree(value, label, path = label) {
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), `${path} is not finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteTree(item, label, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertFiniteTree(item, label, `${path}.${key}`);
    }
  }
}

function assertFacade(facade, label) {
  assertFiniteTree(facade, label);
  invariant(facade.schemaVersion === SIJEON_FACADE_SCHEMA_VERSION,
    `${label}: wrong schema version`);
  invariant(facade.bayCount === SIJEON_FACADE_BAYS
      && facade.columns.length === 3
      && facade.lintels.length === 2
      && facade.openings.length === 2
      && facade.benches.length === 2,
  `${label}: two-bay grammar is incomplete`);
  invariant(facade.storage.role === 'rear-storage', `${label}: rear storage missing`);
  invariant(facade.openings.every((opening) => opening.recessed === true),
    `${label}: an opening lost its recess contract`);

  const building = facade.building.bounds;
  const lot = facade.lot.bounds;
  invariant(building.minX >= lot.minX && building.maxX <= lot.maxX
      && building.minZ >= lot.minZ && building.maxZ <= lot.maxZ,
  `${label}: building mass escaped the planned footprint`);

  // 개구는 빈 공동이 아니다: 칸마다 판문 한 짝이 기둥 뒷면과 후퇴 배면 사이에 서고, 남은 폭으로
  // 배면 목재 면이 보인다(docs/architectural-authenticity.md §7.5 W2-3 / sijeon.md §3.2-4).
  invariant(facade.openings.every((opening) => opening.panel?.role === 'plank-shutter'),
    `${label}: a shop opening lost its plank shutter`);
  for (const opening of facade.openings) {
    const panel = opening.panel;
    const panelBounds = boxBounds(panel);
    const openingBounds = boxBounds(opening);
    const columnBack = Math.min(...facade.columns.map((column) => boxBounds(column).minZ));
    invariant(panelBounds.maxZ <= columnBack + 1e-9,
      `${label}: plank shutter crossed the column line`);
    invariant(panelBounds.minZ > openingBounds.maxZ,
      `${label}: plank shutter fell behind the recessed back face`);
    invariant(panel.size.width > 0 && panel.size.width < opening.size.width,
      `${label}: plank shutter must leave part of the opening readable`);
    invariant(panelBounds.minX >= openingBounds.minX - 1e-9
        && panelBounds.maxX <= openingBounds.maxX + 1e-9,
    `${label}: plank shutter escaped its bay opening`);
    invariant(panel.side === (panel.bay === 0 ? -1 : 1),
      `${label}: plank shutter folded to a non-deterministic side`);
  }

  const physicalParts = [
    ...facade.columns,
    ...facade.lintels,
    ...facade.openings,
    ...facade.openings.map((opening) => opening.panel),
    ...facade.benches,
    facade.storage,
  ];
  for (const part of physicalParts) {
    const bounds = boxBounds(part);
    invariant(bounds.minX >= lot.minX - 1e-9 && bounds.maxX <= lot.maxX + 1e-9,
      `${label}:${part.role} escaped the lot laterally`);
    invariant(bounds.minZ >= lot.minZ - 1e-9
        && bounds.maxZ <= facade.corridor.maxNonEaveZ + 1e-9,
    `${label}:${part.role} entered the road corridor`);
    invariant(bounds.minY >= -1e-9 && bounds.maxY <= facade.building.height + 1e-9,
      `${label}:${part.role} escaped the building height`);
  }
  invariant(facade.openings.every((opening) => (
    boxBounds(opening).maxZ < Math.min(...facade.columns.map((column) => boxBounds(column).maxZ))
  )), `${label}: shop opening is not recessed behind the column line`);
  invariant(facade.storage.center.z < 0
      && boxBounds(facade.storage).maxZ < Math.min(...facade.openings.map((opening) => (
        boxBounds(opening).minZ
      ))),
  `${label}: storage is not behind the sales frontage`);
  invariant(facade.roof.eaveProjection.front
      === Math.max(0, facade.corridor.maxEaveZ - facade.corridor.streetEdgeZ),
  `${label}: roof corridor exception is stale`);
  invariant(facade.corridor.maxEaveZ >= facade.building.bounds.maxZ,
    `${label}: roof no longer covers the facade`);

  // #54 벽체 완결: 지붕이 벽체 질량 위에 앉는가.
  //   수정 전 계획은 전면 골조 + 후면 저장 박스 + 박공지붕만 소유했고 측벽·배면벽·박공벽이 없었다.
  //   그래서 사선·망원(성문 접근로)에서 얇은 지붕판이 공중에 뜨고 밑면이 그대로 보였다.
  //   이 블록은 위 physicalParts 의 본체 높이 상한(<= building.height)을 **완화하지 않는다** —
  //   벽 위에서 지붕면까지 올라가는 closure 부재에만 적용되는 별도 상한(`roofline`)을 쓴다.
  const roofline = facade.roofline;
  invariant(roofline && roofline.wallTopY === facade.building.height,
    `${label}: roofline.wallTopY must equal the body height`);
  invariant(roofline.ridgeY === facade.building.height + facade.roof.rise,
    `${label}: roofline.ridgeY drifted from the roof rise`);
  invariant(roofline.slabAllowance > 0,
    `${label}: roofline must reserve a roof-slab allowance`);
  // 지붕면 y(z): 처마(z=±roof.depth/2, y=wall top)에서 용마루(z=0)까지의 선형 상승.
  const halfRoofDepth = facade.roof.depth / 2;
  const roofPlaneY = (z) => facade.building.height
    + facade.roof.rise * (1 - Math.abs(z) / halfRoofDepth);
  invariant(roofline.closureTopY >= facade.building.height - 1e-9
      && roofline.closureTopY <= roofPlaneY(building.maxZ) + 1e-9,
  `${label}: closure top ${roofline.closureTopY} escaped [wall top, roof plane]`);

  const walls = Array.isArray(facade.walls) ? facade.walls : [];
  const wallsOf = (role) => walls.filter((wall) => wall.role === role);
  invariant(walls.length === 4
      && wallsOf('rear-wall').length === 1
      && wallsOf('side-wall').length === 2
      && wallsOf('front-header').length === 1,
  `${label}: enclosure incomplete — need rear wall + two side walls + front header,`
    + ` got ${walls.map((wall) => wall.role).join(',') || 'none'}`);

  for (const wall of walls) {
    const bounds = boxBounds(wall);
    invariant(wall.size.width > 0 && wall.size.height > 0 && wall.size.depth > 0,
      `${label}:${wall.role} is degenerate`);
    invariant(bounds.minX >= lot.minX - 1e-9 && bounds.maxX <= lot.maxX + 1e-9,
      `${label}:${wall.role} escaped the lot laterally`);
    invariant(bounds.minZ >= lot.minZ - 1e-9
        && bounds.maxZ <= facade.corridor.maxNonEaveZ + 1e-9,
    `${label}:${wall.role} entered the road corridor`);
    invariant(bounds.minY >= -1e-9 && bounds.maxY <= roofline.closureTopY + 1e-9,
      `${label}:${wall.role} escaped [ground, closure top]`);
    // 개방 점포 전면은 발굴 사료 기반 어휘다(docs/sijeon.md §1.4) — 벽이 계획된 개구를 덮으면
    // 그 근거를 지우는 것이므로 실패로 다룬다.
    for (const opening of facade.openings) {
      invariant(!boxesOverlap(bounds, boxBounds(opening)),
        `${label}:${wall.role} covered the bay ${opening.bay} opening`);
    }
  }

  const [rearWall] = wallsOf('rear-wall');
  const rearBounds = boxBounds(rearWall);
  invariant(rearBounds.minX <= building.minX + 1e-9 && rearBounds.maxX >= building.maxX - 1e-9,
    `${label}: rear wall does not span the full building width`);
  invariant(rearBounds.minY <= 1e-9 && rearBounds.maxY >= facade.building.height - 1e-9,
    `${label}: rear wall does not reach the body height`);
  invariant(Math.abs(rearBounds.minZ - building.minZ) <= 1e-9,
    `${label}: rear wall is not on the rear face`);
  // 후면 저장 매스는 유지하되 벽 안쪽에 있어야 한다(벽과 겹친 슬래브가 아니다).
  const storageBounds = boxBounds(facade.storage);
  invariant(storageBounds.minZ >= rearBounds.maxZ - 1e-9,
    `${label}: rear storage still overlaps the rear wall`);

  for (const wall of wallsOf('side-wall')) {
    const bounds = boxBounds(wall);
    invariant(wall.side === -1 || wall.side === 1, `${label}: side wall lost its side`);
    const face = wall.side > 0 ? building.maxX : building.minX;
    const outer = wall.side > 0 ? bounds.maxX : bounds.minX;
    invariant(Math.abs(outer - face) <= 1e-9,
      `${label}: side wall ${wall.side} is not flush with the building side face`);
    invariant(bounds.minZ <= building.minZ + 1e-9 && bounds.maxZ >= building.maxZ - 1e-9,
      `${label}: side wall ${wall.side} does not span the building depth`);
    invariant(bounds.minY <= 1e-9 && bounds.maxY >= facade.building.height - 1e-9,
      `${label}: side wall ${wall.side} does not reach the body height`);
    invariant(!boxesOverlap(bounds, storageBounds),
      `${label}: side wall ${wall.side} overlaps the rear storage mass`);
  }

  const [frontHeader] = wallsOf('front-header');
  const headerBounds = boxBounds(frontHeader);
  const lintelTop = Math.max(...facade.lintels.map((lintel) => boxBounds(lintel).maxY));
  invariant(headerBounds.minX <= building.minX + 1e-9 && headerBounds.maxX >= building.maxX - 1e-9,
    `${label}: front header does not span the full building width`);
  invariant(headerBounds.minY <= lintelTop + 1e-9,
    `${label}: an open band remains between the lintel and the roof`);
  invariant(headerBounds.maxY >= roofline.closureTopY - 1e-9,
    `${label}: front header stops below the roof plane`);
  invariant(Math.abs(headerBounds.maxZ - building.maxZ) <= 1e-9,
    `${label}: front header is not on the shop frontage plane`);

  const gables = Array.isArray(facade.gables) ? facade.gables : [];
  invariant(gables.length === 2, `${label}: gable walls missing (${gables.length})`);
  invariant(new Set(gables.map((gable) => gable.side)).size === 2,
    `${label}: both gables sit on one side`);
  for (const gable of gables) {
    invariant(gable.role === 'gable-wall', `${label}: gable role drifted`);
    invariant(gable.thickness > 0, `${label}: gable has no thickness`);
    const profile = Array.isArray(gable.profile) ? gable.profile : [];
    invariant(profile.length >= 3, `${label}: gable profile is degenerate (${profile.length})`);
    const face = gable.side > 0 ? building.maxX : building.minX;
    invariant(Math.abs(gable.x - (face - gable.side * gable.thickness / 2)) <= 1e-9,
      `${label}: gable ${gable.side} is not flush with the building side face`);
    const zs = profile.map((point) => point.z);
    const ys = profile.map((point) => point.y);
    for (const point of profile) {
      invariant(point.z >= building.minZ - 1e-9 && point.z <= building.maxZ + 1e-9,
        `${label}: gable profile escaped the building depth`);
      invariant(point.y >= facade.building.height - 1e-9,
        `${label}: gable profile dipped below the wall top`);
      invariant(point.y <= roofPlaneY(point.z) + 1e-9,
        `${label}: gable profile pierced the roof plane at z=${point.z}`);
    }
    // 지붕 단면을 실제로 채우는가. 용마루 근처까지 올라가야 측면·사선에서 지붕 밑면이 사라진다.
    invariant(Math.max(...ys) >= facade.building.height + facade.roof.rise * 0.85 - 1e-9,
      `${label}: gable apex ${Math.max(...ys)} does not close the roof section`);
    invariant(Math.min(...zs) <= building.minZ + 1e-9 && Math.max(...zs) >= building.maxZ - 1e-9,
      `${label}: gable profile does not span the building depth`);
  }

  // 개방 전면 문법 보존(축소·제거 금지): 기둥 3 + 인방 2 + 판문 2 는 위에서 이미 단언했고,
  // 여기서는 벽체가 그 앞을 막지 않는다는 것까지 확인한다.
  for (const column of facade.columns) {
    const bounds = boxBounds(column);
    invariant(!boxesOverlap(bounds, headerBounds),
      `${label}: front header swallowed a front column`);
  }
}

const source = readFileSync(new URL('../src/village/sijeon-plan.js', import.meta.url), 'utf8');
invariant(!/from ['"]three['"]|Math\.random/.test(source),
  'sijeon planner gained a Three.js or global-random dependency');
invariant(Object.isFrozen(SIJEON_PLACEMENT), 'placement constants must be immutable');
invariant(SIJEON_PLACEMENT.pitch === 6.2
    && SIJEON_PLACEMENT.depth === 8.5
    && SIJEON_PLACEMENT.setback === 1.4
    && SIJEON_PLACEMENT.runCap === 26
    && SIJEON_PLACEMENT.segmentShops === 5
    && SIJEON_PLACEMENT.segmentGapPitches === 1,
'legacy placement dimensions drifted');

const horizontal = {
  id: 'east-west',
  level: 'daero',
  width: 10,
  pts: [{ x: -50, z: 0 }, { x: 50, z: 0 }],
};
const vertical = {
  id: 'north-south',
  level: 'daero',
  width: 12,
  pts: [{ x: 0, z: -50 }, { x: 0, z: 50 }],
};
const ignored = {
  id: 'minor',
  level: 'gil',
  width: 3,
  pts: [{ x: -50, z: 20 }, { x: 50, z: 20 }],
};
const roadsResult = { roads: [horizontal, vertical, ignored] };
const site = { center: { x: 0, z: 0 }, bowlR: 100 };
const placementInputBefore = stableJson({ roadsResult, site });

const first = withoutGlobalRandom(() => planSijeon(roadsResult, site, 0), 'placement:first');
const repeated = withoutGlobalRandom(() => planSijeon(roadsResult, site, 1), 'placement:repeat');
assertFiniteTree(first, 'placement');
invariant(stableJson({ roadsResult, site }) === placementInputBefore,
  'placement mutated its roads or site input');
invariant(stableJson(first) === stableJson(repeated),
  'placement changed across repeated/char01 inputs');
invariant(first.length === 24, `crossing arterial fixture produced ${first.length}, expected 24`);
invariant(first.every(isSijeonShop), 'short crossing fixture should not need product breaks');
invariant(hash(first) === 'fcc014f185adb2a73f0cb97b3daedc8312ff55be639276ed69f4dae7ea3dca56',
  `placement bytes drifted: ${hash(first)}`);

for (const [index, shop] of first.entries()) {
  invariant(shop.id === `s${index}`, `${shop.id}: IDs are not stable and contiguous`);
  invariant(shop.kind === SIJEON_KIND_SHOP, `${shop.id}: short-run records must be shops`);
  invariant(shop.w === 6.2 && shop.d === 8.5, `${shop.id}: placement dimensions drifted`);
  invariant(shop.poly.length === 4, `${shop.id}: footprint is not a quadrilateral`);
  invariant(shop.segment?.id && Number.isInteger(shop.segment.index),
    `${shop.id}: segment metadata missing`);
  const centroid = G.polyCentroid(shop.poly);
  invariant(Object.is(shop.center.x, centroid.x) && Object.is(shop.center.z, centroid.z),
    `${shop.id}: center no longer preserves the exact legacy centroid`);
  invariant(Math.abs(G.len(shop.frontDir) - 1) < 1e-12,
    `${shop.id}: frontDir is not normalized`);
  const road = Math.abs(shop.frontDir.x) > 0.5 ? vertical : horizontal;
  invariant(G.polylinePolygonDistance(road.pts, shop.poly) >= road.width / 2 + 1.4 - 1e-9,
    `${shop.id}: footprint entered its road corridor`);
}

const shortRoad = {
  level: 'daero',
  width: 8,
  pts: [{ x: -22, z: 0 }, { x: 22, z: 0 }],
};
invariant(planSijeon({ roads: [shortRoad] }, site).length === 4,
  'minimum usable arterial fixture changed');
invariant(planSijeon({ roads: [{ ...shortRoad, level: 'gil' }] }, site).length === 0,
  'non-arterial road produced shops');
invariant(planSijeon({ roads: [] }, site).length === 0,
  'empty road set should produce an empty plan');

// #218a: a long single arterial must insert reserved breaks so continuous shop
// runs never exceed segmentShops. Break polygons keep the market corridor clear
// of residential parcels while owning no facade mass.
const longRoad = {
  id: 'long-daero',
  level: 'daero',
  width: 10,
  pts: [{ x: -200, z: 0 }, { x: 200, z: 0 }],
};
const longSite = { center: { x: 0, z: 0 }, bowlR: 250 };
const longPlan = withoutGlobalRandom(
  () => planSijeon({ roads: [longRoad] }, longSite),
  'placement:long',
);
const longShops = longPlan.filter(isSijeonShop);
const longBreaks = longPlan.filter((record) => record.kind === SIJEON_KIND_BREAK);
invariant(longBreaks.length > 0, 'long arterial produced no product row breaks');
invariant(longShops.length + longBreaks.length === longPlan.length,
  'long plan contains unknown footprint kinds');
invariant(longBreaks.every((record) => record.poly?.length === 4 && !record.segment),
  'break footprints must reserve poly and omit segment mass metadata');

const roofWidth = SIJEON_PLACEMENT.pitch * 0.96 + 1.4;
const bySide = new Map();
for (const record of longPlan) {
  const key = `${Math.sign(record.frontDir.x)}:${Math.sign(record.frontDir.z)}`;
  if (!bySide.has(key)) bySide.set(key, []);
  bySide.get(key).push(record);
}
for (const [side, row] of bySide) {
  row.sort((a, b) => (a.x + a.z) - (b.x + b.z));
  let consecutive = 0;
  let maxConsecutive = 0;
  for (let index = 0; index < row.length; index++) {
    const record = row[index];
    if (record.kind === SIJEON_KIND_BREAK) {
      maxConsecutive = Math.max(maxConsecutive, consecutive);
      consecutive = 0;
      if (index > 0 && index < row.length - 1
          && isSijeonShop(row[index - 1]) && isSijeonShop(row[index + 1])) {
        const centerDist = Math.hypot(
          row[index + 1].x - row[index - 1].x,
          row[index + 1].z - row[index - 1].z,
        );
        // One empty pitch between shops ⇒ ~5 m clear between side eaves.
        invariant(centerDist >= SIJEON_PLACEMENT.pitch * 2 - 1e-6,
          `${side}: break did not open a full pitch between shop centres`);
        invariant(centerDist - roofWidth > 4.5,
          `${side}: roofs still bridge the product break (gap ${centerDist - roofWidth})`);
      }
      continue;
    }
    if (index > 0 && isSijeonShop(row[index - 1])) {
      const step = Math.hypot(record.x - row[index - 1].x, record.z - row[index - 1].z);
      if (step > SIJEON_PLACEMENT.pitch * 1.5) {
        maxConsecutive = Math.max(maxConsecutive, consecutive);
        consecutive = 0;
      }
    }
    consecutive++;
    invariant(record.segment?.length <= SIJEON_PLACEMENT.segmentShops,
      `${record.id}: segment length exceeds product cap`);
    invariant(
      record.segment?.role === 'solo'
        || record.segment?.role === 'start'
        || record.segment?.role === 'mid'
        || record.segment?.role === 'end',
      `${record.id}: invalid segment role`,
    );
  }
  maxConsecutive = Math.max(maxConsecutive, consecutive);
  invariant(maxConsecutive <= SIJEON_PLACEMENT.segmentShops,
    `${side}: continuous shop run ${maxConsecutive} exceeds segmentShops`);
}

// Segment annotation is deterministic and covers every real shop.
const segmentIds = new Set(longShops.map((shop) => shop.segment.id));
invariant(segmentIds.size >= longBreaks.length,
  'segment count is lower than the break count on a long run');
for (const segmentId of segmentIds) {
  const members = longShops
    .filter((shop) => shop.segment.id === segmentId)
    .sort((a, b) => a.segment.index - b.segment.index);
  invariant(members.length === members[0].segment.length,
    `${segmentId}: segment length metadata drifted`);
  for (const [index, member] of members.entries()) {
    invariant(member.segment.index === index, `${member.id}: segment index gap`);
  }
  if (members.length === 1) {
    invariant(members[0].segment.role === 'solo', `${segmentId}: solo role missing`);
  } else {
    invariant(members[0].segment.role === 'start'
        && members[members.length - 1].segment.role === 'end',
    `${segmentId}: start/end roles missing`);
  }
}

let facadeCases = 0;
for (const width of [4.4, 5.2, 6.2, 8, 12.5]) {
  for (const depth of [5.6, 6.4, 8.5, 11, 18]) {
    const label = `${width}x${depth}`;
    const facade = withoutGlobalRandom(
      () => planSijeonFacade({ w: width, d: depth, kind: SIJEON_KIND_SHOP }),
      `facade:${label}`,
    );
    const repeat = withoutGlobalRandom(
      () => planSijeonFacade({ w: width, d: depth, kind: SIJEON_KIND_SHOP }),
      `facade:${label}:repeat`,
    );
    invariant(stableJson(facade) === stableJson(repeat),
      `${label}: facade is not deterministic`);
    invariant(stableJson(JSON.parse(JSON.stringify(facade))) === stableJson(facade),
      `${label}: facade is not JSON-serializable`);
    assertFacade(facade, label);
    facadeCases++;
  }
}

// Deterministic local PRNG: broad dimension fuzz without using the ambient RNG
// whose non-consumption is itself part of the production contract.
let fuzzState = 0x5a17e0;
const fuzz01 = () => {
  fuzzState = (Math.imul(fuzzState, 1664525) + 1013904223) >>> 0;
  return fuzzState / 0x100000000;
};
for (let index = 0; index < 256; index++) {
  const width = 4.4 + fuzz01() * 20;
  const depth = 5.6 + fuzz01() * 28;
  const facade = withoutGlobalRandom(
    () => planSijeonFacade({ w: width, d: depth }),
    `facade:fuzz:${index}`,
  );
  assertFacade(facade, `fuzz:${index}`);
  facadeCases++;
}

// Placement-derived shops keep segment context on the facade; breaks never get one.
const longFacade = planSijeonFacade(longShops[0]);
invariant(longFacade.segment?.id === longShops[0].segment.id,
  'facade lost placement segment context');
let breakRejected = false;
try {
  planSijeonFacade(longBreaks[0]);
} catch (error) {
  breakRejected = error instanceof RangeError;
}
invariant(breakRejected, 'break footprint was accepted as a facade shop');

for (const invalid of [
  null,
  {},
  { w: NaN, d: 8.5 },
  { w: Infinity, d: 8.5 },
  { w: 6.2, d: NaN },
  { w: 0, d: 8.5 },
  { w: 4.39, d: 8.5 },
  { w: 6.2, d: 5.59 },
  { w: 6.2, d: 8.5, kind: SIJEON_KIND_BREAK },
]) {
  let rejected = false;
  try {
    planSijeonFacade(invalid);
  } catch (error) {
    rejected = error instanceof TypeError || error instanceof RangeError;
  }
  invariant(rejected, `invalid facade input was accepted: ${JSON.stringify(invalid)}`);
}

console.log(
  `check-sijeon-contract: PASS (${first.length} placement records, `
  + `${longBreaks.length} long-run breaks, ${facadeCases} facade cases)`,
);


// #227 schema v2 signs — decorative only, sparse, non-emissive.
// 버전 상수만 v3 로 추적한다(#54, 2026-08-04): 계획이 벽체까지 소유하게 되어 v2 렌더러로는 닫힌
// 행랑을 만들 수 없다 = 소비자 계약 변경. 표식 단언 자체는 그대로 유지·확장만 한다.
{
  invariant(SIJEON_FACADE_SCHEMA_VERSION === 3, 'schema version must be 3');
  invariant(SIJEON_SIGN_POLICY.emissive === false, 'sign policy must be non-emissive');
  const withId = planSijeonFacade({ w: 6.2, d: 7.5, id: 'sijeon-test-1' });
  invariant(Array.isArray(withId.signs), 'signs array required');
  for (const s of withId.signs) {
    invariant(s.role === 'marker-board', 'sign role');
    invariant(s.emissive === false, 'sign non-emissive');
    invariant(!('name' in s) && !('text' in s) && !('commodity' in s), 'no labels');
  }
  const noId = planSijeonFacade({ w: 6.2, d: 7.5 });
  invariant(Array.isArray(noId.signs) && noId.signs.length === 0, 'no id → no signs');
}

