// Pure sijeon placement/facade contract. This intentionally imports the domain
// module directly so the planner can be developed before village integration.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as G from '../src/core/math/geom2.js';
import { SIJEON_OCCLUDER_TOP } from '../src/runtime/village/village-door-records.js';
import {
  SIJEON_FACADE_BAYS,
  SIJEON_FACADE_SCHEMA_VERSION,
  SIJEON_ROOF_CHOGA,
  SIJEON_ROOF_GIWA,
  SIJEON_ROOF_MIX,
  SIJEON_SIGN_POLICY,
  SIJEON_KIND_BREAK,
  SIJEON_KIND_SHOP,
  SIJEON_PLACEMENT,
  isSijeonShop,
  planSijeon,
  planSijeonFacade,
  sijeonRoofKind,
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

// ── v4 지붕 표면 재구성 ────────────────────────────────────────────────────────────────
// 계획이 내보낸 단면 격자를 **렌더러와 동일한 삼각형 분할**로 재구성한다. 폐합 부재가 실제 지붕
// 아래에 있는지(틈 없음 / 관통 없음)를 단언하려면 해석식이 아니라 이 격자에서 높이를 읽어야 한다.
function roofTriangles(roof) {
  const lines = roof.surface.lines;
  const triangles = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const cols = lines[i].points.length;
    for (let j = 0; j < cols - 1; j++) {
      const a = { x: lines[i].x, z: lines[i].points[j].z, y: lines[i].points[j].y };
      const b = { x: lines[i].x, z: lines[i].points[j + 1].z, y: lines[i].points[j + 1].y };
      const c = { x: lines[i + 1].x, z: lines[i + 1].points[j].z, y: lines[i + 1].points[j].y };
      const d = { x: lines[i + 1].x, z: lines[i + 1].points[j + 1].z, y: lines[i + 1].points[j + 1].y };
      triangles.push([a, b, c], [b, d, c]);
    }
  }
  return triangles;
}

// (x, z) 를 덮는 삼각형의 보간 높이. 격자선 위의 점은 여러 삼각형에 걸리므로 최대값을 쓴다
// (= 지붕면의 상한 → 관통 판정이 보수적이 된다). 덮는 삼각형이 없으면 null = 지붕 미피복.
function roofSurfaceYAt(triangles, x, z, epsilon = 1e-7) {
  let best = null;
  for (const [a, b, c] of triangles) {
    const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(d) < 1e-12) continue;
    const w0 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
    const w1 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -epsilon || w1 < -epsilon || w2 < -epsilon) continue;
    const y = w0 * a.y + w1 * b.y + w2 * c.y;
    if (best === null || y > best) best = y;
  }
  return best;
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

  // #54 벽체 완결 → v4 지붕 격상: 지붕이 벽체 질량 위에 앉는가.
  //   v2 계획은 전면 골조 + 후면 저장 박스 + 박공지붕만 소유했고 측벽·배면벽·박공벽이 없어 얇은
  //   지붕판이 공중에 떴다. v3 는 그 틈을 **선형 지붕면 전제의 스칼라 상한** 하나로 닫았고, v4 의
  //   지붕면은 유형별 곡면이라 스칼라로는 닫히지 않는다. 그래서 아래 단언은 스칼라 대신 계획이
  //   내보낸 격자에서 읽은 실제 지붕면과 폐합 프리즘을 직접 대조한다.
  //   위 physicalParts 의 본체 높이 상한(<= building.height)은 **완화되지 않는다** — v4 에서는 벽도
  //   본체 높이까지만 올라가고 그 위는 closure 프리즘이 맡는다(v3 보다 강한 계약이다).
  const roofline = facade.roofline;
  const roof = facade.roof;
  invariant(roofline && roofline.wallTopY === facade.building.height,
    `${label}: roofline.wallTopY must equal the body height`);
  invariant(roof.thickness > 0, `${label}: roof member has no thickness`);
  // 처마 **밑면**이 벽 상단에 앉는다 = 지붕면은 그보다 부재 두께만큼 높다.
  invariant(Math.abs(roofline.eaveTopY - (facade.building.height + roof.thickness)) <= 1e-9,
    `${label}: eaveTopY ${roofline.eaveTopY} is not wallTop + thickness`);
  invariant(Math.abs(roofline.apexY - (roofline.eaveTopY + roof.rise)) <= 1e-9,
    `${label}: roofline.apexY drifted from eaveTop + rise`);
  invariant(roofline.ridgeY <= roofline.apexY + 1e-9
      && roofline.ridgeY >= roofline.eaveTopY + roof.rise * 0.8,
  `${label}: sampled ridge ${roofline.ridgeY} escaped [eaveTop+0.8·rise, apex]`);
  invariant(roofline.slabAllowance > 0 && roofline.slabAllowance < roof.thickness,
    `${label}: closure allowance ${roofline.slabAllowance} must be inside the member thickness`);
  // 문 가림 occluder 상한. `src/runtime/village/village-door-records.js#sijeonRecord` 가 시전
  //   occluder 를 `baseY .. baseY + SIJEON_OCCLUDER_TOP` 프리즘으로 세우므로 두 값은 동조해야 한다
  //   (occluder 가 실제 질량보다 낮으면 문 가림 판정이 틀린다). 2026-08-05 재핀: 4.7 → 5.6, 근거는
  //   초가 물매가 그 상한에 갇혀 "얇은 접시" 로 기각된 비전 판정(sijeon.md §3.5.6). 게이트는 상수를
  //   그 모듈에서 직접 읽어 대조하므로 한쪽만 바뀌면 실패한다.
  invariant(roofline.ceilingY === SIJEON_OCCLUDER_TOP,
    `${label}: roof ceiling ${roofline.ceilingY} drifted from the door-occlusion prism`
    + ` top ${SIJEON_OCCLUDER_TOP}`);
  invariant(roofline.topY <= roofline.ceilingY + 1e-9,
    `${label}: roof top ${roofline.topY} exceeds the door-occlusion prism ceiling`);

  // 지붕 표면 격자.
  invariant(roof.kind === SIJEON_ROOF_GIWA || roof.kind === SIJEON_ROOF_CHOGA,
    `${label}: unknown roof kind ${roof.kind}`);
  invariant(roof.role === (roof.kind === SIJEON_ROOF_CHOGA ? 'hip-roof' : 'gable-roof'),
    `${label}: roof role ${roof.role} does not match kind ${roof.kind}`);
  invariant(roof.surface?.kind === 'section-loft',
    `${label}: roof surface is not a section loft`);
  const lines = roof.surface.lines;
  invariant(Array.isArray(lines) && lines.length >= 5,
    `${label}: roof needs at least 5 sections (${lines?.length})`);
  const cols = lines[0].points.length;
  invariant(cols >= 7 && cols % 2 === 1,
    `${label}: roof section needs an odd count of at least 7 points (${cols})`);
  const halfRoofWidth = roof.width / 2;
  const halfRoofDepth = roof.depth / 2;
  for (const [index, line] of lines.entries()) {
    invariant(line.points.length === cols,
      `${label}: section ${index} has a ragged point count`);
    invariant(Math.abs(line.x) <= halfRoofWidth + 1e-9,
      `${label}: section ${index} x ${line.x} escaped the roof width`);
    if (index > 0) {
      invariant(line.x > lines[index - 1].x + 1e-12,
        `${label}: section x is not strictly increasing at ${index}`);
    }
    for (const [j, point] of line.points.entries()) {
      invariant(Math.abs(point.z) <= halfRoofDepth + 1e-9,
        `${label}: section ${index} point ${j} z ${point.z} escaped the roof depth`);
      invariant(point.y >= roofline.eaveTopY - 1e-9 && point.y <= roofline.apexY + 1e-9,
        `${label}: section ${index} point ${j} y ${point.y} escaped [eaveTop, apex]`);
      if (j > 0) {
        invariant(point.z >= line.points[j - 1].z - 1e-12,
          `${label}: section ${index} z is not ordered at ${j}`);
      }
    }
    // 처마 링은 지붕면의 최저 고도다(기와는 앙곡만큼 들리고, 초가는 정확히 처마 높이).
    invariant(line.points[0].y <= roofline.eaveTopY + 0.2 + 1e-9
        && line.points[cols - 1].y <= roofline.eaveTopY + 0.2 + 1e-9,
    `${label}: section ${index} eave ring drifted above the eave band`);
  }
  invariant(Math.abs(lines[0].x + halfRoofWidth) <= 1e-9
      && Math.abs(lines[lines.length - 1].x - halfRoofWidth) <= 1e-9,
  `${label}: roof sections do not reach both roof edges`);

  // 용마루(기와 프리즘) / 용마름(초가 캡).
  const ridge = roof.ridge;
  invariant(ridge, `${label}: roof ridge member missing`);
  invariant(ridge.role === (roof.kind === SIJEON_ROOF_CHOGA ? 'ridge-roll' : 'ridge-tile'),
    `${label}: ridge role ${ridge.role} does not match kind ${roof.kind}`);
  invariant(roofline.topY >= ridge.topY - 1e-9,
    `${label}: roofline.topY does not account for the ridge member`);

  const triangles = roofTriangles(roof);

  if (roof.kind === SIJEON_ROOF_CHOGA) {
    // R2 차단 결함: 압출 프리즘 용마름이 처지는 능선을 따라가지 못해 돔에서 떠올랐고, 리본 마구리
    //   단면이 정육면체 블록으로 보였다. 계약은 이제 (a) 캡이 단면열이고 (b) 그 양끝 점이 지붕면
    //   격자에 **밀착**하며 (c) 끝단 단면의 높이가 죽어 뭉툭한 마구리를 만들지 않는다는 것이다.
    invariant(ridge.kind === 'ridge-cap',
      `${label}: thatch ridge must be a lattice-hugging cap, got ${ridge.kind}`);
    const capLines = ridge.lines;
    invariant(Array.isArray(capLines) && capLines.length >= 3,
      `${label}: ridge cap needs at least 3 sections`);
    let bulgeMax = 0;
    for (const [index, line] of capLines.entries()) {
      const points = line.points;
      invariant(points.length >= 3, `${label}: ridge cap section ${index} is degenerate`);
      for (const point of points) {
        const surface = roofSurfaceYAt(triangles, line.x, point.z);
        invariant(surface !== null,
          `${label}: ridge cap section ${index} sits outside the roof footprint`);
        // 캡은 지붕면 위에 얹힌다(파고들지 않는다) — 그리고 밀착 상한을 넘어 뜨지 않는다.
        invariant(point.y >= surface - 1e-6,
          `${label}: ridge cap dips into the roof surface at x=${line.x.toFixed(3)}`);
        const lift = point.y - surface;
        if (lift > bulgeMax) bulgeMax = lift;
        // 폭 방향 양끝은 지붕면에 정확히 붙어야 한다 = 공기 틈 금지.
        if (point === points[0] || point === points[points.length - 1]) {
          invariant(lift <= 1e-6,
            `${label}: ridge cap edge floats ${lift.toFixed(4)}m above the roof surface`);
        }
      }
    }
    invariant(bulgeMax > 0.02,
      `${label}: ridge cap has no volume above the roof (${bulgeMax.toFixed(4)}m)`);
    // 롤은 **용마루 구간만** 덮는다. 마구리 경사면까지 지나가면 모히칸처럼 능선 밖으로 뻗는다.
    //   용마루 끝에서는 처짐이 0 이므로 지붕면이 정확히 apex 높이다 — 캡의 끝 단면이 그 조건을
    //   만족하는지로 검사한다(경사면 위였다면 그보다 훨씬 낮다).
    for (const line of [capLines[0], capLines[capLines.length - 1]]) {
      const ridgeHeight = roofSurfaceYAt(triangles, line.x, 0);
      invariant(ridgeHeight !== null && ridgeHeight >= roofline.apexY - 0.02,
        `${label}: ridge cap end at x=${line.x.toFixed(3)} sits on the hip slope`
        + ` (roof ${ridgeHeight === null ? 'n/a' : ridgeHeight.toFixed(3)} vs apex`
        + ` ${roofline.apexY.toFixed(3)}) — the roll must stay on the ridge`);
    }
    // 끝단 단면은 볼륨이 0 에 수렴한다(뭉툭한 마구리 블록 금지).
    for (const line of [capLines[0], capLines[capLines.length - 1]]) {
      let endLift = 0;
      for (const point of line.points) {
        const surface = roofSurfaceYAt(triangles, line.x, point.z);
        if (surface !== null) endLift = Math.max(endLift, point.y - surface);
      }
      invariant(endLift <= bulgeMax * 0.25 + 1e-6,
        `${label}: ridge cap end section keeps ${endLift.toFixed(4)}m of blunt volume`);
    }
  } else {
    invariant(ridge.kind === 'ridge-prism' && (ridge.axis === 'x' || ridge.axis === 'z'),
      `${label}: tile ridge must be an extruded prism`);
    invariant(ridge.extent > 0 && Array.isArray(ridge.profile) && ridge.profile.length >= 4,
      `${label}: ridge prism is degenerate`);
    invariant(ridge.topY >= roofline.ridgeY - 1e-9,
      `${label}: ridge member ${ridge.topY} sinks below the roof surface`);
  }

  // R2 차단 결함 ②: 인접 점포 지붕의 기하 교차. 배치 pitch 안에서 지붕이 서로 겹치면 유형·높이가
  //   다른 이웃끼리 하드 관통이 되어 초가 돔이 기와 지붕면을 뚫고 나온다(부감 히어로 프레임).
  //   행랑은 벽을 맞댄 연속 건물이므로 지붕 폭은 필지 pitch 를 넘을 수 없다.
  invariant(roof.width <= facade.lot.width + 1e-9,
    `${label}: roof width ${roof.width.toFixed(3)} exceeds the placement pitch`
    + ` ${facade.lot.width.toFixed(3)} — adjacent roofs would intersect`);
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
    // v4: 벽은 본체 높이까지만 — 그 위는 지붕면을 따르는 closure 프리즘이 맡는다.
    invariant(bounds.minY >= -1e-9 && bounds.maxY <= facade.building.height + 1e-9,
      `${label}:${wall.role} escaped [ground, body height]`);
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
  invariant(Math.abs(headerBounds.maxY - facade.building.height) <= 1e-9,
    `${label}: front header does not reach the body height`);
  invariant(Math.abs(headerBounds.maxZ - building.maxZ) <= 1e-9,
    `${label}: front header is not on the shop frontage plane`);

  // ── v4 지붕 앉음(roof seat): 네 방향 폐합 프리즘 ─────────────────────────────────────
  // 이것이 "지붕이 벽체 위에 앉는다"의 수치 계약이다. 각 프리즘 상단이
  //   (a) 그 지점 지붕면보다 낮고           → 부재 관통 없음
  //   (b) 그 지점 지붕 밑면(지붕면 − 두께)보다 높다 → 벽 위 열린 띠 없음
  // 두 조건을 **계획이 내보낸 격자에서 읽은 실제 높이**로 확인한다.
  const closures = Array.isArray(facade.closures) ? facade.closures : [];
  invariant(closures.length === 4,
    `${label}: roof seat needs four closures, got ${closures.length}`);
  const sideClosures = closures.filter((closure) => closure.axis === 'x');
  const endClosures = closures.filter((closure) => closure.axis === 'z');
  invariant(sideClosures.length === 2 && endClosures.length === 2,
    `${label}: closures must be two side prisms and two end prisms`);
  invariant(new Set(sideClosures.map((closure) => closure.side)).size === 2,
    `${label}: both side closures sit on one side`);
  invariant(new Set(endClosures.map((closure) => closure.end)).size === 2,
    `${label}: both end closures sit on one end`);
  const expectedSideRole = roof.kind === SIJEON_ROOF_CHOGA ? 'eave-closure' : 'gable-wall';
  for (const closure of sideClosures) {
    invariant(closure.role === expectedSideRole,
      `${label}: side closure role ${closure.role} does not match roof kind ${roof.kind}`);
  }
  for (const closure of endClosures) {
    invariant(closure.role === 'eave-closure',
      `${label}: end closure role ${closure.role} drifted`);
  }

  let seatedPoints = 0;
  for (const closure of closures) {
    invariant(closure.extent > 0, `${label}:${closure.role} prism has no extent`);
    const profile = Array.isArray(closure.profile) ? closure.profile : [];
    invariant(profile.length >= 5,
      `${label}:${closure.role} profile is degenerate (${profile.length})`);
    const span = closure.axis === 'x'
      ? { min: building.minZ, max: building.maxZ }
      : { min: building.minX, max: building.maxX };
    // 프리즘은 벽 두께 구간을 차지한다. 그 구간에서 **가장 낮은** 지붕면을 기준으로 삼아야 반대
    // 면에서 지붕을 뚫지 않는다 — 두 면 모두에서 검사한다.
    const faces = closure.axis === 'x'
      ? [closure.center - closure.extent / 2, closure.center + closure.extent / 2]
      : [closure.center - closure.extent / 2, closure.center + closure.extent / 2];
    let sawTop = false;
    for (const point of profile) {
      invariant(point.u >= span.min - 1e-9 && point.u <= span.max + 1e-9,
        `${label}:${closure.role} profile escaped the building footprint at u=${point.u}`);
      invariant(point.y >= facade.building.height - 1e-9,
        `${label}:${closure.role} profile dipped below the wall top`);
      if (point.y <= facade.building.height + 1e-9) continue;
      sawTop = true;
      for (const face of faces) {
        const x = closure.axis === 'x' ? face : point.u;
        const z = closure.axis === 'x' ? point.u : face;
        const surface = roofSurfaceYAt(triangles, x, z);
        invariant(surface !== null,
          `${label}:${closure.role} sits outside the roof footprint at (${x.toFixed(3)}, ${z.toFixed(3)})`
          + ' — the roof does not cover the wall');
        invariant(point.y <= surface + 1e-9,
          `${label}:${closure.role} pierced the roof surface at (${x.toFixed(3)}, ${z.toFixed(3)}):`
          + ` closure ${point.y.toFixed(4)} > surface ${surface.toFixed(4)}`);
        invariant(point.y >= surface - roof.thickness - 1e-9,
          `${label}:${closure.role} leaves an open band at (${x.toFixed(3)}, ${z.toFixed(3)}):`
          + ` closure ${point.y.toFixed(4)} < underside ${(surface - roof.thickness).toFixed(4)}`);
        seatedPoints++;
      }
    }
    invariant(sawTop, `${label}:${closure.role} never rises above the wall top`);
    invariant(profile.some((point) => Math.abs(point.u - span.min) <= 1e-9)
        && profile.some((point) => Math.abs(point.u - span.max) <= 1e-9),
    `${label}:${closure.role} profile does not span the building footprint`);
    for (const opening of facade.openings) {
      invariant(boxBounds(opening).maxY <= facade.building.height + 1e-9,
        `${label}: an opening rose into the roof-seat band`);
    }
  }
  invariant(seatedPoints >= 8,
    `${label}: too few roof-seat samples verified (${seatedPoints})`);

  // 지붕이 건물 평면 전체를 덮는가 — 폐합선 밖의 코너까지 직접 확인한다.
  for (const x of [building.minX, 0, building.maxX]) {
    for (const z of [building.minZ, 0, building.maxZ]) {
      invariant(roofSurfaceYAt(triangles, x, z) !== null,
        `${label}: roof does not cover the building at (${x.toFixed(3)}, ${z.toFixed(3)})`);
    }
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

// v4: 치수 스윕과 fuzz 는 **두 지붕 유형 모두**를 지나야 한다. id 없는 fixture 는 항상 fallback
//   유형(기와)이므로, 종전 스윕만으로는 초가 지붕이 극단 치수에서 한 번도 검사되지 않았다(실측
//   2026-08-05 FAIL-first 4번: 이엉 평면 피복 회귀를 이 게이트가 놓쳤다). 유형별 프로브 ID 를
//   고정해 같은 치수를 두 유형으로 모두 통과시킨다.
const kindProbeId = {};
for (let probe = 0; probe < 64 && Object.keys(kindProbeId).length < 2; probe++) {
  const id = `roof-probe-${probe}`;
  const kind = sijeonRoofKind({ id });
  if (!kindProbeId[kind]) kindProbeId[kind] = id;
}
invariant(kindProbeId[SIJEON_ROOF_GIWA] && kindProbeId[SIJEON_ROOF_CHOGA],
  'could not find a probe id for each roof kind — the mix policy is degenerate');
const facadeVariants = [
  { suffix: 'bare', extra: {} },
  { suffix: SIJEON_ROOF_GIWA, extra: { id: kindProbeId[SIJEON_ROOF_GIWA] } },
  { suffix: SIJEON_ROOF_CHOGA, extra: { id: kindProbeId[SIJEON_ROOF_CHOGA] } },
];
const kindsExercised = new Set();

let facadeCases = 0;
for (const width of [4.4, 5.2, 6.2, 8, 12.5]) {
  for (const depth of [5.6, 6.4, 8.5, 11, 18]) {
    for (const variant of facadeVariants) {
      const label = `${width}x${depth}/${variant.suffix}`;
      const input = { w: width, d: depth, kind: SIJEON_KIND_SHOP, ...variant.extra };
      const facade = withoutGlobalRandom(
        () => planSijeonFacade({ ...input }),
        `facade:${label}`,
      );
      const repeat = withoutGlobalRandom(
        () => planSijeonFacade({ ...input }),
        `facade:${label}:repeat`,
      );
      invariant(stableJson(facade) === stableJson(repeat),
        `${label}: facade is not deterministic`);
      invariant(stableJson(JSON.parse(JSON.stringify(facade))) === stableJson(facade),
        `${label}: facade is not JSON-serializable`);
      assertFacade(facade, label);
      kindsExercised.add(facade.roof.kind);
      facadeCases++;
    }
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
  for (const variant of facadeVariants) {
    const label = `fuzz:${index}/${variant.suffix}`;
    const facade = withoutGlobalRandom(
      () => planSijeonFacade({ w: width, d: depth, ...variant.extra }),
      `facade:${label}`,
    );
    assertFacade(facade, label);
    kindsExercised.add(facade.roof.kind);
    facadeCases++;
  }
}
invariant(kindsExercised.has(SIJEON_ROOF_GIWA) && kindsExercised.has(SIJEON_ROOF_CHOGA),
  `dimension sweep did not exercise both roof kinds (${[...kindsExercised].join(',')})`);

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
// 버전 상수만 v4 로 추적한다(#54, 2026-08-05): v3 는 계획이 벽체까지 소유하게 된 변경, v4 는 지붕이
// 점포별 초가/기와 로프트 표면으로 바뀐 변경이다. 둘 다 소비자 계약 변경. 표식 단언은 유지·확장만.
{
  invariant(SIJEON_FACADE_SCHEMA_VERSION === 4, 'schema version must be 4');
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

// ── v4 지붕 유형 혼합 (#54, 2026-08-05) ─────────────────────────────────────────────────
// 사료는 행랑 지붕 형식을 확정하지 않는다(docs/sijeon.md §2) — 그래서 계약은 "혼합이 존재하고 한
// 유형으로 붕괴하지 않는다"이고, 특정 비율이 아니다. 임계는 실측 보정값이므로 대역으로 단언한다.
{
  invariant(Object.isFrozen(SIJEON_ROOF_MIX), 'roof mix policy must be immutable');
  invariant(SIJEON_ROOF_MIX.fallbackKind === SIJEON_ROOF_GIWA,
    'dimension-only fixtures must keep a deterministic fallback roof kind');
  // id 없는 fixture: 유형·지터 모두 결정론 기본값.
  const bare = planSijeonFacade({ w: 6.2, d: 8.5 });
  invariant(bare.roof.kind === SIJEON_ROOF_MIX.fallbackKind,
    'no-id fixture did not take the fallback roof kind');
  // R2: 벽 상단 대역이 유형별로 분리됐다(초가 처마가 기와 처마보다 항상 위 — FIX ② 완화).
  //   id 없는 fixture 는 지터 0 이므로 그 유형 대역의 상단값을 그대로 갖는다.
  invariant(bare.building.height === 2.86,
    `no-id fixture must keep the authored giwa band top (got ${bare.building.height})`);
  const chogaProbe = (() => {
    for (let probe = 0; probe < 64; probe++) {
      const id = `lap-probe-${probe}`;
      if (sijeonRoofKind({ id }) === SIJEON_ROOF_CHOGA) {
        return planSijeonFacade({ w: 6.2, d: 8.5, id });
      }
    }
    return null;
  })();
  invariant(chogaProbe, 'could not build a choga probe facade');
  // 유형 간 처마 라프 순서: 초가 처마 상단이 기와 처마 상단보다 확실히 위여야, 곡선 구간의 얕은
  //   겹침에서 기와가 이엉 아래로 들어가 "서로 뚫고 나온 귀" 가 되지 않는다.
  const giwaEaveMax = 2.86 + 0.15;
  const chogaEaveMin = 3.00 - 0.10 + 0.36;
  invariant(chogaEaveMin - giwaEaveMax >= 0.2 - 1e-9,
    `thatch eave band must clear the tile eave band by 0.2m`
    + ` (choga min ${chogaEaveMin.toFixed(3)} vs giwa max ${giwaEaveMax.toFixed(3)})`);
  invariant(chogaProbe.roofline.eaveTopY >= chogaEaveMin - 1e-9
      && bare.roofline.eaveTopY <= giwaEaveMax + 1e-9,
  `${'eave lap'}: measured eave tops left their type bands`);
  invariant(planSijeonFacade({ w: 6.2, d: 8.5 }).roof.kind === bare.roof.kind,
    'roof kind is not reproducible');

  // 네 개의 서로 다른 간선 fixture. 각 fixture 에서 두 유형이 모두 나오고, 풀 혼합비가 대역 안인가.
  const arterials = [
    { id: 'mix-a', level: 'daero', width: 10, pts: [{ x: -300, z: 0 }, { x: 300, z: 0 }] },
    { id: 'mix-b', level: 'daero', width: 12, pts: [{ x: -260, z: 40 }, { x: 260, z: 40 }] },
    { id: 'mix-c', level: 'daero', width: 8, pts: [{ x: 0, z: -280 }, { x: 0, z: 280 }] },
    { id: 'mix-d', level: 'daero', width: 14, pts: [{ x: -220, z: -60 }, { x: 220, z: 60 }] },
  ];
  const mixSite = { center: { x: 0, z: 0 }, bowlR: 400 };
  let pooledShops = 0;
  let pooledGiwa = 0;
  let maxRoofWidth = 0;
  for (const arterial of arterials) {
    const fixtureShops = withoutGlobalRandom(
      () => planSijeon({ roads: [arterial] }, mixSite).filter(isSijeonShop),
      `mix:${arterial.id}`,
    );
    invariant(fixtureShops.length >= 20,
      `${arterial.id}: mix fixture is too small (${fixtureShops.length})`);
    const kinds = fixtureShops.map((shop) => sijeonRoofKind(shop));
    const giwa = kinds.filter((kind) => kind === SIJEON_ROOF_GIWA).length;
    const choga = kinds.filter((kind) => kind === SIJEON_ROOF_CHOGA).length;
    invariant(giwa + choga === kinds.length, `${arterial.id}: unknown roof kind in the mix`);
    invariant(giwa > 0 && choga > 0,
      `${arterial.id}: roof mix collapsed to one type (giwa ${giwa} / choga ${choga})`);
    // 계획이 실제로 두 유형의 지붕 형상을 내놓는가(유형 라벨만 바뀌는 것이 아니다).
    for (const kind of [SIJEON_ROOF_GIWA, SIJEON_ROOF_CHOGA]) {
      const sample = fixtureShops.find((shop) => sijeonRoofKind(shop) === kind);
      const facade = planSijeonFacade(sample);
      invariant(facade.roof.kind === kind,
        `${arterial.id}: facade roof kind disagrees with sijeonRoofKind`);
      assertFacade(facade, `mix:${arterial.id}:${kind}`);
      maxRoofWidth = Math.max(maxRoofWidth, facade.roof.width);
    }
    pooledShops += kinds.length;
    pooledGiwa += giwa;
  }
  // 대역의 목적은 "한 유형으로 붕괴"와 극단 편중을 잡는 것이지 특정 비율을 고정하는 것이 아니다.
  //   [2026-08-05 R2 재핀] 채택 정책이 기와 우세로 바뀌었다(근거: sijeon-plan.js SIJEON_ROOF_MIX 주석
  //   — 후기 사진을 전기 관영 행랑의 대리지표로 쓴 R1 근거를 기각). 실측: 생산 hanyang 4시드 63.3%,
  //   여기 합성 간선 풀은 별도 세그먼트 키 집합이라 다르게 나온다. 둘을 모두 담는 대역을 쓴다.
  const share = pooledGiwa / pooledShops;
  invariant(share >= 0.40 && share <= 0.85,
    `pooled giwa share ${(share * 100).toFixed(1)}% left the product band 40–85%`
    + ` (${pooledGiwa}/${pooledShops})`);
  // 유형 변주가 지붕 폭을 키우므로 #218 블록 틈 단언의 상수도 실제 최대 지붕 폭을 써야 한다.
  invariant(SIJEON_PLACEMENT.pitch * 2 - maxRoofWidth > 4.5,
    `roof width ${maxRoofWidth.toFixed(3)} closed the product row break below 4.5m`);
  console.log(
    `check-sijeon-contract: roof mix PASS (pooled ${pooledGiwa}/${pooledShops} giwa`
    + ` = ${(share * 100).toFixed(1)}%, max roof width ${maxRoofWidth.toFixed(2)}m)`,
  );
}

