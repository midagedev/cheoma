# Ground junction — closing visible float under sloped footprints

Status: implementation contract (#56, 2026-08-05).

A structure floats when its lowest solid sits above the **rendered** terrain surface
somewhere under its own footprint. At walk-mode eye height (y ≈ 1.6 m) a slot of
about **0.12 m** already reads as a building hovering over the ground, which is what
the user reported: "도보모드로 보니 바닥 굴곡이 있는 경우 집이 붕 떠 있는 곳이 꽤 많다."

## What was actually wrong

Measured pure-node over `village / town / capital / hanyang × seeds 1, 2` at base
`d9dcdfc`, sampling each category's **real** footprint (dimensions taken from the
module that owns the drawn geometry) against the exact minimum of the triangulated
terrain the renderer draws:

| category | datum decided at | objs | float > 0.12 m | max float | closing geometry before |
|---|---|---|---|---|---|
| guardian 돌단 | `village/gardens.js:430` | 18 | 11 (61%) | **6.49 m** | none |
| sijeon shop rows | `generators/village/sijeon.js:235` | 319 | 99 (31%) | **2.91 m** | none |
| pavilion podium | `generators/village/features.js:357` | 8 | 5 (63%) | 0.98 m | none |
| jangseung / sotdae | `generators/village/features.js:408` | 16 | 13 (81%) | 0.57 m | none |
| parcel pad skirt | `village/pad-landing-plan.js:44` | 1115 | ~26 (2%) | 0.29 m | skirt, but leaky |
| palace feature pad | `generators/village/pads.js:116` | 2 | 2 | 0.37 m | skirt, but leaky |
| auxiliary storehouse | `village/auxiliary-building-plan.js:195` | 59 | 0 | 0.00 m | parcel pad top |

The cause is **not** a sampler mismatch. Decomposing every gap into
`slope` (the footprint spans a slope, but the base came from one centre sample) and
`mismatch` (analytic `site.heightAt` versus the drawn triangles) gives mean
`mismatch` of 0.01–0.04 m and max 0.24 m, against `slope` terms up to 6.5 m. The
defect is that a single point sample cannot represent a footprint on a slope, and
that nothing came down to meet the ground.

Two secondary findings from the same measurement:

- Every affected structure is **simultaneously buried** on its uphill side (sijeon
  up to 3.13 m). Re-datuming the base would trade one defect for another and would
  move every landmark, so the base is deliberately left alone (see below).
- `PAVILION_MAX_RELIEF = 1.4 m` exists but did not prevent a floating pavilion,
  because `pavilionTerrainRelief` measures a ring at `PAVILION_ROOF_RADIUS × 0.72`
  on the analytic field while the drawn podium is `PAVILION_DEFAULTS.radius + 0.9`.
  The gate measured a different footprint than the one that meets the ground.
  `pavilionPodiumFootprintRadius()` (`builder/pavilion-spec.js`) now owns that number.

## The contract

`src/village/ground-junction-plan.js` is the Three-free, JSON-safe source. Two rules
make it exact rather than sampled:

1. **The datum is the rendered surface.** Apron bottoms come from
   `terrainMeshSegmentRange` (`terrain-grid.js`), never a fresh `site.heightAt` call.
   The analytic field diverges from the drawn triangles, and a bottom computed on
   the wrong surface leaves a residual slot.
2. **A chord's bottom is flat at that chord's exact minimum.** Every terrain
   triangle is planar, so the minimum along a chord is available in closed form. A
   bottom edge interpolated between two endpoint samples does not close a mid-chord
   dip — that, plus a fixed 4-chord split of a long parcel edge, is exactly what
   leaked 0.29 m under residential pads.

`src/village/feature-junction-plan.js` applies it to the structures that own no pad
(sijeon rows, pavilion podium, guardian 돌단), taking every footprint dimension from
the module that owns the drawn geometry — `planSijeonFacade`,
`pavilionPodiumFootprintRadius`, `guardianDolranFootprintRadius`. A renderer must
not re-estimate a footprint, a datum, or an apron height.

Hard boundaries:

- **The shared terrain mesh is never re-tessellated.** The building comes down to
  the ground; the ground is not subdivided up to the building (same principle as the
  drainage contract).
- **The base datum is not moved.** Those samples are the street / clearing grade the
  surrounding roads and parcels were solved against.
- **No new material, texture, program family, or draw group.** Junction quads are
  appended to the existing `pad-skirt` buffer in `generators/village/pads.js` and
  share the single `pad-stone` family. `userData.groundJunction.parcelSkirtIndexCount`
  records where the parcel skirt ends so a same-boot A/B capture can toggle the
  junction with `setDrawRange` instead of shipping a runtime flag.
- A rise below `GROUND_JUNCTION.stepMin` (0.1 m) is left as bare grade — a micro-lip,
  not a slot. That cull is only sound while `stepMin < 0.12 m`, which the gate locks.
- Terrain poking **above** a pad top stays governed by the `shoot-relief` `maxPoke`
  contract; this round does not touch `computePadY`, and the harness still reports
  `maxPoke ≤ -0.011` with `floating: 0`.

## 석축 dressing (v2 — vision FIX)

A single tall untextured quad was judged a concrete slab. The face now reuses the
city-wall granite vocabulary, entirely through **vertex colours and geometry
subdivision** — no material, texture, or program family is added, and
`padStoneMaterial` remains the one shared stone family:

- **Courses.** A face taller than `dressAbove` (0.5 m) is split into ~0.42 m courses,
  capped at `maxCourses` (10) so the extreme tail cannot run away. `jointShade`
  (0.06) darkens each course's bottom edge and `crownLift` (0.03) lifts its top,
  which is what makes the horizontal joints read.
- **Batter.** The face leans back at `CITY_GATE_MASONRY.batterSlope` (0.08), so lower
  stone sits further out, capped at `batterMaxInset` (0.34 m) so a tall face cannot
  flare into a neighbour. Because the flared base stands *outside* the footprint ring,
  over terrain the ring chord never sampled, closure is now taken as the **minimum
  over the ring, half-flare, and full-flare chords** — the audit checks all three.
- **갓돌 capstone, flush.** The top 0.26 m course carries
  `CITY_STONE_VALUES.cornice` (1.02) and the lowest is the 대석 base course at
  `CITY_STONE_VALUES.base` (0.95). `capstoneProjection` is **0** and the gate locks it
  there — see the spike investigation below.
- **Watertight seams.** Course boundaries sit on absolute Y bands measured down from the
  datum, and corner offsets use a **mitred vertex normal**. Both exist so two chords of
  different height still meet: with per-chord bands the batter offsets landed at
  different heights and the wall could not close on itself.
- **Stone value.** `cityStoneTone` (spread 0.055) varies each block deterministically;
  the gate holds tone inside 0.8–1.2 so variation stays a shade, never a second stone.

Plain pad skirts write neutral white into the same colour attribute, so residential
축대 look is unchanged.

## Budget

Draw calls and material count are unchanged — still **2 pad meshes** and one
`pad-stone` material. `shoot-relief` reports byte-identical draw calls before and
after the round (827 / 801 / 371 / 346). Triangles, measured exactly across the
8-plan matrix:

| | quads | triangles |
|---|---|---|
| pad-skirt (denser exact chords) | 12972 → 22682 | +19420 |
| feature junctions incl. dressing + returns | +2173 | +4346 |
| **total** | | **+23766** |

Worst single plan is hanyang: **+7282 triangles**, about 0.15% of that scene's
~4.85 M.

## The two bright spikes (vision round 2026-08-05)

The lead rejected the v2 돌단 frame for two thin bright pointed spikes protruding past
the terrain. Identified by rendering the junction alone with one flat ID colour per
chord and counting connected silhouette components — no interpretation of a photograph:

| change | silhouette components |
|---|---|
| v2 as shipped | 38 |
| + mitred seams, absolute-Y course bands, arc-end returns | 40 (satellites byte-identical) |
| + flush capstone (`capstoneProjection: 0`) | **1** |

So the cause was the **projecting 갓돌 lip**, not the batter. The lip is the brightest
element in the apron (cornice 1.02 x crownLift) and was one short course tall, so on a
7 m wall seen from below it projected as a razor-thin up-facing blade standing proud of
the batter line, disconnected from the mass behind it. Two hypotheses were tested and
**disproved by measurement** first: the flared base is not over unsampled terrain
(worst radial gap **0.000 m**, worst sampled-vs-emitted flare drift **0.023 m**), and
the seams were not the cause (fixing them left the satellite components byte-identical).

Kept anyway, because they are correct independent of this bug: closure is now sampled at
the **flare cap** rather than at a flare derived from a provisional height (no circular
dependency), seams are mitred, and every arc end carries a **return** whose bottom
reaches the terrain minimum along its own radial line. That last one matters because a
junction is normally an arc, not a ring — culled chords leave the wall terminating in
mid-air, and the chord-parallel minima that close the face say nothing about the ground
under a return.

## Open frontier

- **Public props (장승 한 쌍, 솟대), max 0.57 m — deliberately not closed.**
  These are posts, not plinth-borne buildings: the enclosing planning cylinder
  over-states their real slot (the posts stand near the centre), and the
  in-vocabulary fix is a deeper post sink in `src/props/`, not a stone apron ring.
  Pinned in `tools/check-house-float.mjs` as a no-regression ceiling of 0.60 m,
  marked `[잠정 — 백로그]`.
- **One guardian tree (hanyang seed 1) needs a 6.59 m apron.** The geometry is now
  closed, but 12.5 m of relief under a 6.4 m stone platform is a *placement* defect:
  `guardian-plan.js#clearAt` has no terrain-relief criterion at all, unlike
  `planPavilion`. It is the only object above 2.5 m across the whole matrix (per-plan
  maxima: 1.39 / 2.38 / 0.67 / 1.97 / 0.78 / 2.43 / 6.59 / 1.78 m). Adding a relief
  criterion moves a required landmark and reaches `dangsanHardObstacles`, garden
  anchors, and focus blockers, so it is left as a decision rather than taken
  unilaterally.

## Gate

`node tools/check-house-float.mjs` — pure, unregistered (gate policy 2026-08-02:
new feature gates stay opt-in). It asserts two things that must both hold:

1. **Closure** — every junction and pad skirt reaches at or below the exact
   rendered-terrain minimum under every chord, to within `stepMin`.
2. **FAIL-first fixtures, carried permanently** — the *unclosed* float (what the
   datum alone leaves, i.e. the pre-fix geometry) must still measurably exceed the
   visible threshold: sijeon ≥ 2.5 m, 돌단 ≥ 5.5 m, pavilion ≥ 0.8 m, and the legacy
   analytic endpoint pad skirt > 0.12 m. Reverting the apron fails (1); neutering the
   measurement so everything reads flat fails (2).

Also affected and re-run green: `node tools/check-pad-landing.mjs`, `npm run check`,
`node tools/shoot-relief.mjs`.

## The capture tool is itself gated (learned the hard way)

`node tools/shoot-house-float.mjs` takes same-boot A/B pairs (`setDrawRange` on the
shared buffer split — no runtime feature flag, and cross-boot pairs would compare
framings). Its **first revision produced six unusable images**, and every one of the
following assertions exists because a specific silent failure shipped past review:

1. **`plan.site` is resolved explicitly and the tool refuses to aim without it.** The
   village handle exposes `{ group, plan, seed }` and has **no `site`**; reading
   `village.site` returned undefined and fell back to `ground() = 0`, putting the eye
   **17.2 m below** hanyang's terrain. The ground was then invisible (terrain
   backfaces are culled) and everything was seen from underneath.
2. **Eye clearance > 1.5 m above `terrainMeshHeightAt`, and `up == (0,1,0)`.** The
   legacy aim is kept as `mode='legacy'` and asserted to still *fail* these, so the
   checks cannot quietly stop catching what they were written for.
3. **Bottom third of the frame ≥ 85% non-sky.** The broken frames measured 0.0%.
4. **The apron must cover ≥ 2000 px of the frame.** Ground in frame is not subject in
   frame: a centre-aimed shot showed 653 px and one pair differed by **12 px**. The
   aim therefore reads the tallest planned junction face out of the plan and frames
   *that*, rather than guessing where the defect is.
5. **Standoff is proportional to the face height, nearest-first, and validated by
   both `terrainMeshSegmentClearance` and a real occlusion raycast.** Terrain
   clearance alone let a neighbouring shop block the subject (sijeon read 0 px at
   9 m); a fixed standoff alone put a 1.1 m pavilion apron under the coverage floor.

Current output, all six frames passing: eye clearance exactly 1.60 m, up = [0,1,0],
bottom-third ground 100%, apron coverage 4.83% (sijeon, 3.11 m face) / 1.48%
(돌단, 6.99 m face) / 3.29% (pavilion, 1.09 m face).

The tool also answers identity questions mechanically. Isolating the junction range
and comparing masks showed that **100.0% of the pixels that appeared in the v1
"after" frame were junction geometry, 0 unexplained** — the "floating dark slab" the
first review saw was the sijeon apron itself, correctly placed, seen from underground
with its retained terrain culled away.
