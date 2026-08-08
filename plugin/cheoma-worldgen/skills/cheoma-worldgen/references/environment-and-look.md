# Environment & flagship look (three.js consumers)

Public surfaces for time-of-day, season, weather, post (rim/DoF/bloom), night glow, snow material tint, and physical particles. **All of this requires a browser WebGL runtime and a single `three@0.185.1` instance.** It is not available through the JSON plan / map-data pipeline — see [limitations.md](limitations.md).

Related: [scene-integration.md](scene-integration.md) · [quickstart.md](quickstart.md) · [SKILL.md](../SKILL.md)  
Repo authority: `docs/external-reuse.md`, `CLAUDE.md` (Rendering / Environment / Night), product wiring in `app/src/engine/engine.js` (reference only — not a public API).

```api-symbols
src/api/environment.js#setupEnvironment
src/api/environment.js#setupPost
src/api/environment.js#setupWeather
src/api/environment.js#setupNightGlow
src/api/environment.js#createDofController
src/api/environment.js#patchSnowMaterial
src/api/environment.js#snowProfileForObject
src/api/environment.js#RIM_CONTEXT_MASTER
src/api/environment.js#TIME_PRESETS
src/api/environment.js#MSAA_SAMPLES_DESKTOP
src/api/environment.js#MSAA_SAMPLES_COMPACT
src/api/environment.js#resolveMsaaSamples
src/api/environment.js#DEFAULT_DOF_APERTURE
src/api/environment.js#SNOW_AMOUNT_MAX
src/api/environment.js#SNOW_ACCUMULATE_SECONDS
src/api/environment.js#SNOW_MELT_SECONDS
src/api/environment-state.js#SEASON_IDS
src/api/environment-state.js#WEATHER_IDS
src/api/environment-state.js#weatherOkForSeason
src/api/environment-state.js#resolveEnvironmentChange
src/api/environment-state.js#normalizeEnvironmentState
src/api/environment-state.js#ENVIRONMENT_SCENES
src/api/environment-state.js#pickEnvironmentScene
src/api/post-quality.js#createPostQualityState
src/api/particles.js#createRainPrecipitationState
src/api/particles.js#createSnowPrecipitationState
src/api/particles.js#advanceRainPrecipitation
src/api/particles.js#advanceSnowPrecipitation
src/api/particles.js#createPhysicalRainRepresentation
src/api/particles.js#createPhysicalSnowRepresentation
src/api/particles.js#createPetalField
src/api/particles.js#setupMotes
src/api/particle-state.js#createRainPrecipitationState
src/api/particle-state.js#createSnowPrecipitationState
src/api/particle-state.js#RAIN_PARTICLE_COUNT
src/api/particle-state.js#SNOW_PARTICLE_COUNT
src/api/lighting.js#createPhysicalNightlightBatch
```

## Time / season / weather

### Setup ownership and dispose

`setupEnvironment(scene, { sun, hemi, renderer, layout })` owns the landscape layer (terrain, sky, seasons, water, clouds, motes, animals, …) and returns a handle with:

- `setTime(name, opts?)` — time presets: `dawn | day | sunset | night` (`TIME_PRESETS` keys)
- `setSunsetLook(name, opts?)` — sunset look variants
- `setSeason(name, opts?)` — `spring | summer | autumn | winter` (`SEASON_IDS`)
- `setLensScale(k)`, `setSnowAccumulation(v)`, `update(dt)`, `setEnabled(bool)`, **`dispose()`**

Contract (source header on `setupEnvironment`): ordinary visible changes **crossfade via internal tweens**. Pass `{ immediate: true }` only at scene lifecycle boundaries (hidden→reveal) where a snap is intentional. A hard cut on a live frame is a contract violation.

Always call `dispose()` when tearing down; it restores caller-owned scene/light fallback state captured at setup and frees owned GPU resources.

```js
import {
  setupEnvironment,
  TIME_PRESETS,
} from './src/api/environment.js';
// or: from 'cheoma' after file: install of the full façade

const env = setupEnvironment(scene, { sun, hemi, renderer, layout });
env.setTime('sunset');           // crossfade — flagship backlit look
// env.setTime('day', { immediate: true }); // lifecycle snap only
env.update(dt);
// teardown:
env.dispose();
```

Weather particles and roof colliders live on **`setupWeather`** (same façade). Night 한지 glow is **`setupNightGlow`**. The product wires all three together in `app/src/engine/engine.js` — copy that lifecycle if you need the full stack; do not invent a parallel time bus.

### Season ↔ weather compatibility (do not self-correct)

Renderer-free ownership: `src/api/environment-state.js` (also re-exported from `environment.js`).

| Season | Allowed weather |
| --- | --- |
| spring / summer / autumn | `clear`, `rain` |
| winter | `clear`, `snow` |

Use `weatherOkForSeason(weather, season)` and **`resolveEnvironmentChange(current, change)`** so season/weather stay coherent (e.g. requesting snow moves the season home to winter; an incompatible season change clears weather to `clear`). Consumers must not invent their own correction table.

```js
import {
  resolveEnvironmentChange,
  normalizeEnvironmentState,
  SEASON_IDS,
  WEATHER_IDS,
} from './src/api/environment-state.js';

const next = resolveEnvironmentChange(
  { season: 'autumn', weather: 'clear' },
  { weather: 'snow' },
);
// → { season: 'winter', weather: 'snow' }
```

Curated complete scenes (time + optional sunset look + season + weather) are listed in `ENVIRONMENT_SCENES`; `pickEnvironmentScene(rng, current?)` samples them with weights.

### App default vs harness default

- Product app default time is **`sunset`** (backlit) — that is the flagship look.
- URL `?shot=1` keeps **`day`** so comparison harnesses are not orange-tinted.
- A consumer that wants the signature golden-hour frame must set sunset explicitly.

## Flagship look (post composer)

### `setupPost`

```js
import {
  setupPost,
  createDofController,
  DEFAULT_DOF_APERTURE,
  RIM_CONTEXT_MASTER,
  MSAA_SAMPLES_DESKTOP,
  MSAA_SAMPLES_COMPACT,
  resolveMsaaSamples,
} from './src/api/environment.js';
import { createPostQualityState } from './src/api/post-quality.js';

const post = setupPost({ renderer, scene, camera /*, msaaSamples */ });
// post.composer — EffectComposer; call post.setSize / post.update as documented on the handle
```

Default path is **ON**. Escape hatch for A/B: product URL `?post=0` (engine wiring, not an API flag).

### Pass order (default Fresnel rim path)

**Render → Grade/Rim grading → Bokeh → Bloom → Flare → Outline → Output**

- Scene render uses **MSAA** inside the composer (`MSAA_SAMPLES_DESKTOP = 4`, `MSAA_SAMPLES_COMPACT = 2`). The stock WebGLRenderer `antialias` flag does **not** affect the composer path.
- **Output is last and unique** so ACES tone mapping + sRGB conversion happen **once**. Putting Output earlier double-maps HDR effects.
- Optional legacy screen-space rim: product `?rim=pass` (fallback for A/B only). Default rim is **not** that pass.

### Rim is a material Fresnel patch (not a screen pass)

Rim lives on lit materials (Fresnel × sun-backlit × solar gate). It is **optically real**:

1. Requires a true silhouette / sun-facing contribution with the sun **behind** the subject.
2. **Vanishes at noon / front-lit** angles — that is correct, not a bug.
3. First troubleshooting step when “rim is missing”: **check sun azimuth vs camera**, not the bloom knobs.

Product policy masters (`RIM_CONTEXT_MASTER`, source `src/env/rim.js`):

| Context | Master weight |
| --- | ---: |
| focus | `1.0` |
| aerial | `0.75` |

Aerial **does not turn rim off** (material Fresnel has zero extra geometry pass). **DoF amount 0** and **flare off** in aerial/cinematic overview **are** product policy — “DoF does nothing in aerial” is expected, not a broken controller. See `createDofController` amount floor (default 0) and engine `setPostFocus` wiring.

### DoF

`createDofController({ camera, pass, aperture = DEFAULT_DOF_APERTURE })` with `DEFAULT_DOF_APERTURE = 0.3`. Physical CoC scales with aperture × FOV × resolution. Goal: bright compact sources read as **circular aperture images**, not as a soft full-frame fog. Drive amount from focus context; aerial amount stays 0 under product policy.

### Post quality (motion / mobile)

`createPostQualityState(options?)` is pure adaptive state: while the camera moves it lowers Bokeh gather quality and uses a binary composer fill scale (`movingFillScale` default `0.65`), then restores full quality when settled. No per-frame render-target thrash on intermediate scales. Compact devices also reduce bloom internal resolution in the product engine wiring.

## Night light — three separate systems

Do not conflate these when a night frame looks wrong:

| System | Role | Surface |
| --- | --- | --- |
| Props stone lanterns | Village prop lights | props / village adapter (product) |
| 한지 window/door glow | Warm interior through paper openings | `setupNightGlow` + palette `userData.hanjiGlow` |
| 처마 eave lanterns | Single-building eave fixtures | environment / sky path (product) |

**Hierarchy:** an eave lantern must never outshine window glow.

### 한지 glow tagging (critical)

- Palette materials set `userData.hanjiGlow` on the **base** material (`Material.copy` deep-copies userData, so clones inherit it).
- `setupNightGlow({ getBuilding })` **traverses** the building tree and patches every material that carries the tag.
- Patching only the shared `M.door` (or any shared base without traverse) **does nothing** for per-mesh clones.
- Independent of `userData.role`, so per-part colour variety is unaffected.

```js
import { setupNightGlow } from './src/api/environment.js';

const nightGlow = setupNightGlow({ getBuilding: () => buildingRoot });
nightGlow.setTime('night');
nightGlow.setEnabled(true);
nightGlow.update(dt);
// on rebuild:
nightGlow.onBuildingChanged();
nightGlow.dispose();
```

Physical HDR nightlight batch geometry (low-level): `createPhysicalNightlightBatch` from `src/api/lighting.js`. Product selection of which lanterns exist stays outside that factory.

## Snow accumulation (material tint, not a volume)

- Snow on roofs/ground is a **white-tint shader patch** via `patchSnowMaterial(material, amountUniform, { profile })`, not a voxel accumulation mesh.
- Profiles: `surface | tile | thatch | terrain | foliage` (`snowProfileForObject` picks from role/name).
- Timing constants: `SNOW_AMOUNT_MAX = 0.82`, accumulate ~46 s, melt ~16 s (exported on environment façade).
- **InstancedMesh:** the snow vertex path composes `mat3(instanceMatrix)` for world normals. Without instance orientation, up-facing coverage is wrong on instances.

```js
import {
  patchSnowMaterial,
  snowProfileForObject,
  SNOW_AMOUNT_MAX,
} from './src/api/environment.js';

const amount = { value: 0 }; // drive 0..SNOW_AMOUNT_MAX over time
root.traverse((obj) => {
  if (!obj.isMesh && !obj.isInstancedMesh) return;
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  for (const mat of mats) {
    if (!mat) continue;
    patchSnowMaterial(mat, amount, { profile: snowProfileForObject(obj, mat) });
  }
});
```

## Physical particles

### State vs representation

| Layer | Module | Role |
| --- | --- | --- |
| Pure state | `src/api/particle-state.js` | Seeded positions/phases; workers & Node OK |
| Three representation | `src/api/particles.js` | Physical meshes/materials consuming those arrays |

Precipitation counts (exports): `RAIN_PARTICLE_COUNT = 2600`, `SNOW_PARTICLE_COUNT = 3600`, seed `WEATHER_PARTICLE_SEED`.

```js
import {
  createRainPrecipitationState,
  createSnowPrecipitationState,
  advanceRainPrecipitation,
  advanceSnowPrecipitation,
} from './src/api/particle-state.js';
import {
  createPhysicalRainRepresentation,
  createPhysicalSnowRepresentation,
  createPetalField,
  setupMotes,
} from './src/api/particles.js';

const rainState = createRainPrecipitationState();
// each frame (options object — not positional args):
advanceRainPrecipitation(rainState, {
  dt,
  wind: { dirX: 0, dirZ: 0, speed: 0 },
  centerX: 0,
  centerZ: 0,
  roofColliders: [],
  collide: true,
});
// representation builders take the same arrays without copying
const rainMesh = createPhysicalRainRepresentation(rainState);
```

### Authored world sizes (centimetres)

Source of truth for gates/comments (`tools/check-season-particle-size.mjs`, `weather-physical-geometry.js`):

| Kind | World size |
| --- | --- |
| Snow flakes | **1.3–3.2 cm** |
| Spring petals | **2–5.4 cm** (gate min band includes 1.3 cm floor on aSize path) |
| Autumn leaves | **≥ ~6 cm**; silhouette raise allows long-axis up to **~29 cm** |

Author sizes in **world units**, not screen pixels. Seasonal petals/leaves: `createPetalField`; dust motes: `setupMotes`.

## Consumer performance traps

1. **PointLight add/remove recompiles the whole lit scene** (three program cache keys include light counts). Keep a fixed pool resident and park unused lights at `intensity = 0`. `visible = false` drops them from the count and brings recompile churn back.
2. **Only `material.dispose()` frees a program.** Detaching a mesh does not. Overlay materials that come and go should keep one anchor material alive per kind.
3. **One three instance.** Pin `three@0.185.1`, alias + dedupe. A second copy breaks `instanceof` and prototype patches — see [limitations.md](limitations.md).
4. Shader warm for large villages: warm **only the incoming subtree** (`compileSubtreeAsync` from `src/api/rendering.js`) — covered in [scene-integration.md](scene-integration.md).

## What this skill does not claim

- No portable “look package” for non-three engines ([limitations.md](limitations.md)).
- No new generation features here — packaging and skill docs only describe existing output.
- Do not document private engine methods as if they were `src/api/` exports. When product policy lives only in `app/src/engine/engine.js`, say so and point there.
