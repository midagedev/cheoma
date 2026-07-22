// Fast, browser-free DoF contract: camera-axis focus, single amount ownership,
// and transparent/decorative depth exclusion.
import * as THREE from '../app/node_modules/three/build/three.module.js';
import { readFile } from 'node:fs/promises';
import {
  contributesDofDepth,
  createDofController,
  focusDepthForPoint,
} from '../src/env/dof.js';
import {
  CIRCULAR_BOKEH_FRAGMENT_SHADER,
  CIRCULAR_BOKEH_KERNEL,
  CIRCULAR_BOKEH_MOVING_KERNEL,
  CIRCULAR_BOKEH_SAMPLE_COUNT,
  MOVING_BOKEH_SAMPLE_COUNT,
  installCircularBokeh,
} from '../src/env/circular-bokeh-shader.js';
import { createPostQualityState } from '../src/env/post-quality-state.js';
import { createCameraMotionTracker } from '../app/src/engine/post-quality-runtime.js';

const EPS = 1e-9;
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (actual, expected, message, epsilon = EPS) => {
  invariant(Math.abs(actual - expected) <= epsilon, `${message} (${actual} != ${expected})`);
};

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 0);
camera.lookAt(0, 0, -1);
camera.updateMatrixWorld(true);

const offAxis = new THREE.Vector3(10, 0, -10);
near(focusDepthForPoint(camera, offAxis), 10,
  'off-axis focus used Euclidean distance instead of camera-axis depth');
invariant(Math.abs(camera.position.distanceTo(offAxis) - 10) > 4,
  'off-axis fixture did not distinguish axial and Euclidean distance');
near(focusDepthForPoint(camera, new THREE.Vector3(-25, 8, -10)), 10,
  'lateral target motion changed a constant focus plane');
invariant(focusDepthForPoint(camera, new THREE.Vector3(0, 0, 1)) === null,
  'behind-camera target was clamped into a visible focus plane');
near(focusDepthForPoint(camera, new THREE.Vector3(0, 0, -1000)), 100,
  'focus depth ignored the camera far bound');

const rig = new THREE.Group();
const rigCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
rig.add(rigCamera);
rig.position.z = 5;
near(focusDepthForPoint(rigCamera, new THREE.Vector3(0, 0, -10)), 15,
  'focus depth read a stale parent camera rig transform');

const pass = {
  enabled: false,
  uniforms: {
    focus: { value: 40 },
    aperture: { value: 0.00012 },
  },
};
const dof = createDofController({ camera, pass, aperture: 0.00012 });
near(dof.amount, 0, 'disabled pass did not initialize with zero amount');
near(pass.uniforms.aperture.value, 0, 'zero amount left a residual aperture');
near(dof.focusAt(offAxis), 10, 'controller did not apply camera-axis focus');

const fadeIn = [0, 0.08, 0.25, 0.5, 0.82, 1].map((amount) => {
  dof.setAmount(amount);
  return { amount: dof.amount, aperture: pass.uniforms.aperture.value, enabled: pass.enabled };
});
invariant(fadeIn.every((sample, index) => index === 0 || sample.amount >= fadeIn[index - 1].amount),
  'focus-in amount was not monotonic');
invariant(fadeIn.every((sample) => sample.aperture >= 0 && sample.aperture <= dof.aperture + EPS),
  'focus-in aperture overshot its base value');
invariant(fadeIn[0].enabled === false && fadeIn.slice(1).every((sample) => sample.enabled),
  'amount did not exclusively own Bokeh pass enablement');

// Reversing a transition continues from its current amount and cannot strand an inflated aperture.
dof.setAmount(0.63);
const reverse = [0, 0.25, 0.5, 0.75, 1].map((k) => dof.setAmount(0.63 * (1 - k)));
invariant(reverse.every((amount, index) => index === 0 || amount <= reverse[index - 1]),
  'focus reversal was not monotonic');
near(dof.amount, 0, 'focus reversal left a residual amount');
near(pass.uniforms.aperture.value, 0, 'focus reversal left a residual aperture');
invariant(pass.enabled === false, 'zero amount left the Bokeh pass enabled');

dof.setEnabled(true);
dof.setAperture(0.0002);
near(dof.amount, 1, 'compatibility enable split from amount ownership');
near(pass.uniforms.aperture.value, 0.0002, 'base aperture update ignored current amount');

const material = (overrides = {}) => ({ visible: true, depthWrite: true, transparent: false, ...overrides });
invariant(contributesDofDepth({ visible: true, isMesh: true, material: material() }),
  'opaque mesh was removed from DoF depth');
invariant(!contributesDofDepth({ visible: true, isMesh: true, material: material({ depthWrite: false }) }),
  'non-depth-writing mesh became an opaque DoF occluder');
invariant(contributesDofDepth({ visible: true, isMesh: true, material: material({ transparent: true }) }),
  'transparent mesh with explicit depth writing lost its depth contract');
invariant(!contributesDofDepth({
  visible: true, isMesh: true, material: material({ alphaHash: true, opacity: 0.5 }),
}), 'intermediate alphaHash fade became an opaque DoF occluder');
invariant(contributesDofDepth({
  visible: true, isMesh: true, material: material({ alphaHash: true, opacity: 1 }),
}), 'full-weight alphaHash mesh lost its DoF depth contract');
invariant(!contributesDofDepth({ visible: true, isPoints: true }),
  'Points became an opaque DoF occluder');
invariant(!contributesDofDepth({ visible: true, isSprite: true }),
  'Sprite became an opaque DoF occluder');
invariant(!contributesDofDepth({ visible: true, isLine: true }),
  'Line became an opaque DoF occluder');
invariant(!contributesDofDepth({ visible: true, isMesh: true, material: material(), userData: { dofDepth: false } }),
  'explicit DoF depth exclusion was ignored');
invariant(contributesDofDepth({
  visible: true, isMesh: true, material: material({ depthWrite: false }), userData: { dofDepth: true },
}), 'explicit mesh DoF depth inclusion was ignored');
invariant(!contributesDofDepth({ visible: true, isPoints: true, userData: { dofDepth: true } }),
  'explicit DoF depth inclusion admitted an incompatible Points primitive');
invariant(!contributesDofDepth({ visible: false, isMesh: true, material: material() }),
  'hidden mesh contributed DoF depth');

invariant(CIRCULAR_BOKEH_SAMPLE_COUNT === CIRCULAR_BOKEH_KERNEL.length,
  'circular bokeh sample contract diverged from its generated kernel');
invariant(CIRCULAR_BOKEH_SAMPLE_COUNT <= 41,
  'cinematic bokeh exceeded the stock pass color-fetch budget');
invariant(MOVING_BOKEH_SAMPLE_COUNT === 13
    && MOVING_BOKEH_SAMPLE_COUNT === CIRCULAR_BOKEH_MOVING_KERNEL.length,
  'moving bokeh lost its 13-tap budget');
invariant(CIRCULAR_BOKEH_KERNEL.every(([x, y]) => Math.hypot(x, y) <= 1 + EPS),
  'circular bokeh kernel escaped its unit aperture');
const radialCounts = new Map();
for (const [x, y] of CIRCULAR_BOKEH_KERNEL) {
  const radius = Math.hypot(x, y).toFixed(6);
  radialCounts.set(radius, (radialCounts.get(radius) || 0) + 1);
}
invariant(JSON.stringify([...radialCounts.values()].sort((a, b) => a - b)) === '[1,8,12,20]',
  'circular bokeh lost its center + 8/12/20 concentric aperture budget');
for (let i = 1; i < CIRCULAR_BOKEH_KERNEL.length; i += 2) {
  const a = CIRCULAR_BOKEH_KERNEL[i];
  const b = CIRCULAR_BOKEH_KERNEL[i + 1];
  near(a[0], -b[0], `bokeh pair ${i} shifted the optical center`);
  near(a[1], -b[1], `bokeh pair ${i} shifted the optical center`);
}
const movingRadialCounts = new Map();
for (const [x, y] of CIRCULAR_BOKEH_MOVING_KERNEL) {
  const radius = Math.hypot(x, y).toFixed(6);
  movingRadialCounts.set(radius, (movingRadialCounts.get(radius) || 0) + 1);
}
invariant(JSON.stringify([...movingRadialCounts.values()].sort((a, b) => a - b)) === '[1,4,4,4]',
  'moving bokeh stopped sampling every authored aperture ring');
near(CIRCULAR_BOKEH_MOVING_KERNEL[0][0], 0, 'moving bokeh lost its optical center');
near(CIRCULAR_BOKEH_MOVING_KERNEL[0][1], 0, 'moving bokeh lost its optical center');
for (let i = 1; i < CIRCULAR_BOKEH_MOVING_KERNEL.length; i += 2) {
  const a = CIRCULAR_BOKEH_MOVING_KERNEL[i];
  const b = CIRCULAR_BOKEH_MOVING_KERNEL[i + 1];
  near(a[0], -b[0], `moving bokeh pair ${i} shifted the optical center`);
  near(a[1], -b[1], `moving bokeh pair ${i} shifted the optical center`);
}
invariant(!/uniform\s+\w+\s+\w+\s*\[/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  'circular bokeh introduced a dynamically indexed custom uniform array');
invariant(!CIRCULAR_BOKEH_FRAGMENT_SHADER.includes('gl_FragCoord'),
  'circular bokeh reintroduced screen-space stochastic tap crawl');
invariant(!/uniform\s+float\s+(?:u)?time\b/i.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  'circular bokeh became time-varying');
const movingCalls = (CIRCULAR_BOKEH_FRAGMENT_SHADER.match(
  /\bvec3\s+movingSample\d+\s*=\s*texture2D\s*\(/g,
) || []).length;
const fullOnlyCalls = (CIRCULAR_BOKEH_FRAGMENT_SHADER.match(/\baccumulateFullSample\s*\(/g) || []).length - 1;
invariant(movingCalls === MOVING_BOKEH_SAMPLE_COUNT
    && movingCalls + fullOnlyCalls === CIRCULAR_BOKEH_SAMPLE_COUNT,
  'adaptive bokeh shader fetch counts diverged from the 13/41 contract');
invariant(/uniform\s+float\s+bokehQuality\s*;/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER)
    && CIRCULAR_BOKEH_FRAGMENT_SHADER.includes('if (bokehQuality > 0.0 || preserveHighlight)')
    && CIRCULAR_BOKEH_FRAGMENT_SHADER.includes('preserveHighlight')
    && CIRCULAR_BOKEH_FRAGMENT_SHADER.includes('outputQuality >= 1.0'),
  'adaptive bokeh lost its moving/HDR branch or exact stable result');
invariant(!/#define[^\n]*bokehQuality/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  'adaptive bokeh quality created a shader-program variant');
invariant((CIRCULAR_BOKEH_FRAGMENT_SHADER.match(/\bsmoothstep\s*\(/g) || []).length === 2,
  'circular bokeh moved highlight classification back into every tap');
const fakeBokehMaterial = { uniforms: { focus: { value: 1 } }, fragmentShader: '', needsUpdate: false };
installCircularBokeh(fakeBokehMaterial);
invariant(fakeBokehMaterial.uniforms.focus.value === 1
    && fakeBokehMaterial.uniforms.highlightGain.value > 0
    && fakeBokehMaterial.uniforms.bokehQuality.value === 1
    && fakeBokehMaterial.fragmentShader === CIRCULAR_BOKEH_FRAGMENT_SHADER
    && fakeBokehMaterial.needsUpdate,
  'circular bokeh installation broke BokehPass uniforms or shader ownership');

const qualitySource = await readFile(new URL('../src/env/post-quality-state.js', import.meta.url), 'utf8');
invariant(!/\b(?:three|document|window|performance|Date|requestAnimationFrame|setTimeout)\b/.test(qualitySource),
  'pure post quality state acquired a renderer, DOM, wall-clock, or timer dependency');

function advanceQuality(state, duration, speed, step) {
  let elapsed = 0;
  while (elapsed < duration - EPS) {
    const dt = Math.min(step, duration - elapsed);
    const same = state.update(dt, speed * dt);
    invariant(same === state, 'post quality update replaced its mutable state object');
    elapsed += dt;
  }
  return state.quality;
}

function qualityTrace(step) {
  const state = createPostQualityState();
  const checkpoints = [];
  for (const [duration, speed] of [
    [0.2, 30],
    [0.1, 0],
    [0.05, 0],
    [0.07, 0],
    [0.12, 0],
  ]) checkpoints.push(advanceQuality(state, duration, speed, step));
  return { state, checkpoints };
}

const quality60 = qualityTrace(1 / 60);
const quality120 = qualityTrace(1 / 120);
const qualityLong = qualityTrace(0.1);
for (let i = 0; i < quality60.checkpoints.length; i++) {
  near(quality60.checkpoints[i], quality120.checkpoints[i], `60/120Hz quality diverged at ${i}`, 1e-3);
  near(quality60.checkpoints[i], qualityLong.checkpoints[i], `long-frame quality diverged at ${i}`, 1e-3);
}
invariant(quality60.checkpoints[0] === 0 && quality60.checkpoints[1] === 0,
  'moving and hold phases did not stay at exact low quality');
invariant(quality60.checkpoints[2] > 0 && quality60.checkpoints[2] < 1,
  'settling did not begin continuously after the hold');
near(quality60.state.quality, 1, 'settling did not end at exact full quality');
invariant(quality60.state.mode === 'stable', 'settling did not end in stable mode');

const hysteresis = createPostQualityState();
hysteresis.update(0.05, 30 * 0.05);
hysteresis.update(0.1, 10 * 0.1);
invariant(hysteresis.mode === 'moving' && hysteresis.quality === 0,
  'between-threshold speed caused moving/stable chatter');
advanceQuality(hysteresis, 0.2, 0, 0.05);
const beforeReverse = hysteresis.quality;
invariant(beforeReverse > 0 && beforeReverse < 1, 'reversal fixture never entered settling');
hysteresis.update(0.05, 30 * 0.05);
invariant(hysteresis.mode === 'moving' && hysteresis.quality === 0,
  'settling reversal overshot or failed to return immediately to moving');
invariant(hysteresis.reset() === hysteresis && hysteresis.quality === 1 && hysteresis.mode === 'stable',
  'post quality reset did not restore the same object to stable quality');

const trackedCamera = {
  position: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
  fov: 40,
  zoom: 1,
  view: null,
};
const cameraMotion = createCameraMotionTracker();
near(cameraMotion.sample(trackedCamera, 1000, 600, 10), 0,
  'first camera snapshot created synthetic motion');
trackedCamera.position.x = 0.1;
invariant(cameraMotion.sample(trackedCamera, 1000, 600, 10) > 0,
  'position-only camera motion was not measured');
near(cameraMotion.sample(trackedCamera, 1000, 600, 10), 0,
  'static camera snapshot retained prior motion');
cameraMotion.reset();
cameraMotion.sample(trackedCamera, 1000, 600, 10);
trackedCamera.quaternion.w = -1;
near(cameraMotion.sample(trackedCamera, 1000, 600, 10), 0,
  'quaternion sign-equivalent snapshot created synthetic rotation');
trackedCamera.quaternion.z = Math.sin(0.01);
trackedCamera.quaternion.w = -Math.cos(0.01);
invariant(cameraMotion.sample(trackedCamera, 1000, 600, 10) > 0,
  'quaternion-only camera motion was not measured');
trackedCamera.fov = 41;
invariant(cameraMotion.sample(trackedCamera, 1000, 600, 10) > 0,
  'FOV-only camera motion was not measured');
trackedCamera.view = {
  enabled: true,
  fullWidth: 1000,
  fullHeight: 600,
  offsetX: 12,
  offsetY: -8,
  width: 1000,
  height: 600,
};
invariant(cameraMotion.sample(trackedCamera, 1000, 600, 10) > 0,
  'view-offset-only camera motion was not measured');
cameraMotion.reset();
trackedCamera.position.x = 5;
near(cameraMotion.sample(trackedCamera, 1200, 700, 10), 0,
  'resize/reset snapshot created synthetic camera motion');

console.log('DOF CONTRACT: PASS');
