// Full-app browser smoke: app bootstrap → village → focus wiring.
// Uses an isolated Vite cache and ephemeral port, leaving any user dev server untouched.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-app-smoke-'));
const timeout = Number(process.env.CHEOMA_APP_SMOKE_TIMEOUT_MS) || 90_000;
const FOOTWEAR_REFERENCE_URLS = Object.freeze([
  'https://iksan.museum.go.kr/site/kor/html/sub04/0402.html?cate_code=&cate_gubun=&id=PS0100101400100019700000&mode=V',
  'https://iksan.museum.go.kr/site/kor/html/sub04/0402.html?cate_code=&cate_gubun=&id=PS0100101400000297500000&mode=V',
  'https://www.museum.go.kr/MUSEUM/contents/M0501000000.do?pageSize=10&relicRecommendCategory=&relicRecommendId=165924&sc=&schM=view&sv=',
  'https://www.korea.net/koreanet/fileDownload?fileUrl=FILE%2FPDF%2Fgeneral%2F201209_liveinkorea_en.pdf',
]);
const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
let runtimeErrors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=20260716&time=day&lang=ko`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.debugPlan(), null, { timeout });
  await reportWebGLRenderer(page, 'app-smoke');

  // docs/credits.md is the public product-reference source of truth.  Verify the
  // newly applied house-plan and legal-limit evidence reaches the actual modal,
  // including authoritative links and the non-literal-use qualification.
  await page.locator('button.info[aria-label="참고 자료"]').click();
  const referenceDialog = page.locator('[role="dialog"][aria-label="참고 자료"]');
  await referenceDialog.waitFor({ state: 'visible', timeout });
  const reference = await referenceDialog.evaluate((dialog) => ({
    text: dialog.textContent.replace(/\s+/g, ' ').trim(),
    links: [...dialog.querySelectorAll('a')].map((anchor) => anchor.href),
    items: [...dialog.querySelectorAll('li')].map((item) => ({
      title: item.querySelector('.it-title')?.textContent?.trim() || '',
      text: item.textContent.replace(/\s+/g, ' ').trim(),
      links: [...item.querySelectorAll('a')].map((anchor) => anchor.href),
      license: item.querySelector('.it-license')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    })),
  }));
  pass(reference.text.includes('국가한옥센터(AURI) 한옥DB — 한옥의 종류·한옥이론')
      && reference.text.includes('ㅡ·ㄱ·ㄷ·ㅁ')
      && reference.text.includes('앱의 칸·충돌 안전 범위')
      && reference.text.includes('역사적 빈도나 보편 비례가 아닌')
      && reference.links.some((url) => url.includes('hanokdb.kr/theology/sub_02')),
  'National Hanok Center semantic-slot evidence and non-historical safety bounds render in Product References');
  pass(reference.text.includes('출입용 호와 채광·조망·환기용 창')
      && reference.text.includes('창 하부 머름 apron/rail')
      && reference.text.includes('lowerPanel')
      && reference.links.some((url) => url.includes('hanokdb.kr/theology/sub_04')),
  'National Hanok Center opening facts and applied lightweight grammar render in Product References');
  const auriNight = reference.items.find((item) => item.title.includes('국가한옥센터(AURI) 한옥DB'));
  const folkNight = reference.items.find((item) => item.title.includes('빛으로 밝히고 조명으로 통하다'));
  pass(auriNight?.text.includes('창호지를 실내 쪽에 붙이고')
      && auriNight.text.includes('실제 고정 한지 면')
      && auriNight.text.includes('주간 채광 설명을 밤의 정확한 외부 밝기·색·점등 빈도로 확대하지 않는다')
      && auriNight.links.some((url) => url.includes('hanokdb.kr/theology/sub_03'))
      && auriNight.license.includes('All rights reserved'),
  'AURI hanji-plane evidence, limit, canonical link, and license stay in one Reference item');
  pass(folkNight?.text.includes('작은 연소 광원')
      && folkNight.text.includes('일부 거주 창호만 seed-stable하게 켜고 어두운 방')
      && folkNight.text.includes('정확한 색·밝기·flicker·점등 비율은 사료값이 아니라')
      && folkNight.text.includes('깊이 가림')
      && folkNight.links.some((url) => url.includes('webzine.nfm.go.kr/2018/09/06/'))
      && folkNight.license.includes('원문·전시 사진은 재배포하지 않는다'),
  'folk-light vocabulary, product limits, canonical link, and license stay in one Reference item');
  pass(reference.text.includes('법적 상한·규범')
      && reference.text.includes('17배 필지 비례')
      && reference.links.some((url) => url.includes('contents.history.go.kr/front/km/view.do')),
  'enhanced house/lot legal-limit evidence and non-literal use render in Product References');
  pass(reference.text.includes('Wikimedia Commons · Bernard Gagnon — 낙안읍성 흙길·마당')
      && reference.text.includes('사진 픽셀이나 자국을 복제하지 않고')
      && reference.links.some((url) => url.includes('Naganeupseong_Village_06.jpg'))
      && reference.links.some((url) => url.includes('Naganeupseong_Village_08.jpg')),
  'packed-earth visual evidence, non-copying use, and CC0 source links render in Product References');
  await referenceDialog.locator('button[aria-label="닫기"]').click();

  // __SHOT_READY는 렌더 준비 신호이지 1.4초 진입 돌리의 완료 신호가 아니다. 실제 제품 tween의
  // onDone을 결정적으로 실행해 explore 줌 범위가 설치된 상태에서 보기 계약을 검사한다.
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });

  const boot = await page.evaluate(() => {
    const engine = window.__engine;
    return {
      state: engine.getState(),
      village: engine.village.getState(),
      plan: engine.village.debugPlan(),
      continuum: engine.village.debugContinuum(),
      camera: engine.village.debugCamera(),
      sceneChildren: engine.scene.children.length,
      canvas: {
        width: engine.renderer.domElement.width,
        height: engine.renderer.domElement.height,
      },
    };
  });
  pass(boot.village.active, 'village mode becomes active');
  pass(boot.plan.seed === 20260716 && boot.plan.scale === 'village', 'URL seed and scale reach the planner');
  pass(boot.plan.houses > 0 && boot.sceneChildren > 0, 'village scene contains planned houses and scene objects');
  pass(boot.canvas.width > 0 && boot.canvas.height > 0, 'renderer owns a sized canvas');
  pass(
    boot.continuum.aerialDist > 0
      && boot.continuum.mode === 'explore'
      && boot.continuum.exploreMinReferenceDist < boot.continuum.aerialReferenceDist
      && boot.continuum.exploreMaxReferenceDist >= boot.continuum.aerialReferenceDist
      && Number.isFinite(boot.camera.near),
    'village camera exposes valid aerial, zoom, and near-plane contracts',
  );

  const diversityRuntime = await page.evaluate(async ({ housesModuleUrl }) => {
    const parcels = window.__engine.village.debugParcels();
    const mirrored = parcels.find((parcel) => parcel.kind === 'giwa' && parcel.variant === 1);
    const mirrorStats = mirrored
      ? window.__engine.village.debugParcelStats(mirrored.parcelId, {})
      : null;

    const { buildKindDecomps } = await import(housesModuleUrl);
    const { decomps, matset } = buildKindDecomps('giwa');
    const canonical = new Set(decomps[0].map((entry) => entry.material));
    const allMaterials = new Set(decomps.flatMap((decomp) => decomp.map((entry) => entry.material)));
    const allTextures = new Set();
    for (const material of allMaterials) {
      for (const value of Object.values(material)) if (value?.isTexture) allTextures.add(value);
    }
    for (const value of Object.values(matset || {})) {
      if (value?.isTexture) allTextures.add(value);
      if (value?.isMaterial) {
        allMaterials.add(value);
        for (const property of Object.values(value)) if (property?.isTexture) allTextures.add(property);
      }
    }
    const result = {
      mirroredId: mirrored?.parcelId || null,
      mirrorX: mirrorStats?.mirrorX ?? null,
      lengths: decomps.map((decomp) => decomp.length),
      shared: decomps.map((decomp) => decomp.filter((entry) => canonical.has(entry.material)).length),
      hardwareEntries: decomps.map((decomp) => decomp.filter((entry) => (
        entry.material?.userData?.paletteKey === 'hardware'
      )).length),
      hardwareMaterials: new Set(decomps.flatMap((decomp) => decomp
        .filter((entry) => entry.material?.userData?.paletteKey === 'hardware')
        .map((entry) => entry.material))).size,
      hardwareEnvelope: decomps.some((decomp) => decomp.some((entry) => (
        entry.material?.userData?.paletteKey === 'hardware'
          && entry.material?.userData?.lodEnvelope === true
      ))),
      materials: allMaterials.size,
      textures: allTextures.size,
    };
    for (const decomp of decomps) for (const entry of decomp) entry.geometry.dispose();
    for (const texture of allTextures) texture.dispose();
    for (const material of allMaterials) material.dispose();
    return result;
  }, { housesModuleUrl: `/@fs${join(ROOT, 'src/generators/village/houses.js')}` });
  pass(diversityRuntime.mirroredId != null && diversityRuntime.mirrorX === -1,
    'mirrored L-plan stays mirrored in the real focus/edit overlay');
  const semanticSharing = diversityRuntime.shared[2] >= Math.floor(diversityRuntime.lengths[2] * 0.45)
    && diversityRuntime.shared[3] >= Math.floor(diversityRuntime.lengths[3] * 0.45)
    && diversityRuntime.materials <= 120
    && diversityRuntime.textures <= 60;
  pass(semanticSharing,
    `single/U topology reuses semantic palette resources (${JSON.stringify(diversityRuntime)})`);
  pass(
    diversityRuntime.hardwareEntries.every((count) => count === 1)
      && diversityRuntime.hardwareMaterials === 1
      && !diversityRuntime.hardwareEnvelope,
    `one shared ironwork group remains FULL-only across house topology (${JSON.stringify(diversityRuntime)})`,
  );

  await page.evaluate((parcelId) => {
    const engine = window.__engine;
    engine.village.debugFocus(parcelId);
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  }, diversityRuntime.mirroredId);
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, diversityRuntime.mirroredId, { timeout });
  const initialOpening = await page.evaluate((parcelId) => (
    window.__engine.village.debugOpeningDetail(parcelId)
  ), diversityRuntime.mirroredId);
  pass(initialOpening?.valid && initialOpening.plan?.primary
      && initialOpening.thresholdLifeBatch === 1
      && initialOpening.plan.hardware === 3
      && initialOpening.plan.meoreum === 0
      && initialOpening.plan.lowerPanel > 0
      && initialOpening.plan.pivot && initialOpening.plan.footwear,
  `focused overlay owns one reusable primary opening contract (${JSON.stringify(initialOpening)})`);
  const houseTabs = page.locator('.ctx.house:not([aria-hidden="true"]) .tabs .tab');
  await houseTabs.filter({ hasText: '초가' }).click();
  await page.waitForFunction(() => window.__engine.village.getState().spec?.kind === 'choga', null, { timeout });
  const chogaSwitch = await page.evaluate(() => {
    const engine = window.__engine;
    const state = engine.village.getState();
    const panel = document.querySelector('.ctx.house:not([aria-hidden="true"])');
    const column = panel?.querySelector('input[data-key="columnHeight"]');
    return {
      spec: state.spec,
      columnValue: Number(column?.value),
      columnMax: Number(column?.max),
      keys: [...(panel?.querySelectorAll('[data-key]') || [])].map((element) => element.dataset.key),
      activeType: panel?.querySelector('.tabs .tab.on')?.textContent?.replace(/\s+/g, ' ').trim(),
      opening: engine.village.debugOpeningDetail(state.selected),
    };
  });
  pass(chogaSwitch.spec.params.columnHeight === 1.95
      && chogaSwitch.spec.params.wallType === 'stone'
      && chogaSwitch.columnValue === 1.95
      && chogaSwitch.columnValue <= chogaSwitch.columnMax
      && !chogaSwitch.keys.some((key) => ['mainHalfW', 'wingLen', 'wingW'].includes(key))
      && chogaSwitch.activeType?.includes('초가')
      && chogaSwitch.opening?.valid && chogaSwitch.opening.thresholdLifeBatch === 1
      && chogaSwitch.opening.plan?.style === 'choga'
      && chogaSwitch.opening.plan.hardware === 3,
  `giwa→choga switch reseeds target defaults and accepted UI values (${JSON.stringify(chogaSwitch)})`);
  await houseTabs.filter({ hasText: '기와집' }).click();
  await page.waitForFunction(() => window.__engine.village.getState().spec?.kind === 'giwa', null, { timeout });
  const restoredType = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const spec = engine.village.getState().spec;
    const panel = document.querySelector('.ctx.house:not([aria-hidden="true"])');
    const result = {
      kind: spec?.kind,
      columnHeight: spec?.params?.columnHeight,
      mainHalfWMin: Number(panel?.querySelector('input[data-key="mainHalfW"]')?.min),
      mirrorX: engine.village.debugParcelStats(parcelId, { kind: 'giwa' })?.mirrorX,
      opening: engine.village.debugOpeningDetail(parcelId),
    };
    engine.village.return();
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    return result;
  }, diversityRuntime.mirroredId);
  pass(restoredType.kind === 'giwa'
      && restoredType.columnHeight === 2.9
      && Math.abs(restoredType.mainHalfWMin - 3.3) < 1e-9
      && restoredType.mirrorX === -1
      && restoredType.opening?.valid && restoredType.opening.thresholdLifeBatch === 1
      && restoredType.opening.plan?.style === 'giwa'
      && restoredType.opening.plan.hardware === 3,
  `choga→giwa switch restores fitted variant defaults and mirror (${JSON.stringify(restoredType)})`);

  const zoomModes = await page.evaluate(async () => {
    const engine = window.__engine;
    window.__noWarm = true;
    const parcelId = engine.village.debugParcels()[0]?.parcelId;
    if (!parcelId) throw new Error('zoom mode fixture has no parcel');
    const frames = (count = 8) => new Promise((resolve) => {
      const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const drainTransition = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
      const sample = engine.debugDofSeek(1, { finish: true });
      if (!sample) throw new Error('explicit view transition did not start');
    };

    const exploreStart = engine.village.debugContinuum();
    const exploreDistance = engine.village.debugDolly(0.20, parcelId);
    await frames();
    const exploreNear = {
      state: engine.village.getState(),
      continuum: engine.village.debugContinuum(),
      minDistance: engine.__controls.minDistance,
    };

    const expectedFocus = engine.village.heroId();
    document.querySelector('.mode .seg:last-child')?.click();
    await drainTransition();
    const focusStart = engine.village.debugContinuum();
    const focusDistance = engine.village.debugDolly(0.99);
    await frames();
    const focusWide = {
      state: engine.village.getState(),
      continuum: engine.village.debugContinuum(),
      maxDistance: engine.__controls.maxDistance,
      labels: [...document.querySelectorAll('.mode .seg')]
        .map((button) => button.textContent.replace(/\s+/g, ' ').trim()),
    };

    engine.village.return();
    await drainTransition();
    const returned = engine.village.getState();
    return { parcelId, expectedFocus, exploreStart, exploreDistance, exploreNear, focusStart, focusDistance, focusWide, returned };
  });
  pass(zoomModes.exploreNear.state.selected == null
      && zoomModes.exploreNear.continuum.mode === 'explore'
      && zoomModes.exploreNear.minDistance <= zoomModes.exploreDistance + 0.2,
  'deep wheel-equivalent zoom keeps free village exploration instead of selecting the center house');
  const focusWideOk = zoomModes.focusWide.state.active
      && zoomModes.focusWide.state.selected === zoomModes.expectedFocus
      && zoomModes.focusWide.state.transitioning === false
      && zoomModes.focusWide.continuum.mode === 'focus'
      && zoomModes.focusWide.continuum.focusEffectWeight <= 0.05
      && zoomModes.focusWide.continuum.elevation >= 29
      && zoomModes.focusWide.maxDistance >= zoomModes.focusDistance - 0.2;
  pass(focusWideOk,
  `direct-village house view preserves selection while retiring close-up bokeh${focusWideOk ? '' : ` (${JSON.stringify(zoomModes.focusWide)})`}`);
  pass(zoomModes.focusWide.labels.some((label) => label.includes('둘러보기'))
      && zoomModes.focusWide.labels.some((label) => label.includes('집 보기'))
      && zoomModes.returned.selected == null,
  'view controls name the two intents and only an explicit return leaves house view');

  const fallbackContract = await page.evaluate(async ({ environmentModuleUrl, threeModuleUrl }) => {
    const [{ captureEnvironmentFallback, restoreEnvironmentFallback }, THREE] = await Promise.all([
      import(environmentModuleUrl),
      import(threeModuleUrl),
    ]);
    const scene = new THREE.Scene();
    const background = new THREE.Texture();
    const fog = new THREE.FogExp2(new THREE.Color().setRGB(0.12, 0.34, 0.56), 0.0123);
    scene.background = background;
    scene.fog = fog;
    const sun = new THREE.DirectionalLight();
    sun.position.set(2.5, 4.5, -7.5);
    sun.color.setRGB(0.17, 0.43, 0.81);
    sun.intensity = 2.37;
    const hemi = new THREE.HemisphereLight();
    hemi.color.setRGB(0.21, 0.38, 0.62);
    hemi.groundColor.setRGB(0.51, 0.27, 0.13);
    hemi.intensity = 0.73;
    const renderer = { toneMappingExposure: 1.17 };
    const original = {
      fogColor: fog.color.clone(), fogDensity: fog.density,
      sunPosition: sun.position.clone(), sunColor: sun.color.clone(), sunIntensity: sun.intensity,
      hemiSky: hemi.color.clone(), hemiGround: hemi.groundColor.clone(), hemiIntensity: hemi.intensity,
      exposure: renderer.toneMappingExposure,
    };
    const fallback = captureEnvironmentFallback(scene, { sun, hemi, renderer });
    scene.background = new THREE.Color(0xffffff);
    scene.fog = new THREE.Fog(0xffffff, 1, 2);
    fog.color.set(0); fog.density = 0.5;
    sun.position.set(0, 0, 0); sun.color.set(0); sun.intensity = 0;
    hemi.color.set(0); hemi.groundColor.set(0); hemi.intensity = 0;
    renderer.toneMappingExposure = 0;
    restoreEnvironmentFallback(scene, { sun, hemi, renderer }, fallback);
    const restored = scene.background === background
      && scene.fog === fog
      && scene.fog.isFogExp2
      && fog.color.equals(original.fogColor)
      && fog.density === original.fogDensity
      && sun.position.equals(original.sunPosition)
      && sun.color.equals(original.sunColor)
      && sun.intensity === original.sunIntensity
      && hemi.color.equals(original.hemiSky)
      && hemi.groundColor.equals(original.hemiGround)
      && hemi.intensity === original.hemiIntensity
      && renderer.toneMappingExposure === original.exposure;
    background.dispose();
    return restored;
  }, {
    environmentModuleUrl: `/@fs${join(ROOT, 'src/env/index.js')}`,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
  });
  pass(fallbackContract, 'environment fallback preserves Texture and FogExp2 identity, type, and exact light values');

  // old/new village roots can legitimately share module-lifetime pad/lantern materials.
  // Scenery handoff must preserve that exact opaque material instead of creating transparent
  // clones/program variants. The fast pure contract covers the full timeline; this browser
  // probe verifies the same ownership rule through Vite's real module graph.
  const waveMaterialContract = await page.evaluate(async ({ waveModuleUrl, threeModuleUrl, resourceModuleUrl }) => {
    const [{ createRerollWave }, THREE, { markSharedResource }] = await Promise.all([
      import(waveModuleUrl),
      import(threeModuleUrl),
      import(resourceModuleUrl),
    ]);
    function fixture() {
      const shared = new THREE.MeshStandardMaterial({
        opacity: 1, transparent: false, depthWrite: true,
        emissive: 0x111111, emissiveIntensity: 0,
      });
      const shaderHook = () => {};
      const cacheKey = () => 'wave-shared-fixture';
      shared.onBeforeCompile = shaderHook;
      shared.customProgramCacheKey = cacheKey;
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const oldRoot = new THREE.Group();
      const newRoot = new THREE.Group();
      const oldPads = new THREE.Group(); oldPads.name = 'village-pads';
      const newPads = new THREE.Group(); newPads.name = 'village-pads';
      const oldMesh = new THREE.Mesh(geometry, shared);
      const newMesh = new THREE.Mesh(geometry, shared);
      oldPads.add(oldMesh); newPads.add(newMesh);
      oldRoot.add(oldPads); newRoot.add(newPads);
      const wave = createRerollWave({ oldRoot, newRoot, duration: 1 });
      const oldClone = oldMesh.material;
      const newClone = newMesh.material;
      let oldCloneDisposals = 0, newCloneDisposals = 0;
      oldClone.addEventListener('dispose', () => { oldCloneDisposals++; });
      newClone.addEventListener('dispose', () => { newCloneDisposals++; });
      return {
        shared, shaderHook, cacheKey, oldPads, newPads, oldMesh, newMesh,
        oldClone, newClone, wave, geometry,
        disposalCounts: () => [oldCloneDisposals, newCloneDisposals],
      };
    }

    const cancel = fixture();
    const opaqueShared = cancel.oldClone === cancel.shared
      && cancel.newClone === cancel.shared
      && cancel.oldClone.onBeforeCompile === cancel.shaderHook
      && cancel.oldClone.customProgramCacheKey === cancel.cacheKey;
    cancel.shared.emissiveIntensity = 0.77; // night-glow updates the shared source during a live wave.
    cancel.wave.seek(0.405);
    const alpha = {
      old: cancel.oldMesh.material.opacity,
      new: cancel.newMesh.material.opacity,
      source: cancel.shared.opacity,
      oldEmission: cancel.oldMesh.material.emissiveIntensity,
      newEmission: cancel.newMesh.material.emissiveIntensity,
    };
    cancel.wave.cancel();
    cancel.wave.cancel();
    const cancelRestored = cancel.oldMesh.material === cancel.shared
      && cancel.newMesh.material === cancel.shared
      && cancel.oldPads.visible && !cancel.newPads.visible
      && cancel.shared.opacity === 1 && !cancel.shared.transparent && cancel.shared.depthWrite
      && cancel.disposalCounts().every((count) => count === 0)
      && cancel.wave.isDone() && cancel.wave.update(0.5) === 1;
    cancel.geometry.dispose(); cancel.shared.dispose();

    const finish = fixture();
    finish.wave.seek(0.405);
    finish.wave.dispose();
    finish.wave.dispose();
    const finishRestored = finish.oldMesh.material === finish.shared
      && finish.newMesh.material === finish.shared
      && !finish.oldPads.visible && finish.newPads.visible
      && finish.shared.opacity === 1 && !finish.shared.transparent && finish.shared.depthWrite
      && finish.disposalCounts().every((count) => count === 0)
      && finish.wave.isDone() && finish.wave.update(0.5) === 1;
    finish.geometry.dispose(); finish.shared.dispose();

    // A module-lifetime material may also have a consumer outside the wave. All three users
    // must retain the same opaque identity throughout the scenery ownership handoff.
    const marked = markSharedResource(new THREE.MeshStandardMaterial({ opacity: 1 }));
    const incoming = new THREE.MeshStandardMaterial({ opacity: 1 });
    const markedGeometry = new THREE.BoxGeometry(1, 1, 1);
    const markedOldRoot = new THREE.Group(), markedNewRoot = new THREE.Group();
    const markedOldPads = new THREE.Group(), markedNewPads = new THREE.Group();
    markedOldPads.name = markedNewPads.name = 'village-pads';
    const markedOldMesh = new THREE.Mesh(markedGeometry, marked);
    const markedNewMesh = new THREE.Mesh(markedGeometry, incoming);
    const externalMesh = new THREE.Mesh(markedGeometry, marked);
    markedOldPads.add(markedOldMesh); markedNewPads.add(markedNewMesh);
    markedOldRoot.add(markedOldPads); markedNewRoot.add(markedNewPads);
    const markedWave = createRerollWave({ oldRoot: markedOldRoot, newRoot: markedNewRoot, duration: 1 });
    markedWave.seek(0.405);
    const markedIdentity = markedOldMesh.material === marked
      && markedOldMesh.material.opacity === 1
      && externalMesh.material === marked && externalMesh.material.opacity === 1;
    markedWave.cancel();
    const markedRestored = markedOldMesh.material === marked && marked.opacity === 1;
    markedGeometry.dispose(); incoming.dispose(); marked.dispose();
    return { opaqueShared, alpha, cancelRestored, finishRestored, markedIdentity, markedRestored };
  }, {
    waveModuleUrl: `/@fs${join(ROOT, 'src/village/wave.js')}`,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
    resourceModuleUrl: `/@fs${join(ROOT, 'src/core/three-resources.js')}`,
  });
  pass(
    waveMaterialContract.opaqueShared
      && waveMaterialContract.alpha.old === 1
      && waveMaterialContract.alpha.new === 1
      && waveMaterialContract.alpha.source === 1
      && waveMaterialContract.alpha.oldEmission === 0.77
      && waveMaterialContract.alpha.newEmission === 0.77
      && waveMaterialContract.cancelRestored
      && waveMaterialContract.finishRestored
      && waveMaterialContract.markedIdentity
      && waveMaterialContract.markedRestored,
    `wave preserves opaque shared materials across exclusive scenery ownership (${JSON.stringify(waveMaterialContract)})`,
  );

  const cinematic = await page.evaluate(() => {
    const { cine } = window.__engine;
    const available = cine.available();
    const droneStarted = cine.start('drone', { pass: 'crane-in' });
    const drone = cine.getState();
    cine.stop();
    const droneStopped = cine.getState();
    const walkStarted = cine.start('walk');
    const walker = cine.debugWalker();
    cine.stop();
    return { available, droneStarted, drone, droneStopped, walkStarted, walker };
  });
  pass(
    cinematic.available && cinematic.droneStarted
      && cinematic.drone.active && cinematic.drone.pass === 'crane-in',
    'cinematic runtime starts a named drone path',
  );
  pass(!cinematic.droneStopped.active, 'cinematic runtime returns control after stop');
  pass(
    cinematic.walkStarted && cinematic.walker
      && Number.isFinite(cinematic.walker.clearance),
    'walk runtime initializes with finite terrain clearance',
  );

  const postOrder = await page.evaluate(() => window.__engine.debugPostPassOrder());
  pass(
    JSON.stringify(postOrder) === JSON.stringify([
      'RenderPass', 'GradePass', 'BokehPass', 'UnrealBloomPass',
      'FlarePass', 'OutlinePass', 'OutputPass',
    ]),
    `post passes preserve the output-last contract (${postOrder.join(' → ')})`,
  );

  const postResolution = await page.evaluate(() => {
    const engine = window.__engine;
    const renderer = engine.renderer;
    const previousRatio = renderer.getPixelRatio();
    const width = renderer.domElement.clientWidth;
    const height = renderer.domElement.clientHeight;
    let state;
    try {
      renderer.setPixelRatio(1.5);
      engine.resize();
      state = engine.debugPostResolution();
    } finally {
      renderer.setPixelRatio(previousRatio);
      engine.resize();
    }
    return {
      ...state,
      expectedWidth: Math.round(width * 1.5),
      expectedHeight: Math.round(height * 1.5),
    };
  });
  pass(
    postResolution.composer.width === postResolution.expectedWidth
      && postResolution.composer.height === postResolution.expectedHeight
      && postResolution.outline.width === postResolution.expectedWidth
      && postResolution.outline.height === postResolution.expectedHeight,
    `composer and outline follow renderer DPR (${postResolution.expectedWidth}×${postResolution.expectedHeight})`,
  );

  const heroId = await page.evaluate(() => window.__engine.village.heroId());
  pass(typeof heroId === 'string' && heroId.length > 0, 'hero parcel is addressable through the app API');
  const focused = await page.evaluate(() => {
    const engine = window.__engine;
    let baseThresholdLife = 0;
    engine.village.exportRoot()?.traverse((object) => {
      if (object.name === 'threshold-life-detail') baseThresholdLife++;
    });
    engine.setTime('night');
    engine.setSeason('autumn');
    engine.setWeather('clear');
    const environment = engine.scene.getObjectByName('environment');
    const motes = environment?.getObjectByName('dustMotes')?.material?.uniforms;
    const sun = engine.scene.children.find((object) => object.isDirectionalLight && object.castShadow);
    const parcelId = engine.village.heroId();
    engine.village.focus(parcelId);
    const state = engine.village.getState();
    const life = engine.village.focusRoot()?.getObjectByName('threshold-life-detail');
    return {
      baseThresholdLife,
      selected: state.selected,
      spec: state.spec,
      overlay: engine.village.debugOverlayBox(state.selected),
      opening: engine.village.debugOpeningDetail(state.selected),
      thresholdLife: life ? {
        count: 1,
        kind: life.userData.thresholdLifePlan?.kind,
        pairs: life.userData.thresholdLifePlan?.items?.length,
        tier: life.userData.openingDetailTier,
        paletteKey: life.material?.userData?.paletteKey,
        envelope: life.material?.userData?.lodEnvelope === true,
        transparent: life.material?.transparent === true,
      } : null,
      // Visible-time changes remain animated: synchronously after the dial event, neither the
      // scene-level sky nor the hidden single-house motes have snapped to the night target yet.
      timeTransitionStart: {
        sunIntensity: sun?.intensity,
        moteIntensity: motes?.uIntensity?.value,
      },
    };
  });
  // Headless ANGLE may produce fewer than one frame per second while linking shaders, so this
  // fast smoke asserts synchronous focus setup rather than wall-clock tween completion.
  pass(focused.selected === heroId && !!focused.spec, 'focus setup targets the requested parcel');
  pass(focused.baseThresholdLife === 0,
    'aerial/static village prototypes own no repeated threshold footwear');
  pass(!!focused.overlay, 'focused parcel exposes a measurable detail overlay');
  pass(focused.opening?.valid
      && focused.opening.plan?.style === 'giwa'
      && focused.opening.plan.hardware === 3
      && focused.opening.plan.meoreum === 0
      && focused.opening.plan.lowerPanel > 0
      && focused.opening.recess === 1
      && focused.opening.door?.hasRecess,
  `representative head house consumes one shared primary opening contract (${JSON.stringify(focused.opening)})`);
  pass(focused.thresholdLife?.count === 1
      && focused.thresholdLife.kind === 'jipsin'
      && focused.thresholdLife.pairs === 2
      && focused.thresholdLife.tier === 'focus'
      && focused.thresholdLife.paletteKey === 'thresholdLife'
      && !focused.thresholdLife.envelope
      && !focused.thresholdLife.transparent,
  `focused residence owns one opaque focus-only footwear batch (${JSON.stringify(focused.thresholdLife)})`);
  pass(
    Math.abs(focused.timeTransitionStart.sunIntensity - 0.9) > 1e-3
      && Math.abs(focused.timeTransitionStart.moteIntensity - 0.5) > 1e-6,
    `visible time changes preserve the sky and ambience crossfade contract (${JSON.stringify(focused.timeTransitionStart)})`,
  );

  // Wait only for the shader-warm handoff, then deterministically finish the real focus tween.
  // Product pointer input remains locked until this same onDone path has installed the focus regime.
  await page.waitForFunction(() => {
    const engine = window.__engine;
    return !engine.village.getState().transitioning || engine.debugDof().tweenProgress != null;
  }, null, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  await page.waitForFunction(() => !window.__engine.village.getState().transitioning, null, { timeout });

  // The representative hero is a walled compound whose inner-hall leaf is
  // legitimately occluded by its south gate. Exercise direct interaction on a
  // regular focused choga where the planned south approach exposes the leaf and
  // the formerly solid host wall now reads as a recessed opening.
  const regularDoorCandidates = await page.evaluate(() => window.__engine.village.debugParcels()
    .filter((parcel) => !parcel.hero && parcel.kind === 'choga')
    .map((parcel) => parcel.parcelId));
  let doorParcelId = null;
  for (const candidate of regularDoorCandidates) {
    await page.evaluate((parcelId) => window.__engine.village.switchTo(parcelId), candidate);
    await page.waitForFunction((parcelId) => {
      const engine = window.__engine;
      return engine.village.getState().selected === parcelId
        && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
    }, candidate, { timeout });
    await page.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await page.waitForFunction((parcelId) => {
      const state = window.__engine.village.getState();
      return state.selected === parcelId && !state.transitioning;
    }, candidate, { timeout });
    if (await page.evaluate((parcelId) => !!window.__engine.village.debugDoorScreen(parcelId), candidate)) {
      doorParcelId = candidate;
      break;
    }
  }
  pass(doorParcelId != null,
    `at least one regular south-focus frame exposes its actual primary leaf (${regularDoorCandidates.join(',')})`);
  if (!doorParcelId) throw new Error('No regular focus frame exposes a primary door action');

  const closedDoor = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const calls = engine.village.debugDrawCalls();
    return {
      state: engine.village.debugDoorInteraction(parcelId),
      screen: engine.village.debugDoorScreen(parcelId),
      programs: engine.renderer.info.programs?.length || 0,
      calls,
    };
  }, doorParcelId);
  pass(closedDoor.state?.valid && closedDoor.state.progress === 0 && !closedDoor.state.targetOpen
      && closedDoor.state.hasRecess && closedDoor.state.recessDepth > 0.03
      && !closedDoor.screen?.behind
      && closedDoor.screen.x > 0 && closedDoor.screen.x < 1280
      && closedDoor.screen.y > 0 && closedDoor.screen.y < 800
      && closedDoor.programs > 0 && closedDoor.calls > 0,
  `focused FULL primary door starts closed at a visible direct target (${JSON.stringify(closedDoor)})`);

  const visibilityGate = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const root = engine.village.focusRoot();
    const panel = root?.getObjectByName('primary-opening-panel');
    const pivot = root?.getObjectByName('primary-door-pivot');
    const originalLayer = pivot?.layers.mask;
    panel.visible = false;
    const hiddenPanel = engine.village.debugDoorScreen(parcelId) == null;
    panel.visible = true;
    pivot.visible = false;
    const hiddenOwner = engine.village.debugDoorScreen(parcelId) == null;
    pivot.visible = true;
    pivot.layers.set(1);
    const layerOwner = engine.village.debugDoorScreen(parcelId) == null;
    pivot.layers.mask = originalLayer;
    root.visible = false;
    const hiddenRoot = engine.village.debugDoorScreen(parcelId) == null;
    root.visible = true;
    return { hiddenPanel, hiddenOwner, layerOwner, hiddenRoot };
  }, doorParcelId);
  pass(Object.values(visibilityGate).every(Boolean),
    `door input follows visible/layer owner state (${JSON.stringify(visibilityGate)})`);

  await page.mouse.move(closedDoor.screen.x, closedDoor.screen.y);
  const doorHover = page.locator('.hlabel');
  await doorHover.waitFor({ state: 'visible', timeout });
  pass((await doorHover.textContent()).includes('문 열기'),
    'actual door hover renders the localized open action in Product UI');

  // `isPrimary` is scoped to a pointer type. A primary touch arriving while a
  // primary mouse gesture owns the door must not overwrite the first pointer's
  // down hit; cancelling that unrelated touch must not cancel the mouse click.
  await page.mouse.down();
  await page.evaluate(({ x, y }) => {
    const canvas = window.__engine.renderer.domElement;
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 17,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
    }));
    canvas.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 17,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 0,
    }));
  }, closedDoor.screen);
  await page.mouse.up();
  const afterCrossTypePointer = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const toggled = engine.village.debugDoorInteraction(parcelId);
    engine.village.debugSeekDoor(0, parcelId);
    return toggled;
  }, doorParcelId);
  pass(afterCrossTypePointer?.targetOpen,
    `a second primary pointer type cannot steal the active door click `
      + `(${JSON.stringify(afterCrossTypePointer)})`);

  // A browser-cancelled pointer sequence must never survive until a later up
  // and toggle the leaf. Exercise the real mouse pointer so OrbitControls also
  // owns/releases pointer capture exactly as it does in production.
  await page.mouse.down();
  await page.evaluate(({ x, y }) => {
    const canvas = window.__engine.renderer.domElement;
    canvas.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
    }));
  }, closedDoor.screen);
  await page.mouse.up();
  const afterPointerCancel = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorInteraction(parcelId)
  ), doorParcelId);
  pass(afterPointerCancel?.progress === 0 && !afterPointerCancel.targetOpen,
    `pointercancel clears the pending door click (${JSON.stringify(afterPointerCancel)})`);

  await page.mouse.down();
  const captureReleased = await page.evaluate(async () => {
    const canvas = window.__engine.renderer.domElement;
    const captured = canvas.hasPointerCapture(1);
    if (captured) canvas.releasePointerCapture(1);
    else canvas.dispatchEvent(new PointerEvent('lostpointercapture', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    return captured;
  });
  await page.mouse.up();
  const afterLostCapture = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorInteraction(parcelId)
  ), doorParcelId);
  pass(afterLostCapture?.progress === 0 && !afterLostCapture.targetOpen,
    `lostpointercapture clears the pending door click (native=${captureReleased}, `
      + `${JSON.stringify(afterLostCapture)})`);

  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  const afterBlur = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorInteraction(parcelId)
  ), doorParcelId);
  pass(afterBlur?.progress === 0 && !afterBlur.targetOpen,
    `window blur clears the pending door click (${JSON.stringify(afterBlur)})`);

  // A pointer sequence that turns into an OrbitControls drag must never toggle the door.
  await page.mouse.down();
  await page.mouse.move(closedDoor.screen.x + 12, closedDoor.screen.y);
  await page.mouse.up();
  const afterDrag = await page.evaluate((parcelId) => ({
    state: window.__engine.village.debugDoorInteraction(parcelId),
    screen: window.__engine.village.debugDoorScreen(parcelId),
  }), doorParcelId);
  pass(afterDrag.state?.progress === 0 && !afterDrag.state.targetOpen,
    `door pointer drag stays an orbit gesture (${JSON.stringify(afterDrag)})`);

  // Down/up must both resolve to the same unobscured moving leaf. Reverse it while
  // moving to prove the spring inherits the exact pose instead of snapping.
  await page.evaluate(() => window.__engine.debugSetPaused(true));
  // OrbitControls damping can keep moving the camera for a few frames after the
  // drag's pointerup. Freeze first, then resolve the click point from that exact
  // frame instead of reusing the pre-freeze projection above.
  const pausedDoorScreen = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorScreen(parcelId)
  ), doorParcelId);
  await page.mouse.click(pausedDoorScreen.x, pausedDoorScreen.y);
  const openingDoor = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const targeted = engine.village.debugDoorInteraction(parcelId);
    const mid = engine.village.debugAdvanceDoor(0.12, parcelId);
    return { targeted, mid, screen: engine.village.debugDoorScreen(parcelId) };
  }, doorParcelId);
  pass(openingDoor.targeted?.targetOpen
      && openingDoor.mid.progress > 0 && openingDoor.mid.progress < 1,
  `direct click starts an interruptible door swing (${JSON.stringify(openingDoor)})`);
  await page.mouse.click(openingDoor.screen.x, openingDoor.screen.y);
  const interruptedDoor = await page.evaluate(({ parcelId, progress }) => {
    const engine = window.__engine;
    const reversed = engine.village.debugDoorInteraction(parcelId);
    const closed = engine.village.debugAdvanceDoor(3, parcelId);
    return { reversed, closed, inheritedError: Math.abs(reversed.progress - progress) };
  }, { parcelId: doorParcelId, progress: openingDoor.mid.progress });
  pass(!interruptedDoor.reversed?.targetOpen && interruptedDoor.inheritedError < 1e-9
      && interruptedDoor.closed.progress === 0 && !interruptedDoor.closed.moving,
  `mid-swing click reverses without a pose snap (${JSON.stringify(interruptedDoor)})`);

  const reopenedScreen = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorScreen(parcelId)
  ), doorParcelId);
  await page.mouse.click(reopenedScreen.x, reopenedScreen.y);
  const openDoor = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const state = engine.village.debugAdvanceDoor(3, parcelId);
    const root = engine.village.focusRoot();
    const pivot = root?.getObjectByName('primary-door-pivot');
    const frame = root?.getObjectByName('opening-frame-details');
    const panel = root?.getObjectByName('primary-opening-panel');
    const hardware = root?.getObjectByName('opening-hardware-details');
    const leaf = root?.getObjectByName('primary-opening-leaf-details');
    const openCalls = engine.village.debugDrawCalls();
    const openPrograms = engine.renderer.info.programs?.length || 0;
    engine.village.debugSeekDoor(0, parcelId);
    const closedPoseCalls = engine.village.debugDrawCalls();
    const closedPosePrograms = engine.renderer.info.programs?.length || 0;
    engine.village.debugSeekDoor(1, parcelId);
    return {
      state,
      hierarchy: {
        panel: panel?.parent === pivot,
        hardware: hardware?.parent === pivot,
        leaf: leaf?.parent === pivot,
        frameFixed: frame?.parent !== pivot,
        recessFixed: frame?.parent !== pivot
          && frame?.userData?.primaryDoorRecesses?.length === 1,
      },
      programs: [openPrograms, closedPosePrograms],
      calls: [openCalls, closedPoseCalls],
    };
  }, doorParcelId);
  pass(openDoor.state?.progress === 1 && openDoor.state.targetOpen && !openDoor.state.moving
      && Object.values(openDoor.hierarchy).every(Boolean)
      && openDoor.programs[0] === openDoor.programs[1]
      && openDoor.calls[0] === openDoor.calls[1]
      && openDoor.calls[0] > 0,
  `open leaf, ironwork, and seams share one hinge without program/draw drift (${JSON.stringify(openDoor)})`);
  await page.evaluate(() => window.__engine.debugSetPaused(false));

  const regularDoorReleaseBeforeHop = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const root = engine.village.focusRoot();
    const pivot = root?.getObjectByName('primary-door-pivot');
    const panel = root?.getObjectByName('primary-opening-panel');
    window.__regularDoorReleaseProbe = { root, pivot, panel };
    return {
      open: engine.village.debugDoorInteraction(parcelId)?.progress === 1,
      pivotAttached: pivot?.parent != null,
      panelOnPivot: panel?.parent === pivot,
    };
  }, doorParcelId);
  pass(Object.values(regularDoorReleaseBeforeHop).every(Boolean),
    `regular door release probe starts on one open attached runtime (${JSON.stringify(regularDoorReleaseBeforeHop)})`);

  await page.evaluate((parcelId) => window.__engine.village.switchTo(parcelId), heroId);
  await page.waitForFunction((parcelId) => {
    const engine = window.__engine;
    return engine.village.getState().selected === parcelId
      && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
  }, heroId, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, heroId, { timeout });

  const regularDoorReleaseAfterHop = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const probe = window.__regularDoorReleaseProbe;
    delete window.__regularDoorReleaseProbe;
    return {
      runtimeReleased: engine.village.debugDoorInteraction(parcelId) == null,
      rootDetached: probe?.root?.parent == null,
      pivotDetached: probe?.pivot?.parent == null,
      pivotClosed: Math.abs(probe?.pivot?.rotation?.y || 0) < 1e-9,
      panelRestored: probe?.panel?.parent !== probe?.pivot,
    };
  }, doorParcelId);
  pass(Object.values(regularDoorReleaseAfterHop).every(Boolean),
    `regular→hero hop releases the old runtime, closes its pivot, and restores host ownership `
      + `(${JSON.stringify(regularDoorReleaseAfterHop)})`);

  const heroOpeningLifecycle = await page.evaluate(async ({ parcelId, resourcesModuleUrl }) => {
    const engine = window.__engine;
    const { collectObjectResources, isSharedResource } = await import(resourcesModuleUrl);
    const frames = (count = 4) => new Promise((resolve) => {
      const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const settlePrograms = async (maxFrames = 36) => {
      let previous = -1;
      let stableFrames = 0;
      for (let frame = 0; frame < maxFrames; frame++) {
        await frames(1);
        const current = engine.renderer.info.programs?.length || 0;
        stableFrames = current === previous ? stableFrames + 1 : 0;
        previous = current;
        if (stableFrames >= 4) break;
      }
    };
    // The focus handoff waits for async link completion, but Chrome may append
    // its finished depth/basic programs to renderer.info a few rAFs later. Take
    // both snapshots only after that observable list settles so delayed focus
    // work is not misreported as a rebuild program family.
    await settlePrograms();
    const oldRoot = engine.village.focusRoot();
    // Register and finish this exact focus subtree before the baseline so
    // delayed scene links cannot be charged to the replacement.
    engine.renderer.compile(oldRoot, engine.camera, engine.scene);
    await engine.renderer.compileAsync(oldRoot, engine.camera);
    await settlePrograms();
    engine.village.debugSeekDoor(1, parcelId);
    const oldPivot = oldRoot?.getObjectByName('primary-door-pivot');
    const oldDoorOpen = engine.village.debugDoorInteraction(parcelId)?.progress === 1;
    const oldGeometries = [];
    oldRoot?.traverse((object) => {
      if ([
        'opening-frame-details',
        'primary-opening-leaf-details',
        'opening-hardware-details',
        'threshold-life-detail',
      ].includes(object.name)
          && object.geometry) oldGeometries.push(object.geometry);
    });
    const disposed = new Map(oldGeometries.map((geometry) => [geometry, 0]));
    const openingShared = oldGeometries.map((geometry) => isSharedResource(geometry));
    const oldResources = collectObjectResources(oldRoot);
    const onDispose = (event) => disposed.set(event.target, (disposed.get(event.target) || 0) + 1);
    for (const geometry of oldGeometries) geometry.addEventListener('dispose', onDispose);
    const beforeProgramList = engine.renderer.info.programs || [];
    const beforePrograms = beforeProgramList.length;
    const beforeProgramKeys = new Set(beforeProgramList.map((program) => program.cacheKey));
    const rebuilt = engine.village.rebuild(parcelId, {
      building: { roofPitch: 1.08, eaveOverhang: 1.38, profileCurve: 0.56 },
    }, { refreshFlora: false });
    await settlePrograms();
    const root = engine.village.focusRoot();
    await engine.renderer.compileAsync(root, engine.camera);
    await settlePrograms();
    const material = {
      frameEnvelope: null, hardwareEnvelope: null, hardwareKey: null,
      thresholdLifeEnvelope: null, thresholdLifeKey: null, thresholdLifeTransparent: null,
    };
    root?.traverse((object) => {
      if (object.name === 'opening-frame-details') {
        material.frameEnvelope = object.material?.userData?.lodEnvelope === true;
      }
      if (object.name === 'opening-hardware-details') {
        material.hardwareEnvelope = object.material?.userData?.lodEnvelope === true;
        material.hardwareKey = object.material?.userData?.paletteKey || null;
      }
      if (object.name === 'threshold-life-detail') {
        material.thresholdLifeEnvelope = object.material?.userData?.lodEnvelope === true;
        material.thresholdLifeKey = object.material?.userData?.paletteKey || null;
        material.thresholdLifeTransparent = object.material?.transparent === true;
      }
    });
    const inspectPrimaryFace = () => {
      const anchor = root?.getObjectByName('primary-opening-anchor');
      const panel = root?.getObjectByName('primary-opening-panel');
      const frame = root?.getObjectByName('opening-frame-details');
      const plan = anchor?.userData?.openingDetailPlan;
      const panelPositions = panel?.geometry?.attributes?.position;
      const framePositions = frame?.geometry?.attributes?.position;
      if (!plan || !panelPositions || !framePositions) return null;
      root.updateWorldMatrix(true, true);
      const point = panel.position.clone();
      let panelFront = -Infinity;
      for (let index = 0; index < panelPositions.count; index++) {
        point.fromBufferAttribute(panelPositions, index);
        panel.localToWorld(point);
        anchor.worldToLocal(point);
        panelFront = Math.max(panelFront, point.z);
      }
      let frameFront = -Infinity;
      const uLimit = plan.width * 0.5 + plan.frame.width;
      const yMin = plan.frame.width * 1.5;
      const yMax = plan.height + plan.frame.width;
      for (let index = 0; index < framePositions.count; index++) {
        point.fromBufferAttribute(framePositions, index);
        frame.localToWorld(point);
        anchor.worldToLocal(point);
        if (Math.abs(point.x) <= uLimit && point.y >= yMin && point.y <= yMax) {
          frameFront = Math.max(frameFront, point.z);
        }
      }
      if (!Number.isFinite(panelFront) || !Number.isFinite(frameFront)) return null;
      return {
        panelFront,
        frameFront,
        clearance: frameFront - panelFront,
        expectedClearance: plan.reveal.faceClearance + plan.frame.depth,
      };
    };
    const afterProgramList = engine.renderer.info.programs || [];
    const newProgramKeys = afterProgramList
      .map((program) => program.cacheKey)
      .filter((key) => !beforeProgramKeys.has(key));
    const result = {
      rebuilt: !!rebuilt,
      opening: engine.village.debugOpeningDetail(parcelId),
      oldDoorOpen,
      oldPivotClosed: Math.abs(oldPivot?.rotation?.y || 0) < 1e-9,
      oldRootDetached: oldRoot?.parent == null,
      oldResourceContainsOpening: oldGeometries.map((geometry) => oldResources.geometries.has(geometry)),
      openingShared,
      oldOpeningGeometries: oldGeometries.length,
      disposed: [...disposed.values()],
      programs: [beforePrograms, engine.renderer.info.programs?.length || 0],
      newProgramKeys,
      openingProgramKeys: newProgramKeys.filter((key) => !/^(?:basic|depth),/.test(key)),
      delayedInfrastructurePrograms: newProgramKeys.filter((key) => /^(?:basic|depth),/.test(key)).length,
      material,
      primaryFace: inspectPrimaryFace(),
    };
    for (const geometry of oldGeometries) geometry.removeEventListener('dispose', onDispose);
    return result;
  }, {
    parcelId: heroId,
    resourcesModuleUrl: `/@fs${join(ROOT, 'src/core/three-resources.js')}`,
  });
  pass(heroOpeningLifecycle.rebuilt
      && heroOpeningLifecycle.opening?.valid
      && heroOpeningLifecycle.opening.plan?.style === 'giwa'
      && heroOpeningLifecycle.opening.door?.progress === 0
      && heroOpeningLifecycle.oldDoorOpen && heroOpeningLifecycle.oldPivotClosed
      && heroOpeningLifecycle.oldRootDetached
      && heroOpeningLifecycle.oldResourceContainsOpening.every(Boolean)
      && heroOpeningLifecycle.openingShared.every((shared) => !shared)
      && heroOpeningLifecycle.oldOpeningGeometries === 4
      && heroOpeningLifecycle.disposed.every((count) => count === 1)
      && heroOpeningLifecycle.material.frameEnvelope
      && !heroOpeningLifecycle.material.hardwareEnvelope
      && heroOpeningLifecycle.material.hardwareKey === 'hardware'
      && !heroOpeningLifecycle.material.thresholdLifeEnvelope
      && heroOpeningLifecycle.material.thresholdLifeKey === 'thresholdLife'
      && !heroOpeningLifecycle.material.thresholdLifeTransparent
      && heroOpeningLifecycle.primaryFace?.clearance > 0
      && Math.abs(
        heroOpeningLifecycle.primaryFace.clearance
          - heroOpeningLifecycle.primaryFace.expectedClearance,
      ) <= 1e-5
      // Chrome can append already-requested scene-level basic/depth links after
      // four stable rAFs. The opening must add no material shader family; keep a
      // small ceiling on that separately classified infrastructure tail.
      && heroOpeningLifecycle.openingProgramKeys.length === 0
      && heroOpeningLifecycle.delayedInfrastructurePrograms <= 4,
  `head-house rebuild preserves positive frame/panel clearance, replaces one opening overlay, `
    + `disposes it once, and adds no opening shader family (${JSON.stringify(heroOpeningLifecycle)})`);

  const thresholdWeather = await page.evaluate(() => {
    const engine = window.__engine;
    const root = engine.village.focusRoot();
    const dry = root?.getObjectByName('threshold-life-detail');
    let dryDisposed = 0;
    dry?.geometry?.addEventListener('dispose', () => { dryDisposed++; });
    engine.setWeather('rain');
    const wet = engine.village.focusRoot()?.getObjectByName('threshold-life-detail');
    let count = 0;
    engine.village.focusRoot()?.traverse((object) => {
      if (object.name === 'threshold-life-detail') count++;
    });
    const result = {
      dryKind: dry?.userData?.thresholdLifePlan?.kind || null,
      wetKind: wet?.userData?.thresholdLifePlan?.kind || null,
      wetCondition: wet?.userData?.thresholdLifePlan?.condition || null,
      count,
      dryDisposed,
      sameGeometry: dry?.geometry === wet?.geometry,
      sameMaterial: dry?.material === wet?.material,
    };
    engine.setWeather('clear');
    return result;
  });
  pass(
    thresholdWeather.dryKind === 'jipsin'
      && thresholdWeather.wetKind === 'namaksin'
      && thresholdWeather.wetCondition === 'wet'
      && thresholdWeather.count === 1
      && thresholdWeather.dryDisposed === 1
      && !thresholdWeather.sameGeometry
      && thresholdWeather.sameMaterial,
    `real clear→rain path swaps one focused pair, releases its geometry, and reuses the runtime material (${JSON.stringify(thresholdWeather)})`,
  );

  const typeChange = await page.evaluate(() => {
    window.__engine.setType('choga');
    return window.__engine.getState().preset;
  });
  pass(typeChange === 'choga', 'setType uses the shared building framing path without a runtime error');

  const expansionContract = await page.evaluate(async () => {
    const { ghostSpec, nextWingPlacement } = await import('/src/engine/expansion.js');
    const params = window.__engine.getParams();
    const samePlacement = [2, 3].every((target) => {
      const ghost = ghostSpec(params, target);
      const placement = nextWingPlacement(params, target);
      return !!ghost && !!placement
        && ghost.pStart.equals(placement.pStart)
        && ghost.size.W === placement.size.W
        && ghost.size.D === placement.size.D
        && ghost.size.H === placement.size.H;
    });
    const originalRandom = Math.random;
    const originalCreateElement = document.createElement;
    let randomCalls = 0;
    let canvasCalls = 0;
    Math.random = () => { randomCalls++; return 0.5; };
    document.createElement = function(tagName, options) {
      if (String(tagName).toLowerCase() === 'canvas') canvasCalls++;
      return originalCreateElement.call(this, tagName, options);
    };
    try { ghostSpec(params, 2); } finally {
      Math.random = originalRandom;
      document.createElement = originalCreateElement;
    }
    return {
      samePlacement,
      invalidRanges: ghostSpec(params, 1) === null && ghostSpec(params, 4) === null,
      randomCalls,
      canvasCalls,
    };
  });
  pass(
    expansionContract.samePlacement
      && expansionContract.invalidRanges
      && expansionContract.randomCalls === 0
      && expansionContract.canvasCalls === 0,
    `wing ghost shares pure placement without hidden generation (random ${expansionContract.randomCalls}, canvas ${expansionContract.canvasCalls})`,
  );

  const buildingApiUrl = `/@fs${join(ROOT, 'src/api/building.js')}`;
  const resourceApiUrl = `/@fs${join(ROOT, 'src/core/three-resources.js')}`;
  const lifecycleContract = await page.evaluate(async ({ buildingModuleUrl, resourceModuleUrl }) => {
    const { PRESETS, buildBuilding, disposeBuilding } = await import(buildingModuleUrl);
    const { isSharedResource } = await import(resourceModuleUrl);
    const owner = buildBuilding({ ...PRESETS.choga });
    const sharedMats = owner.userData.materials;
    const borrower = buildBuilding({ ...PRESETS.choga, mats: sharedMats });
    const sharedResources = new Set();
    for (const value of Object.values(sharedMats)) {
      if (value?.isMaterial) {
        sharedResources.add(value);
        for (const property of Object.values(value)) {
          if (property?.isTexture) sharedResources.add(property);
        }
      } else if (value?.isTexture) sharedResources.add(value);
    }
    const ownedResources = new Set();
    const moduleSharedResources = new Set();
    const addOwnedTexture = (texture) => {
      if (!texture || sharedResources.has(texture)) return;
      (isSharedResource(texture) ? moduleSharedResources : ownedResources).add(texture);
    };
    const addOwnedMaterial = (material) => {
      if (!material || sharedResources.has(material)) return;
      if (isSharedResource(material)) moduleSharedResources.add(material);
      else ownedResources.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) addOwnedTexture(value);
      }
      for (const uniform of Object.values(material.uniforms || {})) {
        const value = uniform?.value;
        if (value?.isTexture) addOwnedTexture(value);
        else if (Array.isArray(value)) {
          for (const item of value) if (item?.isTexture) addOwnedTexture(item);
        }
      }
    };
    borrower.traverse((object) => {
      if (object.geometry?.dispose) {
        (isSharedResource(object.geometry) ? moduleSharedResources : ownedResources).add(object.geometry);
      }
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : (object.material ? [object.material] : []);
      for (const material of objectMaterials) addOwnedMaterial(material);
    });
    let sharedDisposeEvents = 0;
    let moduleSharedDisposeEvents = 0;
    const ownedDisposeCounts = new Map();
    const onDispose = () => { sharedDisposeEvents++; };
    const onModuleSharedDispose = () => { moduleSharedDisposeEvents++; };
    const onOwnedDispose = (event) => ownedDisposeCounts.set(
      event.target, (ownedDisposeCounts.get(event.target) || 0) + 1,
    );
    for (const resource of sharedResources) resource.addEventListener('dispose', onDispose);
    for (const resource of moduleSharedResources) resource.addEventListener('dispose', onModuleSharedDispose);
    for (const resource of ownedResources) resource.addEventListener('dispose', onOwnedDispose);
    const borrowerFirst = disposeBuilding(borrower);
    const afterBorrower = sharedDisposeEvents;
    const borrowerSecond = disposeBuilding(borrower);
    const afterDuplicate = sharedDisposeEvents;
    const ownerFirst = disposeBuilding(owner);
    const afterOwner = sharedDisposeEvents;
    for (const resource of sharedResources) resource.removeEventListener('dispose', onDispose);
    for (const resource of moduleSharedResources) resource.removeEventListener('dispose', onModuleSharedDispose);
    for (const resource of ownedResources) resource.removeEventListener('dispose', onOwnedDispose);
    return {
      borrowerFirst,
      borrowerSecond,
      ownerFirst,
      afterBorrower,
      afterDuplicate,
      afterOwner,
      sharedCount: sharedResources.size,
      moduleSharedCount: moduleSharedResources.size,
      moduleSharedDisposeEvents,
      ownedCount: ownedResources.size,
      ownedDisposed: ownedDisposeCounts.size,
      ownedDuplicates: [...ownedDisposeCounts.values()].filter((count) => count !== 1).length,
    };
  }, { buildingModuleUrl: buildingApiUrl, resourceModuleUrl: resourceApiUrl });
  pass(
    lifecycleContract.borrowerFirst
      && !lifecycleContract.borrowerSecond
      && lifecycleContract.ownerFirst
      && lifecycleContract.afterBorrower === 0
      && lifecycleContract.afterDuplicate === 0
      && lifecycleContract.afterOwner === lifecycleContract.sharedCount
      && lifecycleContract.moduleSharedDisposeEvents === 0
      && lifecycleContract.ownedDisposed === lifecycleContract.ownedCount
      && lifecycleContract.ownedDuplicates === 0,
    `building lifecycle preserves ${lifecycleContract.sharedCount} injected + ${lifecycleContract.moduleSharedCount} module-shared resources and releases ${lifecycleContract.ownedDisposed}/${lifecycleContract.ownedCount} owned resources exactly once`,
  );

  const authenticityContract = await page.evaluate(async ({ buildingModuleUrl }) => {
    const { PRESETS, buildBuilding, disposeBuilding } = await import(buildingModuleUrl);
    const buildings = {
      palace: buildBuilding({ ...PRESETS.korea }),
      templePaljak: buildBuilding({ ...PRESETS.temple, roofType: 'paljak' }),
      jeongja: buildBuilding({ ...PRESETS.giwa, doorPattern: 'jeongja' }),
      sesal: buildBuilding({ ...PRESETS.giwa, doorPattern: 'sesal' }),
    };
    const greenRatio = (building) => {
      const canvas = building.userData.materials.door.map.image;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let green = 0;
      let sampled = 0;
      for (let i = 0; i < data.length; i += 4 * 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128) continue;
        sampled++;
        if (g > r * 1.15 && g > b * 1.15) green++;
      }
      return green / Math.max(1, sampled);
    };
    const ornamentCounts = (building) => {
      const counts = { chwidu: 0, japsang: 0 };
      building.traverse((object) => {
        if (object.name === 'palace-chwidu') counts.chwidu++;
        if (object.name === 'palace-japsang') counts.japsang++;
      });
      return counts;
    };
    const result = {
      green: {
        palace: greenRatio(buildings.palace),
        jeongja: greenRatio(buildings.jeongja),
        sesal: greenRatio(buildings.sesal),
      },
      palace: ornamentCounts(buildings.palace),
      templePaljak: ornamentCounts(buildings.templePaljak),
    };
    for (const building of Object.values(buildings)) disposeBuilding(building);
    return result;
  }, { buildingModuleUrl: buildingApiUrl });
  pass(
    authenticityContract.green.palace > 0.03
      && authenticityContract.green.jeongja < 0.001
      && authenticityContract.green.sesal < 0.001,
    `civilian lattice keeps bare timber/hanji while palace color remains (${JSON.stringify(authenticityContract.green)})`,
  );
  pass(
    authenticityContract.palace.chwidu > 0
      && authenticityContract.palace.japsang > 0
      && authenticityContract.templePaljak.chwidu === 0
      && authenticityContract.templePaljak.japsang === 0,
    `palace roof ornaments do not leak into a paljak temple (${JSON.stringify(authenticityContract)})`,
  );

  // 고증 조사도 제품 신뢰 표면이다. docs/credits.md를 파싱하는 실제 Reference 모달에서
  // 사용자가 출처→구현 해석과 원문을 함께 확인할 수 있어야 한다.
  await page.locator('.seal-label .info').click();
  const kitchenCredit = page.locator('.modal .cat li').filter({
    hasText: '국사편찬위원회 · 한국학중앙연구원 — 조선 살림집 부엌·구들·굴뚝',
  });
  const ornamentCredit = page.locator('.modal .cat li').filter({
    hasText: '국가유산청 · 한국학중앙연구원 — 궁궐 지붕 장식과 잡상',
  });
  const openingCredit = page.locator('.modal .cat li').filter({
    hasText: '국가유산청 국가유산포털 — 경복궁 근정전 창호 철물 정밀실측도',
  });
  const footwearCredit = page.locator('.modal .cat li').filter({
    hasText: '국립익산박물관 · 국립중앙박물관 · Korea.net — 조선 신발과 문간 탈화 생활',
  });
  await kitchenCredit.waitFor({ state: 'visible', timeout });
  await ornamentCredit.waitFor({ state: 'visible', timeout });
  await openingCredit.waitFor({ state: 'visible', timeout });
  await footwearCredit.waitFor({ state: 'visible', timeout });
  const referenceContract = {
    kitchenLinks: await kitchenCredit.locator('a').count(),
    ornamentLinks: await ornamentCredit.locator('a').count(),
    openingLinks: await openingCredit.locator('a').count(),
    footwearLinks: await footwearCredit.locator('a').count(),
    kitchenUse: await kitchenCredit.locator('.it-use').textContent(),
    ornamentUse: await ornamentCredit.locator('.it-use').textContent(),
    openingUse: await openingCredit.locator('.it-use').textContent(),
    openingHref: await openingCredit.locator('a').getAttribute('href'),
    footwearUse: await footwearCredit.locator('.it-use').textContent(),
    footwearHrefs: await footwearCredit.locator('.it-links a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    footwearLicense: await footwearCredit.locator('.it-license').textContent(),
    safeLinks: await page.locator('.modal .it-links a').evaluateAll((links) => links.every((link) => (
      link.target === '_blank'
        && link.rel.split(/\s+/).includes('noopener')
        && link.rel.split(/\s+/).includes('noreferrer')
    ))),
  };
  pass(
    referenceContract.kitchenLinks === 3
      && referenceContract.ornamentLinks === 2
      && referenceContract.openingLinks === 1
      && referenceContract.footwearLinks === 4
      && referenceContract.kitchenUse?.includes('마당 높이 부엌 개구 안')
      && referenceContract.ornamentUse?.includes('palace 전용 경계')
      && referenceContract.openingUse?.includes('민가에 그대로 복제하지 않는다')
      && referenceContract.openingUse?.includes('경첩 띠 두 개와 고리 하나')
      && referenceContract.openingUse?.includes('선택 FULL 주거 근경')
      && referenceContract.openingUse?.includes('경첩 쪽 한 짝·청판·고리·띠를 같은 jamb-edge pivot')
      && referenceContract.openingUse?.includes('관아·궁·사찰 복합체는')
      && referenceContract.openingUse?.includes('열림 각도·감쇠 운동은 실측 복원이 아니라')
      && referenceContract.openingHref?.includes('file_seq=2839493')
      && referenceContract.openingHref?.includes('title3d=')
      && referenceContract.footwearUse?.includes('접근 쪽 문설주 바깥')
      && referenceContract.footwearUse?.includes('현대 고무신')
      && FOOTWEAR_REFERENCE_URLS.every((url, index) => (
        referenceContract.footwearHrefs[index] === url
      ))
      && referenceContract.footwearLicense?.includes('저작권 보호')
      && referenceContract.footwearLicense?.includes('공공누리 제3유형')
      && referenceContract.safeLinks,
    `Reference UI exposes authenticity evidence and applied-use mapping (${JSON.stringify(referenceContract)})`,
  );
  await page.locator('.modal .x').click();

  // Palace and temple are authored multi-building compounds. Until a main-hall
  // role is preserved through their optimized roots, product interaction must
  // not silently choose an arbitrary duplicated or merged primary leaf.
  const compoundPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const compoundErrors = [];
  compoundPage.on('pageerror', (error) => compoundErrors.push(error.message));
  await compoundPage.goto(
    `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&vscale=capital&vpalace=1&vtemple=1&seed=42&vseed=20260716&time=day&lang=ko`,
    { waitUntil: 'domcontentloaded', timeout },
  );
  await compoundPage.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await compoundPage.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  const compoundIds = await compoundPage.evaluate(() => (
    window.__engine.village.debugParcels().map((parcel) => parcel.parcelId)
  ));
  const compoundScope = {};
  for (const [index, parcelId] of ['palace', 'temple'].entries()) {
    await compoundPage.evaluate(({ id, first }) => {
      const engine = window.__engine;
      if (first) engine.village.debugFocus(id);
      else engine.village.switchTo(id);
    }, { id: parcelId, first: index === 0 });
    await compoundPage.waitForFunction((id) => {
      const engine = window.__engine;
      return engine.village.getState().selected === id
        && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
    }, parcelId, { timeout });
    await compoundPage.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await compoundPage.waitForFunction((id) => {
      const state = window.__engine.village.getState();
      return state.selected === id && !state.transitioning;
    }, parcelId, { timeout });
    compoundScope[parcelId] = await compoundPage.evaluate((id) => {
      const engine = window.__engine;
      const root = engine.village.focusRoot();
      let pivots = 0;
      root?.traverse((object) => { if (object.name === 'primary-door-pivot') pivots++; });
      return {
        selected: engine.village.getState().selected,
        door: engine.village.debugDoorInteraction(id),
        screen: engine.village.debugDoorScreen(id),
        pivots,
      };
    }, parcelId);
  }
  // A town has no landmark palace proxy, but its reserved hero is a palace-style
  // magistracy/guest-house core. `hero` alone is therefore not a residential
  // interaction role; the authored heroStyle must survive into runtime scope.
  await compoundPage.goto(
    `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&vscale=town&vpalace=0&vtemple=0&seed=42&vseed=20260716&time=day&lang=ko`,
    { waitUntil: 'domcontentloaded', timeout },
  );
  await compoundPage.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await compoundPage.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  const magistracyId = await compoundPage.evaluate(() => (
    window.__engine.village.debugParcels()
      .find((parcel) => parcel.hero && parcel.heroStyle === 'palace')?.parcelId || null
  ));
  let magistracyScope = null;
  if (magistracyId) {
    await compoundPage.evaluate((id) => window.__engine.village.debugFocus(id), magistracyId);
    await compoundPage.waitForFunction((id) => {
      const engine = window.__engine;
      return engine.village.getState().selected === id
        && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
    }, magistracyId, { timeout });
    await compoundPage.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await compoundPage.waitForFunction((id) => {
      const state = window.__engine.village.getState();
      return state.selected === id && !state.transitioning;
    }, magistracyId, { timeout });
    magistracyScope = await compoundPage.evaluate((id) => {
      const engine = window.__engine;
      const root = engine.village.focusRoot();
      let pivots = 0;
      root?.traverse((object) => { if (object.name === 'primary-door-pivot') pivots++; });
      return {
        parcel: engine.village.debugParcels().find((candidate) => candidate.parcelId === id),
        door: engine.village.debugDoorInteraction(id),
        screen: engine.village.debugDoorScreen(id),
        pivots,
      };
    }, magistracyId);
  }
  await compoundPage.close();
  pass(['palace', 'temple'].every((id) => compoundIds.includes(id)
      && compoundScope[id]?.selected === id
      && compoundScope[id].door == null
      && compoundScope[id].screen == null
      && compoundScope[id].pivots === 0)
      && compoundErrors.length === 0,
  `palace/temple focus keeps ambiguous compound doors non-interactive (${JSON.stringify(compoundScope)})`);
  pass(magistracyScope?.parcel?.heroStyle === 'palace'
      && magistracyScope.door == null
      && magistracyScope.screen == null
      && magistracyScope.pivots === 0,
  `town magistracy hero remains outside residential door interaction (${JSON.stringify(magistracyScope)})`);

  const texturePlateau = await page.evaluate(() => {
    const engine = window.__engine;
    engine.village.exit();
    let thresholdLifeCount = 0;
    engine.village.exportRoot()?.traverse((object) => {
      if (object.name === 'threshold-life-detail') thresholdLifeCount++;
    });
    const environment = engine.scene.getObjectByName('environment');
    const motes = environment?.getObjectByName('dustMotes')?.material?.uniforms;
    const smokeSprite = environment?.getObjectByName('smoke')?.children.find((object) => object.isSprite && object.visible);
    const sun = engine.scene.children.find((object) => object.isDirectionalLight && object.castShadow);
    const resumedEnvironment = {
      visible: environment?.visible === true,
      sunIntensity: sun?.intensity,
      sunColor: sun?.color?.getHex(),
      fogNear: engine.scene.fog?.near,
      fogFar: engine.scene.fog?.far,
      fogColor: engine.scene.fog?.color?.getHex(),
      moteIntensity: motes?.uIntensity?.value,
      moteColor: motes?.uColor?.value?.getHex(),
      // No assigned emitter is also settled: the first visible update detects the rebuilt house
      // after the immediate profile snap, so a stale smoke sprite cannot be rendered meanwhile.
      smokeColor: smokeSprite?.material?.color?.getHex() ?? null,
    };
    engine.setType('choga');
    // setType의 조립 초반에는 아직 숨은 재질이 있어 첫 렌더가 전체 텍스처를 업로드하지 않는다.
    // 완성 상태 1회를 워밍한 뒤, 같은 완성 상태의 교체들만 steady-state로 비교한다.
    engine.__debugFreezeRebuild(1);
    engine.renderer.render(engine.scene, engine.camera);
    const samples = [engine.renderer.info.memory.textures];
    for (let i = 0; i < 6; i++) {
      engine.__debugFreezeRebuild(1);
      engine.renderer.render(engine.scene, engine.camera);
      samples.push(engine.renderer.info.memory.textures);
    }
    return {
      samples,
      stable: samples.every((count) => count === samples[0]),
      resumedEnvironment,
      thresholdLifeCount,
    };
  });
  const resumed = texturePlateau.resumedEnvironment;
  pass(
    resumed.visible
      && Math.abs(resumed.sunIntensity - 0.9) < 1e-6
      && resumed.sunColor === 0x9fb4d9
      && resumed.fogNear === 60 && resumed.fogFar === 400 && resumed.fogColor === 0x1a2740
      && Math.abs(resumed.moteIntensity - 0.5) < 1e-6
      && resumed.moteColor === 0xcdd8f0
      && (resumed.smokeColor == null || resumed.smokeColor === 0x969eae),
    `single-house environment resumes directly at the hidden night profiles (${JSON.stringify(resumed)})`,
  );
  pass(
    texturePlateau.stable && texturePlateau.samples[0] > 0,
    `repeated visible building rebuilds keep GPU textures flat (${texturePlateau.samples.join(' → ')})`,
  );
  pass(texturePlateau.thresholdLifeCount === 0,
    'village exit/focus-out releases threshold footwear from the retained village handle');

  const teardown = await page.evaluate(() => {
    const engine = window.__engine;
    const canvas = engine.renderer.domElement;
    const environment = engine.scene.getObjectByName('environment');
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const addTextures = (material) => {
      for (const value of Object.values(material || {})) if (value?.isTexture) textures.add(value);
      for (const uniform of Object.values(material?.uniforms || {})) {
        const value = uniform?.value;
        if (value?.isTexture) textures.add(value);
        else if (Array.isArray(value)) for (const item of value) if (item?.isTexture) textures.add(item);
      }
    };
    environment?.traverse((object) => {
      if (object.geometry?.dispose) geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : (object.material ? [object.material] : []);
      for (const material of objectMaterials) {
        materials.add(material);
        addTextures(material);
      }
    });
    const disposedGeometries = new Set();
    const disposedMaterials = new Set();
    const disposedTextures = new Set();
    const disposeCounts = new Map();
    const recordDispose = (target) => disposeCounts.set(target, (disposeCounts.get(target) || 0) + 1);
    const onGeometryDispose = (event) => { disposedGeometries.add(event.target); recordDispose(event.target); };
    const onMaterialDispose = (event) => { disposedMaterials.add(event.target); recordDispose(event.target); };
    const onTextureDispose = (event) => { disposedTextures.add(event.target); recordDispose(event.target); };
    for (const resource of geometries) resource.addEventListener('dispose', onGeometryDispose);
    for (const resource of materials) resource.addEventListener('dispose', onMaterialDispose);
    for (const resource of textures) resource.addEventListener('dispose', onTextureDispose);
    engine.dispose();
    engine.dispose();
    return {
      canvasConnected: canvas.isConnected,
      canvasCount: document.querySelectorAll('canvas').length,
      environmentConnected: !!environment?.parent,
      environmentResources: {
        geometries: [disposedGeometries.size, geometries.size],
        materials: [disposedMaterials.size, materials.size],
        textures: [disposedTextures.size, textures.size],
      },
      duplicateDisposals: [...disposeCounts.values()].filter((count) => count !== 1).length,
      hooks: ['__engine', '__viewshift', '__hero', '__asm', '__wx', '__rim', '__flare', '__season']
        .filter((name) => name in window),
    };
  });
  await page.waitForTimeout(100);
  pass(!teardown.canvasConnected && teardown.canvasCount === 0, 'engine.dispose removes the renderer canvas');
  pass(
    !teardown.environmentConnected
      && Object.values(teardown.environmentResources).every(([disposedCount, ownedCount]) => (
        ownedCount > 0 && disposedCount === ownedCount
      ))
      && teardown.duplicateDisposals === 0,
    `engine.dispose releases each environment resource exactly once (${JSON.stringify(teardown.environmentResources)}, duplicates ${teardown.duplicateDisposals})`,
  );
  pass(teardown.hooks.length === 0, `engine.dispose removes owned debug hooks (${teardown.hooks.join(', ') || 'none'})`);
  pass(runtimeErrors.length === 0, `browser reports no runtime errors (${runtimeErrors.length})`);
  if (runtimeErrors.length) console.log(runtimeErrors.slice(0, 5).join('\n'));

  await page.close();
} catch (error) {
  failures.push(error.message);
  console.error(error.stack || error);
  if (runtimeErrors.length) console.error(runtimeErrors.slice(0, 10).join('\n'));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(failures.length ? `\nAPP SMOKE: ${failures.length} FAIL` : '\nAPP SMOKE: PASS');
process.exit(failures.length ? 1 : 0);
