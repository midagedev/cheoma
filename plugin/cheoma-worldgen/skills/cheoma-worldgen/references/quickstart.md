# Quickstart — plan → inspect → validate

All commands assume the **cheoma repository root** after `npm install`. The CLI is `node bin/cheoma.mjs` (package `bin.cheoma` → `./bin/cheoma.mjs`). There is no npm-registry install path yet.

Related: [plan-schema.md](plan-schema.md) · [map-data.md](map-data.md) · [limitations.md](limitations.md) · skill [SKILL.md](../SKILL.md)

## 1. Install

```bash
git clone https://github.com/midagedev/cheoma.git cheoma
cd cheoma
npm install
```

`https://github.com/midagedev/cheoma.git` is the git remote for this source tree (MIT, Copyright 2026 midagedev). Do **not** use `npm install cheoma` from the public registry. From another project you may install this checkout as a file dependency: `npm install /path/to/cheoma`.

Confirm:

```bash
node bin/cheoma.mjs --help
```

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

## 2. Generate a plan

```bash
node bin/cheoma.mjs plan --seed 7 --scale village --out plan.json
```

Measured stderr (2026-08-08, this repo):

```
plan scale=village siteR=180 parcels=36 warnings=0
```

File size for that run: **100687** bytes (includes trailing newline; see [SKILL.md](../SKILL.md) determinism note).

### Useful flags (`cheoma plan --help`)

| Flag | Meaning (from CLI help) |
| --- | --- |
| `--seed <n>` | Plan seed (number or string) |
| `--scale <name>` | Named scale: `hamlet\|village\|town\|capital\|hanyang` |
| `--site-r <m>` | Basin radius in meters (mutually exclusive with `--scale`) |
| `--out <path>` | Write JSON to path (default: stdout) |
| `--pretty` | Indent JSON (2 spaces) |

Notes from help: stdout is JSON only (pipe-safe); the one-line summary goes to stderr. `--scale` and `--site-r` cannot be combined.

### Pure Node (no CLI)

Run from the **repo root**, or install via `npm install /path/to/cheoma` and import `cheoma/plan`. Relative `./src/api/...` only works at the cheoma root.

```js
import { planVillage } from './src/api/village-plan.js';
// or: import { planVillage } from 'cheoma/plan';

const planByR = planVillage({ seed: 7, siteR: 120 });
// packaging-plan measured band: village-band siteR 120 ≈ 46 KB / 15 parcels

// Named scale — byte-identical to `cheoma plan --seed 42 --scale town` (same seed):
const planByScale = planVillage({ seed: 42, scale: 'town' });
```

## 3. Inspect

```bash
node bin/cheoma.mjs inspect plan.json
```

Measured output for seed 7 / `--scale village`:

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
opts: {"scale":"village","siteR":180,"scale01":0.25,"includePalace":false,"includeTemple":false,"seed":7,...}
```

Use inspect before reading large capital/hanyang plans into an agent context.

## 4. Validate

```bash
node bin/cheoma.mjs validate plan.json
```

Measured success:

```
PASS  determinism (planVillage(opts) re-emit byte match)
PASS  validateDangsanPlan(plan.dangsan)
PASS  validateRoadsideDrainagePlan(plan.drainage)
validate: 3 PASS
```

What validate does (from `cheoma validate --help`):

1. **Determinism** — re-run `planVillage` from stored `opts`/`seed` and compare bytes
2. **Domain** — `validateDangsanPlan`, `validateRoadsideDrainagePlan`, and `validateMjaHousePlan` when `parcels[].mjaHouse` is present

Exit `0` on all PASS; exit `1` on any FAIL.

## 5. Map-data file pipeline (optional)

One line — colliders + metadata + terrain (CLI re-plans for live height sampling):

```bash
node bin/cheoma.mjs map-data plan.json --out-dir out/
```

See [map-data.md](map-data.md) and `cheoma map-data --help`.

## 6. Optional gates (repo contracts)

```bash
npm run check:node-core
# → NODE-CORE: PASS  (plan determinism + buildBuilding + disposeBuilding)

node tools/check-map-data.mjs
# → check-map-data: PASS  (village + hanyang colliders/metadata/terrain)
```

## Named scale anchors vs measurement bands

Named `--scale` / `planVillage({ scale })` anchors use product radii from `SCALE_ANCHORS` (`src/village/site.js`):

| Scale | siteR (m) | Notes (measured examples) |
| --- | ---: | --- |
| hamlet | 105 | — |
| village | 180 | seed 7: 36 parcels, plan file 100687 B |
| town | 240 | seed 42: 66 parcels, plan file **182920** B, colliders **368** solids |
| capital | 280 | — |
| hanyang | 500 | — |

Packaging measurement bands in `docs/packaging-plan.md` §1.2 use fixed `siteR` (village-band **120** → ~46 KB / 15 parcels). Both are valid; do not mix them when comparing sizes.
