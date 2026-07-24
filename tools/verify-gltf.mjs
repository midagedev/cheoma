// #104 glTF 익스포트 검증 — 렌더 캡처 없음. 코어(buildBuilding/buildParcel/planVillage/populateVillage)
//   + src/export/gltf.js 를 esbuild 로 번들해 헤드리스 크로미움 페이지에서 실행하고, GLTFLoader 로
//   라운드트립해 수치만 단언한다. 앱 dev 서버 불침해, 전용 포트 4218.
//
//   실행: node tools/verify-gltf.mjs          (playwright 는 tools/node_modules 에서 해석)
//         산출 .glb 는 OS 임시 디렉터리에 저장(CHEOMA_GLTF_OUT으로 재지정 가능, 리포 커밋 금지).
//
//   검증 항목
//     ① 단일 건물 5종(buildBuilding palace/giwa · buildParcel hanok/palace/temple/choga)
//        export → 라운드트립: 메시 수·삼각형 수·재질 수 일치 + 텍스처 임베드(image 존재).
//     ② 마을(village 규모) export → 라운드트립 + 파일<80MB + 임포스터·입자 0.
//     ③ hanyang: 실제 FULL은 예산 가드, fullDetail:false는 모든 경량 FAR 주택을 보존.
//        두 경로 모두 현재 카메라 LOD/focus와 무관하며 FULL/FAR가 중복되지 않는다.
//        transient focus는 빠져 비focus export와 같고, committed edit은 override를
//        포함하면서 superseded base instance/ranges를 export snapshot에서 접는다.
//     ④ pageerror/예외 0.

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCRATCH = process.env.CHEOMA_GLTF_OUT
  ? resolve(process.env.CHEOMA_GLTF_OUT)
  : mkdtempSync(join(tmpdir(), 'cheoma-gltf-'));
mkdirSync(SCRATCH, { recursive: true });

const reqApp = createRequire(join(ROOT, 'app', 'package.json'));
const reqTools = createRequire(join(ROOT, 'tools', 'package.json'));
const esbuild = reqApp('esbuild');
const { chromium } = reqTools('playwright');

const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');
const PORT = 4218;

// ── 브라우저 엔트리(절대경로 import) ────────────────────────────────────────
const ENTRY = `
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildBuilding } from '${ROOT}/src/builder/index.js';
import { buildParcel } from '${ROOT}/src/layout/parcel.js';
import { PRESETS } from '${ROOT}/src/params.js';
import { planVillage } from '${ROOT}/src/village/plan.js';
import { populateVillage } from '${ROOT}/src/village/populate.js';
import { createVillage } from '${ROOT}/src/village/adapter.js';
import { exportGLB, analyzeExport, buildExportScene, filenameFor } from '${ROOT}/src/export/gltf.js';

function abToB64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
const TEX_KEYS = ['map','normalMap','roughnessMap','metalnessMap','emissiveMap','aoMap'];
const SCENERY_RE = /^(?:trees|forest-|village-(?:trees|forest|flora|bloom|critters)|animals|cow|birds|critters|v-(?:dogs|cats|magpies))/;
function countScene(obj) {
  let meshes = 0, tris = 0, points = 0, impostors = 0, overrides = 0;
  let auxiliaryMeshes = 0;
  let scenery = 0, tex = 0, texWithImage = 0, instanced = 0, zeroInstances = 0;
  const matrix = new THREE.Matrix4();
  const mats = new Set();
  obj.traverse((n) => {
    if (n.isPoints || n.isSprite) points++;
    if (/^impostor-/.test(n.name || '')) impostors++;
    if (/^(?:village-overrides|override-|hero-override|palace-override)/.test(n.name || '')) overrides++;
    if (SCENERY_RE.test(n.name || '')) scenery++;
    if (n.isMesh || n.isInstancedMesh) {
      const g = n.geometry; if (!g) return;
      const idx = g.getIndex(); const p = g.getAttribute('position');
      const base = idx ? idx.count / 3 : (p ? p.count / 3 : 0);
      if (base <= 0) return;
      meshes++; tris += base * (n.isInstancedMesh ? n.count : 1);
      if (/^(?:village-auxiliaries-m|auxiliary-building-)/.test(n.name || '')) {
        auxiliaryMeshes++;
      }
      if (n.isInstancedMesh) {
        instanced++;
        for (let index = 0; index < n.count; index++) {
          matrix.fromArray(n.instanceMatrix.array, index * 16);
          if (Math.abs(matrix.determinant()) < 1e-12) zeroInstances++;
        }
      }
      const mm = Array.isArray(n.material) ? n.material : [n.material];
      for (const m of mm) { if (!m) continue; mats.add(m.uuid);
        for (const k of TEX_KEYS) { const t = m[k]; if (t) { tex++; if (t.image) texWithImage++; } } }
    }
  });
  return {
    meshes, tris, materials: mats.size, points, impostors, overrides, auxiliaryMeshes,
    scenery, tex, texWithImage, instanced, zeroInstances,
  };
}
function mixString(hash, value) {
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  return hash;
}
function mixFloatArray(hash, array) {
  const words = new Uint32Array(array.buffer, array.byteOffset, array.byteLength / 4);
  for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i], 16777619) >>> 0;
  return hash;
}
// Position + instance-matrix fingerprint catches the bug that triangle counts alone cannot:
// focused source geometry still has the same count even when every selected range is degenerate.
function shapeFingerprint(obj) {
  let hash = 2166136261, values = 0;
  obj.traverse((n) => {
    if (!n.isMesh && !n.isInstancedMesh) return;
    hash = mixString(hash, n.name || '');
    const position = n.geometry?.getAttribute('position')?.array;
    if (position) { hash = mixFloatArray(hash, position); values += position.length; }
    if (n.isInstancedMesh) {
      hash = mixFloatArray(hash, n.instanceMatrix.array);
      values += n.instanceMatrix.array.length;
    }
  });
  return values + ':' + hash.toString(16).padStart(8, '0');
}
function exportSummary(root, opts) {
  const scene = buildExportScene(root, opts);
  return { ...countScene(scene), fingerprint: shapeFingerprint(scene) };
}
function sameExportShape(a, b) {
  return a.meshes === b.meshes && a.tris === b.tris && a.instanced === b.instanced
    && a.impostors === b.impostors && a.overrides === b.overrides
    && a.auxiliaryMeshes === b.auxiliaryMeshes
    && a.fingerprint === b.fingerprint;
}
function roundtrip(buffer) {
  return new Promise((res, rej) => new GLTFLoader().parse(buffer, '', (g) => res(g.scene), rej));
}

async function exportOne(name, target, opts) {
  const src = analyzeExport(target, opts);
  const buf = await exportGLB(target, opts);
  if (!(buf instanceof ArrayBuffer)) return { name, ok: false, reason: 'not-arraybuffer', over: buf };
  const scene = await roundtrip(buf);
  const rt = countScene(scene);
  // 진단: glTF JSON 의 실제 materials/images 배열 길이(익스포트 측 vs 로드 측 +1 구분).
  const json = await exportGLB(target, { ...opts, binary: false });
  const jsonMats = (json && json.materials && json.materials.length) || 0;
  const jsonImgs = (json && json.images && json.images.length) || 0;
  return {
    name, ok: true, bytes: buf.byteLength,
    src: { meshes: src.meshes, tris: src.triangles, materials: src.materials, instanced: src.instancedMeshes },
    rt, jsonMats, jsonImgs,
    filename: filenameFor(target),
    b64: buf.byteLength < 90 * 1024 * 1024 ? abToB64(buf) : null,
  };
}

async function runAll() {
  const out = { singles: [], village: null, hanyang: null };

  // ① 단일 건물
  const singles = [
    ['buildBuilding:palace', () => buildBuilding(PRESETS.korea)],
    ['buildBuilding:giwa',   () => buildBuilding(PRESETS.giwa)],
    ['buildParcel:hanok',    () => buildParcel({ seed: 20260716, style: 'hanok' })],
    ['buildParcel:palace',   () => buildParcel({ seed: 20260716, style: 'palace' })],
    ['buildParcel:temple',   () => buildParcel({ seed: 20260716, style: 'temple' })],
    ['buildParcel:choga',    () => buildParcel({ seed: 20260716, style: 'choga' })],
  ];
  for (const [name, make] of singles) {
    try { out.singles.push(await exportOne(name, make(), {})); }
    catch (e) { out.singles.push({ name, ok: false, reason: String(e && e.stack || e) }); }
  }

  // ② 마을(village 규모)
  try {
    const plan = planVillage({ scale: 'village', seed: 20260716 });
    const root = populateVillage(plan);
    out.village = await exportOne('village', root, {});
    out.village.name = 'village';
  } catch (e) { out.village = { name: 'village', ok: false, reason: String(e && e.stack || e) }; }

  // ⑤ 옵션 스모크: bake 폴백(인스턴스 전개)·pretty:false(수목/정원/동물 제외).
  out.opts = {};
  try {
    const target = buildBuilding(PRESETS.korea);   // 공포 InstancedMesh 포함 → bake 전개 실증
    const gpu = analyzeExport(target, { instancing: 'gpu' });
    const buf = await exportGLB(target, { instancing: 'bake', maxTriangles: 20_000_000 });
    const scene = await roundtrip(buf);
    const rt = countScene(scene);
    out.opts.bake = { ok: buf instanceof ArrayBuffer, gpuTris: gpu.triangles, gpuMeshes: gpu.meshes, rtTris: rt.tris, rtMeshes: rt.meshes };
  } catch (e) { out.opts.bake = { ok: false, reason: String(e && e.stack || e) }; }
  try {
    // createVillage를 써 populate 뒤 VillageHandle이 붙이는 개·고양이·까치까지 실제 계약을 검증한다.
    const handle = createVillage({ scale: 'village', seed: 20260716 });
    const root = handle.group;
    const fullScene = buildExportScene(root, {});
    const leanScene = buildExportScene(root, { pretty: false, includeTerrain: false });
    const full = analyzeExport(root, {});
    const lean = analyzeExport(root, { pretty: false, includeTerrain: false });
    out.opts.lean = {
      fullTris: full.triangles, leanTris: lean.triangles,
      sourceScenery: countScene(root).scenery,
      fullScenery: countScene(fullScene).scenery,
      leanScenery: countScene(leanScene).scenery,
    };
    handle.dispose();
  } catch (e) { out.opts.lean = { reason: String(e && e.stack || e) }; }

  // ③ hanyang 예산 가드 + 임포스터 존재 규모의 제외 필터 실증
  try {
    const handle = createVillage({ scale: 'hanyang', seed: 20260716 });
    const root = handle.group;
    const an = analyzeExport(root, {});
    const res = await exportGLB(root, {});
    const overBudget = !(res instanceof ArrayBuffer) && res && res.overBudget === true;
    // 실제 FULL 경로는 FAR·입자를 제외한다. 경량 경로는 반대로 FAR를 전체 승격한다.
    const sc = exportSummary(root, {});
    const lw = exportSummary(root, { fullDetail: false });
    // 원본에 임포스터가 실제로 존재하는지(테스트 전제) 확인.
    let srcImpostors = 0; root.traverse((n) => { if (/^impostor-/.test(n.name || '')) srcImpostors++; });

    // 실제 FAR 소스까지 가진 정규 필지를 focus해 FULL instance matrix, FAR mass position,
    // merged wall position을 동시에 접는다. Export 결과는 그 presentation mutation과 무관해야 한다.
    const focusParcel = handle.plan.parcels.find((parcel) => (
      !parcel.hero && parcel.auxiliary && handle.lodState(parcel.id)?.far
    ));
    const detail = focusParcel ? handle.showParcelDetail(focusParcel.id) : null;
    const focusedState = focusParcel ? handle.lodState(focusParcel.id) : null;
    const focusFull = exportSummary(root, {});
    const focusLean = exportSummary(root, { fullDetail: false });
    const focusInvariant = {
      parcelId: focusParcel?.id || null,
      detailCreated: !!detail,
      stateValid: focusedState?.valid === true,
      baseHidden: focusedState?.baseHidden === true,
      wallHidden: focusedState?.wallHidden === true,
      impostorHidden: focusedState?.impostorHidden === true,
      auxiliaryHidden: focusedState?.auxiliaryHidden === true,
      auxiliaryVisible: focusedState?.auxiliaryVisible === true,
      fullSame: sameExportShape(sc, focusFull),
      leanSame: sameExportShape(lw, focusLean),
      baseFull: sc,
      focusFull,
      baseLean: lw,
      focusLean,
    };
    if (focusParcel) handle.hideParcelDetail(focusParcel.id);

    // A committed editor transaction is not a camera staging overlay. Export it
    // as the authoritative FULL house and keep the superseded FULL/FAR/wall base
    // collapsed in the export-only snapshots. The edit uses a count extreme so
    // its opening geometry fingerprint cannot accidentally match the prototype.
    const editedGroup = focusParcel ? handle.rebuildParcel(focusParcel.id, {
      building: { windowCount: 1, windowWidthK: 0.31 },
    }, { persist: true, refreshFlora: false }) : null;
    const editedState = focusParcel ? handle.parcelRebuildState(focusParcel.id) : null;
    const editedLodState = focusParcel ? handle.lodState(focusParcel.id) : null;
    const editedFull = exportSummary(root, {});
    const editedLean = exportSummary(root, { fullDetail: false });
    const committedEdit = {
      created: !!editedGroup,
      marked: editedGroup?.userData?.exportPersistentParcel === true,
      persistent: editedState?.persistent === true,
      fullChanged: !sameExportShape(sc, editedFull),
      leanChanged: !sameExportShape(lw, editedLean),
      fullOverrides: editedFull.overrides,
      leanOverrides: editedLean.overrides,
      fullZeroDelta: editedFull.zeroInstances - sc.zeroInstances,
      auxiliaryAccepted: !!editedGroup?.userData?.auxiliarySpec,
      auxiliaryHidden: editedLodState?.auxiliaryHidden === true,
      fullAuxiliaryMeshDelta: editedFull.auxiliaryMeshes - sc.auxiliaryMeshes,
      leanAuxiliaryMeshDelta: editedLean.auxiliaryMeshes - lw.auxiliaryMeshes,
      baseFull: sc,
      editedFull,
      baseLean: lw,
      editedLean,
    };
    handle.dispose();
    out.hanyang = {
      ok: true, analyzeTris: an.triangles, limit: an.limit, overBudget,
      sanitizedImpostors: sc.impostors, sanitizedPoints: sc.points,
      lightweightImpostors: lw.impostors, lightweightTris: lw.tris,
      srcImpostors, focusInvariant, committedEdit,
      suggestions: overBudget ? res.suggestions : null,
    };
  } catch (e) { out.hanyang = { ok: false, reason: String(e && e.stack || e) }; }

  return out;
}
window.__run = runAll;
window.__READY = true;
`;

// ── esbuild 번들 ─────────────────────────────────────────────────────────
const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'js' },
  bundle: true, format: 'esm', write: false, sourcemap: false,
  alias: { three: THREE_MAIN, 'three/addons': THREE_ADDONS },
  logLevel: 'silent',
});
const BUNDLE = built.outputFiles[0].text;

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><script type="module" src="/bundle.js"></script></body></html>`;

// ── 서브 ───────────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/index')) { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
  if (req.url.startsWith('/bundle.js')) { res.setHeader('content-type', 'text/javascript'); res.end(BUNDLE); return; }
  res.statusCode = 404; res.end('nf');
});
await new Promise((r) => server.listen(PORT, r));

const pageErrors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });

let results = null, fatal = null;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__READY === true', { timeout: 60000 });
  results = await page.evaluate(async () => await window.__run(), { timeout: 180000 });
} catch (e) { fatal = String(e && e.stack || e); }

await browser.close();
await new Promise((r) => server.close(r));

// ── 산출 .glb 저장 + 단언 ────────────────────────────────────────────────
const fails = [];
const B = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const MB = (n) => (n / 1048576).toFixed(2) + 'MB';
function saveGlb(name, b64) { if (!b64) return; writeFileSync(join(SCRATCH, name), Buffer.from(b64, 'base64')); }

if (fatal) fails.push('FATAL: ' + fatal);

if (results) {
  console.log('\n=== ① 단일 건물 라운드트립 (src → roundtrip) ===');
  console.log('name'.padEnd(24), 'meshes(s/rt)'.padEnd(16), 'tris(s/rt)'.padEnd(20), 'mats(s/rt)'.padEnd(14), 'texImg', 'size');
  for (const r of results.singles) {
    if (!r.ok) { fails.push(`single ${r.name}: ${r.reason || r.reason}`); console.log(r.name.padEnd(24), 'FAIL', r.reason); continue; }
    saveGlb(r.filename, r.b64);
    const mOk = r.src.meshes === r.rt.meshes;
    const tOk = r.src.tris === r.rt.tris;
    // 익스포트 충실도: glTF 가 담은 재질 수 == 소스 고유 재질 수. 라운드트립 THREE 재질 수는
    //   GLTFLoader 가 한 glTF 재질을 정점색(COLOR_0) 유무 등 사용 맥락별로 갈라 만들 수 있어
    //   ≥ jsonMats 이 정상(로더 아티팩트, 익스포트 손실 아님).
    const matOk = r.jsonMats === r.src.materials && r.rt.materials >= r.jsonMats;
    const imgOk = r.rt.texWithImage > 0 && r.jsonImgs > 0;
    if (!mOk) fails.push(`${r.name}: mesh ${r.src.meshes}≠${r.rt.meshes}`);
    if (!tOk) fails.push(`${r.name}: tris ${r.src.tris}≠${r.rt.tris}`);
    if (!matOk) fails.push(`${r.name}: glTF mat ${r.jsonMats}≠src ${r.src.materials}`);
    if (!imgOk) fails.push(`${r.name}: no embedded texture image`);
    console.log(
      r.name.padEnd(24),
      `${r.src.meshes}/${r.rt.meshes}${mOk ? '' : '✗'}`.padEnd(16),
      `${r.src.tris}/${r.rt.tris}${tOk ? '' : '✗'}`.padEnd(20),
      `${r.src.materials}/${r.jsonMats}/${r.rt.materials}${matOk ? '' : '✗'}`.padEnd(16),
      `${r.rt.texWithImage}${imgOk ? '' : '✗'}`.padEnd(6),
      MB(r.bytes), `img${r.jsonImgs}`);
  }

  console.log('\n=== ② 마을(village) ===');
  const v = results.village;
  if (!v || !v.ok) { fails.push('village: ' + (v && v.reason)); console.log('village FAIL', v && v.reason); }
  else {
    saveGlb(v.filename, v.b64);
    const sizeOk = v.bytes < 80 * 1048576;
    const impOk = v.rt.impostors === 0;
    const ptOk = v.rt.points === 0;
    const tOk = v.src.tris === v.rt.tris;
    if (!sizeOk) fails.push(`village: size ${MB(v.bytes)} ≥ 80MB`);
    if (!impOk) fails.push(`village: impostors ${v.rt.impostors} ≠ 0`);
    if (!ptOk) fails.push(`village: points ${v.rt.points} ≠ 0`);
    if (!tOk) fails.push(`village: tris ${v.src.tris}≠${v.rt.tris}`);
    console.log(`meshes ${v.rt.meshes} · instanced ${v.rt.instanced} · tris ${B(v.rt.tris)} (src ${B(v.src.tris)}${tOk ? '' : '✗'}) · mats ${v.rt.materials} · texImg ${v.rt.texWithImage} · size ${MB(v.bytes)}${sizeOk ? '' : '✗'} · impostors ${v.rt.impostors}${impOk ? '' : '✗'} · points ${v.rt.points}${ptOk ? '' : '✗'}`);
  }

  console.log('\n=== ③ hanyang 예산 가드 ===');
  const h = results.hanyang;
  if (!h || !h.ok) { fails.push('hanyang: ' + (h && h.reason)); console.log('hanyang FAIL', h && h.reason); }
  else {
    const overOk = h.analyzeTris > h.limit && h.overBudget === true;
    const filterOk = h.sanitizedImpostors === 0 && h.sanitizedPoints === 0
      && h.lightweightImpostors > 0 && h.lightweightTris > 0
      && h.lightweightTris < h.analyzeTris;
    const preOk = h.srcImpostors > 0; // 테스트 전제: 원본에 임포스터 존재
    const fi = h.focusInvariant || {};
    const focusOk = !!fi.parcelId && fi.detailCreated && fi.stateValid
      && fi.baseHidden && fi.wallHidden && fi.impostorHidden
      && fi.auxiliaryHidden && !fi.auxiliaryVisible
      && fi.fullSame && fi.leanSame
      && fi.focusFull?.overrides === 0 && fi.focusLean?.overrides === 0;
    const ce = h.committedEdit || {};
    const committedOk = ce.created && ce.marked && ce.persistent
      && ce.fullChanged && ce.leanChanged
      && ce.fullOverrides >= 2 && ce.leanOverrides >= 2
      && ce.fullZeroDelta > 0
      && ce.auxiliaryAccepted && ce.auxiliaryHidden
      && ce.fullAuxiliaryMeshDelta === 3
      && ce.leanAuxiliaryMeshDelta === 3;
    if (!overOk) fails.push(`hanyang: guard not tripped (tris ${B(h.analyzeTris)} vs limit ${B(h.limit)}, overBudget=${h.overBudget})`);
    if (!filterOk) fails.push(`hanyang: FULL/FAR export selection drift `
      + `(full impostors=${h.sanitizedImpostors}, points=${h.sanitizedPoints}, `
      + `light impostors=${h.lightweightImpostors}, tris=${B(h.lightweightTris)})`);
    if (!preOk) fails.push(`hanyang: src had no impostors (test premise broken)`);
    if (!focusOk) fails.push(`hanyang: focus changed export `
      + `(parcel=${fi.parcelId}, detail=${fi.detailCreated}, state=${fi.stateValid}, `
      + `hidden=${fi.baseHidden}/${fi.wallHidden}/${fi.impostorHidden}/${fi.auxiliaryHidden}, `
      + `same=${fi.fullSame}/${fi.leanSame}, overrides=${fi.focusFull?.overrides}/${fi.focusLean?.overrides})`);
    if (!committedOk) fails.push(`hanyang: committed edit missing from export `
      + `(created=${ce.created}, marked=${ce.marked}, persistent=${ce.persistent}, `
      + `changed=${ce.fullChanged}/${ce.leanChanged}, overrides=${ce.fullOverrides}/${ce.leanOverrides}, `
      + `zeroDelta=${ce.fullZeroDelta}, auxiliary=${ce.auxiliaryAccepted}/${ce.auxiliaryHidden}, `
      + `auxMeshes=${ce.fullAuxiliaryMeshDelta}/${ce.leanAuxiliaryMeshDelta})`);
    console.log(`analyzeTris ${B(h.analyzeTris)} > limit ${B(h.limit)} → overBudget=${h.overBudget}${overOk ? '' : '✗'} · srcImpostors ${h.srcImpostors}${preOk ? '' : '✗'} → FULL impostors ${h.sanitizedImpostors}/points ${h.sanitizedPoints} · FAR impostors ${h.lightweightImpostors}/tris ${B(h.lightweightTris)}${filterOk ? '' : '✗'}`);
    console.log(`focus ${fi.parcelId || 'none'} hidden(base/wall/FAR/aux) ${fi.baseHidden}/${fi.wallHidden}/${fi.impostorHidden}/${fi.auxiliaryHidden} · FULL ${fi.baseFull?.fingerprint}→${fi.focusFull?.fingerprint} · FAR ${fi.baseLean?.fingerprint}→${fi.focusLean?.fingerprint} · overrides ${fi.focusFull?.overrides}/${fi.focusLean?.overrides}${focusOk ? '' : '✗'}`);
    console.log(`committed edit persistent/marked ${ce.persistent}/${ce.marked} · FULL ${ce.baseFull?.fingerprint}→${ce.editedFull?.fingerprint} · FAR ${ce.baseLean?.fingerprint}→${ce.editedLean?.fingerprint} · overrides ${ce.fullOverrides}/${ce.leanOverrides} · zero base delta ${ce.fullZeroDelta} · auxiliary accepted/hidden ${ce.auxiliaryAccepted}/${ce.auxiliaryHidden} · aux mesh Δ ${ce.fullAuxiliaryMeshDelta}/${ce.leanAuxiliaryMeshDelta}${committedOk ? '' : '✗'}`);
    if (h.suggestions) console.log('  안내:', h.suggestions.join(' | '));
  }
}

if (results && results.opts) {
  console.log('\n=== ⑤ 옵션 스모크 ===');
  const bk = results.opts.bake;
  if (bk && bk.ok) {
    const tOk = bk.gpuTris === bk.rtTris;   // bake 는 유효 삼각형 보존, 메시는 전개되어 증가.
    if (!tOk) fails.push(`bake: tris ${bk.gpuTris}≠${bk.rtTris}`);
    if (!(bk.rtMeshes > bk.gpuMeshes)) fails.push(`bake: 메시 전개 안 됨(${bk.rtMeshes}≤${bk.gpuMeshes})`);
    console.log(`bake: tris ${B(bk.gpuTris)}(gpu)→${B(bk.rtTris)}(rt)${tOk ? '' : '✗'} · meshes ${bk.gpuMeshes}(gpu)→${bk.rtMeshes}(rt, 전개)`);
  } else { fails.push('bake: ' + (bk && bk.reason)); console.log('bake FAIL', bk && bk.reason); }
  const ln = results.opts.lean;
  if (ln && ln.fullTris != null) {
    const leanOk = ln.leanTris < ln.fullTris
      && ln.sourceScenery > 0 && ln.fullScenery > 0 && ln.leanScenery === 0;
    if (!leanOk) fails.push(`lean: pretty:false 가 삼각형을 줄이지 않음(${ln.leanTris}≥${ln.fullTris})`);
    console.log(`pretty:false+includeTerrain:false: tris ${B(ln.fullTris)}→${B(ln.leanTris)} · scenery source/full/lean ${ln.sourceScenery}/${ln.fullScenery}/${ln.leanScenery}${leanOk ? '' : '✗'}`);
  } else { fails.push('lean: ' + (ln && ln.reason)); }
}

console.log('\n=== ④ pageerror/예외 ===');
console.log(pageErrors.length ? pageErrors.join('\n') : '없음');
if (pageErrors.length) fails.push(`pageerror ${pageErrors.length}건`);

console.log('\n=== 결과 ===');
if (fails.length === 0) { console.log('PASS — 모든 단언 통과'); console.log('산출 .glb →', SCRATCH); process.exit(0); }
else { console.log('FAIL (' + fails.length + ')'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
