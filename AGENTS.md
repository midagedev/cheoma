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
npm run check:app      # isolated full-app browser smoke
npm run check:worker   # sync / real Worker / fallback scene + picking contracts
npm run check:all      # all repository contract groups
```

There is **no unit-test framework, linter, typechecker, or formatter** (no eslint/prettier/tsconfig — don't hunt for `npm run lint`/`test`). Since nothing typechecks the JS, use `npx esbuild <file> --bundle --format=esm --outfile=/dev/null` as a fast syntax check before running a harness. Verification is **visual/behavioral via Playwright**: `tools/*.mjs` each spin up their own static HTTP server, drive headless Chromium, and write PNG screenshots. Playwright is a repo-root devDependency (root `package.json` — separate from `app/`), so run the tools with plain node:

```bash
npm install                        # at repo root, one-time (chromium reuses the shared Playwright cache)
node tools/shoot-<feature>.mjs
```

For a deterministic build snapshot use a clean build (`rm -rf dist && vite build`) — repeated incremental builds to a dedicated outDir can corrupt output (boot-time null uniforms). When spinning up an *extra* dev server for isolated verification, bind `host: '127.0.0.1'` (vite defaults to IPv6 `::1`, which Playwright's `127.0.0.1` refuses) with its own `cacheDir`; leave the user's own dev server alone.

### Harnesses & runtime flags
The core runs standalone from the repo-root `index.html` (plus per-domain harnesses `ink.html`, `layout.html`, `props.html`, `seasons.html`, `audio.html`). Subsystems expose URL params / `window.__*` hooks for isolated testing — e.g. `?post=0` (disable the post composer), `?worker=0` or `window.__villageSync` (synchronous village gen), `?rim=pass`, `window.__wx`, `window.__viewshift`. Prefer a direct-import harness over the full app path when verifying an `env/` change (the app path breaks often mid-refactor).

## Architecture

**Rendering — the flagship look (`src/env/post.js`)**: a unified EffectComposer, on by default (`?post=0` disables). The full-app pass order is Render → Grade/Rim → Bloom → Bokeh → Flare → Outline → Output. Output stays last so ACES tone mapping and sRGB conversion happen once, after the linear-HDR effects. The signature look is golden-hour backlit rim + bloom haze. The rim is a **Fresnel material patch** (`src/env/rim.js`) applied to role-tagged materials, not a screen-space normal pass.

**Building types & materials**: 궁(palace) / 절(temple) / 기와집(giwa) / 초가(choga). 단청 (dancheong) is type-dependent — palace & temple only. Roof builder dispatch: giwa → `roof-skeleton.js`; palace/temple/choga → `roof.js`. `src/builder/palette.js#makeMaterials` returns role-tagged materials; per-part color variety rides `instanceColor` at zero extra draw calls (adding material variants is expensive — mind draw-call budgets; town ceiling < 1000). A standalone `buildBuilding()` result must be released with `disposeBuilding()` from `src/api/building.js`; it disposes owned geometry/material/texture resources while preserving caller-owned shared `P.mats` and module-lifetime prop materials.

**Village generation** — a deterministic pipeline:
`src/village/plan.js` (pure plan) → `src/village/populate.js` (step orchestration over `src/generators/village/*`) → `src/runtime/village/create.js` and `handle.js`. `src/village/adapter.js` is only a compatibility re-export. Convention: **`+z` = south.** Scale is a continuum (`siteR` scalar / tier): lone house → hamlet → village → town → capital → hanyang (성곽 도성 with 사대문·시전, `citywall.js`). Repeated buildings are instanced (`chunks.js`, `instancing.js`).

Village rerolls use an exclusive scenery handoff: `src/village/wave.js` keeps exactly one static terrain/road/parcel/forest generation visible, swaps ownership only under the peak ink-fog veil, and drives shadows to zero for that frame. Buildings alone use the tofu transform wave. Never crossfade static scenery by mutating `transparent`, `opacity`, or `depthWrite`; dynamic animals, particles, and lights must expose `userData.waveFade` and compose the weight through a stable uniform or precompiled `alphaHash` material. The engine rim-patches and prewarms only the incoming subtree before it becomes visible. Gate this contract with `npm run check:wave` and inspect `npm run shoot:wave` output.

`src/village/parcel-contract.js` is the single spatial contract for a parcel: `frontDir` is the final south-oriented frame used by its polygon, house, wall ring, picking, and south-side `solarAccess`. Road guidance is clamped to the south-facing landform axis ±45° before seed-local jitter; `check:layout` caps the final result at 65°. A regular parcel's access gate is a separate, explicit contract: `access.gateEdge/gateT` select the nearest usable road-side wall edge while the house keeps its solar orientation. Every wall style and the runtime single-house rebuild must consume those fields; never infer the gate from `frontDir` or add a render-only yaw. The clan/government core is the deliberate exception: it is placed behind its south gate and its approach road terminates at that gate, not at the parcel center or roof.

`src/village/house-footprint.js` is the shared house-fit contract. It derives the actual variant roof footprint used by FULL/MID/FAR, finds a deterministic translation and uniform fit inside the parcel, and rejects miniature ordinary-house results. Planning and runtime single-house rerolls must both use `assignFittedVariationSequence()`; do not fit from `plotW`/`plotD` boxes or add a renderer-only correction.

Roads own stable IDs and bidirectional junction metadata through `roads.js`/`road-topology.js`. New branches stop at their first usable connection, and narrow double-crossing lenses are removed from the actual polylines before junctions are built. `road-spatial.js` is the uniform-grid source for nearest-road and width-aware corridor queries. Frontage and infill parcels retain the road point that produced them so access remains testable rather than inferred later. `stream-spatial.js` supplies exact polyline-to-polygon/circle clearances and reuses the same grid broad phase for bulk placement; do not return to center-point or `streamZat(x)` approximations.

**Performance is architectural here, not incidental** (this is a large scene):
- **Worker offload** (`populate.worker.js` + `forest-crunch.js`): forest placement (14k–40k trees, the bulk of generation cost) runs in a Web Worker that returns a transferable `Float32Array` of matrices + seasonal colors; the main thread only assembles `InstancedMesh`. `createVillageAsync` rAF-chunks that assembly. `?worker=0` is the synchronous fallback.
- **Vegetation footprint index** (`vegetation-spatial.js`): forest, scatter, yard trees, and guardians share radius-aware parcel, actual roof, road, stream, paddy, solar, and guardian clearances through a worker-safe uniform grid. Guardian trees are reserved in the pure plan with their real canopy radius; paddy candidates are trimmed to the exact stream bank where viable, then stable-filtered against occupied parcels and one another before vegetation planning. A two-argument forest mask preserves the historical anchor decision; the third radius argument is the final commit check after candidate RNG has been consumed. Do not reintroduce candidate × all-obstacle scans or trunk-only clearance.
- **Yard hard-object contract** (`yard-layout.js`): walls and flora share renderer-independent positions and semantic footprints for sheds, jangdok platforms, stacks, clotheslines, garden beds, and stone ornaments. Tall objects clear the whole canopy; low objects clear the trunk while allowing natural crown overhang. Add or move a yard object here first, then consume it from both renderers and `check:yard`.
- **Shader precompile**: transition freezes are shader **link** stalls, not CPU. `engine.js` calls `warmShaders` (`renderer.compileAsync` scoped to the *new* subtree only — passing the whole scene makes it worse) and flips `renderer.debug.checkShaderErrors = false` after the first village warm.
- Terrain radius is clamped to basin + a fixed buffer; the world edge is finished with `worldedge.js` mist rather than sprawling terrain.

**Determinism (critical)**: village generation swaps global `Math.random` for a seeded rng across the plan+populate window, then restores it; the worker uses a worker-local rng. Any multi-frame async path must save/reinstall the seed window per rAF slice, or the render loop's `Math.random` calls pollute the seed stream and break byte-identical reproduction. Gate village changes with a worker-vs-sync full-village hash.

**Environment (`src/env/`)**: time/season/weather changes crossfade via internal tweens — API signatures stay stable, no hard cut. Snow = a roof white-tint shader (not an accumulation volume); rain = falling-curtain particles. `focus.js` drives the close-up ambience ring (chickens, chimney smoke, wind grass, lanterns) on the focused parcel. Camera tweens must call `camera.lookAt` every frame — freezing direction snaps the frame on tween end. `setupEnvironment()` and `setupAudio()` both own explicit `dispose()` contracts; audio teardown stops/disconnects owned nodes but never closes three's shared `AudioContext`.

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
- `SANSA-HANDOFF.md` is the queued temple-relocation brief. Do not mix its behavior changes into mechanical structure moves. When implemented, its source changes must remain uncommitted for review unless the user changes that instruction.

Code comments reference design documents directly: `mode-integration.md` (mode/camera/focus integration — comments cite e.g. "mode-integration §5.5"), `palace-layout.md`, `joseon-city.md`, `tooling.md` (vetted library stack — manifold-3d, three-mesh-bvh, clipper2 offset caveat), `perf-webgpu.md`, `ui-design.md`, and `references.md`. Do not rename these files or renumber referenced sections casually.

Repository docs must be self-contained. Claude Code memory under `/Users/hckim/.claude/projects/-Users-hckim-repo-asiahouse/memory/` is useful historical input, but it includes superseded implementations, tool-specific routing, credentials, and ephemeral scratch paths. When a memory contains a stable rule that future work needs, migrate the rule into the relevant repository document instead of adding a hard dependency on that private path.
