export function createAbortError(message = 'Engine disposed') {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function combineAbortSignals(primary, secondary) {
  if (!secondary || secondary === primary) return { signal: primary, dispose() {} };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([primary, secondary]), dispose() {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener('abort', abort, { once: true });
  secondary.addEventListener('abort', abort, { once: true });
  if (primary.aborted || secondary.aborted) abort();
  return {
    signal: controller.signal,
    dispose() {
      primary.removeEventListener('abort', abort);
      secondary.removeEventListener('abort', abort);
    },
  };
}

// Browser callbacks owned directly by one runtime pass through one registry.
// cancelAll() invalidates them before the owner releases scene/WebGL resources.
export function createTaskOwner(isLive) {
  const timeouts = new Set();
  const intervals = new Set();
  const frames = new Set();
  const idles = new Set();
  const after = (fn, delay = 0) => {
    if (!isLive()) return null;
    const handle = setTimeout(() => {
      timeouts.delete(handle);
      if (isLive()) fn();
    }, delay);
    timeouts.add(handle);
    return handle;
  };
  const every = (fn, delay) => {
    if (!isLive()) return null;
    const handle = setInterval(() => { if (isLive()) fn(); }, delay);
    intervals.add(handle);
    return handle;
  };
  const frame = (fn) => {
    if (!isLive()) return null;
    const handle = requestAnimationFrame((now) => {
      frames.delete(handle);
      if (isLive()) fn(now);
    });
    frames.add(handle);
    return handle;
  };
  const idle = (fn, opts) => {
    if (!isLive()) return null;
    if (typeof requestIdleCallback !== 'function') return after(fn, 500);
    const handle = requestIdleCallback((deadline) => {
      idles.delete(handle);
      if (isLive()) fn(deadline);
    }, opts);
    idles.add(handle);
    return handle;
  };
  const clearAfter = (handle) => {
    if (handle == null) return;
    clearTimeout(handle);
    timeouts.delete(handle);
  };
  const clearEvery = (handle) => {
    if (handle == null) return;
    clearInterval(handle);
    intervals.delete(handle);
  };
  const clearFrame = (handle) => {
    if (handle == null) return;
    cancelAnimationFrame(handle);
    frames.delete(handle);
  };
  const cancelAll = () => {
    for (const handle of timeouts) clearTimeout(handle);
    for (const handle of intervals) clearInterval(handle);
    for (const handle of frames) cancelAnimationFrame(handle);
    if (typeof cancelIdleCallback === 'function') {
      for (const handle of idles) cancelIdleCallback(handle);
    }
    timeouts.clear(); intervals.clear(); frames.clear(); idles.clear();
  };
  return { after, every, frame, idle, clearAfter, clearEvery, clearFrame, cancelAll };
}

// Wrap function-valued descriptors only. Accessors and nested Three objects stay
// untouched, and the public object/function identities remain stable thereafter.
export function guardApiMethods(api, {
  scope = '', isDisposed, onDisposed, skip = [],
} = {}) {
  const skipped = new Set(skip);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(api))) {
    const original = descriptor.value;
    if (typeof original !== 'function' || skipped.has(key)) continue;
    const path = scope ? `${scope}.${key}` : key;
    const guarded = function guardedEngineMethod(...args) {
      if (isDisposed()) return onDisposed(path);
      return Reflect.apply(original, this, args);
    };
    try { Object.defineProperty(guarded, 'name', { value: original.name, configurable: true }); } catch {}
    try { Object.defineProperty(guarded, 'length', { value: original.length, configurable: true }); } catch {}
    Object.defineProperty(api, key, { ...descriptor, value: guarded });
  }
}
