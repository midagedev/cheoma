// #150-M: pure explore/focus/hop/focusOut/wave/exit transition table.
// Three/DOM/WebGL free — legal transitions, rejections, wave exclusivity,
// zoom/selection split, and ring-buffer event trace.
//
// Usage: node tools/check-view-lifecycle.mjs

import {
  VIEW_EVENTS,
  VIEW_PHASES,
  VIEW_TRACE_DEFAULT_CAPACITY,
  createViewTrace,
  viewCan,
  viewInitialState,
  viewIsBusy,
  viewReduce,
  viewSelectionRegime,
  viewWaveExclusive,
  viewZoomRegime,
} from '../src/camera/view-lifecycle.js';

const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

const reduce = (state, event, payload) => viewReduce(state, event, payload);
const step = (events) => {
  let s = viewInitialState();
  for (const e of events) {
    if (Array.isArray(e)) s = reduce(s, e[0], e[1]);
    else s = reduce(s, e);
  }
  return s;
};

// ---------- 1. Vocabulary ----------
console.log('\n-- vocabulary --');
pass(VIEW_PHASES.includes('outside') && VIEW_PHASES.includes('explore')
  && VIEW_PHASES.includes('focus') && VIEW_PHASES.includes('hopping')
  && VIEW_PHASES.includes('focusingOut') && VIEW_PHASES.includes('waving'),
'phase vocabulary covers outside/explore/focus/hop/focusOut/wave');
pass(VIEW_EVENTS.includes('enter') && VIEW_EVENTS.includes('focus')
  && VIEW_EVENTS.includes('hop') && VIEW_EVENTS.includes('focusOut')
  && VIEW_EVENTS.includes('wave') && VIEW_EVENTS.includes('exit'),
'event vocabulary covers enter/focus/hop/focusOut/wave/exit');
pass(Object.isFrozen(VIEW_PHASES) && Object.isFrozen(VIEW_EVENTS),
'phase and event tables are frozen');

// ---------- 2. Happy paths ----------
console.log('\n-- happy paths --');
{
  const s = step(['enter']);
  pass(s.phase === 'explore' && s.selected == null, "enter → explore");
  pass(viewSelectionRegime(s) === 'explore' && viewZoomRegime(s) === 'explore',
    'settled explore: selection=explore, zoom=explore (orthogonal axes)');
  pass(!viewIsBusy(s) && !viewWaveExclusive(s), 'explore is not busy and not wave-exclusive');
}
{
  const s = step(['enter', ['focus', { parcelId: 'p1' }]]);
  pass(s.phase === 'focusing' && s.selected === 'p1', 'focus from explore → focusing(p1)');
  pass(viewIsBusy(s) && viewZoomRegime(s) === 'lock', 'focus-in locks zoom without owning zoom distance');
  pass(viewSelectionRegime(s) === 'focus', 'mid focus-in already reports selection regime focus');
}
{
  const s = step(['enter', ['focus', 'p1'], 'focusDone']);
  pass(s.phase === 'focus' && s.selected === 'p1', 'focusDone → focus(p1)');
  pass(viewZoomRegime(s) === 'focus' && !viewIsBusy(s), 'settled focus unlocks zoom regime focus');
}
{
  const s = step(['enter', ['focus', 'p1'], 'focusDone', ['hop', 'p2']]);
  pass(s.phase === 'hopping' && s.selected === 'p2' && s.from === 'p1',
    'hop p1→p2 records destination selected and from=p1');
  pass(viewZoomRegime(s) === 'lock', 'hop locks zoom');
}
{
  const s = step(['enter', ['focus', 'p1'], 'focusDone', ['hop', 'p2'], 'hopDone']);
  pass(s.phase === 'focus' && s.selected === 'p2' && s.from == null, 'hopDone settles on p2');
}
{
  const s = step(['enter', ['focus', 'p1'], 'focusDone', 'focusOut']);
  pass(s.phase === 'focusingOut' && s.selected == null && s.from === 'p1',
    'focusOut from settled focus clears selected, keeps from');
  pass(viewSelectionRegime(s) === 'explore', 'focusingOut already reports explore selection');
}
{
  const s = step(['enter', ['focus', 'p1'], 'focusDone', 'focusOut', 'focusOutDone']);
  pass(s.phase === 'explore' && s.selected == null, 'focusOutDone → explore');
}
{
  const s = step(['enter', 'wave']);
  pass(s.phase === 'waving' && viewWaveExclusive(s), 'wave from explore → waving exclusive');
  pass(viewZoomRegime(s) === 'lock', 'wave locks zoom');
}
{
  const s = step(['enter', 'wave', 'waveDone']);
  pass(s.phase === 'explore', 'waveDone → explore');
}
{
  const s = step(['enter', 'wave', 'waveCancel']);
  pass(s.phase === 'explore', 'waveCancel → explore');
}
{
  const s = step(['enter', ['focus', 'p1'], 'focusDone', 'wave']);
  pass(s.phase === 'waving' && s.selected == null,
    'wave from settled focus clears selection (engine defensive clear)');
}
{
  const s = step(['enter', ['focus', 'p1'], 'focusDone', 'exit']);
  pass(s.phase === 'outside' && s === viewInitialState(),
    'exit from focus returns the canonical outside identity');
}

// ---------- 3. Rejections / exclusivity ----------
console.log('\n-- rejections & wave exclusivity --');
{
  const outside = viewInitialState();
  pass(reduce(outside, 'focus', 'p1') === outside, 'focus outside village is identity');
  pass(reduce(outside, 'hop', 'p1') === outside, 'hop outside village is identity');
  pass(reduce(outside, 'focusOut') === outside, 'focusOut outside village is identity');
  pass(reduce(outside, 'wave') === outside, 'wave outside village is identity');
  pass(reduce(outside, 'exit') === outside, 'exit while outside is identity');
}
{
  const exploring = step(['enter']);
  pass(reduce(exploring, 'hop', 'p1') === exploring, 'hop from explore is rejected (need settled focus)');
  pass(reduce(exploring, 'focusDone') === exploring, 'focusDone without focusing is identity');
  pass(reduce(exploring, 'focusOut') === exploring, 'focusOut from explore is identity');
  pass(reduce(exploring, 'focus', null) === exploring, 'focus without parcelId is identity');
}
{
  const focusing = step(['enter', ['focus', 'p1']]);
  pass(reduce(focusing, 'focus', 'p2') === focusing, 'second focus while focusing is rejected');
  pass(reduce(focusing, 'hop', 'p2') === focusing, 'hop while focusing is rejected');
  pass(reduce(focusing, 'wave') === focusing, 'wave while focusing is rejected (camera transition)');
  const out = reduce(focusing, 'focusOut');
  pass(out.phase === 'focusingOut' && out.from === 'p1', 'escape during focus-in is legal → focusingOut');
}
{
  const focused = step(['enter', ['focus', 'p1'], 'focusDone']);
  pass(reduce(focused, 'focus', 'p2') === focused,
    'focus intent from settled focus is rejected (product uses hop)');
  pass(reduce(focused, 'hop', 'p1') === focused, 'hop to same parcel is identity no-op');
  pass(reduce(focused, 'hop', null) === focused, 'hop without parcelId is identity');
}
{
  const hopping = step(['enter', ['focus', 'p1'], 'focusDone', ['hop', 'p2']]);
  pass(reduce(hopping, 'focus', 'p3') === hopping, 'focus while hopping is rejected');
  pass(reduce(hopping, 'hop', 'p3') === hopping, 'second hop while hopping is rejected');
  pass(reduce(hopping, 'wave') === hopping, 'wave while hopping is rejected');
  const out = reduce(hopping, 'focusOut');
  pass(out.phase === 'focusingOut' && out.from === 'p2',
    'escape during hop uses destination as from and clears selected');
}
{
  const waving = step(['enter', 'wave']);
  pass(reduce(waving, 'focus', 'p1') === waving, 'wave exclusivity: focus rejected');
  pass(reduce(waving, 'hop', 'p1') === waving, 'wave exclusivity: hop rejected');
  pass(reduce(waving, 'focusOut') === waving, 'wave exclusivity: focusOut rejected');
  pass(reduce(waving, 'wave') === waving, 'second concurrent wave is rejected');
  const exited = reduce(waving, 'exit');
  pass(exited.phase === 'outside', 'exit is still legal during wave (cancels + leaves)');
}

// ---------- 4. Identity contract ----------
console.log('\n-- identity contract --');
{
  const explore = step(['enter']);
  pass(reduce(explore, 'enter') === explore, 're-enter explore returns identical state object');
  const focus = step(['enter', ['focus', 'p1'], 'focusDone']);
  pass(reduce(focus, 'focusDone') === focus, 'spurious focusDone is identity');
  pass(Object.isFrozen(explore) && Object.isFrozen(focus), 'states are frozen');
}

// ---------- 5. Exhaustive short paths (no illegal phase stuck busy without exit) ----------
console.log('\n-- exhaust short paths --');
{
  const ADVANCES = [
    'enter',
    ['focus', 'a'],
    'focusDone',
    ['hop', 'b'],
    'hopDone',
    'focusOut',
    'focusOutDone',
    'wave',
    'waveDone',
    'waveCancel',
    'exit',
  ];
  const reachable = new Set();
  const walk = (state, depth) => {
    reachable.add(state.phase);
    if (depth === 0) return;
    for (const e of ADVANCES) {
      const next = Array.isArray(e) ? reduce(state, e[0], e[1]) : reduce(state, e);
      walk(next, depth - 1);
    }
  };
  walk(viewInitialState(), 5);
  for (const phase of VIEW_PHASES) {
    pass(reachable.has(phase), `phase '${phase}' is reachable within depth-5 product events`);
  }
  // Every non-outside phase can exit to outside in one step.
  for (const phase of VIEW_PHASES) {
    if (phase === 'outside') continue;
    // synthesise a representative state for the phase
    let s;
    if (phase === 'explore') s = step(['enter']);
    else if (phase === 'focusing') s = step(['enter', ['focus', 'p']]);
    else if (phase === 'focus') s = step(['enter', ['focus', 'p'], 'focusDone']);
    else if (phase === 'hopping') s = step(['enter', ['focus', 'p'], 'focusDone', ['hop', 'q']]);
    else if (phase === 'focusingOut') s = step(['enter', ['focus', 'p'], 'focusDone', 'focusOut']);
    else if (phase === 'waving') s = step(['enter', 'wave']);
    pass(reduce(s, 'exit').phase === 'outside', `exit from '${phase}' always reaches outside`);
  }
}

// ---------- 6. Zoom / selection split ----------
console.log('\n-- zoom/selection split --');
{
  const focus = step(['enter', ['focus', 'p1'], 'focusDone']);
  // The pure module never has a "zoom event" — distance is optics-owned.
  pass(!VIEW_EVENTS.includes('zoom') && !VIEW_EVENTS.includes('wheel'),
    'event vocabulary has no zoom/wheel — distance stays outside this machine');
  pass(viewSelectionRegime(focus) === 'focus' && viewZoomRegime(focus) === 'focus',
    'settled focus: both regimes focus, but only selection is state');
  const exploring = step(['enter']);
  pass(viewSelectionRegime(exploring) === 'explore' && viewZoomRegime(exploring) === 'explore',
    'settled explore: selection and zoom regimes agree without sharing storage');
  // Transition lock is derived, not a third selection value.
  const focusing = step(['enter', ['focus', 'p1']]);
  pass(viewSelectionRegime(focusing) === 'focus' && viewZoomRegime(focusing) === 'lock',
    'during focus-in selection=focus while zoom is only locked');
}

// ---------- 7. Ring-buffer event trace ----------
console.log('\n-- event trace --');
{
  const trace = createViewTrace(4);
  pass(trace.capacity === 4 && trace.size === 0, 'empty trace starts at size 0');
  let s = viewInitialState();
  s = trace.dispatch(s, 'enter');
  s = trace.dispatch(s, 'focus', { parcelId: 'p1' });
  s = trace.dispatch(s, 'focus', { parcelId: 'p2' }); // rejected mid-focusing
  s = trace.dispatch(s, 'focusDone');
  s = trace.dispatch(s, 'exit');
  pass(s.phase === 'outside', 'trace dispatch composes the same pure reduce');
  pass(trace.size === 4, 'trace size caps at capacity (5th write overwrote oldest)');
  const events = trace.toArray();
  pass(events.length === 4, 'toArray returns capacity-bounded history');
  pass(events[0].event === 'focus' && events[0].changed === true,
    'oldest retained is the accepted focus (enter dropped by ring)');
  pass(events[1].event === 'focus' && events[1].changed === false,
    'rejected second focus is still logged for diagnostics');
  pass(events[2].event === 'focusDone' && events[2].to === 'focus', 'focusDone recorded');
  pass(events[3].event === 'exit' && events[3].to === 'outside', 'exit recorded');
  pass(events.every((e, i) => e.seq === events[0].seq + i), 'seq is monotone across wrap');
  pass(VIEW_TRACE_DEFAULT_CAPACITY === 64, 'default diagnostic capacity is 64');
  // Identity reduce still logs
  const before = trace.size;
  s = trace.dispatch(s, 'exit');
  pass(s.phase === 'outside' && trace.size === before,
    'identity exit while outside still logs (size stays at cap)');
  pass(trace.toArray().at(-1).changed === false, 'identity step records changed=false');
  trace.clear();
  pass(trace.size === 0 && trace.toArray().length === 0, 'clear empties the ring');
}

// ---------- 8. viewCan helper ----------
console.log('\n-- viewCan --');
{
  const explore = step(['enter']);
  pass(viewCan(explore, 'focus', 'p1') === true, 'viewCan focus from explore');
  pass(viewCan(explore, 'hop', 'p1') === false, 'viewCan hop from explore is false');
  const waving = step(['enter', 'wave']);
  pass(viewCan(waving, 'focus', 'p1') === false, 'viewCan focus during wave is false');
  pass(viewCan(waving, 'exit') === true, 'viewCan exit during wave is true');
}

console.log(`\n=== check-view-lifecycle: ${failures.length ? `${failures.length} FAILURE(S)` : 'ALL PASS'} ===\n`);
if (failures.length) {
  for (const f of failures) console.error(' -', f);
  process.exitCode = 1;
}
