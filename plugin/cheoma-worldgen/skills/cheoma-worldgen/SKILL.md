---
name: cheoma-worldgen
description: Korean traditional village/hanok procedural map generation (Joseon-era plan JSON, colliders, terrain). Use when the user needs a hanok village map, Korean traditional settlement layout, deterministic village plan from a seed, map colliders for a game engine, help consuming cheoma plan/map-data APIs, or wiring cheoma's time-of-day/weather/rim-light/DoF look into a three.js scene.
---

# cheoma-worldgen

**cheoma** (처마) is a procedural Joseon-era Korean architecture and village generator. From a single seed it produces hanok parcels (giwa/choga), mountain temples (산사), paddies, roads, and — at capital scale — the walled city of 한양 with palace precincts. Generation is **deterministic**: the same seed and options always yield the same plan bytes. Live demo: https://cheoma.midagedev.com

The primary product for agents is the **JSON map contract**, not a baked mesh. A village plan is ~100 KB of readable structure (parcels, roads, features); agents can inspect and act on it without seeing a 3D scene.

## When to load this skill

- User asks for a Korean traditional village / hanok / 한양 / temple-compound map
- Need deterministic world layout from a seed for a game or tool
- Need walk colliders, building metadata, or terrain height grid from that plan
- Integrating cheoma into another three.js project or exporting map data to another engine

## Agent workflow

### ① Obtain the repo and install

cheoma is published on the npm registry (since 0.1.0, 2026-08-08). In a consumer project:

```bash
npm install cheoma        # three@0.185.1 arrives as an exact-pinned peer
npx cheoma --help
```

For hacking on the generator itself (or running repo gates), use a git checkout instead:

```bash
git clone https://github.com/midagedev/cheoma.git cheoma
cd cheoma
npm install
```

If you are already inside the cheoma worktree, skip clone and run `npm install` at the repo root when `node_modules` is missing.

Verify the CLI:

```bash
node bin/cheoma.mjs --help
```

Expected (excerpt from live `--help`):

```
Usage: cheoma <command> [options]

Commands:
  plan       Generate a village plan JSON
  inspect    Summarize a plan JSON
  validate   Determinism + domain validation of a plan JSON
  map-data   Write colliders/metadata/terrain JSON from a plan
  glb        Bake a standalone building GLB (textures omitted in Node)

Run `cheoma <command> --help` for command options.
```

### ② Generate a plan JSON

```bash
node bin/cheoma.mjs plan --seed 7 --scale village --out plan.json
```

stderr one-liner (stdout is pure JSON when not using `--out`):

```
plan scale=village siteR=180 parcels=36 warnings=0
```

Named scales: `hamlet | village | town | capital | hanyang`. Use either `--scale` or `--site-r <m>`, never both. Other useful flags: `--pretty` (indent JSON), `--seed <n|string>`.

Named-scale anchor radii (`SCALE_ANCHORS` in `src/village/site.js`):

| Scale | siteR (m) |
| --- | ---: |
| hamlet | 105 |
| village | 180 |
| town | 240 |
| capital | 280 |
| hanyang | 500 |

Town-anchor measured example (seed 42): siteR **240**, parcels **66**, plan file **182920** B, colliders **368** solids. See [references/quickstart.md](references/quickstart.md).

Programmatic (three-free Node). Run the script from the **cheoma repo root**, or install the checkout into the consumer with `npm install /path/to/cheoma` (file: dependency) and use the `cheoma/plan` specifier — relative `./src/api/...` paths only resolve at the repo root.

```js
import { planVillage } from './src/api/village-plan.js';
// or: import { planVillage } from 'cheoma/plan';

// Fixed basin radius (measurement band):
const planByR = planVillage({ seed: 7, siteR: 120 });

// Named scale anchor — same bytes as CLI `--scale town` for the same seed:
const planByScale = planVillage({ seed: 42, scale: 'town' });
// JSON.stringify(plan) is the file form — function fields on site are dropped
```

### ③ Inspect the summary

Do not dump an entire capital plan (hundreds of KB) into the context. Summarize first:

```bash
node bin/cheoma.mjs inspect plan.json
```

Example output (seed 7, `--scale village`):

```
seed: 7
scale/tier: village
siteR: 180 m
parcels: 36 (choga:28, giwa:8)
roads: 11
paddies: 1
features: pavilion, bridges, props, guardianTrees
warnings (0):
  (none)
json bytes: 100687
```

### ④ Consume what you need

| Consumer need | Surface |
| --- | --- |
| Layout / placement / agent reasoning | Plan JSON (`parcels`, `roads`, `features`, …) — full field map in [references/plan-schema.md](references/plan-schema.md) and repo `docs/plan-schema.md` |
| **Shortest file pipeline** (colliders + metadata + terrain, no Node script) | `node bin/cheoma.mjs map-data plan.json --out-dir out/` — writes `colliders.json`, `metadata.json`, `terrain.json` |
| Walk collision / bounds (API) | `buildMapColliders(plan)` — [references/map-data.md](references/map-data.md) |
| Spawn / building list / roads flat (API) | `buildMapMetadata(plan)` |
| Height field (API) | `sampleTerrainHeightGrid(plan, { step })` — **requires a live plan** (see below) |
| Standalone building mesh file | `node bin/cheoma.mjs glb --preset <name> --out building.glb` (textures omitted in Node; see `glb --help`) |
| Rendered house mesh (three.js) | package export `./building` — see below |
| Time/season/weather + flagship look (rim/DoF/bloom) | [references/environment-and-look.md](references/environment-and-look.md) — three.js only |
| Full village runtime, cinematic, audio in your scene | [references/scene-integration.md](references/scene-integration.md) — three.js only; product wiring pointer `app/src/engine/engine.js` |

**Terrain grid and file plans:** `sampleTerrainHeightGrid` needs a **live** `planVillage` result (`site.heightAt` is a function). A plan loaded with `JSON.parse` from disk throws `site.heightAt is not a function`. Colliders and metadata accept file plans. For a file pipeline that needs terrain, use **`cheoma map-data`** (it re-plans from stored `opts`/`seed` internally) or call `planVillage` yourself and pass the live object.

Map-data API example (live plan; three-free). Same import-path rule as §②: repo-root relative, or `cheoma/plan` + map-data via package path after `npm install /path/to/cheoma`.

```js
import { planVillage } from './src/api/village-plan.js';
import {
  buildMapColliders,
  buildMapMetadata,
  sampleTerrainHeightGrid,
} from './src/api/map-data.js';

const plan = planVillage({ seed: 7, siteR: 120 });
const colliders = buildMapColliders(plan);
const metadata = buildMapMetadata(plan);
const terrain = sampleTerrainHeightGrid(plan, { step: 4 }); // live plan only
```

File one-liner (terrain included):

```bash
node bin/cheoma.mjs map-data plan.json --out-dir out/
```

### ⑤ Self-validate

```bash
node bin/cheoma.mjs validate plan.json
```

Example success:

```
PASS  determinism (planVillage(opts) re-emit byte match)
PASS  validateDangsanPlan(plan.dangsan)
PASS  validateRoadsideDrainagePlan(plan.drainage)
validate: 3 PASS
```

Exits `0` only when every check PASSes; any FAIL exits `1`.

## Determinism contract

Same generative inputs (`seed` + normalized options such as `siteR` / `scale`) → **same JSON bytes** from `planVillage` / `cheoma plan`. The repository gate `tools/check-plan-contract.mjs` (part of `npm run check`) locks this. Agents may re-run with the same seed to converge; do not inject wall-clock or `Math.random` into the generation path.

CLI `--out` files append a trailing newline (1 byte). Measured town seed 42: file **182920** B vs `JSON.stringify` string **182919** B. When byte-comparing a file to stdout or a `planVillage` string, **trim** (or strip the final `\n`) first.

## Coordinate contract

| Rule | Value |
| --- | --- |
| Horizontal | `+x` east, **`+z` south** |
| Vertical | `+y` up (meters), when present |
| Units | **meters**; yaw in radians |

## Limitations (honest)

Do not promise these. Details and rationale: [references/limitations.md](references/limitations.md). Source: repo `docs/packaging-plan.md` §5.

| Limit | Reality |
| --- | --- |
| No interior entry | Walk solids treat house bodies as solid; only through-passages (e.g. middle gate) pass. No interior layer. |
| No tile streaming | Single basin world clamped by `siteR`; edge is worldedge mist. Not an open-world tile set. |
| No navmesh | Autostroll follows road polylines only. Navmesh is not shipped. |
| No gameplay hooks | No spawn points, trigger volumes, or interaction tags. `userData.role` remains for post-classification. |
| Single three instance | two three.js copies break `instanceof` and prototype patches. Pin **0.185.1**, one install, alias + dedupe. |
| No tree-shaking | Importing a building still pulls a wide palette/helper graph. "Minimal" is not byte-minimal. |

Install paths: registry `npm install cheoma` (0.1.0+, verified: plan/validate/glb all run from a registry install via `npx cheoma`), git clone, or `npm install /path/to/cheoma` as a file: dependency.

## three.js consumers

Package `exports` (repo root `package.json`):

| Export | Entry | Role |
| --- | --- | --- |
| `cheoma` / `.` | `src/api/index.js` | Full public façade (three required) |
| `cheoma/plan` | `src/api/village-plan.js` | Pure plan, no three |
| `cheoma/building` | `src/api/building.js` | Standalone building build/dispose |

Scripts that use relative `./src/api/...` imports must run from the **repo root**. From another project: `npm install /path/to/cheoma` (file: dependency) and import `cheoma/building` / `cheoma/plan`.

```js
import { buildBuilding, disposeBuilding, PRESETS } from './src/api/building.js';
// or: import { buildBuilding, disposeBuilding, PRESETS } from 'cheoma/building';

const root = buildBuilding({ ...PRESETS.giwa });
scene.add(root);
// teardown:
scene.remove(root);
disposeBuilding(root); // first call returns true; second returns false
```

Ownership: `disposeBuilding(root)` releases geometries and derived materials/textures owned by that build. Caller-owned shared `P.mats` palette is **not** disposed. Always dispose the **original root** returned by `buildBuilding`, not a wrapper child. Peer dependency: `three@0.185.1` only once in the consumer app.

Broader reuse rules: repo `docs/external-reuse.md`.

## Verification commands

Run from the cheoma repo root after install:

```bash
# Pure Node: plan determinism + buildBuilding + dispose
npm run check:node-core

# Map-data colliders / metadata / terrain (village + hanyang fixtures)
node tools/check-map-data.mjs

# Plan file you just wrote
node bin/cheoma.mjs validate plan.json
```

Commit/CI core suite (architecture + plan goldens + runner self-test):

```bash
npm run check
```

## References in this skill

| File | Contents |
| --- | --- |
| [references/quickstart.md](references/quickstart.md) | Install → plan → inspect → validate loop with measured output |
| [references/plan-schema.md](references/plan-schema.md) | Top-level plan keys + pointer to full repo schema |
| [references/map-data.md](references/map-data.md) | Colliders, metadata, terrain grid, solid types |
| [references/environment-and-look.md](references/environment-and-look.md) | Time/season/weather, post look (rim/DoF/bloom), night glow, snow, particles |
| [references/scene-integration.md](references/scene-integration.md) | Full façade in your three.js scene, cinematic, audio, engine pointer |
| [references/limitations.md](references/limitations.md) | Full limitations table |

## Repo docs (authoritative, do not fork)

- `docs/plan-schema.md` — full plan field inventory (gated by `check:plan-schema`)
- `docs/packaging-plan.md` — packaging stages and §5 limits
- `docs/external-reuse.md` — public API and dispose ownership
- `docs/project-status.md` — current product direction
