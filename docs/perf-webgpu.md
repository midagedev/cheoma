# 렌더링 성능 리서치 — three.js 최신 버전 · WebGPU · 최적화 기법

- 조사일: **2026-07-17**
- 대상: cheoma (three.js 조선 전통건축 파라메트릭 앱)
- 현재 스택: `three@0.185.1` (= r185), `WebGLRenderer` 전제, Svelte SPA + 프레임워크 무관 ES 코어
- 작성: 렌더링 성능 리서처 (조사 전 코드 인벤토리 → 웹 리서치)

---

## 경영 요약 (권고안 5줄)

1. **버전 갭 없음 — 업그레이드 불필요.** `0.185.1`은 r185(2026-07-01 릴리스)로 **현시점 최신 릴리스 라인**이다. "최신 버전 적극 활용"은 이미 충족돼 있으며, 지금 할 일은 버전 올리기가 아니라 **최신 버전이 제공하는 기법(BatchedMesh 등)을 도성 스케일에 쓰는 것**이다.
2. **WebGPU는 지금 메인 전환 보류, 병행 브랜치 실험만 권고.** three.js 공식 문서가 **r185 기준 WebGPURenderer를 여전히 "experimental, 프로덕션 비권장"**으로 명시한다. 게다가 우리 스택은 WebGPU 이행 비용이 최악군 — `onBeforeCompile` GLSL 체인 4종(계절·날씨·단청·바람) + 커스텀 `RimPass` + `EffectComposer`(bloom/DoF) + `ShaderMaterial` 파티클 + ink 패스 전부가 **TSL 전면 재작성 대상**이다.
3. **성능 병목은 draw call(CPU)이 아니라 fill-rate(GPU)일 가능성이 높다.** 마을 인스턴싱이 이미 draw call을 8,700+ → 수십 규모로 붕괴시켜 놓았다. 반면 `RimPass`가 **매 프레임 씬을 노멀 오버라이드로 한 번 더 통째로 렌더**하고, bloom·DoF·4096 그림자가 GPU를 먹는다. WebGPU의 render bundle 이점은 **CPU-bound일 때만** 발현 — 우리가 GPU-bound라면 WebGPU로 바꿔도 "마법 같은 개선"은 없다.
4. **톱3 최적화(렌더러 불문, 지금 착수 가치 순):** ① **청크 단위 static merge + frustum culling**(현재 `mergeStatic`이 마을 전체를 1개 거대 병합 메시로 만들어 컬링이 절대 안 됨 — 도성에서 치명적) ② **원거리 건물 LOD/임포스터** ③ **그림자 전략 개편**(현재 ±22m 단일 4096 맵은 건물 1채용 — 도성 커버 불가; CSM/캐스케이드 + static shadow cache 필요).
5. **먼저 측정하라.** #47 착수 전 `renderer.info` + stats-gl 프로파일 하네스로 **CPU-bound인지 GPU-bound인지부터 판정**해야 최적화 우선순위(그리고 WebGPU 타당성)가 결정된다. 지금은 추정뿐이다.

---

## 조사 전 코드 인벤토리 (WebGL 종속 근거)

실제로 파일을 열어 확인한 WebGL/WebGLRenderer 종속. WebGPU 이행 시 이 목록이 그대로 "재작성 범위"가 된다.

### 렌더러 셋업
- `src/main.js:61` / `app/src/engine/engine.js:54` — `new THREE.WebGLRenderer({ antialias, powerPreference:'high-performance' })`. `setPixelRatio(min(dpr, PR_CAP))`, `PCFSoftShadowMap`, `ACESFilmicToneMapping`.
- 카메라 `PerspectiveCamera(28, …, 0.1, 500)`, `OrbitControls` + damping + autoRotate.

### 후처리 — `src/env/post.js` (핵심 GPU 비용)
- `EffectComposer`(HalfFloat HDR) 파이프라인: `RenderPass → RimPass(커스텀) → UnrealBloomPass → BokehPass(opt-in DoF) → OutputPass(ACES+sRGB 1회)`.
- **`RimPass`(post.js:158–253)가 최대 관전 포인트:** `render()`마다 씬 전체를 `overrideMaterial = MeshNormalMaterial`로 **반해상도 오프스크린에 통째로 재렌더**(투명 오브젝트 숨김 traverse 포함)해서 뷰공간 노멀·깊이를 얻은 뒤 프레넬 림 합성. 건물 1채면 무해하나 **도성 300호에선 지오메트리 제출이 사실상 2배 + 별도 fill 패스**가 된다.
- ink 모드는 별도 컴포저(`src/render/ink.js`): `RenderPass → InkPass(커스텀 GLSL FullScreenQuad) → OutputPass`. 절차 한지 텍스처(2048 canvas).

### `onBeforeCompile` GLSL 패치 체인 (TSL 이행의 최대 난관)
- `src/env/seasons.js` — `patchTrees`(vertex: 수종별 잎색 이동 + instanceMatrix 기반 바람 sway), `patchTerrain`(vertex+fragment 지면 곱연산 틴트). `prev()` 체이닝.
- `src/env/weather.js:101 patchSnow` — **씬 전체 `MeshStandardMaterial`을 traverse**해 vertex(월드 노멀/위치 varying) + fragment(노멀 교정, 적설 블렌딩, 그늘 리프트) 주입. 공유 uniform `uSnowAmount`.
- 추가로 단청·바람 패치 체인 존재(메모리 `onbeforecompile-chain-order` — `#include` 문자열 치환 순서 역전 함정 활용 중).
- 이 GLSL 문자열 주입 방식은 **WebGPURenderer에서 전면 미지원**(아래 ② 참조).

### 파티클 (Points/LineSegments + 커스텀 셰이더, 대부분 CPU 업데이트)
- `weather.js`: snow 3,600 `Points`(ShaderMaterial, **매 프레임 CPU로 Float32Array position 갱신**), rain 2,600 `LineSegments`(CPU), drips `LineSegments`(CPU), splash `Points`(GPU 애니메이션, uTime 구동).
- `seasons.js`: 낙엽 640 `InstancedMesh` 쿼드(CPU), litter `InstancedMesh`(CPU).
- `env/motes.js`: 160 `Points`(GPU 애니메이션), `env/smoke.js` 연기.
- 파티클 총량은 현재 modest(카메라가 건물 고정이라 볼륨이 작음). 도성에서 파티클을 대폭 늘릴 계획이 없으면 compute 전환 이득은 제한적.

### 인스턴싱 — `src/village/instancing.js` (이미 잘 되어 있음)
- 재질별 `InstancedMesh`(변주 풀) + 유일 지오 `mergeStatic`(재질별 정적 병합). `instanceColor`로 집집 틴트. 픽킹은 프록시 레이캐스트(adapter.js).
- 코드 주석 근거: **capital 68호 = 8,700+ draw call → "재질 수" 규모(수십)로 붕괴**. (task 설명의 75호 14,929→587도 같은 전략.)
- **단, `mergeStatic`(instancing.js:185)은 담·도로·논·랜드마크를 재질별로 1개 메시로 병합** → 그 메시의 bounding volume이 마을 전체를 덮어 **frustum culling이 사실상 무력화**된다. 도성 4배에서 이게 GPU 낭비의 큰 축이 된다(청크 분할 필요).

### 텍스처
- **거의 전부 절차적 canvas 텍스처**(`document.createElement('canvas')` → `CanvasTexture`): 한지, 잎, 태양 글로우 등. **외부 이미지 자산 파일이 거의 없다** → KTX2/Basis/Draco 같은 "에셋 압축" 최적화는 우리에게 적용 여지가 작다(예외: glTF export 경로 #4).

### 모바일 성능 프로파일 (이미 존재 — `device.svelte.js` + `engine.js:32`)
- `perf = touch || w≤900` → **DoF off**(`post.setDof(false)`, BokehPass 풀스크린 블러가 fill 큼), 그림자맵 2048.
- `compact = min(w,h)≤520` → `pixelRatio` 1.5, 그림자맵 1536, `LOW_BLOOM`(bloom 반해상도).

---

## ① three.js 최신 버전 갭

### 결론: **갭 없음. 업그레이드 작업 불필요(비용 0).**

- `0.185.1` = **r185, 2026-07-01 릴리스**. three.js는 `0.<rNNN>.<patch>` 버저닝이며 월 1회 릴리스 케이던스. 조사일(07-17) 기준 **r185가 최신 라인**이고 우리는 그 위에 있다. (다음 r186은 8월 초 예상.)
- 즉 "three.js 최신 버전 적극 활용"은 **이미 충족**. 남은 과제는 버전을 올리는 게 아니라 **최신 버전이 이미 제공하는 도구를 도성 스케일에 적용**하는 것.

### 최신 버전이 우리에게 주는 것(이미 손 안에 있음)
- **`BatchedMesh`** — r156부터 도입, r184에서 구형 instancing 경로 정리·성숙. "재질 공유·지오메트리 상이" 객체를 1 draw call로. (우리 적용성은 ③에서 판정: 대부분 **동일 지오 반복 → InstancedMesh가 이미 최적**, BatchedMesh는 제한적.)
- **`WebGPURenderer`/TSL** — r171+ 부터 `three/webgpu` 서브패스로 안정 import 가능(단 experimental, ②).
- r161+ **신규 머티리얼 기능은 "TSL-first"** 로 추가되는 흐름. 단 **`WebGLRenderer`와 GLSL 경로는 계속 완전 지원** — 우리가 GLSL을 계속 써도 당장 끊기지 않는다. 다만 장기적으로 신기능이 TSL 쪽에 먼저 붙는다는 방향성은 인지 필요.

### 업그레이드 비용 평가
- **없음.** 이미 최신. 매월 r186, r187… 따라가는 것은 선택(브레이킹은 대부분 deprecated 제거 — 우리 코어가 표준 API·addons만 쓰므로 리스크 낮음). 굳이 자주 올릴 유인도 낮다(현 기능 충분).

---

## ② WebGPU 적극 활용 타당성

### 결론: **지금은 메인 전환 보류. 병행 실험 브랜치만 권고(선택).**

### (a) WebGPURenderer + TSL 성숙도 — 공식 입장이 "아직 아니다"
three.js **공식 매뉴얼(`threejs.org/manual/en/webgpurenderer.html`)이 명시:**
> "The renderer itself is still in an **experimental state** … depending on your application and scene setup, you will encounter **missing features or better performance with `WebGLRenderer`**. … For pure WebGL 2 applications, `WebGLRenderer` remains the **recommended choice** for production."

일부 서드파티 블로그(utsubo, ravespace 등)는 "r171부터 production-ready, 지금 마이그레이션하라"고 더 공격적으로 주장하나, **공식 문서와 상충**한다. 우리 스택 리스크를 감안하면 **공식 입장(보수)에 무게**를 둔다.

### (b) 브라우저 커버리지 (2026, caniuse ≈ 82%)
| 브라우저 | 데스크톱 | 모바일 |
|---|---|---|
| Safari | 26+ 기본 ON | **iOS/iPadOS 26+ 기본 ON** (WebGL 시절 최대 난적이 열림 — 의미 큼) |
| Chrome/Edge | 기본 ON (mac/Win) | Android 12+ 기본 ON (v121+) |
| Firefox | Win(141+)·mac(147+) ON, **Linux 플래그** | **Android 플래그(비활성)** |

- **WebGL2 자동 폴백**이 `WebGPURenderer`에 내장 → 미지원 환경도 자동 흡수. 폴백 실효성은 높다.
- 단 **폴백 경로에선 우리가 TSL로 재작성한 셰이더가 GLSL로 컴파일되어 돌 뿐, WebGPU 이득은 없음** → "둘 다 유지"가 아니라 "TSL 한 벌로 양쪽" 구조.

### (c) 우리 스택 이행 난이도 — **최악군(High)**
공식 매뉴얼이 열거하는 WebGPU 제약이 **정확히 우리가 가진 것들**:
- **`ShaderMaterial`·`RawShaderMaterial`·`onBeforeCompile()` 미지원** → node material + **TSL로 전면 이식**. 우리: 계절(2패치)·날씨(적설, 씬 전체 traverse)·단청·바람 + 파티클 ShaderMaterial 다수. **가장 큰 공수.**
- **`EffectComposer` 미지원** → TSL `PostProcessing` 노드 합성으로 재작성. bloom/DoF는 노드 대응물 존재(`bloom()`, DoF 노드 — 오히려 더 성능 좋다고 함, SSGI/SSS 등 신규 효과도), **하지만 우리 커스텀 `RimPass`(씬 노멀 재렌더 + 프레넬)는 대응물 없음 → TSL로 직접 재구현**해야 함. ink NPR 패스도 동일.
- **비동기 초기화**: `await renderer.init()` 필요(setAnimationLoop 아니면).

### (d) 실측 성능 이득의 현실적 추정
- **파티클 compute:** CPU 파티클 ~50k 한계 → WebGPU compute로 **1M+**. 단 **우리 현재 파티클은 수천 규모이고 늘릴 계획이 명확치 않음** → 이 이득은 지금 우리에겐 크지 않다.
- **draw-call-heavy / compute-heavy 씬에서 2–10x.** 우리는 인스턴싱으로 이미 draw call을 눌러놨다 → **CPU draw-call이 병목이 아닐 가능성**.
- **Render bundle은 CPU-bound일 때만 효과.** GPU-bound(fill-rate: bloom·DoF·RimPass 재렌더·4096 그림자)라면 WebGPU render bundle로도 개선 없음.
- ⇒ **핵심: 우리가 CPU-bound인지 GPU-bound인지 측정 전엔 WebGPU 이득을 확언 불가.** 인스턴싱 완료 상태 + 무거운 후처리 정황상 **GPU-bound 쪽이 유력** → WebGPU 우선순위가 낮아진다.

### 권고 (명확)
- **지금(메인):** WebGL 유지. #47은 WebGL에서 렌더러 불문 최적화(③)로 간다.
- **병행(선택, 저우선):** `three/webgpu` + TSL로 **작은 실험 브랜치** — 계절/적설 패치 1개를 TSL로 시제 이식해 이행 공수를 실측하고, WebGPURenderer로 도성 씬을 돌려 fill-rate 이득을 A/B. **메인 코드 동결.**
- **재평가 트리거:** (1) 공식 매뉴얼에서 "experimental" 문구 제거, (2) 프로파일이 **CPU-bound**로 나옴, (3) 파티클을 10k+로 크게 늘릴 제품 결정. 이 중 하나라도 서면 WebGPU 승격 재검토.

---

## ③ 렌더러 불문 최적화 기법 총람 (우선순위 톱10)

임팩트/공수/리스크는 **도성(#47)** 기준. 대부분 WebGL·WebGPU 공통이라 지금 착수해도 낭비 없음.

| # | 기법 | 임팩트 | 공수 | 리스크 | 우리 상황 근거 |
|---|---|---|---|---|---|
| 1 | **프로파일 하네스 우선 구축** (`renderer.info.render.calls/triangles` + stats-gl + Spector.js) | 상 | 하 | 하 | 병목(CPU vs GPU) 판정 없이 나머지·WebGPU 결정 불가. 착수 0순위. |
| 2 | **청크 단위 static merge + frustum culling** | 상 | 중 | 중 | 현 `mergeStatic`이 마을 전체 1병합 → 컬링 무력. 격자 청크별 병합해 화면 밖 청크 컷. #46 청크 생성과 자연 결합. |
| 3 | **원거리 건물 LOD / 임포스터(billboard)** | 상 | 중 | 중 | 대형 씬 30–40% fps. 원경 초가/기와를 저폴리 or 빌보드로. `InstancedMesh` + 거리별 스왑. |
| 4 | **그림자 전략 개편 (CSM/캐스케이드 + static cache + 프러스텀 확대)** | 상 | 중 | 중 | 현 `sun.shadow` ±22m·단일 4096은 **건물 1채용** — 도성 커버 불가. `shadowMap.autoUpdate=false`(정적 씬 캐시), 데스크톱 4/모바일 2 캐스케이드. |
| 5 | **`RimPass` 도성 게이팅** | 상 | 하 | 하 | post.js가 매 프레임 씬 노멀 재렌더(지오 2배 제출). 부감 도성에선 rim off 또는 근경 한정. 즉효·저공수. |
| 6 | **three-mesh-bvh 픽킹** | 중 | 하 | 하 | 300호 프록시 레이캐스트 대비 정밀·고속(80k+ 폴리 60fps). adapter.js 픽킹 경로에 결합. |
| 7 | **frustum/거리 컬링 정합** (병합 지오 bounding 정확화, 원거리 파티클/디테일 드롭) | 중 | 하 | 하 | 파티클 `frustumCulled=false` 다수 — 도성에선 거리 게이트 재검토. |
| 8 | **지오메트리 압축·머지 튜닝** (non-indexed 재인덱싱, 정점 attribute 다이어트) | 중 | 중 | 중 | `normalizeGeo`가 non-indexed로 병합 → 정점 중복. 도성 메모리·대역폭에 영향. |
| 9 | **OffscreenCanvas + Worker 청크 생성** | 중 | 상 | 상 | #46 무프리징 생성. **함정: 우리 텍스처가 canvas 절차 생성** → 워커에선 OffscreenCanvas 필요, 일부 API 제약. 지오 병합만 워커로 빼는 게 현실적. |
| 10 | **BatchedMesh(선택)** | 하~중 | 중 | 중 | "재질 공유·지오 상이"에만 이득. 우리 반복은 **동일 지오 → InstancedMesh가 이미 최적**. 현재 multidraw가 instanced-multidraw보다 1.5–2x 느림(구현 한계). **랜드마크(유일 지오) 묶음에 한해** 검토. |

### 로드맵 매핑
- **#47 도성(4x, draw call 서브리니어):** 이미 인스턴싱으로 draw call은 서브리니어 달성. **실제 남은 병목은 GPU fill·컬링·그림자** → 위 #2·#3·#4·#5가 직결. WebGPU는 여기서 필수 아님.
- **#46 청크 생성(무프리징):** #9(워커/OffscreenCanvas, 지오만) + #2(청크 병합)이 동일 작업으로 수렴. 프레임 슬라이싱은 `requestIdleCallback`/시간예산 루프.
- **모바일:** 이미 PR clamp·DoF off·그림자 하향 존재. 추가로 **#5(rim off)**, 파티클 수 하향, **#4 static shadow cache**(정적 부감), bloom 반해상도(이미 compact). fill-rate가 모바일 최대 적 → post 경량화가 최고 ROI.

---

## 채택 / 보류 / 후속검증

### 채택 (지금, WebGL 유지 하에)
- 프로파일 하네스(① 톱10 #1) — **모든 것의 선행.**
- 청크 병합+컬링(#2), 원거리 LOD/임포스터(#3), 그림자 개편(#4), RimPass 도성 게이팅(#5), three-mesh-bvh 픽킹(#6). → **#47·#46의 실질 작업 목록.**

### 보류
- **WebGPURenderer 메인 전환** — 공식 "experimental·비권장" + 우리 스택 이행 최악군 + 이득 미확정(GPU-bound 유력). **병행 실험 브랜치만 허용, 메인 동결.**
- **three.js 버전 업그레이드** — 이미 최신(r185). 불필요.
- **KTX2/Basis/Draco 에셋 압축** — 우리는 절차 canvas 텍스처·절차 지오 → 적용 여지 작음. (예외: glTF export #4 산출물 최적화.)
- **BatchedMesh 전면 도입** — 동일 지오 반복엔 InstancedMesh가 우위. 랜드마크 한정 선택 검토.
- **파티클 compute 셰이더** — 현 파티클 규모론 이득 작음. 대량 증설 결정 시 재검토.

### 후속검증 (측정으로 결정)
- **CPU-bound vs GPU-bound 판정** (`renderer.info` + GPU timer). → 최적화 우선순위 + WebGPU 타당성의 분기점.
- **TSL 이행 공수 실측** — 계절/적설 패치 1개를 TSL 시제 이식해 시간·리스크 계량(WebGPU 승격 판단 근거).
- **OffscreenCanvas 워커에서 canvas 텍스처 생성 가능성** — 안 되면 텍스처는 메인 유지, 지오만 워커.
- **도성 300호 실측 draw call·프레임타임** — 인스턴싱 후 실제 값으로 서브리니어 확인.

---

## 출처 (조사일 2026-07-17)

- three.js Releases (최신 버전·릴리스 노트): https://github.com/mrdoob/three.js/releases
- three.js Migration Guide (브레이킹 체인지): https://github.com/mrdoob/three.js/wiki/Migration-Guide
- three.js 공식 매뉴얼 — WebGPURenderer (experimental·비권장·제약, **1차 근거**): https://threejs.org/manual/en/webgpurenderer.html
- three.js docs — BatchedMesh: https://threejs.org/docs/pages/BatchedMesh.html
- WebGPU 구현 현황(브라우저별, gpuweb 공식): https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- web.dev — WebGPU 주요 브라우저 지원: https://web.dev/blog/webgpu-supported-major-browsers
- three.js 포럼 — InstancedMesh vs BatchedMesh 선택/성능: https://discourse.threejs.org/t/how-to-choose-between-instancedmesh-and-batchedmesh/81221
- three.js 이슈 #31935 — BatchedMesh multiDraw*Instanced (1.5–2x 격차 근거): https://github.com/mrdoob/three.js/issues/31935
- Three.js Roadmap — Draw Calls: The Silent Killer (<100 draw call 목표·CPU-bound): https://threejsroadmap.com/blog/draw-calls-the-silent-killer
- Three.js Roadmap — WebGL vs WebGPU Explained: https://threejsroadmap.com/blog/webgl-vs-webgpu-explained
- Toji.dev — WebGPU Render Bundle best practices (CPU-bound일 때만 효과): https://toji.dev/webgpu-best-practices/render-bundles.html
- utsubo — WebGPU↔three.js Migration Guide (서드파티, 공격적 입장; 참고): https://www.utsubo.com/blog/webgpu-threejs-migration-guide
- utsubo — 100 three.js Performance Tips 2026 (기법 개괄): https://www.utsubo.com/blog/threejs-best-practices-100-tips

> 주의: utsubo·ravespace 등 서드파티 블로그는 "WebGPU production-ready, 지금 이행"으로 공식 매뉴얼보다 낙관적이다. 상충 시 **threejs.org 공식 문서를 우선**했다.
