// One-shot P0→P3 probe: can plain Node bake a building GLB?
// Always exits 0. Prints byte length on success, or exact error + stack top.
// Not a registered gate — packaging evidence only.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { makeRecordingCanvasFactory } from './lib/node-canvas-stub.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const api = (name) => pathToFileURL(resolve(ROOT, 'src/api', name)).href;
const builder = (name) => pathToFileURL(resolve(ROOT, 'src/builder', name)).href;

try {
  const { PRESETS, buildBuilding, disposeBuilding } = await import(api('building.js'));
  const { setPaletteContext, createPaletteContext } = await import(builder('palette.js'));
  const { exportGLB } = await import(api('export.js'));

  const factory = makeRecordingCanvasFactory();
  setPaletteContext(createPaletteContext({
    random: () => 0.5,
    createCanvas: factory.createCanvas,
  }));

  const root = buildBuilding({ ...PRESETS.giwa });
  const result = await exportGLB(root);
  disposeBuilding(root);

  if (result && result.overBudget) {
    console.log('PROBE-NODE-GLB: overBudget', JSON.stringify(result));
  } else if (result instanceof ArrayBuffer) {
    console.log(`PROBE-NODE-GLB: OK bytes=${result.byteLength}`);
  } else if (result && typeof result === 'object') {
    console.log(`PROBE-NODE-GLB: OK non-binary type=${typeof result} keys=${Object.keys(result).slice(0, 12).join(',')}`);
  } else {
    console.log(`PROBE-NODE-GLB: OK result type=${typeof result}`);
  }
} catch (err) {
  const msg = err && (err.message || String(err));
  const stack = err && err.stack ? String(err.stack) : String(err);
  const top = stack.split('\n').slice(0, 8).join('\n');
  console.log('PROBE-NODE-GLB: FAIL');
  console.log(msg);
  console.log(top);
}

process.exit(0);
