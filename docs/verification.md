# 검증 가이드

> - **상태**: 현재 계약
> - **기준일**: 2026-07-20

이 프로젝트에는 전통적인 unit-test/lint/typecheck 프레임워크가 없다. 대신 빠른 정적·golden 계약, 실제 Worker, 전체 앱 Playwright smoke, 도메인별 시각 하네스를 위험에 맞게 조합한다.

## 기본 준비

루트 `package.json`은 Playwright와 PNG 전후 비교(`pngjs`) 도구용이고 `app/package.json`은 SPA용이다. 도구 버전은 lockfile과 함께 고정한다.

```bash
npm install
cd app && npm install
```

추가 dev 서버는 사용자의 서버를 건드리지 않고 `127.0.0.1`, 임시 포트, 고유 Vite `cacheDir`를 사용한다. 영구 `check:*` 도구는 이 격리를 스스로 수행한다.

## 표준 명령

```bash
npm run check               # 구조 + 10개 plan golden, 약 수초
npm run check:app           # 실제 Vite 앱 Playwright smoke
npm run check:worker        # sync/Worker/fallback 전체 마을 계약
npm run check:audio         # 실제 Web Audio 생성·종료 수명주기 계약
npm run check:all           # 위 네 게이트 순차 실행
```

영향 범위가 넓은 구조 변경은 `check:all`을 사용한다. 앱 배포 경계를 건드렸으면 production build도 별도로 실행한다.

```bash
cd app
npm run build
```

clean snapshot이 필요하면 사용자 dev server와 기존 산출물을 건드리지 않는 임시 `outDir`를 사용한다. 반복 incremental build를 같은 별도 outDir에 덮어쓰면 boot-time uniform 오류가 날 수 있다.

## 영구 게이트

### `npm run check`

`tools/check-fast.mjs`가 다음을 순서대로 실행한다.

- `check:architecture`
  - `src/`→Svelte/app 금지.
  - 앱의 코어 import는 `src/api/`로 한정.
  - 코어 내부→public façade 역참조 금지.
  - generator→runtime 금지, 기존 village→runtime은 adapter shim만 허용.
  - 상대 import 해석, `src/` cycle 0, core 방향 검사.
  - `village-plan` dependency closure의 THREE·DOM·browser 전역 금지.
- `check:plan`
  - hamlet/village/town/capital/hanyang × temple OFF/ON 10개 전체 plan SHA-256.
  - 같은 입력 반복 결정론.
  - 전역 `Math.random` 미사용.
  - 입력 옵션 불변.

plan 기준값은 `tools/plan-contract.json`에 있다. 의도된 기능 변경도 실제 데이터 diff를 검토한 뒤 fixture를 갱신한다. 산사 변경에서는 temple ON 사례만 변할 수 있다.

### `npm run check:app`

`tools/check-app-smoke.mjs`는 임시 cache와 포트로 실제 Svelte/Vite 앱을 부팅해 다음을 확인한다.

- URL seed/scale이 plan에 도달하고 village scene과 canvas가 생성된다.
- 마을 부감 거리, zoom hysteresis, near plane 값이 유효하다.
- 명명된 drone path 시작·중단과 walker 초기화가 된다.
- hero parcel과 focus detail overlay가 공개 앱 API로 연결된다.
- 시간·계절·날씨 setter 호출 중 browser error가 없다.
- 환경 OFF/종료가 Texture 배경과 FogExp2의 객체·타입·정밀한 조명 값을 원상 복원한다.
- full-app pass가 `Render → Grade/Rim → Bloom → Bokeh → Flare → Outline → Output` 순서이며 Output이 마지막이다.
- 단일 건물 타입 변경이 공용 카메라 framing 경로를 사용해 예외 없이 완료된다.
- 확장 ghost가 실제 merge와 같은 순수 배치를 쓰고 숨은 canvas/건물 생성을 하지 않는다.
- `disposeBuilding()`이 주입된 `P.mats`를 보존하며, 보이는 초가를 6회 재생성해도 GPU texture 수가 plateau를 유지한다.
- 엔진 종료가 환경의 geometry/material/texture를 정확히 한 번씩 해제하고 environment group을 scene에서 분리한다.
- `engine.dispose()`를 두 번 호출해도 안전하고 canvas와 엔진 소유 debug hook(`__season` 포함)이 남지 않는다.

### `npm run check:audio`

`tools/check-audio.mjs`는 실제 Web Audio 노드의 `start/stop`, `connect/disconnect`를 계측한다. 종료 시 모든 시작 소스와 연결 노드가 짝을 이루어 정리되고, 이중 `dispose()`와 종료 후 public API 호출이 새 오디오 그래프를 만들지 않는지 확인한다. 오프라인 종·개울 합성의 RMS도 검사해 무음 회귀를 막는다.

Headless ANGLE은 shader link 중 render frame이 매우 느릴 수 있다. 따라서 이 빠른 smoke는 1.9초 tween이 wall clock 1.9초 안에 끝난다고 단언하지 않고, 동기 상태 설정과 유한한 계약값을 검사한다. 타임아웃 진단이 필요하면 `CHEOMA_APP_SMOKE_TIMEOUT_MS`를 임시로 낮출 수 있다.

### `npm run check:worker`

`tools/check-worker-contract.mjs`는 실제 module Worker가 동작하는 임시 Vite 서버를 만들고 village/town/capital/hanyang에서 다음을 비교한다.

- 동기 `createVillage`.
- `createVillageAsync` 실제 Worker 경로.
- `createVillageAsync`의 `?worker=0` fallback.
- 전체 scene graph 구조, geometry, instance buffer, 기본 material hash.
- pick proxy bbox·center·dims·spec·framing hash.
- 단건 `getPickProxy(id)`와 전체 descriptor의 동일성, 없는 ID의 `null`, 반환 Box/Vector의 방어 복제.
- `VillageHandle.dispose()`가 sync/async 각각의 소유 자원을 정확히 한 번 해제하고 모듈 공유 재질은 보존하며, 이중 종료와 종료 후 재진입·detail/debug API가 불활성인지 확인한다.
- `populateVillageSteps` label과 순서.
- 실제 Worker 생성 수와 성공 메시지 수.

현재 골든 scene/proxy hash는 도구 안에 명시돼 있다. sync/async끼리 같더라도 골든과 다르면 실패한다. 이 값은 구조 이동 때 갱신하지 않는다.

## 문법과 API 번들

변경 파일의 빠른 문법 검사는 esbuild를 사용한다.

```bash
npx esbuild src/village/plan.js --bundle --format=esm --outfile=/dev/null
```

루트에는 `three`가 없고 앱에만 설치돼 있으므로 전체 공개 façade만 확인할 때는 peer 의존으로 제외한다.

```bash
npx esbuild src/api/index.js --bundle --format=esm \
  --external:three '--external:three/*' --outfile=/dev/null
```

이 검사는 export 충돌과 문법을 확인하지만 browser runtime을 대신하지 않는다.

## 도메인 하네스

가장 가까운 `tools/*.mjs`를 plain `node`로 실행한다. 각 도구의 주석과 실제 구현을 먼저 읽고 범위를 과대평가하지 않는다.

| 도구 | 현재 용도 | 한계 |
| --- | --- | --- |
| `tools/check-determinism.mjs` | 일부 plan 반복성 보조 검사 | worker·forest·temple 전체 계약이 아니다. |
| `tools/verify-solo-app.mjs` | 외딴집·절 단독 populate와 browser error | 전체 앱·worker 검사가 아니다. |
| `tools/verify-cine.mjs` | drone path와 walker 수학 | 앱 배선은 확인하지 않는다. |
| `tools/verify-cinewire.mjs` | 앱 시네마틱·GLB·focus 장시간 배선 | 전용 production outDir를 먼저 만들어야 하고 headless에서 오래 걸린다. |
| `tools/check-audio.mjs` | 합성음 RMS, 시간·날씨·BGM 배선, source/node teardown | 공유 `AudioContext` 자체는 닫지 않으며 시작/정지·연결/해제 identity를 비교한다. |
| `tools/verify-rim101.mjs` | 림 재질군 uniform, 제외 규칙, shader 오류, program plateau | 미학적 강도와 색은 이미지 직접 판정이 필요하다. |
| `tools/shoot-flare.mjs` | flare ON/OFF 기여량, 시간·날씨 소멸, 대표 골든아워 컷 | 베이스 씬의 미세 비결정성이 있어 절대 픽셀 동일성보다 ON/OFF 차이와 직접 비교를 본다. |
| `tools/shoot-templesite.mjs` | 산사 위치·낙차·backdrop·draw call과 이미지 | 동기 populate 경로이며 `mode=old`는 직전 before가 아니다. |
| `tools/shoot-forest.mjs` | 인스턴스 숲 부감·능선·계절 시각 | 산사 수치와 Worker 일치는 별도 검사한다. |
| `tools/shoot-relief.mjs` | 지형 기복·패드 접지·축대·물 시간대 | 산사 path/mask는 별도 확인한다. |
| `tools/verify-forest.mjs` | 폐기된 캐노피 쉘 이력 | 현재는 실패 예상이므로 실행하지 않는다. |

## 시각·성능 판정

에이전트는 생성 PNG를 직접 열어 관통, 실루엣, 숲 프레이밍, 길의 연속성을 본다. 수치 통과는 미학적 통과를 대신하지 않는다. 렌더 도구의 임시 파일은 OS 임시 디렉터리를 쓰고 개인 Claude scratch 경로를 하드코딩하지 않는다.

Headless ANGLE은 shader link를 직렬화하므로 절대 frame time을 실제 성능 수치로 인용하지 않는다. program 수 변화, draw call, 결정론 hash, 오류 수를 우선한다. 임시 이미지는 scratch 경로에 두고, 영구 하네스가 명시한 gate 산출물이 아니면 기존 `shots/` 증거를 덮어쓰지 않는다.

## 변경 유형별 최소 매트릭스

| 변경 | 최소 게이트 |
| --- | --- |
| 순수 plan·수학 | `npm run check`, 관련 수치 하네스 |
| village generator/runtime/worker | `npm run check:all`, 필요 시 대표 시각 하네스 |
| 앱 engine/UI | `npm run check`, `npm run check:app`, production build |
| shader/material/post/roof | 위 게이트 + program count와 고정 시드 이미지 직접 판정 |
| 산사 배치 | 아래 산사 매트릭스 + `check:all` |

## 산사 작업 검증 매트릭스

[`SANSA-HANDOFF.md`](../SANSA-HANDOFF.md)를 구현할 때 최소한 다음을 남긴다.

| 항목 | 규모/경로 | 통과 기준 |
| --- | --- | --- |
| 문법 | 변경한 plan/generator/forest 파일 | esbuild exit 0 |
| 위치 수치 | village, capital 및 추가 seed/scale | 목표 표고·반경, footprint 낙차, backdrop을 브리프와 비교 |
| 시각 | aerial, temple, focus | 관통 없음, 단일 거대 선반 없음, 숲 프레이밍, 연속 진입로 |
| 성능 | village | render calls < 1000, 진입로 신규 ≤ 2 calls |
| 절 OFF 회귀 | 같은 seed | 기존 base plan golden 불변 |
| 결정론 | sync / Worker / fallback | 전체 scene와 proxy 계약 일치, 의도된 temple 골든만 갱신 |
| 런타임 | 앱과 하네스 | pageerror 0, console-error 0 |

before/after는 같은 코드 경로, seed, `mode=current`로 보관한다. `mode=old`를 이번 작업의 before로 쓰지 않는다.
