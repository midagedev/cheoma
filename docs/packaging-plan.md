# 모듈화·툴화 계획 (외부 게임 프로젝트 대상)

> - **상태**: P0–P3 구현 완료 (2026-08-08, 같은 날 실행) — 잔여: npm publish·마켓플레이스 등록(사용자 결정), 네비메시(보류), textured Node GLB(프런티어)
> - **기준일**: 2026-08-08
> - **근거**: 아래 §1의 실측. 사용자 결정 2026-08-08 — three.js 커뮤니티 공개 목표 달성 후 방향 전환.
> - **선행 문서**: [`external-reuse.md`](external-reuse.md)(현재 외부 소비 계약), [`architecture-refactor.md`](architecture-refactor.md)(§공개 재사용 API), [`project-status.md`](project-status.md)(방향)

## 0-bis. 실행 결과 (2026-08-08)

| 단계 | 커밋 | 산출물 | 게이트 |
| --- | --- | --- | --- |
| P0 | `faaf69b` | 루트 three@0.185.1(dev+peer) + exports map(`.`/`./plan`/`./building`), `tools/lib/node-canvas-stub.mjs`, GLB 프로브 | `check:node-core` (FAST) |
| P3a | `9901216` | `src/api/map-data.js` — 콜라이더(walk-solids 통과)·메타데이터·지형 그리드, citywall 폴리곤화 폴백 | `check:map-data` (FAST, P3b에서 등록) |
| P1 | `a61a11d` | `bin/cheoma.mjs` CLI `plan`/`inspect`/`validate`, `docs/plan-schema.md`(109 키 경로 대조) | `check:cli`·`check:plan-schema` (FAST) |
| P3b | `ea3cb61` | CLI `map-data`(opts 재수화)·`glb`(텍스처 스트립 Node bake, GLB 매직·바이트 결정론), `src/export/strip-textures.js` | `check:cli-export` (FAST) |
| P2 | `6b46392` | `plugin/cheoma-worldgen/` 스킬+플러그인. **신선 에이전트 왕복 테스트 통과**(스킬만으로 plan→map-data→validate 완주, metadata JSON만으로 필지 배치 판단 성립), 결함 7건 반영 | `check:docs` |
| P2b | `4d64623` | 스킬 확장(사용자 지시): 환경·플래그십 룩·야간 3계·입자·시네마틱·오디오 런타임 가이드 2편. 실측이 문서를 두 번 이김(부감 rim 0.75 — DoF/flare만 정책 0, 낙엽 ~29cm) | `check:skill-refs` (65 심볼 Node 실증, FAST) |

실행 중 계측기 결함 2건을 리드가 FAIL-first로 잡아 수정했다: ① 폴리곤화 대조 표본이 비원형 성곽 contour(196–324m)를 meanRadius ±11m 밴드로 뽑아 0% 불일치가 허공 측정이었던 것(각도별 실제 contour 반경 중심으로 수정 → 실측 0.150%, 전부 경계 밴드 내) ② 스키마 대조가 고정 4밴드만 돌아 capital 앵커(280) 전용 키 3개가 새던 것(`SCALE_ANCHORS` 전수 스윕 추가).

GLB 텍스처의 Node 반출은 프로브로 기각 확인(`GLTFExporter.processImage`가 DOM `document` 요구) — Node 경로는 텍스처 생략을 `--help`에 명시하고, 텍스처 GLB는 기존 인앱 반출이 담당한다. napi-canvas 심 경로(toBlob·FileReader 이중 폴리필)는 프런티어로만 기록한다.

## 0. 무엇을 만드는가

cheoma의 생성 엔진을 **다른 사람이 게임을 만들 때 가져다 쓸 수 있는 형태**로 포장한다. 소비자는 두 부류다.

1. **three.js 웹 게임 개발자** — 코어를 직접 import해 런타임에 마을을 생성한다.
2. **엔진(Unity·Unreal·Godot) 게임 개발자** — 맵 데이터와 지오메트리를 파일로 받아 자기 엔진에서 쓴다.

그리고 두 부류 모두 **코딩 에이전트와 함께 작업한다**는 것을 설계 전제로 둔다. 이는 장식이 아니라 이 계획의 중심축이며, 근거는 §2에 있다.

## 1. 실측 (2026-08-08, 이 계획의 사실 기반)

계획을 세우기 전에 측정한 값이다. 수치를 갱신하지 않고 계획을 고치면 안 된다.

### 1.1 계층 경계는 이미 그어져 있다

| 항목 | 실측 |
| --- | --- |
| `src/` 전체 | 326 파일, 86,219줄 |
| 그중 bare `three`를 import | 107 파일 |
| `src/api/` façade | 47 파일 |
| 그중 **Node에서 `three` 없이 로드됨** | **26 파일** (plan 계층) |
| 그중 three를 요구 | 21 파일 (geometry·runtime 계층) |
| `app/`이 `src/`를 import하는 지점 | 32곳 — **전부 `src/api/*` 경유, 깊은 import 0건** |

`app/`의 깊은 import가 0건인 것은 `check-architecture.mjs`(커밋 블로킹)가 지켜온 결과다. **패키지 경계를 새로 설계할 필요가 없다** — 26/21 분할선이 그대로 두 패키지의 경계다.

Node에서 `three` 없이 로드되는 26개 façade:

```
auxiliary-building-plan  ceiling-plan  clip-stage  creek-bank-plan  dangsan-plan
door-motion  drainage-plan  environment-state  gate-quarter-plan  glossary-plan
mja-house-plan  moon-optics  mud-wall-plan  opening-detail  particle-state
post-quality  rendering  residential-openings  shadow-framing  sijeon-plan
surface-material-plan  temple-plan  threshold-life  village-options  village-plan
yard-life-plan
```

### 1.2 plan 산출물의 크기 — 에이전트가 읽을 수 있다

`planVillage({ seed: 7, siteR })`을 Node에서 직접 호출한 실측이다. `src/api/village-plan.js`는 155개를 export한다.

| 규모 | `siteR` | plan JSON | 필지 | 도로 |
| --- | --- | --- | --- | --- |
| hamlet | 60 | 22 KB | 5 | 6 |
| village | 120 | **46 KB** | 15 | 7 |
| town | 250 | 172 KB | 63 | 24 |
| capital | 400 | 881 KB | 206 | 49 |

최상위 키: `opts, seed, scale, warnings, site, roads, nodes, parcels, paddies, drainage, dangsan, features, …`

### 1.3 plan 계층은 이미 결정론이 잠겨 있다

`npm run check`(커밋·CI 블로킹)의 `CORE_CHECKS`는 셋뿐이고 그중 하나가 plan 골든이다.

```
./check-architecture.mjs      계층 경계
./check-plan-contract.mjs     plan 골든 (tools/plan-contract.json)
./check-verification-runner.mjs
```

즉 외부 소비자에게 "같은 시드는 같은 맵"을 약속할 근거가 이미 게이트로 존재한다. 패키징이 이 약속을 새로 만드는 것이 아니라 **노출**하는 것이다.

### 1.4 도메인별 검증 함수가 이미 공개돼 있다

```
validateDangsanPlan  validateGateQuarterPlan  validateMjaHousePlan
validateMudWallSurfacePlan  validateRoadsideDrainagePlan  validateYardLifeRecords
```

이 함수들은 원래 내부 계약 검사용이지만, 외부 소비자(특히 에이전트)의 **자기검증 루프**에 그대로 쓰인다. §2 참조.

### 1.5 발견된 결함 — three 계층은 지금 Node에서 돌지 않는다

`src/`는 bare `three`를 import하지만 **레포 루트에 `three`가 설치돼 있지 않다**(`app/node_modules`에만 있다). 재현:

```
$ node -e "import('/…/src/api/building.js')"
three 로드 OK 185
GLTFExporter 로드 OK
FAIL: Cannot find package 'three' imported from /…/src/builder/index.js
```

`app/vite.config.js`의 alias(`three` → `app/node_modules`, `dedupe: ['three']`)가 app 빌드 컨텍스트 안에서만 해석해 주고 있었다. 따라서 `AGENTS.md`/`CLAUDE.md`가 말하는 "framework-agnostic 코어"는 **plan 계층에서만 실제로 성립**하고, geometry 계층은 조용히 vite에 묶여 있다.

이것은 아키텍처 결함이 아니라 **의존성 선언 누락**이며, 고치는 비용이 작다. 다만 이걸 풀지 않으면 패키지·CLI·스킬이 모두 불가능하므로 P0이다.

### 1.6 GLB 반출은 절반만 브라우저에 묶여 있다

`src/export/gltf.js`에서 브라우저 API(`Blob`, `URL.createObjectURL`, `document.createElement`)를 쓰는 곳은 **`triggerDownload` 헬퍼 하나뿐**이다. `exportGLB` 본체는 `three/addons/exporters/GLTFExporter.js`를 쓴다.

남는 제약은 canvas 절차 텍스처다: `CanvasTexture`의 `image`가 `HTMLCanvasElement`이고 `processImage`가 `drawImage`로 처리한다. Node에는 canvas가 없으므로 **텍스처를 포함한 GLB를 순수 Node에서 굽는 것은 아직 확인되지 않았다**. 헤드리스 브라우저 또는 canvas polyfill이 필요하다. 이 미확인이 P3을 뒤로 미루는 이유다.

### 1.7 이미 있는 자산

- `LICENSE` — MIT. 외부 사용에 법적 장애가 없다.
- [`external-reuse.md`](external-reuse.md) — 447줄, 현재 계약. 좁은 façade·단일 three·borrowed resource·dispose 소유권을 이미 서술한다.
- `examples/api-building/` — 실행되는 최소 예제(고정 카메라·두 광원·지면 위 기와집 한 채).
- `npm run check:api-reuse` — 그 예제를 실제로 부팅해 검증하는 게이트.
- `src/cinematic/walk-solids.js` — 1인칭 충돌 솔리드. 담장 런 세그먼트, 집 몸통 폴리곤(처마 제외), 성벽을 OBB 800개 대신 극좌표 환대 하나로(점 질의 O(1)). mesh-bvh 없이 순수 계획 기하.
- `terrainMeshHeightAt`, `sampleRoadSurface`, 도로 그래프(`attachRoadJunctions`), LOD·임포스터 명세.

## 2. 설계 중심축 — 산출물은 GLB가 아니라 JSON 맵 계약이다

절차생성 패키지의 통상적 산출물은 "메시"다. 이 프로젝트는 그렇게 두지 않는다. 근거:

1. **에이전트는 3D 씬을 볼 수 없지만 46KB JSON은 읽는다**(§1.2). 게임 개발자의 에이전트가 `planVillage()`를 호출하고, 필지 목록을 읽고, "이 필지는 개천에 접했으니 물레방아를 넣자"를 스스로 판단할 수 있다. 메시만 주면 이 능력이 전부 사라진다.
2. **결정론이 이미 게이트로 잠겨 있다**(§1.3). 에이전트가 반복 실행하며 수렴할 수 있다.
3. **검증 함수가 이미 있다**(§1.4). 에이전트 작업의 완료 조건을 "이 명령이 통과한다"로 줄 수 있다 — 에이전트 위임에서 가장 중요한 요건이다.
4. plan 계층은 three·DOM·전역 RNG가 없어(§1.1) 서버·워커·CI에서 돈다. 소비자의 실행 환경을 가정하지 않는다.

따라서 계층 순서는 **plan(JSON) → 반출(콜라이더·메타데이터) → 메시(GLB)**이고, GLB는 최상위 산출물이 아니라 렌더 백엔드 하나다.

## 3. 단계 계획

각 단계는 **독립적으로 배포 가능한 가치**를 갖는다. 뒤 단계가 취소돼도 앞 단계는 쓸모가 남는다.

### P0 — 코어를 Node에서 돌게 만든다

**문제**: §1.5.

**작업**
- 루트 `package.json`에 `three@0.185.1`을 `devDependencies`로 추가하고, 배포 시점에는 `peerDependencies`로 선언한다(소비자가 자기 three를 하나만 갖게 — 두 인스턴스는 `instanceof`와 프로토타입 패치를 조용히 깬다).
- 루트 `package.json`에 `exports` map을 둔다. 최소 두 갈래:
  - `"./plan"` → 순수 계층 진입점(three 없음)
  - `"./three"` → geometry·runtime 진입점(three peer 필요)
- `app/vite.config.js`의 alias·dedupe와 정합성을 유지한다. app이 계속 하나의 three를 보는지 확인한다.

**완료 조건 (검증 명령과 기대 출력)**
- `node -e "import('./src/api/building.js').then(m => { const r = m.buildBuilding({...m.PRESETS.giwa}); … })"` 가 메시 수·삼각형 수를 출력한다(현재는 `Cannot find package 'three'`로 실패).
- `npm run check` 3개 코어 게이트 전부 통과.
- `npm run check:api-reuse` 통과(기존 예제가 깨지지 않았음).
- `cd app && npm run build` 통과.

**리스크**: 낮음. 의존성 선언과 exports map뿐이고 소스 로직을 건드리지 않는다. 다만 `exports` map은 기존 깊은 import 경로(호환 shim 포함)를 막을 수 있으므로, app이 쓰는 32개 경로가 모두 살아 있는지 확인한다.

### P1 — `plan` 패키지와 기계 판독 계약

**작업**
- plan 산출물의 **JSON 스키마를 문서화**한다. 에이전트가 필드를 추측하지 않게 하는 것이 목적이다. 최소한 `site / roads / nodes / parcels / paddies / drainage / dangsan / features`의 필드·단위·좌표 규약(**`+z` = 남**)을 명시한다.
- CLI:
  - `cheoma plan --seed 42 --scale village --out plan.json` — 순수, three 불필요, 빠름
  - `cheoma inspect plan.json` — 사람과 에이전트가 읽는 요약(규모·필지 수·도로 수·경고). capital 881KB를 통째로 읽히지 않게 하는 장치다.
  - `cheoma validate plan.json` — §1.4의 기존 `validate*`를 재사용
- `warnings` 필드가 이미 plan에 있으므로 CLI가 이를 노출한다.

**완료 조건**: 위 세 명령이 hamlet·village·town·capital 네 규모에서 통과하고, 같은 시드가 같은 바이트를 낸다(`check-plan-contract.mjs`와 같은 기준).

**리스크**: 낮음. 새 생성 로직이 없다. 스키마 문서가 코드와 어긋나는 것이 유일한 위험이므로, 스키마를 손으로 쓰지 말고 plan에서 생성하거나 검사로 대조한다.

### P2 — 스킬 `cheoma-worldgen`

다른 사람의 **에이전트가 진입하는 문**이다. 이 프로젝트에서 P1보다 더 차별적인 산출물일 수 있다.

**형식** (로컬 설치본에서 확인한 구조)
- `SKILL.md` — frontmatter는 `name` + `description` 두 필드. description이 로드 판단 근거이므로 "한국 전통 마을·한옥 맵이 필요할 때"가 드러나야 한다.
- `references/` — 하위 문서. 이 레포 `docs/`가 이미 도메인별로 자기완결적이라 재료가 있다. 필요한 것: plan 스키마, 좌표 규약, 시드 결정론, 콜라이더 계약, GLB 옵션, **못 하는 것 목록**(§5).
- 배포는 `.claude-plugin/plugin.json` + 마켓플레이스 `marketplace.json`. 공식 마켓플레이스는 `source: git-subdir`(url·path·ref·sha)를 지원하므로 이 레포의 서브디렉터리를 그대로 가리킬 수 있다 — 별 레포로 쪼갤 필요가 없다.

**완료 조건**: 이 레포를 모르는 세션에서 스킬을 로드해 "한옥 마을 맵을 만들어라"를 수행하고, 그 세션이 plan을 만들고 검증 명령까지 통과시킨다. 이 왕복이 실패하면 스킬 문서가 부족한 것이다.

**리스크**: 중간. 스킬 품질은 "에이전트가 실제로 성공하는가"로만 판정되고, 그 판정에 실사용 왕복이 필요하다.

### P3 — 게임맵 반출

여기서부터 신규 구현 비중이 커진다. **P1·P2가 끝난 뒤에 착수한다.**

- **콜라이더 JSON** — `walk-solids.js`를 그대로 재사용한다(§1.7). 담장 런·집 몸통 폴리곤·성벽 환대가 이미 계산되므로 직렬화가 주된 일이다. 가장 저렴하고 가장 즉시 유용하다.
- **맵 메타데이터 JSON** — 건물 목록(종류·위치·yaw·규모), 도로 그래프, 필지 ID, 대문 위치, 지형 높이 샘플러. plan에 이미 있는 값의 직렬화·평탄화다. 스폰포인트·퀘스트 앵커·미니맵의 재료.
- **GLB bake** — §1.6의 canvas 텍스처 미확인을 먼저 해소해야 한다. 선택지: 헤드리스 브라우저(이 레포는 Playwright를 이미 갖고 있다), canvas polyfill, 또는 텍스처를 정점색으로 대체한 저사양 반출. `analyzeExport`에 삼각형 예산 가드가 이미 있고, `instancing: 'bake'`는 한양 규모에서 노드 폭발을 낸다는 주석이 있으므로 규모별 기본값을 정해야 한다.
- **네비메시 / 보행 가능 영역** — 도로 폴리라인과 마당이 이미 있으므로 그 위에 얹는다. AI 패스파인딩이 필요한 소비자에게만 가치가 있어 우선순위가 가장 낮다.

## 4. 이 계획이 하지 않는 것

- **별 레포로 쪼개지 않는다.** 코드가 여기 있고, 마켓플레이스가 `git-subdir`를 지원하며(§P2), 서브트리 분리는 유지비가 크다.
- **새 생성 기능을 만들지 않는다.** P0~P2는 기존 산출물의 포장이고, P3만 신규 직렬화·반출이다. 중국·일본 건축 확장, 범용 월드 확장은 여전히 범위 밖이다([`project-status.md`](project-status.md)).
- **룩을 이식 대상으로 약속하지 않는다.** 골든아워 룩은 `src/env/post.js` 컴포저(bloom+rim+DoF)에 강하게 묶여 있다. three.js 소비자는 그 파이프라인째 가져갈 수 있지만, 다른 엔진 소비자에게는 재작성이다. 문서에서 이를 분명히 한다.

## 5. 소비자에게 정직하게 알려야 할 한계

스킬·README에 반드시 넣는다. 기대를 잘못 세팅하면 이 작업 전체가 실패로 읽힌다.

| 한계 | 실태 |
| --- | --- |
| **실내 진입 불가** | `walk-solids`가 집 몸통 폴리곤을 솔리드로 취급한다. 대문 통로(`giwa-through-passage`)만 통과한다. 인테리어 레이어가 없다. |
| **타일 스트리밍 없음** | `siteR` 반경으로 클램프된 단일 분지 월드이고 테두리는 `worldedge` 안개로 마감한다. 오픈월드 타일링 개념이 없다. |
| **네비메시 없음** | 오토스트롤은 도로 폴리라인 추종뿐이다(P3에서 선택적으로 추가). |
| **게임플레이 훅 없음** | 스폰포인트·트리거 볼륨·상호작용 태그가 없다. 단 `userData.role` 태깅은 살아 있어 후처리 분류에 쓸 수 있다. |
| **단일 three 인스턴스 필수** | 두 인스턴스는 `instanceof`와 프로토타입 패치를 조용히 깬다. peer dependency로 강제한다. |
| **트리셰이킹 없음** | 건물만 쓰려 해도 palette가 환경 helper를 참조해 그래프가 넓게 끌려온다. [`external-reuse.md`](external-reuse.md)도 "최소"가 byte-minimal이 아니라고 못박아 두었다. |

## 6. 착수 순서와 판정

```
P0 (기반, 반나절)  →  P1 (패키지+CLI)  →  P2 (스킬)  →  P3 (반출)
                                    ↘  P3 콜라이더만 먼저 빼도 됨
```

P0 완료 시점에 P1~P3의 난이도가 정확해지므로, **P0의 실측 결과를 받고 이 문서를 갱신한 뒤** P1 스펙을 확정한다. 특히 §1.6의 canvas 텍스처 확인은 P0 직후에 한 번 시도해 P3 경로를 결정한다.

게이트 정책은 기존 그대로다([`../CLAUDE.md`](../CLAUDE.md) Gate policy): 새 게이트를 커밋 블로킹 `CORE_CHECKS`에 넣지 않는다. 패키징 게이트는 `FAST_CHECKS`(deep·routing)에 등록한다.

## 7. 재평가 (2026-08-08, 착수 직전)

착수 전 설계를 재검토하며 추가 실측한 결과다. 중심축(§2)과 단계 순서(§3)는 유지하되 다음을 조정한다.

### 7.1 P0 리스크 하향 — Node 실행은 이미 레포 안에서 증명돼 있다

- `src/builder/palette-context.js`는 **비브라우저 런타임용 canvas 주입 경계를 이미 갖고 있다** (`createPaletteContext({ createCanvas })` + `setPaletteContext`). document가 없으면 명시 에러를 던지는 설계된 실패다.
- `tools/check-hero-global-merge-hide.mjs`는 이미 **Node에서 esbuild alias로 three를 해석하고, 레코딩 스텁 canvas를 주입해 `makeMaterials`·지오메트리 빌드·위치 해시까지 돌린다.**

따라서 P0의 본질은 "가능하게 만들기"가 아니라 **기존 우회로(esbuild alias)를 표준 해석(루트 `node_modules` + `exports` map)으로 승격**하고, 스텁 canvas 패턴을 재사용 가능한 공용 헬퍼로 추출하는 것이다. `buildBuilding()`이 재질 텍스처를 즉시 그리므로(palette.js의 다수 `CanvasTexture`) P0 완료 조건의 Node 실행에는 이 canvas 주입이 포함된다 — 네이티브 canvas 의존성은 **불필요**하다(레코딩 스텁으로 충분).

### 7.2 P3 실현성 상향

같은 주입 경계로 텍스처 포함 GLB bake도 순수 Node에서 될 가능성이 높아졌다. 실픽셀이 필요한 경우에만 `@napi-rs/canvas` 류를 **optional** 의존성으로 검토한다(스텁은 지오메트리·구조를, 실캔버스는 텍스처 픽셀을 준다). P0 직후 프로브 1회로 확정한다.

### 7.3 범위 조정

- **P1 스키마**: JSON-Schema 생성기를 만들지 않는다. 실측 plan과 대조되는 레퍼런스 문서 + 대조 검사로 한정한다(효용 대비 저작·유지비).
- **P3 네비메시**: 확인된 수요가 없으므로 **보류**로 확정한다. 콜라이더 JSON·메타데이터 JSON까지가 P3 범위다.
- **npm publish·마켓플레이스 등록**: 사용자 계정 행위이므로 자율 진행 범위 밖이다. 이번 라운드는 "publish 가능한 상태"(exports map·문서·검증 완비)까지 만들고, 실제 발행은 사용자 결정으로 남긴다.

### 7.4 유용성 판정 (정직하게)

- **three.js 소비자**: 즉시 유용 — 유일한 조선 건축 절차 생성기이고, 경계·게이트·문서가 이미 있다.
- **에이전트 소비자**: 차별적 — plan JSON + validate 함수 + 결정론 게이트 조합은 에이전트 자기검증 루프를 공짜로 성립시키며, 이 조합을 갖춘 절차 생성 패키지는 드물다.
- **엔진(Unity 등) 소비자**: 데이터(콜라이더·메타데이터·GLB)만 간다. 룩은 이식되지 않는다(§4).
- **수요 불확실성은 실재한다.** 헤지는 단계별 독립 가치(§3)다 — P0는 레포 자체의 결함 수정이고, P1·P2는 저비용이며, 비싼 것(P3 GLB)은 프로브 후 결정한다.
