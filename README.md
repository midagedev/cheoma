# 처마 · cheoma

[![npm](https://img.shields.io/npm/v/cheoma)](https://www.npmjs.com/package/cheoma)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**A procedural Joseon-era Korean village, grown from a seed — in the browser, and now in your project.**

Parametric hanok — Korean traditional architecture — and whole settlements, generated in three.js: palaces, mountain temples, tiled and thatched houses, and the terrain, walls, paddies and forests around them.

**Live demo → [cheoma.midagedev.com](https://cheoma.midagedev.com)**

![cheoma — Hanyang at sunset](https://raw.githubusercontent.com/midagedev/cheoma/main/docs/media/hero.jpg)

| | |
| --- | --- |
| ![close-up hanok courtyard](https://raw.githubusercontent.com/midagedev/cheoma/main/docs/media/grid-1-house.jpg) | ![parcel cluster with yard life](https://raw.githubusercontent.com/midagedev/cheoma/main/docs/media/grid-2-yard.jpg) |
| ![hillside village](https://raw.githubusercontent.com/midagedev/cheoma/main/docs/media/grid-3-hillside.jpg) | ![palace precinct and sijeon](https://raw.githubusercontent.com/midagedev/cheoma/main/docs/media/grid-4-palace.jpg) |

<sub>A hanok courtyard up close · a parcel cluster with its yard life · a hillside village · the palace precinct and the market street. From one house to a walled capital — every frame is captured straight from the app's product path.</sub>

## Features

- **Parametric hanok** — the 칸 (*kan*) bay system, bracket sets and the hip-and-gable roof curve are all parameters: roof pitch, eave depth, window lattice and 단청 polychrome are editable live.
- **Composed villages** — 배산임수 terrain (mountain behind, water in front), parcels with mud walls and alleys, terraced paddies, a creek, and a mountain temple compound.
- **A continuous scale slider** — one continuum from a lone farmstead through hamlet, village and town to 한양, the walled capital, with its multi-court palace, market arcades and four great gates.
- **Multi-court palace** — axial courts stacked behind shared corridor walls, following the Gyeongbokgung layout.
- **Gathered, terraced mountain temples** — halls packed with eaves nearly touching and ridge directions crossing, stepping down over rubble retaining terraces, with a two-storey principal hall crowning the largest compounds.
- **Time, season, weather** — golden-hour rim light, snow and rain, lantern glow and moonlight at night. Every transition crossfades; a visible pop is treated as a bug.
- **A focus zoom continuum** — aerial to eye level without a mode switch, with per-parcel editing, an assembly animation, and close-up ambience (chickens, kitchen smoke, grass moving in the wind).
- **A one-take drone tour** — approach, a low pass through the valley, a glide over the rooftops, an orbit around the landmark, a ridge climb, and the return, in a single unbroken flight.
- **First-person walking** — WASD, arrow keys and pointer-lock look (a virtual joystick on mobile) to walk the alleys and yards yourself.
- **Reroll wave** — regenerating with a new seed hands terrain, roads, parcels and forest over to the next generation in a single frame, hidden under an ink-fog veil.
- **glTF/GLB export** — the scene exports with instancing preserved through `EXT_mesh_gpu_instancing`.
- **Shareable scene URLs** — seed, scale, time, season and camera all ride in the URL, so one link reproduces the exact frame.

## Use it in your project

cheoma is not only a demo — the generator ships as an **npm package, a CLI, and an agent skill**.

```bash
npm install cheoma        # three@0.185.1 arrives as an exact-pinned peer dependency
```

| Entry point | What you get | Needs three |
| --- | --- | --- |
| `cheoma/plan` | Deterministic village **plan as JSON** — parcels, roads, paddies, features. Runs in Node, workers, servers. | no |
| `cheoma/building` | `buildBuilding` / `disposeBuilding` — a standalone hanok for your own scene. | yes |
| `cheoma` | The full runtime façade the app itself consumes — village runtime, environment, cinematic, export. | yes |

```js
import { planVillage } from 'cheoma/plan';

const plan = planVillage({ seed: 7, scale: 'village' });
// ~50–100 KB of readable JSON. Same seed + options → the same bytes, every time.
```

The primary product is the **JSON map contract** ([`docs/plan-schema.md`](docs/plan-schema.md) — every field, `+z` = south, meters, gated against the real generator output). A coding agent can read a village plan and place gameplay without ever seeing the 3D scene.

The CLI covers the whole pipeline:

```bash
npx cheoma plan --seed 42 --scale town --out plan.json
npx cheoma inspect plan.json                    # summary instead of 180 KB in your context
npx cheoma validate plan.json                   # determinism re-check + domain validators
npx cheoma map-data plan.json --out-dir map/    # colliders.json / metadata.json / terrain.json
npx cheoma glb --preset giwa --out house.glb    # node GLB bake (textures omitted; the in-app export keeps them)
```

`map-data` is the game-engine surface: walk **colliders** (wall segments, house body polygons, and the walled capital as an analytic band with a polygonized fallback for engines that want plain polygons), building/gate **metadata** for spawns and quests, and a regular terrain **height grid**.

For coding agents there is a Claude Code plugin — this repository is its own marketplace:

```
/plugin marketplace add midagedev/cheoma      →  skill: cheoma-worldgen
```

The skill walks an agent through plan → inspect → consume → self-validate, plus wiring the time-of-day / weather / rim-light / DoF look into a three.js scene. Honest limits (no interiors, no tile streaming, no navmesh, no gameplay hooks — those are yours to add) are stated up front in the skill and in [`docs/external-reuse.md`](docs/external-reuse.md).

## Technical highlights

The parts most likely to interest anyone building a large procedural scene in three.js.

- **Deterministic generation with a worker offload.** Village generation runs inside a window where a seeded RNG replaces the global `Math.random` and is then restored. The dominant cost — forest placement, 14k–40k trees — is computed in a Web Worker that returns transferable `Float32Array` matrices; the main thread only assembles the `InstancedMesh`. A hash gate asserts that the worker path and the synchronous path produce **byte-identical** scenes → [`docs/verification.md`](docs/verification.md)
- **Colour variety at zero draw-call cost.** Per-house member colour rides `instanceColor`, not new materials. Material variants multiply program families and are expensive, so all variety is an instance attribute → [`docs/house-diversity.md`](docs/house-diversity.md)
- **The rim light is a material Fresnel patch, not a screen-space pass.** A Fresnel term is injected via `onBeforeCompile` into role-tagged materials, so the outline appears only when the sun is genuinely behind the subject and vanishes at noon (`src/env/rim.js`) → [`AGENTS.md`](AGENTS.md)
- **One EffectComposer chain.** Render → Grade/Rim → Bokeh → Bloom → Flare → Outline → Output. Optical defocus comes **before** sensor bloom (small HDR sources form the aperture image first, then bloom adds its halo), and Output stays last so ACES tone mapping and sRGB conversion happen exactly once, after the linear-HDR effects (`src/env/post.js`; `?post=0` disables it).
- **Performance is judged by program counts, not wall clock.** Transition hitches turned out to be shader *link* stalls, not CPU. Headless ANGLE serialises linking, so absolute frame times are not evidence — program-count deltas and determinism hashes are. Adding or removing a single PointLight recompiles every lit material, so lights live in a resident fixed pool → [`docs/verification.md`](docs/verification.md), [`docs/perf-campaign.md`](docs/perf-campaign.md)

The visual grammar (painterly stylisation unified by light and atmosphere) and the historical baseline are documented in [`docs/look-grammar.md`](docs/look-grammar.md) and [`docs/architectural-authenticity.md`](docs/architectural-authenticity.md).

## Development

three.js is pinned to **0.185.1**. The core is framework-agnostic ES modules (`src/`); the app is a Svelte 5 + Vite SPA (`app/`) that consumes the core only through `src/api/`.

```bash
cd app
npm install
npm run dev     # vite dev server (default :5173)
npm run build   # → app/dist
```

Repository contract gates run from the root:

```bash
npm run check       # BLOCKING core invariants only: architecture boundary + plan goldens + runner self-test (~20s)
npm run check:deep  # the full pure suite (~100 feature gates) — opt-in
npm run check:pr    # changed-file router: core + affected feature/browser/worker gates
npm run check:app   # isolated full-app browser smoke
npm run check:worker
npm run check:all
npm run check:full  # merge gate: all groups + DoF/LOD app flows + a production build
```

There is no unit-test framework, linter or typechecker. Verification is **pure-node contracts plus Playwright visual harnesses**: each `tools/*.mjs` spins up its own static server, drives headless Chromium, and writes screenshots and measurements. The discipline of this repository is to assert the *cause* in pure node and use the browser once to confirm the *effect*.

```bash
npm install                   # once, at the repo root (Playwright is a root devDependency)
node tools/shoot-<feature>.mjs
```

The root install also makes the core runnable in plain node (that is what the package build rides on): `npm run check:node-core` asserts a deterministic plan and a full `buildBuilding` with an injected canvas stub, no browser involved.

For everyday iteration, run `npm run check:pr -- --dry-run` to see the plan, then `npm run check:pr`. Browser gates prefer a locally installed Chrome (and log the real WebGL renderer), falling back to the bundled Chromium; pin one with `CHEOMA_BROWSER=chromium`.

## Documentation

- [`AGENTS.md`](AGENTS.md) — code boundaries, architecture, determinism and performance invariants, rules for contributors and coding agents
- [`docs/README.md`](docs/README.md) — the document map and status labels (contract / active work / research / snapshot / completed record)
- [`docs/project-status.md`](docs/project-status.md) — project direction and the decisions that must hold
- [`docs/architecture-refactor.md`](docs/architecture-refactor.md) — the structural split and the reuse/boundary contract
- [`docs/plan-schema.md`](docs/plan-schema.md) — the JSON map contract: every plan field, coordinate convention, determinism
- [`docs/external-reuse.md`](docs/external-reuse.md) — consuming the generator outside the app: narrow façades, single three, dispose ownership
- [`docs/verification.md`](docs/verification.md) — harness map and verification pitfalls
- [`docs/look-grammar.md`](docs/look-grammar.md) — the visual grammar the look is judged against
- [`docs/architectural-authenticity.md`](docs/architectural-authenticity.md) — the authenticity audit and the fact → implementation mapping
- [`docs/temple-generator.md`](docs/temple-generator.md) — the mountain temple contract: gathered layout, terraces, the two-storey hall

## Credits & License

Sources for the measured drawings, literature, papers and photographs behind the historical and architectural decisions — together with a "what was built from this" mapping — are in [`docs/credits.md`](docs/credits.md), and the same list is surfaced in the app's References screen. cheoma is a stylised reinterpretation, not a scholarly reconstruction of any specific monument.

The background music was generated outside the repository with Suno ([`docs/suno-prompts.md`](docs/suno-prompts.md)). Third-party reference photography used during development (`refs/`) is not redistributable and is therefore not included here.

MIT — [`LICENSE`](LICENSE)

---

<sub><b>한국어</b> — 처마(cheoma)는 조선 전통건축(궁궐·사찰·기와집·초가)과 마을을 파라메트릭으로 생성하는 three.js 앱이자 <b>npm 패키지·CLI·에이전트 스킬</b>입니다(<code>npm install cheoma</code>). 종가 한 채에서 성곽 도성 한양까지 규모가 하나의 연속체로 이어지고, 시간·계절·날씨와 focus 줌·드론 원테이크 투어·1인칭 도보를 지원합니다. 결정론 plan JSON·콜라이더·지형 그리드를 반출해 다른 게임 프로젝트에서 맵으로 쓸 수 있습니다. 고증 근거와 구현 매핑은 <a href="docs/architectural-authenticity.md"><code>docs/architectural-authenticity.md</code></a>, 문서 지도는 <a href="docs/README.md"><code>docs/README.md</code></a>에 있습니다.</sub>
