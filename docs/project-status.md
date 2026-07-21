# 프로젝트 방향과 현재 상태

> - **상태**: 현재 계약
> - **기준일**: 2026-07-21
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

- 공개 API: building, village plan/full runtime, environment, cinematic, audio, props, export.
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

## 현재 대기 작업

[`SANSA-HANDOFF.md`](../SANSA-HANDOFF.md)의 산사 재배치는 아직 착수 전이다. 이 작업은 temple ON plan과 scene 골든을 의도적으로 바꾸므로 구조 개선과 별도 변경으로 진행한다. temple OFF 골든은 그대로 유지해야 한다.

구조의 다음 후보는 palette의 canvas provider 주입과 engine village/focus controller지만, 새 기능보다 자동 검증을 먼저 추가하는 조건으로만 진행한다.

## 최근 마무리 상태

현재 Git 이력 기준으로 궁 전각 재질 공유(#149), 마을 critters(#152와 후속 LOD), BGM 복원 회귀, 모바일/개요 패널 수정(#154/#155)이 반영돼 있다. 이 문서는 changelog가 아니므로 세부 완료 목록은 Git 이력을 사용한다.

## 메모리 승격 원칙

개인 Claude Code 메모리는 작업 이력의 중요한 입력이지만 완료·폐기안, 도구별 지시, 임시 경로도 섞여 있다. 장기 규칙은 `AGENTS.md`, 이 문서, 검증 가이드, 활성 브리프로 옮기고 레포가 개인 경로에 의존하지 않게 한다.

## 갱신 규칙

- 기능이나 구조 계약이 바뀌면 같은 작업에서 이 문서와 관련 검증 문서를 갱신한다.
- 사용자 결정이 기존 항목을 뒤집으면 날짜와 이유를 남긴다.
- 코드와 문서가 다르면 실행 결과를 확인해 문서를 즉시 고친다.
