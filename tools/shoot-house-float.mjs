// Walk-mode eye-height A/B captures for the #56 ground-junction round.
//
// Same boot, same camera, same program cache: the junction quads live at the tail
// of the shared 'pad-skirt' index buffer (pads.js exposes the split as
// userData.groundJunction.parcelSkirtIndexCount), so `setDrawRange` turns the fix
// off and on without a second page load. Cross-boot capture pairs are invalid here
// — the framing varies per boot — which is why this drives one scene twice.
//
// Fixtures are the exact worst-float coordinates from the diagnosis probe.
// Usage: node tools/shoot-house-float.mjs [--out DIR]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(ROOT, 'scratch/house-float/renders');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

// Worst measured visible float per category (scratch/house-float/probe-float2.mjs).
// eye = camera position at walk height, look = the floating footprint.
const FIXTURES = [
  {
    name: 'sijeon-worst', scale: 'hanyang', seed: 2,
    target: { x: 319, z: -10 }, kind: 'sijeon', note: 'sijeon s85, 2.91m float',
  },
  {
    name: 'dolran-worst', scale: 'hanyang', seed: 1,
    target: { x: 155, z: 85 }, kind: 'guardian-dolran', note: 'guardian 돌단, 6.49m float',
  },
  {
    name: 'pavilion-worst', scale: 'village', seed: 1,
    target: { x: 23, z: 88 }, kind: 'pavilion', note: 'pavilion podium, 0.98m float',
  },
];

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';
import { terrainMeshHeightAt, terrainMeshSegmentClearance } from '/src/village/terrain-grid.js';
import { planFeatureGroundJunctions } from '/src/village/feature-junction-plan.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'hanyang';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 1;

// Deterministic boot: shared palette paths touch Math.random.
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c4);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 3000);

// Backlit-ish key light so a stone face reads in section, plus fill so the
// shadow side is not crushed (look grammar: no crushed-black silhouettes).
const sun = new THREE.DirectionalLight(0xffe3bd, 2.4);
sun.position.set(-120, 90, -140);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 400;
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbcd2e8, 0x6b5c46, 1.0));

const village = await createVillage({ scale, seed, sync: true });
const root = village.root || village.group || village;
scene.add(root);

// Locate the shared pad-skirt buffer and its parcel/junction split.
let skirt = null, pads = null;
root.traverse((object) => {
  if (object.name === 'pad-skirt') skirt = object;
  if (object.name === 'village-pads') pads = object;
});
const split = pads?.userData?.groundJunction || null;
window.__floatAB = {
  found: !!skirt,
  split,
  total: skirt ? skirt.geometry.getIndex().count : 0,
};
window.__setJunction = (on) => {
  if (!skirt || !split) return false;
  const index = skirt.geometry.getIndex();
  skirt.geometry.setDrawRange(0, on ? index.count : split.parcelSkirtIndexCount);
  return true;
};
// Draw ONLY the feature-junction tail of the buffer. Used to settle the identity of
// anything that appears between a before/after pair: if a silhouette coincides with
// this isolation render, that silhouette is the junction geometry and nothing else.
window.__setJunctionOnly = () => {
  if (!skirt || !split) return false;
  const index = skirt.geometry.getIndex();
  skirt.geometry.setDrawRange(split.parcelSkirtIndexCount,
    index.count - split.parcelSkirtIndexCount);
  return true;
};

// The village handle exposes { group, plan, seed } — there is NO handle.site. The
// first revision of this tool read village.site, got undefined, and silently fell
// back to ground() = 0. That put the camera ~7 m UNDER hanyang's terrain: every
// capture looked up at the underside of the world, and the ground was invisible
// because terrain backfaces are culled. Resolve the sampler explicitly and refuse
// to aim at all when it is missing, so the failure can never be silent again.
const site = village.plan?.site;
if (!site || typeof site.heightAt !== 'function') {
  throw new Error('shoot-house-float: could not resolve plan.site — refusing to aim blind');
}
// The RENDERED surface, not the analytic field: the eye must stand on the very
// triangles the camera sees.
const groundAt = (x, z) => terrainMeshHeightAt(site, x, z);

const EYE_HEIGHT = 1.6;
window.__aim = (tx, tz, kind = null, mode = 'eye') => {
  camera.up.set(0, 1, 0);
  // mode='legacy' reproduces the broken v1 aim (ground() = 0) for the FAIL-first proof.
  if (mode === 'legacy') {
    camera.position.set(tx + 16, EYE_HEIGHT, tz);
    camera.lookAt(tx, 1.2, tz);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return window.__probe();
  }

  // Aiming at the object's CENTRE is not enough either: the float is at a footprint
  // edge, so a centre-aimed frame showed 653 px of apron. Frame the actual tallest
  // apron face — the exact thing being judged — by reading it out of the plan.
  const worst = window.__worstFace(tx, tz, kind);
  if (!worst) throw new Error('shoot-house-float: no junction face near the fixture target');
  const mid = { x: (worst.a.x + worst.b.x) / 2, z: (worst.a.z + worst.b.z) / 2 };
  const faceMidY = (worst.topY + worst.bottomY) / 2;
  // Stand outward along the face's own outward normal, on the ground, and look
  // straight at the middle of the face. Nearest standoff with a clear sightline wins
  // (terrainMeshSegmentClearance is the same test the focus camera uses).
  // Standoff candidates run NEAREST first, scaled by the subject so apparent size is
  // comparable across fixtures. Two occlusion tests must both pass, because each one
  // alone let a useless frame through: terrain clearance missed a neighbouring shop
  // (sijeon read 0 px at 9 m), and a fixed near standoff put a 1.1 m pavilion apron
  // below the coverage floor.
  const candidates = [];
  for (const value of [3.5, worst.height * 3, worst.height * 4, worst.height * 5.5, worst.height * 8]) {
    const distance = Math.max(3.5, Math.min(20, value));
    if (!candidates.some((existing) => Math.abs(existing - distance) < 0.2)) candidates.push(distance);
  }
  candidates.sort((a, b) => a - b);

  const raycaster = new THREE.Raycaster();
  const eyeVector = new THREE.Vector3();
  const faceVector = new THREE.Vector3(mid.x, faceMidY, mid.z);
  const direction = new THREE.Vector3();
  let best = null;
  for (const distance of candidates) {
    const x = mid.x + worst.normal.x * distance;
    const z = mid.z + worst.normal.z * distance;
    const h = groundAt(x, z);
    const sight = terrainMeshSegmentClearance(site,
      { x, y: h + EYE_HEIGHT, z }, { x: mid.x, y: faceMidY, z: mid.z });
    if (sight.min < 0.1) continue;
    // Anything solid between the eye and the face — a neighbouring shop, a wall, a
    // tree trunk — makes the capture worthless, and terrain clearance cannot see it.
    eyeVector.set(x, h + EYE_HEIGHT, z);
    direction.copy(faceVector).sub(eyeVector);
    const span = direction.length();
    raycaster.set(eyeVector, direction.normalize());
    raycaster.far = span - 0.25;
    const blocked = raycaster.intersectObject(root, true).length > 0;
    if (blocked) continue;
    best = {
      x, z, h, distance, sightline: sight.min, faceHeight: worst.height, occluded: false,
    };
    break;
  }
  if (!best) {
    const distance = candidates[0];
    const x = mid.x + worst.normal.x * distance, z = mid.z + worst.normal.z * distance;
    best = {
      x, z, h: groundAt(x, z), distance, sightline: 0, faceHeight: worst.height, occluded: true,
    };
  }
  camera.position.set(best.x, best.h + EYE_HEIGHT, best.z);
  camera.lookAt(mid.x, faceMidY, mid.z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { ...window.__probe(), aim: best, face: { mid, height: worst.height, kind: worst.kind } };
};

// Tallest planned junction face near a fixture target. The renderer must not guess
// where the defect is; the plan already knows.
window.__worstFace = (tx, tz, kind = null, radius = 60) => {
  const junctions = planFeatureGroundJunctions(village.plan, site);
  let best = null;
  for (const entry of junctions) {
    if (kind && entry.kind !== kind) continue;
    for (const segment of entry.junction.segments) {
      const mx = (segment.a.x + segment.b.x) / 2, mz = (segment.a.z + segment.b.z) / 2;
      if (Math.hypot(mx - tx, mz - tz) > radius) continue;
      if (!best || segment.height > best.height) best = { ...segment, kind: entry.kind };
    }
  }
  return best;
};

// Mechanical camera probe — no look judgement, purely "is this a walk-mode eye".
window.__probe = () => {
  const groundUnderCamera = groundAt(camera.position.x, camera.position.z);
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  return {
    eye: [camera.position.x, camera.position.y, camera.position.z],
    up: [camera.up.x, camera.up.y, camera.up.z],
    groundUnderCamera,
    clearance: camera.position.y - groundUnderCamera,
    near: camera.near,
    forward: [forward.x, forward.y, forward.z],
  };
};
window.__frame = () => { renderer.render(scene, camera); };
window.__ready = true;
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(HTML);
    return;
  }
  try {
    const body = await readFile(join(ROOT, url.pathname));
    response.writeHead(200, { 'content-type': MIME[extname(url.pathname)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

// ── Mechanical frame assertions ────────────────────────────────────────────
// A capture is only walk-mode evidence if the eye stands ON the ground and the
// ground is actually in frame. The v1 tool satisfied neither and produced six
// unusable images, so these are asserted, not eyeballed.
const MIN_EYE_CLEARANCE = 1.5;      // camera y must clear the rendered terrain by this
const MIN_GROUND_RATIO = 0.85;      // of the bottom third of the frame, non-sky
const MIN_AB_DIFF_PIXELS = 2000;    // the apron must actually be in shot (~0.2% of frame)
const SKY = { r: 0x9f, g: 0xb4, b: 0xc4 };   // scene.background set in the page

function decodePng(buffer) {
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let position = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[position++];
    const line = raw.subarray(position, position + stride);
    position += stride;
    const target = out.subarray(row * stride, (row + 1) * stride);
    const previous = row > 0 ? out.subarray((row - 1) * stride, row * stride) : null;
    for (let index = 0; index < stride; index++) {
      const a = index >= channels ? target[index - channels] : 0;
      const b = previous ? previous[index] : 0;
      const c = (previous && index >= channels) ? previous[index - channels] : 0;
      let value = line[index];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      target[index] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

// Fraction of the bottom third that is NOT the flat background colour. Standing on
// the ground and looking at a subject puts terrain across the whole lower frame; a
// camera under the world sees culled backfaces, i.e. raw background.
function bottomThirdGroundRatio(png) {
  const startRow = Math.floor(png.height * 2 / 3);
  let ground = 0, total = 0;
  for (let row = startRow; row < png.height; row++) {
    for (let column = 0; column < png.width; column++) {
      const base = (row * png.width + column) * png.channels;
      const distance = Math.abs(png.data[base] - SKY.r)
        + Math.abs(png.data[base + 1] - SKY.g)
        + Math.abs(png.data[base + 2] - SKY.b);
      if (distance > 24) ground++;
      total++;
    }
  }
  return ground / total;
}

function frameViolations(probe, ratio) {
  const problems = [];
  if (!(probe.clearance > MIN_EYE_CLEARANCE)) {
    problems.push(`eye clearance ${probe.clearance.toFixed(2)}m <= ${MIN_EYE_CLEARANCE}m `
      + `(camera y ${probe.eye[1].toFixed(2)} vs rendered ground ${probe.groundUnderCamera.toFixed(2)})`);
  }
  const [ux, uy, uz] = probe.up;
  if (!(Math.abs(ux) < 1e-9 && Math.abs(uy - 1) < 1e-9 && Math.abs(uz) < 1e-9)) {
    problems.push(`camera up is [${probe.up.join(', ')}], expected [0, 1, 0]`);
  }
  if (!(ratio >= MIN_GROUND_RATIO)) {
    problems.push(`bottom-third ground ratio ${(ratio * 100).toFixed(1)}% < ${(MIN_GROUND_RATIO * 100).toFixed(0)}%`);
  }
  return problems;
}

// Mask of pixels that differ between two frames, plus its bounding box. Used both
// to prove an A/B pair is live and to identify what appeared between them.
function diffMask(a, b) {
  const mask = new Uint8Array(a.width * a.height);
  let count = 0, minX = a.width, maxX = -1, minY = a.height, maxY = -1;
  for (let row = 0; row < a.height; row++) {
    for (let column = 0; column < a.width; column++) {
      const index = row * a.width + column;
      const base = index * a.channels;
      let differs = false;
      for (let channel = 0; channel < 3; channel++) {
        if (Math.abs(a.data[base + channel] - b.data[base + channel]) > 2) differs = true;
      }
      if (differs) {
        mask[index] = 1; count++;
        if (column < minX) minX = column;
        if (column > maxX) maxX = column;
        if (row < minY) minY = row;
        if (row > maxY) maxY = row;
      }
    }
  }
  return { mask, count, minX, maxX, minY, maxY, width: a.width, height: a.height };
}

// Non-background silhouette of an isolation render.
function silhouette(png) {
  const mask = new Uint8Array(png.width * png.height);
  let count = 0;
  for (let index = 0; index < mask.length; index++) {
    const base = index * png.channels;
    const distance = Math.abs(png.data[base] - SKY.r)
      + Math.abs(png.data[base + 1] - SKY.g)
      + Math.abs(png.data[base + 2] - SKY.b);
    if (distance > 24) { mask[index] = 1; count++; }
  }
  return { mask, count };
}

function overlap(maskA, maskB) {
  let both = 0, onlyA = 0;
  for (let index = 0; index < maskA.length; index++) {
    if (maskA[index] && maskB[index]) both++;
    else if (maskA[index]) onlyA++;
  }
  return { both, onlyA, fractionExplained: both / Math.max(1, both + onlyA) };
}

const browser = await chromium.launch();
const results = [];
let failFirstProven = false;

for (const fixture of FIXTURES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => console.error(`  page error: ${error.message}`));
  await page.goto(`http://127.0.0.1:${port}/?scale=${fixture.scale}&seed=${fixture.seed}`);
  await page.waitForFunction('window.__ready === true', { timeout: 240000 });
  const ab = await page.evaluate('window.__floatAB');

  // FAIL-first, once: the v1 aim (ground() = 0) must trip these assertions. If it
  // ever stops tripping them, the assertions are not measuring what they claim.
  if (!failFirstProven) {
    const legacyProbe = await page.evaluate(`window.__aim(${fixture.target.x}, ${fixture.target.z}, null, 'legacy')`);
    await page.evaluate('window.__setJunction(true)');
    await page.evaluate('window.__frame()');
    const legacyShot = await page.screenshot();
    const legacyRatio = bottomThirdGroundRatio(decodePng(legacyShot));
    const legacyProblems = frameViolations(legacyProbe, legacyRatio);
    if (!legacyProblems.length) {
      throw new Error('FAIL-first proof lost: the legacy v1 aim now passes the frame '
        + 'assertions, so they cannot be catching the defect they were written for');
    }
    console.log(`FAIL-first (legacy v1 aim, ${fixture.name}): ${legacyProblems.length} violation(s)`);
    for (const problem of legacyProblems) console.log(`  - ${problem}`);

    // Identity of anything the vision round saw appear in the v1 "after" frame.
    // Capture the same legacy viewpoint three ways and compare masks.
    await page.evaluate('window.__setJunction(false)');
    await page.evaluate('window.__frame()');
    const legacyBefore = decodePng(await page.screenshot({
      path: join(OUT, `v2-slab-legacy-${fixture.name}-before.png`),
    }));
    await page.evaluate('window.__setJunction(true)');
    await page.evaluate('window.__frame()');
    const legacyAfter = decodePng(await page.screenshot({
      path: join(OUT, `v2-slab-legacy-${fixture.name}-after.png`),
    }));
    await page.evaluate('window.__setJunctionOnly()');
    await page.evaluate('window.__frame()');
    const legacyOnly = decodePng(await page.screenshot({
      path: join(OUT, `v2-slab-legacy-${fixture.name}-junction-only.png`),
    }));
    const appeared = diffMask(legacyBefore, legacyAfter);
    const isolated = silhouette(legacyOnly);
    const explained = overlap(appeared.mask, isolated.mask);
    console.log(`SLAB IDENTITY (legacy v1 viewpoint, ${fixture.name}):`);
    console.log(`  pixels that appeared in "after": ${appeared.count} `
      + `bbox x[${appeared.minX}..${appeared.maxX}] y[${appeared.minY}..${appeared.maxY}] `
      + `of ${appeared.width}x${appeared.height} (y=0 is frame top)`);
    console.log(`  junction-only silhouette: ${isolated.count} px; `
      + `${(explained.fractionExplained * 100).toFixed(1)}% of the appeared pixels are junction geometry `
      + `(${explained.onlyA} unexplained)`);
    failFirstProven = true;
  }

  const probe = await page.evaluate(`window.__aim(${fixture.target.x}, ${fixture.target.z}, '${fixture.kind}')`);
  const shots = {};
  const frames = {};
  for (const [suffix, on] of [['before', false], ['after', true]]) {
    await page.evaluate(`window.__setJunction(${on})`);
    await page.evaluate('window.__frame()');
    const file = join(OUT, `v2-house-float-${fixture.name}-${suffix}.png`);
    const buffer = await page.screenshot({ path: file });
    const png = decodePng(buffer);
    frames[suffix] = png;
    shots[suffix] = { file, ratio: bottomThirdGroundRatio(png) };
    console.log(`saved ${file}`);
  }
  // Both frames of the pair must be valid walk-mode evidence.
  for (const [suffix, shot] of Object.entries(shots)) {
    const problems = frameViolations(probe, shot.ratio);
    if (problems.length) {
      throw new Error(`${fixture.name}/${suffix} is not walk-mode evidence: ${problems.join('; ')}`);
    }
  }
  // Ground in frame is not the same as SUBJECT in frame. A pair whose two halves are
  // nearly identical shows the viewer nothing about the fix, however valid the eye
  // position is — that is how a 12-pixel "before/after" slipped through once.
  const changed = diffMask(frames.before, frames.after);
  if (changed.count < MIN_AB_DIFF_PIXELS) {
    throw new Error(`${fixture.name}: the apron occupies only ${changed.count} px of the frame `
      + `(< ${MIN_AB_DIFF_PIXELS}) — this viewpoint does not show the subject, so the pair is `
      + 'not evidence. Aim/fixture needs revisiting, not the assertion.');
  }
  results.push({ ...fixture, ab, probe, shots, changed: changed.count });
  console.log(`  ${fixture.name}: ${fixture.note}`);
  console.log(`    GROUND ASSERTIONS PASS  eye=[${probe.eye.map((v) => v.toFixed(1)).join(', ')}] `
    + `renderedGround=${probe.groundUnderCamera.toFixed(2)} clearance=${probe.clearance.toFixed(2)}m `
    + `up=[${probe.up.join(',')}] bottomThirdGround=`
    + `${(shots.before.ratio * 100).toFixed(1)}%/${(shots.after.ratio * 100).toFixed(1)}% (before/after)`);
  console.log(`    SUBJECT VISIBLE  apron changes ${changed.count} px `
    + `(${(100 * changed.count / (frames.before.width * frames.before.height)).toFixed(2)}% of frame) `
    + `bbox y[${changed.minY}..${changed.maxY}]  standoff=${probe.aim?.distance}m `
    + `faceHeight=${probe.aim?.faceHeight?.toFixed(2)}m sightline=${probe.aim?.sightline?.toFixed(2)}m`);
  console.log(`    junction: parcelIdx=${ab.split?.parcelSkirtIndexCount} totalIdx=${ab.total} `
    + `seg=${ab.split?.segments} tri=${ab.split?.triangles} maxHeight=${ab.split?.maxHeight?.toFixed?.(2)}m`);
  await page.close();
}
await browser.close();
server.close();
console.log(`\nHOUSE FLOAT SHOTS: ${results.length * 2} captures in ${OUT}`);
console.log(`FRAME CONTRACT: PASS (eye clearance > ${MIN_EYE_CLEARANCE}m, up = [0,1,0], `
  + `bottom-third ground >= ${(MIN_GROUND_RATIO * 100).toFixed(0)}% on all ${results.length * 2} frames)`);
