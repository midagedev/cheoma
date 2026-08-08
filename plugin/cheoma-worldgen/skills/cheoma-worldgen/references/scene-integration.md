# Scene integration — village runtime, cinematic, audio

How a **three.js** consumer mounts cheoma’s browser runtime into its own scene. This surface is **not** reachable from the JSON plan / map-data pipeline alone — see [limitations.md](limitations.md). Plan-only agents stay on [plan-schema.md](plan-schema.md) and [map-data.md](map-data.md).

Related: [environment-and-look.md](environment-and-look.md) · [quickstart.md](quickstart.md) · [SKILL.md](../SKILL.md)  
Repo authority: `docs/external-reuse.md`, package `exports` in root `package.json`, product wiring **`app/src/engine/engine.js`**.

```api-symbols
src/api/index.js#createVillage
src/api/index.js#createVillageAsync
src/api/index.js#planVillage
src/api/index.js#setupEnvironment
src/api/index.js#setupPost
src/api/index.js#setupWeather
src/api/index.js#setupNightGlow
src/api/index.js#setupAudio
src/api/index.js#setupCinematic
src/api/index.js#compileSubtreeAsync
src/api/rendering.js#compileSubtreeAsync
src/api/cinematic.js#setupCinematic
src/api/cinematic.js#createDronePaths
src/api/cinematic.js#createWalker
src/api/cinematic.js#buildWalkSolids
src/api/cinematic.js#pointHitsWalkSolids
src/api/cinematic.js#createArchitecturalReveal
src/api/cinematic.js#villageFocusEffectWeight
src/api/cinematic.js#VILLAGE_FOCUS_DOF_APERTURE
src/api/audio.js#setupAudio
src/api/audio.js#createFootsteps
src/api/audio.js#chimeWorldCorners
src/api/audio.js#nearestStreamAnchor
```

## Full façade vs narrow entry

| Package export | Entry | When to use |
| --- | --- | --- |
| `cheoma` / `.` | `src/api/index.js` | Full public façade (village + environment + cinematic + audio + …). **Requires three.** |
| `cheoma/plan` | `src/api/village-plan.js` | Pure plan JSON, no three |
| `cheoma/building` | `src/api/building.js` | Standalone house build/dispose only |

Importing the aggregate façade pulls the browser runtime dependency graph. Standalone building consumers should use `cheoma/building` — see [SKILL.md](../SKILL.md) and `docs/external-reuse.md`.

```js
// Full façade (repo root relative, or `import … from 'cheoma'` after file: install)
import {
  planVillage,
  createVillage,
  createVillageAsync,
  setupEnvironment,
  setupPost,
  setupWeather,
  setupNightGlow,
  setupCinematic,
  setupAudio,
  compileSubtreeAsync,
} from './src/api/index.js';
```

`createVillage` / `createVillageAsync` are the public village runtime constructors (also on the façade via `village.js`). Prefer the async path for product-scale forests (worker offload); `?worker=0` / sync is the fallback in the product app, not a separate package export.

## Canonical product wiring (reference, not API)

**There is one product integration that already composes these façades correctly:**  
`app/src/engine/engine.js` (exposed in-app as `window.__engine`).

That file owns:

- One three.js `scene` + one renderer + one EffectComposer contract (`setupPost`)
- `setupEnvironment` → `setupWeather` → `setupNightGlow` lifecycle and time fan-out
- Village create/dispose, focus ring, wave handoff
- Shader warm via `compileSubtreeAsync` **scoped to the incoming subtree only**
- Audio `setupAudio` + intro events (never mute BGM by writing gains ad hoc)
- Cinematic / walk / reveal camera paths

**Do not treat engine methods as public API.** When this skill says “wire X like the product,” open `engine.js` and mirror ownership; when it lists a symbol, that symbol must exist on `src/api/*`.

### Shader warm

```js
import { compileSubtreeAsync } from './src/api/rendering.js';

// Warm only the *new* subtree (village incoming root). Passing the whole scene
// makes transition freezes worse (shader link cost scales with graph size).
await compileSubtreeAsync(renderer, incomingRoot, camera, scene);
```

## Cinematic

Public façade: `src/api/cinematic.js`.

| Export | Role |
| --- | --- |
| `setupCinematic(camera, controls, { layout, getLayout, domElement })` | Product drone / cinematic controller bound to OrbitControls |
| `createDronePaths({ site, plan, heightAt, seed, … })` | Seed-stable aerial tour paths over a plan |
| `createWalker({ site, plan, heightAt })` | First-person walk state (uses walk solids) |
| `buildWalkSolids(plan, heightAt)` | Gate-aware wall/house solids for collision |
| `pointHitsWalkSolids(solids, x, z, radius?)` | Query helper |
| `createArchitecturalReveal` / `createArchitecturalRevealTimeline` / `sampleArchitecturalReveal` | Renderer-free arrival camera path |
| `villageFocusEffectWeight` / optics constants (`VILLAGE_LENS`, `VILLAGE_FOCUS_DOF_APERTURE`, …) | Focus continuum math shared with DoF/post policy |
| `viewReduce` / `VIEW_PHASES` / `VIEW_EVENTS` | Explore/focus/hop lifecycle table (selection ≠ zoom) |

```js
import {
  setupCinematic,
  createDronePaths,
  createWalker,
  buildWalkSolids,
  pointHitsWalkSolids,
  createArchitecturalReveal,
} from './src/api/cinematic.js';

const cinematic = setupCinematic(camera, controls, {
  getLayout: () => layout,
  domElement: renderer.domElement,
});

const solids = buildWalkSolids(plan, plan.site.heightAt);
const walker = createWalker({ site: plan.site, plan, heightAt: plan.site.heightAt });
const paths = createDronePaths({ site: plan.site, plan, heightAt: plan.site.heightAt, seed: plan.seed });
```

Walk solids treat house bodies as solid (no interior entry) — same contract as map-data colliders; see [limitations.md](limitations.md) and [map-data.md](map-data.md).

Aerial / wide cinematic overview: product policy keeps **DoF amount 0** and **flare off**; rim uses `RIM_CONTEXT_MASTER.aerial` (0.75), not zero. Details: [environment-and-look.md](environment-and-look.md).

## Audio

Public façade: `src/api/audio.js`.

```js
import {
  setupAudio,
  createFootsteps,
  chimeWorldCorners,
  nearestStreamAnchor,
} from './src/api/audio.js';

// listenerCarrier is usually the camera (THREE.AudioListener is attached inside).
const audio = setupAudio(camera, {
  layout,
  getStreamAnchor: () => nearestStream /* Vector3 or null */,
  getChimeCorners: () => corners /* [[x,y,z]×4] or null */,
});

// Browser autoplay: call start() synchronously inside the first user gesture.
await audio.start();
audio.setTime('sunset');
audio.setWeather('clear');
audio.update(dt);
audio.dispose(); // stops/disconnects owned nodes; does NOT close three's shared AudioContext
```

Also exported: pure positional helpers `chimeLocalCorners`, `chimeLayoutParams`, `chimeWorldCorners`, `nearestStreamAnchor`, `pickChimeParcel`; footstep synth `createFootsteps` + stride constants `STRIDE_WALK` / `STRIDE_RUN` / `LAND_MIN_MPS`.

Product intro BGM mute/restore is owned by pure policy modules consumed inside `setupAudio` (`introEvent('arm'|'enter'|'settle'|'skip')`). The engine must not write BGM volume directly — missing restore leaves music permanently silent while SFX still play.

### Asset license honesty

- **Code** in this repository is under the repo license (MIT for the open core as shipped).
- **BGM under `assets/audio/`** is generated by the repository owner (Suno prompts live in `docs/suno-prompts.md`) and is **not** automatically free for third-party games to ship.
- **Ambience SFX** in the product mix include CC0 / parametric synth paths — check **`docs/credits.md`** (and the in-app References UI that parses it) before reusing any binary asset.
- **Code MIT ≠ asset license inheritance.** If your game cannot clear the audio files, use your own tracks or synth-only helpers (`createFootsteps`) and keep cheoma’s MP3s out of your build.

## Three.js-only reminder

Everything on this page needs WebGL + AudioContext (where used). Agents generating maps for Unity / Godot / servers should stay on plan JSON + [map-data.md](map-data.md) and reimplement atmosphere themselves ([limitations.md](limitations.md) — “Look pipeline is product-coupled”).

## Checklist for a minimal three.js host

1. Pin **one** `three@0.185.1` (alias + dedupe).
2. `planVillage` → `createVillage` / `createVillageAsync` into your scene.
3. `setupEnvironment` + optional `setupWeather` / `setupNightGlow` / `setupPost`.
4. Fan out time/season/weather through the handles (crossfade; use environment-state for coherence).
5. `compileSubtreeAsync` on each new village subtree before reveal.
6. Optional: `setupCinematic` / walker / drone paths; `setupAudio` after a user gesture.
7. Dispose every handle and village root you created; never leave PointLight counts unstable.

For look contracts (rim solar gate, DoF, snow patch, particles), continue in [environment-and-look.md](environment-and-look.md).
