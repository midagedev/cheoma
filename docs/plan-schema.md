# Village plan JSON schema reference

> - **상태**: 계약
> - **기준일**: 2026-08-08
> - **소스**: `src/village/plan.js` `planVillage()` via `src/api/village-plan.js`
> - **게이트**: `npm run check:plan-schema` (`tools/check-plan-schema-doc.mjs`)
> - **CLI**: `cheoma plan|inspect|validate` (`bin/cheoma.mjs`)

This document is the field reference for the **JSON map contract** produced by
`planVillage({ seed, siteR | scale, ... })`. It is hand-maintained markdown plus a
machine-readable path inventory — not a generated JSON Schema
(`docs/packaging-plan.md` §7.3 / P1).

Meanings below are grounded in source comments and measured values. Fields that
are only structural containers without a local prose comment are marked
**미문서화** with a source pointer; the schema gate enforces **path existence**,
not the truth of prose.

## Coordinate and unit contract

| Rule | Value |
| --- | --- |
| Horizontal axes | `x` east (+), `z` south (+) — **`+z` = south** |
| Vertical | `y` up (meters), when present |
| Units | meters (m), radians for yaw, unitless 0..1 for many ratios |
| Determinism | Same generative inputs → same JSON bytes (`JSON.stringify` of the plan). Gate: `tools/check-plan-contract.mjs` |

Live `planVillage()` returns `site` functions (`heightAt`, `hillAt`, …). They are
**not** part of the JSON contract — `JSON.stringify` drops them. Consumers of the
CLI / file form only see the data keys listed below.

## Scale sizes (measured)

`planVillage({ seed: 7, siteR })` byte sizes and counts (JSON after stringify),
same fixtures as `docs/packaging-plan.md` §1.2:

| Label | `siteR` (m) | JSON size | Parcels | Roads |
| --- | ---: | ---: | ---: | ---: |
| hamlet-band | 60 | ~22 KB | 5 | 6 |
| village-band | 120 | ~46 KB | 15 | 7 |
| town-band | 250 | ~172 KB | 63 | 24 |
| capital-band | 400 | ~881 KB | 206 | 49 |

Named `--scale` anchors (`SCALE_ANCHORS` in `src/village/site.js`) use different
`siteR` values (hamlet 105, village 180, town 240, capital 280, hanyang 500).
The table above is the packaging measurement band, not the named-anchor radii.

## Machine-readable path inventory

The fenced block below is the **authoritative key-path set** for
`tools/check-plan-schema-doc.mjs`.

**Rule:** one path per line inside a `plan-paths` fence. Paths use:

- top-level key: `seed`
- object child: `site.siteR`
- array element fields: `roads[].id`, `parcels[].kind`, `paddies[].poly`

The checker measures the same path set from real `planVillage` runs at
siteR ∈ {60, 120, 250, 400} plus every named `SCALE_ANCHORS` radius
(hamlet 105 / village 180 / town 240 / capital 280 / hanyang 500, seed 7)
and asserts equality both ways. The anchor sweep exists because tier-only
keys leak otherwise — `features.govCore` appears at the capital anchor
(280) but at none of the four fixed bands (2026-08-08 measured).

```plan-paths
bounds
dangsan
drainage
features
features.bridges
features.cityWall
features.ferry
features.gateQuarter
features.govCore
features.guardianTrees
features.palace
features.pavilion
features.props
features.riverPort
features.sijeon
features.temple
nodes
opts
paddies
paddies[].poly
paddies[].tone
paddies[].y
parcels
parcels[]._idx
parcels[].access
parcels[].aux
parcels[].auxRequested
parcels[].auxiliary
parcels[].center
parcels[].clothesline
parcels[].courtyardTree
parcels[].frontDir
parcels[].gardenLevel
parcels[].hero
parcels[].heroBudget
parcels[].heroStyle
parcels[].houseFitFactor
parcels[].houseFitSource
parcels[].houseLocal
parcels[].id
parcels[].jangdok
parcels[].kind
parcels[].lantern
parcels[].magistracySlot
parcels[].placement
parcels[].plotD
parcels[].plotW
parcels[].poly
parcels[].rank
parcels[].riverbank
parcels[].roofRank
parcels[].roofTone
parcels[].satellite
parcels[].seed
parcels[].settlementScale01
parcels[].shape
parcels[].solarAccess
parcels[].stoneTone
parcels[].structureScale
parcels[].sx
parcels[].sy
parcels[].sz
parcels[].thatchAge
parcels[].toneIdx
parcels[].urbanEave
parcels[].variant
parcels[].vegBed
parcels[].wallHeightK
parcels[].wallTone
parcels[].wallType
parcels[].wealth
parcels[].woodTone
parcels[].yardStack
parcels[].yaw
roads
roads[].id
roads[].junctionIds
roads[].level
roads[].pts
roads[].wallApproach
roads[].width
scale
seed
site
site.Hmax
site.R
site.ansanZ
site.bounds
site.bowlR
site.center
site.edge
site.entrance
site.mountainZ
site.nearR
site.paddyRegion
site.relief
site.ridgeR
site.scale
site.seed
site.siteR
site.stream
site.streamHalf
site.streamValleyFlatHalf
site.streamValleyHalf
site.streamWaterHalf
site.streamZ
site.terrainR
stats
warnings
```

## Top-level keys

| Path | Type | Meaning |
| --- | --- | --- |
| `opts` | object | Normalized generative options echoed for re-runs (`scale`, `siteR`, `seed`, `tuning`, …). Source: `src/village/plan.js` return `opts: norm`. |
| `seed` | number | Plan seed (uint32). |
| `scale` | string | Tier name from `tierForR(siteR)` (hamlet / village / town / capital / hanyang). |
| `warnings` | string[] | Human-readable planning warnings (may be empty). |
| `site` | object | Basin / terrain summary (JSON data only; functions stripped). |
| `roads` | object[] | Road polylines with stable ids and junction metadata. |
| `nodes` | object | Road graph anchors (entrance, center, spine, junctions, …). |
| `parcels` | object[] | House lots (giwa / choga / reserved cores). |
| `paddies` | object[] | Rice-paddy polygons south of the stream. |
| `drainage` | object | Roadside drainage plan (`schema`, `frame`, `runs`, `crossings`). |
| `dangsan` | object | Optional dangsan cultural landscape plan (`schema`, `sites`, `reason`). |
| `features` | object | Landmarks and structures (pavilion, cityWall, temple, …). |
| `bounds` | object | Axis-aligned world bounds of roads+parcel centers (`minX/maxX/minZ/maxZ/w/d`, meters). |
| `stats` | object | Aggregate counts (houses, giwa, choga, roads, paddies, drainageRuns, …). |

## `site`

Basin geometry for 배산임수 placement. Source: `src/village/site.js` `makeSite`.

| Path | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `site.scale` | string | — | Tier label. |
| `site.siteR` | number | m | Basin radius (primary scale scalar). |
| `site.seed` | number | — | Site seed. |
| `site.R` | number | m | Alias of basin radius used internally. |
| `site.terrainR` | number | m | Terrain mesh / forest near-band radius. |
| `site.Hmax` | number | m | Ridge height scalar (주산). |
| `site.edge` | object | m | World-edge contour data for mist / clamp. |
| `site.center` | `{x,z}` | m | 명당 / settlement center (slightly north of geometric origin). |
| `site.entrance` | `{x,z}` | m | South entrance / 동구 approach point (+z). |
| `site.mountainZ` | number | m | 주산 ridge z. |
| `site.streamZ` | number | m | Nominal stream axis z. |
| `site.ansanZ` | number | m | 안산 (south hill) z. |
| `site.bowlR` | number | m | Bowl / buildable basin radius. |
| `site.ridgeR` | number | m | Ridge crest radius. |
| `site.nearR` | number | m | Forest near-LOD radius. |
| `site.streamHalf` | number | m | Bank / channel half-width reservation. |
| `site.streamWaterHalf` | number | m | Visible ordinary-water half-width. |
| `site.streamValleyHalf` | number | m | Valley half-width. |
| `site.streamValleyFlatHalf` | number | m | Flat valley floor half-width. |
| `site.stream` | object | m | Polyline stream record (`pts`, `kind`, `cross`, `flow`, …). |
| `site.relief` | object | — | Settlement relief params (`localWavelength`, `terraceStep`, `terraceStrength`). |
| `site.paddyRegion` | object | m | Paddy belt reservation geometry. |
| `site.bounds` | object | m | Site AABB. |

## `roads[]`

| Path | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `roads[].id` | string | — | Stable road id (e.g. `daero-0`, `soro-000`). |
| `roads[].level` | string | — | Road class (`daero` / `jungno` / `soro` / …). |
| `roads[].width` | number | m | Corridor width. |
| `roads[].pts` | `{x,z}[]` | m | Centerline polyline (south-positive z). |
| `roads[].junctionIds` | string[] | — | Bidirectional junction ids (`attachRoadJunctions`). |
| `roads[].wallApproach` | object \| undefined | — | City-wall gate approach metadata when present (`gate`, `side`). |

## `parcels[]`

| Path | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `parcels[].id` | string | — | Stable parcel id. |
| `parcels[]._idx` | number | — | Insertion / plan index. |
| `parcels[].kind` | string | — | `giwa` \| `choga` (and reserved cores as giwa). |
| `parcels[].rank` | number | — | Wealth / rank ordinal used by placement. |
| `parcels[].seed` | number | — | Parcel-local seed. |
| `parcels[].center` | `{x,z}` | m | Parcel center in world xz. |
| `parcels[].frontDir` | `{x,z}` | — | Unit front direction (south-oriented frame; +z south). |
| `parcels[].plotW` | number | m | Plot width. |
| `parcels[].plotD` | number | m | Plot depth. |
| `parcels[].poly` | `{x,z}[]` | m | Parcel polygon (world). |
| `parcels[].yaw` | number | rad | House yaw. |
| `parcels[].sx` `sy` `sz` | number | — | Non-uniform fit scales from house fit. |
| `parcels[].shape` | string \| number | — | Plan shape token (ㅡ/ㄱ/ㄷ family). |
| `parcels[].variant` | number | — | Fitted house variation index. |
| `parcels[].placement` | string | — | Placement class (frontage / infill / reserved / …). |
| `parcels[].hero` | boolean | — | Hero / core parcel flag. |
| `parcels[].heroStyle` | string | — | `hanok` \| `palace` \| … when hero. |
| `parcels[].roofRank` | string | — | Roof ornament rank (`giwa` / `magistracy` / `palace` / …). |
| `parcels[].solarAccess` | object | m | Winter-sun opening (`localStart`, `localEnd`, `halfWidth`). |
| `parcels[].access` | object \| null | m | Gate access contract (`gateEdge`, `gateT`, `gatePoint`, `roadId`, …). |
| `parcels[].wallType` | string | — | Courtyard wall style id. |
| `parcels[].wallHeightK` | number | — | Wall height scale factor. |
| `parcels[].wealth` | number | — | Wealth axis for materials / yard. |
| `parcels[].toneIdx` | number | — | Palette instanceColor tone index. |
| `parcels[].stoneTone` `woodTone` `wallTone` `roofTone` | number | — | Per-material tone knobs. |
| `parcels[].thatchAge` | number | — | Thatch weathering (choga). |
| `parcels[].houseLocal` | `{x,z}` | m | House origin in parcel-local frame. |
| `parcels[].houseFitFactor` | number | — | Uniform fit scale result. |
| `parcels[].houseFitSource` | string | — | Which fit path accepted the house. |
| `parcels[].structureScale` | number | — | Structure scale continuum. |
| `parcels[].aux` | object \| null | — | Legacy aux request blob (may be null). |
| `parcels[].auxRequested` | boolean | — | Whether an auxiliary was requested. |
| `parcels[].auxiliary` | object \| null | m | Detached storehouse record when placed. |
| `parcels[].jangdok` | object \| null | — | Jar platform plan. |
| `parcels[].yardStack` | object \| null | — | Yard stack plan. |
| `parcels[].clothesline` | object \| null | — | Clothesline plan. |
| `parcels[].vegBed` | object \| null | — | Vegetable bed plan. |
| `parcels[].gardenLevel` | number | — | Garden intensity. |
| `parcels[].courtyardTree` | object \| null | — | Courtyard tree reservation. |
| `parcels[].lantern` | object \| null | — | Stone lantern plan. |
| `parcels[].satellite` | boolean \| undefined | — | Satellite-hamlet parcel (capital+). |
| `parcels[].riverbank` | boolean \| undefined | — | River-port bank parcel when river archetype applies. |
| `parcels[].settlementScale01` | number \| undefined | — | Continuous settlement scale at placement. |
| `parcels[].urbanEave` | number \| undefined | — | Urban eave scale (capital / hanyang density). |

## `paddies[]`

| Path | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `paddies[].poly` | `{x,z}[]` | m | Field polygon. |
| `paddies[].y` | number | m | Slab elevation. |
| `paddies[].tone` | number | — | Field tone index. |

## `features`

Keys are always present for the base set (`pavilion`, `bridges`, `ferry`,
`riverPort`, `props`, `temple`, `palace`); capital tiers also attach
`cityWall`, `sijeon`, `gateQuarter`, `guardianTrees` (guardians also appear at
smaller scales when planned).

| Path | Type | Meaning |
| --- | --- | --- |
| `features.pavilion` | object \| null | Public pavilion footprint / center / radius. |
| `features.bridges` | array | Stream crossings. |
| `features.ferry` | object \| null | Ferry landing when river archetype is active. |
| `features.riverPort` | object \| null | South-bank port ward plan (capital river). |
| `features.props` | array | Village public props (jangseung, wells, …). |
| `features.temple` | object \| null | Temple compound reservation when `includeTemple`. |
| `features.palace` | object \| null | Palace precinct when capital-tier + palace. |
| `features.cityWall` | object \| undefined | City wall contour + gates (walled tiers). |
| `features.sijeon` | array \| undefined | Market-row façades (hanyang / forced). |
| `features.guardianTrees` | array \| undefined | Guardian canopy reservations. |
| `features.gateQuarter` | object \| undefined | Gate-side thatched quarters plan (walled capital). |
| `features.govCore` | object \| undefined | Magistracy core (객사) anchor at capital tier: `{x, z, frontDir, roofRank:'magistracy'}`. The core parcel itself rides `parcels[]` with `hero` + `roofRank:'magistracy'`; satellite magistracy slots carry `parcels[].magistracySlot` and count against the hero cap via `parcels[].heroBudget`. |

## `drainage` / `dangsan` / `nodes` / `stats` / `opts`

These are top-level objects validated or echoed as wholes:

- **`drainage`** — `validateRoadsideDrainagePlan` input (`schema`, `frame`, `runs[]`, `crossings[]`). Empty runs at rural scales. Source: `src/village/drainage-plan.js`.
- **`dangsan`** — `validateDangsanPlan` input (`schema`, `sites[]`, `reason`). Often `sites: []` with a skip reason. Source: `src/village/dangsan-plan.js`.
- **`nodes`** — road graph anchors; shape varies by tier (`entrance`, `center`, `crossing`, `spine`, `junctions`, optional `palaceFront`). 미문서화(세부 필드): `src/village/roads.js` / road topology.
- **`stats`** — derived counts for harnesses (`houses`, `giwa`, `choga`, `roads`, `paddies`, `drainageRuns`, `parcelDebug`, …). Source: `src/village/plan.js` return `stats`.
- **`opts`** — full normalized options for regeneration. Prefer `cheoma validate` / `inputOptsFromPlan` rather than re-feeding `char01` unless `charOverride` was true.

## Optional fields not in the default seed-7 inventory

When product context enables an ㅁ-shaped banga (`opts.mjaHouse`), a parcel may
carry `parcels[].mjaHouse` (full mja plan object). That path is **not** in the
default four-band inventory above; `cheoma validate` still runs
`validateMjaHousePlan` when the field is present.

## Related

- Public façade: `src/api/village-plan.js`
- Packaging plan: [`packaging-plan.md`](packaging-plan.md)
- External reuse: [`external-reuse.md`](external-reuse.md)
- CLI: `bin/cheoma.mjs`
