# Limitations — what cheoma does not do

Honesty here is part of the product. Agents must not invent workarounds that claim these capabilities exist. Source table: repository **`docs/packaging-plan.md` §5** (packaging plan, 2026-08-08).

Related: [quickstart.md](quickstart.md) · [map-data.md](map-data.md) · [SKILL.md](../SKILL.md)

## Consumer limits (must state)

| Limit | Reality |
| --- | --- |
| **No interior entry** | `walk-solids` treats house body polygons as solid. Only through-passages such as the giwa middle-gate passage pass. There is **no interior layer**. |
| **No tile streaming** | The world is a single basin clamped by `siteR`. The edge is finished with `worldedge` mist. There is **no open-world tiling** concept. |
| **No navmesh** | Autostroll follows road polylines only. A navmesh / walkable-region export is **not shipped** (packaging-plan P3 listed it as optional future work). |
| **No gameplay hooks** | No spawn points, trigger volumes, or interaction tags. `userData.role` tagging remains available for post-classification. |
| **Single three.js instance required** | Two copies of three silently break `instanceof` and prototype patches (e.g. accelerated raycast). Consumers must pin **`three@0.185.1`** once (peer dependency) with alias + `dedupe`. |
| **No tree-shaking** | Importing only a building still pulls palette and environment helpers; the graph is wide. `docs/external-reuse.md` states that "minimal" is **not** byte-minimal. |

## Packaging / distribution limits

| Limit | Reality |
| --- | --- |
| **Registry install is new** | `npm install cheoma` works since **0.1.0 (2026-08-08)**; git clone and `npm install /path/to/cheoma` (file: dependency) remain valid. From a registry install the CLI is `npx cheoma …`; `node bin/cheoma.mjs …` is the checkout form. |
| **Look pipeline is product-coupled** | Golden-hour look lives in `src/env/post.js` (composer: bloom + rim + DoF). three.js consumers can take that pipeline; other engines must reimplement atmosphere. Packaging does not promise a portable "look package". |
| **No new generation features in packaging** | Packaging (P0–P2, and P3 serialization) does not add China/Japan architecture, open-world expansion, or in-app recording (`docs/project-status.md` / packaging-plan §4). |

## CLI surface (current)

Five subcommands (verified via `node bin/cheoma.mjs --help`):

| Command | Role (from help text) |
| --- | --- |
| `plan` | Generate a village plan JSON |
| `inspect` | Summarize a plan JSON |
| `validate` | Determinism + domain validation of a plan JSON |
| `map-data` | Write colliders/metadata/terrain JSON from a plan |
| `glb` | Bake a standalone building GLB (**textures omitted in Node**) |

API equivalents still exist under `src/api/map-data.js` and `src/api/building.js`. `glb` is a Node bake path with textures omitted — use in-app export for textured GLB (`glb --help` notes).

## What still works

Despite the limits above, agents **can** reliably:

1. Generate deterministic plan JSON (`cheoma plan` / `planVillage`)
2. Inspect and validate that JSON
3. Export colliders, metadata, and terrain grids (`cheoma map-data` or map-data API)
4. Bake a textureless standalone building GLB (`cheoma glb`)
5. Build standalone buildings in three.js with `disposeBuilding` ownership
