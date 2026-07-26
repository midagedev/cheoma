// BGM 트랙 선택·진입 뮤트 복원·자산 도달성·위치성 앵커 순수 계약(브라우저·AudioContext 없음).
//
// 왜 순수인가: 실제로 시달렸던 두 결함은 모두 "계산으로 판정되는 사실" 이었다.
//   1. assets/audio/genesis.mp3 는 첫 진입용으로 준비됐는데 **자동 선택 경로가 없어** 한 번도
//      재생되지 않았다(getTracks() 선택지로만 노출). 라우팅 사실 → 브라우저 불필요.
//   2. 타이틀 뮤트(hero.arm)의 복원이 엔진 곳곳에 흩어져, 복원 없는 경로 하나가 곧 영구 무음이었다.
//      볼륨 종착은 상태기계 속성 → 브라우저 불필요.
//   3. 마을 모드에서 stream/chime 이 원점 솔로 앵커에 묶여 들리지 않음 — 앵커 선택은 계획
//      좌표 산술로 판정된다(getStreamAnchor/getChimeCorners getter 배선 포함).
// 실제 AudioContext 가 필요한 것(ctx.state, resume, 게인 값, 보이스 수, decodeAudioData)만
// tools/check-audio.mjs(브라우저 게이트)에 남긴다.
//
// 사용법: node tools/check-audio-policy.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALL_TRACKS, AUTO_TRACKS, ENTRY_TRACK, MANUAL_TRACKS, OPTION_TRACKS, TIME_TRACK,
  handOffTrack, isKnownTrack, trackForEntry, trackForTime,
} from '../src/audio/track-policy.js';
import {
  INTRO_EVENTS, INTRO_FADE, INTRO_PHASES,
  introAdvance, introInitialState, introReduce,
} from '../src/audio/intro-policy.js';
import {
  chimeLocalCorners,
  chimeLayoutParams,
  chimeWorldCorners,
  nearestStreamAnchor,
  pickChimeParcel,
} from '../src/audio/anchors.js';

const ROOT = resolve(import.meta.dirname, '..');
const AUDIO_DIR = join(ROOT, 'assets', 'audio');

const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

// ---------- 1. 트랙 선택 라우팅 ----------
console.log('\n-- track selection --');
for (const [time, expected] of Object.entries({ dawn: 'dawn', day: 'main-theme', sunset: 'sunset', night: 'night' })) {
  pass(trackForTime(time) === expected, `time '${time}' resolves to '${expected}' (got '${trackForTime(time)}')`);
}
// 앱 기본 진입 시간대는 sunset 이다(?shot=1 만 day). 그 상태가 무음으로 풀리면 안 된다.
pass(trackForTime('sunset') === TIME_TRACK.sunset, 'app default time (sunset) resolves to its own track');
pass(trackForTime('nonsense') === TIME_TRACK.day,
  `unknown time falls back to the main theme instead of silence (got '${trackForTime('nonsense')}')`);
pass(trackForEntry() === ENTRY_TRACK && ENTRY_TRACK === 'genesis',
  `first-entry track is 'genesis' (got '${trackForEntry()}')`);

// 진입 트랙은 **자동 선택 경로**를 가져야 한다. 이 단언이 genesis 회귀의 본질이다:
// 선택지 목록(OPTION_TRACKS)에만 있는 트랙은 "준비만 되고 재생되지 않는" 트랙이다.
pass(AUTO_TRACKS.includes(ENTRY_TRACK), 'the entry track has an automatic selection path (not options-only)');
for (const value of Object.values(TIME_TRACK)) {
  pass(AUTO_TRACKS.includes(value), `time-mapped track '${value}' is automatically selectable`);
}

// 진입 → 시간대 인계
pass(handOffTrack(ENTRY_TRACK, 'sunset') === 'sunset', 'entry track hands off to the sunset track');
pass(handOffTrack(ENTRY_TRACK, 'night') === 'night', 'entry track hands off to the night track');
pass(handOffTrack('sunset', 'sunset') === null,
  'handover is a no-op once a time track already owns playback (no self-crossfade)');
pass(handOffTrack('night', 'sunset') === null,
  'a user time change during the landing is not overridden by the handover');
pass(isKnownTrack(ENTRY_TRACK) && !isKnownTrack('does-not-exist'), 'isKnownTrack recognises exactly the policy names');

// ---------- 2. 진입 뮤트·복원 상태기계 ----------
console.log('\n-- intro mute/restore state machine --');
const initial = introInitialState();
pass(initial.volume === 1 && initial.phase === 'idle',
  'a session without a title window starts audible (idle, volume 1)');
pass(introReduce(initial, 'arm').volume === 0, "'arm' mutes BGM for the title window");

// identity 계약: 변화 없는 사건은 **같은 객체**를 돌려줘야 한다(호출부가 그걸로 중복 play 를 막는다).
const armed = introReduce(initial, 'arm');
pass(introReduce(armed, 'arm') === armed, "repeating 'arm' returns the identical state object (no duplicate play)");
const entering = introReduce(armed, 'enter');
pass(introReduce(entering, 'enter') === entering, "re-entering mid-swell returns the identical state (no ramp restart)");
pass(entering.track === ENTRY_TRACK, "'enter' selects the entry track");
pass(entering.volume === 0, "'enter' starts the swell from silence");

// 전이 그래프 완전 탐색: 길이 4 이하의 모든 사건 열 + 각 단계에서 부분/완전 진행을 섞는다.
const ADVANCES = [0, INTRO_FADE / 4, INTRO_FADE];
const reachable = new Map();     // key → state
const keyOf = (s) => `${s.phase}|${s.volume.toFixed(4)}|${s.track || '-'}`;
const seen = new Set();
(function walk(state, depth) {
  const key = keyOf(state);
  if (!reachable.has(key)) reachable.set(key, state);
  if (depth === 0) return;
  for (const event of INTRO_EVENTS) {
    for (const dt of ADVANCES) {
      const next = introAdvance(introReduce(state, event), dt);
      const path = `${key}>${event}>${dt}`;
      if (seen.has(path)) continue;
      seen.add(path);
      walk(next, depth - 1);
    }
  }
})(initial, 4);
// 뮤트 상태에서 출발하는 경로도 전부 탐색한다(부팅이 arm 으로 시작하는 실제 순서).
(function walkArmed(state, depth) {
  const key = keyOf(state);
  if (!reachable.has(key)) reachable.set(key, state);
  if (depth === 0) return;
  for (const event of INTRO_EVENTS) {
    for (const dt of ADVANCES) walkArmed(introAdvance(introReduce(state, event), dt), depth - 1);
  }
})(armed, 3);

const quiet = [...reachable.values()].filter((s) => s.volume < 1);
pass(quiet.every((s) => s.phase === 'armed' || s.phase === 'entering'),
  `only the title window and the swell may be quiet (quiet phases: ${JSON.stringify([...new Set(quiet.map((s) => s.phase))])})`);
pass(quiet.every((s) => introReduce(s, 'settle').volume === 1 && introReduce(s, 'skip').volume === 1),
  `every mutable state is restored to full volume by settle and by skip (${quiet.length} quiet states checked)`);
pass(quiet.every((s) => introReduce(s, 'settle').track === null && introReduce(s, 'skip').track === null),
  'settle and skip always release the entry track back to the time mapping');
pass([...reachable.values()].every((s) => INTRO_PHASES.includes(s.phase)),
  'every reachable phase is declared in INTRO_PHASES');
pass([...reachable.values()].every((s) => s.volume >= 0 && s.volume <= 1 && Number.isFinite(s.volume)),
  'volume stays a finite 0..1 value on every path');

// 명시 경로표 — 사용자 신고와 1:1 대응하는 실제 랜딩 경로들.
const paths = {
  'arm → enter → full swell': ['arm', 'enter', { advance: INTRO_FADE }],
  'arm → enter → settle mid-swell': ['arm', 'enter', { advance: INTRO_FADE / 4 }, 'settle'],
  'arm → enter → settle immediately': ['arm', 'enter', 'settle'],
  'arm → skip (hero parcel missing fallback)': ['arm', 'skip'],
  'arm → settle (landing skipped)': ['arm', 'settle'],
  'arm → arm → enter → settle (double title)': ['arm', 'arm', 'enter', 'settle'],
  'enter without arm (?hero=0)': ['enter', { advance: INTRO_FADE }],
  'settle → arm → enter → settle (engine reuse)': ['settle', 'arm', 'enter', 'settle'],
};
for (const [name, steps] of Object.entries(paths)) {
  let state = initial;
  for (const step of steps) {
    state = typeof step === 'string' ? introReduce(state, step) : introAdvance(state, step.advance);
  }
  pass(state.volume === 1, `path '${name}' ends at full BGM volume (got ${state.volume})`);
}
// 스웰 도중은 아직 1이 아니어야 한다(그래야 페이드가 실재한다).
let mid = introAdvance(introReduce(introReduce(initial, 'arm'), 'enter'), INTRO_FADE / 2);
pass(mid.volume > 0 && mid.volume < 1, `the entry swell is a real ramp (half-way volume ${mid.volume.toFixed(3)})`);
pass(introAdvance(mid, INTRO_FADE).volume === 1, 'the swell completes at INTRO_FADE');
pass(introAdvance(introReduce(initial, 'settle'), 1) === introReduce(initial, 'settle'),
  'advancing a settled state is a no-op (identical object, zero cost per frame)');
pass(introAdvance(entering, Number.NaN).volume === 0 && introAdvance(entering, -1).volume === 0,
  'a non-finite or negative frame delta cannot corrupt the swell');

// ---------- 3. 자산 도달성(파일시스템) ----------
console.log('\n-- audio assets --');
const files = readdirSync(AUDIO_DIR).filter((name) => name.endsWith('.mp3'));
const names = files.map((name) => name.replace(/\.mp3$/, ''));
for (const track of ALL_TRACKS) {
  const file = join(AUDIO_DIR, `${track}.mp3`);
  let size = -1;
  try { size = statSync(file).size; } catch {}
  pass(size > 0, `assets/audio/${track}.mp3 exists and is non-empty (${size} bytes)`);
}
for (const name of names) {
  pass(ALL_TRACKS.includes(name),
    `assets/audio/${name}.mp3 is named by the track policy (orphan audio files are silent files)`);
  pass(AUTO_TRACKS.includes(name) || Object.hasOwn(MANUAL_TRACKS, name),
    `track '${name}' is either automatically selectable or explicitly declared manual`);
}
for (const [name, reason] of Object.entries(MANUAL_TRACKS)) {
  pass(typeof reason === 'string' && reason.trim().length > 20,
    `manual-only track '${name}' documents why it has no automatic path`);
  pass(!AUTO_TRACKS.includes(name), `manual-only track '${name}' is not also declared automatic`);
  pass(OPTION_TRACKS.includes(name), `manual-only track '${name}' stays exposed through getTracks()`);
}
pass(OPTION_TRACKS.includes(ENTRY_TRACK), 'the entry track stays auditionable through getTracks()');

// ---------- 4. 소스 배선 계약 ----------
// 정책 모듈이 존재해도 엔진이 부르지 않으면 소리는 안 난다 — 그 누락이 바로 이번 결함이었다.
// 범위는 **제품 엔진(app/src/engine/engine.js)** 이다. 저장소 루트 하네스 `src/main.js` 는 자체
// 히어로 페이드를 유지하며(같은 함수 안에서 뮤트·복원이 닫혀 있어 영구 무음 위험이 없다) 여기 계약 밖이다.
console.log('\n-- engine wiring --');
const ENGINE = join(ROOT, 'app', 'src', 'engine', 'engine.js');
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// 주석을 제거한 코드만 센다. 이 파일은 주석에 배선 규칙을 그대로 인용하므로(예: "직접 뮤트 금지"),
// 원문 그대로 세면 주석이 계약을 통과시켜 버린다.
function stripComments(text) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    out += c;
    i += 1;
  }
  return out;
}
const engineSrc = stripComments(readFileSync(ENGINE, 'utf8'));

pass(countOf(engineSrc, 'setBgmVolume(0)') === 0,
  'engine.js never mutes BGM directly — the intro policy owns every mute (a raw mute is how music went permanently silent)');
pass(countOf(engineSrc, "introEvent('arm')") === 1,
  `engine.js arms the title mute exactly once (found ${countOf(engineSrc, "introEvent('arm')")})`);
for (const event of ['enter', 'settle', 'skip']) {
  pass(countOf(engineSrc, `introEvent('${event}')`) >= 1,
    `engine.js emits introEvent('${event}') on at least one landing path`);
}

// 첫 진입 랜딩(마을 우선 히어로)은 제스처 안에서 오디오를 **시작**해야 한다. start() 가 없으면
// 컨텍스트가 suspended 로 남아 랜딩 내내 무음이고, 아이콘만 ON 으로 보인다.
const landingStart = engineSrc.indexOf('function enterVillageHero(');
const landingEnd = engineSrc.indexOf('\n  function ', landingStart + 1);
pass(landingStart > 0 && landingEnd > landingStart, 'enterVillageHero (first-entry landing) is locatable in engine.js');
const landing = engineSrc.slice(landingStart, landingEnd);
pass(/audio\.start\(\)/.test(landing),
  'the first-entry landing starts audio inside the entry gesture (ctx.resume must happen there, not on a later canvas tap)');
pass(landing.indexOf("introEvent('enter')") >= 0, "the first-entry landing emits introEvent('enter')");
pass(landing.indexOf('audio.start()') < landing.indexOf('buildVillage('),
  'audio.start() runs before the heavy synchronous village build (iOS consumes user activation on the event turn, so resume goes first)');
pass(/introEvent\('(?:settle|skip)'\)/.test(landing),
  'the first-entry landing also carries a restore event (settle or skip) so the title mute cannot stick');

// 진입 트랙은 어딘가에서 실제로 선택돼야 한다(정책만 있고 호출이 없으면 여전히 무음이다).
const wiringFiles = [ENGINE, join(ROOT, 'src', 'audio', 'index.js')];
const selectsEntry = wiringFiles
  .some((file) => /trackForEntry\(\)|playEntryTrack\(|prefetchEntryTrack\(/.test(stripComments(readFileSync(file, 'utf8'))));
pass(selectsEntry, 'some product source actually selects the entry track');
pass(/prefetchEntryTrack\(/.test(engineSrc),
  'engine.js prefetches the entry track during the title window (heavy work stays hidden)');

// 위치성 SFX 앵커: 값 캡처(streamAnchor: env.streamAnchor) 회귀를 막는다.
// 개 짖음처럼 getter 로 라이브 좌표를 넘겨야 마을 모드에서 들린다.
pass(/getStreamAnchor\s*:/.test(engineSrc),
  'engine.js wires getStreamAnchor (live creek) — not a one-shot streamAnchor value capture');
pass(/getChimeCorners\s*:/.test(engineSrc),
  'engine.js wires getChimeCorners so 풍경 follow focused/nearest parcel eaves in village mode');
pass(!/streamAnchor\s*:\s*env\.streamAnchor/.test(engineSrc),
  'engine.js does not capture env.streamAnchor as a setup-time value (that pinned SFX to the origin)');
const audioIndexSrc = stripComments(readFileSync(join(ROOT, 'src', 'audio', 'index.js'), 'utf8'));
pass(/getStreamAnchor/.test(audioIndexSrc) && /getChimeCorners/.test(audioIndexSrc),
  'setupAudio accepts getStreamAnchor and getChimeCorners (dog-style live anchors)');
pass(/getAnchor/.test(stripComments(readFileSync(join(ROOT, 'src', 'audio', 'stream.js'), 'utf8'))),
  'createStream follows a live getAnchor each update (same pattern as createDog)');

// ---------- 5. 위치성 앵커 순수 산술 ----------
console.log('\n-- positional anchors --');
const streamSite = {
  streamY: (x) => -0.4 + x * 0.001,
  stream: {
    pts: [
      { x: -40, z: 12 }, { x: -10, z: 10 }, { x: 0, z: 8 }, { x: 20, z: 9 }, { x: 40, z: 11 },
    ],
    cross: { x: 0, z: 8 },
  },
};
const nearCam = nearestStreamAnchor(streamSite, { x: 18, z: 40 });
// Camera at (18,40) projects onto the (20,9)→(40,11) segment near the east bank, not the origin crossing.
pass(!!nearCam && nearCam.x > 15 && nearCam.x < 30 && nearCam.z > 8 && nearCam.z < 12,
  `nearestStreamAnchor projects onto the local centerline segment (got ${JSON.stringify(nearCam)})`);
const farWest = nearestStreamAnchor(streamSite, { x: -100, z: 0 });
pass(!!farWest && farWest.x < -30,
  `nearestStreamAnchor at the west extreme stays on the west bank (got ${JSON.stringify(farWest)})`);
pass(!!nearCam && Math.abs(nearCam.y - (streamSite.streamY(nearCam.x) + 0.25)) < 1e-9,
  'nearestStreamAnchor sits 0.25m above the analytic bed (matches solo water.anchor)');
const atCross = nearestStreamAnchor(streamSite, { x: 0, z: 0 });
pass(!!atCross && Math.abs(atCross.x) < 1 && Math.abs(atCross.z - 8) < 1,
  `nearestStreamAnchor near origin lands on the crossing sample (got ${JSON.stringify(atCross)})`);
pass(nearestStreamAnchor({ stream: null }, { x: 0, z: 0 }) === null,
  'nearestStreamAnchor returns null for a dry site (no solo-origin fallback)');
pass(nearestStreamAnchor(null, { x: 0, z: 0 }) === null,
  'nearestStreamAnchor returns null without a site');

const layout = { xEave: 5, zEave: 4, eaveEdgeY: 3 };
const locals = chimeLocalCorners(layout);
pass(locals.length === 4 && locals.every((c) => c.length === 3),
  'chimeLocalCorners yields four [x,y,z] eaves');
pass(locals[0][0] === 5 && locals[0][2] === 4 && Math.abs(locals[0][1] - 2.75) < 1e-9,
  'chimeLocalCorners hang 0.25m below eaveEdgeY');

const parcel = {
  id: 'p3', kind: 'giwa', hero: false,
  center: { x: 100, z: -50 },
  frontDir: { x: 0, z: 1 },
  houseLocal: { x: 1, z: -2 },
  baseY: 3,
  sx: 1, sy: 1, sz: 1,
  variant: 0,
};
const world = chimeWorldCorners(layout, parcel);
pass(!!world && world.length === 4,
  'chimeWorldCorners returns four world eaves for a residential parcel');
pass(world.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2])),
  'chimeWorldCorners world coordinates are finite');
// +z front, identity rot → world ≈ center + houseLocal + local
pass(Math.abs(world[0][0] - (100 + 1 + 5)) < 1e-6 && Math.abs(world[0][2] - (-50 - 2 + 4)) < 1e-6,
  `chimeWorldCorners applies houseLocal + center (got ${JSON.stringify(world[0])})`);
pass(Math.abs(world[0][1] - (3 + 2.75)) < 1e-6,
  'chimeWorldCorners y = baseY + scaled local eave height');

const parcels = [
  { id: 'hero', kind: 'giwa', hero: true, center: { x: 0, z: 0 } },
  { id: 'p1', kind: 'choga', hero: false, center: { x: 10, z: 0 } },
  { id: 'p2', kind: 'giwa', hero: false, center: { x: 100, z: 0 } },
  { id: 'palace', kind: 'palace', hero: false, center: { x: 5, z: 0 } },
];
pass(pickChimeParcel(parcels, { focusedId: 'p2' })?.id === 'p2',
  'pickChimeParcel prefers the focused residential parcel');
pass(pickChimeParcel(parcels, { focusedId: 'hero' })?.id === 'p1',
  'pickChimeParcel ignores a focused hero and falls back to nearest residential');
pass(pickChimeParcel(parcels, { ref: { x: 95, z: 0 } })?.id === 'p2',
  'pickChimeParcel picks the nearest giwa/choga to the camera when unfocused');
pass(pickChimeParcel(parcels, { focusedId: 'palace' })?.id === 'p1',
  'pickChimeParcel skips palace/temple hosts (multi-building eaves are not the product layout)');
pass(chimeLayoutParams({ kind: 'giwa' }, { kind: 'giwa', params: { bays: 4 } })?.bays === 4,
  'chimeLayoutParams prefers buildingSpec.params over an empty parcel');
pass(chimeLayoutParams({ kind: 'palace' }) === null,
  'chimeLayoutParams rejects non-residential hosts');

console.log(`\n=== check-audio-policy: ${failures.length ? `${failures.length} FAILURE(S)` : 'ALL PASS'} ===\n`);
if (failures.length) {
  for (const message of failures) console.log(`  - ${message}`);
  process.exit(1);
}
