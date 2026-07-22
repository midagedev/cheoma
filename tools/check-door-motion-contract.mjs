import { planOpeningDetail } from '../src/api/opening-detail.js';
import { createDoorMotionState, planDoorMotion } from '../src/api/door-motion.js';

const EPS = 1e-6;
const invariant = (condition, message) => { if (!condition) throw new Error(message); };

const opening = planOpeningDetail({
  kind: 'door', style: 'giwa', seed: 'door-motion:17',
  width: 1.72, height: 2.04, wallThickness: 0.13,
  lowerPanelHeight: 0.42, primary: true, leafOutward: 0.035,
});
const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; throw new Error('door motion consumed global RNG'); };
let plan;
try {
  plan = planDoorMotion(opening);
} finally {
  Math.random = originalRandom;
}
invariant(randomCalls === 0, 'door motion touched global Math.random');
invariant(Object.isFrozen(plan) && Object.isFrozen(plan.pivot), 'door motion plan is mutable');
invariant(JSON.stringify(planDoorMotion(opening)) === JSON.stringify(plan),
  'same opening does not produce byte-stable door motion');
invariant(plan.openAngle * plan.hingeSide < 0, 'primary door does not swing inward');
invariant(Math.abs(plan.leafWidth - opening.width / opening.leafCount) < EPS
    && Math.abs(Math.abs(plan.pivot.u) - opening.width * 0.5) < EPS,
  'door motion does not own exactly one jamb-edge leaf');
invariant(Math.abs(plan.leafCenterU - opening.anchors.pivot.leafCenterU) < EPS
    && Math.abs(plan.meetingU - opening.anchors.pivot.meetingU) < EPS,
  'door motion lost the planned leaf center or meeting edge');
invariant(Math.abs(plan.pivot.outward - opening.anchors.pivot.outward) < EPS,
  'door motion lost the panel/pivot outward plane');

const state = createDoorMotionState(plan);
const closed = state.snapshot();
invariant(closed.progress === 0 && closed.angle === 0 && !closed.targetOpen,
  'door does not start closed');
state.toggle();
let previous = 0;
for (let index = 0; index < 360; index++) {
  state.update(1 / 60);
  const now = state.snapshot();
  invariant(now.progress + EPS >= previous && now.progress >= 0 && now.progress <= 1,
    'opening door overshot or reversed');
  previous = now.progress;
}
const opened = state.snapshot();
invariant(opened.progress === 1 && Math.abs(opened.angle - plan.openAngle) < EPS && !opened.moving,
  'door did not settle exactly open');

state.setOpen(false);
for (let index = 0; index < 12; index++) state.update(1 / 60);
const beforeInterrupt = state.snapshot();
state.setOpen(true);
const interrupted = state.snapshot();
invariant(interrupted.progress === beforeInterrupt.progress && interrupted.angle === beforeInterrupt.angle,
  'interrupt snapped the current door pose');
for (let index = 0; index < 360; index++) state.update(1 / 60);
invariant(state.snapshot().progress === 1, 'interrupted door did not settle on its latest target');

const replay = createDoorMotionState(plan);
replay.setOpen(true);
for (let index = 0; index < 360; index++) replay.update(1 / 60);
invariant(JSON.stringify(replay.snapshot()) === JSON.stringify(opened),
  'identical door steps are not deterministic');
state.dispose();
state.dispose();
invariant(state.snapshot().disposed && state.snapshot().progress === 0,
  'door state disposal is not closed and idempotent');

let rejected = false;
try {
  planDoorMotion(planOpeningDetail({ kind: 'window', style: 'giwa', seed: 1 }));
} catch { rejected = true; }
invariant(rejected, 'window acquired a door motion contract');

console.log(
  `DOOR MOTION CONTRACT: PASS (hinge=${plan.hingeSide < 0 ? 'left' : 'right'}, `
  + `open=${(plan.openAngle * 180 / Math.PI).toFixed(1)}°)`,
);
