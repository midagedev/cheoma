# 에이전트 친화적 구조 계약

> - **상태**: 1차 구조 개선 완료 / 후속 개선의 기준선
> - **기준일**: 2026-07-22
> - **목표**: 동작과 결정론을 보존하면서 변경 이유가 다른 코드를 분리하고, 생성 엔진을 앱 밖에서도 재사용 가능하게 유지

## Beck 단순 설계 규칙

구조 판단은 다음 순서를 고정한다. 뒤 규칙을 위해 앞 규칙을 훼손하지 않는다.

1. **모든 검사를 통과한다.** 구조·plan·앱·worker 계약이 먼저 녹색이어야 한다.
2. **의도를 드러낸다.** 이름과 공개 계약만으로 입력, 결과, 수명, dispose 소유권을 알 수 있어야 한다.
3. **중복이 없다.** RNG 창, 좌표 변환, noise, 보간, worker 프로토콜처럼 하나의 규칙은 한 곳에만 둔다.
4. **요소가 최소다.** 줄 수를 맞추는 파일 분할, 소비자 없는 façade, 전달만 하는 계층은 만들지 않는다.

함수 이동과 동작 변경은 같은 작업에 섞지 않는다. 구조 이동 중 hash가 바뀌면 먼저 회귀로 취급한다.

## 현재 레이어

```text
src/api/                       앱과 외부 프로젝트가 보는 안정된 진입점
src/core/math/                 THREE·DOM 없는 공용 geometry/noise/scalar/world-edge 커널
src/generators/shared/         생성기들이 공유하는 좌표 변환
src/generators/village/        THREE 마을 조립: pads/features/terrain/roads/trees/houses
src/runtime/village/           생성 수명: seed window/worker/create/handle/pick/edit/light/env bridge
src/village/                   순수 plan과 아직 이동하지 않은 도메인 구현, 기존 경로 호환 shim
app/src/engine/                제품 scene 조립과 앱 전용 runtime
app/src/                       Svelte UI
```

의존 방향은 위에서 아래로 흐르지 않는다. 특히 다음 규칙은 `npm run check:architecture`가 강제한다.

- `src/`는 Svelte나 `app/`을 import하지 않는다.
- `app/src/`가 코어를 사용할 때는 `src/api/`만 import한다.
- 코어 내부 구현은 `src/api/` façade를 역으로 import하지 않는다.
- `src/generators/`는 `src/runtime/`을 import하지 않는다.
- 기존 `src/village/`에서 runtime으로 가는 경로는 `adapter.js` 호환 shim 하나뿐이다.
- `src/core/`는 상위 생성·runtime 계층을 알지 않는다.
- `src/api/village-plan.js`의 전체 dependency closure에는 THREE와 브라우저 전역이 없다.

## 완료된 구조 개선

| 영역 | 이전 | 현재 |
| --- | --- | --- |
| 마을 어댑터 | `src/village/adapter.js` 1,523줄에 worker·handle·pick·edit·환경 결합 | 2줄 호환 façade + `src/runtime/village/`의 역할별 모듈, 최대 파일 `handle.js` 약 760줄 |
| 마을 populate | `src/village/populate.js` 1,389줄에 모든 조립 구현 | 398줄 순서 orchestration + `src/generators/village/` 6개 생성기, 최대 302줄 |
| 앱 엔진 | `engine.js` 약 2,402줄에 scene/post/view shift/시네마틱/마을 카메라 포함 | 약 2,128줄 integration façade + scene/post/view-shift/cinematic/village-camera runtime |
| 공용 수학 | geometry, world edge, value noise, smoothstep가 여러 도메인에 복제 | `src/core/math/{geom2,world-edge,value-noise2,scalar}.js`가 단일 구현 소유 |
| 필지 변환 | layout이 village instancing 내부에 의존 | `src/generators/shared/parcel-transform.js`가 소유, 기존 경로는 re-export |
| 공개 경계 | 앱과 외부 소비자가 코어 내부 파일을 직접 import | 앱의 코어 import는 `src/api/*`로 한정, 정적 게이트로 고정 |
| 건물 자원 수명 | 재생성 때 geometry만 해제해 CanvasTexture가 매회 누적 | 공개 `disposeBuilding()`이 geometry·material·texture를 identity-dedupe하며, 주입된 `P.mats`와 모듈 수명 공유 소품 재질은 보존 |
| 건물 표면 깊이 | ㄱ자 기단을 직사각형 두 벌로 겹치고 장식면의 순서를 개별 오프셋에 의존 | 순수 `core/surface-clearance.js`의 기초 매입·표면 간격과 단일 오목 기단 솔리드가 보이는 면의 depth owner를 하나로 고정 |
| 확장 미리보기 | ghost 치수 확인만으로 완성 건물·재질·텍스처를 생성 후 폐기 | 순수 `nextWingPlacement`를 ghost와 실제 merge가 공유하고, 실제 건물은 merge 때 한 번만 생성 |
| 필지 단건 조회 | 내부 `Map`이 있어도 전체 proxy와 가변 객체를 매번 복제 | `getPickProxy(id)`가 한 건만 방어 복제하고, 카메라 hot loop는 동일 handle/id의 중심점을 재사용 |
| 후처리 계약 | 그룹별 shader cache 의미, 색공간, DPR, dispose가 암묵적 | 그룹 계수 uniform, r185 선형 색, renderer/composer DPR 동기화, Output-last·owned-resource teardown을 실행 가능한 계약으로 고정 |
| 앱 종료 | canvas 이벤트, post, 환경 GPU 자원, WebAudio graph가 재마운트 뒤 남음 | 이름 있는 이벤트와 idempotent `dispose()`로 listener·pass·target·environment·audio·hook·canvas를 정리 |

기존 깊은 import를 당장 깨지 않도록 아래 경로는 호환 shim으로 남겼다.

- `src/village/adapter.js`
- `src/village/geom.js`
- `src/env/worldedge.js`
- `src/village/instancing.js`의 `parcelMatrix`

레포 내부 소비가 0이어도 외부 사용 여부를 확인하기 전에는 제거하지 않는다. 새 코드는 shim 대신 공개 API나 새 소유 모듈을 사용한다.

## 공개 재사용 API

| 진입점 | 주요 계약 | 실행 환경 |
| --- | --- | --- |
| `src/api/village-plan.js` | `planVillage`, site/tier/road, 성곽 contour·사대문, 보호수·필지 focus·LOD impostor 명세, terrain-grid 높이, 지형 clip 도로 surface 순수 helper | Node, worker, browser |
| `src/api/building.js` | 건물·필지·한옥·궁 생성, layout/preset, assembly/tofu animation | THREE와 canvas provider가 있는 runtime |
| `src/api/village.js` | plan, 단계별 populate, granular village generators, sync/async handle, reroll wave | browser/worker 지원 runtime |
| `src/api/environment.js` | 순수 atmosphere profile/석양 resolver, 계절·날씨 상태, environment, focus, post, 축방향 DoF controller, 공유 적설 재질, weather, ink, time, world edge | 상태/profile은 Node/worker/browser, 나머지는 WebGL browser runtime |
| `src/api/cinematic.js` | 건물 카메라 drive, 마을 광학·dolly 정책, drone path, walker와 obstacle helper | THREE runtime; 녹화 drive는 browser |
| `src/api/audio.js` | Web Audio 환경음·음악 orchestration | browser |
| `src/api/rendering.js` | 해제 경합을 견디는 shader precompile | browser WebGL runtime |
| `src/api/ink.js` | 재사용 수묵 pass·종이 texture, Three 없는 표현 상태 | 상태는 Node/worker/browser, pass는 WebGL browser runtime |
| `src/api/props.js` | prop registry와 생성 | THREE와 canvas provider가 있는 runtime |
| `src/api/export.js` | export 분석·GLB·download·postcard | 분석 제외 대부분 browser |
| `src/api/index.js` | 전체 browser runtime façade | WebGL browser runtime |

외부 프로젝트는 bare `three`를 하나만 사용해야 한다. 이 레포처럼 alias/dedupe를 적용하거나 향후 패키징 시 `three@0.185.1`을 peer dependency로 둔다.

### 수묵 렌더 재사용 경계

수묵 렌더는 생성 계획과 표현 상태를 섞지 않는다. `src/render/ink-state.js`의 순수 상태, `src/render/ink.js`의 WebGL pass, `src/api/ink.js`의 공개 façade까지만 코어가 소유하고, 제품 전환·URL·post 휴면은 `app/src/engine/ink-mode-runtime.js`가 소유한다. shader precompile만 제공하는 가벼운 `src/api/rendering.js`에는 WebGL 수묵 import를 섞지 않는다. 외부 프로젝트는 같은 pass를 독립 composer에 삽입할 수 있으며 `OutputPass`를 마지막 하나로 유지해야 한다. 앱은 pass를 처음 진입할 때만 만들고 dispose 때 render target과 종이 texture를 함께 회수한다. 세부 미학·색공간·깊이 계약은 [`ink-landscape.md`](ink-landscape.md)를 따른다.

## 보존되는 런타임 계약

- 기존 공개 함수 시그니처와 `VillageHandle` 메서드. 단건 `getPickProxy(id)`는 기존 전체 조회를 보존하는 추가 계약이다.
- `buildBuilding()`의 기존 반환 구조. 새 `disposeBuilding(root)`는 해당 root의 소유 자원만 정리하고 외부 `P.mats`와 모듈 수명 공유 소품 재질은 건드리지 않는다.
- 기단·대지·창호처럼 맞닿는 보이는 면은 `polygonOffset`으로 덮지 않는다. `src/core/surface-clearance.js`의 월드 단위 간격을 공유하고, 가장 낮은 기초만 상단 높이 불변으로 대지 아래에 묻힌다.
- `VillageHandle.dispose()`는 내부 공유 identity를 정확히 한 번 해제하며, 종료 뒤 public method는 씬이나 자원을 다시 만들지 않는다.
- 같은 seed의 RNG 소비 순서와 sync/worker/fallback 결과.
- `populateVillageSteps`의 label과 순서.
- object `name`, `userData`, material role·identity, pick proxy framing.
- `onBeforeCompile` 등록 순서와 `customProgramCacheKey`.
- `instanceColor`, geometry winding, `instanceMatrix` normal 합성.
- 앱의 `window.__engine` API와 URL/runtime hook.
- focus overlay와 scene resource의 dispose 소유권.
- 짧게 사는 focus/wave 서브트리의 shader warm은 `src/api/rendering.js#compileSubtreeAsync`를 통한다.
  three.js 기본 `compileAsync`처럼 해제된 material의 사라진 `currentProgram`을 계속 poll하지 않으므로,
  빠른 focus-out·리롤과 GPU 링크 수명이 겹쳐도 전역 예외를 만들지 않는다.

## 개울·대하천의 계획·렌더 표면 계약

`src/village/site.js`는 제방을 포함한 계획 회랑 `streamHalf`와, ordinary creek의 실제 수면 폭
`streamWaterHalf`를 구분한다. 하곡 중심은 `-x` 흐름 방향으로 단조롭게 낮아지고, 평시 물폭은 최대 8m에서
멈춘다. 규모만 키워 개울을 암묵적으로 강으로 만들지 않는다.

해석적 `site.heightAt/streamY`와 실제 화면의 정규 격자 삼각면은 보간 때문에 미세하게 다를 수 있다.
`src/village/terrain-grid.js#streamSurfaceHeightAt`가 두 표면의 상한과 clearance를 한 번만 계산하고,
수면 ribbon과 다리가 이를 함께 소비한다. 계획 변경은 `check:layout`의 전 단면 lane/단조 경사 검사와
plan golden, 렌더 결과는 sync/Worker/fallback scene hash로 닫는다.

`river=true`는 capital/hanyang에서만 실효를 갖는 별도 대하천 문법이다. `site.js`가 수면·제방·충적 완사면·world-edge 소실을 소유하고, `river-port-plan.js`가 Three 없이 양안 나루 접근로와 남안 취락 시드를 만든다. 외곽 길을 더한 뒤 `attachRoadJunctions()`로 양방향 접합 메타데이터를 재계산하며, 포구 필지도 일반 필지의 집 fit·남향 일조·도로측 대문·식생 clearance를 그대로 쓴다. 가벼운 외부 사용은 `src/api/village-plan.js` 에서 `createSettlementRelief`, `planRiverPort`, `terrainRangeOnPolygon`, `attachRoadJunctions`를 소비한다.

## 보기별 줌과 디테일 LOD 계약

한양처럼 큰 장면의 주택과 생활 디테일은 서로 다른 임계값을 임의로 판독하지 않는다. 순수 정책은
`src/village/lod-policy.js`, 카메라·시선 셀 상태 계산은 `src/runtime/village/detail-lod.js`, 실제 필지
표현 소유권은 `src/runtime/village/parcel-representation.js`가 각각 한 번만 소유한다.

- 줌 거리와 선택 상태는 직교한다. 휠/핀치는 `explore`/`focus` 내부의 거리만 바꾸고 모드 전환을 일으키지
  않는다. `src/camera/optics.js#villageZoomReferenceBounds`가 규모별 둘러보기 최소 거리와 두 보기의 최대
  거리를 화면 등가 단위로 소유하며, 앱 runtime은 현재 렌즈의 실제 dolly로 한 번만 변환한다. 선택을 유지한
  넓은 집 보기에서는 `villageFocusEffectWeight`가 근경 DoF만 단조롭게 0으로 내려 Bokeh pass를 쉬고,
  `villageFocusContextElevation`이 정자·높은 공공 오브젝트와 공유하는 남측 일조축을 유지한 채 31° 부감으로
  크레인 업해 넓어진 시야의 전경 차폐를 넘는다.
- 한양의 모든 정규 주택은 `FAR mass → MID envelope → FULL` 세 단계다. FAR는 실제 variant의
  치수·평면·지붕 종류와 역할별 팔레트에서 파생하고, MID는 별도 근사 모델이 아니라 실제 빌더의
  외피 geometry·material만 재사용한다. 중앙을 포함해 청크마다 세 root 중 하나만 보인다.
- focus overlay가 나타나는 순간 해당 필지의 FAR, MID, FULL, 병합 담을 함께 접는다. 카메라 전환이 끝나기
  전이나 focus hop 중에도 `base/overlay` 두 집이 겹치지 않으며, focus-out 때 현재 청크 단계 하나만 복원한다.
- 사용자가 다시 지은 정규 필지는 예외적으로 focus-out 뒤에도 overlay가 부감 표현의 권위 있는 소유자다.
  `src/village/parcel-rebuild.js`가 원래 예약 필지에서 새 계획을 만들고, runtime은 pick proxy·카메라 framing·
  실제 편집 처마 footprint·병합 flora를 한 커밋으로 갱신한다. 저장된 편집 소유권과 현재 focus 앰비언스
  제외 상태를 같은 Map으로 표현하지 않는다.
- Svelte의 연속 range 입력은 `app/src/lib/live-edit-scheduler.js`가 소유한다. 앱 컴포넌트는 최신 편집값만
  보유하고 scheduler가 적응형 preview와 단일 commit, focus epoch 취소를 담당한다. 코어는 UI 이벤트나
  rAF를 알지 못하며, slider commit만 기존 `rebuildParcel()` 트랜잭션으로 들어간다.
- 소동물·필지 앰비언스·꽃잎/낙엽은 절대 `camera.position.y` 대신 `controls.target`의 지형 높이에 대한
  상대 고도와 시선 거리를 공유한다. 지상 개체는 현재 시선 셀 주변만 갱신하고 원경에서는 mesh와 CPU
  시뮬레이션을 함께 쉰다. 하늘의 새 떼와 시간대·fog 전이는 부감에서도 유지한다.
- 광각↔망원 전환의 보상 dolly가 실제 카메라 거리를 바꾸더라도 생활·입자 LOD는
  `src/camera/optics.js`의 화면 등가 거리로 판단한다. 같은 화면 크기의 소동물·모트·낙엽이 망원 전환만으로
  일찍 꺼지지 않으며, 실제 거리와 등가 거리는 debug 상태에서 구분한다.
- populate가 이미 배치한 마당 닭은 focus에서 숨겼다가 다른 무리로 바꾸지 않고, 같은 객체를
  거리 LOD로 깨워 계속 쓴다. base flock이 없는 필지만 focus ring이 닭을 만들어 같은 마당에
  두 무리가 겹치지 않는다. 별도 exclusion/lease 상태는 존재하지 않는다.
- scene 직속인 비선택 필지 앰비언스도 `village-ambient-wave-owner` bridge로 마을 root의 wave multiplier를
  받는다. 새 핸들은 전체 마을 모드를 넘겨받기 전에 이 앰비언스만 사전 연결해, 집·지형이 교체되는 동안
  옛 필드가 따로 남거나 새 연기·모트·등롱이 완료 프레임에 한꺼번에 나타나는 별도 수명 주기를 만들지 않는다.
  새 필드의 PointLight 풀과 전역 lookahead 소유권은 옛 필드가 해제되는 승격 프레임까지 지연해, 웨이브 중
  scene light 개수와 shader variant가 늘어나지 않는다.
- 정적 scenery(지형·개울·논·도로·필지·수목)는 재질 페이드를 하지 않고 먹안개가 100%인 한 프레임에
  old→incoming 가시성을 배타적으로 넘긴다. 그림자도 같은 veil의 보수로 1→0→1을 따라 이중 필지·도로·그림자가
  한 프레임에 공존하지 않는다. 건물·궁·사찰·성곽만 두부 transform wave를 탄다.
- 소동물·새·입자·야간 광원은 `userData.waveFade` controller에서 거리/focus/wave 가중치를 곱해 소유권을
  합성한다. 중간 값은 고정 uniform 또는 미리 컴파일한 `alphaHash`로 표현하고, 런타임에 `transparent`/
  `depthWrite`를 토글해 새 program·투명 정렬 경로를 만들지 않는다.
- 임계값을 소비자 파일에 복제하지 않는다. 새 근접 디테일은 `createVillageDetailLodState` 또는
  `villageDetailWeightAt`을 소비하며, 새 주택 표현은 `setParcelBaseHidden`의 단일 소유권 전환에 합류한다.
- 규모 wave의 비동기 build부터 애니메이션 완료까지는 하나의 busy 수명이다. 이 동안 focus·zoom·hover를
  잠그고, old/incoming 핸들에 시간·계절·날씨를 같은 프레임에 적용한다. 취소·이탈은 pending
  토큰, reframe tween, fog/그림자 presentation, incoming root를 함께 회수해 늦게 완성된 핸들이 재승격되지 않게 한다.
- GLB export는 현재 카메라 LOD와 focus 은닉 상태를 읽지 않는다. 인스턴스 행렬·병합 정점의
  pristine snapshot에서 `FULL` 또는 `FAR`를 선택하고 `village-overrides`를 제외해, 같은 옵션의 export가
  사용자의 현재 화면에 따라 달라지지 않는다.

순수 경계·히스테리시스·variant 계약은 `npm run check:lod`, 실제 앱의 한양 focus-in/hop/out 프레임별
배타성과 동물 sleep/wake·wave 수명은 `npm run check:lod:app`으로 검증한다. `window.__engine.village.debugLod()`는
정책값이 아니라 실제 root 가시성과 필지별 은닉 핸들을 읽어 실패 필지를 반환한다.

`tools/check-worker-contract.mjs`는 네 규모의 scene graph와 pick proxy 골든 hash, 실제 Worker 메시지, async 단계 순서를 함께 고정한다. 구조 이동 뒤 이 값은 갱신 대상이 아니라 보존 대상이다.

## 광학과 DoF 계약

마을의 연속 구도와 focus 전환의 시각 언어·초점 계산은 생성기나 앱 전환마다 복제하지 않는다.

- `src/camera/optics.js`가 부감 46° 광각, 일반 필지 20°·hero 18°·궁 24°·사찰 26° 망원과 피사체 화면 크기를 보존하는 dolly 변환을 소유한다. 궁·사찰처럼 FOV만으로 종전 구도를 추론할 수 없는 렌즈는 `referenceFov`를 framing→tween→camera LOD로 명시 전달한다. 소동물·강수·낙엽의 휴면은 화면 등가 거리를, point sprite 크기는 별도 lens scale을 사용한다.
- `src/env/dof.js`가 월드 초점점을 카메라 전방축 깊이로 변환하고 DoF enable·amount·aperture를 한 controller에서 소유한다. focus-in/out은 선택 필지 축깊이를 붙들고, 필지 hop은 보간되는 시선을 따라간다.
- `StableBokehPass`의 깊이 패스에는 depth를 쓰는 mesh만 참여한다. Points·Line·Sprite·`depthWrite=false`·`userData.dofDepth=false` 객체는 제외하고, `instFade` 수목은 color와 depth에서 같은 dither 함수를 공유한다. stock override depth가 opacity dither를 재현하지 못하므로 중간 opacity의 `alphaHash` 재질은 완전 불투명 occluder로 쓰지 않고, 가중치 1에서만 일반 depth에 합류한다. 임시 가시성·재질·override·배경은 한 프레임 안에서 복원한다.
- 근경 색 합성은 중심 1개와 8/12/20개 동심원, 총 41개의 고정 표본을 쓴다. stock과 같은 color-fetch 예산 안에서 화면 좌표 난수 없이 원형 aperture와 패닝 안정성을 확보하고, 탭별 판정 대신 평균 뒤 한 번만 HDR 광원 격리를 판정한다. 0.45 device-pixel 미만 blur는 한 번의 color fetch로 조기 반환한다. out-of-focus 픽셀의 ALU는 stock보다 많지만 새 post pass나 draw call은 없고, 저성능 경로에서는 DoF 자체를 건너뛴다. 중앙 depth 기반 gather라 초점면 불투명 표면과 정확히 겹친 전경 광원은 원판으로 산란하지 못하며, 이를 고정 fixture로 기록한다.

화각·dolly·LOD 등가는 `npm run check:lod`, 순수 축깊이·셰이더 계약은 `npm run check:dof`, 실제 46°→20° 제품 전환과 한 번의 depth prepass는 `npm run check:dof:app`으로 검사한다. 자연 장면은 `npm run shoot:dof`, 원형비·정지 동일성·저속 패닝은 `npm run shoot:bokeh` 산출물을 직접 열어 검증한다.

## 계절·날씨와 적설 재사용 계약

`src/env/environment-state.js`가 계절·날씨 호환성과 가중 장면 목록을 Three·DOM 없이 소유한다. 앱 seed, 환경 다이얼, 엔진 setter는 이 모듈을 공유하며 서로 호환되지 않는 눈·비 조합을 각자 보정하지 않는다. `setupEnvironment()` 하나가 계절 지형·식생·논·능선을 소유하고 샘플 페이지도 별도 `setupSeasons()`를 중첩하지 않는다.

`src/env/snow-material.js`는 단독 건물과 대규모 마을이 함께 쓰는 적설 shader patch다. `surface/tile/thatch/terrain/foliage` profile은 uniform만 달리해 재질 종류마다 shader source를 복제하지 않고, InstancedMesh의 월드 노멀과 위치에는 `instanceMatrix`를 합성한다. 눈발과 표면 축적은 분리하되 지붕·지형·식생·외부 소품·원경 능선이 하나의 축적 시계를 소비한다. 외부 소비자는 `src/api/environment.js`에서 순수 상태와 적설 patch를 사용할 수 있다.

순수 상태는 `npm run check:environment`, 실제 적설 범위·휘도·program/draw 예산은 `npm run check:winter:app`으로 검증한다.

## 하늘과 석양 재사용 계약

시간대별 하늘·광원·안개·post 수치는 `src/env/atmosphere-profiles.js`가 Three와 DOM 없이 소유한다. `sky.js`와 `post.js`가 각자 색표를 복제하지 않고 같은 profile key를 resolve하며, 외부 소비자는 `src/api/environment.js`에서 프로필과 resolver를 사용할 수 있다. 석양 스타일의 seed 선택은 앱 seed의 독립 fork라 village/worker 생성 순서를 오염시키지 않는다.

가시성과 그림자는 두 구름 레이어로 분리한다.

- 네 장의 월드 상공 구름은 지형 셰이더의 `uCloudBlobs`와 정확히 같은 위치를 사용한다. 카메라가 너무 가까워 거대한 판으로 보일 때는 billboard만 감쇠하고 그림자 데이터는 유지한다.
- 16개 원경 적운은 하나의 `InstancedMesh`다. translation은 sky dome처럼 카메라를 따르지만 azimuth는 월드에 고정돼 회전하면 다른 구름이 나타난다. 이 레이어가 근경 실루엣, HDR rim, 달의 alpha 가림, 구름 틈 빛줄기를 맡는다.
- sky dome과 달은 `environment` 지형 그룹이 아니라 scene-level `sky-atmosphere`가 소유한다. 마을 모드가 단일건물 지형을 숨겨도 하늘은 끊기지 않으며, enable/dispose는 environment lifecycle이 명시적으로 정리한다.

일반 필지 focus는 순수 계획의 남측 접근·건물 비례 3.0–5.6m 인방/처마 target·1.35m 마당 눈높이를 유지한다. 각도 기준이 아니라 월드 높이 기준이므로 큰 필지나 망원 dolly에서도 카메라가 부감으로 떠오르지 않고 처마와 하늘을 올려다본다. 앱의 `view-shift.js`는 UI 패널 offset과 별개인 -18% 수직 composition을 같은 비대칭 frustum에 합성해 능선 위 하늘을 연다. focus hop/in/out, 리롤, 옵션 변경은 이 값을 같은 카메라 timeline에서 보간하거나 0으로 초기화한다. `check:atmosphere`가 프로필·태양방향을, `shoot:sky`가 실제 앱 픽셀·구름/달/광선·draw call을 검사한다.

## 병렬 작업 소유권

| 작업 레인 | 기본 소유 경계 | 통합 시 공유 계약 |
| --- | --- | --- |
| 순수 village plan | `src/village/{site,roads,parcels,plan,variants}`와 `src/core/math` | plan fixture, RNG |
| 건물 생성 | `src/builder`, building 관련 `src/layout` | `params.js`, material role |
| village 생성 | `src/generators/village` | populate step order, object metadata |
| village runtime | `src/runtime/village` | `VillageHandle`, worker protocol |
| 환경·post | `src/env` | shader/material hooks |
| 앱 integration | `app/src/engine` runtime과 `App.svelte` | `window.__engine` |
| 검증 | `tools/check-*`, 도메인 harness | golden fixture와 문서 |

병렬 작업자는 같은 대형 파일의 서로 다른 구간을 동시에 고치지 않는다. façade나 fixture 변경은 구현 레인의 결과가 통과한 뒤 통합 단계에서 한 번에 수행한다.

## 현재 남은 개선 후보

다음 파일은 크지만 줄 수만으로 분할하지 않는다.

| 파일 | 현재 줄 수(근사) | 다음 안전 조건 |
| --- | ---: | --- |
| `app/src/engine/engine.js` | 2,128 | village/focus lifecycle의 명확한 상태기계 계약과 전용 앱 하네스가 있을 때 추가 추출 |
| `src/builder/palette.js` | 899 | canvas/texture provider 주입과 material/shader identity 검사 마련 후 분리 |
| `src/env/post.js` | 873 | pass 순서·program plateau·대표 픽셀 게이트는 마련됨. 실제 재사용 소비자가 pass 단위 소유권을 요구할 때만 추가 분리 |
| `src/builder/roof.js` | 826 | 지붕 유형별 geometry hash와 근접 시각 게이트 마련 후 분리 |
| `src/env/critters.js` | 817 | proto/배치/애니메이션별 수치·시각 계약 마련 후 분리 |
| `app/src/App.svelte` | 785 | UI 상태 소유권을 먼저 명시한 뒤 화면 orchestration 분리 |

가장 자연스러운 후속 순서는 palette의 browser 의존 주입, engine의 village/focus controller, façade를 사용하는 최소 외부 예제, 마지막으로 `@cheoma/core`·`@cheoma/three` 패키지 manifest다. 현재 검증보다 위험한 이동은 먼저 게이트를 추가한 뒤 수행한다.

## 완료 판정

이번 1차 구조 개선은 다음을 만족한다.

- `adapter.js`와 `populate.js`의 다중 책임이 generator/runtime 경계로 이동했다.
- 앱과 외부 소비자의 공개 진입점이 마련됐고 정적 경계 검사가 이를 강제한다.
- 순수 plan, 전체 scene, pick proxy, 실제 Worker, 앱 부팅·카메라·focus에 영구 회귀 게이트가 있다.
- 대표 계획과 전체 마을 골든 결과가 구조 이동 전과 같다.
- 남은 대형 모듈은 검증 없이 억지로 쪼개지 않고 위험과 선행 조건을 문서화했다.

새 기능 작업은 이 기준선 위에서 진행할 수 있다. 이후 구조 개선도 같은 Beck 순서와 검증 매트릭스를 반복한다.
