import { createPostQualityState } from '../../../src/api/post-quality.js';

const DEG2RAD_HALF = Math.PI / 360;
const finitePositive = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? value : fallback
);

/** Numeric camera history whose live sample path allocates no arrays or vectors. */
export function createCameraMotionTracker() {
  let primed = false;
  let px = 0; let py = 0; let pz = 0;
  let qx = 0; let qy = 0; let qz = 0; let qw = 1;
  let focal = 1;
  let depth = 1;
  let viewX = 0; let viewY = 0;
  let viewportWidth = 1; let viewportHeight = 1;

  const tracker = {
    motionPx: 0,
    reset() {
      primed = false;
      tracker.motionPx = 0;
    },
    sample(camera, width, height, referenceDepth) {
      const w = finitePositive(width, 1);
      const h = finitePositive(height, 1);
      const position = camera.position;
      const quaternion = camera.quaternion;
      const zoom = finitePositive(camera.zoom, 1);
      const tanHalfFov = Math.max(1e-6, Math.tan(camera.fov * DEG2RAD_HALF) / zoom);
      const nextFocal = h / (2 * tanHalfFov);
      const nextDepth = finitePositive(referenceDepth, depth);
      const view = camera.view;
      const viewEnabled = !!view?.enabled;
      const viewWidth = viewEnabled ? finitePositive(view.width, w) : w;
      const viewHeight = viewEnabled ? finitePositive(view.height, h) : h;
      const fullWidth = viewEnabled ? finitePositive(view.fullWidth, viewWidth) : viewWidth;
      const fullHeight = viewEnabled ? finitePositive(view.fullHeight, viewHeight) : viewHeight;
      const offsetX = viewEnabled && Number.isFinite(view.offsetX) ? view.offsetX : 0;
      const offsetY = viewEnabled && Number.isFinite(view.offsetY) ? view.offsetY : 0;
      const nextViewX = viewEnabled
        ? (fullWidth * 0.5 - offsetX - viewWidth * 0.5) * w / viewWidth
        : 0;
      const nextViewY = viewEnabled
        ? (fullHeight * 0.5 - offsetY - viewHeight * 0.5) * h / viewHeight
        : 0;

      if (!primed || w !== viewportWidth || h !== viewportHeight) {
        tracker.motionPx = 0;
        primed = true;
      } else {
        const dx = position.x - px;
        const dy = position.y - py;
        const dz = position.z - pz;
        const scale = Math.max(focal, nextFocal);
        const translation = Math.hypot(dx, dy, dz)
          * scale / Math.max(1e-3, Math.min(depth, nextDepth));
        const quaternionDot = Math.min(1, Math.abs(
          quaternion.x * qx + quaternion.y * qy + quaternion.z * qz + quaternion.w * qw
        ));
        const rotation = 2 * Math.acos(quaternionDot) * scale;
        const lens = 0.5 * Math.hypot(w, h) * Math.abs(Math.log(nextFocal / focal));
        const viewShift = Math.hypot(nextViewX - viewX, nextViewY - viewY);
        tracker.motionPx = Math.max(translation, rotation, lens, viewShift);
      }

      px = position.x; py = position.y; pz = position.z;
      qx = quaternion.x; qy = quaternion.y; qz = quaternion.z; qw = quaternion.w;
      focal = nextFocal;
      depth = nextDepth;
      viewX = nextViewX; viewY = nextViewY;
      viewportWidth = w; viewportHeight = h;
      return tracker.motionPx;
    },
  };
  return tracker;
}

/** App adapter joining the pure quality state to the existing Bokeh uniform. */
export function createPostQualityRuntime({ camera, bokehPass, width, height }) {
  const quality = createPostQualityState();
  const motion = createCameraMotionTracker();
  let viewportWidth = Math.max(1, width);
  let viewportHeight = Math.max(1, height);

  return {
    update(dt, referenceDepth) {
      if (!(dt > 0)) return quality;
      const motionPx = motion.sample(
        camera,
        viewportWidth,
        viewportHeight,
        referenceDepth,
      );
      quality.update(dt, motionPx);
      bokehPass.setBokehQuality(quality.quality);
      return quality;
    },
    resize(nextWidth, nextHeight) {
      viewportWidth = Math.max(1, nextWidth);
      viewportHeight = Math.max(1, nextHeight);
      motion.reset();
    },
    debug() {
      return {
        postQuality: quality.quality,
        postQualityMode: quality.mode,
        postMotionPx: motion.motionPx,
        postMotionSpeed: quality.speed,
        activeBokehTaps: bokehPass.enabled ? bokehPass.bokehSampleCount : 0,
      };
    },
  };
}
