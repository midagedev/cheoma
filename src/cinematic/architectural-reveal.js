// Deterministic, renderer-free camera choreography for an architectural reveal.
//
// The core owns only numbers and time. A framework adapter applies each sampled
// frame to its camera/controls, which keeps input handoff and lifecycle out of this
// reusable path. Both profiles are endpoint exact with zero endpoint velocity:
//   arrival — a broad establishing arc that settles into the authored close view.
//   rebuild — a restrained breathing arc from the live frame to the new framing.

// No global RNG is consumed. `seed` only chooses the side of the orbit through a
// stable integer mix, so village generation remains byte-identical.

const DEG = Math.PI / 180;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smootherstep = (value) => {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const point = (value = {}) => ({
  x: finite(value.x),
  y: finite(value.y),
  z: finite(value.z),
});
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const lerp = (a, b, t) => a + (b - a) * t;
const lerpPoint = (a, b, t) => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

function mixedSeed(seed) {
  let value = finite(seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function shortestAngle(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function polarOffset(offset) {
  return {
    angle: Math.atan2(offset.x, offset.z),
    radius: Math.max(1e-6, Math.hypot(offset.x, offset.z)),
    y: offset.y,
  };
}

function frame(value = {}) {
  return Object.freeze({
    position: Object.freeze(point(value.position)),
    target: Object.freeze(point(value.target)),
    fov: finite(value.fov, 28),
    referenceFov: finite(value.referenceFov, finite(value.fov, 28)),
    composition: clamp01(finite(value.composition)),
  });
}

function profileFor(kind, motion, subjectSize) {
  const size = Math.max(4, finite(subjectSize, 12));
  if (motion === 'reduced') {
    return { duration: 0, sweep: 0, radialBreath: 0, verticalBreath: 0, startScale: 1, startRise: 0 };
  }
  const compact = motion === 'compact';
  if (kind === 'arrival') {
    return {
      duration: compact ? 4.2 : 5.8,
      sweep: (compact ? 22 : 70) * DEG,
      radialBreath: 0,
      verticalBreath: 0,
      startScale: compact ? 1.28 : 1.62,
      startRise: Math.min(compact ? 2.8 : 5.2, Math.max(compact ? 1.4 : 2.6, size * (compact ? 0.12 : 0.22))),
    };
  }
  return {
    duration: compact ? 2.35 : 3.15,
    sweep: (compact ? 6 : 13) * DEG,
    radialBreath: Math.min(compact ? 0.8 : 1.8, size * (compact ? 0.045 : 0.085)),
    verticalBreath: Math.min(compact ? 0.35 : 0.85, size * (compact ? 0.025 : 0.05)),
    startScale: 1,
    startRise: 0,
  };
}

/**
 * Create an immutable reveal descriptor.
 *
 * `from` is the exact currently presented camera frame. `to` is the authored
 * destination. Arrival replaces only its starting position/lens with an
 * establishing view; rebuild preserves both supplied endpoints exactly.
 */
export function createArchitecturalReveal({
  kind = 'rebuild',
  from,
  to,
  seed = 0,
  subjectSize = 12,
  motion = 'full',
  duration,
} = {}) {
  if (kind !== 'arrival' && kind !== 'rebuild') {
    throw new Error(`Unknown architectural reveal kind: ${kind}`);
  }
  if (!from || !to) throw new TypeError('Architectural reveal requires from and to frames');

  const destination = frame(to);
  const source = frame(from);
  const profile = profileFor(kind, motion, subjectSize);
  const side = (mixedSeed(seed) & 1) === 0 ? -1 : 1;
  const endOffset = polarOffset(sub(destination.position, destination.target));
  let start = source;

  if (kind === 'arrival' && motion !== 'reduced') {
    const startAngle = endOffset.angle + profile.sweep * side;
    const startRadius = endOffset.radius * profile.startScale;
    const startTarget = {
      ...destination.target,
      y: destination.target.y + Math.min(2.4, Math.max(0.7, finite(subjectSize, 12) * 0.08)),
    };
    start = frame({
      position: add(startTarget, {
        x: Math.sin(startAngle) * startRadius,
        y: endOffset.y + profile.startRise,
        z: Math.cos(startAngle) * startRadius,
      }),
      target: startTarget,
      fov: Math.max(destination.fov + (motion === 'compact' ? 8 : 14), motion === 'compact' ? 28 : 32),
      referenceFov: Math.max(
        destination.referenceFov + (motion === 'compact' ? 8 : 14),
        motion === 'compact' ? 28 : 32,
      ),
      composition: Math.min(destination.composition, motion === 'compact' ? 0.35 : 0.15),
    });
  }

  // Reduced motion is an exact destination cut. It intentionally ignores an
  // arbitrary current frame so assistive preferences never inherit a long dolly.
  if (motion === 'reduced') start = destination;

  return Object.freeze({
    kind,
    motion,
    seed: finite(seed) >>> 0,
    duration: motion === 'reduced'
      ? 0
      : Math.max(0, Number.isFinite(duration) ? duration : profile.duration),
    side,
    start,
    end: destination,
    sweep: profile.sweep * side,
    radialBreath: profile.radialBreath,
    verticalBreath: profile.verticalBreath,
  });
}

/** Sample a reveal without mutating the descriptor or any scene state. */
export function sampleArchitecturalReveal(shot, progress) {
  if (!shot?.start || !shot?.end) throw new TypeError('Invalid architectural reveal descriptor');
  const t = clamp01(progress);
  const k = smootherstep(t);
  const target = lerpPoint(shot.start.target, shot.end.target, k);
  const start = polarOffset(sub(shot.start.position, shot.start.target));
  const end = polarOffset(sub(shot.end.position, shot.end.target));
  const baseAngle = start.angle + shortestAngle(start.angle, end.angle) * k;
  const endpointBump = Math.sin(Math.PI * t) ** 2; // value and first derivative are 0 at both ends
  const angle = baseAngle + (shot.kind === 'rebuild' ? shot.sweep * endpointBump : 0);
  const radius = lerp(start.radius, end.radius, k) + shot.radialBreath * endpointBump;
  const relativeY = lerp(start.y, end.y, k) + shot.verticalBreath * endpointBump;

  return {
    progress: t,
    position: add(target, {
      x: Math.sin(angle) * radius,
      y: relativeY,
      z: Math.cos(angle) * radius,
    }),
    target,
    fov: lerp(shot.start.fov, shot.end.fov, k),
    referenceFov: lerp(shot.start.referenceFov, shot.end.referenceFov, k),
    composition: lerp(shot.start.composition, shot.end.composition, k),
  };
}

/** A tiny pure clock used by both the live adapter and deterministic seek gates. */
export function createArchitecturalRevealTimeline(shot) {
  let elapsed = 0;
  let done = shot.duration <= 0;
  const progress = () => done ? 1 : clamp01(elapsed / shot.duration);
  return {
    advance(seconds) {
      if (!done) {
        elapsed = Math.min(shot.duration, elapsed + Math.max(0, finite(seconds)));
        done = elapsed >= shot.duration;
      }
      return sampleArchitecturalReveal(shot, progress());
    },
    seek(value) {
      const p = clamp01(value);
      elapsed = shot.duration * p;
      done = p >= 1 || shot.duration <= 0;
      return sampleArchitecturalReveal(shot, p);
    },
    sample: () => sampleArchitecturalReveal(shot, progress()),
    progress,
    isDone: () => done,
  };
}
