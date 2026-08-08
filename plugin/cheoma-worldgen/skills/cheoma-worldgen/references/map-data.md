# Map data — colliders, metadata, terrain grid

Pure JSON export for external engines (no three / DOM). Implementation: `src/export/map-data.js`, public façade: `src/api/map-data.js`. Gate: `node tools/check-map-data.mjs`. CLI: `node bin/cheoma.mjs map-data <plan.json> --out-dir <dir>`.

Related: [plan-schema.md](plan-schema.md) · [limitations.md](limitations.md) · [SKILL.md](../SKILL.md)

## Coordinate convention

Every map-data payload includes or assumes:

| Rule | Value |
| --- | --- |
| South | **`+z`** |
| Units | **meters** |
| East | `+x` |
| Up | `+y` (heights) |

`buildMapColliders` sets `convention: { south: '+z', units: 'meters' }` on the output object.

## Shortest file pipeline (CLI)

No Node script required. From a plan JSON on disk:

```bash
node bin/cheoma.mjs map-data plan.json --out-dir out/
```

Writes `colliders.json`, `metadata.json`, and `terrain.json`. The CLI **re-generates a live plan from stored `opts`/`seed`** so terrain sampling works (see below). Options from `map-data --help`: `--terrain-step <m>` (default 4), `--polygonize-citywall`.

## Live plan vs file plan (API)

| Builder | File plan (`JSON.parse`) | Live `planVillage(...)` |
| --- | --- | --- |
| `buildMapColliders` | OK | OK |
| `buildMapMetadata` | OK | OK |
| `sampleTerrainHeightGrid` | **Throws** (`site.heightAt is not a function`) | OK |

**If the pipeline is file-based and you need a terrain grid:** use `cheoma map-data` (re-plans internally from `opts`) **or** call `planVillage` and pass the live result to `sampleTerrainHeightGrid`. Do not expect `JSON.parse` + `sampleTerrainHeightGrid` to work.

## API

Import paths: run the script from the **cheoma repo root**, or `npm install /path/to/cheoma` (file: dependency) in the consumer and use package exports (`cheoma/plan`, etc.). Relative `./src/api/...` only resolves at the repo root.

```api-symbols
src/api/village-plan.js#planVillage
src/api/map-data.js#buildMapColliders
src/api/map-data.js#buildMapMetadata
src/api/map-data.js#sampleTerrainHeightGrid
src/api/map-data.js#polygonizeCityWallSolid
```

```js
import { planVillage } from './src/api/village-plan.js';
import {
  buildMapColliders,
  buildMapMetadata,
  sampleTerrainHeightGrid,
  polygonizeCityWallSolid,
} from './src/api/map-data.js';

const plan = planVillage({ seed: 7, siteR: 120 }); // live — keeps site.heightAt

// Walk solids (reuses cinematic walk-solids)
const colliders = buildMapColliders(plan, {
  // heightAt: optional height sampler
  // polygonizeCityWall: false by default; true → citywall → poly strips
  // cityWallStep: arc-length sample step in meters (default 3)
});

// Flattened buildings / roads / paddies / features
const metadata = buildMapMetadata(plan);

// Regular height grid over fixed-content radius (default step 4 m) — live plan only
const terrain = sampleTerrainHeightGrid(plan, { step: 4 });
```

All three builders return **JSON-safe** plain objects (`schemaVersion: 1`) and throw if NaN / non-JSON values appear.

## Colliders — three solid types

Source: `src/cinematic/walk-solids.js` via `buildMapColliders`. Types observed in product plans:

### 1. `obb` — oriented bounding box

Axis-aligned in local parcel frame, stored with center + half-extents + rotation:

| Field | Meaning |
| --- | --- |
| `type` | `"obb"` |
| `cx`, `cz` | Center (m) |
| `hw`, `hd` | Half-width / half-depth (m) |
| `cos`, `sin` | Rotation of local +x into world XZ |
| `kind` | e.g. `wall`, `hero`, `footprint`, `palace`, `temple` |
| `parcelId` | Optional parcel id |
| `top` | Optional top Y (m) |

### 2. `poly` — horizontal polygon

| Field | Meaning |
| --- | --- |
| `type` | `"poly"` |
| `pts` | `[{ x, z }, …]` ring (m) |
| `kind` | e.g. `house`, `wall`, `citygate` |
| `parcelId` / `part` / … | Optional metadata |

House body footprints and many wall segments use `poly`.

### 3. `citywall` — analytic city-wall annulus

Present on large Hanyang-scale plans with a city wall:

| Field | Meaning |
| --- | --- |
| `type` | `"citywall"` |
| `spec` | Contour radii / gates (same contract as walk-solids) |
| `half` | Half-thickness (m) |
| `kind` | `"citywall"` |

Optional: `buildMapColliders(plan, { polygonizeCityWall: true })` expands each `citywall` solid into many `poly` strips via `polygonizeCityWallSolid` (gate wedges stay open). Gate: hanyang fixture in `tools/check-map-data.mjs`.

### Collider document shape

```json
{
  "schemaVersion": 1,
  "convention": { "south": "+z", "units": "meters" },
  "solids": [ /* obb | poly | citywall */ ]
}
```

### Measured solid counts

| Fixture | Solids | Breakdown |
| --- | ---: | --- |
| village-band siteR 120 (seed 7, `check-map-data`) | 66 | — |
| **town anchor** (`scale: 'town'` / siteR 240, seed 42) | **368** | type: **obb 305** / **poly 63**; kind: **wall 302** · **house 63** · **hero 3** (walls ≈ **82%**) |
| hanyang siteR 450 (seed 7, `check-map-data`) | 1671 | includes `citywall` |

## Metadata

`buildMapMetadata(plan)` flattens existing plan fields — it does not invent placement:

| Key | Contents |
| --- | --- |
| `schemaVersion` | `1` |
| `seed`, `scale`, `warnings` | From plan |
| `site` | Subset of basin numbers + bounds / entrance |
| `buildings[]` | `parcelId`, `kind`, `hero`, `center`, `houseBodies` (polygons), optional `gate` |
| `roads[]` | `pts`, `width`, optional `id` / `level` / `junctionIds` |
| `paddies[]` | `poly`, optional `y` / `tone` |
| `features` | cityWall / temple / palace / pavilion presence + counts |

## Terrain height grid

`sampleTerrainHeightGrid(plan, { step = 4 })`:

| Field | Meaning |
| --- | --- |
| `origin` | `{ x, z }` — lower corner of axis-aligned box covering fixed-content radius |
| `step` | Cell size (m), minimum 0.5 |
| `nx`, `nz` | Grid dimensions |
| `heights` | Row-major `nz` rows × `nx` cols, Y in meters from `terrainMeshHeightAt` |

Heights sample the **mesh surface** the product uses, not a separate simplified field.

**Requires live plan** — see [Live plan vs file plan](#live-plan-vs-file-plan-api). File pipeline: `cheoma map-data`.

## Limitations for game use

- Colliders block house interiors (see [limitations.md](limitations.md)).
- No navmesh export.
- City wall as `citywall` type needs engine support for the analytic test, or set `polygonizeCityWall: true` for poly strips only.
