// Hop overlay prewarm contract (#hop freeze): cold residential showParcelDetailChunked
// must await an injected warm(group) callback while the draft is still off-scene, then
// only parent it after warm resolves. Node-only (no browser); canvas stub + createVillage
// seeded window — same pattern as assembly / wall-gate pure gates.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(target, key) {
      if (key === 'canvas') return canvas;
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      if (key === 'getImageData' || key === 'createImageData') {
        return (a, b, c, d) => {
          const w = Math.max(1, (key === 'createImageData' ? a : c) | 0);
          const h = Math.max(1, (key === 'createImageData' ? b : d) | 0);
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        };
      }
      if (!(key in target)) target[key] = noop;
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  canvas = { width: 0, height: 0, getContext: () => context };
  return canvas;
}
globalThis.document = globalThis.document || { createElement: () => makeCanvas() };

const built = await esbuild.build({
  stdin: {
    contents: "export { createVillage } from './src/runtime/village/create.js';",
    resolveDir: ROOT,
    sourcefile: 'hop-warm-contract-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const { createVillage } = await import(moduleUrl);

// 실패 메시지만 남긴다(번들이 data: URL 이라 스택에 모듈 전체가 실려 출력이 폭발한다).
process.on('uncaughtException', (error) => {
  console.error(`HOP WARM: FAIL — ${error.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(`HOP WARM: FAIL — ${error?.message || error}`);
  process.exit(1);
});

const results = [];
function record(ok, message) {
  results.push({ ok, message });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
}

function attachedToHandle(group, handleGroup) {
  let cur = group;
  while (cur) {
    if (cur === handleGroup) return true;
    cur = cur.parent;
  }
  return false;
}

function findResidentialParcel(handle) {
  return handle.plan.parcels.find((parcel) => !parcel.hero
    && parcel.kind
    && parcel.kind !== 'palace'
    && parcel.id !== 'palace'
    && parcel.id !== 'temple');
}

// ── Scenario A: warm once, before scene install ──────────────────────────────
{
  const handle = createVillage({ scale: 'hamlet', seed: 7, includePalace: false, includeTemple: false });
  const parcel = findResidentialParcel(handle);
  if (!parcel) {
    record(false, 'hamlet:7 has no residential parcel for hop warm');
  } else {
    let warmCalls = 0;
    let warmGroup = null;
    let parentAtWarm = 'unset';
    let attachedAtWarm = false;
    let warmResolvedBeforeReturn = false;
    let warmResolve = null;
    const warmGate = new Promise((resolve) => { warmResolve = resolve; });

    const warm = async (group) => {
      warmCalls += 1;
      warmGroup = group;
      parentAtWarm = group?.parent ?? null;
      attachedAtWarm = attachedToHandle(group, handle.group);
      // Hold warm open briefly so finish cannot sneak ahead of resolve.
      await warmGate;
      warmResolvedBeforeReturn = true;
    };

    const detailPromise = handle.showParcelDetailChunked(parcel.id, {
      yieldFrame: async () => {},
      isCancelled: () => false,
      warm,
    });

    // Give the chunked path a turn to reach warm (or finish without it).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // If warm never ran, unstick and finish so we can report FAIL cleanly.
    if (warmCalls === 0) {
      warmResolve();
      const detail = await detailPromise;
      record(false, `warm called exactly once (got ${warmCalls})`);
      record(false, 'warm invoked while group.parent is null (pre-install)');
      record(false, 'detail.group is warm group and parented after warm resolves');
      if (detail?.group) handle.hideParcelDetail(parcel.id);
    } else {
      // Warm is in flight — group must still be detached.
      const preParentOk = parentAtWarm == null && !attachedAtWarm;
      record(warmCalls === 1, `warm called exactly once (got ${warmCalls})`);
      record(preParentOk,
        `warm invoked while group.parent is null (pre-install; parent=${parentAtWarm}, attached=${attachedAtWarm})`);

      warmResolve();
      const detail = await detailPromise;
      const sameGroup = detail?.group === warmGroup;
      const parentedAfter = sameGroup && attachedToHandle(detail.group, handle.group);
      record(sameGroup && parentedAfter && warmResolvedBeforeReturn,
        'detail.group is warm group and parented after warm resolves');
      if (detail?.group) handle.hideParcelDetail(parcel.id);
    }
  }
  handle.dispose?.();
}

// ── Scenario B: cancel during warm aborts without scene install ──────────────
{
  const handle = createVillage({ scale: 'hamlet', seed: 7, includePalace: false, includeTemple: false });
  const parcel = findResidentialParcel(handle);
  if (!parcel) {
    record(false, 'cancel scenario: no residential parcel');
  } else {
    let cancelled = false;
    let warmGroup = null;
    let warmCalls = 0;
    let warmResolve = null;
    const warmGate = new Promise((resolve) => { warmResolve = resolve; });

    const warm = async (group) => {
      warmCalls += 1;
      warmGroup = group;
      cancelled = true; // flip mid-warm
      await warmGate;
    };

    const detailPromise = handle.showParcelDetailChunked(parcel.id, {
      yieldFrame: async () => {},
      isCancelled: () => cancelled,
      warm,
    });

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    if (warmCalls === 0) {
      warmResolve();
      await detailPromise;
      record(false, 'cancel-during-warm: warm ran so cancel can abort install');
      record(false, 'cancel-during-warm: detail is null and group never parented');
    } else {
      warmResolve();
      const detail = await detailPromise;
      const neverParented = warmGroup != null && !attachedToHandle(warmGroup, handle.group);
      record(true, 'cancel-during-warm: warm ran so cancel can abort install');
      record(detail == null && neverParented,
        `cancel-during-warm: detail is null and group never parented (detail=${detail}, attached=${!neverParented})`);
    }
  }
  handle.dispose?.();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('HOP WARM: FAIL');
  process.exit(1);
}
console.log('HOP WARM: PASS');
