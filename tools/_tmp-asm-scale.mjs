import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = '/Users/hckim/repo/asiahouse/.claude/worktrees/agent-addfb80313bf43ede';
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: { contents: "export { buildParcel } from './src/api/building.js';", resolveDir: ROOT, sourcefile: 'p.js' },
  alias: {
    'three/addons': join(ROOT, 'app/node_modules/three/examples/jsm'),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false, logLevel: 'silent',
});
function mk() {
  const noop = () => {};
  const g = Object.freeze({ addColorStop: noop });
  let c;
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return c;
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => g;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (!(k in t)) t[k] = noop;
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  c = { width: 0, height: 0, getContext: () => ctx };
  return c;
}
globalThis.document = { createElement: () => mk() };
const { buildParcel } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const root = buildParcel({ seed: 20260716, style: 'hanok', plotW: 20, plotD: 18, lanterns: false });
const out = [];
root.traverse((o) => {
  const s = o.scale;
  if (Math.abs(s.x - 1) > 1e-6 || Math.abs(s.y - 1) > 1e-6 || Math.abs(s.z - 1) > 1e-6) {
    const chain = [];
    let p = o;
    while (p) { chain.unshift(p.name || p.type); p = p.parent; }
    out.push(`${chain.join('/')} scale=(${s.x},${s.y},${s.z})`);
  }
});
console.log(out.length ? out.slice(0, 20).join('\n') : 'no non-unit scales');
console.log(`total non-unit scales: ${out.length}`);
