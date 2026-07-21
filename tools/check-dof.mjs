// Fast, browser-free DoF contract: camera-axis focus, single amount ownership,
// and transparent/decorative depth exclusion.
import * as THREE from '../app/node_modules/three/build/three.module.js';
import {
  contributesDofDepth,
  createDofController,
  focusDepthForPoint,
} from '../src/env/dof.js';
import {
  CIRCULAR_BOKEH_FRAGMENT_SHADER,
  CIRCULAR_BOKEH_KERNEL,
  CIRCULAR_BOKEH_SAMPLE_COUNT,
  installCircularBokeh,
} from '../src/env/circular-bokeh-shader.js';

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
invariant(!/uniform\s+\w+\s+\w+\s*\[/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  'circular bokeh introduced a dynamically indexed custom uniform array');
invariant(!CIRCULAR_BOKEH_FRAGMENT_SHADER.includes('gl_FragCoord'),
  'circular bokeh reintroduced screen-space stochastic tap crawl');
invariant(!/uniform\s+float\s+(?:u)?time\b/i.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  'circular bokeh became time-varying');
const accumulationCalls = (CIRCULAR_BOKEH_FRAGMENT_SHADER.match(/\baccumulateSample\s*\(/g) || []).length - 1;
invariant(accumulationCalls === CIRCULAR_BOKEH_SAMPLE_COUNT,
  'circular bokeh shader fetch count diverged from its kernel contract');
invariant((CIRCULAR_BOKEH_FRAGMENT_SHADER.match(/\bsmoothstep\s*\(/g) || []).length === 2,
  'circular bokeh moved highlight classification back into every tap');
const fakeBokehMaterial = { uniforms: { focus: { value: 1 } }, fragmentShader: '', needsUpdate: false };
installCircularBokeh(fakeBokehMaterial);
invariant(fakeBokehMaterial.uniforms.focus.value === 1
    && fakeBokehMaterial.uniforms.highlightGain.value > 0
    && fakeBokehMaterial.fragmentShader === CIRCULAR_BOKEH_FRAGMENT_SHADER
    && fakeBokehMaterial.needsUpdate,
  'circular bokeh installation broke BokehPass uniforms or shader ownership');

console.log('DOF CONTRACT: PASS');
