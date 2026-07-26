# HANDOFF — 2026-07-26

Written at the end of a long autonomous session so a fresh session can pick up cold.
Read `CLAUDE.md` first (project contract), then this file, then `docs/project-status.md`.

`main` is at **`8a0e60a`**, pushed, and **deployed** — `cheoma.midagedev.com` serves
`index-DRRImtEb.js`, verified against the local build.

---

## 1. What landed this session

| commit | what |
|---|---|
| `8a0e60a` | ground stones and podium caps stop sharing a plane |
| `59304f7` | first-entry landing starts audio in the entry gesture and plays the entry track |
| `24001ef` | giwa roof courses keep a constant world pitch instead of fanning |
| `1f649de` | three authenticity defects — eave band, crossing stones, brush fence |
| `9254483` | falling leaves keep their colour — snow patch was blacking them out |

Three new **pure-node** gates were added and are registered inside `npm run check`
(now 62 fast contracts): `check-giwa-tile-course.mjs`, `check-ground-stone-bedding.mjs`,
`check-audio-policy.mjs`. Each was verified to **fail on the pre-fix source** before being
accepted — that check is the point, not a formality.

### 1.1 Roof tile courses (`24001ef`)

`src/layout/roof-skeleton.js` assigned the cross-slope tile coordinate as a *normalized*
parameter held constant along the slope (surface UV `u = iu/NU`, 수키와 rolls
`s = (j+0.5)/nRolls`). Iso-parameter lines are **not** parallel on a straight-skeleton face:
a face ending at reflex (회첨) vertices fans wider toward the ridge, one ending at convex
(추녀) vertices narrows. Measured: the ㄷ자 middle range's courtyard face ran 0.34 m per tile
at the eave against **1.12 m** at the ridge (3.3× — tiles narrowing as they flow down, the
user's report), and the 우진각 rect front face ran 0.34 m against **0.10 m** (3.3× bunching).
Rolls inherited the fan — worst was **45.0° off perpendicular** to its own eave, and no roll
was ever cut at a hip (top-Y spread 0.031 m).

Fixed by taking the cross-slope coordinate as **world projection onto the eave direction**
(`acrossOf`): UV `u = across / 0.34`, rolls on a constant 0.30 m world grid, terminating
before the ridge at a convex end and starting mid-slope in the 회첨골 at a reflex end.
Draw calls, programs, materials, textures all unchanged; triangles +1.7% worst case at village
scale. Worker goldens re-baselined (reason recorded in `tools/check-worker-contract.mjs`).

**Known follow-ups deliberately not fixed** — see task list §3.

### 1.2 Ground stones (`8a0e60a`)

The reported "디딤돌 z-fighting" was **five** exactly-coplanar up-facing surface pairs, and the
worst was not a stepping stone but the **기단 top itself** (`podium-upper` top ⟷ `podium-cap`
top, dy = 0, whole platform). The 초가 front 디딤돌 was worse than z-fighting: its top face
*was* the courtyard plane, so it rendered only as stripes in the ground and did not read as a
stone at all. Confirmed as colour-pass depth conflict, not shadow acne (persisted with
`shadow=0`). Multi-frame ROI flicker went from erratic 0.035–0.074 to flat 0.006 on the 기단.

New shared vocabulary `beddedStone(surfaceY, standAbove)` in `src/core/surface-clearance.js`:
authored height is measured from the **drawn surface** and the base sinks below grade — which is
also the authentic form (a trodden 디딤돌 is set into the ground). The new gate carries **six
regression fixtures** that re-inject the pre-fix coordinates, so the file guarantees "catches
that defect" rather than "is green today".

### 1.3 First-entry audio (`59304f7`)

The first-entry landing was **completely silent**, not playing the wrong track.
`enterVillageHero` called `ensureAudio()` but never `audio.start()` — and `start()` is the only
thing that calls `ctx.resume()` *and* starts the ambience/chime/stream/dog/BGM sources. The
title click was the one real user gesture in the flow and it was not used, so `ctx.state` stayed
`suspended` with **zero voices** until the user later tapped the canvas.

The mute/restore invariant was **not** the cause: every landing path did end at volume 1. The
volume was being restored onto an empty graph, which is why it looked like the mute bug. A UI
desync compounded it: `App.svelte` set `audioOn = true` without calling `engine.toggleAudio`, so
the ♪ icon read ON while the engine had `started === false` — the user's first ♪ press actually
*muted*.

`assets/audio/genesis.mp3` had **no automatic selection path** at all (it sat in `OPTION_TRACKS`,
which only feeds `getTracks()`). It is now the first-entry track and hands over to the
time-mapped track at landing settle through the existing 4 s equal-power crossfade.

Two new pure modules own what was implicit: `src/audio/track-policy.js` (state → track name,
plus `MANUAL_TRACKS` where an orphan mp3 must declare a reason) and `src/audio/intro-policy.js`
(the `arm/enter/settle/skip` state machine). The engine's **only** BGM channel is now
`audio.introEvent(...)`; it must never set BGM volume directly.

Mobile hardening: a self-removing resume net (`pointerdown`/`touchend`/`keydown` capture +
`visibilitychange`) because iOS suspends the context on backgrounding and never returns on its
own; prefetch reordered so the handover target is fetched first and reduced to one track on
`saveData`/2g/3g; `bgm.load()` failures recorded in `failures` instead of only `console.warn`.
Diagnostics: `window.__engine.audioDiag()`.

**Why the existing `check:audio` gate did not catch any of this** (named because it matters more
than the fix): it only drove `audio.html`, which has no title/landing path, so no engine wiring
was under test; its BGM assertion was literally "bgm track buttons present (count>0)" — it clicked
the genesis button and asserted nothing about the result; and it asserted teardown identity but
never a single **gain value, voice count, or track name**, so a correctly-built and completely
inaudible graph passed.

**Ask the user to check on their phone:** (1) silent switch OFF, tap the title once — music should
swell over ~2.5 s and change piece when the house finishes assembling; (2) if silent, read
`window.__engine.audioDiag()` — `ctxState: suspended` = autoplay/interruption path, `master: 0` =
toggled off in UI, non-empty `bgm.failures` = the mp3 did not load; (3) silent from the first tap,
or silent only *after* switching apps / taking a call — the second is the interruption path the
resume net handles.

**iOS hardware silent switch mutes WebAudio and no code change fixes it.** Mitigations
(a dismissible hint when `ctxState` is not `running`, or routing BGM through an
`HTMLAudioElement` and losing the crossfade graph) were deliberately **not** implemented — open
decision.

---

## 2. In-flight tracks (worktrees preserved, WIP-committed)

All four were killed by the session limit mid-round, then resumed and asked to converge without
new scope. Each worktree has a WIP checkpoint commit so nothing is uncommitted.

| track | worktree | WIP | base | state |
|---|---|---|---|---|
| Assembly part-order + pudding settle | `.claude/worktrees/agent-addfb80313bf43ede` | `63c9f03` | `1f649de` (stale) | 18 files. Needs rebase — `engine.js` and `hanok.js` both moved under it. |
| Critters (기러기 V / dog / cat) | `.claude/worktrees/agent-a436fb9fdab37be3e` | `e463e0b` | `1f649de` (stale) | 17 files, reaches into `rim.js` and `material-program-key.js` — justify or drop. |
| UI 3-axis + framing (i)/(ii) | `.claude/worktrees/agent-a67784a25ff426843` | `34fe7a5` | contains older main | **Most merge-ready.** One blocker: veil regression. |
| Village yard polygon | `.claude/worktrees/agent-ab06f53fc2fcc87b0` | `ad0d9d4` | `8a0e60a` (current) | Narrowed to the polygon fix only. |
| DoF tilt-shift + AA/high-DPI | `.claude/worktrees/dof-layers` | `c67aa52` | rebased onto main | 35 files. Tilt is structurally complete and compiles but is **behaviourally unverified**. |

### 2.1 Assembly (user-driven, three revisions)

The hero 종가 rose as one lump because `src/anim/assembly.js#playAssembly` finds parts by
**name** (`podium`/`columns`/`walls`/`brackets`/`roof`) and `src/layout/hanok.js` creates none of
them — the engine therefore falls back to `playCompoundAssembly` (`app/src/engine/engine.js`
~2048), whose own comment admits it lifts the 몸채 whole.

The user then revised a standing decision. **#126's "no rebound" is withdrawn.** What was
rejected back then was a *decoupled* post-landing wobble ("일단 다 지어진 다음에 그 이후 영역만
한번 덜렁거리고 말더라"); what is wanted is **the acceleration of rising off the ground carried
straight through into a pudding-like settle**, everywhere, not just the hero. The mechanism note
that matters: the rise uses `easeOutCubic`, so it arrives at `IMPACT` with velocity **exactly
zero** — any elastic response added after a zero-velocity arrival *must* be an arbitrary
independent wobble. The fix is to arrive with nonzero velocity and make the settle a damped
spring whose **initial condition is that velocity**, with volume-preserving squash. Then a heavy
roof reads heavy because of its approach velocity, not because someone typed a bigger amplitude.

Also requested: **slight** per-member offsets so multiple columns ripple ("다라라락"). The
existing stagger is real but invisible — `columns` window `[0.18, 0.48]` gives `spread = 0.12` of
total, so at ~2.6 s with ~12 columns the neighbour offset is **~26 ms, under two frames at
60 fps**. Two things must change together and the second matters more: magnitude above the
perceptual floor, and an **ordering that is spatially meaningful** (today it is `grp.children`
array order, which reads as random popping no matter the magnitude).

**Total duration may grow** — the user approved it ("이런게 나름 인상적인 클립이니까"). Guardrails:
the empty-site dead time must **not** grow; the coupled hero choreography (polar arc camera,
reveal hold, DoF `lockFocus` ramp, `heroAssembleTiming*`) must be re-timed as one unit; `skip()`
must still land on exact restored state; and any gate encoding the **old** no-overshoot decision
is stale and must be **re-authored**, not relaxed.

Invariants that still hold: only `position.y`/`scale`/`visible` may move and must restore exactly
at completion / `skip()` / `seek()`; no finished-building flash (`applyAt(0)` immediately);
`village.asmStarts === 1` for a hero landing; one shared easing language (`tofuScale`/`tofuBob`
are reused by assembly, 칸 expansion, merge and the engine compound path — do not fork).

### 2.2 UI 3-axis + focus framing

Two items finished: the editing-mode view chip (`data-view-chip`, in `EnvironmentDial.svelte`,
band 172×257 → **358×257 usable** on 390×844) and the ink-stroke progress animation moved to a
compositor `transform` (main-thread paints 178/178 frames → **0/181**; Blink was refusing to
composite `background-position-x`).

Then a real defect chain in how the focus band is derived. Three faces, two fixed:

- **(ii) verdict/applied-shift coordinate mismatch — implemented.** `projectPoint` assumed the
  camera axis sits at the safe-rect centre while the applied shift adds `compositionYFrac·h`
  (`focusCompositionFor` is 0 only for palace/temple, **1 for every residential parcel**), so a
  residential focus reported `fitted: true` while **56.5 px** of the house sat below the usable
  band on a phone. Fixed by threading an optional `appliedShift` through
  `src/camera/focus-framing.js#fitFocusFraming` so search **and** verdict happen in the shipped
  space; default path is arithmetically identical and two assertions pin that. Zero fixtures moved.
  Note `src/api/cinematic.js` is only a re-export façade — the implementation is
  `src/camera/focus-framing.js`.
- **(i) pre-morph first solve — designed, NOT applied.** On a phone the first solve runs while
  the chrome is still pre-morph (at synchronous `focus()` return the card is resident and the
  sheet is at `peek`; chip and `half` arrive ~60 ms later; the sheet box has a **420 ms** CSS
  transition), and it never re-solves, clamping to `scale 4` instead of the correct `2.94`. A
  plain wait-for-settle costs up to ~450 ms of dolly delay, so the mechanism is: start the tween
  immediately, then re-solve once on the inset-settled frame and **retarget the endpoint**,
  rebasing `p0` so position is exactly continuous — `p0' = (cur − k·p1')/(1 − k)` — letting only
  velocity redistribute. The complete applyable diff is in the UI track's report; `layoutSignature()`
  already exists in `app/src/engine/view-shift.js`. **Anchor E gets `compositionY` only** (that
  path drives `revealCamera`, not `tween`), and the retarget must **exclude the 종가 `arc` spiral**
  (different parameterisation). Do not retarget the lens — the authored 16°/7° frame is a look
  contract. This is the last blocker on the mobile palace `check:cinematic:app` timeout.
- **main's standing red assertion is the third face, and this branch fixes it.**
  `ordinary house focus frames sky above the eave and yard below it (top -0.0336, bottom -0.3077)`
  on main becomes `top +0.0243 / bottom -0.2517` on the branch. **Not** via (ii): `rayY(±1)`
  unprojects frustum-edge rays and depends only on pitch, vertical half-angle and the applied
  view offset, never on dolly distance. The cause is chrome geometry — the retired shell's
  bottom-heavy chrome (right drawer + bottom action bar) pushed the safe rect up into a large
  **positive** recentring shift (~+160 px) that cancelled and inverted the −110 px sky
  composition; the three-axis shell's shift is small and opposite-signed (−19…−38 px).

**Open look decision I made, not yet implemented:** the composition shift should be a fraction of
the **usable band**, not of viewport height — calibrated so desktop reproduces its current 104 px
exactly (`104/519 ≈ 0.20`, to be verified). Phone then gets ~51 px instead of 110 px: same
compositional intent, honestly scaled, no device conditional, no desktop regression. Rejected the
alternative of a phone-only clamp because it encodes "phones are special" into a look rule and
the next in-between viewport breaks again. If that makes the phone fit honestly, **delete the
`ideal-shift-fallback`** the agent added — a path that ships a frame the verdict did not authorise
is the same class of bug we just spent the session removing. If some viewport still cannot fit,
that must surface as a **gate failure**, not a silent substitution.

**New regression owned by this branch:** `densest entry veil hazes the establishing frame without
washing it out (fog factor 0.000 at 110.9m)`. The #16 entry reordering means generation is already
complete at entry, so the ink-fog veil has nothing left to ramp. The veil was doing two jobs and
only one was masking — it is also the app's opening look. Fix by binding it to the **arrival
choreography** rather than a generation wait, with zero added pre-motion latency (entry press went
3.2 s → 78 ms) and expressed against arrival *progress* rather than a hardcoded duration, because
the assembly length is changing concurrently.

### 2.3 Critters

Not missing — capped at two. `src/env/critters.js:659-665` `CAP` is a **village-total**
(`village: { dog: 2, cat: 2, magpie: 3 }`), while chickens are a different layer placed **per
parcel** by `populate`'s `buildVillageAnimals`. Compounding: `BIRD_BOOST = 4.2` gives distance
readability to the sky flock only and ground animals explicitly get none, so a 0.5–0.9 m dog is a
few pixels aerially; and the cat is "기단 위 웅크려 정지(대부분)". The flock is **boids**, a swarm by
construction, not a formation.

Freedom worth remembering: this layer is attached post-generation by the adapter (`finishVillage`)
and consumes only its own rng, so **population changes need no determinism re-baseline**, and each
species is a single `InstancedMesh` (≤4 draw calls regardless of count).

Asked for: a real V skein with echelon offsets and whole-body banking, gated to autumn/winter
(geese are winter migrants in Korea; 까치 is resident) — watch the known trap where a `setSeason`
exists but the adapter never calls it. Dog legibility diagnosed numerically before changing.
Cat presence earned by **placement and behaviour** (담장 top, 기단 edge, warm roof, beside the
장독대, sunny 마당 patch; tail flick, stretch, grooming, occasional dash) rather than headcount.

Authenticity hooks given **from memory and explicitly flagged as possibly wrong** — 이암 「모견도」,
변상벽 「묘작도」, 노안도(蘆雁圖). The agent was told to verify each attribution against the holding
institution and **drop what it cannot verify**. Check its report for which survived.

### 2.4 Village yard objects — measured, fix in progress

**The wall follows the irregular polygon; the yard objects are placed against a rectangle.**
`src/village/yard-layout.js` places the 장독대 at `x: -plotW/2 + width/2 + 0.5`,
`z: -plotD/2 + depth/2 + 0.5` — a flat **0.5 m** inset from the *rectangle* corner — while
`localParcelShape` pulls the back edge inward by up to `bnCap = 0.105·plotW` per side (~1.44 m on
a 13.7 m lot) plus `lean` up to `0.22·plotW`. Measured escape rate (seed 7, point-in-polygon
against `parcel.shape.pts`):

| tier | jangdok outside | worst overhang | stack | clothesline | garden |
|---|---|---|---|---|---|
| village | **17/34 (50%)** | 2.35 m | 0/34 | 0/34 | 2/34 (0.04 m) |
| town | **39/67 (58%)** | 2.21 m | 0/67 | 0/67 | 1/67 (0.05 m) |
| capital | **29/51 (57%)** | 2.63 m | 0/51 | 0/51 | 0/51 |

The rule is uniformly wrong; the 장독대 merely occupies the **back-left** corner, which is exactly
the one `bnL` pinches. Reproduction script:
`scratchpad/jangdok-escape.mjs` (path in §5). Escape rate scales with `plotW`, so enlarging lots
reduces but never removes it — the polygon fix is required independently of any scale change.

---

## 3. Queued work, in the order I would take it

1. **Land the UI branch.** Veil regression → then (i) applied by the lead once `engine.js` frees →
   `check:cinematic:app` once. This also turns main's standing red green.
2. **Village land scale and 마당 proportions** — the user's explicit direction, deferred from this
   session. Measured baseline (seed 7, non-hero; `scratchpad/yard-ratio2.mjs`):

   | tier | kind | lot | roof | built | front yard |
   |---|---|---|---|---|---|
   | hamlet | choga | 9.4×9.0 m (26평) | 7.4×5.1 = 37 m² | 45% | 2.6 m (min 1.2) |
   | village | choga | 10.2×9.5 (29평) | 7.8×5.4 = 42 | 44% | 3.1 m |
   | village | **giwa** | 13.7×12.6 (52평) | 10.4×9.8 = 101 | **59%** | **0.8 m (min 0.3)** |
   | town | giwa | 14.0×13.3 (56평) | 10.6×9.7 = 104 | 56% | 1.8 m (min 0.3) |
   | capital | giwa | 15.3×14.2 (67평) | 10.5×9.4 = 100 | 47% | 3.1 m |
   | hanyang | giwa | 15.0×14.1 (65평) | 10.1×9.0 = 92 | 44% | 3.5 m |

   Two findings: the 마당 falls out as a **remainder** rather than a designed space (hence 0.8 m),
   and the tier relationship is **inverted** — rural lots are tighter than the capital's, whereas
   the walled capital was dense and subdivided while a farmstead needed room for 마당 and 텃밭.
   `src/village/parcels.js:131-139` sizes from rank and village character only
   (`sizeMul = 0.84 + char01*0.40`) with **no urban/rural term**, while its own comment at line 39
   claims 가대제한 as the basis — claim and implementation have diverged.

   **User direction, verbatim:** "마을 땅 크기 자체도 더 키우고 마당도 더 넓게 만드는게 맞지싶다.
   집을 줄이는것은 디테일이 줄어서 아쉽거든. 그리고 이당시가 그렇게 땅을 빽뺵하게 쓰지도 않았을꺼같아."
   So **shrinking houses is off the table** (it costs close-up detail, which is goal 1 — this was my
   proposal and the user overruled it). Levers: site radius up, lots up tier-aware (rural most,
   Hanyang least — dense is historically right there *and* it is the heaviest scene), and above all
   make the yard a **derived minimum** so a 0.3 m yard becomes structurally impossible.

   The "terrain stays tight / village fills 65–75% of the frame" rule is about **proportion**, so it
   survives scaling — the real cost is forest tree count (per-area), draw calls, and generation time.
   Measure and report those; **never** thin the forest to hide them.

   Research still owed: 가대(家垈) 지급 figures and their unit conversion, surveyed lots from the
   국가민속문화유산 villages, and a 멍석/타작 working dimension that converts into a gateable minimum
   yard depth. A research agent was mid-verification when the limit hit — see §4.
3. **DoF round 2 (tilt-shift) + AA/high-DPI** — one branch, `dof-layers`, rebased. Tilt is
   structurally complete (`tiltStrength`/`tiltAnchorV` uniforms, `setTilt` with far-asymptote clamp
   headroom, `dof.js` API) and compiles, but **behaviourally unverified**. Remaining: narrower sharp
   band + steeper ramp, aerial DoF switch, speckle residue (MSAA resolve mixes emitter radiance into
   silhouette-edge texels carrying background depth), lantern **core** restoration (halo +20–35% but
   core 78→19 / 54→0), M6 focus accuracy, aerial re-capture, moving 3-frame crawl check, golden-hour
   backlit evidence. Also codify the `shoot:bokeh` ellipticity boundary (background ~1.05, foreground
   just above the measured 1.346 so the pre-fix 1.376 fails).
4. **Roof tile follow-ups** (all pre-existing, disclosed by `24001ef`, each needs its own visual
   round): 암키와 0.34 m vs 수키와 0.30 m are different constants but physically one course = one of
   each, so they drift out of phase; `sugiwaMaterial` has its texture axes swapped (TubeGeometry gives
   `uv.x` = along, `uv.y` = around, opposite to the code comment) and its density is 4× too high;
   the **v (course) direction is still parameter-based** — `slopeLen` is a running max consumed inside
   the same `iu` loop that computes it, so course spacing varies ~33% between mid-face and hip; and
   the 회첨 valley tube uses `poly[ci]` (wall corner) where hips use `eaveV[ci]`, differing by ~1.98 m
   at a ㄷ자 reflex corner, so there is no 회첨골 gutter tile.
5. **Positional SFX are anchored to the hidden single-building scene** — the real unfixed half of
   "효과음이 잘 안 나온다". `setupAudio` captures `streamAnchor: env.streamAnchor` **once by value**
   (unlike the dog, which uses a getter), and chimes sit at the origin building's eaves updated only
   via `computeLayout(P)`. In village mode the camera is near neither, so 풍경/개울 are inaudible or
   arrive from the wrong direction. Needs village-side anchors; a behaviour change, not wiring.
6. **#20 운무 절단 + aerial wall-line legibility** — azimuth/altitude-dependent fog thickness, and
   wall-line legibility via **canopy density/height falloff near the village** rather than wall tone
   (mud wall 0.50 / stylobate 0.63 vs foliage 0.21 already gives 2.4–3× contrast). Owned by
   `forest-crunch.js`; forest total preserved; expect a worker-hash re-baseline.
7. **#21 signature clip beat sheet** — 삼원법 고원 → 심원 → 평원, one take. No in-app recording
   (standing decision; clips are manual OS screen recordings). The reworked assembly is now a major
   beat and the sheet must account for its new duration and choreography.
8. **#10 Phase 5 program diet (R8) + transition delta.**
9. **Queued behind AA:** ink's fbm cell size is in device px so retina breaks the brush texture
   (normalize to CSS px, re-capture at DPR 2); re-judge `uLeafTransmit = 0.42` with `post` ON (bloom
   may push it to 0.35/0.30 — retreat line already documented in `seasons.js`).
10. **`app/package-lock.json` is out of sync with `app/package.json`** (it still says
    `"name": "joseon-app"` and carries two orphan `@fontsource` entries). Any `npm install` rewrites
    it, so every agent worktree keeps producing spurious diffs. Worth one deliberate commit; I did
    not do it near a release.

---

## 4. Open decisions the next session should not silently resolve

- **Composition as a band fraction** (§2.2) — decided by me, unimplemented. Verify the fraction
  reproduces desktop's 104 px before shipping.
- **iOS silent-switch mitigation** (§1.3) — a hint versus `HTMLAudioElement` routing. Neither
  implemented; the trade is losing the crossfade graph.
- **`village.mp3` is an orphan** with no automatic selection path. Declared in `MANUAL_TRACKS` with
  that reason rather than silently wired, because where it should overlap `TIME_TRACK` is a product
  decision. Ask the user whether they want it on village aerial.
- **The audio track suggested a `CLAUDE.md` amendment** recording the intro-policy contract. I did
  **not** make it — a peer asking me to edit `CLAUDE.md` is not the user asking, so it needs the
  user's call. The rule itself is recorded in `docs/verification.md` and in the module headers.
- **Research provenance for the 가대 figures** — a research agent (`gadae-research`) was verifying
  가대 부수, 안마당 실측 and 멍석 dimensions and died before delivering. I asked it directly for its
  findings; whatever it returns belongs in `docs/architectural-authenticity.md` with the document's
  three-way split (source-stated fact / this project's interpretation / still unmodelled) and in
  `docs/credits.md`. **Do not let unverified numbers into either file** — a wrong citation is worse
  than none here.

---

## 5. Working notes worth carrying

- **Gate weight (user correction this session).** The gates were too heavy: things decidable by
  pure computation were being proven in a headless browser. The repo already separates the layers —
  of 101 `check`/`shoot` scripts, **47 take the browser lock and 54 do not**, with the convention
  `check:X` pure and `check:X:browser`/`:app` rendered. The rule is now: **assert the cause in node,
  use the browser once to confirm the effect.** Geometry invariants, timing/ordering math, plan-level
  routing decisions, asset reachability and seeded reproducibility all belong in node — `three`
  runs there for `Object3D`/`Vector3`/`BufferGeometry` reads with no GL context. The browser earns
  its cost for `renderer.info` draw-call and **program** counts, shader compile/link, rendered depth
  artifacts, real `Worker` byte-identity, `AudioContext`, and one perceptual verdict. A numeric gate
  also catches *every* case, whereas a capture catches only the framing you happened to choose.
- **A gate that passes on broken code is worthless.** Every new gate this session was verified to
  fail on the pre-fix source first. Two agents' "12 failures" / "9 failures" claims were reproduced
  independently before their work was merged.
- **Prove the instrument is engaged before believing a negative result.** One agent's five negative
  shader-probe rounds were void because the injection never applied.
- **Attribution before re-baselining.** When a gate fails after an intended change, find the
  mechanism first. Twice this session a "regression" was a **stale worktree base**: the p31
  cinematic failures and the DoF app 3-FAIL both vanished on rebase, and the DoF case was provable —
  the three assertions passed with **byte-identical** measurements, so only the tolerance envelope
  had moved (`doorEnvelope` derives from `src/` geometry).
- **Reason from what can execute, not from what changed.** My own worst error this session: I pinned
  the DoF failures on a `view-shift.js` diff without checking that the harness disables view-shift
  entirely (`?shot=1` plus an explicit `setViewShiftEnabled(false)`), so the changed code never ran.
- **Worker golden re-baselining is the lead's job and the values must come from a run on the
  rebased tree.** Both agents' reported hashes were stale because main moved between their run and
  the merge. I re-baselined twice today with the reason recorded in the file.
- **Restore trap.** On a worktree branch with no commits, `git checkout -- <file>` reverts to base
  and destroys earlier rounds. Back up to `_wt-out/<name>.PRE-RESTORE.<ext>` first. Better: WIP-commit
  at every round boundary, which is what I did before this handoff.
- **Do not pipe a background gate through `head`/`tail`.** I truncated my own log twice and lost the
  failing assertion, once wasting a full re-run of a browser gate.
- **Browser lock is repo-global** (`.git/cheoma-worktrees/browser.lock`, 600 s). `lock timed out` is
  contention, not failure. With five or more agents it becomes the throughput bottleneck — which is
  the practical reason the pure-first rule pays.

### Scratch artifacts (session-local, will not survive)

`/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/`
holds `yard-ratio2.mjs` (parcel/roof/yard measurement), `jangdok-escape.mjs` (yard-object escape
measurement), and the full gate logs. **Copy anything worth keeping into `tools/` before the temp
directory is cleaned** — the two measurement scripts are the baseline evidence for §3.2 and §2.4 and
should probably become real gates.
