# 프로젝트 방향과 현재 상태

> - **상태**: 현재 계약
> - **기준일**: 2026-07-22
> - **근거**: Claude Code 프로젝트 메모리의 안정된 결정, 현재 코드, 영구 회귀 게이트

## 한 줄 방향

cheoma의 목표는 공식 three.js 채널에 소개될 만한 완성도의 절차적 한옥 데모다. 기능 수보다 **코드 품질, 플래그십 룩, 한옥 품질, 대규모 마을, 릴리스 안정성**을 함께 보존하는 것이 우선이다.

## 판단 기준

새 작업은 아래 중 하나에 직접 기여할 때 진행한다.

1. 스펙을 만족하면서 모든 관련 검사를 통과한다.
2. 의도와 소유권을 더 분명하게 만든다.
3. 동작 규칙의 중복과 변경 충돌면을 줄인다.
4. 골든아워 처마선·수묵화·한옥 근접 화면의 완성도를 높인다.
5. 대규모 마을의 측정된 병목이나 릴리스 회귀를 해결한다.

범용 월드 확장, 중국·일본 건축 확장, 앱 내 녹화 기능은 현재 범위에서 보류한다. 트윗 클립은 OS 화면 녹화로 만든다.

## 유지해야 할 결정

- 산의 빽빽한 숲은 한국 산의 핵심 룩이다. 성능 문제는 worker, instancing, LOD로 해결하며 숲을 잘라내지 않는다.
- 지형은 마을과 고정 버퍼까지만 만들고 `worldedge` 안개로 세계 끝을 마감한다.
- 헤드리스 절대 frame time은 성능 근거로 쓰지 않는다. program 수, draw call, 결정론 hash, 실제 앱 동작을 사용한다.
- 시각 작업은 수치뿐 아니라 생성 이미지를 직접 열어 도면·사진과 비교한다.
- 마을 부감은 공간을 읽는 46° 광각, 필지·hero·궁·사찰 근경은 형태와 배경 압축을 살리는 20°/18°/24°/26° 망원을 사용한다. 피사체 크기는 보상 dolly로 유지하고, 디테일 LOD·입자 휴면은 화면 등가 거리, point sprite 크기는 lens scale로 보정한다.
- 근경 DoF는 단순한 흐림이 아니라 밝은 광원이 원형 aperture image로 읽혀야 한다. 피사체 축깊이, depth-writing mesh의 기여, 전환 중 단조로운 aperture를 자동 계약으로 보존한다.
- `src/` 코어와 `app/` Svelte 경계를 유지하고 앱은 코어의 `src/api/`만 소비한다.
- 구조 이동과 기능 변경을 분리한다. hash 변화는 의도와 증거가 없으면 회귀다.

## 코드 구조 개선 상태

1차 구조 개선과 렌더/수명주기 안정화가 완료됐다. 상세 계약은 [`architecture-refactor.md`](architecture-refactor.md)에 있다.

- 공개 API: building, temple plan/full renderer, village plan/full runtime, environment, cinematic, audio, props, export.
- 순수 커널: geometry, world edge, value noise, scalar interpolation.
- 재사용 생성기: village pads, features, terrain, roads, trees, houses.
- runtime: seed window, worker client, create, handle, picking, parcel edit, light/night/snow/ambient/fauna.
- 앱 runtime: scene, post, view shift, camera framing, cinematic, village camera.
- 자동 경계: app→API, generator↛runtime, 내부↛API, core 방향, cycle 0, 순수 plan closure.
- 자동 회귀: 10개 plan golden, 네 규모 scene/pick proxy golden, sync/worker/fallback 일치, 앱 부팅·드론·보행·focus smoke.
- hot path: 확장 ghost의 숨은 완성 건물 생성을 제거했고, 필지 단건 proxy 조회와 카메라 중심점 캐시로 전체 방어 복제를 피한다.
- 생성기 수명주기: `buildBuilding`/`disposeBuilding` 쌍과 `VillageHandle.dispose()`가 독립 자원을 identity-dedupe해 회수하되 공유 `P.mats`·모듈 캐시 소유권은 보존한다. 종료된 handle은 재활성화되지 않는다.
- 렌더: 림 그룹 uniform, r185 색공간, composer DPR, Output-last 순서와 program plateau를 계약으로 고정했다. 광각↔망원 정책과 축방향 DoF, 장식물을 제외한 안정된 depth prepass, 무작위 crawl 없는 41-tap 원형 HDR 보케도 순수·실앱·고정 fixture 게이트로 분리했다.
- 종료: post/cinematic/weather/environment/audio/focus/controls/canvas가 idempotent engine teardown에 참여한다. 환경 GPU 자원과 WebAudio source/node는 실측 dispose 게이트로 고정했다.

`adapter.js`는 호환 façade, `populate.js`는 조립 순서를 보여주는 orchestration이 됐다. `engine.js`는 여전히 큰 통합 지점이지만 scene/post/카메라 runtime이 분리됐으며, 남은 village/focus 수명주기는 전용 계약 없이 억지로 나누지 않는다.

## 현재 작업

GitHub #6 보행·드론 카메라는 `camera/heading.js`의 Three 독립 각운동 컨트롤러를 공유한다. 최단각 계산은
±π에서 회전면을 고정하고, 속도뿐 아니라 각가속도도 제한한다. 자동 보행은 막다른 길에서 이동 방향을 한 프레임에
뒤집지 않고 먼저 멈춰 시선을 돌린 뒤 다시 걷는다. 보행 시작점과 경로 진행도는 입구에 가까운 주도로 끝점을
단일 기준으로 써서 카메라가 하천 사면이나 큰 오브젝트 아래로 합류하지 않는다. 드론은 명명된 패스 사이의
위치 컷을 보존하되 시선 방향을
최대 72.2°/s 안에서 이어준다. 합성 막다른 길의 반복 왕복은 브라우저 없는 빠른 게이트로, 실제 세 규모의
100초 경로와 앱 패스 체인은 별도 수치·브라우저 게이트로 확인한다.

GitHub #3 집 편집 슬라이더는 `live-edit-scheduler.js`를 단일 케이던스 소유자로 쓴다. 화면의 숫자는 모든 `input`에 즉시 반응하지만, 일반 주택 지오메트리 preview는 최신 값만 프레임에 맞춰 반영하고 최근 재생성 비용에 따라 32–96ms 사이에서 스스로 숨을 고른다. `change` 커밋은 대기 preview를 폐기하고 #19의 정확한 편집 처마·pick proxy·병합 flora를 한 번만 확정한다. 종가·관아·궁·사찰 복합체는 기존대로 커밋 시에만 재생성한다.

focus-out·필지 hop·마을 이탈·앱 dispose는 같은 scheduler epoch를 취소한다. 따라서 놓지 않은 슬라이더 값이 부감이나 다음 필지에 뒤늦게 적용되지 않고, 재진입하면 마지막 확정값으로 돌아온다. 50개 입력의 1회 병합과 취소 수명주기는 순수 게이트로, 실제 Svelte range 48개 입력→1 preview→1 flora commit·시각 변화·렌더 예산은 기존 단건 재건축 브라우저 부팅 안에서 함께 검증한다.

GitHub #19 집 편집 패널은 “다시 보기”를 제거하고 `이 집 다시 짓기`와 `내보내기`만 남긴다. 다시 짓기는 장식 애니메이션 재생이 아니라 원래 예약된 필지 안에서 경계·집 변주·담장·마당 살림·과실수를 하나의 트랜잭션으로 새로 구성한다. 결과는 focus-out 뒤에도 권위 있는 부감 오버레이로 남아 낡은 인스턴스가 되살아나지 않는다.

재건축은 `parcel-rebuild.js`의 불변 원본 envelope에서만 파생해 누적 축소를 막고, 남향 `frontDir`, 도로측 대문, 일조 통로, 정자 4.5m 지붕과 근경 카메라 시선을 보존한다. 편집된 실제 처마 bounds와 마당 hard object를 커밋한 뒤 같은 마을 seed/options로 단일 병합 flora를 다시 만들며 까치의 나무 perch도 갱신한다. 슬라이더 드래그 중에는 단일 집만 갱신하고 flora 교체는 pointer release에서 한 번 수행한다. 순수 계약과 실제 UI/카메라/LOD/프로그램·드로우콜 브라우저 게이트를 분리해 반복 검증을 가볍게 유지한다.

GitHub #5 사찰 터 재배치는 PR #43으로 `main`에 반영됐다. 산사를 강제하지 않고 평지·완경사·계류변·도성 안을 허용하며, 산과 숲의 위요감은 보너스일 뿐 필수가 아니다. temple ON plan과 scene 골든만 의도적으로 바뀌고 temple OFF 골든은 그대로 유지하는 것이 승인된 계약이다.

GitHub #15 근경 구도는 지붕 중심이 아니라 1.65–2.5m 문 높이를 조준하면서 기존 물리 카메라 높이는 보존한다. 주택 카메라의 XZ 시선은 필지의 `solarAccess` 안을 지난다. 이웃집은 실제 variant 지붕·지형 높이와 30° 저각 겨울 햇빛에서 1.5m 창 일조를 보장한다.

후속 GitHub #49는 가림의 실제 주체였던 정자를 중심선 점검에서 화면 폭 계약으로 보강한다. 정자의 공유 physical spec과 주택 지붕 실루엣을 사용해 카메라 쪽으로 좁아지는 focus envelope를 예약하며, 장승·솟대·우물·낟가리 같은 마을 소품도 높이 기반 겨울 일조와 같은 구도 판정을 소비한다. 낮은 소품과 이웃 지붕은 전경 깊이감으로 남기고, 넓은 정자 처마가 선택 집의 문·마당을 덮는 경우만 결정론적으로 다른 빈터를 고른다.

GitHub #12 복합 가람 생성기는 [`temple-generator.md`](temple-generator.md)의 계약대로 구현됐다. Three 없는 순수 local-space 계획과 Three.js 조립·dispose를 분리하고, 22–30m 암자형·36–48m 중정형·52–72m 다원형을 제공한다. 마을은 실제 직사각 footprint를 필지·도로·식생 전에 예약하며, 편집 패널은 전각 수·중정 여백·축 굴절·석탑·석등·종루·당간지주·부도를 계획 옵션으로 갱신한다. 남측 일조 통로와 26° focus 카메라는 같은 `frontDir` 계약을 쓴다.

사찰 원본 조립 트리는 편집·두부 조립용으로만 유지하고, 부감에서는 재질별 병합해 대표 다원형을 2,681콜에서 111콜로 낮춘다. 순수 계약과 독립 WebGL 수명주기/성능 게이트, 실제 앱 focus 캡처를 분리해 일상 검증은 가볍게 유지한다.

구조의 다음 후보는 palette의 canvas provider 주입과 engine village/focus controller지만, 새 기능보다 자동 검증을 먼저 추가하는 조건으로만 진행한다.

## 최근 마무리 상태

현재 Git 이력 기준으로 궁 전각 재질 공유(#149), 마을 critters(#152와 후속 LOD), BGM 복원 회귀, 모바일/개요 패널 수정(#154/#155)이 반영돼 있다. 이 문서는 changelog가 아니므로 세부 완료 목록은 Git 이력을 사용한다.

## 메모리 승격 원칙

개인 Claude Code 메모리는 작업 이력의 중요한 입력이지만 완료·폐기안, 도구별 지시, 임시 경로도 섞여 있다. 장기 규칙은 `AGENTS.md`, 이 문서, 검증 가이드, 활성 브리프로 옮기고 레포가 개인 경로에 의존하지 않게 한다.

## 갱신 규칙

- 기능이나 구조 계약이 바뀌면 같은 작업에서 이 문서와 관련 검증 문서를 갱신한다.
- 사용자 결정이 기존 항목을 뒤집으면 날짜와 이유를 남긴다.
- 코드와 문서가 다르면 실행 결과를 확인해 문서를 즉시 고친다.
