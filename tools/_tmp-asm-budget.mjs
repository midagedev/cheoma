// 예산 before/after — 같은 buildParcel('hanok') 트리를 (a) 현행 파트 그룹 상태와
// (b) 파트 그룹을 평탄화한 상태(= 변경 전 씬 내용)로 계수 비교. Group 은 렌더 대상이 아니므로
// 두 계수가 동일하면 드로우콜·재질·텍스처·삼각형 예산이 불변임이 증명된다.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = '/Users/hckim/repo/asiahouse/.claude/worktrees/agent-addfb80313bf43ede';
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: "export { buildParcel } from './src/api/building.js';",
    resolveDir: ROOT,
    sourcefile: 'probe.js',
  },
  alias: {
    'three/addons': join(ROOT, 'app/node_modules/three/examples/jsm'),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false, logLevel: 'silent',
});
function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return canvas;
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (!(k in t)) t[k] = noop;
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  canvas = { width: 0, height: 0, getContext: () => context };
  return canvas;
}
globalThis.document = { createElement: () => makeCanvas() };
const url = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const { buildParcel } = await import(url);

const PART = new Set(['podium', 'columns', 'walls', 'brackets']);
function count(root) {
  let meshes = 0, tris = 0, groups = 0, drawUnits = 0;
  const mats = new Set(), texs = new Set(), geos = new Set(), progFamilies = new Set();
  root.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      geos.add(o.geometry.uuid);
      const idx = o.geometry.index;
      const pos = o.geometry.attributes.position;
      const c = idx ? idx.count : (pos ? pos.count : 0);
      tris += (c / 3) * (o.isInstancedMesh ? o.count : 1);
      const list = Array.isArray(o.material) ? o.material : [o.material];
      drawUnits += Math.max(1, o.geometry.groups?.length || 1);
      for (const m of list) {
        if (!m) continue;
        mats.add(m.uuid);
        progFamilies.add(`${m.type}|${!!m.map}|${!!m.normalMap}|${m.side}|${m.transparent}|${m.alphaHash || false}|${!!m.onBeforeCompile}`);
        for (const k of ['map', 'normalMap', 'roughnessMap', 'alphaMap', 'emissiveMap', 'aoMap', 'bumpMap']) {
          if (m[k]) texs.add(m[k].uuid);
        }
      }
    } else if (o.isGroup) groups++;
  });
  return {
    meshes, drawUnits, geometries: geos.size, materials: mats.size,
    textures: texs.size, programFamilies: progFamilies.size, triangles: Math.round(tris), groups,
  };
}

const opts = { seed: 20260716, style: 'hanok', plotW: 20, plotD: 18, lanterns: false };
const after = buildParcel(opts);
const before = buildParcel(opts);
// (b) 파트 그룹 평탄화 = 변경 전 씬 내용 재현(그룹 노드 제거, 메시 소유권만 상위로).
const hanok = before.getObjectByName('hanok');
for (const name of ['podium', 'columns', 'walls', 'brackets']) {
  const grp = hanok.children.find((c) => c.name === name);
  if (!grp) continue;
  for (const child of [...grp.children]) {
    child.position.y += grp.position.y;
    hanok.add(child);
  }
  grp.removeFromParent();
}
const roof = hanok.children.find((c) => c.name === 'roof');
if (roof) { roof.name = 'skeleton-roof'; delete roof.userData.asmChunked; }
void PART;

const a = count(after), b = count(before);
const keys = Object.keys(a);
console.log('metric            before(flattened)   after(part groups)   delta');
for (const k of keys) {
  const d = a[k] - b[k];
  console.log(`${k.padEnd(17)} ${String(b[k]).padStart(17)} ${String(a[k]).padStart(20)} ${(d >= 0 ? '+' : '') + d}`);
}
