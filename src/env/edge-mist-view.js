import { smoothstep } from '../core/math/scalar.js';

// A horizontal transparent annulus reads as distant ground mist from an eye-level
// view, but its triangles become broad overlapping wedges when the camera looks
// down through the surface. The separate upright ridge mist remains visible after
// this weight reaches zero and continues to own focused/aerial atmosphere.
const FADE_START = Math.sin(10 * Math.PI / 180);
const FADE_END = Math.sin(18 * Math.PI / 180);

export function edgeMistViewWeight(cameraForwardY) {
  if (!Number.isFinite(cameraForwardY)) return 0;
  return 1 - smoothstep(FADE_START, FADE_END, Math.max(0, -cameraForwardY));
}
