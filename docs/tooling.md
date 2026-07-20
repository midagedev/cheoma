# 도구 스택: 브라우저 기반 절차적 건축 생성

기준일: 2026-07-16. 버전·게시일은 npm 레지스트리, 유지보수 상태는 GitHub `pushed_at`으로 교차 검증됨.

## 2026-07-20: `cloudai-x/threejs-skills` 선별 적용 판단

[`cloudai-x/threejs-skills`](https://github.com/cloudai-x/threejs-skills)는 일반적인 three.js 제작 체크리스트로는 가치가 있지만, 이 레포의 결정론·worker·instancing·`onBeforeCompile` 규칙과 겹치는 자체 계약을 대체할 수는 없다. 따라서 스킬 전체를 설치하거나 코드를 복사하지 않고 다음 원칙만 현재 구조에 맞게 적용했다.

- hot loop에서 전체 객체 열거·복제를 피하고 이미 존재하는 인덱스를 단건 API로 노출한다.
- renderer, composer, pass와 DOM 이벤트의 소유자에게 idempotent teardown을 둔다.
- 색공간과 DPR은 three 0.185.1의 실제 동작을 기준으로 한 번만 변환·동기화한다.
- 셰이더 프로그램 변형은 리터럴 분기보다 uniform을 우선하고 program plateau로 검증한다.
- 시각 변경은 고정 시드 캡처와 효과 ON/OFF 기여량을 함께 본다.

적용 결과는 `architecture-refactor.md`와 `verification.md`의 현재 계약에 반영했다. 나머지 예제·보일러플레이트·일반 튜토리얼은 레포에 중복 문서와 두 번째 작업 규칙을 만들기 때문에 가져오지 않는다.

## 1. CSG / 불리언 연산

### manifold-3d (Manifold) — 1순위
- 버전: **v3.5.1** (2026-06-04 릴리스, 2026-07-14 커밋 — 매우 활발, 2.1k★)
- 라이선스: Apache-2.0 / WASM 기반, 패키지 2.76MB (wasm 바이너리 자체는 약 1MB 안팎)
- **결구·기와 절단 같은 정적 정밀 지오메트리에 강력 추천.** 위상 견고성(guaranteed manifold, watertight)이 설계 목표라 장부맞춤처럼 얇은 겹침·동일평면 절단에서도 깨진 메시가 안 나옴. OpenSCAD·Three.js 진영이 채택한 사실상의 표준.
- 단점: Three.js `BufferGeometry` ↔ 자체 MeshGL 포맷 간 수동 변환 필요 (저장소에 three.js 예제 있음, 배열 복사 수준이라 일회성 전처리엔 부담 없음).

### three-bvh-csg — 보조
- 버전: v0.0.18 (2026-02-17 — 활발, 925★) / MIT / 순수 JS, 1.39MB, three-mesh-bvh 위에 구축
- **실시간·동적 불리언이나 프로토타이핑용.** `Brush`(=`THREE.Mesh`)를 직접 받아 `BufferGeometry`로 반환 — 왕복 변환 없음, Three.js 통합 편의성 최고.
- 단점: 축퇴·동일평면 입력에서 Manifold보다 견고성 떨어짐 → 정밀 결구에는 부적합할 수 있음.

> **판단**: 최종 품질은 Manifold, UI 실험 단계는 three-bvh-csg 병용. 단, 상당수 결구는 CSG 없이 파라메트릭 박스 조립만으로 표현 가능하니 **CSG 사용은 "보이는 절단면이 필요한 부위"로 한정**.

## 2. 공간 가속 구조

### three-mesh-bvh — 필수
- 버전: **v0.9.11** (2026-07-10 — 매우 활발, 3.4k★) / MIT / 순수 JS, 2.33MB
- **1인칭 탐색 모드에 필수.** 레이캐스팅 수십~수백 배 가속 + `shapecast` 기반 캡슐-메시 충돌. **1인칭 캐릭터 컨트롤러 예제가 공식 저장소에 존재** — 충돌 검사를 직접 짤 필요 없음. three-bvh-csg의 기반이라 CSG 쓰면 어차피 함께 들어옴.

## 3. B-rep / NURBS 커널

### 판단: 곡면 지붕(앙곡·안허리곡 이중 곡률)에 풀 CAD 커널 불필요
앙곡(수직 들림)·안허리곡(수평 굽음)은 본질적으로 **제어점 보간 곡선을 서까래 그리드에 로프트하는 문제**로, B-rep 위상 연산이 필요 없음. **1순위: Three.js 내장 `CatmullRomCurve3`/`CubicBezierCurve3` + 직접 버텍스 그리드 계산** — 가장 가볍고 제어가 정밀하며 서까래·기와 인스턴싱 좌표를 그대로 뽑을 수 있음.

- **verb-nurbs** (v3.0.3, 2025-04 릴리스, 810★, MIT, 순수 JS 2.58MB): 진짜 NURBS 파라미터화가 필요할 때만 보조로. 풀 커널이 아닌 곡면 수학 라이브러리라 로딩 비용 없음.
- **opencascade.js** (v1.1.1, 저장소 2023-08 이후 정체, LGPL-2.1, WASM 풀 빌드 언팩 66MB): **비추천** — 3년째 정체 + 로딩 비용 과다.
- **replicad** (v0.23.1, 2026-05 — 활발, MIT, 트림된 OCCT WASM 수 MB): 풀 CAD가 정말 필요할 때의 현실적 선택지지만 본 프로젝트엔 과함.

## 4. 2D 폴리곤 연산 (풋프린트·도시 블록)

### clipper2-js — 1순위
- 버전: v1.2.4 (2024-01) / Boost SW License / 순수 JS, 1.87MB
- 불리언 + **폴리곤 오프셋(inflate/deflate)** 지원 — 풋프린트 인셋, 도로 폭 확보, 블록 여백 처리에 필수. 정수 좌표 기반이라 견고성 우수.
- 대안: js-angusj-clipper (WASM, 대량 폴리곤에서 더 빠를 수 있음 — 성능 병목 실측 시에만). polygon-clipping은 오프셋 미지원·견고성 이슈로 **비추천**.

## 5. 익스포트 파이프라인

- **GLTFExporter** (three 내장, three v0.185.1 / 2026-07-01): 씬 → glTF/GLB 직행. 무비용.
- **glTF Transform** (`@gltf-transform/core` + `functions` v4.4.1, 2026-07-02 — 매우 활발, MIT): **도시 스케일 최적화에 강력 추천.** Draco·Meshopt 압축, dedup/weld, **`EXT_mesh_gpu_instancing`**, LOD, 텍스처 리사이즈를 프로그래밍 방식으로 후처리. 반복 부재(기둥·기와·공포) 수만 개 스케일에서 파일 크기·드로우콜을 결정적으로 줄임.

## 6. 보조 도구

| 도구 | 버전·상태 | 용도 | 판정 |
|---|---|---|---|
| `alea` | v1.0.1 (안정, 무의존 9KB) | 시드 결정론 PRNG | **필수** (seedrandom보다 가볍고 빠름) |
| `lil-gui` | v0.21.0 (2025-10) | 파라미터 실시간 튜닝 패널 | **필수급** |
| `simplex-noise` | v4.0.3 (2024-07) | 지형 기복·재질 변주·밀도 필드 | 추천 |
| `poisson-disk-sampling` | v2.3.1 (안정) | 건물·수목 비겹침 산포 | 추천 (도시 단계) |
| `rbush` | v4.0.1 (표준급 R-tree) | 도시 인스턴스 범위 질의·컬링 | 추천 (도시 단계) |
| `wavefunctioncollapse` | v2.1.0 (저활동) | 타일 기반 생성 | 조건부 — 격자·축선 규칙이 뚜렷한 동아시아 도시엔 규칙 기반 분할+BSP/포아송이 더 적합 |

## 추천 스택 요약

**필수 (지금 도입)**
- `three` (0.185.1) + 내장 GLTFExporter, CatmullRomCurve3/Bezier — 지붕 곡면은 내장 커브 + 직접 버텍스 계산
- `three-mesh-bvh` — 레이캐스팅·1인칭 충돌
- `manifold-3d` — 견고성이 필요한 CSG
- `@gltf-transform/core`+`functions` — 압축·인스턴싱·LOD
- `alea`, `lil-gui`

**나중에 / 조건부**: `clipper2-js` (도시 블록), `simplex-noise`·`poisson-disk-sampling`·`rbush` (산포·컬링), `three-bvh-csg` (실시간 CSG 실험), `verb-nurbs` (NURBS 필요 시), `wavefunctioncollapse` (불규칙 다양성 필요 시)

**불필요**: `opencascade.js` (정체+로딩 비용), `replicad` (이득 없음), `polygon-clipping` (clipper2-js에 밀림)

**핵심 판단 세 가지**
1. 이중 곡률 지붕은 CAD 커널 없이 Three.js 내장 커브 + 버텍스 계산으로 충분 — WASM 커널 회피.
2. CSG는 Manifold(견고성) 우선, 결구 상당수는 파라메트릭 조립으로 대체해 CSG 호출 최소화.
3. 도시 스케일의 관건은 생성이 아니라 **익스포트 단계의 인스턴싱·압축** — gltf-transform이 결정적.

---

## 부록: 앰비언트 레이어 도구 (에이전트 미검증 — 프로토타입 단계에서 확인)

README의 앰비언트 레이어(파티클·소동물·사운드) 관련 후보. 위 조사와 달리 아직 버전·유지보수 검증 전.

- **사운드**: Three.js 내장 `AudioListener`/`PositionalAudio`로 풍경(風磬) positional audio 구현 가능 — 별도 라이브러리 불필요할 가능성 높음. 복잡해지면 howler.js 검토.
- **파티클(낙엽·꽃잎·눈)**: 자체 InstancedMesh + 셰이더 바람 필드가 기본. 규모가 커지면 `three.quarks` 같은 파티클 시스템 검토.
- **새 boids / 소동물**: 개체 수가 적어(수십) 자체 구현이 적절. 충돌은 three-mesh-bvh 재활용.
- **사운드 에셋**: freesound.org (CC0/CC-BY 필터), 국악 BGM은 국립국악원 아카이브 라이선스 확인 필요.

---

## 채택 확정 (스파이크 검증 완료 · 2026-07-17)

위 조사(계획)를 **실채택 검증**으로 확정한 결과. 검증 도구: `tools/spike-libs.html`(자체 importmap, jsdelivr/esm.sh CDN) + `tools/spike-libs.mjs`(playwright 헤드리스 크롬 실행기). 각 라이브러리를 **빌드 스텝 없이 브라우저 CDN 로드** 후 트리비얼 연산 1건을 실행하고, `.wasm` fetch·네트워크 실패·콘솔 오류를 함께 수집했다. 재현: `node tools/spike-libs.mjs` (결과 JSON 은 스크래치패드에 기록).

### 판정 표

| 라이브러리 | 버전 | CDN (importmap) | 검증 연산 → 결과 | 판정 |
|---|---|---|---|---|
| **manifold-3d** | 3.5.1 | `https://cdn.jsdelivr.net/npm/manifold-3d@3.5.1/manifold.js` (ESM 글루, `manifold.wasm` 동일 경로 자동 fetch) | 큐브∩큐브 → **volume 4 (정확)**, MeshGL 추출(8v/12t, vertProps) OK | **확정** (CSG·glTF 클린 지오메트리). WASM CDN fetch 성공 → **vendoring 불필요** |
| **three-mesh-bvh** | 0.9.11 | `https://esm.sh/three-mesh-bvh@0.9.11?external=three` | Box BVH 빌드 + 레이캐스트 → **hit dist 4 (정확)**, `boundsTree instanceof MeshBVH` | **확정** (1인칭 충돌·레이캐스트) |
| **clipper2-js** | 1.2.4 | `https://cdn.jsdelivr.net/npm/clipper2-js@1.2.4/fesm2015/clipper2-js.mjs` | Union(겹친 두 사각형) → **면적 175 (정확)** / **오프셋(InflatePaths) → 왜곡, 면적 81 기대에 90.168** | **부분 확정** — **불리언만 채택**, **오프셋은 보류(버그)** |
| **js-angusj-clipper** | 1.3.1 | `https://esm.sh/js-angusj-clipper@1.3.1/web` (WASM) | 사각형 -0.5 오프셋 → **정확한 인셋 정사각형, 면적 81** | **확정 (오프셋 전용 대안)**. WASM CDN fetch 성공 → **vendoring 불필요** |

> 검증 중 `.wasm`·CDN 요청 실패 **0건**. manifold·js-angusj-clipper 두 WASM 모두 헤드리스 크롬에서 CDN 바이너리 로드 성공 → **로컬 vendoring(assets/vendor/) 불필요**. (사내망 CSP·오프라인 배포가 필요해지면 그때 vendoring 재검토.)

### 함정 (실측)

- **clipper2-js@1.2.4 오프셋 버그**: `Clipper.InflatePaths`/`ClipperOffset` 이 닫힌 다각형에서 첫 정점 코너만 정상 마이터하고 나머지 코너를 한 축으로만 오프셋해 **왜곡된 폴리곤**을 반환(사각형 -0.5 인셋이 면적 81 대신 90.168, +0.5 아웃셋도 왜곡). **1.2.4 가 유일한 최신 릴리스**라 버전 업으로 해결 불가. **불리언(Union/Intersect/Difference)은 정확**하므로 블록 분할 등 불리언 용도로만 채택.
- **three-mesh-bvh 는 반드시 `?external=three`**: esm.sh 기본 로드나 jsdelivr `+esm` 은 three 를 **중복 번들**해 별도 인스턴스가 생김 → `acceleratedRaycast` 프로토타입 패치·`instanceof` 가 깨진다. `?external=three` 로 peer three 를 importmap 에 위임해야 함.
- **manifold-3d 진입점**: 기본(`manifold.min.js`)이 아니라 **ESM 글루 `manifold.js`** 를 import → `const wasm = await (await import('manifold-3d')).default(); wasm.setup(); const { Manifold } = wasm;`. `.wasm` 은 `import.meta.url` 기준 상대 경로라 jsdelivr 경로에서 자동 해석됨. Three 통합 시 **MeshGL↔BufferGeometry 수동 변환** 필요(배열 복사 수준).
- **정수 좌표**: 두 클리퍼 모두 정수 좌표 기반 → float 는 **~1e4 스케일** 후 오프셋/불리언, 결과를 되나눔.
- **js-angusj-clipper 비동기 초기화**: `await loadNativeClipperLibInstanceAsync(NativeClipperLibRequestedFormat.WasmWithAsmJsFallback)` 로 인스턴스 확보 후 `offsetToPaths({ delta, offsetInputs:[{ data:[{x,y}...], joinType, endType }] })`. 점 포맷은 `{x,y}`.

### v4 도시 생성 권장 조합

- **폴리곤 불리언** (블록→필지 분할, 도로/필지 교집합·차집합): **clipper2-js** (불리언 정확·순수 JS·경량).
- **폴리곤 오프셋** (신분별 필지 인셋·도로폭 확보·담장 중심선·이면도로 여백): 두 갈래 —
  1. **js-angusj-clipper** (임의 각도 폴리곤까지 견고, WASM). 일반 오프셋 필요 시.
  2. **커스텀 직교 마이터 오프셋** — 조선 도성/블록은 대체로 **직교·축선형**(docs/joseon-city.md)이라, 이미 검증된 `src/layout/hanok.js`의 `offsetPoly`(및 skeleton 모듈의 직교 처리)로 결정론·무WASM 처리 가능. **rectilinear 케이스는 이쪽 우선** — 의존성·번들 최소화.
- **CSG** (ㄱ자 지붕 회첨 볼륨·결구 절단면·glTF 클린 솔리드): **manifold-3d** (위상 견고). 단 tooling.md 원칙대로 **보이는 절단면 한정** 사용.
- **레이캐스트/1인칭 충돌·소품 지형 스냅**: **three-mesh-bvh** (`?external=three`).
- **익스포트**: three 내장 GLTFExporter + `@gltf-transform`(인스턴싱·압축) — 본 스파이크 범위 밖(별도 검증 권장).

**요약 판정**: manifold-3d·three-mesh-bvh **즉시 확정**, clipper2-js **불리언 확정/오프셋 보류**, 오프셋은 **js-angusj-clipper 또는 직교 커스텀**. WASM vendoring 현재 불필요.
