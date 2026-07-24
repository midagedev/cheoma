// 전체 village scene graph 계약: sync, async worker, async fallback이 같은 결과를 만들어야 한다.
// Vite를 독립 cacheDir로 직접 띄워 실제 module Worker 변환과 메시지 왕복까지 검사한다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-worker-contract-'));
const threeMain = join(ROOT, 'app/node_modules/three/build/three.module.js');
const threeAddons = join(ROOT, 'app/node_modules/three/examples/jsm/');
const html = '<!doctype html><meta charset="utf-8"><title>worker contract</title>';
const expectedSteps = [
  'plan', 'setup+clearance', 'terrain', 'mist+water', 'roads+paddy', 'parcels/houses',
  'features+wall+sijeon', 'merges', 'trees', 'forest', 'flora',
  'animals+night+bloom+cloudshadow',
];
const expectedSceneHashes = {
  // #12: the variable rectangular precinct is reserved before parcels and
  // vegetation, then rendered as the compact/courtyard/extended TemplePlan.
  // #49 extends the solar/focus-frame contract to pavilion eaves and feature
  // props. #13 replaces overlapping rectangular giwa podiums with one concave
  // solid and sinks every building foundation. #21 reserves a monotonically
  // graded stream valley and adds the visible five-lane water ribbon. #40 adds
  // metre-scale settlement relief to every tier; explicit river mode remains a
  // separate non-golden scenario. #56 gives temple roles distinct dancheong
  // palettes; #8 retains four giwa groups but changes their exact geometry to
  // ㅡ + mirrored ㄱ + fitted four-bay ㄷ. #11 replaces duplicated exterior
  // stove masses with one recessed residential kitchen scene and neutralizes
  // civilian lattice textures. #30 adds deterministic world-space road UVs;
  // the texture bytes stay outside this structural hash. #16 adds shared static
  // opening frames, window meoreum aprons, restrained FULL-only hardware, and
  // splits the active primary leaf from the fixed remainder. #10 carries the
  // six residential opening axes through the variant bytes and renders those
  // selected openings in every FULL giwa/choga prototype. Choga and hanok keep
  // a fixed dark recess while residential primary-door and footwear anchors
  // share the same renderer-free opening plan. The reviewed 24° focus elevation
  // and #95's 10° parcel lens lengthen the protected focus corridor while the
  // projected house size stays fixed. Pavilions and public props therefore move
  // only among already-valid planned candidates. The structural byte change is
  // confined to roots downstream of those positions (merged landmarks and the
  // terrain's structure-clearance colour field in the reviewed capital split);
  // houses, roads, paddies, temple, trees, flora, animals, night lights, and bloom
  // stay byte-identical. #81 replaces inferred lot lights with fixed renderer-
  // authored opening anchors. #96 replaces their point sprite with one physical
  // instanced hanji quad batch that carries authored anchor, outward normal, and
  // opening dimensions. The intentional geometry/material/triangle change updates
  // every scale hash while pick proxies remain byte-identical. Front-side rejection,
  // source depth, and the fixed 1+1 draw family are covered by the dedicated lighting
  // gates. #112 splits solid walls on rendered terrain into bounded horizontal
  // steps while preserving flat/soft-boundary output and every pick proxy byte.
  // #122 writes each temple hall's role-ranked roof/bracket/eave/massing grammar
  // and actual eave polygon into the pure plan. Temple meshes and serialized
  // plans therefore change at every scale, while residential geometry and pick
  // proxies remain unchanged.
  // #128 preserves every sijeon placement byte and replaces only the Hanyang
  // market-row meshes with the planned two-bay column/opening/bench grammar.
  // The other scales and all pick proxies therefore remain byte-identical.
  // #131 adds one stable named yard-life group at every scale and, for selected
  // households, texture-free seasonal geometry that is prebuilt but asleep in
  // summer. Its physical hedge envelope removes the one Hanyang golden household
  // whose seasonal footprint would enter the rendered shrub band; other golden
  // scales and every parcel pick proxy remain exact.
  // Sync, real module Worker, and ?worker=0 fallback must still match exactly.
  village: 'ae1af164:287a8084:452f2525:e178edfe',
  town: 'a306bb06:d9edffa4:db9607bf:c955fb6e',
  capital: '53b4e2bb:48fb5b8b:3e9b9356:3e67cdff',
  hanyang: 'f4d92850:e3b6d6c2:e300b7b3:32aa4d5e',
};
const expectedProxyHashes = {
  // #22 visibility uses #8's fitted roof OBBs plus planned feature blockers.
  // #56's palace/temple dancheong edit axes remain in the proxy contract. #8 also
  // exposes the authored giwa bay width so the shape-aware editor can start at
  // the first effective mainHalfW rather than presenting a dead slider range.
  // #10 adds the six normalized residential opening axes to the public proxy.
  // Product focus keeps the door-height target at the exact reviewed shared
  // 24° courtyard elevation. #95 applies the 10° physical parcel lens from the
  // authored 23° reference lens. #132 shortens any mountain-crossing ray inside
  // the rendered terrain's first safe interval and widens only actual FOV; the
  // authored reference lens stays fixed so LOD remains screen-equivalent. Safe
  // candidates still scale XZ and Y together and all four proxy counts/isolation
  // contracts remain unchanged.
  village: '7772a271',
  town: 'e52d4318',
  capital: '0ecf2caf',
  hanyang: '63c90052',
};

const server = await createServer({
  appType: 'custom',
  cacheDir,
  configFile: false,
  root: ROOT,
  logLevel: 'error',
  plugins: [{
    name: 'worker-contract-page',
    configureServer(vite) {
      vite.middlewares.use('/__worker-contract', (_req, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(html);
      });
    },
  }],
  resolve: {
    alias: [
      { find: /^three\/addons\//, replacement: threeAddons },
      { find: /^three$/, replacement: threeMain },
    ],
    dedupe: ['three'],
  },
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
let failed = false;
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  // Scene/proxy goldens are cross-path determinism bytes, not a render benchmark. Keep the
  // Playwright-pinned JS/browser runtime here; system Chrome versions can legitimately round
  // generated Float32 data differently even when worker and sync still agree with each other.
  browser = await chromium.launch();
  console.log('[verification-browser] browser=chromium mode=pinned-worker-goldens');

  async function compare(mode) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await page.goto(`${base}/__worker-contract${mode === 'fallback' ? '?worker=0' : ''}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });

    const result = await page.evaluate(async () => {
      const NativeWorker = window.Worker;
      const workerStats = { started: 0, succeeded: 0, failed: 0, terminated: 0 };
      window.Worker = class ContractWorker extends NativeWorker {
        constructor(...args) {
          super(...args);
          workerStats.started++;
          this.addEventListener('message', (event) => {
            if (event.data?.ok) workerStats.succeeded++;
            else workerStats.failed++;
          });
          this.addEventListener('error', () => workerStats.failed++);
        }
        terminate() {
          workerStats.terminated++;
          return super.terminate();
        }
      };

      const [
        { createVillage, createVillageAsync },
        { hashThreeGroup, hashVillagePickProxies },
        { isSharedResource },
        { CITY_WALL_DIMENSIONS, cityWallVegetationBlocked },
        { FOREST_VISUAL_RADIUS },
        { VILLAGE_LENS, dollyScaleForFov },
        { makeVegetationMask, yardCanopyBlocked },
        { parcelLocalPoint },
        { yardHardObstacles, yardTreeIntersectsHardObstacle },
        { planYardLife, yardLifeRecordsToHardObstacles },
        { SCATTER_TREE_VISUAL_RADIUS },
        { decodeSceneSnapshot, encodeSceneSnapshot },
        { Material },
      ] = await Promise.all([
        import('/src/village/adapter.js'),
        import('/tools/lib/hash-three-group.mjs'),
        import('/src/core/three-resources.js'),
        import('/src/village/citywall-contour.js'),
        import('/src/village/forest-crunch.js'),
        import('/src/camera/optics.js'),
        import('/src/village/vegetation-spatial.js'),
        import('/src/village/parcel-contract.js'),
        import('/src/village/yard-layout.js'),
        import('/src/village/yard-life-plan.js'),
        import('/src/generators/village/trees.js'),
        import('/app/src/lib/scene-snapshot.js'),
        import('/app/node_modules/three/build/three.module.js'),
      ]);
      const probeLifecycle = (handle) => {
        const yardLife = handle.group.userData.yardLife || null;
        const owned = new Set();
        const shared = new Set();
        const add = (resource) => {
          if (!resource?.dispose) return;
          (isSharedResource(resource) ? shared : owned).add(resource);
        };
        const addMaterial = (material) => {
          if (!material) return;
          add(material);
          for (const value of Object.values(material)) if (value?.isTexture) add(value);
          for (const uniform of Object.values(material.uniforms || {})) {
            const value = uniform?.value;
            if (value?.isTexture) add(value);
            else if (Array.isArray(value)) for (const item of value) if (item?.isTexture) add(item);
          }
        };
        const addObject = (object) => {
          add(object.geometry);
          const materials = Array.isArray(object.material)
            ? object.material
            : (object.material ? [object.material] : []);
          for (const material of materials) addMaterial(material);
        };
        handle.group.traverse(addObject);
        for (const proxy of handle.getPickProxies()) addObject(proxy.mesh);
        const counts = new Map();
        let sharedDisposals = 0;
        const onOwned = (event) => counts.set(event.target, (counts.get(event.target) || 0) + 1);
        const onShared = () => { sharedDisposals++; };
        for (const resource of owned) resource.addEventListener('dispose', onOwned);
        for (const resource of shared) resource.addEventListener('dispose', onShared);
        return {
          finish() {
            for (const resource of owned) resource.removeEventListener('dispose', onOwned);
            for (const resource of shared) resource.removeEventListener('dispose', onShared);
            const yardLifeDebug = yardLife?.debug?.() || null;
            return {
              owned: owned.size,
              disposed: counts.size,
              duplicates: [...counts.values()].filter((count) => count !== 1).length,
              duplicateDetails: [...counts.entries()]
                .filter(([, count]) => count !== 1)
                .slice(0, 8)
                .map(([resource, count]) => ({ type: resource.type || resource.constructor?.name, name: resource.name || '', count })),
              shared: shared.size,
              sharedDisposals,
              yardLifeDisposed: yardLifeDebug?.disposed === true
                && yardLifeDebug?.productMaterialsDisposed === true
                && yardLifeDebug?.resources?.geometries === 0
                && yardLifeDebug?.resources?.derivedMaterials === 0,
            };
          },
        };
      };
      const postDisposeInactive = (handle) => {
        const scene = new handle.group.constructor();
        let beforeObjects = 0;
        handle.group.traverse(() => { beforeObjects++; });
        const parcelId = handle.plan.parcels[0]?.id;
        handle.enterVillageMode({ scene });
        handle.debugShowProxies(true);
        const detail = handle.showParcelDetail(parcelId);
        let afterObjects = 0;
        handle.group.traverse(() => { afterObjects++; });
        return scene.children.length === 0
          && beforeObjects === afterObjects
          && detail === null
          && handle.getPickProxy(parcelId) === null
          && handle.getPickProxies().length === 0
          && handle.updateLod(null) === 0;
      };
      const vegetationContract = (handle) => {
        const wall = handle.plan.features?.cityWall;
        const mask = makeVegetationMask(handle.plan, handle.plan.site);
        let checked = 0;
        const failures = [];
        handle.group.traverse((object) => {
          if (!object.isInstancedMesh || ![
            'forest-pine', 'forest-broad', 'forest-far', 'forest-rocks',
            'scatter-pine', 'scatter-broad',
          ].includes(object.name)) return;
          const array = object.instanceMatrix.array;
          for (let i = 0; i < object.count; i++) {
            const o = i * 16;
            const point = { x: array[o + 12], z: array[o + 14] };
            const sx = Math.hypot(array[o], array[o + 1], array[o + 2]);
            const sz = Math.hypot(array[o + 8], array[o + 9], array[o + 10]);
            const factor = object.name === 'forest-pine' ? FOREST_VISUAL_RADIUS.pine
              : object.name === 'forest-broad' ? FOREST_VISUAL_RADIUS.broad
                : object.name === 'forest-far' ? FOREST_VISUAL_RADIUS.far
                  : object.name === 'forest-rocks' ? FOREST_VISUAL_RADIUS.rock
                    : object.name === 'scatter-pine' ? SCATTER_TREE_VISUAL_RADIUS.pine
                      : SCATTER_TREE_VISUAL_RADIUS.broad;
            const radius = Math.max(sx, sz) * factor;
            const blockedByLayout = mask(point.x, point.z, radius);
            const blockedByWall = wall && cityWallVegetationBlocked(wall, point, {
              corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
              gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
              gateApproachMargin: radius,
            });
            checked++;
            if ((blockedByLayout || blockedByWall) && failures.length < 8) failures.push({
              name: object.name, index: i, radius, x: point.x, z: point.z,
              blockedByLayout, blockedByWall: !!blockedByWall,
            });
          }
        });
        for (const [index, anchor] of (handle.group.userData.guardianAnchors || []).entries()) {
          const radius = anchor.r || 0;
          const blocked = wall && cityWallVegetationBlocked(wall, anchor, {
            corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
            gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
            gateApproachMargin: radius,
          });
          checked++;
          if (blocked && failures.length < 8) failures.push({
            name: 'flora-guardian', index, radius, x: anchor.x, z: anchor.z,
          });
        }
        const parcelById = new Map(handle.plan.parcels.map((parcel) => [parcel.id, parcel]));
        for (const [index, anchor] of (handle.group.userData.yardTreeAnchors || []).entries()) {
          const parcel = parcelById.get(anchor.parcelId);
          const local = parcel && parcelLocalPoint(parcel, anchor);
          const gardenOptions = Number.isFinite(anchor.hwagyeX)
            ? { exact: true, side: anchor.gardenSide, hwagyeX: anchor.hwagyeX }
            : undefined;
          const hardObstacles = parcel ? [
            ...yardHardObstacles(parcel, gardenOptions),
            ...yardLifeRecordsToHardObstacles(
              handle.group.userData.yardLifeRecords,
              anchor.parcelId,
            ),
          ] : [];
          const blocked = !parcel || !(anchor.radius > 0)
            || !(anchor.trunkRadius > 0)
            || yardCanopyBlocked(parcel, local, anchor.radius)
            || mask.spatial.blocksYardCanopy(anchor.x, anchor.z, anchor.radius)
            || yardTreeIntersectsHardObstacle(local, {
              canopyRadius: anchor.radius,
              trunkRadius: anchor.trunkRadius,
            }, hardObstacles);
          checked++;
          if (blocked && failures.length < 8) failures.push({
            name: 'flora-yard', index, parcelId: anchor.parcelId,
            radius: anchor.radius, x: anchor.x, z: anchor.z,
          });
        }
        const plannedGuardians = handle.plan.features?.guardianTrees || [];
        const renderedGuardians = handle.group.userData.guardianAnchors || [];
        if (plannedGuardians.length !== renderedGuardians.length && failures.length < 8) {
          failures.push({
            name: 'flora-guardian-count',
            planned: plannedGuardians.length,
            rendered: renderedGuardians.length,
          });
        }
        return { pass: failures.length === 0, checked, failures };
      };
      const yardLifeContract = (handle) => {
        const debug = handle.debugYardLife?.();
        const records = handle.group.userData.yardLifeRecords || [];
        const source = JSON.stringify(debug?.records || []);
        let hash = 0x811c9dc5;
        for (let index = 0; index < source.length; index++) {
          hash ^= source.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193);
        }
        const signature = (hash >>> 0).toString(16).padStart(8, '0');
        const group = handle.group.getObjectByName('village-yard-life');
        const pass = !!debug
          && debug.season === 'summer'
          && debug.weather === 'clear'
          && debug.recordCount === records.length
          && debug.records?.length === records.length
          && debug.activeRecords === 0
          && debug.submittedDrawCalls === 0
          && debug.allocatedDrawCalls <= 6
          && debug.textures === 0
          && debug.productBorrowedMaterials === 6
          && debug.productMaterialsDisposed === false
          && group?.visible === false
          && typeof group?.userData.waveFade?.setWeight === 'function';
        return {
          pass,
          recordCount: debug?.recordCount ?? -1,
          activeRecords: debug?.activeRecords ?? -1,
          allocatedDrawCalls: debug?.allocatedDrawCalls ?? -1,
          signature,
        };
      };
      const crossKindYardLifeContract = (handle) => {
        const first = handle.group.userData.yardLifeRecords?.[0];
        if (!first) return { pass: true, skipped: true };
        const parcelId = first.owner.parcelId;
        const parcel = handle.plan.parcels.find((candidate) => candidate.id === parcelId);
        if (!parcel || !['giwa', 'choga'].includes(parcel.kind)) {
          return { pass: false, skipped: false, reason: 'missing residential owner' };
        }
        const kind = parcel.kind === 'choga' ? 'giwa' : 'choga';
        const rebuilt = handle.rebuildParcel(parcelId, { kind }, { persist: true });
        const planningParcels = handle.plan.parcels.map((candidate) => (
          candidate.id === parcelId ? { ...candidate, kind } : candidate
        ));
        const expected = planYardLife(planningParcels, { seed: handle.plan.seed });
        const actual = handle.group.userData.yardLifeRecords || [];
        return {
          pass: !!rebuilt && JSON.stringify(actual) === JSON.stringify(expected),
          skipped: false,
          parcelId,
          kind,
          expectedRecords: expected.filter((record) => record.owner.parcelId === parcelId).length,
          actualRecords: actual.filter((record) => record.owner.parcelId === parcelId).length,
        };
      };
      const landmarkLensContract = (handle, { requirePalace = false, requireTemple = true } = {}) => {
        const DEG = Math.PI / 180;
        const failures = [];
        let checked = 0;
        const specs = [
          { id: 'palace', profile: VILLAGE_LENS.palace, fit: 1.12, padding: 0.12, targetLift: 3.2, required: requirePalace },
          { id: 'temple', profile: VILLAGE_LENS.temple, fit: 1.16, padding: 0.14, targetLift: 3, required: requireTemple },
        ];
        for (const spec of specs) {
          const proxy = handle.getPickProxy(spec.id);
          if (!proxy) {
            if (spec.required) failures.push({ id: spec.id, reason: 'missing' });
            continue;
          }
          checked++;
          const framing = proxy.cameraFraming;
          const extent = Math.max(proxy.dims.x, proxy.dims.z);
          const expectedReferenceDistance = (extent * 0.5)
            / Math.tan(spec.profile.referenceFov * 0.5 * DEG) * spec.fit
            + extent * spec.padding;
          const physicalDistance = framing.position.distanceTo(framing.target);
          const scale = dollyScaleForFov(spec.profile.referenceFov, spec.profile.fov);
          const screenEquivalentDistance = physicalDistance / scale;
          const referencePreserved = framing.referenceFov === spec.profile.referenceFov;
          const fovPreserved = framing.fov === spec.profile.fov;
          const compositionPreserved = Math.abs(screenEquivalentDistance - expectedReferenceDistance) <= 1e-8;
          const targetLift = framing.target.y - proxy.worldCenter.y;
          const doorTargetPreserved = Math.abs(targetLift - spec.targetLift) <= 1e-8;
          if (!referencePreserved || !fovPreserved || !compositionPreserved || !doorTargetPreserved) {
            failures.push({
              id: spec.id,
              fov: framing.fov,
              referenceFov: framing.referenceFov,
              screenEquivalentDistance,
              expectedReferenceDistance,
              targetLift,
              expectedTargetLift: spec.targetLift,
            });
          }
        }
        return { pass: failures.length === 0, checked, failures };
      };

      const abortName = async (promise) => {
        try { await promise; return 'resolved'; }
        catch (error) { return error?.name || 'unknown'; }
      };
      const preAborted = new AbortController();
      preAborted.abort();
      const preAbortName = await abortName(createVillageAsync(
        { scale: 'village', seed: 20260716 },
        { signal: preAborted.signal },
      ));
      const duringAbort = new AbortController();
      const abortSteps = [];
      const duringAbortName = await abortName(createVillageAsync(
        { scale: 'village', seed: 20260717 },
        {
          signal: duringAbort.signal,
          budgetMs: -1,
          onStep(label) {
            abortSteps.push(label);
            if (label === 'terrain') duringAbort.abort();
          },
        },
      ));
      const lateAbort = new AbortController();
      const lateAbortSteps = [];
      const yardLifeDisposals = new Map();
      const originalMaterialDispose = Material.prototype.dispose;
      Material.prototype.dispose = function disposeTrackedYardLifeMaterial() {
        if (this.name?.startsWith('yard-life-')
          || this.name?.startsWith('village-yard-life-')) {
          yardLifeDisposals.set(this.name, (yardLifeDisposals.get(this.name) || 0) + 1);
        }
        return originalMaterialDispose.call(this);
      };
      let lateAbortName;
      try {
        lateAbortName = await abortName(createVillageAsync(
          { scale: 'capital', seed: 20260716 },
          {
            signal: lateAbort.signal,
            budgetMs: -1,
            onStep(label) {
              lateAbortSteps.push(label);
              if (label === 'flora') lateAbort.abort();
            },
          },
        ));
      } finally {
        Material.prototype.dispose = originalMaterialDispose;
      }
      const stepsAtAbort = abortSteps.length;
      const schedulerFailureName = await abortName(createVillageAsync(
        { scale: 'village', seed: 20260718 },
        { nextFrame() { throw new Error('scheduler-fail'); } },
      ));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const abortContract = {
        preAbortName,
        duringAbortName,
        schedulerFailureName,
        steps: abortSteps,
        stopped: abortSteps.length === stepsAtAbort,
        lateAbortName,
        lateAbortSteps,
        lateAbortYardLifeDisposals: Object.fromEntries(yardLifeDisposals),
        lateAbortYardLifeLifecycle: yardLifeDisposals.size === 14
          && [...yardLifeDisposals.values()].every((count) => count === 1),
      };
      const scales = ['village', 'town', 'capital', 'hanyang'];
      const cases = [];
      for (const scale of scales) {
        const opts = { scale, seed: 20260716, includeTemple: true };
        const sync = createVillage(opts);
        const steps = [];
        const asyncHandle = await createVillageAsync(opts, {
          budgetMs: 8,
          nextFrame: (callback) => requestAnimationFrame(callback),
          onStep: (label) => steps.push(label),
        });
        const syncHash = hashThreeGroup(sync.group);
        const asyncHash = hashThreeGroup(asyncHandle.group);
        const syncProxyHash = hashVillagePickProxies(sync);
        const asyncProxyHash = hashVillagePickProxies(asyncHandle);
        const vegetation = vegetationContract(sync);
        const syncYardLife = yardLifeContract(sync);
        const asyncYardLife = yardLifeContract(asyncHandle);
        const yardLifePass = syncYardLife.pass
          && asyncYardLife.pass
          && syncYardLife.recordCount === asyncYardLife.recordCount
          && syncYardLife.signature === asyncYardLife.signature;
        const crossKindYardLife = scale === 'capital'
          ? crossKindYardLifeContract(sync)
          : { pass: true, skipped: true };
        const lensRequirements = { requirePalace: scale === 'hanyang', requireTemple: true };
        const syncLandmarkLenses = landmarkLensContract(sync, lensRequirements);
        const asyncLandmarkLenses = landmarkLensContract(asyncHandle, lensRequirements);
        const syncProbe = probeLifecycle(sync);
        const asyncProbe = probeLifecycle(asyncHandle);
        sync.dispose();
        sync.dispose();
        asyncHandle.dispose();
        asyncHandle.dispose();
        const inactive = postDisposeInactive(sync) && postDisposeInactive(asyncHandle);
        const syncLifecycle = syncProbe.finish();
        const asyncLifecycle = asyncProbe.finish();
        const lifecyclePass = [syncLifecycle, asyncLifecycle].every((result) => (
          result.owned > 0
          && result.disposed === result.owned
          && result.duplicates === 0
          && result.sharedDisposals === 0
          && result.yardLifeDisposed
        )) && inactive;
        cases.push({
          scale,
          equal: syncHash.hash === asyncHash.hash && syncProxyHash.hash === asyncProxyHash.hash,
          syncHash,
          asyncHash,
          syncProxyHash,
          asyncProxyHash,
          steps,
          lifecyclePass,
          syncLifecycle,
          asyncLifecycle,
          inactive,
          vegetation,
          yardLifePass: yardLifePass && crossKindYardLife.pass,
          syncYardLife,
          asyncYardLife,
          crossKindYardLife,
          syncLandmarkLenses,
          asyncLandmarkLenses,
        });
      }

      // #108: one deliberately tiny scene proves that the canonical URL
      // option envelope feeds the same sync, real-worker, and ?worker=0
      // generation paths. Keep this outside the four historical scene goldens:
      // it is a transport/determinism acceptance case, not a fifth art golden.
      const advancedInput = {
        state: {
          seed: 108,
          preset: 'korea',
          time: 'day',
          sunsetLook: 'gold',
          season: 'summer',
          weather: 'clear',
          renderStyle: 'pbr',
          expansion: 1,
        },
        overrides: {
          preset: true,
          time: true,
          sunsetLook: true,
          season: true,
          weather: true,
        },
        village: {
          seed: 20260724,
          scale: 'solo',
          character: 'yeoyeom',
          includePalace: false,
          includeTemple: false,
          siteR: 30,
          undAmpK: 0,
          ridgeHK: 0.5,
          streamMeanderK: 2.5,
          stream: false,
          river: true,
          paddyDensityK: 0,
          treeDensityK: 0,
          cityWall: false,
          sijeon: false,
          char01: 0.2,
          diversityK: 0,
          houses: 1,
          wallWeights: {
            tile: 1.5,
            stone: 1.25,
            mud: 0.75,
            brush: 0.5,
            hedge: 1,
            open: 0,
          },
        },
      };
      const advancedPayload = encodeSceneSnapshot(advancedInput);
      const advancedDecoded = decodeSceneSnapshot(advancedPayload);
      const advancedRoundtrip = advancedDecoded && encodeSceneSnapshot({
        state: {
          seed: advancedDecoded.seed,
          preset: advancedDecoded.preset,
          time: advancedDecoded.time,
          sunsetLook: advancedDecoded.sunsetLook,
          season: advancedDecoded.season,
          weather: advancedDecoded.weather,
          renderStyle: advancedDecoded.renderStyle,
          expansion: advancedDecoded.expansion,
        },
        overrides: advancedDecoded.overrides,
        village: advancedDecoded.village,
        flow: advancedDecoded.flow,
        residentialEdits: advancedDecoded.residentialEdits,
        focusedParcelId: advancedDecoded.focusedParcelId,
        view: advancedDecoded.view,
      });
      const decodedOptions = advancedDecoded?.village;
      const codecPass = !!advancedPayload
        && advancedRoundtrip === advancedPayload
        && decodedOptions?.siteR === 30
        && decodedOptions?.houses === 1
        && decodedOptions?.stream === false
        && decodedOptions?.river === true
        && decodedOptions?.wallWeights?.tile === 1.5
        && decodedOptions?.wallWeights?.stone === 1.25
        && decodedOptions?.wallWeights?.mud === 0.75
        && decodedOptions?.wallWeights?.brush === 0.5
        && decodedOptions?.wallWeights?.hedge === 1
        && decodedOptions?.wallWeights?.open === 0;

      let advancedCase = {
        codecPass,
        payload: advancedPayload,
        roundtrip: advancedRoundtrip,
        equal: false,
        planOptionsPass: false,
        steps: [],
      };
      if (decodedOptions) {
        const sync = createVillage(decodedOptions);
        const steps = [];
        const asyncHandle = await createVillageAsync(decodedOptions, {
          budgetMs: 8,
          nextFrame: (callback) => requestAnimationFrame(callback),
          onStep: (label) => steps.push(label),
        });
        const syncHash = hashThreeGroup(sync.group);
        const asyncHash = hashThreeGroup(asyncHandle.group);
        const syncProxyHash = hashVillagePickProxies(sync);
        const asyncProxyHash = hashVillagePickProxies(asyncHandle);
        const tuning = sync.plan.opts.tuning;
        const planOptionsPass = sync.plan.opts.siteR === 30
          && sync.plan.opts.target === 1
          && sync.plan.site.stream === null
          && tuning.stream === false
          && tuning.river === true
          && tuning.treeDensityK === 0
          && tuning.paddyDensityK === 0
          && tuning.wallWeights?.tile === 1.5
          && tuning.wallWeights?.open === 0;
        advancedCase = {
          codecPass,
          payload: advancedPayload,
          roundtrip: advancedRoundtrip,
          equal: syncHash.hash === asyncHash.hash
            && syncProxyHash.hash === asyncProxyHash.hash,
          planOptionsPass,
          steps,
          syncHash,
          asyncHash,
          syncProxyHash,
          asyncProxyHash,
        };
        sync.dispose();
        asyncHandle.dispose();
      }
      return { cases, advancedCase, workerStats, abortContract };
    });
    await page.close();
    return { ...result, errors };
  }

  const advancedModeHashes = [];
  for (const mode of ['worker', 'fallback']) {
    const result = await compare(mode);
    console.log(`\n${mode === 'worker' ? 'async worker' : 'async fallback (?worker=0)'}`);
    for (const item of result.cases) {
      const stepsEqual = JSON.stringify(item.steps) === JSON.stringify(expectedSteps);
      const baselineEqual = item.syncHash.hash === expectedSceneHashes[item.scale]
        && item.syncProxyHash.hash === expectedProxyHashes[item.scale];
      const proxyApiPass = item.syncProxyHash.singleContract && item.asyncProxyHash.singleContract;
      const landmarkLensPass = item.syncLandmarkLenses.pass && item.asyncLandmarkLenses.pass;
      const pass = item.equal && stepsEqual && baselineEqual && proxyApiPass && landmarkLensPass
        && item.lifecyclePass && item.vegetation.pass && item.yardLifePass;
      failed ||= !pass;
      console.log(`${item.scale.padEnd(9)} ${pass ? 'PASS' : 'FAIL'}  ${item.syncHash.hash}  proxy=${item.syncProxyHash.hash}`
        + `  objects=${item.syncHash.objects} triangles=${item.syncHash.triangles}`);
      if (!item.equal) console.log(`          async ${item.asyncHash.hash}  proxy=${item.asyncProxyHash.hash}`);
      if (!baselineEqual) {
        console.log(`          expected ${expectedSceneHashes[item.scale]}  proxy=${expectedProxyHashes[item.scale]}`);
      }
      if (!stepsEqual) console.log(`          steps ${JSON.stringify(item.steps)}`);
      if (!proxyApiPass) console.log('          getPickProxy descriptor parity/isolation contract failed');
      if (!landmarkLensPass) {
        console.log(`          landmark lenses sync=${JSON.stringify(item.syncLandmarkLenses)} async=${JSON.stringify(item.asyncLandmarkLenses)}`);
      }
      if (!item.lifecyclePass) {
        console.log(`          lifecycle sync=${JSON.stringify(item.syncLifecycle)} async=${JSON.stringify(item.asyncLifecycle)} inactive=${item.inactive}`);
      }
      if (!item.vegetation.pass) console.log(`          vegetation ${JSON.stringify(item.vegetation)}`);
      if (!item.yardLifePass) {
        console.log(`          yard-life sync=${JSON.stringify(item.syncYardLife)} async=${JSON.stringify(item.asyncYardLife)} crossKind=${JSON.stringify(item.crossKindYardLife)}`);
      }
    }
    const advanced = result.advancedCase;
    const advancedStepsEqual = JSON.stringify(advanced.steps) === JSON.stringify(expectedSteps);
    const advancedProxyApiPass = advanced.syncProxyHash?.singleContract
      && advanced.asyncProxyHash?.singleContract;
    const advancedPass = advanced.codecPass
      && advanced.equal
      && advanced.planOptionsPass
      && advancedStepsEqual
      && advancedProxyApiPass;
    failed ||= !advancedPass;
    console.log(`snapshot  ${advancedPass ? 'PASS' : 'FAIL'}  ${advanced.syncHash?.hash || 'no-scene'}`
      + `  proxy=${advanced.syncProxyHash?.hash || 'no-proxy'}`
      + `  payload=${advanced.payload?.length || 0}b`);
    if (!advanced.codecPass) {
      console.log(`          codec payload=${JSON.stringify(advanced.payload)} roundtrip=${JSON.stringify(advanced.roundtrip)}`);
    }
    if (!advanced.equal) {
      console.log(`          async ${advanced.asyncHash?.hash || 'no-scene'}  proxy=${advanced.asyncProxyHash?.hash || 'no-proxy'}`);
    }
    if (!advanced.planOptionsPass) console.log('          decoded advanced options did not reach the planner intact');
    if (!advancedStepsEqual) console.log(`          steps ${JSON.stringify(advanced.steps)}`);
    if (!advancedProxyApiPass) console.log('          snapshot getPickProxy descriptor parity/isolation contract failed');
    advancedModeHashes.push({
      mode,
      scene: advanced.syncHash?.hash,
      proxy: advanced.syncProxyHash?.hash,
    });
    const workerPass = mode === 'worker'
      ? result.workerStats.started === 1
        && result.workerStats.succeeded >= result.cases.length + 1
        && result.workerStats.failed === 0
        && result.workerStats.terminated === 0
      : result.workerStats.started === 0 && result.workerStats.terminated === 0;
    const abortPass = result.abortContract.preAbortName === 'AbortError'
      && result.abortContract.duringAbortName === 'AbortError'
      && result.abortContract.lateAbortName === 'AbortError'
      && result.abortContract.schedulerFailureName === 'Error'
      && result.abortContract.stopped
      && result.abortContract.steps.at(-1) === 'terrain'
      && result.abortContract.lateAbortSteps.at(-1) === 'flora'
      && result.abortContract.lateAbortYardLifeLifecycle;
    failed ||= !workerPass || !abortPass || result.errors.length > 0;
    console.log(`worker messages: ${JSON.stringify(result.workerStats)} ${workerPass ? 'PASS' : 'FAIL'}`);
    console.log(`abort lifecycle: ${JSON.stringify(result.abortContract)} ${abortPass ? 'PASS' : 'FAIL'}`);
    for (const error of result.errors) console.error(error);
  }
  const snapshotCrossModePass = advancedModeHashes.length === 2
    && advancedModeHashes[0].scene === advancedModeHashes[1].scene
    && advancedModeHashes[0].proxy === advancedModeHashes[1].proxy;
  failed ||= !snapshotCrossModePass;
  console.log(`\nsnapshot sync/worker/fallback: ${snapshotCrossModePass ? 'PASS' : 'FAIL'} ${JSON.stringify(advancedModeHashes)}`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

if (failed) {
  console.error('\nWORKER CONTRACT: FAIL');
  process.exitCode = 1;
} else {
  console.log('\nWORKER CONTRACT: PASS');
}
