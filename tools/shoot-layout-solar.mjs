// Issue #7 visual review: south-facing parcels, solar corridors, and guardian canopies.
//
// Captures use the real app/engine path and stay in an OS temp directory. The overlay
// is injected only by this harness; production scene code and public APIs stay untouched.
//
// Usage:
//   node tools/shoot-layout-solar.mjs
//   CHEOMA_LAYOUT_OVERLAY=on node tools/shoot-layout-solar.mjs
//   CHEOMA_LAYOUT_OVERLAY=off CHEOMA_LAYOUT_SCENE=giwa node tools/shoot-layout-solar.mjs
//   CHEOMA_LAYOUT_LAYERS=front,solar node tools/shoot-layout-solar.mjs
//   CHEOMA_LAYOUT_SCALE=hamlet CHEOMA_LAYOUT_SEED=7 CHEOMA_LAYOUT_SCENE=top node tools/shoot-layout-solar.mjs
//   CHEOMA_LAYOUT_SCALE=hanyang CHEOMA_LAYOUT_SEED=7 CHEOMA_LAYOUT_SCENE=parcel \
//     CHEOMA_LAYOUT_PARCEL=p254 node tools/shoot-layout-solar.mjs
//
// CHEOMA_LAYOUT_OVERLAY: both (default), on, off
// CHEOMA_LAYOUT_SCENE:   all (default), top, aerial, focus, giwa, choga, parcel
// CHEOMA_LAYOUT_LAYERS:  comma-separated front,solar,guardian (default: all)
// CHEOMA_LAYOUT_SCALE:   hamlet, village, town, capital, hanyang (default: village)
// CHEOMA_LAYOUT_SEED:    unsigned integer VillagePlan seed (default: 20260716)
// CHEOMA_LAYOUT_TIME:    dawn, day, sunset, night (default: day)
// CHEOMA_LAYOUT_SEASON:  spring, summer, autumn, winter (default: summer)
// CHEOMA_LAYOUT_WEATHER: clear, rain, snow (default: clear)
// CHEOMA_LAYOUT_PARCEL:  exact parcel ID; pair with CHEOMA_LAYOUT_SCENE=parcel
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const overlayMode = process.env.CHEOMA_LAYOUT_OVERLAY || 'both';
const sceneFilter = process.env.CHEOMA_LAYOUT_SCENE || 'all';
const layoutScale = process.env.CHEOMA_LAYOUT_SCALE || 'village';
const layoutSeed = Number.parseInt(process.env.CHEOMA_LAYOUT_SEED || '20260716', 10) >>> 0;
const layoutTime = process.env.CHEOMA_LAYOUT_TIME || 'day';
const layoutSeason = process.env.CHEOMA_LAYOUT_SEASON || 'summer';
const layoutWeather = process.env.CHEOMA_LAYOUT_WEATHER || 'clear';
const layoutParcel = process.env.CHEOMA_LAYOUT_PARCEL || null;
const reproduceQuery = '?hero=0&village=1&worker=0&shot=1'
  + `&seed=42&vseed=${layoutSeed}&vscale=${layoutScale}`
  + `&time=${layoutTime}&season=${layoutSeason}&weather=${layoutWeather}`;
const validLayers = new Set(['front', 'solar', 'guardian']);
const validScales = new Set(['hamlet', 'village', 'town', 'capital', 'hanyang']);
const validTimes = new Set(['dawn', 'day', 'sunset', 'night']);
const validSeasons = new Set(['spring', 'summer', 'autumn', 'winter']);
const validWeather = new Set(['clear', 'rain', 'snow']);
const layers = (process.env.CHEOMA_LAYOUT_LAYERS || 'front,solar,guardian')
  .split(',').map((value) => value.trim()).filter(Boolean);

if (!['both', 'on', 'off'].includes(overlayMode)) {
  throw new Error(`CHEOMA_LAYOUT_OVERLAY must be both, on, or off (received ${overlayMode})`);
}
if (!['all', 'top', 'aerial', 'focus', 'giwa', 'choga', 'parcel'].includes(sceneFilter)) {
  throw new Error(`CHEOMA_LAYOUT_SCENE has an unknown value: ${sceneFilter}`);
}
if (sceneFilter === 'parcel' && !layoutParcel) {
  throw new Error('CHEOMA_LAYOUT_SCENE=parcel requires CHEOMA_LAYOUT_PARCEL');
}
if (!validScales.has(layoutScale)) throw new Error(`CHEOMA_LAYOUT_SCALE is invalid: ${layoutScale}`);
if (!validTimes.has(layoutTime)) throw new Error(`CHEOMA_LAYOUT_TIME is invalid: ${layoutTime}`);
if (!validSeasons.has(layoutSeason)) throw new Error(`CHEOMA_LAYOUT_SEASON is invalid: ${layoutSeason}`);
if (!validWeather.has(layoutWeather)) throw new Error(`CHEOMA_LAYOUT_WEATHER is invalid: ${layoutWeather}`);
if (!layers.length) throw new Error('CHEOMA_LAYOUT_LAYERS did not select a known layer');
const unknownLayers = layers.filter((layer) => !validLayers.has(layer));
if (unknownLayers.length) throw new Error(`CHEOMA_LAYOUT_LAYERS has unknown values: ${unknownLayers.join(',')}`);

const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-layout-solar-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-layout-solar-shots-'));

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const errors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(180_000);
  await page.addInitScript(() => {
    window.__noWarm = true;
    window.__villageSync = true;
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  const reproduceUrl = `http://127.0.0.1:${port}/${reproduceQuery}`;
  console.log(`repro: ${reproduceUrl}`);
  await page.goto(reproduceUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine);
  await reportWebGLRenderer(page, 'layout-solar');
  await page.waitForFunction(({ seed, scale }) => {
    const plan = window.__engine?.village?.debugPlan?.();
    return plan?.seed === seed && plan?.scale === scale;
  }, { seed: layoutSeed, scale: layoutScale });
  // Keep captures about the 3D scene. Element screenshots still composite DOM panels
  // positioned above the canvas, so hide every non-canvas branch after app boot.
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('renderer canvas is unavailable');
    for (const element of document.body.querySelectorAll('*')) {
      if (element === canvas || element.contains(canvas)) continue;
      element.style.setProperty('visibility', 'hidden', 'important');
    }
  });

  const overlayStats = await page.evaluate(async ({ threeModuleUrl, selectedLayers }) => {
    const THREE = await import(threeModuleUrl);
    const engine = window.__engine;
    const root = engine.village.exportRoot();
    const plan = root?.userData?.plan;
    if (!plan) throw new Error('active VillagePlan is unavailable');

    const old = engine.scene.getObjectByName('__layout-solar-overlay');
    if (old) old.removeFromParent();

    const overlay = new THREE.Group();
    overlay.name = '__layout-solar-overlay';
    const groups = Object.fromEntries(['front', 'solar', 'guardian'].map((name) => {
      const group = new THREE.Group();
      group.name = `layout-${name}`;
      group.visible = selectedLayers.includes(name);
      overlay.add(group);
      return [name, group];
    }));

    const site = plan.site;
    const groundY = (x, z, fallback = 0) => {
      const y = site.heightAt?.(x, z);
      return Number.isFinite(y) ? y : fallback;
    };
    const worldPoint = (parcel, local) => {
      const front = parcel.frontDir || { x: 0, z: 1 };
      const length = Math.hypot(front.x, front.z) || 1;
      const fx = front.x / length, fz = front.z / length;
      const rx = fz, rz = -fx;
      return {
        x: parcel.center.x + rx * local.x + fx * local.z,
        z: parcel.center.z + rz * local.x + fz * local.z,
      };
    };
    const markDebugMaterial = (material) => {
      material.depthTest = false;
      material.depthWrite = false;
      material.transparent = true;
      return material;
    };
    const prepare = (object) => {
      object.renderOrder = 10_000;
      object.frustumCulled = false;
      object.traverse?.((child) => {
        child.renderOrder = 10_000;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) if (material) markDebugMaterial(material);
      });
      return object;
    };

    for (const parcel of plan.parcels || []) {
      if (!parcel?.center || !parcel?.frontDir) continue;
      const parcelId = parcel.id;
      const baseY = Number.isFinite(parcel.baseY)
        ? parcel.baseY : groundY(parcel.center.x, parcel.center.z);

      const frontGroup = new THREE.Group();
      frontGroup.userData.parcelId = parcelId;
      const frontLength = Math.min(8, Math.max(3.5, (parcel.plotD || 12) * 0.42));
      const southDot = parcel.frontDir.z / (Math.hypot(parcel.frontDir.x, parcel.frontDir.z) || 1);
      const color = southDot >= Math.cos(Math.PI / 4)
        ? 0x28f0c8 : southDot >= Math.cos(Math.PI / 3) ? 0xffc857 : 0xff5b69;
      frontGroup.add(prepare(new THREE.ArrowHelper(
        new THREE.Vector3(parcel.frontDir.x, 0, parcel.frontDir.z).normalize(),
        new THREE.Vector3(parcel.center.x, baseY + 1.3, parcel.center.z),
        frontLength, color, Math.min(1.7, frontLength * 0.3), Math.min(0.9, frontLength * 0.17),
      )));
      groups.front.add(frontGroup);

      const corridor = parcel.solarAccess;
      if (!corridor) continue;
      const localCorners = [
        { x: -corridor.halfWidth, z: corridor.localStart },
        { x: corridor.halfWidth, z: corridor.localStart },
        { x: corridor.halfWidth, z: corridor.localEnd },
        { x: -corridor.halfWidth, z: corridor.localEnd },
      ];
      const corners = localCorners.map((local) => {
        const point = worldPoint(parcel, local);
        return new THREE.Vector3(point.x, groundY(point.x, point.z, baseY) + 1.0, point.z);
      });
      const solarGroup = new THREE.Group();
      solarGroup.userData.parcelId = parcelId;
      const fillGeometry = new THREE.BufferGeometry().setFromPoints(corners);
      fillGeometry.setIndex([0, 1, 2, 0, 2, 3]);
      fillGeometry.computeVertexNormals();
      solarGroup.add(prepare(new THREE.Mesh(fillGeometry, new THREE.MeshBasicMaterial({
        color: 0xffd45e, opacity: 0.14, side: THREE.DoubleSide,
      }))));
      solarGroup.add(prepare(new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(corners),
        new THREE.LineBasicMaterial({ color: 0xffe07a, opacity: 0.92 }),
      )));
      groups.solar.add(solarGroup);
    }

    for (const guardian of plan.features?.guardianTrees || []) {
      if (!Number.isFinite(guardian.x) || !Number.isFinite(guardian.z)) continue;
      const radius = Math.max(0.5, guardian.radius || 1);
      const points = [];
      for (let i = 0; i < 64; i++) {
        const angle = i / 64 * Math.PI * 2;
        const x = guardian.x + Math.cos(angle) * radius;
        const z = guardian.z + Math.sin(angle) * radius;
        points.push(new THREE.Vector3(x, groundY(x, z) + 1.15, z));
      }
      const marker = new THREE.Group();
      marker.userData.guardian = true;
      marker.add(prepare(new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xef6dff, opacity: 0.95 }),
      )));
      const y = groundY(guardian.x, guardian.z) + 1.2;
      marker.add(prepare(new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0), new THREE.Vector3(guardian.x, y, guardian.z),
        Math.max(6, radius * 0.85), 0xef6dff, 1.4, 0.8,
      )));
      groups.guardian.add(marker);
    }

    // A fixed north/south legend in the northwest of the plan makes the top shot
    // self-explanatory: this long cyan arrow always points toward canonical +z south.
    const R = plan.siteR || site.R || 100;
    const center = site.center || { x: 0, z: 0 };
    const legendX = center.x - R * 0.72, legendZ = center.z - R * 0.72;
    const legendY = groundY(legendX, legendZ) + 2;
    const southLegend = prepare(new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(legendX, legendY, legendZ),
      R * 0.22, 0x3cb8ff, R * 0.045, R * 0.025,
    ));
    southLegend.userData.legend = true;
    groups.front.add(southLegend);

    engine.scene.add(overlay);
    let focusedParcelId = null;
    const syncParcelVisibility = () => {
      for (const layerName of ['front', 'solar']) {
        for (const child of groups[layerName].children) {
          child.visible = !focusedParcelId || child.userData.legend || child.userData.parcelId === focusedParcelId;
        }
      }
    };
    window.__layoutSolarOverlay = {
      group: overlay,
      setVisible(value) { overlay.visible = !!value; return overlay.visible; },
      setLayer(name, value) {
        if (!groups[name]) return false;
        groups[name].visible = !!value;
        return groups[name].visible;
      },
      focus(parcelId = null) { focusedParcelId = parcelId; syncParcelVisibility(); },
      state() {
        return {
          visible: overlay.visible,
          focusedParcelId,
          layers: Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, group.visible])),
        };
      },
    };
    syncParcelVisibility();
    overlay.visible = false;
    return {
      parcels: (plan.parcels || []).length,
      guardians: (plan.features?.guardianTrees || []).length,
      arrows: groups.front.children.length - 1,
      corridors: groups.solar.children.length,
      layers: selectedLayers,
    };
  }, {
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
    selectedLayers: layers,
  });
  console.log(`overlay: ${JSON.stringify(overlayStats)}`);

  const candidates = await page.evaluate((requestedParcelId) => {
    const root = window.__engine.village.exportRoot();
    const plan = root.userData.plan;
    const editable = new Set(window.__engine.village.debugParcels()
      .filter((parcel) => parcel.editable && !parcel.hero).map((parcel) => parcel.parcelId));
    const treeOwners = new Set((root.userData.yardTreeAnchors || []).map((anchor) => anchor.parcelId));
    const regular = (plan.parcels || []).filter((parcel) => editable.has(parcel.id));
    const choose = (kind) => regular.find((parcel) => parcel.kind === kind && treeOwners.has(parcel.id))
      || regular.find((parcel) => parcel.kind === kind);
    const requested = requestedParcelId
      ? (plan.parcels || []).find((parcel) => parcel.id === requestedParcelId)
      : null;
    return {
      giwa: choose('giwa')?.id || null,
      choga: choose('choga')?.id || null,
      parcel: requested ? {
        id: requested.id,
        kind: requested.kind,
        hero: !!requested.hero,
        hasTree: treeOwners.has(requested.id),
      } : null,
    };
  }, layoutParcel);
  const wants = (name) => sceneFilter === 'all'
    || sceneFilter === name
    || (sceneFilter === 'focus' && (name === 'giwa' || name === 'choga'));
  if ((wants('giwa') && !candidates.giwa) || (wants('choga') && !candidates.choga)) {
    throw new Error(`missing representative layout candidates: ${JSON.stringify(candidates)}`);
  }
  if (sceneFilter === 'parcel' && !candidates.parcel) {
    throw new Error(`missing requested layout parcel: ${layoutParcel}`);
  }
  console.log(`focus candidates: ${JSON.stringify(candidates)}`);
  const overlayStates = overlayMode === 'both'
    ? [{ name: 'clean', visible: false }, { name: 'overlay', visible: true }]
    : [{ name: overlayMode === 'on' ? 'overlay' : 'clean', visible: overlayMode === 'on' }];

  const renderAndCapture = async (sceneName, state) => {
    const snapshot = await page.evaluate(({ visible }) => {
      const engine = window.__engine;
      window.__layoutSolarOverlay.setVisible(visible);
      engine.debugTuneDof({ amount: 0 });
      engine.debugRenderDofFrame();
      return {
        overlay: window.__layoutSolarOverlay.state(),
        camera: engine.cine.debugCam(),
        dof: engine.debugDof(),
      };
    }, state);
    const path = join(outputDir, `${sceneName}-${state.name}.png`);
    await page.locator('canvas').screenshot({ path });
    console.log(`${path} ${JSON.stringify(snapshot)}`);
  };

  const setOverview = async (kind) => page.evaluate((view) => {
    const engine = window.__engine;
    const plan = engine.village.exportRoot().userData.plan;
    const site = plan.site;
    const center = site.center || { x: 0, z: 0 };
    const R = plan.siteR || site.R || 100;
    const y = site.heightAt?.(center.x, center.z) || 0;
    engine.debugSetPaused(true);
    window.__layoutSolarOverlay.focus(null);
    engine.__controls.enabled = false;
    engine.__controls.target.set(center.x, y, center.z);
    engine.camera.clearViewOffset();
    if (view === 'top') {
      engine.camera.up.set(0, 0, -1);
      engine.camera.fov = 52;
      engine.camera.position.set(center.x, y + R * 2.42, center.z);
    } else {
      engine.camera.up.set(0, 1, 0);
      engine.camera.fov = 44;
      engine.camera.position.set(center.x + R * 0.5, y + R * 0.95, center.z + R * 1.72);
      engine.__controls.target.set(center.x, y + R * 0.05, center.z - R * 0.14);
    }
    engine.camera.near = 0.5;
    engine.camera.far = Math.max(engine.camera.far, R * 8);
    engine.camera.lookAt(engine.__controls.target);
    engine.camera.updateProjectionMatrix();
    engine.camera.updateMatrixWorld(true);
  }, kind);

  for (const view of ['top', 'aerial']) {
    if (!wants(view)) continue;
    await setOverview(view);
    for (const state of overlayStates) await renderAndCapture(view, state);
  }

  const beginAndSeek = async (method, parcelId) => page.evaluate(async ({ method, parcelId }) => {
    const engine = window.__engine;
    engine.debugSetPaused(false);
    engine.__controls.enabled = true;
    engine.camera.up.set(0, 1, 0);
    engine.village[method](parcelId);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const sampled = engine.debugDofSeek(1, { finish: true });
    if (!sampled) throw new Error(`${method} transition did not start for ${parcelId}`);
    engine.setWeather('clear');
    engine.setSeason('summer', { immediate: true });
    engine.setTime('day', { immediate: true });
    engine.debugAdvanceFocusRing(3.2);
    engine.debugAdvancePost(2.0);
    engine.debugSetPaused(true);
    window.__layoutSolarOverlay.focus(parcelId);
    window.__layoutSolarOverlay.setVisible(false);
    return sampled;
  }, { method, parcelId });

  const inspectOcclusion = async (parcelId) => page.evaluate(async ({ parcelId, threeModuleUrl }) => {
    const THREE = await import(threeModuleUrl);
    const engine = window.__engine;
    const root = engine.village.exportRoot();
    const overlay = window.__layoutSolarOverlay.group;
    const camera = engine.camera;
    camera.updateMatrixWorld(true);
    engine.scene.updateMatrixWorld(true);

    const isPresented = (object) => {
      for (let current = object; current; current = current.parent) {
        if (current === overlay || current.visible === false) return false;
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      return materials.every((material) => !material || material.visible !== false);
    };
    const ancestryOf = (object) => {
      const ancestry = [];
      for (let current = object; current && ancestry.length < 7; current = current.parent) {
        const data = current.userData || {};
        ancestry.push({
          name: current.name || null,
          type: current.type,
          parcelId: data.parcelId || null,
          ownerParcelId: data.ownerParcelId || null,
          role: data.role || null,
          kind: data.kind || null,
        });
      }
      return ancestry;
    };
    const declaredOwners = (ancestry) => {
      const owners = [];
      for (const item of ancestry) {
        const name = item.name || '';
        const fromName = /^(?:override|parcel)-(.+)$/.exec(name)?.[1]
          || /^hero-(p\d+)(?:-|$)/.exec(name)?.[1] || null;
        for (const value of [item.parcelId, item.ownerParcelId, fromName]) {
          if (value && !owners.includes(value)) owners.push(value);
        }
      }
      return owners;
    };
    const materialOf = (object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      return materials.filter(Boolean).slice(0, 3).map((material) => ({
        name: material.name || null,
        type: material.type,
        role: material.userData?.role || null,
        color: material.color?.getHexString?.() || null,
        opacity: Number.isFinite(material.opacity) ? +material.opacity.toFixed(3) : null,
      }));
    };
    const inferredOwners = (point) => {
      const candidates = [];
      for (const anchor of root.userData.yardTreeAnchors || []) {
        const distance = Math.hypot(point.x - anchor.x, point.z - anchor.z);
        const radius = anchor.radius || 0;
        if (distance <= radius + 1.5) candidates.push({
          layer: 'yardTree', parcelId: anchor.parcelId || null,
          species: anchor.species || null, distance: +distance.toFixed(2), radius: +radius.toFixed(2),
        });
      }
      for (const anchor of root.userData.guardianAnchors || []) {
        const distance = Math.hypot(point.x - anchor.x, point.z - anchor.z);
        const radius = anchor.r || 0;
        if (distance <= radius + 1.5) candidates.push({
          layer: 'guardian', parcelId: null, species: null,
          distance: +distance.toFixed(2), radius: +radius.toFixed(2),
        });
      }
      return candidates.sort((a, b) => a.distance - b.distance).slice(0, 3);
    };
    const summarize = (raycaster, targetDistance) => raycaster
      .intersectObjects(engine.scene.children, true)
      .filter((hit) => isPresented(hit.object) && (hit.object.isMesh || hit.object.isInstancedMesh))
      .filter((hit) => hit.distance < targetDistance - 0.05)
      .slice(0, 8)
      .map((hit) => {
        const ancestry = ancestryOf(hit.object);
        return {
          distance: +hit.distance.toFixed(2),
          targetDistance: +targetDistance.toFixed(2),
          object: hit.object.name || hit.object.type,
          type: hit.object.type,
          instanceId: hit.instanceId ?? null,
          point: { x: +hit.point.x.toFixed(2), y: +hit.point.y.toFixed(2), z: +hit.point.z.toFixed(2) },
          ancestry,
          declaredOwners: declaredOwners(ancestry),
          materials: materialOf(hit.object),
          inferredOwners: inferredOwners(hit.point),
        };
      });

    const focusTarget = engine.__controls.target.clone();
    const targetDirection = focusTarget.clone().sub(camera.position);
    const targetDistance = targetDirection.length();
    const targetRay = new THREE.Raycaster(
      camera.position.clone(), targetDirection.normalize(), camera.near, targetDistance,
    );
    // Sprite.raycast reads raycaster.camera even when the ray was constructed directly.
    targetRay.camera = camera;
    const centerRay = new THREE.Raycaster();
    centerRay.setFromCamera(new THREE.Vector2(0, 0), camera);
    centerRay.near = camera.near;
    centerRay.far = targetDistance;
    const sampleRays = [
      ['center', 0, 0], ['left', -0.3, 0], ['right', 0.3, 0],
      ['lower', 0, -0.32], ['lowerLeft', -0.3, -0.32], ['lowerRight', 0.3, -0.32],
    ].map(([name, x, y]) => {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      raycaster.near = camera.near;
      raycaster.far = targetDistance;
      return { name, ndc: { x, y }, blockers: summarize(raycaster, targetDistance).slice(0, 2) };
    });
    const potentialForeignBlockers = sampleRays.flatMap((sample) => {
      const blocker = sample.blockers[0];
      if (!blocker || blocker.distance >= targetDistance * 0.9) return [];
      const owners = [...blocker.declaredOwners,
        ...blocker.inferredOwners.map((owner) => owner.parcelId).filter(Boolean)];
      if (owners.includes(parcelId)) return [];
      return [{
        sample: sample.name,
        object: blocker.object,
        distance: blocker.distance,
        targetDistance: blocker.targetDistance,
        owners,
        ancestry: blocker.ancestry.map((item) => item.name || item.type),
        inferredOwners: blocker.inferredOwners,
      }];
    });
    return {
      parcelId,
      camera: {
        x: +camera.position.x.toFixed(2), y: +camera.position.y.toFixed(2), z: +camera.position.z.toFixed(2),
      },
      focusTarget: {
        x: +focusTarget.x.toFixed(2), y: +focusTarget.y.toFixed(2), z: +focusTarget.z.toFixed(2),
        distance: +targetDistance.toFixed(2),
      },
      centerBlockers: summarize(centerRay, targetDistance),
      targetBlockers: summarize(targetRay, targetDistance),
      sampledFrameBlockers: sampleRays,
      potentialForeignBlockers,
    };
  }, {
    parcelId,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
  });

  let focused = false;
  const occlusionReports = [];
  for (const kind of ['giwa', 'choga']) {
    if (!wants(kind)) continue;
    await beginAndSeek(focused ? 'switchTo' : 'focus', candidates[kind]);
    focused = true;
    const report = await inspectOcclusion(candidates[kind]);
    occlusionReports.push({ kind, ...report });
    console.log(`${kind} occlusion: ${JSON.stringify(report)}`);
    for (const state of overlayStates) await renderAndCapture(`${kind}-focus`, state);
  }
  if (sceneFilter === 'parcel') {
    const target = candidates.parcel;
    await beginAndSeek('focus', target.id);
    const report = await inspectOcclusion(target.id);
    occlusionReports.push({ kind: target.kind, requested: true, ...report });
    console.log(`parcel occlusion: ${JSON.stringify(report)}`);
    for (const state of overlayStates) await renderAndCapture(`${target.id}-focus`, state);
  }

  const diagnosticsPath = join(outputDir, 'occlusion.json');
  await writeFile(diagnosticsPath, `${JSON.stringify({
    reproduceQuery, overlayMode, sceneFilter, overlayStats, candidates, occlusionReports,
  }, null, 2)}\n`);
  console.log(`occlusion diagnostics: ${diagnosticsPath}`);
  console.log(`LAYOUT SOLAR SHOTS: ${outputDir}`);
  console.log(`runtime errors: ${errors.length}`);
  for (const error of errors) console.log(error);
  if (errors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
