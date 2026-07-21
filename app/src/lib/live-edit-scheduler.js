// Frame-aware scheduler for geometry-backed controls. UI values update on every
// input event, while expensive previews are latest-wins and adapt to their own
// measured rebuild cost. The final commit is synchronous and cancels any stale
// preview so persistence work (flora, pick bounds) happens exactly once.

const finitePositive = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? value : fallback
);

export function createLiveEditScheduler({
  preview,
  commit,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  now = () => performance.now(),
  minIntervalMs = 32,
  maxIntervalMs = 96,
  costHeadroom = 2.2,
} = {}) {
  if (typeof preview !== 'function' || typeof commit !== 'function') {
    throw new TypeError('live edit scheduler requires preview and commit callbacks');
  }
  if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function' || typeof now !== 'function') {
    throw new TypeError('live edit scheduler requires frame and clock functions');
  }

  const minInterval = finitePositive(minIntervalMs, 32);
  const maxInterval = Math.max(minInterval, finitePositive(maxIntervalMs, 96));
  const headroom = finitePositive(costHeadroom, 2.2);
  let frame = null;
  let dirty = false;
  let disposed = false;
  let epoch = 0;
  let nextPreviewAt = -Infinity;
  let previewCount = 0;
  let commitCount = 0;
  let lastCostMs = 0;
  let lastIntervalMs = minInterval;

  const schedule = () => {
    if (disposed || !dirty || frame != null) return;
    const scheduledEpoch = epoch;
    frame = requestFrame((timestamp) => {
      frame = null;
      if (disposed || scheduledEpoch !== epoch || !dirty) return;
      const frameTime = Number.isFinite(timestamp) ? timestamp : now();
      if (frameTime + 0.01 < nextPreviewAt) {
        schedule();
        return;
      }

      dirty = false;
      const startedAt = now();
      preview();
      lastCostMs = Math.max(0, now() - startedAt);
      lastIntervalMs = Math.min(maxInterval, Math.max(minInterval, lastCostMs * headroom));
      nextPreviewAt = startedAt + lastIntervalMs;
      previewCount++;
      if (dirty) schedule();
    });
  };

  const cancelPending = () => {
    epoch++;
    dirty = false;
    nextPreviewAt = -Infinity;
    if (frame != null) cancelFrame(frame);
    frame = null;
  };

  return {
    request() {
      if (disposed) return false;
      dirty = true;
      schedule();
      return true;
    },

    commit() {
      if (disposed) return false;
      cancelPending();
      commit();
      commitCount++;
      return true;
    },

    cancel: cancelPending,

    dispose() {
      if (disposed) return;
      cancelPending();
      disposed = true;
    },

    snapshot() {
      return Object.freeze({
        pending: dirty || frame != null,
        disposed,
        previewCount,
        commitCount,
        lastCostMs,
        lastIntervalMs,
      });
    },
  };
}
