// #56 v3 ①: identify, by rendered pixels rather than by argument, which junction
// quads form the two bright pointed spikes seen in v2-house-float-dolran-worst-after.
//
// Method: render ONLY the guardian-돌단 junction, one flat ID colour per segment, from
// the exact v2 camera. Then find connected components of the silhouette, rank them by
// thinness, and read each component's modal ID colour back to a segment index. That
// names the geometry without any interpretation of a photograph.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'scratch/house-float/renders');
mkdirSync(OUT, { recursive: true });
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';
import { terrainMeshHeightAt } from '/src/village/terrain-grid.js';
import { planFeatureGroundJunctions } from '/src/village/feature-junction-plan.js';

{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(1280, 720);
renderer.setPixelRatio(1);
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(48, 1280 / 720, 0.1, 3000);

const village = await createVillage({ scale: 'hanyang', seed: 1, sync: true });
const site = village.plan.site;
const junctions = planFeatureGroundJunctions(village.plan, site);
const dolran = junctions.filter((entry) => entry.kind === 'guardian-dolran');

// The v2 dolran camera, verbatim.
camera.up.set(0, 1, 0);
camera.position.set(154.7, -0.8, 91.9);
const worst = (() => {
  let best = null;
  for (const entry of dolran) {
    for (const segment of entry.junction.segments) {
      const mx = (segment.a.x + segment.b.x) / 2, mz = (segment.a.z + segment.b.z) / 2;
      if (Math.hypot(mx - 155, mz - 85) > 60) continue;
      if (!best || segment.height > best.height) best = segment;
    }
  }
  return best;
})();
const mid = { x: (worst.a.x + worst.b.x) / 2, z: (worst.a.z + worst.b.z) / 2 };
camera.lookAt(mid.x, (worst.topY + worst.bottomY) / 2, mid.z);
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);

// One flat ID colour per segment of the target entry, drawn unlit so the colour read
// back from the framebuffer is exactly the ID.
const target = dolran.find((entry) => entry.junction.segments.includes(worst));
const LAYER = new URLSearchParams(location.search).get('layer') || 'all';
const positions = [], colors = [], indices = [];
const idOf = (index) => {
  const value = index + 1;                    // 0 reserved for background
  return [((value >> 0) & 15) / 15, ((value >> 4) & 15) / 15, ((value >> 8) & 15) / 15];
};
const segmentMeta = [];
for (const [segmentIndex, segment] of target.junction.segments.entries()) {
  const nx = segment.normal.x, nz = segment.normal.z;
  const [r, g, b] = idOf(segmentIndex);
  for (const [courseIndex, course] of segment.courses.entries()) {
    const to = course.outsetTop, bo = course.outsetBottom;
    if (LAYER === 'all' || LAYER === 'faces') {
      const base = positions.length / 3;
      positions.push(
        segment.a.x + nx * to, course.topY, segment.a.z + nz * to,
        segment.a.x + nx * bo, course.bottomY, segment.a.z + nz * bo,
        segment.b.x + nx * to, course.topY, segment.b.z + nz * to,
        segment.b.x + nx * bo, course.bottomY, segment.b.z + nz * bo,
      );
      for (let v = 0; v < 4; v++) colors.push(r, g, b);
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    if ((LAYER === 'all' || LAYER === 'ledges') && course.role === 'capstone' && to > 0) {
      const base = positions.length / 3;
      positions.push(
        segment.a.x, course.topY, segment.a.z,
        segment.a.x + nx * to, course.topY, segment.a.z + nz * to,
        segment.b.x, course.topY, segment.b.z,
        segment.b.x + nx * to, course.topY, segment.b.z + nz * to,
      );
      for (let v = 0; v < 4; v++) colors.push(r, g, b);
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    void courseIndex;
  }
  segmentMeta.push({
    segmentIndex,
    id: segmentIndex + 1,
    height: segment.height,
    courses: segment.courses.length,
    edge: segment.edge,
    a: segment.a, b: segment.b,
    bottomY: segment.bottomY,
    topY: segment.topY,
    groundAtA: terrainMeshHeightAt(site, segment.a.x, segment.a.z),
    groundAtB: terrainMeshHeightAt(site, segment.b.x, segment.b.z),
  });
}
if (LAYER === 'all' || LAYER === 'returns') {
  for (const record of target.junction.returns || []) {
    const [r, g, b] = idOf(record.ordinal);
    const base = positions.length / 3;
    positions.push(
      record.inner.x, record.topY, record.inner.z,
      record.inner.x, record.bottomY, record.inner.z,
      record.outer.x, record.topY, record.outer.z,
      record.outer.x, record.bottomY, record.outer.z,
    );
    for (let v = 0; v < 4; v++) colors.push(r, g, b);
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
}
const idGeometry = new THREE.BufferGeometry();
idGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
idGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
idGeometry.setIndex(indices);
const idMesh = new THREE.Mesh(idGeometry, new THREE.MeshBasicMaterial({
  vertexColors: true, side: THREE.DoubleSide,
}));
idMesh.name = 'junction-id';

// Terrain, so we can also see which spike pixels survive in front of the ground.
const villageRoot = village.group;
window.__modes = {
  idOnly: () => {
    scene.clear();
    scene.add(idMesh);
    renderer.render(scene, camera);
  },
  idWithTerrain: () => {
    scene.clear();
    scene.add(villageRoot);
    scene.add(idMesh);
    renderer.render(scene, camera);
  },
};
window.__meta = { segments: segmentMeta, worstHeight: worst.height, arcCount: target.junction.segments.length, entryId: target.id };
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
    response.writeHead(404); response.end('nope');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

function decodePng(buffer) {
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
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
  if (bitDepth !== 8) throw new Error('bit depth');
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let position = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[position++];
    const line = raw.subarray(position, position + stride); position += stride;
    const targetRow = out.subarray(row * stride, (row + 1) * stride);
    const previous = row > 0 ? out.subarray((row - 1) * stride, row * stride) : null;
    for (let index = 0; index < stride; index++) {
      const a = index >= channels ? targetRow[index - channels] : 0;
      const b = previous ? previous[index] : 0;
      const c = (previous && index >= channels) ? previous[index - channels] : 0;
      let value = line[index];
      if (filter === 1) value += a; else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      targetRow[index] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

// Connected components of non-black pixels, with the modal ID colour of each.
function components(png) {
  const { width, height, channels, data } = png;
  const seen = new Uint8Array(width * height);
  const out = [];
  const quantise = (value) => Math.round(value / 17);   // 15 steps of 17
  for (let start = 0; start < width * height; start++) {
    if (seen[start]) continue;
    const base = start * channels;
    if (data[base] + data[base + 1] + data[base + 2] < 12) { seen[start] = 1; continue; }
    const stack = [start];
    seen[start] = 1;
    let count = 0, minX = width, maxX = -1, minY = height, maxY = -1;
    const votes = new Map();
    while (stack.length) {
      const index = stack.pop();
      const x = index % width, y = (index - x) / width;
      const pixel = index * channels;
      const id = quantise(data[pixel]) | (quantise(data[pixel + 1]) << 4) | (quantise(data[pixel + 2]) << 8);
      votes.set(id, (votes.get(id) || 0) + 1);
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx2 = x + dx, ny2 = y + dy;
        if (nx2 < 0 || ny2 < 0 || nx2 >= width || ny2 >= height) continue;
        const next = ny2 * width + nx2;
        if (seen[next]) continue;
        const nb = next * channels;
        if (data[nb] + data[nb + 1] + data[nb + 2] < 12) { seen[next] = 1; continue; }
        seen[next] = 1; stack.push(next);
      }
    }
    const modal = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    const boxWidth = maxX - minX + 1, boxHeight = maxY - minY + 1;
    out.push({
      count, minX, maxX, minY, maxY, boxWidth, boxHeight,
      fill: count / (boxWidth * boxHeight),
      aspect: boxHeight / Math.max(1, boxWidth),
      modalId: modal[0], modalVotes: modal[1],
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
await page.goto(`http://127.0.0.1:${port}/?layer=${process.env.LAYER || 'all'}`);
await page.waitForFunction('window.__ready === true', { timeout: 240000 });
const meta = await page.evaluate('window.__meta');

await page.evaluate('window.__modes.idOnly()');
const idOnly = decodePng(await page.screenshot({ path: join(OUT, `v3-spike-id-${process.env.LAYER || 'all'}.png`) }));
await page.evaluate('window.__modes.idWithTerrain()');
const withTerrain = await page.screenshot({ path: join(OUT, `v3-spike-terrain-${process.env.LAYER || 'all'}.png`) });
void withTerrain;

console.log(`\nDOLRAN JUNCTION: entry=${meta.entryId} arc=${meta.arcCount} segments, `
  + `tallest face ${meta.worstHeight.toFixed(2)}m`);
const parts = components(idOnly);
console.log(`\nSILHOUETTE COMPONENTS of the junction alone (unoccluded): ${parts.length}`);
for (const part of parts.slice(0, 8)) {
  const segment = meta.segments.find((entry) => entry.id === part.modalId);
  console.log(`  ${String(part.count).padStart(7)} px  bbox ${part.boxWidth}x${part.boxHeight} `
    + `aspect ${part.aspect.toFixed(1)} fill ${part.fill.toFixed(2)}  `
    + `modal segment ${segment ? `#${segment.segmentIndex} h=${segment.height.toFixed(2)}m edge=${segment.edge}` : `id ${part.modalId}?`}`);
}

// Which segments sit at the two ENDS of the visible arc? Those terminal chords taper
// from full height to nothing, which is the classic "pointed triangle" silhouette.
const sorted = [...meta.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
console.log('\nARC PROFILE (segment order around the ring; height 0 = chord not emitted)');
console.log(sorted.map((segment) => `#${segment.segmentIndex}:${segment.height.toFixed(1)}`).join(' '));
const ends = [sorted[0], sorted.at(-1)];
for (const segment of ends) {
  console.log(`  terminal chord #${segment.segmentIndex}: height ${segment.height.toFixed(2)}m  `
    + `ground at ends ${segment.groundAtA.toFixed(2)} / ${segment.groundAtB.toFixed(2)}  `
    + `baseY ${segment.topY.toFixed(2)}  ->  exposed above ground at A: `
    + `${(segment.topY - segment.groundAtA).toFixed(2)}m, at B: ${(segment.topY - segment.groundAtB).toFixed(2)}m`);
}

await browser.close();
server.close();
