// Pure first-person walk solids (#150-J): wall runs + house OBB with gate gap open.
// Browser-free. Asserts road→gate→courtyard clearance and wall mid-edge block.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';
import {
  buildWalkSolids,
  houseSolidProbePoint,
  parcelHouseWalkSolid,
  parcelHouseWalkSolids,
  parcelWallWalkSolids,
  pointHitsWalkSolids,
  sampleGateCourtyardPath,
  sampleWallMidBlocked,
} from '../src/cinematic/walk-solids.js';
import {
  rectangularParcelShape,
  parcelWorldPoint,
  parcelWorldPolygon,
} from '../src/village/parcel-contract.js';
import { villageWallProfile, splitVillageWallGate } from '../src/village/wall-contract.js';
import {
  CITY_GATE_MASONRY,
  CITY_WALL_DIMENSIONS,
  cityGateLocalPoint,
  cityGateMasonryProfile,
  cityWallAngleInGate,
  cityWallRadiusAt,
  pointOnCityWall,
} from '../src/village/citywall-contour.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');
const BODY = 0.45;
const DT = 1 / 60;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

// ── Synthetic rectangular giwa lot: exact gate math + impostor body ──
const plotW = 12, plotD = 10;
const shape = rectangularParcelShape(plotW, plotD);
const fixture = {
  id: 'walk-fixture',
  kind: 'giwa',
  hero: false,
  wallType: 'stone',
  // ㅡ single bay (not L/U) so the south yard stays clearly open.
  variant: 2,
  center: { x: 0, z: 0 },
  frontDir: { x: 0, z: 1 },
  yaw: 0,
  plotW,
  plotD,
  sx: 1,
  sz: 1,
  shape,
  // North-biased house so the south courtyard stays open for free-step entry.
  houseLocal: { x: 0, z: -2.5 },
};
fixture.poly = parcelWorldPolygon(fixture);
const profile = villageWallProfile(shape, {
  style: 'stone',
  plotW,
  plotD,
  gateEdge: 0,
  gateT: 0.5,
});
const a = shape.pts[0], b = shape.pts[1];
const split = splitVillageWallGate(a, b, profile.gateT, profile.gap);
invariant(split, 'fixture gate split failed');
const gateLocal = split.center;
const gatePoint = parcelWorldPoint(fixture, gateLocal);
fixture.access = {
  roadId: 'r0',
  roadPoint: { x: gatePoint.x, z: gatePoint.z + 4 },
  gateEdge: 0,
  gateT: split.centerT,
  gateRole: 'front',
  gatePoint,
  gateLocalPoint: gateLocal,
  distance: 4,
};

const fixtureSolids = buildWalkSolids({ parcels: [fixture], features: {} });
invariant(fixtureSolids.some((s) => s.kind === 'house'), 'fixture missing house solid');
invariant(fixtureSolids.some((s) => s.kind === 'wall'), 'fixture missing wall solids');
// Gate centre must be open even with body radius.
invariant(!pointHitsWalkSolids(fixtureSolids, gatePoint.x, gatePoint.z, BODY),
  'fixture gate centre is solid');
// Courtyard point just inside the gate.
const courtyardZ = gatePoint.z - 1.5;
invariant(!pointHitsWalkSolids(fixtureSolids, 0, courtyardZ, BODY),
  'fixture courtyard just inside gate is solid');
// House body mass must block.
const houseSolid = parcelHouseWalkSolid(fixture);
invariant(houseSolid, 'fixture house solid missing');
const houseProbe = houseSolidProbePoint(houseSolid);
invariant(pointHitsWalkSolids(fixtureSolids, houseProbe.x, houseProbe.z, BODY),
  'fixture house mass is not solid');
// left edge is index 1: pts[1]→pts[2]
const leftA = parcelWorldPoint(fixture, shape.pts[1]);
const leftB = parcelWorldPoint(fixture, shape.pts[2]);
const leftMid = { x: (leftA.x + leftB.x) * 0.5, z: (leftA.z + leftB.z) * 0.5 };
invariant(pointHitsWalkSolids(fixtureSolids, leftMid.x, leftMid.z, BODY),
  'fixture wall mid-edge is not solid');

const gatePath = sampleGateCourtyardPath(fixture, fixtureSolids, {
  bodyRadius: BODY,
  insideDist: 1.2,
  outsideDist: 1.2,
});
invariant(gatePath.clear, `fixture road→gate→courtyard blocked at ${JSON.stringify(gatePath.blockedAt)}`);
const wallMid = sampleWallMidBlocked(fixture, fixtureSolids, BODY);
invariant(wallMid.blocked, 'fixture wall mid-edge sample failed');

// Whole-parcel footprint would have blocked the courtyard; gate-aware must not.
invariant(!pointHitsWalkSolids(fixtureSolids, 0, plotD * 0.25, BODY),
  'south yard inside lot still treated as solid (old footprint behaviour)');

// ── Real planned village: own-ring gate path + mid wall ──
const plan = planVillage({ scale: 'village', seed: 7, includePalace: false, includeTemple: false });
const regulars = (plan.parcels || []).filter((p) => !p.hero
  && (p.kind === 'giwa' || p.kind === 'choga')
  && p.access?.gatePoint
  && p.wallType
  && p.wallType !== 'open'
  && p.shape?.pts?.length >= 3);
invariant(regulars.length >= 3, `village:7 has too few gated regular parcels (${regulars.length})`);

let clearCount = 0;
let midBlocked = 0;
let houseBlocked = 0;
for (const parcel of regulars) {
  const own = [
    ...parcelHouseWalkSolids(parcel),
    ...parcelWallWalkSolids(parcel),
  ];
  invariant(own.some((s) => s.kind === 'wall'), `${parcel.id} produced no wall solids`);
  invariant(own.some((s) => s.kind === 'house'), `${parcel.id} produced no house solids`);
  const path = sampleGateCourtyardPath(parcel, own, {
    bodyRadius: BODY,
    insideDist: 0.9,
    outsideDist: 1.2,
  });
  invariant(path.clear,
    `${parcel.id} own-ring road→gate→courtyard blocked at ${JSON.stringify(path.blockedAt)}`);
  clearCount++;
  const mid = sampleWallMidBlocked(parcel, own, BODY);
  if (mid.blocked) midBlocked++;
  const house = parcelHouseWalkSolid(parcel);
  const probe = houseSolidProbePoint(house);
  if (probe && pointHitsWalkSolids(own, probe.x, probe.z, BODY)) houseBlocked++;
}
invariant(midBlocked === regulars.length,
  `only ${midBlocked}/${regulars.length} regular parcels blocked wall mid-edge`);
invariant(houseBlocked === regulars.length,
  `only ${houseBlocked}/${regulars.length} regular parcels block house mass`);

// Hero compounds stay conservative full footprints (courtyard not freely open).
const hero = (plan.parcels || []).find((p) => p.hero);
if (hero) {
  const all = buildWalkSolids(plan, plan.site.heightAt);
  const heroSolids = all.filter((s) => s.parcelId === hero.id || s.kind === 'hero');
  invariant(heroSolids.length >= 1, 'hero has no walk solid');
  invariant(pointHitsWalkSolids(heroSolids, hero.center.x, hero.center.z, BODY),
    'hero compound centre is walkable (must stay conservative)');
}

// ── Walker free-step through the synthetic gate (esbuild + pinned three) ──
const built = await esbuild.build({
  stdin: {
    contents: "export { createWalker } from './src/cinematic/walker.js';",
    resolveDir: ROOT,
    sourcefile: 'walk-solids-walker-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const { createWalker } = await import(moduleUrl);

const site = {
  R: 40,
  bowlR: 30,
  center: { x: 0, z: 0 },
  entrance: { x: 0, z: 12 },
  heightAt: () => 0,
};
const walkPlan = {
  site,
  parcels: [fixture],
  features: {},
  roads: [{
    level: 'soro',
    pts: [
      { x: 0, z: 12 },
      { x: 0, z: gatePoint.z + 1.5 },
    ],
  }],
};
const walker = createWalker({ site, plan: walkPlan, heightAt: site.heightAt });
// Place just outside the gate, facing north into the courtyard (−z).
walker.setPos(gatePoint.x, gatePoint.z + 2.0);
walker.yaw = Math.PI; // face −z
walker.stopAutoStroll();
let entered = false;
for (let frame = 0; frame < 180; frame++) {
  walker.update(DT, { fwd: 1, strafe: 0, yaw: 0, pitch: 0, run: false });
  // Courtyard is south-of-center band inside the ring (z < gate, z > house front).
  if (walker.pos.z < gatePoint.z - 0.6 && walker.pos.z > -0.5
    && Math.abs(walker.pos.x) < 1.5
    && !walker.isColliding()) {
    entered = true;
    break;
  }
}
invariant(entered, `walker failed to enter courtyard through gate (z=${walker.pos.z.toFixed(3)}, colliding=${walker.isColliding()})`);

// Auto-stroll must remain road-bound (never park inside the courtyard).
const stroller = createWalker({ site, plan: walkPlan, heightAt: site.heightAt });
stroller.startAutoStroll();
let maxCourtyardFrames = 0;
for (let frame = 0; frame < 600; frame++) {
  stroller.update(DT, {});
  const inYard = stroller.pos.z < gatePoint.z - 0.5 && stroller.pos.z > -1;
  if (inYard) maxCourtyardFrames++;
}
invariant(maxCourtyardFrames === 0,
  `auto-stroll entered courtyard (${maxCourtyardFrames} frames)`);

// ── 도성 성곽 (R3 Phase B) ── 1인칭이 성벽·육축을 통과하지 못하고, 홍예 통로는 통행 가능해야 한다.
//   이 절 이전에는 성곽이 walk solids 에 **전혀** 없어 자유 이동이 여장·홍예·육축을 그대로 지나갔다.
const cityStats = (() => {
  const cityPlan = planVillage({ scale: 'hanyang', seed: 2026, includePalace: true, includeTemple: true });
  const wall = cityPlan.features?.cityWall;
  invariant(wall && wall.gates?.length >= 4,
    'hanyang fixture lost its city wall — the城郭 contract needs a walled capital');
  const citySolids = buildWalkSolids(cityPlan, cityPlan.site.heightAt);
  const solid = (x, z) => pointHitsWalkSolids(citySolids, x, z, BODY);

  // (a) 성벽 몸통: 문 각도 구간을 뺀 contour 표본 전체가 solid.
  let bodySamples = 0, bodyLeaks = 0;
  for (let k = 0; k < 360; k++) {
    const angle = (k / 360) * Math.PI * 2;
    if (cityWallAngleInGate(wall, angle)) continue;
    bodySamples++;
    const p = pointOnCityWall(wall, angle);
    if (!solid(p.x, p.z)) bodyLeaks++;
  }
  invariant(bodyLeaks === 0,
    `first person walks through the city wall body at ${bodyLeaks}/${bodySamples} contour samples`);

  // (b) 성벽이 과도하게 두껍지 않다: 중심선 ±6m 는 양쪽 모두 통행 가능(회랑·가로가 살아 있어야 한다).
  let clearBoth = 0, clearTotal = 0;
  for (let k = 0; k < 360; k += 3) {
    const angle = (k / 360) * Math.PI * 2;
    if (cityWallAngleInGate(wall, angle)) continue;
    clearTotal++;
    const r = cityWallRadiusAt(wall, angle);
    const dx = Math.sin(angle), dz = Math.cos(angle);
    const inside = { x: wall.cx + dx * (r - 6), z: wall.cz + dz * (r - 6) };
    const outside = { x: wall.cx + dx * (r + 6), z: wall.cz + dz * (r + 6) };
    if (!solid(inside.x, inside.z) && !solid(outside.x, outside.z)) clearBoth++;
  }
  invariant(clearBoth === clearTotal,
    `city wall solid is too thick — only ${clearBoth}/${clearTotal} samples keep both faces walkable`);

  // (c) 홍예 통로: 문 축을 따라 ±12m 를 끊김 없이 통과할 수 있다(성문의 존재 이유).
  // (d) 육축: 홍예 밖 석축 내부는 solid.
  let archBlocked = 0, pierOpen = 0;
  for (const gate of wall.gates) {
    for (let t = -12; t <= 12; t += 0.25) {
      if (solid(gate.x + gate.dirX * t, gate.z + gate.dirZ * t)) archBlocked++;
    }
    const masonry = cityGateMasonryProfile(gate, cityPlan.site);
    for (const zone of masonry.zones) {
      const rect = zone.courses[0].bottom;
      for (const fx of [0.25, 0.5, 0.75]) {
        for (const fz of [0.3, 0.5, 0.7]) {
          const p = cityGateLocalPoint(gate,
            rect.x0 + (rect.x1 - rect.x0) * fx, rect.z0 + (rect.z1 - rect.z0) * fz);
          if (!solid(p.x, p.z)) pierOpen++;
        }
      }
    }
  }
  invariant(archBlocked === 0,
    `city gate arch passage is blocked at ${archBlocked} samples — the gate must be walkable`);
  invariant(pierOpen === 0,
    `first person walks into city gate masonry at ${pierOpen} pier interior samples`);

  // (e) 진실 소유: 계획 예약 여유폭은 육축 두 덩이와 정확히 같다(따로 저작하면 한쪽만 바뀐다).
  invariant(CITY_WALL_DIMENSIONS.gateExtraWidth === CITY_GATE_MASONRY.pierWidth * 2,
    `gateExtraWidth (${CITY_WALL_DIMENSIONS.gateExtraWidth}) must stay pierWidth * 2 `
      + `(${CITY_GATE_MASONRY.pierWidth * 2}) — one place owns the truth`);

  return {
    solids: citySolids.length,
    cityWallSolids: citySolids.filter((x) => x.kind === 'citywall').length,
    cityGateSolids: citySolids.filter((x) => x.kind === 'citygate').length,
    bodySamples,
    archSamples: wall.gates.length * 97,
  };
})();

console.log('walk-solids contract: PASS', JSON.stringify({
  fixtureGap: +profile.gap.toFixed(2),
  regulars: regulars.length,
  gatePathsClear: clearCount,
  wallMidsBlocked: midBlocked,
  walkerEntered: entered,
  autoStrollYardFrames: maxCourtyardFrames,
  ...cityStats,
}));
