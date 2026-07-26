import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = '/Users/hckim/repo/asiahouse/.claude/worktrees/agent-addfb80313bf43ede';
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: { contents: "export { buildParcel, playAssembly } from './src/api/building.js';", resolveDir: ROOT, sourcefile: 'p.js' },
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
const { buildParcel, playAssembly } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

const PART = ['podium', 'columns', 'walls', 'brackets', 'roof'];
for (const style of ['palace', 'temple', 'choga']) {
  const root = buildParcel({ seed: 5, style, plotW: 24, plotD: 22, lanterns: false });
  console.log(`\n${style}: ${root.children.map((c) => `${c.name || c.type}(${c.children.length})`).join(' ')}`);
  for (const c of root.children) {
    if (!c.children?.length) continue;
    const direct = c.children.filter((x) => PART.includes(x.name) && x.children.length).map((x) => x.name);
    const delegated = direct.length >= 3 && direct.includes('podium') && direct.includes('roof');
    if (!delegated) continue;
    const plan = playAssembly(c, { duration: 5 }).plan();
    console.log(`  ${c.name} delegated -> ${plan.map((p) => `${p.part}(m${p.members} r${p.ranks} ${(p.rippleSec * 1000).toFixed(0)}ms${p.courseFlow ? ' flow' : ''})`).join(' ')}`);
  }
}
