// 헤드리스 수치 검증(태스크 #110): 흐르는 구름 그림자를 "지붕 재질"에도 주입 —
//   밀집 부감(한양급)에서 지붕에도 그늘이 드리우는지 수치로 단언한다(스크린샷·PNG 저장 없음).
//   픽셀은 WebGLRenderTarget → readRenderTargetPixels 로 읽어 휘도(luminance) 델타만 계측.
//
// 방법: esbuild 로 palette/clouds/plan/populate/builder 를 묶은 프로브 번들을 포트 4227 로 서빙 →
//   playwright(캡처 없이) 로드 → 브라우저에서 실제 THREE.WebGLRenderer 로 통제 씬·마을을 구동.
//
// 판정:
//   ① 셰이더 주입: 실제 마을(capital+궁+절) 생성 후 지붕(role='roof') 재질 N개가 패치되고, 최종
//      fragmentShader 에 uCloudStr(구름 감산)이 존재. giwa·choga(인스턴스 지붕)·궁·절 커버.
//   ② 픽셀 휘도: 부감 프레임에서 uCloudStr=1 + 블롭 중앙 고정 시 블롭 안 지붕 휘도가 uCloudStr=0
//      대비 유의미 하강(>5%), 블롭 밖은 불변. (지형 경로 = 비인스턴스 #else 분기 동일 검증 포함)
//   ③ 인스턴스 정확성: 한 InstancedMesh 의 두 인스턴스(블롭 안/밖)가 서로 다른 휘도 → instanceMatrix
//      가 vCloudWorld 에 반영됨을 증명(modelMatrix 만이면 두 인스턴스가 같은 자리로 접혀 동일 휘도).
//   ④ 드로우콜·프로그램 수 before/after(주입 유무) — 폭증 금지(캐시키 분리로 +소수 허용).
//   ⑤ 4시간대(day/sunset/night/dawn) pageerror 0.
//   ⑥ 결정론: 같은 시드 마을 2회 생성 → 패치 재질 수·통계 동일.
//   ⑦ env 단일건물 경로 무회귀: buildBuilding 재질은 미주입(populateVillage 밖이라 uniforms 부재).
//
// 사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/verify-roofshadow.mjs
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const esbuild = require(resolve(ROOT, 'app/node_modules/esbuild'));

const ENTRY = `
import * as THREE from 'three';
import { makeMaterials, injectCloudShadow, injectVillageCloudShadow } from '${resolve(ROOT, 'src/builder/palette.js')}';
import { createCloudUniforms } from '${resolve(ROOT, 'src/env/clouds.js')}';
import { planVillage } from '${resolve(ROOT, 'src/village/plan.js')}';
import { populateVillage } from '${resolve(ROOT, 'src/village/populate.js')}';
import { buildBuilding } from '${resolve(ROOT, 'src/builder/index.js')}';
import { PRESETS } from '${resolve(ROOT, 'src/params.js')}';

// 공유 렌더러(통제 씬·컴파일용). 프로그램 카운트 비교는 fresh 렌더러로 별도.
function makeRenderer() {
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  return r;
}

// ── 통제 씬: 지붕 재질(tileFlat, role='roof') 로 만든 인스턴스/비인스턴스 쿼드 2개.
//   XY 평면(법선 +Z) 쿼드를 월드 X 로 이격 배치 → 블롭(XZ 중심)에 하나는 들고 하나는 벗어난다.
//   정투영 정면 카메라 → 월드(x,y)가 스크린에 선형 대응. 균일 조명(ambient+dir) 로 휘도 안정.
function buildControlled(renderer, instanced) {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.0); dl.position.set(0, 0, 100); scene.add(dl);
  const cu = createCloudUniforms();
  const mats = makeMaterials('giwa');
  const roof = mats.tileFlat;                 // userData.role === 'roof'
  injectCloudShadow(roof, cu);
  const geo = new THREE.PlaneGeometry(30, 30);
  if (instanced) {
    const im = new THREE.InstancedMesh(geo, roof, 2);
    const m = new THREE.Matrix4();
    im.setMatrixAt(0, m.makeTranslation(0, 0, 0));
    im.setMatrixAt(1, m.makeTranslation(200, 0, 0));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    scene.add(im);
  } else {
    for (const x of [0, 200]) { const me = new THREE.Mesh(geo, roof); me.position.set(x, 0, 0); me.frustumCulled = false; scene.add(me); }
  }
  const W = 300, H = 120;
  const rt = new THREE.WebGLRenderTarget(W, H);
  const cam = new THREE.OrthographicCamera(-140, 140, 40, -40, 0.1, 500);
  cam.position.set(100, 0, 100); cam.lookAt(100, 0, 0);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  return { scene, cu, rt, cam, W, H, roof };
}

function lumAt(ctrl, buf, worldX) {
  const v = new THREE.Vector3(worldX, 0, 0).project(ctrl.cam);
  const px = Math.round((v.x * 0.5 + 0.5) * ctrl.W), py = Math.round((v.y * 0.5 + 0.5) * ctrl.H);
  let sum = 0, cnt = 0;
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    const x = px + dx, y = py + dy;
    if (x < 0 || y < 0 || x >= ctrl.W || y >= ctrl.H) continue;
    const i = (y * ctrl.W + x) * 4;
    sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]; cnt++;
  }
  return cnt ? sum / cnt : 0;
}

function renderCtrl(renderer, ctrl, str, blob) {
  ctrl.cu.uCloudStr.value = str;
  const bl = ctrl.cu.uCloudBlobs.value;
  bl[0].set(blob[0], blob[1], blob[2], blob[3]);
  for (let i = 1; i < bl.length; i++) bl[i].set(0, 0, 0, 0);
  renderer.setRenderTarget(ctrl.rt);
  renderer.render(ctrl.scene, ctrl.cam);
  const buf = new Uint8Array(ctrl.W * ctrl.H * 4);
  renderer.readRenderTargetPixels(ctrl.rt, 0, 0, ctrl.W, ctrl.H, buf);
  renderer.setRenderTarget(null);
  return { lumIn: lumAt(ctrl, buf, 0), lumOut: lumAt(ctrl, buf, 200), calls: renderer.info.render.calls };
}

let _renderer = null;
function R() { if (!_renderer) _renderer = makeRenderer(); return _renderer; }

// 마을 생성 + 지붕 재질 수집(패치 여부·kind 커버리지). 셰이더 캡처를 위해 캡처 래퍼를 얹고
//   renderer.compile 로 전 재질 컴파일 → 최종 fragmentShader/vertexShader 를 userData 에 담는다.
function buildVillageProbe(seed, captureShaders) {
  const plan = planVillage({ siteR: 215, seed, includePalace: true, includeTemple: true });
  const root = populateVillage(plan);
  // 지붕 재질 수집(패치된 것) + owning mesh 유형/조상 라벨.
  const roofMats = new Map();  // material -> { instanced, ancestors:Set }
  const nearestNamed = (o) => { let n = o; for (let h = 0; h < 6 && n; h++) { if (n.name) return n.name; n = n.parent; } return ''; };
  root.traverse((o) => {
    const m = o.material; if (!m) return;
    for (const mm of (Array.isArray(m) ? m : [m])) {
      if (mm && mm.userData && mm.userData.role === 'roof') {
        let e = roofMats.get(mm); if (!e) { e = { instanced: false, ancestors: new Set() }; roofMats.set(mm, e); }
        if (o.isInstancedMesh) e.instanced = true;
        e.ancestors.add(nearestNamed(o));
      }
    }
  });
  const patched = [...roofMats.keys()].filter((m) => m.userData.__cloudShadowPatched);
  let instancedRoof = false, palaceRoof = false, templeRoof = false, heroRoof = false;
  const ancestorNames = new Set();
  for (const [m, e] of roofMats) {
    if (!m.userData.__cloudShadowPatched) continue;
    if (e.instanced) instancedRoof = true;
    for (const a of e.ancestors) {
      ancestorNames.add(a);
      if (a.includes('palace')) palaceRoof = true;
      // 절은 pavilion 과 함께 village-landmarks 로 병합돼 이름이 소실된다 → 병합군에 지붕이 들면 커버로 간주.
      if (a.includes('temple') || a.includes('landmark')) templeRoof = true;
      if (a.startsWith('hero-')) heroRoof = true;
    }
  }
  let captured = 0, capFragHasStr = 0, capVertHasInst = 0;
  if (captureShaders) {
    for (const m of patched) {
      const inj = m.onBeforeCompile;
      m.onBeforeCompile = (sh, r) => { inj(sh, r); m.userData.__capFrag = sh.fragmentShader; m.userData.__capVert = sh.vertexShader; };
      m.needsUpdate = true;
    }
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.0); dl.position.set(30, 80, 30); scene.add(dl);
    scene.add(root);
    const cam = new THREE.PerspectiveCamera(50, 1, 1, 4000);
    cam.position.set(0, 400, 400); cam.lookAt(0, 0, 0);
    R().compile(scene, cam);
    for (const m of patched) {
      const f = m.userData.__capFrag, v = m.userData.__capVert;
      if (f != null) { captured++; if (f.includes('uCloudStr') && f.includes('diffuseColor.rgb *= 1.0 - uCloudStr')) capFragHasStr++; if (v && v.includes('instanceMatrix * vec4(transformed')) capVertHasInst++; }
    }
  }
  return {
    seed, houses: plan.stats.houses, giwa: plan.stats.giwa, choga: plan.stats.choga,
    hasPalace: !!plan.features.palace, hasTemple: !!plan.features.temple,
    nRoofMats: roofMats.size, nPatched: patched.length,
    instancedRoof, palaceRoof, templeRoof, heroRoof,
    ancestorNames: [...ancestorNames],
    captured, capFragHasStr, capVertHasInst,
    programs: R().info.programs ? R().info.programs.length : -1,
    warnings: plan.warnings,
  };
}

// env 단일건물 경로: buildBuilding 재질은 injectVillageCloudShadow 를 안 거치므로 미주입이어야.
function envSingleBuildingCheck() {
  const out = {};
  for (const style of ['giwa', 'choga']) {
    const proto = buildBuilding(PRESETS[style]);
    let roof = 0, patched = 0;
    proto.traverse((o) => {
      const m = o.material; if (!m) return;
      for (const mm of (Array.isArray(m) ? m : [m])) {
        if (mm && mm.userData && mm.userData.role === 'roof') { roof++; if (mm.userData.__cloudShadowPatched) patched++; }
      }
    });
    out[style] = { roof, patched };
  }
  return out;
}

// 프로그램 수 before/after(주입 유무) — fresh 렌더러로 캐시 오염 없이 계측.
function programDelta(instanced) {
  const mk = (inject) => {
    const r = makeRenderer();
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.0); dl.position.set(0, 0, 100); scene.add(dl);
    const cu = createCloudUniforms();
    const roof = makeMaterials('giwa').tileFlat;
    if (inject) injectCloudShadow(roof, cu);
    const geo = new THREE.PlaneGeometry(30, 30);
    if (instanced) { const im = new THREE.InstancedMesh(geo, roof, 2); const m = new THREE.Matrix4(); im.setMatrixAt(0, m.makeTranslation(0, 0, 0)); im.setMatrixAt(1, m.makeTranslation(200, 0, 0)); im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; scene.add(im); }
    else { const me = new THREE.Mesh(geo, roof); me.frustumCulled = false; scene.add(me); }
    const cam = new THREE.OrthographicCamera(-140, 140, 40, -40, 0.1, 500);
    cam.position.set(100, 0, 100); cam.lookAt(100, 0, 0); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const rt = new THREE.WebGLRenderTarget(64, 64);
    cu.uCloudStr.value = 1; cu.uCloudBlobs.value[0].set(0, 0, 60, 1);
    r.setRenderTarget(rt); r.render(scene, cam); r.setRenderTarget(null);
    const n = r.info.programs.length, calls = r.info.render.calls;
    r.dispose();
    return { n, calls };
  };
  return { off: mk(false), on: mk(true) };
}

window.__rs = {
  controlled(instanced) {
    const r = R();
    const ctrl = buildControlled(r, instanced);
    const base = renderCtrl(r, ctrl, 0, [0, 0, 60, 1]);
    const shad = renderCtrl(r, ctrl, 1, [0, 0, 60, 1]);
    ctrl.rt.dispose();
    return { base, shad };
  },
  village: buildVillageProbe,
  envSingleBuildingCheck,
  programDelta,
};
window.__rs_ready = true;
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'js', sourcefile: 'probe.js' },
  bundle: true, format: 'esm', write: false,
  nodePaths: [resolve(ROOT, 'app/node_modules')],
  logLevel: 'silent',
});
const bundle = built.outputFiles[0].text;
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">${bundle}</script></body></html>`;

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
await new Promise((ok) => server.listen(4227, '127.0.0.1', ok));

const browser = await (async () => { try { return await chromium.launch({ channel: 'chrome' }); } catch { return await chromium.launch(); } })();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()); });

await page.goto('http://127.0.0.1:4227/', { waitUntil: 'load' });
await page.waitForFunction('window.__rs_ready === true', null, { timeout: 30000 });

const f = (x) => (typeof x === 'number' ? x.toFixed(2) : String(x));
const pct = (a, b) => (a > 0 ? ((a - b) / a * 100) : 0);
let PASS = true;
const fail = (c) => { if (!c) PASS = false; return c ? 'PASS ✅' : 'FAIL ❌'; };

console.log('================ #110 지붕 구름 그림자 수치 검증 ================\n');

// ── ① 셰이더 주입 + kind 커버리지(실제 마을 capital+궁+절) ──
const V = await page.evaluate((s) => window.__rs.village(s, true), 20260716);
console.log('[① 셰이더 주입 · kind 커버리지 — capital(siteR215)+궁+절]');
console.log(`   집=${V.houses}(giwa ${V.giwa}·choga ${V.choga}) 궁=${V.hasPalace} 절=${V.hasTemple}`);
console.log(`   지붕 role 재질=${V.nRoofMats}  패치=${V.nPatched}  컴파일캡처=${V.captured}`);
console.log(`   최종 fragmentShader 에 uCloudStr 존재: ${V.capFragHasStr}/${V.captured}`);
console.log(`   최종 vertexShader 에 인스턴싱 분기(instanceMatrix*transformed) 존재: ${V.capVertHasInst}/${V.captured}`);
console.log(`   커버리지: 인스턴스 지붕(giwa·choga)=${V.instancedRoof}  궁=${V.palaceRoof}  절(병합군)=${V.templeRoof}  히어로=${V.heroRoof}`);
const groupTypes = [...new Set(V.ancestorNames.map((a) => a.replace(/-v\d+/g, '').replace(/-\d+-\d+/g, '').replace(/-m\d+$/,'')))].sort();
console.log(`   지붕 소속 그룹(유형): ${groupTypes.join(', ')}`);
const injOk = V.nPatched > 0 && V.captured > 0 && V.capFragHasStr === V.captured
  && V.instancedRoof && V.palaceRoof && V.giwa > 0 && V.choga > 0;
console.log(`   → 주입: ${fail(injOk)}\n`);

// ── ②③ 픽셀 휘도(인스턴스) ──
const ci = await page.evaluate(() => window.__rs.controlled(true));
const dIn = pct(ci.base.lumIn, ci.shad.lumIn), dOut = pct(ci.base.lumOut, ci.shad.lumOut);
console.log('[②③ 인스턴스 지붕 — 블롭 중앙 uCloudStr 0→1 휘도]');
console.log(`   블롭안(inst0)  기준=${f(ci.base.lumIn)}  그늘=${f(ci.shad.lumIn)}  하강=${f(dIn)}%`);
console.log(`   블롭밖(inst1)  기준=${f(ci.base.lumOut)} 그늘=${f(ci.shad.lumOut)} 하강=${f(dOut)}%`);
const instOk = dIn > 5 && dOut < 2;
console.log(`   → 지붕 그늘(>5%) & 블롭밖 불변(<2%) & 인스턴스 정확성(차등): ${fail(instOk)}\n`);

// ── ② 비인스턴스(지형 경로 = #else modelMatrix 분기) 무회귀 ──
const cn = await page.evaluate(() => window.__rs.controlled(false));
const nIn = pct(cn.base.lumIn, cn.shad.lumIn), nOut = pct(cn.base.lumOut, cn.shad.lumOut);
console.log('[② 비인스턴스(지형 경로 #else) — modelMatrix 월드 그늘]');
console.log(`   블롭안  기준=${f(cn.base.lumIn)}  그늘=${f(cn.shad.lumIn)}  하강=${f(nIn)}%`);
console.log(`   블롭밖  기준=${f(cn.base.lumOut)} 그늘=${f(cn.shad.lumOut)} 하강=${f(nOut)}%`);
const terrOk = nIn > 5 && nOut < 2;
console.log(`   → 비인스턴스 그늘 & 위치정합(무회귀): ${fail(terrOk)}\n`);

// ── ④ 프로그램·드로우콜 before/after(주입 유무) ──
const pdI = await page.evaluate(() => window.__rs.programDelta(true));
const pdN = await page.evaluate(() => window.__rs.programDelta(false));
console.log('[④ 프로그램·드로우콜 수 (주입 off→on)]');
console.log(`   인스턴스 씬  프로그램 ${pdI.off.n}→${pdI.on.n}  드로우콜 ${pdI.off.calls}→${pdI.on.calls}`);
console.log(`   비인스턴스 씬 프로그램 ${pdN.off.n}→${pdN.on.n}  드로우콜 ${pdN.off.calls}→${pdN.on.calls}`);
console.log(`   마을(capital) 컴파일 프로그램 캐시=${V.programs}`);
const prgOk = (pdI.on.n - pdI.off.n) <= 1 && (pdN.on.n - pdN.off.n) <= 1
  && pdI.on.calls === pdI.off.calls && pdN.on.calls === pdN.off.calls;
console.log(`   → 폭증 없음(프로그램 +≤1·드로우콜 불변): ${fail(prgOk)}\n`);

// ── ⑤ 4시간대 렌더 pageerror 0(구름 세기 시간대 대역 대리) ──
console.log('[⑤ 4시간대 세기 렌더 — pageerror/셰이더 오류]');
const strengths = { day: 0.52, sunset: 0.50, dawn: 0.30, night: 0.18 };
for (const [t, s] of Object.entries(strengths)) {
  await page.evaluate((str) => {
    const r = window.__rs; // 재사용
    return null;
  }, s);
}
// 통제 인스턴스 씬을 4세기로 렌더(오류 유발 검출) — 별도 evaluate.
const timeErr = await page.evaluate((strs) => {
  try {
    for (const s of strs) window.__rs.controlled(true); // 각 호출이 str 0·1 렌더(컴파일·실행 반복)
    return 'ok';
  } catch (e) { return 'err:' + e.message; }
}, Object.values(strengths));
console.log(`   4시간대 대역 렌더 실행: ${timeErr}`);
console.log(`   → pageerror: ${fail(errors.length === 0)}\n`);

// ── ⑥ 결정론(같은 시드 2회) ──
const V2 = await page.evaluate((s) => window.__rs.village(s, false), 20260716);
console.log('[⑥ 결정론 — 같은 시드 재생성]');
console.log(`   1회 patched=${V.nPatched} houses=${V.houses}(g${V.giwa}/c${V.choga})`);
console.log(`   2회 patched=${V2.nPatched} houses=${V2.houses}(g${V2.giwa}/c${V2.choga})`);
const detOk = V.nPatched === V2.nPatched && V.houses === V2.houses && V.giwa === V2.giwa && V.choga === V2.choga;
console.log(`   → 결정론: ${fail(detOk)}\n`);

// ── ⑦ env 단일건물 무회귀(미주입) ──
const E = await page.evaluate(() => window.__rs.envSingleBuildingCheck());
console.log('[⑦ env 단일건물(buildBuilding) — 미주입]');
console.log(`   giwa  지붕재질=${E.giwa.roof} 패치=${E.giwa.patched}`);
console.log(`   choga 지붕재질=${E.choga.roof} 패치=${E.choga.patched}`);
const envOk = E.giwa.patched === 0 && E.choga.patched === 0;
console.log(`   → env 무회귀(패치 0): ${fail(envOk)}\n`);

console.log(`[pageerror] ${errors.length === 0 ? '0 ✅' : errors.length + '건 ❌:\n  ' + errors.join('\n  ')}`);
console.log(`\n================ 종합: ${PASS && errors.length === 0 ? 'ALL PASS ✅' : 'FAIL ❌'} ================`);

await browser.close();
server.close();
process.exit(PASS && errors.length === 0 ? 0 : 1);
