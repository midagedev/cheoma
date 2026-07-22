# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

cheoma (처마) — a procedural Joseon-era Korean architecture & village generator in three.js. Parametric hanok (칸 system, 공포, 팔작지붕 curvature), auto-composed villages (배산임수 terrain, 필지·담장·고샅, 다랑이 논·개울, 산사), a scale continuum from a lone house to a walled capital (한양) with multi-곽 palaces, plus time/season/weather, a focus zoom continuum, and an ink (수묵화) NPR mode. Live at cheoma.midagedev.com.

## Two-layer boundary (read this first)

- **`src/`** — the framework-agnostic ES-module core (pure three.js): all generation, rendering, environment, animation, export. Imports bare `three`. **Never import Svelte or anything from `app/` into `src/`.**
- **`app/`** — a Svelte 5 + Vite SPA that consumes the core through `src/api/` only. `app/src/engine/engine.js` is the imperative wrapper: it wires the core into one three.js scene and exposes `window.__engine`. Svelte components drive that imperative API only — they hold no three.js state of their own.

three is pinned to **0.185.1**. `app/vite.config.js` aliases bare `three` → `app/node_modules` (with `dedupe`) and sets `server.fs.allow = repoRoot` so the app can import `../src`. A second three instance silently breaks `instanceof` checks and prototype patches (e.g. accelerated raycast).

## Commands

```bash
cd app
npm install
npm run dev      # vite dev server (default :5173)
npm run build    # → app/dist   (build.target es2022, assetsInlineLimit 0)
```

Repository contract gates run from the root:

```bash
npm run check          # architecture + plan goldens + pure geometry invariants
npm run check:pr       # changed-file router: fast core + affected browser/worker gates
npm run check:app      # isolated full-app browser smoke
npm run check:worker   # sync / real Worker / fallback scene + picking contracts
npm run check:all      # all repository contract groups
npm run check:full     # merge gate: all + DoF/LOD app flows + production build
```

There is **no unit-test framework, linter, typechecker, or formatter** (no eslint/prettier/tsconfig — don't hunt for `npm run lint`/`test`). Since nothing typechecks the JS, use `npx esbuild <file> --bundle --format=esm --outfile=/dev/null` as a fast syntax check before running a harness. Verification is **visual/behavioral via Playwright**: `tools/*.mjs` each spin up their own static HTTP server, drive headless Chromium, and write PNG screenshots. Playwright is a repo-root devDependency (root `package.json` — separate from `app/`), so run the tools with plain node:

```bash
npm install                        # at repo root, one-time (chromium reuses the shared Playwright cache)
node tools/shoot-<feature>.mjs
```

For normal iteration, start with `npm run check:pr -- --dry-run`, then run `npm run check:pr`. The router always runs the fast core contracts, unions only the browser/worker gates affected by the changed paths, and fails closed to `check:full` for unknown paths, verification tooling, dependency manifests, or an unresolved merge base. `npm run check` runs its isolated contracts with bounded parallelism (`CHEOMA_CHECK_JOBS`, default up to 4). Run `check:full` once before merging; it preserves the full Hanyang/continuous-frame coverage and adds a production build.

Canonical browser harnesses use `CHEOMA_BROWSER=auto`: they prefer an installed Chrome, which may use the host GPU, and fall back to Playwright's bundled Chromium. Use `CHEOMA_BROWSER=chrome` or `CHEOMA_BROWSER=chromium` to require one backend. Harnesses using this launcher log the selected browser and, when applicable, the WebGL renderer; never compare wall time across different backends. `check:worker` deliberately stays on Playwright-pinned Chromium because its byte goldens include browser-runtime floating-point behavior and it does not render WebGL.

For a deterministic build snapshot use a clean build (`rm -rf dist && vite build`) — repeated incremental builds to a dedicated outDir can corrupt output (boot-time null uniforms). When spinning up an *extra* dev server for isolated verification, bind `host: '127.0.0.1'` (vite defaults to IPv6 `::1`, which Playwright's `127.0.0.1` refuses) with its own `cacheDir`; leave the user's own dev server alone.

### Harnesses & runtime flags
The core runs standalone from the repo-root `index.html` (plus per-domain harnesses `ink.html`, `layout.html`, `props.html`, `seasons.html`, `audio.html`). Subsystems expose URL params / `window.__*` hooks for isolated testing — e.g. `?post=0` (disable the post composer), `?worker=0` or `window.__villageSync` (synchronous village gen), `?rim=pass`, `window.__wx`, `window.__viewshift`. Prefer a direct-import harness over the full app path when verifying an `env/` change (the app path breaks often mid-refactor).

## Architecture

**Rendering — the flagship look (`src/env/post.js`)**: a unified EffectComposer, on by default (`?post=0` disables). The full-app pass order is Render → Grade/Rim → Bloom → Bokeh → Flare → Outline → Output. Output stays last so ACES tone mapping and sRGB conversion happen once, after the linear-HDR effects. The signature look is golden-hour backlit rim + bloom haze. The rim is a **Fresnel material patch** (`src/env/rim.js`) applied to role-tagged materials, not a screen-space normal pass.

**Building types & materials**: 궁(palace) / 절(temple) / 기와집(giwa) / 초가(choga). 단청 (dancheong) is type-dependent — palace & temple only. Roof builder dispatch: giwa → `roof-skeleton.js`; palace/temple/choga → `roof.js`. `src/builder/palette.js#makeMaterials` returns role-tagged materials; per-part color variety rides `instanceColor` at zero extra draw calls (adding material variants is expensive — mind draw-call budgets; town ceiling < 1000). A standalone `buildBuilding()` result must be released with `disposeBuilding()` from `src/api/building.js`; it disposes owned geometry/material/texture resources while preserving caller-owned shared `P.mats` and module-lifetime prop materials.

`src/builder/dancheong.js` owns the reusable, renderer-free dancheong axes and rank policy. Palace defaults to moro; a temple compound reserves geum for its main worship hall and steps subsidiary/domestic buildings down. Cached Canvas sources are immutable and bucket-keyed; Texture/Material objects stay palette-owned so concurrent compounds and disposal cannot mutate one another. Never expose dancheong controls or allocate its textures for giwa/choga. See `docs/dancheong.md`.

`src/core/surface-clearance.js` owns the small world-space separations for building contact surfaces. Sink only the lowest foundation while preserving its visible top, keep courtyard/terrain faces physically separated, and place visible opening faces beyond their host geometry. Do not hide coplanar defects with camera-dependent `polygonOffset`. The giwa podium is one concave solid per stone course; never rebuild its ㄱ footprint from overlapping boxes.

**Village generation** — a deterministic pipeline:
`src/village/plan.js` (pure plan) → `src/village/populate.js` (step orchestration over `src/generators/village/*`) → `src/runtime/village/create.js` and `handle.js`. `src/village/adapter.js` is only a compatibility re-export. Convention: **`+z` = south.** Scale is a continuum (`siteR` scalar / tier): lone house → hamlet → village → town → capital → hanyang (성곽 도성 with 사대문·시전, `citywall.js`). Repeated buildings are instanced (`chunks.js`, `instancing.js`).

Village rerolls use an exclusive scenery handoff: `src/village/wave.js` keeps exactly one static terrain/road/parcel/forest generation visible, swaps ownership only under the peak ink-fog veil, and drives shadows to zero for that frame. Buildings alone use the tofu transform wave. Never crossfade static scenery by mutating `transparent`, `opacity`, or `depthWrite`; dynamic animals, particles, and lights must expose `userData.waveFade` and compose the weight through a stable uniform or precompiled `alphaHash` material. The engine rim-patches and prewarms only the incoming subtree before it becomes visible. Gate this contract with `npm run check:wave` and `npm run check:wave:app`; inspect the representative `npm run shoot:wave` output during iteration and `npm run shoot:wave:full` for the full scale matrix.

`src/village/parcel-contract.js` is the single spatial contract for a parcel: `frontDir` is the final south-oriented frame used by its polygon, house, wall ring, picking, and south-side `solarAccess`. Road guidance is clamped to the south-facing landform axis ±45° before seed-local jitter; `check:layout` caps the final result at 65°. A regular parcel's access gate is a separate, explicit contract: `access.gateEdge/gateT` select the nearest usable road-side wall edge while the house keeps its solar orientation. Every wall style and the runtime single-house rebuild must consume those fields; never infer the gate from `frontDir` or add a render-only yaw. The clan/government core is the deliberate exception: it is placed behind its south gate and its approach road terminates at that gate, not at the parcel center or roof.

`src/village/solar-access.js` is the shared low-winter-sun contract. Parcel placement uses actual variant roof polygons, roof/terrain heights, a conservative 30° angle, and a 1.5m window target; circular structures and feature props use the same height-aware shadow reach rather than pretending to be tree canopies. Frontage, infill, satellites, and residential/government reserved cores participate as targets; a palace precinct is an obstruction but its large vegetation corridor is not misread as one residential window. `check:layout` verifies every planned pair and tall feature obstruction.

`src/village/pavilion-plan.js` owns the public pavilion as an actual building footprint, not a point prop. `src/builder/pavilion-spec.js` is the single source for its rendered default eave radius and height. Required guardian trees and paddies reserve their stable footprints first; the pavilion then avoids parcels, roads, streams, production land, guardian canopies, every parcel's height-aware `solarAccess`, and the perspective-narrowing house silhouette envelope around the exact `planParcelFocus()` camera. A center ray alone is insufficient because broad eaves can cover a door or roof corner while missing it. Residential focus cameras still aim through the south-light opening; never repair a blocked pavilion with a render-only camera offset.

`src/village/public-props-plan.js` owns village-level jangseung, sotdae, wells, jar platforms, haystacks, and mortars. Their renderer dimensions reduce to named planning cylinders; tall pieces share the house focus-frame and low-winter-sun checks, while low pieces may remain as useful foreground detail. They must also avoid parcels, roads, streams, production land, guardian canopies, the pavilion, and one another. Do not return these props to fixed render-only coordinates.

`src/temple/plan.js` is the reusable local-space temple contract and `src/temple/compound.js` is its Three.js assembler/lifecycle boundary. Compact/courtyard/extended reserve 22–30m, 36–48m, and 52–72m rectangular precincts before village parcels, roads, and vegetation are finalized. The village adapter must consume `compound.width/depth` and the embedded plan; it may not rebuild a different arrangement from the variant name. Main-hall `solarAccess` stays clear of other halls and tall monuments, and the temple focus camera approaches from the same south-facing `frontDir`. Public consumers use `src/api/temple-plan.js` without Three or `src/api/temple.js` with rendering. Gate changes with `npm run check:temple`, `npm run check:temple:browser`, and the temple frame from `npm run shoot:focus-level`.

`src/village/house-footprint.js` is the shared house-fit contract. It derives the actual variant roof footprint used by FULL/MID/FAR, finds a deterministic translation and uniform fit inside the parcel, and rejects miniature ordinary-house results. Planning and runtime single-house rerolls must both use `assignFittedVariationSequence()`; do not fit from `plotW`/`plotD` boxes or add a renderer-only correction.

`src/village/parcel-rebuild.js` is the focused-house rebuild contract. Every rebuild derives from an immutable copy of the originally reserved parcel, never from the last inset, and preserves the south frame, road access, solar opening, pavilion sightline, and neighbour envelope. A committed rebuild is an authoritative aerial overlay: focus-out must not reveal the stale instanced house. Commit the exact edited roof bounds and yard fields before regenerating the single batched `village-flora` group with the same village seed/options, then refresh animal tree perches; live slider frames may defer that flora swap until pointer release. Persistent edit ownership and current-focus ambience exclusion are separate states. Gate this path with `npm run check:parcel-rebuild` and `npm run check:parcel-rebuild:browser`.

Geometry-backed house sliders use `app/src/lib/live-edit-scheduler.js`. Input labels update for every event, but regular-house previews are latest-wins, frame-aligned, and adapt from 32–96ms to measured rebuild cost. Pointer/change commit cancels the preview and performs the one flora/pick-boundary refresh; focus changes, scene exit, and teardown must cancel the scheduler so uncommitted values cannot cross parcel ownership. Special compounds remain commit-only. Gate the pure timing contract with `npm run check:live-edit`; the shared parcel browser gate covers the real Svelte input path without adding another app boot.

Roads own stable IDs and bidirectional junction metadata through `roads.js`/`road-topology.js`. New branches stop at their first usable connection, and narrow double-crossing lenses are removed from the actual polylines before junctions are built. `road-spatial.js` is the uniform-grid source for nearest-road and width-aware corridor queries. Frontage and infill parcels retain the road point that produced them so access remains testable rather than inferred later. `stream-spatial.js` supplies exact polyline-to-polygon/circle clearances and reuses the same grid broad phase for bulk placement; do not return to center-point or `streamZat(x)` approximations.

The village creek owns two widths: `streamHalf` is the bank/channel reservation used by planning, while `streamWaterHalf` is the visible ordinary-water width and caps before becoming a river. `site.heightAt` blends a broad valley into a monotonic bed that descends toward the shader's `-x` flow. Water and bridges must use `streamSurfaceHeightAt()` from `terrain-grid.js`, which includes the actual triangulated terrain surface; do not place them from analytic `streamY` alone. `river=true` is a separate capital/Hanyang archetype: 60–120m wet width, broad alluvial floor, tapered world-edge handoff, ferry rather than a permanent monumental bridge, connected roads on both banks, and a south-bank port ward whose houses still use the normal fit/solar/access/vegetation contracts. `river-port-plan.js` owns its pure roads and ward seeds; never add renderer-only waterfront buildings. `check:layout` samples the actual tapered width of every rendered cross-section and `check:worker` fixes the resulting scene bytes.

**Performance is architectural here, not incidental** (this is a large scene):
- **Worker offload** (`populate.worker.js` + `forest-crunch.js`): forest placement (14k–40k trees, the bulk of generation cost) runs in a Web Worker that returns a transferable `Float32Array` of matrices + seasonal colors; the main thread only assembles `InstancedMesh`. `createVillageAsync` rAF-chunks that assembly. `?worker=0` is the synchronous fallback.
- **Vegetation footprint index** (`vegetation-spatial.js`): forest, scatter, yard trees, and guardians share radius-aware parcel, actual roof, road, stream, paddy, solar, and guardian clearances through a worker-safe uniform grid. Guardian trees are reserved in the pure plan with their real canopy radius; paddy candidates are trimmed to the exact stream bank where viable, then stable-filtered against occupied parcels and one another before vegetation planning. A two-argument forest mask preserves the historical anchor decision; the third radius argument is the final commit check after candidate RNG has been consumed. Do not reintroduce candidate × all-obstacle scans or trunk-only clearance.
- **Yard hard-object contract** (`yard-layout.js`): walls and flora share renderer-independent positions and semantic footprints for sheds, jangdok platforms, stacks, clotheslines, garden beds, and stone ornaments. Tall objects clear the whole canopy; low objects clear the trunk while allowing natural crown overhang. Add or move a yard object here first, then consume it from both renderers and `check:yard`.
- **Shader precompile**: transition freezes are shader **link** stalls, not CPU. `engine.js` calls `warmShaders` through public `compileSubtreeAsync`, scoped to the *new* subtree only — passing the whole scene makes it worse. The helper tolerates materials disposed while GPU-link polling is pending, and the engine flips `renderer.debug.checkShaderErrors = false` after the first village warm.
- Terrain radius is clamped to basin + a fixed buffer; the world edge is finished with `worldedge.js` mist rather than sprawling terrain.

**Determinism (critical)**: village generation swaps global `Math.random` for a seeded rng across the plan+populate window, then restores it; the worker uses a worker-local rng. Any multi-frame async path must save/reinstall the seed window per rAF slice, or the render loop's `Math.random` calls pollute the seed stream and break byte-identical reproduction. Gate village changes with a worker-vs-sync full-village hash.

**Environment (`src/env/`)**: time/season/weather changes crossfade via internal tweens — API signatures stay stable, no hard cut. `atmosphere-profiles.js` is the Three/DOM-free source for synchronized sky/light/fog/post sunset looks; public consumers use `src/api/environment.js`. The camera-relative scene-level sky survives single-house/village terrain swaps. Village clouds have two roles: four local billboards own the exact ground-shadow blobs and fade visually when their apparent telephoto size becomes a ceiling; the 16-instance horizon bank owns visible close-up silhouettes, HDR rim, moon occlusion, and crepuscular rays in one draw call. General parcel focus keeps its planned south-axis approach, lintel/eave target, and 1.35m yard eye height, while `view-shift.js` composes the authored sky rise into the projection and resets it on focus exit/reroll. Gate this boundary with `npm run check:atmosphere`, `npm run shoot:sky`, cloud-shadow verification, and `npm run shoot:focus-level`. Snow = a roof white-tint shader (not an accumulation volume); rain = falling-curtain particles. `focus.js` drives the close-up ambience ring (chickens, chimney smoke, wind grass, lanterns) on the focused parcel. Camera tweens must call `camera.lookAt` every frame — freezing direction snaps the frame on tween end. `setupEnvironment()` and `setupAudio()` both own explicit `dispose()` contracts; audio teardown stops/disconnects owned nodes but never closes three's shared `AudioContext`.

Village zoom never owns selection. Wheel/pinch changes framing inside the current `explore` or `focus` regime; only a house click/programmatic focus enters a parcel, and only the breadcrumb, Escape, or explicit view toggle returns to exploration. `src/camera/optics.js` owns both regimes' reference-distance bounds so wide aerial and telephoto focus lenses share one screen-equivalent contract. Gate this behavior in the existing full-app smoke rather than adding another browser startup.

**Other core dirs**: `src/layout/` (hanok/compound assembly, `offsetPoly`), `src/anim/assembly.js` (the "tofu" drop-in assembly, shared by assembly/expansion/merge), `src/camera/`, `src/cinematic/` (drone + first-person walk), `src/export/` (glTF/GLB, `EXT_mesh_gpu_instancing`), `src/render/` (ink NPR), `src/props/`, `src/share/`.

## onBeforeCompile gotchas
Many stock materials are patched via `onBeforeCompile`. Rules learned the hard way:
- No dynamically-indexed custom uniform arrays. `Vector3.copy(Color)` yields NaN → black render.
- Patch **chain order inverts**: an earlier-registered patch's `color` code runs *after* a later patch's (string-replacement ordering) — exploited deliberately for seasonal multiply overrides.
- World-normal effects on an `InstancedMesh` must compose `mat3(instanceMatrix)` (instance orientation lives in `instanceMatrix`, not `modelMatrix`), or up-facing gates read zero.

## Verifying visual changes
Headless ANGLE serializes shader linking, so absolute frame-ms from headless runs is unreliable — judge perf by **program-count deltas** and determinism hashes, not wall-clock. Keep gate screenshots minimal; put throwaway captures in a scratch dir, not `shots/`.

## Documentation & current work

- Start at `docs/README.md` for the document map and status labels. Not every file in `docs/` is a current implementation contract; research and dated snapshots are marked there.
- `docs/project-status.md` holds the current wrap-up direction and stable user decisions migrated from Claude Code memory.
- `docs/architecture-refactor.md` records the completed first structure pass and the current reuse/boundary contract. Public consumer entrypoints live in `src/api/`; internal modules must not import that façade. Run `npm run check` before browser-heavy gates.
- `docs/verification.md` is the canonical harness map. In particular, `tools/check-determinism.mjs` does not compare worker vs sync and does not hash temple data, while `tools/verify-forest.mjs` is obsolete.
- `SANSA-HANDOFF.md` records the reviewed #5 temple-site history. `docs/temple-generator.md` is the current #12 contract for the implemented reusable multi-building compounds, stone props, editor, lifecycle, and render budgets.

Code comments reference design documents directly: `mode-integration.md` (mode/camera/focus integration — comments cite e.g. "mode-integration §5.5"), `palace-layout.md`, `joseon-city.md`, `tooling.md` (vetted library stack — manifold-3d, three-mesh-bvh, clipper2 offset caveat), `perf-webgpu.md`, `ui-design.md`, and `references.md`. Do not rename these files or renumber referenced sections casually.

Repository docs must be self-contained. Claude Code memory under `/Users/hckim/.claude/projects/-Users-hckim-repo-asiahouse/memory/` is useful historical input, but it includes superseded implementations, tool-specific routing, credentials, and ephemeral scratch paths. When a memory contains a stable rule that future work needs, migrate the rule into the relevant repository document instead of adding a hard dependency on that private path.
