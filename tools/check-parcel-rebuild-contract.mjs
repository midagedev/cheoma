// Pure/runtime-light contract for GitHub #19's focused parcel rebuild transaction.
// It proves that the lot variation stays inside its reserved envelope, never
// accumulates shrinkage, remains deterministic, and regenerates yard flora clear
// of the edited roof, solar/view corridor, and every hard yard object.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/village/plan.js';
import {
  captureParcelRebuildEnvelope,
  parcelRebuildIssues,
  planParcelRebuild,
  residentialVariationDistance,
} from '../src/village/parcel-rebuild.js';
import {
  canopyBlocksSolarAccess,
  parcelLocalPoint,
} from '../src/village/parcel-contract.js';
import { parcelLocalRoofBounds } from '../src/village/house-footprint.js';
import {
  PAVILION_ROOF_RADIUS,
  pavilionBlocksParcelFocus,
} from '../src/village/pavilion-plan.js';
import { yardHardObstacles, yardTreeIntersectsHardObstacle } from '../src/village/yard-layout.js';
import { yardCanopyBlocked } from '../src/village/vegetation-spatial.js';
import { buildingBlocksSolarAccess } from '../src/village/solar-access.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');
const built = await esbuild.build({
  stdin: {
    contents: "export { buildVillageFlora } from './src/village/gardens.js';",
    resolveDir: ROOT,
    sourcefile: 'parcel-rebuild-contract-entry.js',
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
const { buildVillageFlora } = await import(moduleUrl);

const fail = (message) => { throw new Error(message); };
const stable = (parcel) => JSON.stringify({
  plotW: parcel.plotW, plotD: parcel.plotD,
  shape: parcel.shape, poly: parcel.poly, access: parcel.access,
  seed: parcel.seed, rebuildSeed: parcel.rebuildSeed,
  variant: parcel.variant, sx: parcel.sx, sy: parcel.sy, sz: parcel.sz,
  wallType: parcel.wallType, wallHeightK: parcel.wallHeightK,
  aux: parcel.aux, auxRequested: parcel.auxRequested,
  auxiliary: parcel.auxiliary,
  jangdok: parcel.jangdok, yardStack: parcel.yardStack,
  clothesline: parcel.clothesline, vegBed: parcel.vegBed,
  courtyardTree: parcel.courtyardTree,
});
const anchors = (flora, parcelId) => flora.yardTreeAnchors
  .filter((tree) => tree.parcelId === parcelId)
  .map((tree) => ({
    x: +tree.x.toFixed(6), z: +tree.z.toFixed(6),
    radius: +tree.radius.toFixed(6), trunkRadius: +tree.trunkRadius.toFixed(6),
    species: tree.species,
  }));

let rebuilt = 0;
let rebuiltAuxiliaries = 0;
let floraCases = 0;
let varied = 0;
let floraChanges = 0;
for (const scale of ['hamlet', 'village', 'town', 'capital', 'hanyang']) {
  const largeTier = scale === 'capital' || scale === 'hanyang';
  for (const villageSeed of largeTier ? [7] : [7, 91, 20260716]) {
    const plan = planVillage({
      scale,
      seed: villageSeed,
      includePalace: largeTier,
    });
    const solarPeers = [
      ...plan.parcels,
      ...(plan.features.palace?.center ? [plan.features.palace] : []),
    ];
    const samples = plan.parcels.filter((parcel) => !parcel.hero).slice(0, 3);
    for (const parcel of samples) {
      const envelope = captureParcelRebuildEnvelope(parcel);
      // A whole-parcel reroll retires any previous FULL edit measurement before
      // choosing its new variant. Neither the flora roof envelope nor the door
      // obstruction is allowed to leak into the freshly planned house.
      envelope.editRoofBounds = { minX: -99, maxX: 99, minZ: -99, maxZ: 99 };
      envelope.editBuildingBounds = {
        minX: -99, maxX: 99, minY: 0, maxY: 99, minZ: -99, maxZ: 99,
      };
      const original = stable(envelope);
      const fingerprints = new Set();
      for (const rebuildSeed of [11, 29, 47]) {
        const a = planParcelRebuild(envelope, rebuildSeed, {
          char01: plan.opts.char01,
          tuning: plan.opts.tuning,
          pavilion: plan.features.pavilion,
          site: plan.site,
          solarPeers,
        });
        const b = planParcelRebuild(envelope, rebuildSeed, {
          char01: plan.opts.char01,
          tuning: plan.opts.tuning,
          pavilion: plan.features.pavilion,
          site: plan.site,
          solarPeers,
        });
        if (!a || !b) fail(`${scale}:${villageSeed}:${parcel.id} rebuild failed`);
        if (a.editRoofBounds != null || a.editBuildingBounds != null) {
          fail(`${scale}:${villageSeed}:${parcel.id} stale edit bounds survived reroll`);
        }
        if (stable(a) !== stable(b)) fail(`${scale}:${villageSeed}:${parcel.id} nondeterministic`);
        const issues = parcelRebuildIssues(envelope, a);
        if (issues.length) fail(`${scale}:${villageSeed}:${parcel.id} ${issues.join(', ')}`);
        // Pavilion is placed after parcels; a residual solar gap on the reserved
        // envelope must not make rebuild impossible. Only fail when the rebuild
        // newly introduces a pavilion conflict the envelope did not already have.
        const envelopePavSolar = canopyBlocksSolarAccess(
          envelope, plan.features.pavilion, PAVILION_ROOF_RADIUS,
        );
        const envelopePavFocus = pavilionBlocksParcelFocus(envelope, plan.features.pavilion);
        if (!envelopePavSolar
          && canopyBlocksSolarAccess(a, plan.features.pavilion, PAVILION_ROOF_RADIUS)) {
          fail(`${scale}:${villageSeed}:${parcel.id} pavilion blocks rebuilt solar access`);
        }
        if (!envelopePavFocus
          && pavilionBlocksParcelFocus(a, plan.features.pavilion)) {
          fail(`${scale}:${villageSeed}:${parcel.id} pavilion blocks rebuilt focus camera`);
        }
        for (const peer of solarPeers) {
          if (peer.id === a.id) continue;
          if (buildingBlocksSolarAccess(a, peer, plan.site)
            || (peer.kind !== 'palace' && buildingBlocksSolarAccess(peer, a, plan.site))) {
            fail(`${scale}:${villageSeed}:${parcel.id} rebuilt house blocks neighbour sunlight`);
          }
        }
        if (a.plotW < envelope.plotW * 0.879 || a.plotD < envelope.plotD * 0.879) {
          fail(`${scale}:${villageSeed}:${parcel.id} accumulated shrink`);
        }
        if (a.auxiliary) rebuiltAuxiliaries++;
        fingerprints.add(stable(a));
        rebuilt++;
      }
      if (stable(envelope) !== original) fail(`${scale}:${villageSeed}:${parcel.id} envelope mutated`);
      if (fingerprints.size > 1) varied++;

      // One adversarial flora commit per plan is enough to cover every expensive
      // geometry path while the planner loop above covers the larger seed matrix.
      if (largeTier || parcel !== samples[0]) continue;
      const baseline = buildVillageFlora(plan, plan.site, plan.seed);
      const ownerId = baseline.yardTreeAnchors.find((tree) => !plan.parcels
        .find((candidate) => candidate.id === tree.parcelId)?.hero)?.parcelId;
      // Small hamlets can legitimately have no regular yard tree after every
      // roof/solar/hard-object clearance. Skip only that expensive flora fixture;
      // the browser gate and the minimum below still require real tree owners.
      if (!ownerId) {
        baseline.dispose();
        continue;
      }
      const owner = plan.parcels.find((candidate) => candidate.id === ownerId);
      const ownerEnvelope = captureParcelRebuildEnvelope(owner);
      const beforeAnchors = anchors(baseline, ownerId);
      const edited = planParcelRebuild(ownerEnvelope, 0x19e17, {
        char01: plan.opts.char01,
        tuning: plan.opts.tuning,
        pavilion: plan.features.pavilion,
        site: plan.site,
        solarPeers,
      });
      edited.aux = true;
      edited.jangdok = 3;
      edited.yardStack = true;
      edited.clothesline = true;
      edited.vegBed = true;
      edited.wallType = 'open';
      const roof = parcelLocalRoofBounds(edited);
      edited.editRoofBounds = {
        minX: roof.minX - 0.7, maxX: roof.maxX + 0.7,
        minZ: roof.minZ - 0.7, maxZ: roof.maxZ + 0.7,
      };
      const editPlan = {
        ...plan,
        parcels: plan.parcels.map((candidate) => candidate.id === edited.id ? edited : candidate),
      };
      const floraA = buildVillageFlora(editPlan, plan.site, plan.seed);
      const floraB = buildVillageFlora(editPlan, plan.site, plan.seed);
      const aAnchors = anchors(floraA, edited.id);
      const bAnchors = anchors(floraB, edited.id);
      if (JSON.stringify(aAnchors) !== JSON.stringify(bAnchors)) {
        fail(`${scale}:${villageSeed}:${edited.id} flora nondeterministic`);
      }
      if (JSON.stringify(beforeAnchors) !== JSON.stringify(aAnchors)) floraChanges++;
      const obstacles = yardHardObstacles(edited);
      for (const tree of floraA.yardTreeAnchors.filter((item) => item.parcelId === edited.id)) {
        const local = parcelLocalPoint(edited, tree);
        const footprint = { canopyRadius: tree.radius, trunkRadius: tree.trunkRadius };
        if (yardTreeIntersectsHardObstacle(local, footprint, obstacles)) {
          fail(`${scale}:${villageSeed}:${edited.id} tree/hard-object collision`);
        }
        if (yardCanopyBlocked(edited, local, tree.radius)) {
          fail(`${scale}:${villageSeed}:${edited.id} tree roof/solar/view collision`);
        }
      }
      baseline.dispose();
      floraA.dispose();
      floraB.dispose();
      floraCases++;
    }
  }
}

if (varied === 0) fail('rebuild seeds produced no variation');
if (rebuiltAuxiliaries === 0) fail('rebuild matrix produced no planned auxiliary');
if (floraCases < 4) fail(`only ${floraCases} rebuild fixtures contained a real yard tree`);
if (floraChanges === 0) fail('flora commits never changed a rebuilt tree owner');

// Focus "다시 짓기" must explore a broader form repertoire than placement, stay
// deterministic for a fixed seed+previous, and prefer a non-near-duplicate of
// the currently focused house. Village placement never sets exploreReroll.
{
  const plan = planVillage({ scale: 'village', seed: 7 });
  const samples = plan.parcels.filter((parcel) => !parcel.hero).slice(0, 4);
  let formFlips = 0;
  let strongSteps = 0;
  let steps = 0;
  for (const parcel of samples) {
    const envelope = captureParcelRebuildEnvelope(parcel);
    const opts = {
      char01: plan.opts.char01,
      tuning: plan.opts.tuning,
      pavilion: plan.features.pavilion,
      site: plan.site,
      solarPeers: [
        ...plan.parcels,
        ...(plan.features.palace?.center ? [plan.features.palace] : []),
      ],
    };
    let previous = planParcelRebuild(envelope, 3, opts);
    if (!previous) fail(`${parcel.id} explore baseline rebuild failed`);
    const a = planParcelRebuild(envelope, 91, {
      ...opts, exploreReroll: true, previous,
    });
    const b = planParcelRebuild(envelope, 91, {
      ...opts, exploreReroll: true, previous,
    });
    if (!a || !b) fail(`${parcel.id} explore reroll failed`);
    if (stable(a) !== stable(b)) fail(`${parcel.id} explore reroll nondeterministic`);
    for (const rebuildSeed of [5, 17, 29, 41, 53, 67, 79, 101]) {
      const next = planParcelRebuild(envelope, rebuildSeed, {
        ...opts, exploreReroll: true, previous,
      });
      if (!next) fail(`${parcel.id} explore chain failed`);
      const distance = residentialVariationDistance(previous, next);
      if (distance < 1) fail(`${parcel.id} explore reroll stayed a near-duplicate`);
      if (distance >= 2) strongSteps += 1;
      if ((next.variant | 0) !== (previous.variant | 0)) formFlips += 1;
      previous = next;
      steps += 1;
    }
  }
  if (steps < 16) fail(`explore chain too short (${steps})`);
  if (strongSteps < steps * 0.7) {
    fail(`explore rerolls rarely change the house strongly (${strongSteps}/${steps})`);
  }
  if (formFlips < steps * 0.35) {
    fail(`explore rerolls rarely change plan form (${formFlips}/${steps})`);
  }
}

console.log(`PARCEL REBUILD CONTRACT: PASS (${rebuilt} deterministic rebuilds, ${rebuiltAuxiliaries} auxiliaries, ${varied} varied envelopes, ${floraCases} flora commits, ${floraChanges} changed owners)`);
