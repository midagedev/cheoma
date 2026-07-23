import { compileSubtreeAsync } from '../src/api/rendering.js';

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const root = { name: 'short-lived-focus-ring' };
const camera = { name: 'camera' };
const scene = { name: 'target-scene' };
const live = { name: 'live' };
const released = { name: 'released' };
let polls = 0;
let compileArgs;
const renderer = {
  compile(...args) {
    compileArgs = args;
    return new Set([live, released]);
  },
  properties: {
    get(material) {
      if (material === released) return {}; // disposed while the warm is pending
      return { currentProgram: { isReady: () => ++polls >= 2 } };
    },
  },
};

const result = await compileSubtreeAsync(renderer, root, camera, scene);
invariant(result === root, 'warm result does not preserve the subtree');
invariant(compileArgs?.[0] === root && compileArgs[1] === camera && compileArgs[2] === scene,
  'compile target arguments drifted');
invariant(polls === 2, `live program polling ended at ${polls}, expected 2`);

const failedRenderer = { compile() { throw new Error('context lost'); } };
invariant(await compileSubtreeAsync(failedRenderer, root, camera, scene) === root,
  'compile failure did not resolve to the original subtree');
invariant(await compileSubtreeAsync(null, root, camera, scene) === root,
  'missing renderer did not remain a no-op');

let abortPolls = 0;
const abortController = new AbortController();
const pending = compileSubtreeAsync({
  compile: () => new Set([live]),
  properties: { get: () => ({ currentProgram: { isReady: () => { abortPolls++; return false; } } }) },
}, root, camera, scene, { signal: abortController.signal });
abortController.abort();
invariant(await pending === root, 'aborted warm did not resolve to the original subtree');
await new Promise((resolve) => setTimeout(resolve, 30));
invariant(abortPolls === 0, `aborted warm kept polling (${abortPolls})`);

console.log('SHADER WARM CONTRACT: PASS (released materials + live polling + abort + failure fallback)');
