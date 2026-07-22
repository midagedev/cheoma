import assert from 'node:assert/strict';
import { createLiveEditScheduler } from '../app/src/lib/live-edit-scheduler.js';

let clock = 0;
let nextFrameId = 0;
const frames = new Map();
const events = [];
const requestFrame = (callback) => {
  const id = ++nextFrameId;
  frames.set(id, callback);
  return id;
};
const cancelFrame = (id) => frames.delete(id);
const runFrame = (time) => {
  clock = time;
  const first = frames.entries().next().value;
  assert.ok(first, `no frame was scheduled at ${time}ms`);
  const [id, callback] = first;
  frames.delete(id);
  callback(time);
};

const scheduler = createLiveEditScheduler({
  preview: () => { events.push('preview'); clock += 8; },
  commit: () => events.push('commit'),
  requestFrame,
  cancelFrame,
  now: () => clock,
  minIntervalMs: 32,
  maxIntervalMs: 96,
  costHeadroom: 2.2,
});

for (let i = 0; i < 50; i++) scheduler.request();
assert.equal(frames.size, 1, 'input burst scheduled more than one frame');
runFrame(0);
assert.deepEqual(events, ['preview'], 'latest-wins burst did not produce one preview');
assert.equal(scheduler.snapshot().lastIntervalMs, 32, 'fast preview did not use the smooth minimum interval');

scheduler.request();
runFrame(16);
assert.deepEqual(events, ['preview'], 'cooldown frame rebuilt too early');
assert.equal(frames.size, 1, 'cooldown did not retain one scheduled frame');
runFrame(32);
assert.deepEqual(events, ['preview', 'preview'], 'latest value was not rebuilt after cooldown');

scheduler.request();
assert.equal(frames.size, 1, 'commit fixture did not schedule a preview');
scheduler.commit();
assert.equal(frames.size, 0, 'commit left a stale preview frame');
assert.deepEqual(events, ['preview', 'preview', 'commit'], 'commit did not supersede the pending preview');
assert.deepEqual(scheduler.snapshot(), {
  pending: false,
  disposed: false,
  previewCount: 2,
  commitCount: 1,
  lastCostMs: 8,
  lastIntervalMs: 32,
});

scheduler.request();
scheduler.cancel();
assert.equal(frames.size, 0, 'focus cancellation left scheduled work');
runCancelledCallbackSafety();
runAdaptiveCostContract();
runDisplayCadenceContracts();

function runCancelledCallbackSafety() {
  // A browser may already have dequeued a callback when cancellation occurs.
  // Replaying an epoch-stale callback must therefore remain a no-op.
  let staleCallback;
  const stale = createLiveEditScheduler({
    preview: () => events.push('stale-preview'),
    commit: () => {},
    requestFrame: (callback) => { staleCallback = callback; return 1; },
    cancelFrame: () => {},
    now: () => clock,
  });
  stale.request();
  stale.cancel();
  staleCallback(clock + 100);
  assert.ok(!events.includes('stale-preview'), 'cancelled focus work crossed its epoch');
  stale.dispose();
}

function runAdaptiveCostContract() {
  let adaptiveClock = 100;
  let adaptiveFrame;
  const adaptive = createLiveEditScheduler({
    preview: () => { adaptiveClock += 30; },
    commit: () => {},
    requestFrame: (callback) => { adaptiveFrame = callback; return 1; },
    cancelFrame: () => {},
    now: () => adaptiveClock,
    minIntervalMs: 32,
    maxIntervalMs: 96,
    costHeadroom: 2.2,
  });
  adaptive.request();
  adaptiveFrame(adaptiveClock);
  assert.equal(adaptive.snapshot().lastCostMs, 30, 'preview cost was not measured');
  assert.equal(adaptive.snapshot().lastIntervalMs, 66, 'preview cadence did not adapt to rebuild cost');
  adaptive.dispose();
}

function runDisplayCadenceContracts() {
  const sixtyHz = cadenceFixture(8);
  for (const time of [0, 16, 32, 48, 64, 80]) sixtyHz.inputFrame(time);
  assert.deepEqual(sixtyHz.starts, [0, 32, 64],
    '60Hz input did not settle to one preview every other displayed frame');
  sixtyHz.dispose();

  const lowFps = cadenceFixture(8);
  for (const time of [0, 40, 80, 120]) lowFps.inputFrame(time);
  assert.deepEqual(lowFps.starts, [0, 40, 80, 120],
    '40ms display frames were throttled despite already satisfying the minimum interval');
  lowFps.dispose();

  const irregular = cadenceFixture(8);
  for (const time of [0, 11, 37, 53, 94, 111, 145]) irregular.inputFrame(time);
  assert.deepEqual(irregular.starts, [0, 37, 94, 145],
    'irregular display frames did not retain the latest input at the wall-clock cadence');
  assertCadence(irregular.starts, 32, 'irregular display cadence');
  irregular.dispose();

  const adaptive = cadenceFixture(30);
  for (const time of [0, 40, 80, 112, 1000]) adaptive.inputFrame(time);
  assert.deepEqual(adaptive.starts, [0, 80, 1000],
    'adaptive cadence or a paused-tab frame discarded the latest input');
  assertCadence(adaptive.starts, 66, 'adaptive display cadence');
  assert.equal(adaptive.scheduler.snapshot().lastIntervalMs, 66,
    'display cadence fixture did not retain measured rebuild headroom');
  adaptive.dispose();
}

function cadenceFixture(previewCostMs) {
  let cadenceClock = 0;
  let nextId = 0;
  const cadenceFrames = new Map();
  const starts = [];
  const scheduler = createLiveEditScheduler({
    preview: () => {
      starts.push(cadenceClock);
      cadenceClock += previewCostMs;
    },
    commit: () => {},
    requestFrame: (callback) => {
      const id = ++nextId;
      cadenceFrames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => cadenceFrames.delete(id),
    now: () => cadenceClock,
    minIntervalMs: 32,
    maxIntervalMs: 96,
    costHeadroom: 2.2,
  });
  return {
    starts,
    scheduler,
    inputFrame(time) {
      cadenceClock = time;
      scheduler.request();
      const first = cadenceFrames.entries().next().value;
      assert.ok(first, `no cadence frame was scheduled at ${time}ms`);
      const [id, callback] = first;
      cadenceFrames.delete(id);
      callback(time);
    },
    dispose() {
      scheduler.dispose();
      assert.equal(cadenceFrames.size, 0, 'cadence fixture left a scheduled frame');
    },
  };
}

function assertCadence(starts, minimumGapMs, label) {
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= minimumGapMs,
      `${label} rebuilt after ${starts[i] - starts[i - 1]}ms`);
  }
}

scheduler.dispose();
assert.equal(scheduler.request(), false, 'disposed scheduler accepted input');
assert.equal(scheduler.commit(), false, 'disposed scheduler accepted commit');

console.log('LIVE EDIT SCHEDULER: PASS (50→1 coalescing, display-aware adaptive cooldown, exact commit, epoch cancellation)');
