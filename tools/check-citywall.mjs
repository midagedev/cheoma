// 한양 성곽의 단일-contour 계약: 좌표계·사대문·world edge·도로 폭·식생 여유·지형 밀착을
// DOM/THREE 없이 검증한다. 넓은 wall-only seed sweep과 회귀 이력이 있는 production seed를 함께 둔다.
import { readFileSync } from 'node:fs';

import * as G from '../src/core/math/geom2.js';
import { makeSite } from '../src/village/site.js';
import { planVillage, GATE_FORECOURT_PLAN_DEPTH } from '../src/village/plan.js';
import { planGuardianTrees } from '../src/village/guardian-plan.js';
import { terrainMeshHeightAt, terrainWarpInner } from '../src/village/terrain-surface.js';
import {
  ROAD_SURFACE_MIN_JOIN_GAP,
  roadSurfaceUpArea,
  sampleRoadSurface,
} from '../src/village/road-surface.js';
import {
  CITY_GATE_MASONRY,
  cityGateForecourtPolygon,
  CITY_GATE_PAVILION,
  CITY_STONE_BOND,
  CITY_STONE_VALUES,
  CITY_WALL_COURSES,
  CITY_WALL_DIMENSIONS,
  CITY_WALL_MERLON,
  CITY_WALL_MIN_SITE_R,
  cityGateFootprint,
  cityStoneBondPlan,
  cityStoneTone,
  cityGateApproachFootprint,
  cityGateLocalPoint,
  cityGateMasonryProfile,
  cityGatePavilionProfile,
  cityGatePierTerrainProfile,
  cityGateStructureProfile,
  cityGateStreamClearance,
  cityGateTerrainProfile,
  cityWallAngleInAperture,
  cityWallAngleInGate,
  cityWallClearance,
  cityWallContainsPolygon,
  cityWallCourseProfile,
  cityWallMerlonLoophole,
  cityWallMerlonPlan,
  cityWallMerlonSpans,
  cityWallOutsidePolygon,
  cityWallSegmentCapProfile,
  cityWallSegmentFootprint,
  cityWallVegetationBlocked,
  normalOnCityWall,
  planCityWall,
  pointOnCityWall,
  sampleCityWallSegments,
  worldEdgeClearance,
  worldEdgeContainsPolygon,
} from '../src/village/citywall-contour.js';

const TAU = Math.PI * 2;
const EPS = 1e-6;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertGuardianClearance(plan, label, expectedCount) {
  const wall = plan.features?.cityWall;
  if (!wall) return 0;
  const guardians = planGuardianTrees(plan, plan.site, plan.seed);
  invariant(guardians.length === expectedCount,
    `${label}: expected ${expectedCount} collision-free guardian trees, got ${guardians.length}`);
  for (const [index, guardian] of guardians.entries()) {
    const radius = guardian.radius;
    invariant(!cityWallVegetationBlocked(wall, guardian, {
      corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
      gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
      gateApproachMargin: radius,
    }), `${label}: guardian ${index} canopy reaches wall/gate/approach`);
    invariant(worldEdgeClearance(plan.site.edge, guardian) >= radius - EPS,
      `${label}: guardian ${index} canopy left terrain`);
  }
  return guardians.length;
}

const near = (a, b, eps = EPS) => Math.abs(a - b) <= eps;
const pointNear = (a, b, eps = EPS) => G.dist(a, b) <= eps;
const angleDistance = (a, b) => {
  let d = Math.abs(a - b) % TAU;
  return d > Math.PI ? TAU - d : d;
};

function assertSimpleContour(spec, label) {
  const points = spec.radii.map((_, i) => pointOnCityWall(spec, i / spec.radii.length * TAU));
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      invariant(!G.segIntersect(a, b, c, d), `${label}: contour self-intersection ${i}/${j}`);
    }
  }
}

function assertGate(spec, site, gate, label) {
  const onWall = pointOnCityWall(spec, gate.angle);
  invariant(pointNear(onWall, gate), `${label}/${gate.name}: gate drifted from contour`);
  const normal = normalOnCityWall(spec, gate.angle);
  invariant(near(normal.x, gate.dirX) && near(normal.z, gate.dirZ), `${label}/${gate.name}: stale normal`);
  invariant(near(Math.hypot(gate.dirX, gate.dirZ), 1), `${label}/${gate.name}: non-unit normal`);
  invariant((gate.x - spec.cx) * gate.dirX + (gate.z - spec.cz) * gate.dirZ > 0,
    `${label}/${gate.name}: normal points inward`);
  invariant(cityWallAngleInGate(spec, gate.angle), `${label}/${gate.name}: opening misses gate center`);
  invariant(!cityWallAngleInGate(spec, gate.angle - gate.halfAngle), `${label}/${gate.name}: fuzzy opening start`);
  invariant(!cityWallAngleInGate(spec, gate.angle + gate.halfAngle), `${label}/${gate.name}: fuzzy opening end`);

  for (const point of cityGateFootprint(gate)) {
    invariant(worldEdgeClearance(site.edge, point) >= -EPS, `${label}/${gate.name}: footprint left terrain`);
  }
  if (site.R >= 250) {
    invariant(cityGateStreamClearance(gate, site) >= CITY_WALL_DIMENSIONS.gateStreamClearance - EPS,
      `${label}/${gate.name}: gate overlaps the stream bank`);
  }
  const structure = cityGateStructureProfile(gate, site);
  const denseRoad = cityGateTerrainProfile(gate, site, { extraWidth: 0, widthSamples: 17, depthSamples: 13 });
  invariant(structure.archBottomY <= denseRoad.min, `${label}/${gate.name}: floating passage mask`);
  invariant(structure.archTopY >= denseRoad.max
    + CITY_WALL_DIMENSIONS.gateArchClearance * gate.scale - EPS,
  `${label}/${gate.name}: road lacks arch clearance`);
  invariant(structure.baseTopY >= Math.max(denseRoad.max, ...structure.piers.map((pier) => pier.max))
    + CITY_WALL_DIMENSIONS.gateTerrainReveal * gate.scale - EPS,
  `${label}/${gate.name}: terrain covers gate deck`);
  let maxPierHeight = 0;
  for (const side of [-1, 1]) {
    const pier = cityGatePierTerrainProfile(gate, site, side);
    const bottomY = pier.min - CITY_WALL_DIMENSIONS.gateFoundationSink * gate.scale;
    maxPierHeight = Math.max(maxPierHeight, structure.baseTopY - bottomY);
    let denseMin = Infinity;
    for (let ix = 0; ix <= 24; ix++) for (let iz = 0; iz <= 24; iz++) {
      const localX = pier.centerX - pier.pierWidth * 0.5 + pier.pierWidth * ix / 24;
      const localZ = -pier.depth * 0.5 + pier.depth * iz / 24;
      const point = cityGateLocalPoint(gate, localX, localZ);
      denseMin = Math.min(denseMin, terrainMeshHeightAt(site, point.x, point.z));
    }
    invariant(bottomY <= denseMin + EPS, `${label}/${gate.name}: pier ${side} floats ${Number(bottomY - denseMin).toFixed(3)}m`);
  }
  invariant(maxPierHeight <= CITY_WALL_DIMENSIONS.gateMaxPierHeight + EPS,
    `${label}/${gate.name}: ${maxPierHeight.toFixed(2)}m cliff pier`);
  invariant(cityWallVegetationBlocked(spec, gate), `${label}/${gate.name}: vegetation reaches gate`);
  const masonry = assertGateMasonry(gate, site, structure, label);
  assertGatePavilion(gate, structure, masonry, label);
  const approach = CITY_WALL_DIMENSIONS.gateApproachLength * Math.max(0.6, gate.scale || 1);
  for (const sign of [-1, 1]) {
    const point = { x: gate.x + gate.dirX * approach * 0.9 * sign, z: gate.z + gate.dirZ * approach * 0.9 * sign };
    invariant(cityWallVegetationBlocked(spec, point), `${label}/${gate.name}: vegetation blocks approach`);
  }
}

// ── R3 성문 석축 격상 계약(#19 A) ────────────────────────────────────────────
// 홍예 아치·육축 배터·석재 2켜·중층 문루는 모두 순수 spec 에서 파생되고 렌더러는 그 값을 그대로
// 소비한다. 그래서 형태 판정을 브라우저 없이 여기서 못 박을 수 있다.
function assertGateMasonry(gate, site, structure, label) {
  const masonry = cityGateMasonryProfile(gate, site, structure);
  const scale = gate.scale || 1;
  const tag = `${label}/${gate.name}`;

  // (a) 홍예 개구 폭 / 육축 총폭 — 숭례문 실측 밴드.
  const band = CITY_GATE_MASONRY.archRatioBand;
  invariant(near(masonry.totalWidth, gate.width + masonry.pierWidth * 2, 1e-9),
    `${tag}: masonry total width drifted from the reserved gate footprint`);
  invariant(masonry.arch.ratio >= 0.18 - EPS && masonry.arch.ratio <= 0.22 + EPS,
    `${tag}: 홍예 ratio ${masonry.arch.ratio.toFixed(4)} left the 0.18~0.22 band`);
  invariant(near(masonry.arch.ratio, masonry.arch.openingWidth / masonry.totalWidth, 1e-9),
    `${tag}: arch ratio is not the rendered opening/total`);
  invariant(band > 0 && CITY_GATE_MASONRY.archRatio - band >= 0.18 - EPS
    && CITY_GATE_MASONRY.archRatio + band <= 0.22 + EPS,
  `${tag}: authored arch ratio band escapes 0.18~0.22`);

  // 실제 반원 홍예: 지름=개구 폭, 무지개 정점=상인방 하단(도로 유효고 계약), 홍예석 밑 수직 문협.
  const arch = masonry.arch;
  invariant(near(arch.radius, arch.openingWidth * 0.5, 1e-9), `${tag}: arch is not semicircular`);
  invariant(near(arch.crownY, structure.archTopY, 1e-9), `${tag}: arch crown left the clearance contract`);
  invariant(near(arch.springY, arch.crownY - arch.radius, 1e-9), `${tag}: spring line drifted`);
  invariant(arch.springY - arch.sillY >= CITY_GATE_MASONRY.jambMin - EPS,
    `${tag}: jamb ${Number(arch.springY - arch.sillY).toFixed(2)}m is shorter than the authored floor`);
  invariant(arch.intrados.length === CITY_GATE_MASONRY.archSegments + 1,
    `${tag}: intrados is not a ${CITY_GATE_MASONRY.archSegments}-segment low-poly arc`);
  invariant(near(arch.intrados[0].x, -arch.radius, 1e-9) && near(arch.intrados[0].y, arch.springY, 1e-9),
    `${tag}: intrados does not start on the spring line`);
  invariant(near(arch.intrados.at(-1).x, arch.radius, 1e-9)
    && near(arch.intrados.at(-1).y, arch.springY, 1e-9), `${tag}: intrados does not close on the spring line`);
  let crown = -Infinity;
  for (let i = 0; i < arch.intrados.length; i++) {
    const point = arch.intrados[i];
    invariant(near(Math.hypot(point.x, point.y - arch.springY), arch.radius, 1e-6),
      `${tag}: intrados point ${i} left the arch circle`);
    if (i > 0) invariant(point.x > arch.intrados[i - 1].x, `${tag}: intrados folds back at ${i}`);
    crown = Math.max(crown, point.y);
  }
  invariant(near(crown, arch.crownY, 1e-9), `${tag}: intrados never reaches the crown`);
  invariant(arch.spandrelTopY > arch.crownY && arch.spandrelTopY <= structure.baseTopY + EPS,
    `${tag}: spandrel does not sit between crown and deck`);

  // (c) 육축 배터: 상단 폭 < 하단 폭이고 기울기가 6~10% 밴드.
  const batter = masonry.batter;
  invariant(batter.slope >= 0.06 - EPS && batter.slope <= 0.10 + EPS,
    `${tag}: batter slope ${batter.slope} left the 6~10% band`);
  invariant(batter.inset > 0, `${tag}: masonry has no batter`);
  invariant(near(masonry.topWidth, masonry.totalWidth - 2 * batter.inset, 1e-9)
    && masonry.topWidth < masonry.totalWidth - EPS,
  `${tag}: battered top (${masonry.topWidth.toFixed(2)}m) is not narrower than the base (${masonry.totalWidth.toFixed(2)}m)`);
  invariant(masonry.topDepth < masonry.depth - EPS && masonry.topDepth > masonry.depth * 0.5,
    `${tag}: battered depth ${masonry.topDepth.toFixed(2)}m out of range`);
  invariant(masonry.topWidth > masonry.totalWidth * 0.7,
    `${tag}: batter over-narrows the masonry top`);
  invariant(masonry.cornice.y1 > masonry.cornice.y0
    && near(masonry.cornice.y1, structure.baseTopY, 1e-9),
  `${tag}: cornice course missing under the deck`);
  invariant(masonry.cornice.overhang > 0, `${tag}: cornice does not flare past the battered face`);

  // (d-1) 석재 위계: 대석 기단 켜가 노출고의 35~45%.
  const course = masonry.courseSplitY;
  const exposedBottom = masonry.groundY;
  const fraction = (course - exposedBottom) / (structure.baseTopY - exposedBottom);
  invariant(fraction >= 0.35 - EPS && fraction <= 0.45 + EPS,
    `${tag}: 대석 기단 켜 ${fraction.toFixed(3)} left the 0.35~0.45 band`);

  // 홍예를 좁히면 옛 통행 폭 일부가 석면이 된다. 그 새 footprint 도 떠 있으면 안 된다.
  for (const zone of masonry.zones) {
    invariant(zone.courses.length === 2, `${tag}: masonry zone lost its 2-course hierarchy`);
    invariant(zone.courses[0].key !== zone.courses[1].key, `${tag}: masonry courses share one material key`);
    invariant(zone.bottomY <= structure.piers[zone.index].min
      - CITY_WALL_DIMENSIONS.gateFoundationSink * scale + EPS,
    `${tag}: zone ${zone.side} rose above the planned pier foot`);
    let denseMin = Infinity;
    for (let ix = 0; ix <= 20; ix++) for (let iz = 0; iz <= 14; iz++) {
      const localX = zone.centerX - zone.width * 0.5 + zone.width * ix / 20;
      const localZ = -masonry.depth * 0.5 + masonry.depth * iz / 14;
      const point = cityGateLocalPoint(gate, localX, localZ);
      denseMin = Math.min(denseMin, terrainMeshHeightAt(site, point.x, point.z));
    }
    invariant(zone.bottomY <= denseMin + EPS,
      `${tag}: masonry zone ${zone.side} floats ${Number(zone.bottomY - denseMin).toFixed(3)}m`);
    const first = zone.courses[0], last = zone.courses.at(-1);
    invariant(near(first.y0, zone.bottomY, 1e-9) && near(last.y1, masonry.cornice.y0, 1e-9),
      `${tag}: masonry zone ${zone.side} courses do not span foot→cornice`);
    for (const [index, part] of zone.courses.entries()) {
      invariant(part.y1 > part.y0, `${tag}: zone ${zone.side} course ${index} is inverted`);
      if (index > 0) invariant(near(part.y0, zone.courses[index - 1].y1, 1e-9),
        `${tag}: zone ${zone.side} course seam split`);
      const bottomWidth = part.bottom.x1 - part.bottom.x0;
      const topWidth = part.top.x1 - part.top.x0;
      invariant(bottomWidth > 0 && topWidth > 0, `${tag}: zone ${zone.side} course degenerate`);
      invariant(topWidth <= bottomWidth + EPS, `${tag}: zone ${zone.side} course flares upward`);
      invariant(part.top.z1 - part.top.z0 <= part.bottom.z1 - part.bottom.z0 + EPS,
        `${tag}: zone ${zone.side} depth flares upward`);
      const innerX = zone.side > 0 ? part.bottom.x0 : part.bottom.x1;
      invariant(near(Math.abs(innerX), arch.openingWidth * 0.5, 1e-9),
        `${tag}: zone ${zone.side} inner face left the arch jamb`);
      // 통로 차단 금지: 석축은 홍예 개구 밖에만 존재한다(문 너머 지형·길이 보여야 한다).
      for (const rect of [part.bottom, part.top]) {
        for (const x of [rect.x0, rect.x1]) {
          invariant(Math.abs(x) >= arch.openingWidth * 0.5 - EPS && Math.sign(x) === zone.side,
            `${tag}: zone ${zone.side} masonry entered the 홍예 passage at x=${x.toFixed(3)}`);
        }
      }
      const outerFaceX = zone.side > 0 ? part.bottom.x1 : part.bottom.x0;
      invariant(Math.abs(outerFaceX) <= masonry.totalWidth * 0.5 + EPS,
        `${tag}: zone ${zone.side} outer face left the reserved footprint`);
      invariant(Math.abs(part.top.z0) <= masonry.depth * 0.5 + EPS
        && Math.abs(part.top.z1) <= masonry.depth * 0.5 + EPS,
      `${tag}: zone ${zone.side} depth left the reserved footprint`);
    }
  }
  invariant(masonry.zones.length === 2 && masonry.zones[0].side === -1 && masonry.zones[1].side === 1,
    `${tag}: masonry lost one of its two 육축 zones`);
  return masonry;
}

// (d-2) 중층 문루: 하층(벽체)·상층(체감)·지붕 2단 + 육축 상면 여장 링.
function assertGatePavilion(gate, structure, masonry, label) {
  const pavilion = cityGatePavilionProfile(gate, structure, masonry);
  const tag = `${label}/${gate.name}`;
  invariant(pavilion.storeys.length === 2, `${tag}: 문루 is not two storeys`);
  invariant(pavilion.roofs.length === 2, `${tag}: 문루 lacks its two roof tiers`);
  const [lower, upper] = pavilion.storeys;
  invariant(lower.tier === 'lower' && upper.tier === 'upper', `${tag}: storey tiers mislabelled`);
  invariant(lower.y0 >= structure.baseTopY - EPS, `${tag}: lower storey sinks into the masonry`);
  invariant(near(lower.y1, lower.y0 + lower.height, 1e-9), `${tag}: lower storey height mismatch`);
  invariant(upper.y0 >= lower.y1 - EPS, `${tag}: storey y-bands overlap`);
  invariant(upper.y1 > upper.y0, `${tag}: upper storey is flat`);
  // 상층 체감은 **깊이 전용**이고 정면 폭은 하층과 같다 — 재핀 2026-08-04 (#54 G8).
  //   구 단언은 폭·깊이를 함께 upperRatio 로 줄이라고 못 박았으나, 구한말 성문 사진 실측이
  //   상층 정면이 하층과 같은 폭임을 보여준다(숭례문 상·하층 정면 모두 5칸; 실측 상층 처마 폭 /
  //   하층 처마 폭 = 0.96 인데 폭까지 0.8 로 줄이면 0.815 가 되어 상층이 축소 복제로 읽힌다).
  //   폭 동일 + 깊이 체감이면 처마 깊이 차(upperEave < lowerEave)만으로 0.98 이 나온다.
  invariant(upper.width === lower.width,
    `${tag}: 상층 정면 폭 ${upper.width} ≠ 하층 ${lower.width} — 상층이 축소 복제로 읽힌다`);
  invariant(near(upper.depth, lower.depth * CITY_GATE_PAVILION.upperRatio, 1e-9),
    `${tag}: upper storey depth does not step in by ${CITY_GATE_PAVILION.upperRatio}`);
  invariant(CITY_GATE_PAVILION.upperRatio >= 0.75 && CITY_GATE_PAVILION.upperRatio <= 0.85,
    `${tag}: authored upper-storey depth taper left the ~0.8 band`);
  invariant(upper.columns === lower.columns,
    `${tag}: 상·하층 기둥 수가 어긋났다 — 같은 정면 폭이면 주칸 격자가 정렬해야 한다`);
  invariant(lower.columns >= 3 && lower.panels > 0, `${tag}: lower storey has no column/panel wall`);
  invariant(upper.rail > 0, `${tag}: upper storey lacks its balustrade`);
  const [lowerRoof, upperRoof] = pavilion.roofs;
  invariant(lowerRoof.tier === 'lower' && upperRoof.tier === 'upper', `${tag}: roof tiers mislabelled`);
  invariant(near(lowerRoof.y, lower.y1, 1e-9), `${tag}: 하층 차양 지붕 detached from its eave line`);
  invariant(near(upperRoof.y, upper.y1, 1e-9), `${tag}: 상층 본지붕 detached from its eave line`);
  invariant(upperRoof.y > lowerRoof.y + 1, `${tag}: roof tiers collapse into one`);
  invariant(lowerRoof.width > lower.width && lowerRoof.depth > lower.depth,
    `${tag}: 하층 지붕 does not overhang its storey`);
  invariant(upperRoof.width < lowerRoof.width && upperRoof.height > 0,
    `${tag}: 상층 지붕 is not the smaller crowning tier`);

  // 육축 둘레 여장 링: 문루가 링 안쪽에 앉고 성벽 여장과 같은 높이를 쓴다.
  const parapet = pavilion.parapet;
  invariant(near(parapet.height, CITY_WALL_DIMENSIONS.capHeight, 1e-9),
    `${tag}: gate parapet height breaks continuity with the wall 여장`);
  invariant(parapet.thickness > 0 && parapet.sides.length === 4, `${tag}: parapet ring is not closed`);
  invariant(lower.width <= parapet.halfWidth * 2 - parapet.thickness * 2 + EPS
    && lower.depth <= parapet.halfDepth * 2 - parapet.thickness * 2 + EPS,
  `${tag}: 문루 overruns its parapet ring`);
  for (const side of parapet.sides) {
    invariant(side.length > 0, `${tag}: parapet side ${side.axis}${side.sign} is empty`);
    const spans = cityWallMerlonSpans(side.length);
    invariant(spans.count > 0, `${tag}: parapet side ${side.axis}${side.sign} has no merlon`);
  }
  assertGateBrackets(pavilion, tag);
  assertGateProportion(pavilion, masonry, tag);
  return pavilion;
}

// ── 문루 비례 계약(#54 G8, 2026-08-04) ───────────────────────────────────────
// 사용자 판정: "성문의 형태(특히 2단 지붕의 비율)의 갭이 크다". 원인은 문루가 육축 폭의 0.6 이라
// "높은 석축 위 작은 정자"로 읽힌 것이었다. 구한말 성문 사진 픽셀 실측(사진 2장 교차,
// docs/joseon-city.md §성문의 홍예 4.6m 로 절대 환산 — 그 환산이 총높이 약 20m 를 재현해 계측기
// 자체가 교차 검증된다)이 준 목표는 아래 두 축이고, 둘 다 지형과 무관한 순수 저작 비례다.
//   · 문루 몸체 폭 / 육축 상면 폭 : 사진 ≈1.00 (기둥선이 육축 끝에 선다)
//   · 하층 처마 폭 / 육축 총폭   : 사진 1.18~1.23 (처마가 육축 밖으로 나간다)
// 제품은 여장 링 두께(성벽 두께×0.7 = 1.82m)가 좌우로 물러나야 해서 몸체가 육축 상면의 1.00 에
// 닿을 수 없다 — 그래서 하한은 실측이 아니라 **링 제약 아래의 달성 가능 프런티어**다.
function assertGateProportion(pavilion, masonry, tag) {
  const [lower] = pavilion.storeys;
  const [lowerRoof] = pavilion.roofs;
  const bodyOverTop = lower.width / masonry.topWidth;
  const roofOverMasonry = lowerRoof.width / masonry.totalWidth;
  // 몸체는 여장 링을 뺀 육축 상면을 거의 다 쓴다. 0.86 아래면 좌우 날개가 다시 벌어져 문루가
  // 육축 위에 얹힌 작은 정자로 읽힌다(구 저작 0.60~0.64 가 정확히 그 상태였다).
  invariant(bodyOverTop >= 0.86,
    `${tag}: 문루 몸체/육축 상면 폭 ${bodyOverTop.toFixed(3)} < 0.86 — 좌우 여장 날개가 벌어져 `
    + '"석축 위 작은 정자"로 되돌아갔다(사진 실측 ≈1.00)');
  // 처마는 육축 **밖으로** 나가야 한다. 1.0 이 그 기하학적 문턱이고, 상한은 처마가 육축 아래
  // 성벽 여장까지 덮어 성가퀴 연속을 지우는 것을 막는다.
  invariant(roofOverMasonry >= 1.0 && roofOverMasonry <= 1.30,
    `${tag}: 하층 처마 폭/육축 총폭 ${roofOverMasonry.toFixed(3)} — 1.0 밑이면 처마가 육축 안에 `
    + '갇히고(구 저작 0.70~0.75) 1.30 위면 육축 좌우 성벽 여장까지 덮는다(사진 실측 1.18~1.23)');
  return { tag, bodyOverTop, roofOverMasonry };
}

// ── 다포계 공포대 계약(#23 R3-①) ─────────────────────────────────────────────
// 성문 문루는 다포계다. 예전 구현은 창방·평방 두 켜 + 기둥머리 소로뿐이어서 처마 밑에 받치는 것이
// 없었고, 구한말 성문 사진 대비 R3 비전이 심각도 1위로 꼽았다. 여기서 못 박는 것은 "포가 몇 개
// 보이는가"가 아니라 **처마·기둥·출목이 서로 정합한가**다 — 그래서 브라우저 없이 판정된다.
function assertGateBrackets(pavilion, tag) {
  const P = CITY_GATE_PAVILION;
  const [lower, upper] = pavilion.storeys;
  for (const [i, storey] of pavilion.storeys.entries()) {
    const B = storey.bracket;
    const label = `${tag}/${storey.tier}`;
    invariant(B, `${label}: 공포대 spec missing — 문루가 창방·평방 힌트 밴드로 되돌아갔다`);
    invariant(B.tiers >= 2, `${label}: ${B.tiers} 출목 — 다포로 읽히려면 외출목 2단 이상이다`);
    invariant(B.inter >= 1, `${label}: 간포 ${B.inter} — 기둥 위 주포만이면 주심포이지 다포가 아니다`);

    // ① 공포대는 층 y밴드의 **위**를 쓰고 기둥이 그만큼 짧아진다. 그래서 지붕 y·상층 바닥이
    //    이 격상에 흔들리지 않는다(밴드 상단 = 층 상단 = 지붕 처마선, 부동소수 오차 0).
    invariant(B.y1 === storey.y1,
      `${label}: 공포대 top ${B.y1} ≠ storey top ${storey.y1} — 지붕 y 가 밀린다`);
    invariant(near(B.y0 + B.height, storey.y1, 1e-9),
      `${label}: 공포대 밑면+높이가 층 상단과 어긋난다 (${B.y0 + B.height} vs ${storey.y1})`);
    invariant(near(B.height, storey.height * P.bracketBandRatio, 1e-9),
      `${label}: 공포대 높이가 저작 비율을 벗어났다`);
    invariant(B.height / storey.height >= 0.20 && B.height / storey.height <= 0.32,
      `${label}: 공포대/층 높이 ${(B.height / storey.height).toFixed(3)} — 0.20~0.32 밖이면 `
      + '기둥이 사라지거나(과대) 힌트 밴드로 되돌아간다(과소)');
    const columnHeight = storey.height - B.height;
    invariant(columnHeight > B.height,
      `${label}: 기둥 ${columnHeight.toFixed(2)}m 가 공포대 ${B.height.toFixed(2)}m 보다 낮다`);

    // ② 포 배치: 주포는 기둥 중심에 **정확히** 얹히고, 간포는 주칸 등분이라 간격이 완전 균등하다.
    const mains = B.posts.x.filter((post) => post.main).map((post) => post.at);
    invariant(mains.length === storey.columns && storey.columnX.length === storey.columns,
      `${label}: 주포 ${mains.length} vs 기둥 ${storey.columns}`);
    for (const [k, at] of mains.entries()) {
      invariant(at === storey.columnX[k], `${label}: 주포 ${k} 가 기둥에서 어긋났다`);
    }
    invariant(B.posts.x.length === storey.columns + B.inter * (storey.columns - 1),
      `${label}: 포 수가 주칸 등분과 맞지 않는다`);
    const gaps = B.posts.x.slice(1).map((post, k) => post.at - B.posts.x[k].at);
    const spread = Math.max(...gaps) - Math.min(...gaps);
    invariant(spread <= 1e-9, `${label}: 포 간격 불균등 ${spread}`);
    const spacing = gaps[0];
    invariant(B.judu.width / spacing >= 0.30 && B.judu.width / spacing <= 0.55,
      `${label}: 주두폭/포간격 ${(B.judu.width / spacing).toFixed(3)} — 0.30 밑이면 포벽만 보이고 `
      + '0.55 위면 포가 붙어 한 덩이 띠가 된다(포열 리듬 소실)');
    invariant(B.posts.z.every((post) => !post.main),
      `${label}: 좌·우 면 포에 코너가 남았다 — 앞·뒤 면 포와 부재가 겹친다`);

    // ③ 출목: 단마다 단조 증가하고 최외 단이 외목도리 자리다.
    invariant(B.steps.length === B.tiers, `${label}: 출목 단 수 불일치`);
    for (let k = 1; k < B.steps.length; k++) {
      invariant(B.steps[k].out > B.steps[k - 1].out,
        `${label}: 출목 ${k} 가 앞 단보다 안으로 들어갔다 — 계단형 돌출이 사라진다`);
      invariant(B.steps[k].y > B.steps[k - 1].y, `${label}: 출목 ${k} 가 위로 오르지 않는다`);
    }
    invariant(near(B.steps[B.steps.length - 1].out, B.tipOut, 1e-9)
      && near(B.purlin.out, B.tipOut, 1e-9),
    `${label}: 외목도리가 최외 출목 위에 없다`);
    // 살미 → 소로 → 행공 적층 순서(부재가 서로를 받친다). 순서가 뒤집히면 소로가 공중에 뜬다.
    invariant(B.salmi.base < B.soro.base && B.soro.base < B.haenggong.base,
      `${label}: 살미·소로·행공 적층 순서가 뒤집혔다`);
    invariant(B.haenggong.base + B.haenggong.height <= 1.10,
      `${label}: 행공이 다음 출목 단을 넘어간다`);
    // 수평 런은 코너 기둥 머리를 덮을 만큼 길다(짧으면 코너에 배경이 보이는 슬리버가 남는다).
    for (const [name, run] of [
      ['창방', B.changbang], ['평방', B.pyeongbang], ['외목도리', B.purlin],
      ...(B.infill ? [['포벽', B.infill]] : []),
      ...B.steps.map((step) => [`행공${step.index}`, step]),
    ]) {
      invariant(run.grow >= storey.columnRadius - 1e-12,
        `${label}: ${name} 런 여장 ${run.grow} < 기둥 반경 ${storey.columnRadius}`);
    }

    // ④ 처마 정합: 처마는 외목도리 **밖으로** 캔틸레버해야 하고, 그 여장이 출목 총거리와 같은 급이다
    //    (서까래가 외목도리를 지나 출목의 한두 배만큼 더 나간다).
    //    상한 재핀 2026-08-04 (#54 G8): 1.6 → 2.15. 구 상한은 문루가 육축의 0.6 폭이던 시절의
    //    처마(1.9m)에서 나온 값이고 측정된 계약이 아니었다. 사진 실측
    //    (refs/hanyang-old/sungnyemun-1900s.jpg, 홍예 4.6m 환산 11.7px/m)에서 하층 처마는 기둥
    //    중심선 밖 ≈2.87m, 공포대 최외 출목은 ≈1.0m 이므로 실물 캔틸레버/출목 ≈ 1.87 이다 —
    //    즉 구 상한 1.6 이 실물을 배제하고 있었다. 하한 0.7 은 그대로 둔다(처마가 공포에 붙는 것을
    //    막는 쪽은 반증되지 않았다). 새 상한은 실측 1.87 위로 상층 여유만 남긴 값이다.
    const roof = pavilion.roofs[i];
    const eave = (roof.width - storey.width) / 2;
    invariant(near((roof.depth - storey.depth) / 2, eave, 1e-9),
      `${label}: 처마가 방향별로 다르다`);
    invariant(eave > B.purlin.out,
      `${label}: 처마 ${eave.toFixed(2)}m 가 외목도리 ${B.purlin.out.toFixed(2)}m 밖으로 나가지 않는다`);
    const cantilever = (eave - B.purlin.out) / B.purlin.out;
    invariant(cantilever >= 0.7 && cantilever <= 2.15,
      `${label}: 외목도리 밖 캔틸레버/출목 ${cantilever.toFixed(3)} — 0.7~2.15 밖이면 처마와 공포가 `
      + '서로 다른 건물의 비례다(사진 실측 1.87)');
    // ⑤ 지붕면이 공포대를 관통하지 않는다. buildGateRoof 는 처마를 roof.y + height*0.20 에 두고
    //    중앙만 height*0.06 처지므로, 최저점조차 밴드 상단(=roof.y) 위여야 한다.
    const eaveLow = roof.height * 0.20 - roof.height * 0.06;
    invariant(eaveLow > 0,
      `${label}: 지붕 처마 최저점이 공포대 상단을 파고든다 (${eaveLow.toFixed(3)}m)`);
  }

  // ⑥ 상층 위계: 포 밀도가 하층보다 낮아지면 위계가 뒤집힌다(출목·단청 rank 는 별 계약).
  invariant(upper.bracket.inter >= lower.bracket.inter,
    `${tag}: 상층 간포 ${upper.bracket.inter} < 하층 ${lower.bracket.inter} — 위계 역전`);
  return assertPavilionFacadeClosure(pavilion, tag);
}

// ── 하층 파사드 폐합(#23 R3-① 후속) ─────────────────────────────────────────
// 공포대가 층 y밴드의 위를 쓰면서 하층 벽체 상단이 내려갔고, 그 결과 판벽 위·포열 사이로 배경
// 하늘이 관통하는 가로 슬릿이 생겼다(비전 계측 2026-08-04: forecourt-day 1440×900 y=505–509 행의
// 19~27% 가 순수 하늘색, y=488–493 은 행당 26~56px). 다포계 하층은 포벽이 있는 쪽이 고증상 맞고
// 상층은 개방 정자라 포 사이 하늘이 정당하다 — 그래서 계약은 "하층 폐합 + 상층 개방"이다.
//
// 판정 방법: 파사드를 **수평 레이로 훑는다.** 부재를 파사드 평면에 투영해 (가로 구간 × y구간)
// 사각형으로 모으고, y 브레이크포인트 사이 구간마다 가로 커버리지를 정확히 잰다(구간 안에서는
// 커버리지가 상수이므로 표본이 아니라 해석이다). 렌더러가 그리는 것과 같은 수를 보게 하려고
// 판벽 폭·기둥 반경·런 여장(grow)은 모두 순수 spec 에서 가져온다.
//   모델은 의도적으로 **보수적**이다: 그 면과 평행한 부재만 센다. 직교면 런·코너 포도 실제로는
//   레이를 막지만(코너에서 미터 이음), 그것까지 세면 렌더러 로컬 상수(판벽 두께·인셋)를 모델에
//   복제해야 한다. 덜 세는 쪽은 통과를 조작할 수 없으므로 계약이 약해지지 않는다.
function facadeSpans(storey, axis) {
  const half = axis === 'x' ? storey.width * 0.5 : storey.depth * 0.5;
  const other = axis === 'x' ? storey.depth * 0.5 : storey.width * 0.5;
  const r = storey.columnRadius;
  const B = storey.bracket;
  const colH = storey.height - B.height;
  const rects = [];
  const add = (a, b, y0, y1, kind) => {
    if (b > a && y1 > y0) rects.push({ a, b, y0, y1, kind });
  };
  // 기둥: x면은 주칸 격자 그대로, z면(측면)은 코너 두 개만 보인다.
  const columnAt = axis === 'x' ? storey.columnX : [-half, half];
  for (const at of columnAt) add(at - r, at + r, storey.y0, storey.y0 + colH, 'column');
  // 판벽: 기둥 사이를 정확히 채운다(렌더러와 같은 span<=0.1 스킵 조건까지 모사한다).
  if (storey.panel) {
    if (axis === 'x') {
      for (let i = 0; i < storey.columnX.length - 1; i++) {
        const span = storey.columnX[i + 1] - storey.columnX[i] - r * 2;
        if (span <= 0.1) continue;
        const mid = (storey.columnX[i] + storey.columnX[i + 1]) * 0.5;
        add(mid - span * 0.5, mid + span * 0.5, storey.panel.y0, storey.panel.y1, 'panel');
      }
    } else {
      const span = half * 2 - r * 2;
      if (span > 0.1) add(-span * 0.5, span * 0.5, storey.panel.y0, storey.panel.y1, 'panel');
    }
  }
  // 수평 런: 창방·평방·(하층)포벽·행공·외목도리. grow 만큼 면 방향으로 길어진다.
  const runs = [
    { y: B.changbang.y, h: B.changbang.height, grow: B.changbang.grow, kind: 'changbang' },
    { y: B.pyeongbang.y, h: B.pyeongbang.height, grow: B.pyeongbang.grow, kind: 'pyeongbang' },
  ];
  if (B.infill) {
    runs.push({ y: B.infill.y, h: B.infill.height, grow: B.infill.grow, kind: 'infill' });
  }
  for (const step of B.steps) {
    runs.push({
      y: step.y + step.height * B.haenggong.base, h: step.height * B.haenggong.height,
      grow: step.grow, kind: 'haenggong',
    });
  }
  runs.push({ y: B.purlin.y, h: B.purlin.height, grow: B.purlin.grow, kind: 'purlin' });
  for (const run of runs) add(-half - run.grow, half + run.grow, run.y, run.y + run.h, run.kind);
  // 포 유닛: 주두 + 출목별 살미·소로. x면 포는 posts.x, z면 포는 posts.z 를 쓴다.
  const posts = axis === 'x' ? B.posts.x : B.posts.z;
  for (const post of posts) {
    add(post.at - B.judu.width * 0.5, post.at + B.judu.width * 0.5,
      B.judu.y, B.judu.y + B.judu.height, 'judu');
    for (const step of B.steps) {
      const armH = step.height * B.salmi.height;
      const cy = step.y + step.height * B.salmi.base;
      add(post.at - B.arm * 0.5, post.at + B.arm * 0.5, cy, cy + armH, 'salmi');
      const sy = step.y + step.height * B.soro.base;
      add(post.at - B.soro.width * 0.5, post.at + B.soro.width * 0.5,
        sy, sy + step.height * B.soro.height, 'soro');
    }
  }
  return { rects, limit: half + r, other };
}

// 한 y구간의 가로 커버리지: 파사드 실루엣 폭(코너 기둥 바깥면까지) 안에서 불투과 구간의 합.
function facadeCoverageAt(model, y) {
  const spans = model.rects
    .filter((rect) => rect.y0 <= y && y <= rect.y1)
    .map((rect) => [Math.max(rect.a, -model.limit), Math.min(rect.b, model.limit)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let covered = 0, cursor = -model.limit;
  for (const [a, b] of spans) {
    if (b <= cursor) continue;
    covered += b - Math.max(a, cursor);
    cursor = b;
  }
  return covered / (model.limit * 2);
}

function facadeCoverageProfile(storey, axis) {
  const model = facadeSpans(storey, axis);
  const top = storey.bracket.y1;
  const edges = new Set([storey.y0, top]);
  for (const rect of model.rects) {
    for (const y of [rect.y0, rect.y1]) if (y > storey.y0 && y < top) edges.add(y);
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const y0 = sorted[i], y1 = sorted[i + 1];
    if (y1 - y0 < 1e-9) continue;
    bands.push({ y0, y1, coverage: facadeCoverageAt(model, (y0 + y1) * 0.5) });
  }
  let min = { coverage: Infinity };
  let openHeight = 0;
  for (const band of bands) {
    if (band.coverage < min.coverage) min = band;
    if (band.coverage < 1 - 1e-9) openHeight += band.y1 - band.y0;
  }
  return { bands, min, openHeight, limit: model.limit };
}

function assertPavilionFacadeClosure(pavilion, tag) {
  const rows = [];
  for (const storey of pavilion.storeys) {
    for (const axis of ['x', 'z']) {
      const profile = facadeCoverageProfile(storey, axis);
      const label = `${tag}/${storey.tier}/${axis}면`;
      rows.push({ tier: storey.tier, axis, ...profile });
      if (storey.panel) {
        // 하층: 데크에서 처마선까지 어느 높이에서도 배경이 보이지 않는다(포벽 포함 커버리지 100%).
        invariant(profile.min.coverage >= 1 - 1e-9,
          `${label}: 파사드 커버리지 ${(profile.min.coverage * 100).toFixed(1)}% `
          + `(y ${profile.min.y0?.toFixed(3)}~${profile.min.y1?.toFixed(3)}, 개방 총높이 `
          + `${profile.openHeight.toFixed(3)}m) — 하층 공포대 아래로 배경 하늘이 관통하는 `
          + '가로 슬릿이다. 포벽(bracket.infill)·판벽 상단(storey.panel)을 확인하라');
        invariant(profile.openHeight === 0, `${label}: 개방 구간 ${profile.openHeight}m 잔존`);
      } else {
        // 상층은 개방 정자다 — 포 사이가 다 막히면 누각이 벽체 상자가 된다.
        const stackY0 = storey.bracket.y0
          + storey.bracket.changbang.height + storey.bracket.pyeongbang.height;
        const openInStack = profile.bands.some((band) => band.coverage < 1 - 1e-9
          && band.y0 >= stackY0 - 1e-9);
        invariant(openInStack, `${label}: 상층 포열 구간이 폐합됐다 — 개방 정자가 아니다`);
        invariant(profile.openHeight > 0, `${label}: 상층 파사드에 개방 구간이 없다`);
      }
    }
  }
  return rows;
}

// ── R3 2라운드: 근경 표면 계약 ────────────────────────────────────────────────
// 비전 판정에서 육축이 성벽과 다른 자산으로 보인 원인은 색이 아니라 노멀이었다(성벽은 정점 공유
// 프리즘의 스무딩으로 수직면이 위로 기운 노멀을 갖고, 육축은 면별 플랫 노멀). 그래서 이 라운드의
// 계약은 ① 석재 위계를 재질이 아니라 **하나의 화강암 값 테이블**로만 두고, ② 줄눈·총안 슬릿을
// 순수 spec 으로 확정하고, ③ 렌더러가 flat shading + vertexColors 로 그것을 소비하도록 못 박는다.
function assertStoneValues(label) {
  const V = CITY_STONE_VALUES;
  const stone = V.stoneKeys.map((key) => {
    const value = V[key];
    invariant(Number.isFinite(value) && value > 0, `${label}: stone value ${key} missing`);
    return value;
  });
  invariant(stone.length >= 4, `${label}: stone hierarchy collapsed`);
  const span = Math.max(...stone) / Math.min(...stone);
  invariant(span <= 1.10 + EPS,
    `${label}: stone value hierarchy spans ${((span - 1) * 100).toFixed(1)}% — 명도 차이는 10% 이내`);
  invariant(span >= 1.02, `${label}: stone hierarchy has no readable value difference`);
  // 성벽과 육축이 같은 키를 쓰므로 두 자산의 톤은 구성상 동일하다(별 톤 표류 불가).
  invariant(V.body === 1, `${label}: body value must anchor the granite palette at 1`);
  invariant(V.base < V.body && V.parapet < V.body && V.cornice > V.body,
    `${label}: 대석/여장/코니스 위계가 뒤집혔다`);
  // 그늘 축은 돌 위계와 분리되고, 입구 쪽이 밝아 통로 반대편이 읽힌다.
  invariant(V.shadeDeep < 0.5 && V.shadeMouth > V.shadeDeep + 0.15,
    `${label}: 홍예 내부 그라디언트가 입구를 밝히지 못한다`);
  invariant(V.shadeMouth < Math.min(...stone),
    `${label}: 통로 그늘이 석면보다 밝다`);
  invariant(V.loophole < 0.5, `${label}: 총안 인셋이 어둡지 않다`);
}

// (3) 석재 분절(줄눈): 1m급 방형 블록이 면을 정확히 타일링하고 켜마다 통줄눈을 피한다.
function assertBondPlan(label) {
  for (const [width, height] of [[14.8, 9.6], [8.5, 12.4], [2.8, 2.16], [1.4, 1.1], [35, 0.42]]) {
    const plan = cityStoneBondPlan(width, height);
    invariant(plan.courses.length === plan.rows && plan.rows >= 1,
      `${label}: bond plan row count mismatch (${width}×${height})`);
    invariant(plan.blockWidth >= CITY_STONE_BOND.blockBand[0] - EPS
      && plan.blockWidth <= CITY_STONE_BOND.blockBand[1] + EPS,
    `${label}: block width ${plan.blockWidth.toFixed(3)}m left the band (${width}×${height})`);
    invariant(plan.blockHeight > 0 && plan.blockHeight <= CITY_STONE_BOND.blockBand[1] + EPS,
      `${label}: block height ${plan.blockHeight.toFixed(3)}m too tall (${width}×${height})`);
    let previousStarts = null;
    for (const [index, course] of plan.courses.entries()) {
      invariant(near(course.v0, index / plan.rows, 1e-9) && near(course.v1, (index + 1) / plan.rows, 1e-9),
        `${label}: course ${index} is not an even band`);
      invariant(course.spans.length >= 1, `${label}: course ${index} has no block`);
      invariant(near(course.spans[0].u0, 0, 1e-9) && near(course.spans.at(-1).u1, 1, 1e-9),
        `${label}: course ${index} does not span the face`);
      for (let s = 1; s < course.spans.length; s++) {
        invariant(near(course.spans[s].u0, course.spans[s - 1].u1, 1e-9),
          `${label}: course ${index} block seam split`);
      }
      // 통줄눈(모든 켜에서 세로 줄눈이 일치) 금지 — 켜마다 반 블록 어긋난 막힌줄눈.
      const starts = course.spans.map((span) => span.u0.toFixed(6)).join(',');
      if (previousStarts && course.spans.length > 1) {
        invariant(starts !== previousStarts, `${label}: course ${index} repeats the stack bond`);
      }
      previousStarts = starts;
    }
    // 결정론: 같은 인자 → 같은 계획, 같은 톤.
    const again = cityStoneBondPlan(width, height);
    invariant(JSON.stringify(plan) === JSON.stringify(again), `${label}: bond plan is not deterministic`);
  }
  const spread = CITY_STONE_BOND.toneSpread;
  invariant(spread > 0 && spread <= 0.08, `${label}: block tone spread ${spread} out of range`);
  let min = Infinity, max = -Infinity;
  for (let seed = 0; seed < 8; seed++) {
    for (let i = 0; i < 40; i++) for (let j = 0; j < 12; j++) {
      const tone = cityStoneTone(seed, i, j);
      min = Math.min(min, tone); max = Math.max(max, tone);
      invariant(tone === cityStoneTone(seed, i, j), `${label}: stone tone is not pure`);
    }
  }
  invariant(min >= 1 - spread - EPS && max <= 1 + spread + EPS,
    `${label}: block tone left its spread (${min.toFixed(3)}~${max.toFixed(3)})`);
  invariant(max - min > spread, `${label}: block tone barely varies — 줄눈이 읽히지 않는다`);
  invariant(cityStoneTone(1, 3, 4) !== cityStoneTone(2, 3, 4), `${label}: block tone ignores the seed`);
}

// (6) 총안 리듬: 정사각 아이콘이 아니라 가로 슬릿이고, 간격이 벌어지며, 시드 파생으로 불규칙하다.
function assertMerlonSlits(label) {
  const M = CITY_WALL_MERLON;
  invariant(M.loopholeWidth / M.loopholeHeight >= 2.4,
    `${label}: 총안 aspect ${(M.loopholeWidth / M.loopholeHeight).toFixed(2)} is not a 가로 슬릿`);
  invariant(M.loopholeKeep > 0.4 && M.loopholeKeep < 0.75,
    `${label}: 총안 keep ratio ${M.loopholeKeep} leaves no rhythm`);
  invariant(M.loopholeJitter > 0 && M.loopholeJitter <= 0.12,
    `${label}: 총안 jitter ${M.loopholeJitter} out of range`);
  const sample = (seed) => {
    let kept = 0, total = 0;
    const heights = new Set();
    for (let run = 0; run < 4; run++) {
      for (let index = 0; index < 200; index++) {
        total++;
        const hole = cityWallMerlonLoophole(seed, run, index);
        if (!hole) continue;
        kept++;
        invariant(hole.width / hole.height >= 2.4, `${label}: rendered 총안 is not a slit`);
        invariant(hole.bottom > 0 && hole.bottom + hole.height < CITY_WALL_DIMENSIONS.capHeight,
          `${label}: 총안 left the 타 face`);
        heights.add(hole.bottom.toFixed(4));
      }
    }
    return { ratio: kept / total, variety: heights.size };
  };
  const a = sample(7);
  invariant(a.ratio > 0.4 && a.ratio < 0.75,
    `${label}: 총안 density ${a.ratio.toFixed(3)} left the band`);
  invariant(a.variety >= 3, `${label}: 총안 height never varies`);
  const b = sample(8);
  invariant(Math.abs(a.ratio - b.ratio) < 0.2, `${label}: 총안 density swings with the seed`);
  invariant(JSON.stringify(cityWallMerlonLoophole(7, 1, 5)) === JSON.stringify(cityWallMerlonLoophole(7, 1, 5)),
    `${label}: 총안 is not pure`);
  let differs = false;
  for (let index = 0; index < 40; index++) {
    if (JSON.stringify(cityWallMerlonLoophole(7, 0, index)) !== JSON.stringify(cityWallMerlonLoophole(9, 0, index))) {
      differs = true; break;
    }
  }
  invariant(differs, `${label}: 총안 pattern ignores the wall seed`);
}

// (b) 여장 톱니: 연속 프리즘이 아니라 타/타구 반복이고, 피치가 밴드 안이며, 총안이 붙는다.
function assertMerlonPattern(label) {
  // 25.3m 이상이면 타 정수배가 항상 두 밴드를 함께 만족한다(성벽 run 은 전부 이 구간).
  for (const runLength of [6.4, 25.4, 40, 137.5, 411.31, 2740]) {
    const plan = cityWallMerlonSpans(runLength);
    invariant(plan.count > 0, `${label}: merlon run ${runLength} produced no 타`);
    invariant(!plan.degenerate, `${label}: merlon run ${runLength} degenerated`);
    invariant(plan.merlonLength >= 2.8 - EPS && plan.merlonLength <= 3.2 + EPS,
      `${label}: 타 길이 ${plan.merlonLength.toFixed(3)}m left the 2.8~3.2m band`);
    invariant(plan.gap >= 0.3 - EPS && plan.gap <= 0.4 + EPS,
      `${label}: 타구 ${plan.gap.toFixed(3)}m left the 0.3~0.4m band`);
    invariant(near(plan.period, plan.merlonLength + plan.gap, 1e-9), `${label}: merlon pitch mismatch`);
    invariant(plan.spans.length === plan.count, `${label}: merlon span count mismatch`);
    let previousEnd = -EPS;
    for (const span of plan.spans) {
      invariant(span.start >= previousEnd - EPS, `${label}: merlons overlap`);
      invariant(near(span.end - span.start, plan.merlonLength, 1e-9), `${label}: ragged 타 length`);
      invariant(span.end <= runLength + EPS, `${label}: merlon left its run`);
      invariant(span.loophole.start > span.start && span.loophole.end < span.end,
        `${label}: 총안 escapes its 타`);
      invariant(span.loophole.end - span.loophole.start <= CITY_WALL_MERLON.loopholeWidth + EPS,
        `${label}: 총안 too wide`);
      previousEnd = span.end;
    }
    invariant(previousEnd <= runLength + EPS && runLength - previousEnd <= plan.gap + EPS,
      `${label}: merlon run leaves a blank tail`);
  }
  invariant(CITY_WALL_MERLON.length - CITY_WALL_MERLON.lengthBand >= 2.8 - EPS
    && CITY_WALL_MERLON.length + CITY_WALL_MERLON.lengthBand <= 3.2 + EPS,
  `${label}: authored 타 band escapes 2.8~3.2m`);
  // 성문에 붙는 자투리 run 도 타 하나는 남는다(연속 프리즘으로 되돌아가지 않는다).
  for (const runLength of [1.4, 3.05, 5, 12, 19.2]) {
    const plan = cityWallMerlonSpans(runLength);
    invariant(plan.count > 0 && plan.merlonLength <= 3.2 + EPS,
      `${label}: stub run ${runLength} lost its 타`);
    invariant(plan.spans.every((span) => span.end <= runLength + EPS),
      `${label}: stub run ${runLength} overflows`);
  }
}

// 여장 블록은 지형 추종 세그먼트의 miter 를 그대로 물려받아야 몸체와 틈이 생기지 않는다.
function assertMerlonBlocks(segments, label, seed = 0) {
  const thickness = CITY_WALL_DIMENSIONS.thickness * 0.7;
  const plan = cityWallMerlonPlan(segments, { thickness, seed });
  invariant(plan.runs.length >= 4, `${label}: merlon runs did not split at the four gates`);
  invariant(plan.blocks.length > 0, `${label}: no merlon blocks`);
  invariant(plan.triangles > 0, `${label}: merlon triangle budget not reported`);
  let loopholes = 0;
  const covered = new Map();
  const slitted = new Set();
  for (const block of plan.blocks) {
    const segment = segments[block.segmentIndex];
    invariant(segment, `${label}: merlon block references a missing segment`);
    const cap = cityWallSegmentCapProfile(segment, thickness);
    invariant(block.corners.length === 4 && block.baseY.length === 4,
      `${label}: merlon block is not a prism`);
    invariant(near(block.height, CITY_WALL_DIMENSIONS.capHeight, 1e-9),
      `${label}: merlon height left capHeight`);
    // 블록 네 코너가 여장 footprint 의 두 변 위(세그먼트 내부)에 있어야 몸체-여장 틈이 없다.
    for (const [index, corner] of block.corners.entries()) {
      const from = index === 0 || index === 3 ? cap.corners[0] : cap.corners[1];
      const to = index === 0 || index === 3 ? cap.corners[3] : cap.corners[2];
      const span = G.sub(to, from);
      const length = Math.hypot(span.x, span.z);
      const t = ((corner.x - from.x) * span.x + (corner.z - from.z) * span.z) / (length * length);
      invariant(t >= -1e-9 && t <= 1 + 1e-9, `${label}: merlon corner left its segment edge`);
      const expected = { x: from.x + span.x * t, z: from.z + span.z * t };
      invariant(pointNear(corner, expected, 1e-9), `${label}: merlon corner left the cap footprint`);
      const y0 = index === 0 || index === 3 ? cap.baseY[0] : cap.baseY[1];
      const y1 = index === 0 || index === 3 ? cap.baseY[3] : cap.baseY[2];
      invariant(near(block.baseY[index], y0 + (y1 - y0) * t, 1e-9),
        `${label}: merlon base left the body top (${Number(block.baseY[index] - (y0 + (y1 - y0) * t)).toFixed(4)}m)`);
    }
    if (block.loophole) {
      loopholes++;
      invariant(block.loophole.bottom > 0
        && block.loophole.bottom + block.loophole.height < CITY_WALL_DIMENSIONS.capHeight,
      `${label}: 총안 leaves the merlon face`);
      invariant(block.loophole.height > 0 && block.loophole.relief > 0,
        `${label}: 총안 is a hole, not an inset face`);
    }
    const key = `${block.runIndex}/${block.merlonIndex}`;
    covered.set(key, (covered.get(key) || 0) + 1);
    if (block.loophole) slitted.add(key);
  }
  const totalMerlons = plan.runs.reduce((sum, run) => sum + run.count, 0);
  invariant(covered.size === totalMerlons, `${label}: ${totalMerlons - covered.size} merlons never rendered`);
  // 총안은 타마다가 아니라 시드 파생으로 띄어 뚫린다(등간격 아이콘 리듬 금지).
  const density = slitted.size / Math.max(1, totalMerlons);
  invariant(density > 0.35 && density < 0.8,
    `${label}: 총안 density ${density.toFixed(3)} (${slitted.size}/${totalMerlons}) left the band`);
  invariant(loopholes >= slitted.size, `${label}: 총안 block accounting lost pieces`);
  for (const run of plan.runs) {
    invariant(run.count > 0, `${label}: empty merlon run`);
    // 한 타의 정수배가 밴드로 떨어지지 않는 것은 성문에 붙은 짧은 자투리뿐이다. 긴 run 이
    // 밴드를 벗어나면 톱니 리듬 자체가 깨진 것이므로 회귀로 잡는다.
    if (run.degenerate) {
      invariant(run.runLength <= 26,
        `${label}: ${run.runLength.toFixed(1)}m run degenerated out of the merlon band`);
      invariant(run.merlonLength >= 1.2 - EPS && run.merlonLength <= 3.2 + EPS,
        `${label}: stub run 타 ${run.merlonLength.toFixed(3)}m is not a 타`);
      invariant(run.gap <= 2 + EPS, `${label}: stub run 타구 ${run.gap.toFixed(3)}m is a blank stretch`);
      continue;
    }
    invariant(run.merlonLength >= 2.8 - EPS && run.merlonLength <= 3.2 + EPS,
      `${label}: run 타 ${run.merlonLength.toFixed(3)}m left the band`);
    invariant(run.gap >= 0.3 - EPS && run.gap <= 0.4 + EPS,
      `${label}: run 타구 ${run.gap.toFixed(3)}m left the band`);
  }
  return plan;
}

// (d-1) 성벽 몸통 2켜: 검증된 두께 envelope 안으로만 물러나고 여장 밑변과 이어진다.
function assertWallCourses(segment, label) {
  const profile = cityWallCourseProfile(segment);
  const exposed = CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink;
  invariant(profile.courses.length === 2, `${label}: wall body is not a two-course hierarchy`);
  const [base, body] = profile.courses;
  invariant(base.key === CITY_WALL_COURSES.keys[0] && body.key === CITY_WALL_COURSES.keys[1],
    `${label}: wall course material keys drifted`);
  invariant(base.key !== body.key, `${label}: wall courses share one material group`);
  invariant(near(base.bottomOffset, -CITY_WALL_DIMENSIONS.foundationSink, 1e-9),
    `${label}: base course left the foundation`);
  invariant(near(body.topOffset, exposed, 1e-9), `${label}: body course top left the 여장 base`);
  invariant(near(base.topOffset, body.bottomOffset, 1e-9), `${label}: course seam split`);
  const fraction = base.topOffset / exposed;
  invariant(fraction >= 0.35 - EPS && fraction <= 0.45 + EPS,
    `${label}: 대석 기단 켜 ${fraction.toFixed(3)} left the 0.35~0.45 band`);
  invariant(base.thickness > body.thickness + EPS,
    `${label}: no horizontal step between base and body`);
  invariant(near(base.thickness, segment.thickness, 1e-9),
    `${label}: base course left the validated wall envelope`);
  invariant(body.thickness >= CITY_WALL_DIMENSIONS.thickness * 0.7,
    `${label}: body course receded behind the 여장`);

  // (7) 성벽도 배터를 가진다 — 육축만 기울고 성벽은 판이라 접합부가 두 자산으로 읽혔다.
  const capThickness = CITY_WALL_DIMENSIONS.thickness * 0.7;
  for (const [index, course] of profile.courses.entries()) {
    invariant(course.topThickness <= course.thickness + EPS,
      `${label}: course ${index} flares upward`);
    invariant(course.topCorners.length === 4 && course.topGroundY.length === 4,
      `${label}: course ${index} lacks a battered top footprint`);
    const slope = (course.thickness - course.topThickness) * 0.5
      / Math.max(1e-6, course.topOffset - course.bottomOffset);
    invariant(slope >= 0 && slope <= 0.10 + EPS,
      `${label}: course ${index} batter ${(slope * 100).toFixed(1)}% exceeds the 육축 vocabulary`);
    course.slope = slope;
  }
  invariant(body.slope >= 0.05 - EPS && body.slope <= 0.10 + EPS,
    `${label}: wall body batter ${(body.slope * 100).toFixed(1)}% left the 5~10% band`);
  invariant(base.slope <= 0.03 + EPS,
    `${label}: 대석 기단 should stay near-vertical (${(base.slope * 100).toFixed(1)}%)`);
  invariant(body.topThickness >= capThickness - EPS,
    `${label}: battered body top (${body.topThickness.toFixed(3)}m) fell behind the 여장 (${capThickness}m)`);
  // 좁아진 top footprint 도 계획이 검증한 envelope 안이라 지형 밀착·world edge 계약이 유지된다.
  for (const course of profile.courses) {
    for (const corner of course.topCorners) {
      invariant(cityWallSegmentFootprint(segment, course.thickness).corners.length === 4,
        `${label}: footprint helper broke`);
      invariant(Number.isFinite(corner.x) && Number.isFinite(corner.z),
        `${label}: battered corner is not finite`);
    }
  }
  for (let c = 0; c < 4; c++) {
    invariant(pointNear(base.corners[c], segment.corners[c], 1e-9),
      `${label}: base course footprint drifted from the segment`);
    invariant(near(base.groundY[c], segment.ground[c], 1e-9),
      `${label}: base course ground drifted from the segment`);
  }
  const capProfile = cityWallSegmentCapProfile(segment, body.thickness);
  for (let c = 0; c < 4; c++) {
    invariant(near(body.groundY[c] + body.topOffset, capProfile.baseY[c], 1e-9),
      `${label}: body top and cap base split`);
  }
}

function assertGateSpacing(spec, label) {
  const gates = [...spec.gates].sort((a, b) => a.angle - b.angle);
  for (let i = 0; i < gates.length; i++) {
    const a = gates[i], b = gates[(i + 1) % gates.length];
    const separation = (b.angle - a.angle + TAU) % TAU;
    const gapAngle = separation - a.halfAngle - b.halfAngle;
    const gapMetres = gapAngle * spec.meanRadius;
    invariant(gapMetres >= 2 - EPS, `${label}: gates ${a.name}/${b.name} overlap (${gapMetres.toFixed(2)}m)`);
  }
}

function bilerpQuad(corners, values, u, v) {
  const inner = G.lerp(corners[0], corners[3], u);
  const outer = G.lerp(corners[1], corners[2], u);
  const point = G.lerp(inner, outer, v);
  const innerValue = values[0] + (values[3] - values[0]) * u;
  const outerValue = values[1] + (values[2] - values[1]) * u;
  return { point, value: innerValue + (outerValue - innerValue) * v };
}

function assertSegments(spec, site, label) {
  const segments = sampleCityWallSegments(spec, site);
  invariant(segments.length > 0, `${label}: no wall segments`);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    invariant(segment.length <= CITY_WALL_DIMENSIONS.maxSegmentLength + EPS, `${label}: segment too long`);
    invariant(segment.terrainError <= CITY_WALL_DIMENSIONS.maxTerrainError + EPS, `${label}: terrain chord error`);
    // 개구부 = 사대문 + 수문(#20 R4). 수문 석축이 그 구멍을 채우므로 리본은 여기서도 끊긴다.
    invariant(!cityWallAngleInAperture(spec, (segment.angle0 + segment.angle1) * 0.5),
      `${label}: wall crosses an opening`);
    invariant(cityWallVegetationBlocked(spec, G.lerp(segment.p0, segment.p1, 0.5)), `${label}: vegetation reaches wall`);
    assertWallCourses(segment, label);
    const cap = cityWallSegmentCapProfile(segment, CITY_WALL_DIMENSIONS.thickness * 0.7);
    const narrow = cityWallSegmentFootprint(segment, CITY_WALL_DIMENSIONS.thickness * 0.7);
    invariant(narrow.corners.length === 4, `${label}: invalid cap footprint`);
    for (let c = 0; c < 4; c++) {
      invariant(pointNear(cap.corners[c], narrow.corners[c], 1e-9), `${label}: cap footprint drift`);
    }
    const bodyTop = segment.ground.map(
      (ground) => ground + CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink,
    );
    const capEdgeMix = (1 - 0.7) * 0.5;
    const capEdgeSamples = [
      bilerpQuad(segment.corners, bodyTop, 0, capEdgeMix).value,
      bilerpQuad(segment.corners, bodyTop, 0, 1 - capEdgeMix).value,
      bilerpQuad(segment.corners, bodyTop, 1, 1 - capEdgeMix).value,
      bilerpQuad(segment.corners, bodyTop, 1, capEdgeMix).value,
    ];
    for (let c = 0; c < 4; c++) {
      invariant(near(cap.baseY[c], capEdgeSamples[c], 1e-9),
        `${label}: cap/body seam split ${Number(cap.baseY[c] - capEdgeSamples[c]).toFixed(3)}m`);
    }

    for (let c = 0; c < 4; c++) {
      const point = segment.corners[c];
      invariant(near(segment.ground[c], terrainMeshHeightAt(site, point.x, point.z)),
        `${label}: stale corner ground`);
      invariant(worldEdgeClearance(site.edge, point) >= -EPS, `${label}: segment corner left terrain`);
    }
    for (const u of [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1]) {
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const sample = bilerpQuad(segment.corners, segment.ground, u, v);
      // 화면에 보이는 것은 해석 heightAt가 아니라 정규 grid 삼각형의 선형면이다.
      const terrainY = terrainMeshHeightAt(site, sample.point.x, sample.point.z);
      const bottomY = sample.value - CITY_WALL_DIMENSIONS.foundationSink;
      const topY = sample.value + CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink;
      invariant(bottomY <= terrainY + EPS, `${label}: wall bottom floats ${Number(bottomY - terrainY).toFixed(3)}m`);
      invariant(topY >= terrainY + 4, `${label}: wall body buried (${Number(topY - terrainY).toFixed(3)}m exposed)`);
      }
    }

    const next = segments[i + 1];
    if (next && near(segment.angle1, next.angle0, 1e-9)) {
      invariant(segment.joinedEnd && next.joinedStart, `${label}: continuous run lost join metadata`);
      invariant(pointNear(segment.corners[2], next.corners[1], 1e-9), `${label}: outer miter split`);
      invariant(pointNear(segment.corners[3], next.corners[0], 1e-9), `${label}: inner miter split`);
    } else if (!(i === segments.length - 1 && !cityWallAngleInAperture(spec, 0))) {
      invariant(!segment.joinedEnd, `${label}: opening lost end-cap`);
    }
  }
  assertMerlonBlocks(segments, label, spec.seed);
  const first = segments[0], last = segments.at(-1);
  if (!cityWallAngleInAperture(spec, 0)) {
    invariant(last.joinedEnd && first.joinedStart, `${label}: cyclic seam lost join metadata`);
    invariant(pointNear(last.corners[2], first.corners[1], 1e-9), `${label}: cyclic outer miter split`);
    invariant(pointNear(last.corners[3], first.corners[0], 1e-9), `${label}: cyclic inner miter split`);
  }
  return segments;
}

function assertWallOnly(seed, siteR) {
  const label = `seed=${seed}/R=${siteR}`;
  const site = makeSite({ siteR, seed });
  const hw = Math.min(50, siteR * 0.10), hd = Math.min(85, siteR * 0.18);
  const core = [[
    { x: site.center.x - hw, z: site.center.z - hd },
    { x: site.center.x + hw, z: site.center.z - hd },
    { x: site.center.x + hw, z: site.center.z + hd },
    { x: site.center.x - hw, z: site.center.z + hd },
  ]];
  const wall = planCityWall(site, seed, core);
  invariant(wall.version === 3, `${label}: stale wall schema`);
  invariant(wall.radii.length >= 96 && wall.radii.length <= 256, `${label}: sample budget`);
  invariant(wall.radii.every((radius) => Number.isFinite(radius) && radius > 0), `${label}: invalid radius`);
  invariant(pointNear(pointOnCityWall(wall, 0), pointOnCityWall(wall, TAU)), `${label}: open seam`);
  invariant(pointOnCityWall(wall, 0).z > wall.cz, `${label}: angle 0 is not south/+z`);
  invariant(pointOnCityWall(wall, Math.PI / 2).x > wall.cx, `${label}: angle π/2 is not east/+x`);
  invariant(cityWallContainsPolygon(wall, core[0], 5), `${label}: reserved core escaped`);
  assertSimpleContour(wall, label);

  for (let i = 0; i < 1024; i++) {
    const angle = i / 1024 * TAU;
    const point = pointOnCityWall(wall, angle);
    const normal = normalOnCityWall(wall, angle);
    for (const offset of [-CITY_WALL_DIMENSIONS.thickness / 2, 0, CITY_WALL_DIMENSIONS.thickness / 2]) {
      const q = { x: point.x + normal.x * offset, z: point.z + normal.z * offset };
      invariant(worldEdgeClearance(site.edge, q) >= -EPS, `${label}: wall footprint left terrain at ${i}`);
    }
  }

  const byName = Object.fromEntries(wall.gates.map((gate) => [gate.name, gate]));
  invariant(wall.gates.length === 4, `${label}: four gates required`);
  invariant(angleDistance(byName.south.angle, 0) <= 0.7 + EPS, `${label}: south gate left sector`);
  invariant(angleDistance(byName.north.angle, Math.PI) <= 1.2 + EPS, `${label}: north gate left sector`);
  invariant(byName.east.x > wall.cx && byName.west.x < wall.cx, `${label}: east/west gates swapped`);
  invariant(near(byName.east.z, wall.axes.jongnoZ) && near(byName.west.z, wall.axes.jongnoZ), `${label}: Jongno gate drift`);
  invariant(wall.axes.jongnoZ >= wall.cz + site.R * 0.13 - EPS,
    `${label}: Jongno crossed north of the palace approach`);
  assertGateSpacing(wall, label);
  for (const gate of wall.gates) assertGate(wall, site, gate, label);
  return assertSegments(wall, site, label);
}

function pointInGateOpening(wall, point, roadWidth) {
  const angle = Math.atan2(point.x - wall.cx, point.z - wall.cz);
  return cityWallAngleInGate(wall, angle)
    && wall.gates.some((gate) => G.dist(gate, point) <= roadWidth + CITY_WALL_DIMENSIONS.gateDepth);
}

function triangleSurfacePoint(a, b, c, u, v) {
  const wa = 1 - u - v;
  return {
    x: a.x * wa + b.x * u + c.x * v,
    y: a.y * wa + b.y * u + c.y * v,
    z: a.z * wa + b.z * u + c.z * v,
  };
}

function pointInTriangleXZ(point, [a, b, c]) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const ab = cross(a, b, point), bc = cross(b, c, point), ca = cross(c, a, point);
  return (ab >= -EPS && bc >= -EPS && ca >= -EPS)
    || (ab <= EPS && bc <= EPS && ca <= EPS);
}

function assertRoadTriangleDraped(p, q, r, road, site, label) {
  invariant(roadSurfaceUpArea(p, q, r) > EPS,
    `${label}/${road.level}: road triangle faces down or degenerates`);
  for (let iu = 0; iu <= 4; iu++) for (let iv = 0; iv <= 4 - iu; iv++) {
    const point = triangleSurfacePoint(p, q, r, iu / 4, iv / 4);
    const terrainY = terrainMeshHeightAt(site, point.x, point.z);
    invariant(point.y >= terrainY - EPS,
      `${label}/${road.level}: road surface entered terrain by ${(terrainY - point.y).toFixed(3)}m`);
  }
}

function assertRoadSurfaceDraped(road, site, label) {
  const { centerline, strips, joins } = sampleRoadSurface(site, road);
  invariant(centerline.length === road.pts.length
    && centerline.every((point, i) => pointNear(point, road.pts[i])),
  `${label}/${road.level}: renderer changed the shared road centerline`);
  for (const strip of strips) {
    const tangent = G.norm(G.sub(strip.b, strip.a));
    const normal = G.perpR(tangent);
    const length = G.dist(strip.a, strip.b);
    invariant(strip.triangles.length > 0, `${label}/${road.level}: empty rendered ribbon`);
    for (const triangle of strip.triangles) {
      for (const point of triangle) {
        const relative = G.sub(point, strip.a);
        const along = G.dot(relative, tangent), across = G.dot(relative, normal);
        invariant(along >= -EPS && along <= length + EPS
          && Math.abs(across) <= strip.width * 0.5 + EPS,
        `${label}/${road.level}: rendered ribbon left its plan segment`);
      }
      assertRoadTriangleDraped(...triangle, road, site, label);
    }
    // Production clipper와 독립적으로 원래 직사각형을 표본화해 grid/diagonal seam의 구멍을 잡는다.
    for (const alongK of [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1]) {
      const center = G.lerp(strip.a, strip.b, alongK);
      for (const acrossK of [-0.98, -0.5, 0, 0.5, 0.98]) {
        const point = G.add(center, G.mul(normal, strip.width * 0.5 * acrossK));
        invariant(strip.triangles.some((triangle) => pointInTriangleXZ(point, triangle)),
          `${label}/${road.level}: terrain-clipped ribbon leaves a coverage gap`);
      }
    }
  }
  for (const join of joins) for (const triangle of join.triangles) {
    assertRoadTriangleDraped(...triangle, road, site, label);
  }

  // Production triangulator를 되읽지 않고 계획선 회전에서 기대 부채꼴을 독립 계산한다. 각 내부
  // vertex의 외측 반경·각도 표본이 실제 join triangle에 들어가야 코너 구멍을 회귀로 잡는다.
  const joinByPoint = new Map(joins.map((join) => [join.pointIndex, join]));
  let expectedJoins = 0;
  for (let i = 1; i < centerline.length - 1; i++) {
    const incoming = G.norm(G.sub(centerline[i], centerline[i - 1]));
    const outgoing = G.norm(G.sub(centerline[i + 1], centerline[i]));
    const turn = incoming.x * outgoing.z - incoming.z * outgoing.x;
    const directionDot = G.dot(incoming, outgoing);
    const turnAngle = Math.abs(Math.atan2(turn, directionDot));
    if (directionDot > 0 && road.width * 0.5 * turnAngle <= ROAD_SURFACE_MIN_JOIN_GAP) continue;
    expectedJoins++;
    const side = turn === 0 ? 1 : turn;
    const startNormal = side > 0 ? G.perpL(incoming) : G.perpR(incoming);
    const endNormal = side > 0 ? G.perpL(outgoing) : G.perpR(outgoing);
    const startAngle = Math.atan2(startNormal.z, startNormal.x);
    const sweep = Math.atan2(
      startNormal.x * endNormal.z - startNormal.z * endNormal.x,
      G.dot(startNormal, endNormal),
    );
    const join = joinByPoint.get(i);
    invariant(join, `${label}/${road.level}: missing outer join at point ${i}`);
    for (const radiusK of [0.25, 0.5, 0.75, 0.98]) for (const arcK of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const angle = startAngle + sweep * arcK;
      const point = {
        x: centerline[i].x + Math.cos(angle) * road.width * 0.5 * radiusK,
        z: centerline[i].z + Math.sin(angle) * road.width * 0.5 * radiusK,
      };
      invariant(join.triangles.some((triangle) => pointInTriangleXZ(point, triangle)),
        `${label}/${road.level}: outer join leaves a coverage gap at point ${i}`);
    }
  }
  invariant(joins.length === expectedJoins, `${label}/${road.level}: unexpected road joins`);
  return strips.reduce((sum, strip) => sum + strip.triangles.length, 0)
    + joins.reduce((sum, join) => sum + join.triangles.length, 0);
}

function assertGateRoadThroats(road, wall, site, label) {
  let gateLinked = false;
  const crossings = [];
  for (let index = 0; index < road.pts.length; index++) {
    const gate = wall.gates.find((candidate) => pointNear(candidate, road.pts[index]));
    if (gate) crossings.push({ gate, index });
  }
  for (const { gate, index } of crossings) {
    gateLinked = true;
    const inward = { x: -gate.dirX, z: -gate.dirZ };
    const outward = { x: gate.dirX, z: gate.dirZ };
    const sides = [];
    if (index > 0) sides.push({ step: -1, point: road.pts[index - 1] });
    if (index < road.pts.length - 1) sides.push({ step: 1, point: road.pts[index + 1] });
    const classified = sides.map((side) => {
      const tangent = G.norm(G.sub(side.point, gate));
      const inwardDot = G.dot(tangent, inward);
      return { ...side, tangent, inwardDot, kind: inwardDot >= 0 ? 'inside' : 'outside' };
    });
    const approach = road.wallApproach?.gate === gate.name;
    invariant(classified.some((side) => side.kind === 'inside'),
      `${label}/${gate.name}: road lacks an interior throat`);
    invariant(!approach || (classified.length === 2
      && classified.filter((side) => side.kind === 'outside').length === 1),
    `${label}/${gate.name}: exterior approach does not cross the gate once`);
    if (classified.length === 2) {
      invariant(G.dot(classified[0].tangent, classified[1].tangent) <= -1 + 1e-9,
        `${label}/${gate.name}: road bends inside the opening`);
    }
    for (const side of classified) {
      const direction = side.kind === 'inside' ? inward : outward;
      const cosine = G.dot(side.tangent, direction);
      invariant(cosine >= 1 - 1e-9, `${label}/${gate.name}: ${side.kind} road misses gate normal`);
      const requiredOpening = road.width / Math.max(cosine, EPS) + CITY_WALL_DIMENSIONS.gateRoadClearance;
      invariant(requiredOpening <= gate.width + EPS,
        `${label}/${gate.name}: ${road.level} road clips gate (${requiredOpening.toFixed(2)}m > ${gate.width.toFixed(2)}m)`);
      if (side.kind === 'inside') {
        invariant(cityWallClearance(wall, side.point) >= road.width * 0.5
          + CITY_WALL_DIMENSIONS.roadEdgeMargin - EPS,
        `${label}/${gate.name}: aligned throat lacks wall clearance`);
      }
      const local = [gate];
      for (let cursor = index + side.step; cursor >= 0 && cursor < road.pts.length && local.length < 6; cursor += side.step) {
        local.push(road.pts[cursor]);
      }
      let previousAlong = -EPS;
      for (const point of local) {
        const along = G.dot(G.sub(point, gate), direction);
        invariant(along >= previousAlong - EPS, `${label}/${gate.name}: ${side.kind} transition doubles back`);
        previousAlong = along;
      }
      for (let i = 1; i < local.length - 1; i++) {
        const before = G.norm(G.sub(local[i], local[i - 1]));
        const after = G.norm(G.sub(local[i + 1], local[i]));
        const turn = Math.acos(Math.min(1, Math.max(-1, G.dot(before, after))));
        invariant(turn <= Math.PI * 35 / 180 + EPS,
          `${label}/${gate.name}: ${side.kind} transition folds ${(turn * 180 / Math.PI).toFixed(1)}°`);
      }
    }
  }
  if (road.wallApproach) invariant(crossings.length === 1,
    `${label}/${road.level}: exterior approach has ${crossings.length} gate crossings`);
  if (gateLinked) assertRoadSurfaceDraped(road, site, label);
}

function assertRoads(plan, label) {
  const wall = plan.features.cityWall;
  const warpInner = terrainWarpInner(plan, plan.site);
  for (const road of plan.roads) {
    for (const point of road.pts) {
      invariant(Math.hypot(point.x, point.z) + road.width * 0.5 <= warpInner + EPS,
        `${label}/${road.level}: road footprint entered warped terrain band`);
    }
    assertGateRoadThroats(road, wall, plan.site, label);
    const approachGate = road.wallApproach
      ? wall.gates.find((gate) => gate.name === road.wallApproach.gate)
      : null;
    const gateIndex = approachGate
      ? road.pts.findIndex((point) => pointNear(point, approachGate))
      : -1;
    for (let i = 0; i < road.pts.length - 1; i++) {
      const a = road.pts[i], b = road.pts[i + 1];
      const tangent = G.norm(G.sub(b, a));
      const side = G.perpL(tangent);
      const exterior = approachGate && (road.wallApproach.side === 'start' ? i < gateIndex : i >= gateIndex);
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const point = G.lerp(a, b, u);
        invariant(worldEdgeClearance(plan.site.edge, point) >= -EPS,
          `${label}: road center left terrain`);
        if (exterior) {
          if (!pointInGateOpening(wall, point, road.width)) {
            invariant(cityWallClearance(wall, point) <= -EPS,
              `${label}: exterior approach re-entered the wall`);
          }
          continue;
        }
        invariant(cityWallClearance(wall, point) >= -EPS, `${label}: road center crossed wall`);
        if (pointInGateOpening(wall, point, road.width)) continue;
        for (const sign of [-1, 1]) {
          const edge = G.add(point, G.mul(side, road.width * 0.5 * sign));
          invariant(cityWallClearance(wall, edge) >= -EPS, `${label}: ${road.level} road edge crossed wall`);
          invariant(worldEdgeClearance(plan.site.edge, edge) >= -EPS, `${label}: ${road.level} road edge left terrain`);
        }
      }
    }
  }
}

function assertPlan(options, { expectedWall = true, repeat = false } = {}) {
  const label = JSON.stringify(options);
  const before = Math.random;
  Math.random = () => { throw new Error(`${label}: consumed global Math.random`); };
  let plan;
  try { plan = planVillage(options); }
  finally { Math.random = before; }
  if (repeat) {
    const again = planVillage(options);
    const pick = (p) => JSON.stringify({ roads: p.roads, parcels: p.parcels, wall: p.features.cityWall, sijeon: p.features.sijeon });
    invariant(pick(plan) === pick(again), `${label}: repeated plan differs`);
  }

  const wall = plan.features.cityWall;
  invariant(Boolean(wall) === expectedWall, `${label}: unexpected wall availability`);
  if (!wall) return plan;
  assertGateSpacing(wall, label);
  for (const gate of wall.gates) assertGate(wall, plan.site, gate, label);
  for (const parcel of plan.parcels) {
    invariant(worldEdgeContainsPolygon(plan.site.edge, parcel.poly, 6 - EPS), `${label}/${parcel.id}: parcel left terrain`);
    if (parcel.satellite) invariant(cityWallOutsidePolygon(wall, parcel.poly, 4 - EPS), `${label}/${parcel.id}: satellite inside wall`);
    else invariant(cityWallContainsPolygon(wall, parcel.poly, 6 - EPS), `${label}/${parcel.id}: parcel crossed wall`);
  }
  for (const shop of plan.features.sijeon || []) {
    invariant(cityWallContainsPolygon(wall, shop.poly, 4 - EPS), `${label}: sijeon crossed wall`);
  }
  assertRoads(plan, label);
  const southApproach = plan.roads.find((road) => road.wallApproach?.gate === 'south');
  invariant(southApproach, `${label}: south gate lacks an exterior approach`);
  const approachEnd = southApproach.wallApproach.side === 'start'
    ? southApproach.pts[0] : southApproach.pts.at(-1);
  invariant(cityWallClearance(wall, approachEnd) <= -southApproach.width * 0.5 + EPS,
    `${label}: south approach endpoint is not outside the wall`);
  invariant(worldEdgeClearance(plan.site.edge, approachEnd) >= southApproach.width * 0.5 - EPS,
    `${label}: south approach endpoint left terrain`);
  if (plan.site.stream && plan.features.bridges?.length) {
    const bridge = plan.features.bridges[0];
    invariant(G.distToPolyline(bridge, southApproach.pts).d <= EPS,
      `${label}: gate road misses its stream bridge`);
  }
  for (const gate of wall.gates) {
    const approach = cityGateApproachFootprint(gate);
    for (const parcel of plan.parcels.filter((candidate) => candidate.satellite)) {
      invariant(!G.polysOverlap(parcel.poly, approach), `${label}/${parcel.id}: satellite blocks ${gate.name} gate`);
    }
  }
  if (plan.scale === 'hamlet' || plan.scale === 'village') {
    const south = wall.gates.find((gate) => gate.name === 'south');
    invariant(plan.roads.some((road) => road.pts.some((point) => pointNear(point, south))),
      `${label}: village spine misses south gate`);
  } else {
    const east = wall.gates.find((gate) => gate.name === 'east');
    const west = wall.gates.find((gate) => gate.name === 'west');
    const jongno = plan.roads.find((road) => pointNear(road.pts[0], west) && pointNear(road.pts.at(-1), east));
    invariant(jongno, `${label}: east/west trunk misses gates`);
    if (plan.scale === 'hanyang') {
      invariant(jongno.pts.some((point) => near(point.x, wall.cx) && near(point.z, wall.axes.jongnoZ)), `${label}: Jongno misses T`);
    }
  }
  return plan;
}

// 작은 외부 contour 재사용부터 한양까지 고르게 훑는다. 회귀 seed는 production 계획에서도 별도 검사한다.
const RADII = [74, 128, 176, 250, 400, 440, 500];
let terrainSegments = 0;
let contourCount = 0;
for (let seed = 0; seed < 64; seed++) {
  terrainSegments += assertWallOnly(seed, RADII[seed % RADII.length]).length;
  contourCount++;
}
// 육축 높이·고밀도 도로 표본·동서문 산사면 회귀를 실제로 일으켰던 seed들.
const REGRESSION_SITES = [
  [88, 128], [6, 128], [1, 176], [58, 176], [5, 250], [17, 250], [24, 250], [33, 250],
  [96, 250], [125, 250],
  [115, 500], [317, 500], [555, 500], [657, 500], [974, 500],
];
for (const [seed, siteR] of REGRESSION_SITES) {
  terrainSegments += assertWallOnly(seed, siteR).length;
  contourCount++;
}

const solo = assertPlan({ scale: 'solo', seed: 1, cityWall: true }, { expectedWall: false, repeat: true });
invariant(solo.warnings.some((warning) => warning.includes(`R≥${CITY_WALL_MIN_SITE_R}`)), 'solo: missing graceful wall warning');
for (const [scale, seed, guardians] of [
  ['hamlet', 20, 1], ['hamlet', 1, 1], ['village', 88, 1], ['village', 42, 1],
  ['town', 42, 2], ['capital', 42, 3],
]) {
  const plan = assertPlan({ scale, seed, cityWall: true });
  assertGuardianClearance(plan, `forced ${scale}/${seed}`, guardians);
}

// 호수 기반 bowl 축소가 고정 폭 성문·육축보다 지형을 작게 만들면 강제 성곽이 예외로
// 앱 생성을 중단했다. 최소 호수와 건천/개울 양쪽을 전 tier에서 훑고, 실제 회귀 seed의
// hamlet은 반복 계획까지 비교해 wall을 조용히 버리지도 결정론을 흔들지도 않게 잠근다.
for (const scale of ['hamlet', 'village', 'town', 'capital', 'hanyang']) {
  for (const stream of [true, false]) {
    const options = {
      scale,
      seed: 13,
      cityWall: true,
      houses: 1,
      stream,
      includePalace: false,
    };
    const plan = assertPlan(options, { repeat: scale === 'hamlet' });
    invariant(near(plan.opts.bowlK, 0.8),
      `${JSON.stringify(options)}: wall did not reserve its minimum terrain span`);
  }
}
assertPlan({ scale: 'hanyang', seed: 13, houses: 1 }, { repeat: true });
assertPlan({ scale: 'hanyang', seed: 1, cityWall: false }, { expectedWall: false, repeat: true });

const defaultPlan = assertPlan({ scale: 'hanyang', seed: 20260716 }, { repeat: true });
assertGuardianClearance(defaultPlan, 'default hanyang', 3);
const defaultRoadTriangles = defaultPlan.roads.reduce(
  (sum, road, index) => sum
    + assertRoadSurfaceDraped(road, defaultPlan.site, `default hanyang/road-${index}`), 0,
);
invariant(defaultRoadTriangles <= 40000,
  `default hanyang: road surface budget exceeded (${defaultRoadTriangles} triangles)`);
invariant(defaultPlan.parcels.some((parcel) => parcel.satellite), 'default hanyang: satellite belt regressed to empty');
invariant(cityGateStreamClearance(
  defaultPlan.features.cityWall.gates.find((gate) => gate.name === 'south'), defaultPlan.site,
) >= CITY_WALL_DIMENSIONS.gateStreamClearance - EPS, 'default hanyang: south gate flooded');
assertPlan({ scale: 'hanyang', seed: 20260716, includePalace: false });
for (const seed of [25, 108, 112, 142]) {
  assertPlan({ scale: 'hanyang', seed });
}
assertPlan({ scale: 'hanyang', seed: 7, houses: 0, includePalace: false });

// ── R3 여장·문루 예산과 렌더러 소비 계약 ────────────────────────────────────
assertMerlonPattern('merlon pattern');
assertStoneValues('stone values');
assertBondPlan('stone bond');
assertMerlonSlits('merlon slits');
const defaultWall = defaultPlan.features.cityWall;
const defaultSegments = sampleCityWallSegments(defaultWall, defaultPlan.site);
const defaultMerlons = assertMerlonBlocks(defaultSegments, 'default hanyang', defaultWall.seed);
let gateParapetTriangles = 0;
let gateMerlons = 0;
const closureRows = [];
const heightRows = [];
for (const gate of defaultWall.gates) {
  const structure = cityGateStructureProfile(gate, defaultPlan.site);
  const masonry = cityGateMasonryProfile(gate, defaultPlan.site, structure);
  const pavilion = cityGatePavilionProfile(gate, structure, masonry);
  closureRows.push(...assertPavilionFacadeClosure(pavilion, `default hanyang/${gate.name}`)
    .map((row) => ({ gate: gate.name, ...row })));
  // ── 육축:문루 높이 비(#54 G8) ──
  // 사진 실측 육축 노출 / 문루 용마루 = 0.80 (= 육축:문루 1:1.25). 이 비는 지형 낙차가 육축
  // 노출 높이를 6.1~10.2m 로 흔들기 때문에 seed 마다 다르다 — 그래서 저작 상수가 아니라
  // **기본 hanyang 픽스처(seed 20260716) 4문**에 못 박는다. 통행면은 도로 표본의 중앙값이다
  // (최고점은 육축 노출을 항상 하한 6.1m 로 되돌려 지형 정보를 잃는다).
  //
  // 단언은 **한쪽만** 건다. 사용자 판정이 지적한 방향은 "육축이 문루를 압도한다"이고, 그 반대
  // (문루가 육축을 압도)는 여기서 고칠 수 없는 별건 원인을 갖는다: 평지 seed 에서 육축 노출이
  // 홍예 클리어런스 바닥(gateArchClearance 4.4 + safety 0.5 + lintel 1.2 = 6.1m)에 고정되는데
  // 인접 성벽 노출은 bodyHeight 7.9m 라, 그 경우 성문 육축이 옆 성벽보다 **낮다**. 그것을 문루
  // 높이로 보정하면 경사 seed 에서 문루가 다시 작아진다 — 원인은 baseTopY 이므로 백로그로 넘긴다
  // (실측: 기본 픽스처 북문 0.531 이 그 바닥 사례다).
  const roadYs = structure.roadTerrain.samples.map((s) => s.y).sort((a, b) => a - b);
  const masonryOverRoad = masonry.cornice.y1 - roadYs[roadYs.length >> 1];
  const [, upperRoof] = pavilion.roofs;
  const pavRidge = upperRoof.y + upperRoof.height - masonry.cornice.y1;
  const ratio = masonryOverRoad / pavRidge;
  invariant(ratio <= 0.85,
    `default hanyang/${gate.name}: 육축 노출/문루 용마루 ${ratio.toFixed(3)} > 0.85 — `
    + '"높은 석축 위 작은 정자"로 되돌아갔다(사진 실측 0.80)');
  heightRows.push({ gate: gate.name, masonryOverRoad, pavRidge, ratio });
  for (const side of pavilion.parapet.sides) {
    const spans = cityWallMerlonSpans(side.length);
    gateMerlons += spans.count;
    // 육축 링의 타는 옆 4면 + 윗면(밑면은 마루에 묻힘) + 총안 인셋 = 12삼각.
    gateParapetTriangles += spans.count * 12;
  }
}
const merlonTriangles = defaultMerlons.triangles + gateParapetTriangles;
invariant(merlonTriangles <= 60000,
  `default hanyang: 여장 triangle budget exceeded (${merlonTriangles})`);
const merlonCount = defaultMerlons.runs.reduce((sum, run) => sum + run.count, 0);
// 파사드 폐합 실측 요약: 하층은 최저 커버리지 100%, 상층은 개방 총높이가 남는다.
const lowerRows = closureRows.filter((row) => row.tier === 'lower');
const upperRows = closureRows.filter((row) => row.tier === 'upper');
const closureSummary = `문루 파사드 하층 최저 커버리지 `
  + `${(Math.min(...lowerRows.map((row) => row.min.coverage)) * 100).toFixed(1)}% / `
  + `개방 ${Math.max(...lowerRows.map((row) => row.openHeight)).toFixed(3)}m, `
  + `상층 개방 ${Math.min(...upperRows.map((row) => row.openHeight)).toFixed(3)}~`
  + `${Math.max(...upperRows.map((row) => row.openHeight)).toFixed(3)}m`;
// 비례 실측 요약(#54 G8): 몸체/육축 상면, 하층 처마/육축 총폭, 육축 노출/문루 용마루.
const proportionRows = defaultWall.gates.map((gate) => {
  const structure = cityGateStructureProfile(gate, defaultPlan.site);
  const masonry = cityGateMasonryProfile(gate, defaultPlan.site, structure);
  const pavilion = cityGatePavilionProfile(gate, structure, masonry);
  return assertGateProportion(pavilion, masonry, `default hanyang/${gate.name}`);
});
const span = (values) => `${Math.min(...values).toFixed(3)}~${Math.max(...values).toFixed(3)}`;
const proportionSummary = `문루 비례 몸체/육축상면 ${span(proportionRows.map((r) => r.bodyOverTop))}`
  + ` (사진 ≈1.00), 하층처마/육축총폭 ${span(proportionRows.map((r) => r.roofOverMasonry))}`
  + ` (사진 1.18~1.23), 육축/문루용마루 ${span(heightRows.map((r) => r.ratio))} (사진 0.80)`;

// 렌더러는 이 순수 spec 을 소비해야 한다. 옛 박스 상인방·연속 여장 프리즘·단층 콜로네이드가
// 남아 있으면 형태 격상이 무효다(브라우저 없이 잡을 수 있는 최소 회귀 가드).
const citywallSource = readFileSync(new URL('../src/village/citywall.js', import.meta.url), 'utf8');
for (const consumed of [
  'cityGateMasonryProfile',
  'cityGatePavilionProfile',
  'cityWallCourseProfile',
  'cityWallMerlonPlan',
  'cityWallMerlonSpans',
  'pavilion.storeys',
  'pavilion.roofs',
  'masonry.arch',
  'masonry.zones',
  // 2라운드: 근경 표면.
  'cityStoneBondPlan',
  'cityStoneTone',
  'CITY_STONE_VALUES',
  'cityWallMerlonLoophole',
  // #23 R3-①: 다포계 공포대. 포열·출목 좌표는 순수 profile 이 주고 렌더러는 그것만 소비한다.
  'storey.bracket',
  'storey.columnX',
  'addPavilionBrackets',
  'B.posts',
  'B.steps',
  // 후속 라운드: 하층 폐합. 판벽 상단·기둥 반경·포벽은 렌더러가 스스로 고쳐 쓰지 않고 계획값을 쓴다.
  'B.infill',
  'storey.panel',
  'storey.columnRadius',
]) {
  invariant(citywallSource.includes(consumed),
    `citywall.js does not consume ${consumed} — R3 masonry/pavilion spec is unrendered`);
}
invariant(!/BoxGeometry\(w \+ pierW/.test(citywallSource),
  'citywall.js still builds the box lintel instead of a 홍예 arch');
invariant(!citywallSource.includes('cityWallSegmentCapProfile'),
  'citywall.js still lays a continuous 여장 prism per segment');
// 옛 힌트 밴드는 기둥 상부에 겹쳐 놓은 architraveY 한 자리에서 창방·평방·소로를 다 만들었다.
invariant(!/\barchitraveY\b/.test(citywallSource),
  'citywall.js still builds the 공포 힌트 band instead of a 다포 포열 (#23 R3-①)');
// 판벽 높이를 렌더러가 기둥 높이의 분율로 되저작하면 공포대 밑에 다시 슬릿이 열린다.
invariant(!/panelH\s*=\s*colH\s*\*/.test(citywallSource),
  'citywall.js re-authors 판벽 height as a fraction of the column — 공포대 밑에 가로 슬릿이 열린다');
// 공포는 기존 dancheong 두 재질만 쓴다 — 새 재질은 프로그램 계열과 병합 드로우콜을 늘린다.
invariant(!/new THREE\.MeshStandardMaterial[^]*?bracket/i.test(
  citywallSource.slice(citywallSource.indexOf('function addPavilionBrackets'))),
'citywall.js allocates a bracket-local material — 공포는 dancheongBeam/dancheongBracket 만 쓴다');

// 톤 통일은 "같은 값을 두 재질에 적어서"가 아니라 **석재 재질이 하나뿐**이라 구성상 보장된다.
// 스무딩된 정점 노멀이 수직면을 하늘 쪽으로 기울여 성벽만 밝게 뜨던 것이 근본 원인이라
// flat shading 을 함께 못 박는다.
for (const banned of ['gateStoneMat', 'baseMat', 'capMat', '0x968d80', '0x8f887d', '0x79736a', '0x746c62']) {
  invariant(!citywallSource.includes(banned),
    `citywall.js still carries a separate stone material/tone (${banned}) — 육축과 성벽이 두 자산으로 갈린다`);
}
invariant(/flatShading:\s*true/.test(citywallSource),
  'citywall.js masonry must be flat shaded — 정점 공유 프리즘의 스무딩이 수직면을 밝게 띄운다');
invariant(/vertexColors:\s*true/.test(citywallSource),
  'citywall.js must carry the stone value hierarchy/줄눈 in vertex colours (텍스처 추가 금지)');
invariant(/SHADE_CASTS_SHADOW\s*=\s*false/.test(citywallSource)
  && /shade[^\n]*SHADE_CASTS_SHADOW/i.test(citywallSource),
'citywall.js 홍예 그늘 판은 그림자를 던지면 안 된다(밀착한 석면에 자기 그림자를 찍는다)');
invariant((citywallSource.match(/new THREE\.MeshStandardMaterial/g) || []).length <= 6,
  'citywall.js material count grew — 병합 후 드로우콜 예산');

// ── 문전 마당 (R3 Phase B) ── 성문 안쪽 접근 예약이 **필지 배치에도** 걸려야 한다. 이전에는 식생에만
//   걸려 있어 일반 필지가 육축 12~14m 앞까지 붙었다(hanyang/7 남문 13.8m·/99 12.0m). 마당은 빈
//   공간이므로 그림자를 만들지 않고(solarObstruction:false), 행랑도 마당은 비워 둔다 — 넓은 가로가
//   좁은 홍예로 수렴하는 압축이 이 마당에서 완성된다.
// [개정 2026-08-04, #54] 배제 깊이를 통행 예약 47m → GATE_FORECOURT_PLAN_DEPTH(14m)로 축소.
//   사용자 결정(12~18m 대역)이며 근거는 문서가 **단언한** 조항 쪽이다: docs/joseon-city.md
//   §시전행랑("종루~남대문·종묘~동대문")·§성문 주변("행랑은 성문에 닿는 간선 파사드를 따라").
//   반대 근거였던 "문 안쪽 의례 광장"은 같은 문서가 미검증으로 명시한 조항이다. 47m 를 필지·시전
//   배제에 그대로 쓰는 동안 문 안쪽 51.25m 가 통째로 비었다(실측 2026-08-04: 사대문 전부 0~30m
//   밴드 필지 0·행랑 0). 통행·식생 예약은 47m 그대로이므로 이 단언은 "필지·시전이 문 앞 14m 를
//   비운다"로 좁혀진 것이고, 문 앞이 열려 있다는 계약 자체는 유지된다.
//   행랑이 실제로 문에 닿는지는 tools/check-sijeon-approach.mjs 가 반대 방향으로 못박는다
//   (FAIL-first 확인: 수정 전 소스에서 19건 실패).
const forecourtRows = [];
for (const forecourtSeed of [2026, 7, 99]) {
  const fp = planVillage({
    scale: 'hanyang', seed: forecourtSeed, includePalace: true, includeTemple: true,
  });
  const fwall = fp.features?.cityWall;
  invariant(fwall?.gates?.length >= 4, `hanyang/${forecourtSeed} lost its city wall`);
  for (const fgate of fwall.gates) {
    const poly = cityGateForecourtPolygon(fgate, { length: GATE_FORECOURT_PLAN_DEPTH });
    const intruders = fp.parcels.filter((parcel) => G.polysOverlap(parcel.poly, poly)).length;
    invariant(intruders === 0,
      `hanyang/${forecourtSeed} ${fgate.name}: ${intruders} parcels intrude into the gate forecourt`);
    const shops = (fp.features.sijeon || []).filter((shop) => G.polysOverlap(shop.poly, poly)).length;
    invariant(shops === 0,
      `hanyang/${forecourtSeed} ${fgate.name}: ${shops} sijeon shops intrude into the gate forecourt`);
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      area += a.x * b.z - b.x * a.z;
    }
    forecourtRows.push({ gate: fgate.name, area: Math.abs(area) / 2 });
  }
}
const forecourtAreas = forecourtRows.map((r) => r.area);
const forecourtSummary = `${forecourtRows.length} forecourts `
  + `${Math.round(Math.min(...forecourtAreas))}~${Math.round(Math.max(...forecourtAreas))} m2`;

console.log(`CITY WALL: PASS (${contourCount} contours, ${terrainSegments} terrain segments, ${defaultPlan.parcels.length} default parcels, ${defaultRoadTriangles} road triangles, ${merlonCount}+${gateMerlons} merlons / ${merlonTriangles} tri, ${forecourtSummary}, ${closureSummary}, ${proportionSummary})`);
