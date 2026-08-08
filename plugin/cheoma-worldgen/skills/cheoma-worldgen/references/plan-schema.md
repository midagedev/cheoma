# Plan schema (summary)

**Authoritative full field reference:** repository `docs/plan-schema.md`  
(gated by `npm run check:plan-schema` / `tools/check-plan-schema-doc.mjs`).  
This skill file is a **pointer + top-level index only** — do not treat it as a second full schema.

Related: [quickstart.md](quickstart.md) · [map-data.md](map-data.md) · [SKILL.md](../SKILL.md)

## Contract

| Rule | Value |
| --- | --- |
| Source | `planVillage()` via `src/api/village-plan.js` |
| Coordinates | `+x` east, **`+z` south**, `+y` up |
| Units | meters; yaw in radians |
| Determinism | Same generative inputs → same `JSON.stringify` bytes |
| Live vs file | Live plan may attach function fields on `site` (`heightAt`, …); **JSON form drops them** |

## Top-level keys

| Key | Type | Meaning |
| --- | --- | --- |
| `opts` | object | Normalized generative options echoed for re-runs (`scale`, `siteR`, `seed`, `tuning`, …) |
| `seed` | number | Plan seed (uint32) |
| `scale` | string | Tier name: hamlet / village / town / capital / hanyang |
| `warnings` | string[] | Planning warnings (may be empty) |
| `site` | object | Basin / terrain summary (JSON data only) |
| `roads` | object[] | Road polylines with stable ids and junction metadata |
| `nodes` | object | Road graph anchors (entrance, center, spine, junctions, …) |
| `parcels` | object[] | House lots (giwa / choga / reserved cores) |
| `paddies` | object[] | Rice-paddy polygons |
| `drainage` | object | Roadside drainage plan |
| `dangsan` | object | Optional dangsan cultural landscape plan |
| `features` | object | Landmarks (pavilion, cityWall, temple, palace, …) |
| `bounds` | object | Axis-aligned world bounds (meters) |
| `stats` | object | Aggregate counts |

For nested paths (`parcels[].access`, `roads[].pts`, `features.cityWall`, …) and the machine-readable path inventory, open **`docs/plan-schema.md`** in the cheoma repo.

## Size reference (measured bands)

From `docs/packaging-plan.md` §1.2 / `docs/plan-schema.md` — `planVillage({ seed: 7, siteR })`:

| Label | siteR (m) | ~JSON | Parcels |
| --- | ---: | ---: | ---: |
| hamlet-band | 60 | 22 KB | 5 |
| village-band | 120 | 46 KB | 15 |
| town-band | 250 | 172 KB | 63 |
| capital-band | 400 | 881 KB | 206 |

Named CLI `--scale` anchors use different radii (e.g. village **180** m). See [quickstart.md](quickstart.md).

## CLI

```bash
node bin/cheoma.mjs plan --seed 7 --scale village --out plan.json
node bin/cheoma.mjs inspect plan.json
node bin/cheoma.mjs validate plan.json
```
