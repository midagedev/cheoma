# 프로젝트 방향과 현재 상태

> - **상태**: 현재 계약
> - **기준일**: 2026-07-24
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

장기 이슈는 독립 worktree와 겹치지 않는 file/prefix claim으로 병렬화한다. 구현 레인과 공유 façade·golden·문서
통합 레인을 분리하고, 인계 뒤 diff·회귀·시각 결과를 다시 검토한다. 반복 단계는 영향받은 순수 계약과 browser
게이트만 실행하고, 전체 계약은 머지 직전에 한 번 실행한다. 생성·claim·검증·인계·안전 정리는
[`agent-workflow.md`](agent-workflow.md)를 따른다.

이 규칙은 장기 Goal의 실행 계약이다. 후속 이슈는 영향 기반 `check:pr`로 가장 싼 실패를 먼저 찾고, 서로 겹치지
않는 claim/worktree 청크만 병렬화하며, 검증 실행기를 통한 browser 작업은 공용 레인에서 직렬화한다. 자동 게이트
뒤에는 필요한 직접 시각 판정을 하고, 최종 변경이 끝난 동일 HEAD에서 `check:full` 성공 1회를 남긴 뒤 PR을 머지한다.

범용 월드 확장, 중국·일본 건축 확장, 앱 내 녹화 기능은 현재 범위에서 보류한다. 트윗 클립은 OS 화면 녹화로 만든다.

## 유지해야 할 결정

- 산의 빽빽한 숲은 한국 산의 핵심 룩이다. 성능 문제는 worker, instancing, LOD로 해결하며 숲을 잘라내지 않는다.
- 지형은 마을과 고정 버퍼까지만 만들고 `worldedge` 안개로 세계 끝을 마감한다. 수평
  `edge-mist-ring`은 아이레벨에서만 지형 끝을 감싸고, 아래보기 10°부터 연속 감쇠해 18° 부감에서는
  사라진다. 근경·부감의 원경 대기는 별도 수직 `ridge-mist`와 지형 edge haze가 계속 소유하므로 넓은
  투명 환형 메시를 지형 위의 흰 막으로 남기지 않는다.
- 헤드리스 절대 frame time은 성능 근거로 쓰지 않는다. program 수, draw call, 결정론 hash, 실제 앱 동작을 사용한다.
- 시각 작업은 수치뿐 아니라 생성 이미지를 직접 열어 도면·사진과 비교한다.
- 시각·동작 구현은 물리적인 월드 지오메트리·깊이·광학을 기본값으로 삼는다. Points·impostor·screen-space 근사는 측정된 성능 이득이 충분히 클 때만 쓰고, 근경의 물리 단계와 화면 크기 연속성을 보존하며 그 예외를 도메인 문서와 게이트에 남긴다.
- 강수·꽃잎·낙엽 같은 디테일 입자는 동일한 결정론 상태를 한 개의 물리 월드 지오메트리가 소비하고, 색과 DoF depth가 같은 변위·회전·활성 조건을 공유하며 원경에서는 simulation과 draw를 함께 쉰다. Points/FAR 복제 경로는 제품 카메라 ABBA에서 최대 `0.059ms`, 16.7ms frame의 `0.35%` 이하 차이만 보여 유지하지 않는다. 실제 폭은 눈 `1.3–3.2cm`, 봄 꽃잎 `2–5.4cm`, 가을 낙엽 `6–12cm`다.
- 마을 부감은 공간을 읽는 46° 광각, 일반 필지·hero·궁·사찰 근경은 형태와 배경 압축을 살리는 10°/7°/24°/26° 망원을 사용한다. 24mm 세로 센서 환산으로 일반 필지는 약 137mm, hero는 약 196mm라 200mm급 망원 인상을 낸다. 23°/21° reference FOV에서 보상 dolly해 피사체 크기를 유지하고, 디테일 LOD·입자 휴면은 화면 등가 거리로 계산한다. 먼 망원 카메라가 산을 통과하더라도 평소에는 거리를 줄이거나 actual FOV를 넓히지 않는다. 실제 terrain-grid 삼각형과 카메라를 향한 집 앞면 3×3 표본을 정확히 교차해 가장 깊은 전경 지형 뒤로 하나의 camera near plane을 옮기되, 가장 가까운 집 표면 앞에는 최소 1.2m를 남긴다. 이 투영 절단면을 focus-in·reveal·휠·복원 모두에서 최종 카메라 writer 뒤에 갱신하므로 색·물리 입자·DoF/수묵 depth·숲이 같은 공간을 보고, 새 재질·pass·target·draw call은 없다. 절단면이 집에 닿는 예외에서만 실제 카메라를 첫 지형 안전 구간으로 당긴다. 따라서 `capital/7/p31`은 62m 거리와 10° 망원 압축을 유지한 채 약 34m 앞 능선만 자르고, 집 앞면은 약 59m에 남는다. 7° 최초 종가 진입은 일반 10°와 별도로 계산한다. 강수·꽃잎·낙엽·mote·한지 실용광은 실제 월드 크기를 가지며 authored camera projection으로만 화면 크기가 변한다.
- 일반 필지 근경은 남측 일조축 안의 정확한 24° 카메라 고도와 1.65–2.5m 문 높이 조준을 유지한다. 초기 10° 카메라 고도에서 마당과 생활 소품을 더 보여 달라는 연속 사용자 검수에 따라 12°·14°·16°·18°·20°·22°를 거쳐 24°로 올렸으며, 별도 수직 composition은 0으로 두어 집과 전경 마당을 화면 밖으로 밀지 않는다.
- 근경 DoF는 단순한 흐림이 아니라 밝은 광원이 원형 aperture image로 읽혀야 한다. 제품 근경은 `0.00020`의 한 물리 aperture 계수를 쓰고, 보상 망원 dolly가 국소 축깊이 차이를 보존하므로 카메라 거리로 다시 배율하지 않는다. 피사체 축깊이, depth-writing mesh의 기여, 전환 중 단조로운 aperture를 자동 계약으로 보존한다. 주거 focus의 의미 초점은 카메라 조준점이나 움직이는 문짝이 아니라 고정된 주출입문 개구면 중심이다. overlay 진입·필지 hop·재건축·재굴림에서만 그 세계점을 원자적으로 갱신하고, focus-in은 조준점→문, hop은 문→문을 카메라와 같은 easing으로 잇는다. focus-out은 효과가 0이 될 때까지 출발 문을 고정한다. 주 전각이 불명확한 복합체만 기존 조준점으로 안전하게 물러난다.
- GitHub #14부터 줌과 선택은 분리한다. `둘러보기`에서 휠·핀치로 집 가까이 내려가도 자동 선택하지 않으며,
  `집 보기`는 이웃까지 보이도록 넉넉히 줌아웃해도 선택·편집·DoF 컨텍스트를 유지한다. 집 클릭/집 보기만
  진입하고 마을 브레드크럼·ESC·둘러보기만 복귀한다. 한양의 최소 줌 거리도 도시 반경에 끝없이 비례하지
  않도록 화면 등가 24m에서 상한을 둔다. 선택을 유지한 넓은 문맥에서는 근경 보케만 단조롭게 사라져 마을이
  선명해지고 Bokeh pass도 0 비용 상태로 돌아간다. 카메라는 정자·높은 공공 오브젝트가 비켜 둔 남측 일조축을
  보존하면서 31° 부감으로 크레인 업해 넓은 시야의 전경 차폐를 넘고, 다시 줌인하면 원래 문높이 구도로 돌아간다. 근경 최소 거리는 착지 구도의
  42%로 제한해 처마 안으로 카메라가 뚫고 들어가지 않는다. 직접 마을 URL에서도 집 보기 버튼은 레거시
  단일건물 씬으로 이탈하지 않고 종가를 선택한다.
- `src/` 코어와 `app/` Svelte 경계를 유지하고 앱은 코어의 `src/api/`만 소비한다.
- 수묵은 `?mode=ink`로 재현되는 표현 상태이며 둘러보기/집 보기 카메라 상태와 독립적이다. 실경의 지형·건축 특징을 보존하면서 능선, 명암 덩어리, 안개 여백을 강조하고 village plan이나 seed RNG는 바꾸지 않는다. 세부 근거와 계약은 [`ink-landscape.md`](ink-landscape.md)를 따른다.
- 구조 이동과 기능 변경을 분리한다. hash 변화는 의도와 증거가 없으면 회귀다.

## 코드 구조 개선 상태

1차 구조 개선과 렌더/수명주기 안정화가 완료됐다. 상세 계약은 [`architecture-refactor.md`](architecture-refactor.md)에 있다.

- 공개 API: building, temple plan/full renderer, village plan/full runtime, environment, pure particle state, physical particles, lighting, cinematic, audio, props, export, rendering lifecycle.
- 순수 커널: geometry, world edge, value noise, scalar interpolation.
- 재사용 생성기: village pads, features, terrain, roads, trees, houses.
- runtime: seed window, worker client, create, handle, picking, parcel edit, light/night/snow/ambient/fauna.
- 앱 runtime: scene, post, view shift, camera framing, cinematic, village camera.
- 자동 경계: app→API, generator↛runtime, 내부↛API, core 방향, cycle 0, 순수 plan closure.
- 자동 회귀: 10개 plan golden, 네 규모 scene/pick proxy golden, sync/worker/fallback 일치, 앱 부팅·드론·보행·focus smoke.
- hot path: 확장 ghost의 숨은 완성 건물 생성을 제거했고, 필지 단건 proxy 조회와 카메라 중심점 캐시로 전체 방어 복제를 피한다.
- 생성기 수명주기: `buildBuilding`/`disposeBuilding` 쌍과 `VillageHandle.dispose()`가 독립 자원을 identity-dedupe해 회수하되 공유 `P.mats`·모듈 캐시 소유권은 보존한다. 종료된 handle은 재활성화되지 않는다.
- 렌더: 림 그룹 uniform, r185 색공간, composer DPR, Output-last 순서와 program plateau를 계약으로 고정했다. 림은 N·V 접선뿐 아니라 실제 첫 방향 태양의 N·L, 카메라와 태양의 역광 관계, `reflectedLight.directDiffuse`, stock 조명 루프의 shadow 전후 비율을 모두 요구한다. 이 비율은 태양 세기와 무관하게 반그림자를 보존하고, 뒤따르는 비그림자 fill은 주 태양 그림자 안의 림을 되살릴 수 없다. `receiveShadow=false` 오브젝트는 물리 visibility를 알 수 없으므로 per-object uniform에서 림을 0으로 제한한다. 지붕의 구름 그림자는 명시된 합성 patch로만 허용하며 callback과 `customProgramCacheKey`를 rim과 함께 체인한다. 별도 shadow-map fetch나 암부 wrap 없이 pre-group HDR 상한을 적용해 실제로 해를 받는 얇은 실루엣만 남기며, 넓은 담·벽·지붕면을 자체발광시키지 않는다. 광각↔망원 정책과 축방향 DoF, 장식물을 제외한 안정된 depth prepass, 무작위 crawl 없는 선택적 HDR 보케를 순수·실앱·고정 fixture 게이트로 분리했다. 카메라가 움직일 때는 일반 표면 합성을 중심 1표본으로 쉬고, 정착 뒤에도 3.25px 안의 높은 휘도 대비 경계만 최대 13표본으로 재구성한다. 제품 threshold `>=1.2`를 넘은 compact HDR 광원만 별도 원형 scatter가 맡아 물리 크기와 에너지를 계속 보존한다. 실제 Chrome GPU query·최종 픽셀 안정성·수묵/compact 휴면·Hanyang LOD parity를 계약으로 둔다. 실제 방향광은 구름·풀·입자·flare·rim의 공통 방향 입력으로 원점에 유지하고, 기존 한 장의 shadow camera만 선택 필지 target으로 texel-snap해 외곽 집에서도 처마·기단·담장·마당의 물리 그림자가 남는다. focus-in/hop/out은 카메라 target과 같은 연속 경로를 따르고 부감은 원점으로 복귀하며, 새 shadow map·pass·재질·draw call은 없다.
- 수묵 렌더: Three·DOM 없는 표현 상태 façade, 재사용 raw-beauty capture/`InkPass`, 앱 전환 runtime, Svelte 토글을 분리했다. 종이·normal/beauty target은 최초 진입 때만 만들고 완전 수묵에서는 중복 PBR fullscreen pass를 쉬게 한다. raw beauty가 농담을 고정해 sleep 전후 픽셀 pop이 없고 PBR 복귀 뒤 copy도 쉬며, 단일 Output-last 색공간과 모바일·URL·접근성을 실제 앱 게이트로 고정했다.
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

GitHub #22의 최초 등장과 단독 집 재생성은 `cinematic/architectural-reveal.js`의 renderer-free 경로를
공유한다. 최초 등장은 70° 안의 완만한 establishing 호와 넓은 화각에서 출발해 정확한 24° 카메라 고도·문 높이·7° hero 망원
프레임으로 내려앉고, 재생성은 현재 화면을 정확한 시작점으로 삼아 작은 측면 호와 거리·높이의 숨 고르기만
더한 뒤 새 필지 프레이밍에 정확히 복귀한다. seed는 선회 방향만 결정하며 전역 RNG를 소비하지 않는다.

앱 adapter는 카메라·target·reference FOV·비대칭 구도를 한 프레임으로 적용하고 매 프레임 `lookAt`을
갱신한다. capture-phase pointer/wheel/key 입력은 같은 이벤트에서 즉시 경로를 끊고 OrbitControls에 정확한
현재 프레임을 넘긴다. 휠은 같은 이벤트가 controls에 도달하기 전에 focus 줌 범위를 복구하므로 중단만 되고
실제 dolly가 사라지는 입력 손실이 없다. 조립은 계속하되 중단 뒤 자동 선회가 사용자의 카메라를 다시 빼앗지 않는다. 모바일은
축소된 호, reduced-motion은 즉시 endpoint를 사용한다. 순수 경로와 실제 Hero/집 재생성 제품 경로를
분리한 게이트가 endpoint·DoF·program plateau·입력 인계를 고정한다.

최종 구도는 배치 RNG를 다시 굴리거나 renderer에서 이웃 집을 숨기지 않는다. `camera/focus-visibility.js`가
필지의 남측 `solarAccess` 안에서 기존점·중간점·중앙점 세 개만 결정적으로 평가하고, 필요할 때 최대 20%
마당 쪽으로 당기면서 10°→최대 약 12.5°의 망원 보상으로 화면 점유율을 지킨다. 공간 그리드에는 picking용
필지 상자와 분리된 실제 fitted 처마 OBB, 계획 단계의 정자·마을 공공 소품·궁·사찰 footprint가 들어간다.
이 실제 방해물로 3×3 가시성을 검사하며, 기존점이 막혔더라도 사용 가능한 후보가 하나라도 있으면 카메라를
건물이나 소품 내부로 되돌리지 않는다. 이 결과가 pick proxy의 권위 있는
`cameraFraming`이므로 일반 클릭 focus, 최초 종가 landing, 집 재생성 final이 같은 구도를 쓴다.
지형 능선은 이 권위 프레임을 다시 당기지 않는다. `village/terrain-grid.js`가 같은 3×3 집 앞면 표본의
정확한 삼각면 교차를 projection near 거리 하나로 줄이고, `village-camera-runtime.js`가 모든 카메라
writer 뒤에서 이를 적용한다. 집을 침범하지 않는 한 렌더러별 clipping patch나 FOV 보상은 만들지 않는다.

GitHub #3 집 편집 슬라이더는 `live-edit-scheduler.js`를 단일 케이던스 소유자로 쓴다. 화면의 숫자는 모든 `input`에 즉시 반응하지만, 일반 주택 지오메트리 preview는 최신 값만 프레임에 맞춰 반영하고 최근 재생성 비용에 따라 32–96ms 사이에서 스스로 숨을 고른다. `change` 커밋은 대기 preview를 폐기하고 #19의 정확한 편집 처마·pick proxy·병합 flora를 한 번만 확정한다. 종가·관아·궁·사찰 복합체는 기존대로 커밋 시에만 재생성한다.

focus-out·필지 hop·마을 이탈·앱 dispose는 같은 scheduler epoch를 취소한다. 따라서 놓지 않은 슬라이더 값이 부감이나 다음 필지에 뒤늦게 적용되지 않고, 재진입하면 마지막 확정값으로 돌아온다. 50개 입력의 1회 병합과 취소 수명주기는 순수 게이트로, 실제 Svelte range 48개 입력→1 preview→1 flora commit·시각 변화·렌더 예산은 기존 단건 재건축 브라우저 부팅 안에서 함께 검증한다.

GitHub #19 집 편집 패널은 “다시 보기”를 제거하고 `이 집 다시 짓기`와 `내보내기`만 남긴다. 다시 짓기는 장식 애니메이션 재생이 아니라 원래 예약된 필지 안에서 경계·집 변주·담장·마당 살림·과실수를 하나의 트랜잭션으로 새로 구성한다. 결과는 focus-out 뒤에도 권위 있는 부감 오버레이로 남아 낡은 인스턴스가 되살아나지 않는다.

재건축은 `parcel-rebuild.js`의 불변 원본 envelope에서만 파생해 누적 축소를 막고, 남향 `frontDir`, 도로측 대문, 일조 통로, 정자 4.5m 지붕과 근경 카메라 시선을 보존한다. 편집된 실제 처마 bounds와 마당 hard object를 커밋한 뒤 같은 마을 seed/options로 단일 병합 flora를 다시 만들며 까치의 나무 perch도 갱신한다. 슬라이더 드래그 중에는 단일 집만 갱신하고 flora 교체는 pointer release에서 한 번 수행한다. 순수 계약과 실제 UI/카메라/LOD/프로그램·드로우콜 브라우저 게이트를 분리해 반복 검증을 가볍게 유지한다.

GitHub #5 사찰 터 재배치는 PR #43으로 `main`에 반영됐다. 산사를 강제하지 않고 평지·완경사·계류변·도성 안을 허용하며, 산과 숲의 위요감은 보너스일 뿐 필수가 아니다. temple ON plan과 scene 골든만 의도적으로 바뀌고 temple OFF 골든은 그대로 유지하는 것이 승인된 계약이다.

GitHub #15 근경 구도는 지붕 중심이 아니라 1.65–2.5m 문 높이를 조준하면서 카메라를 정확히 24°로 올린다. 3° 복원은 회귀 원인을 분리하기 위한 기준선이었지만 실제 제품에서는 담과 대문이 집·마당을 가렸다. 후속 사용자 검수에서 10°보다 마당과 생활 소품을 더 열도록 12°·14°·16°·18°·20°·22°를 거쳐 24°로 조정했으며, 0 수직 composition은 종가 landing·직접 `집 보기`와 일반 기와·초가에서 집, 열린 마당, 대문·등롱, 생활 동물을 함께 보존한다. 종가 닭은 대문 바로 안쪽에서 열린 안마당으로 옮겨 두 제품 경로에서 ray와 100 이상의 pure-canvas 변경 픽셀을 만든다. 이 정책은 주거형 hero에만 적용하고 관아·궁궐형 hero에는 닭을 만들지 않는다. 주택 카메라의 XZ 시선은 필지의 `solarAccess` 안을 지난다. 이웃집은 실제 variant 지붕·지형 높이와 30° 저각 겨울 햇빛에서 1.5m 창 일조를 보장한다.

GitHub #78은 이 구도를 바꾸지 않고 근경 DoF의 초점만 주출입문 의미 anchor로 분리한다. 고정 개구면 중심을 overlay 수명주기 이벤트에서 한 번 찾아 캐시하므로 정착 프레임에는 traversal·raycast·heap allocation이 없고, 새 GPU 자원·pass·재질·draw call도 없다. 전환의 두 끝점을 명시해 focus-in, 필지 hop, focus-out 중에도 문짝·창살·철물이 선명한 평면을 연속적으로 따라가며, 유일한 주출입문을 정할 수 없는 궁·사찰 같은 복합체는 기존 카메라 조준점으로 fallback한다.

GitHub #81은 실제 창호 anchor를 따르는 야간 원경 불빛으로 구현됐다. AURI가 설명한 실내측 한지 면과 외부에서
읽히는 살의 관계, 국립민속박물관이 소개한 양초·호롱·석유등의 작은 연소 점광원 어휘를 근거로 삼되, 모든 방이
빛났다는 주장이나 정확한 색·밝기·flicker·점등 비율로 확대하지 않는다. 제품은 일부 거주 방을 seed-stable하게
어둡게 남기면서 기존 따뜻한 불빛을 실제 고정 한지 opening anchor, 외향 법선, 변주·mirror·house fit·필지 변환에
붙인다. `plotW`/`plotD` 추정점과 궁·사찰·정자의 근거 없는 극좌표 점은 제거하고, 저작 anchor가 없으면 어둡게
fail closed한다. 하나의 물리 instanced batch가 opening의 실제 폭·높이·외향 법선을 가진 얕은 한지 면을 그리며,
front-side와 일반 depth test로 집·담·지형 뒤에서 가리고 color pass의 `depthWrite=false`를 유지한다. 근경 보케의
compact source transfer에는 같은 instance buffer·vertex shader·uniform·한지 profile을 공유하는 명시적 packed-depth
material이 실제 창불 깊이를 제공한다. 따라서 일반 color scene은 계속 1 draw이고 DoF depth prepass에서
1 draw/1 program/1 material을 추가한다. 슬롯당 2 triangle 외에 texture·light·render target·pass는 늘지 않는다. 조사 근거와 제품
번역의 한계는 [`exterior-detail.md`](exterior-detail.md)·[`architectural-authenticity.md`](architectural-authenticity.md)·
[`credits.md`](credits.md)에 함께 남겨 References UI가 같은 설명과 원문 링크를 보여 준다. 순수 anchor·자원 계약,
Worker/fallback 수명, 실제 앱의 같은 카메라 depth A/B와 aerial/focus/rebuild 프레임은
[`verification.md`](verification.md)의 영구 게이트로 고정했다.

GitHub #96은 Three 없는 강수 상태·진행·bounds 재매핑을 `src/api/particle-state.js`로, 이를 소비하는 물리 강수
표현과 근경 detail geometry·제품 계절/mote runtime을 `src/api/particles.js`로 분리한다. 한지 HDR 면광원은
입자 façade에 섞지 않고 `src/api/lighting.js`가 소유한다. seed가 정한 위치·위상·크기·종류 buffer는 하나뿐이고
한 개의 물리 월드 지오메트리가 이를 소비한다. color·일반 depth·명시적 packed DoF depth는 같은 instance offset,
시간·바람·활성 uniform, 종별 실루엣·normal, 3축 회전과 alpha coverage를 공유하므로 비활성 입자가 깊이에만
남지 않는다. 디테일 band를 벗어나면 별도 FAR Points로 바꾸지 않고 simulation과 draw를 함께 쉰다.

같은 renderer의 focus 7°/24°와 aerial 46°/31° ABBA에서 Points/FAR의 최대 절대 차이는 약 `0.059ms`,
16.7ms frame의 `0.35%` 이하였다. block별 우세 방향도 일관되지 않았고 제품 aerial duty cycle은 이미
0이어서 두 번째 geometry·shader·dispose 경로를 정당화하지 못한다. 실제 월드 폭은 눈 `1.3–3.2cm`, 봄
꽃잎 `2–5.4cm`, 가을 낙엽 `6–12cm`로 제한한다. 별도 lighting 경계의 한지 창 HDR source도 화면에 맞춘
임의 점을 만들지 않고 #81의 실제 고정 한지 opening anchor·폭·높이·외향 법선·mirror/fit/필지 변환과 정확한
source depth를 사용하며, anchor가 없으면 color와 depth 모두 fail closed한다.

GitHub #102는 focus·편집으로 한 필지만 바뀔 때 같은 batch 전체를 다시 보내던 GPU 전송을 줄인다.
`src/core/buffer-update-range.js`가 Three r185의 component 단위 `updateRanges`를 소유하고, 집은 선택 instance의
행렬 16성분, 담·FAR mass는 해당 source position lane, 한지 창불은 owner의 고정 slot만 갱신한다. 같은 상태의
재호출은 no-op이며 hide→show와 GLB export의 pristine snapshot은 바이트 단위로 유지한다. 반대로 tofu wave처럼
모든 행렬을 실제로 쓰는 경로는 명시적 full upload라서 희소 갱신으로 가장하지 않는다. 8필지 실제 WebGL
fixture에서 부분 전송은 `704B`, 기존 전체 전송은 `5,632B`였고 `bufferData` 재할당 없이 87.5% 줄었다.
장면 구조·draw call·결정론은 바꾸지 않으며 CPU 계약과 실제 `bufferSubData` 계측을 별도 영구 게이트로 둔다.

후속 GitHub #49는 가림의 실제 주체였던 정자를 중심선 점검에서 화면 폭 계약으로 보강한다. 정자의 공유 physical spec과 주택 지붕 실루엣을 사용해 카메라 쪽으로 좁아지는 focus envelope를 예약하며, 장승·솟대·우물·낟가리 같은 마을 소품도 높이 기반 겨울 일조와 같은 구도 판정을 소비한다. 낮은 소품과 이웃 지붕은 전경 깊이감으로 남기고, 넓은 정자 처마가 선택 집의 문·마당을 덮는 경우만 결정론적으로 다른 빈터를 고른다.

GitHub #21은 개울을 지형 위에 얹은 장식 리본이 아니라 계획과 렌더가 공유하는 하곡으로 만든다. 넓은 어깨는
산세를 완만하게 열고, 평시 수면은 최대 8m에서 멈춰 한양에서도 강으로 과장되지 않는다. 하상은 shader 흐름인
`-x` 방향으로 단조롭게 낮아지며, 실제 삼각 지형보다 최소 3.5cm 위의 같은 수면을 물과 다리가 소비한다.
5개 수면 lane의 청록 깊이색·제방색, 절제한 반사와 잔물결로 낮에는 분명하고 밤·석양에는 흰 bloom 띠가 되지
않는다. 호수·물새는 별도 폴리시로 남긴다.

GitHub #40은 지형의 크기와 무관한 30–46m 지역 파장의 자연 기복과 대규모 취락의 완만한 지형 단을 분리한 `settlement-relief` 계약으로 만든다. 그래서 마을이 커져도 지역 기복이 실종하지 않고 필지 패드는 3m 이상 부양을 거부한다. 명시적 `river=true`는 최소 60m, 한양 120m의 한강급 수면·충적 저지·양안 길·나루·남안 초가 취락을 한 계획으로 만든다. 조선시대 한강의 일상 횡단을 따라 거대 상설 석교 대신 나루배를 쓰며, 물 리본은 world-edge 안개 밴드에서 좁아져 사각 수면이 지형 밖으로 삐져나오지 않는다.

GitHub #25·#26의 하늘은 금빛·홍빛·보랏빛 세 석양을 `src/env/atmosphere-profiles.js`의 순수 프로필로 묶어 sky·조명·fog·post가 같은 상태를 소비한다. 스타일은 UI와 `?sunset=` URL로 재현되며 별도 seed fork를 써 마을 생성 RNG를 바꾸지 않는다. 카메라를 따르는 하늘 돔과 달은 단일건물/마을 전환에도 남고, 월드 방위가 고정된 16개 원경 구름은 한 InstancedMesh로 모든 근경 방위를 감싼다. 상공 구름은 실제 지면 그림자 위치를 소유하되 actual FOV와 aspect로 계산한 화면 폭이 약 64%를 넘으면 보이는 면만 감추고, 약 38% 아래에서 완전히 복귀한다. 원경 구름은 HDR 림·달 가림·저고도 빛줄기를 표현한다. 둘을 같은 거대 billboard로 합쳐 7°/10° 근경 화면을 천장처럼 덮지 않는다.

GitHub #18·#28의 환경은 봄·여름·가을·겨울과 맑음·비·눈의 호환 행렬을 `environment-state.js`로 분리했다. seed·UI·엔진이 같은 순수 상태를 사용해 눈은 겨울, 겨울의 비는 봄비로 일관되게 이동한다. 겨울은 낙엽 진 수목·휴경 논·차가운 지형·능선 설선을 갖고, 눈이 오면 `snow-material.js`의 공유 shader가 지붕뿐 아니라 지형·식생·외부 소품까지 한 축적 시계로 덮는다. 새 적설 geometry 없이 draw call 증가는 1, 실제 앱 program 증가는 24로 제한한다.

같은 작업에서 오래된 패널 하네스가 3.6초 scenery wave 도중의 구 plan을 완료 상태로 오인하던 판정을 고쳤다.
`stream=false`, 강제 성곽, 시드 유지와 리롤은 실제 wave commit 뒤 검사한다. 빠른 focus-out/리롤이
셰이더 precompile 중인 링 재질을 먼저 해제해 three.js 내부 polling에서 전역 예외가 나던 경합은 공개
`compileSubtreeAsync`가 해제된 재질을 완료로 회수하도록 해결했다.

GitHub #13은 카메라별 `polygonOffset` 대신 실제 geometry의 깊이 소유권으로 해결한다. 모든 최하단 기초는 상단 높이를 보존한 채 대지 아래 6cm 묻히고, 필지 마당은 성토면에서 6cm 뜬다. 기와집 ㄱ자 기단은 겹친 직사각형 두 벌이 아니라 켜마다 하나의 오목 솔리드이며, 판벽 봉창은 2cm 전면 간격, 맞배 박공벽은 지붕 아래 16cm 물림을 수치 계약으로 검증한다.

GitHub #11의 건축 고증 감사는 [`architectural-authenticity.md`](architectural-authenticity.md)에 출처의 사실,
구현 해석, 한계와 완료/잔여 체크리스트를 함께 남긴다. 초가·기와집의 외벽 밖 독립 화덕은 공유 부엌 개구 안으로
후퇴시키되 굴뚝과 근접 야간 불빛을 유지하고, 민가 정자살·세살은 궁궐 주칠·뇌록 대신 백골 목재·한지를 쓴다.
잡상·취두는 지붕 형식만으로 생기지 않고 현 유형 체계의 `palace`에만 허용한다. 공식 자료를 제품 판단에 쓰면
같은 도메인 문서와 `credits.md`를 갱신하고 실제 Reference UI의 적용 문구와 링크까지 검증한다.

GitHub #30의 첫 표면 파일럿은 [`surface-materials.md`](surface-materials.md)의 순수 source/Three adapter 경계를 따른다. 다져진 흙길은 사진 타일이나 비동기 로더 대신 seed 결정론 RGBA8 albedo·height를 만들고, 회전된 16m 월드 UV로 교차로까지 연속된다. 기존 vertex color가 도로 등급과 경사면 mute를 계속 소유하며 draw call·삼각형·재질 수는 늘지 않는다. 사용자에게 보이는 출처는 `credits.md` 한 곳에서 실제 Reference UI로 전달하고, 고정 OFF/ON 화면을 직접 열어 반복 띠·중원경 shimmer를 확인한다.

GitHub #135의 토담 표면은 [`mud-wall.md`](mud-wall.md)의 판담·판축·돌 하부·토벽 수분 근거와 한계를 따른다.
Three 없는 불변 plan이 낮은 수의 다짐 lift, 수 mm 깊이의 불규칙 이음, 드문 짚 섬유, 생성 시점에 고정되는
하부 흔적을 계획하고, Three adapter는 모든 정점을 기존 담장 envelope 안쪽에만 만든다. 제품은 기존 `mud`와
`jipjul` 재질 및 정적 병합을 그대로 쓰므로 필지별 재질·texture·draw group을 늘리지 않는다. 한양 MID/FAR은
원래 담장을 생략하므로 새 디테일도 FULL 근경에서만 자연스럽게 나타난다. `shoot:mud-wall`은 공개 API A/B 다섯
기여도와 실제 `village:1:p3` 근경·부감 프레임을 한 browser boot에서 기록한다.

GitHub #139의 길가 배수는 [`drainage.md`](drainage.md)의 한양 법정 도랑·인사동 유구·외암의
예외적 생활수로 근거를 분리한다. 일반 hamlet/village/town에는 측구를 만들지 않고, 실제 낮은 유출구가
성립하는 Hanyang 계획가로는 최대 양측, capital 대로·중로는 한쪽만 허용한다. 순수 plan은 실제 삼각 지형
위의 단조 bed와 도로·수계·필지·논 이격, 저장된 대문 접근축과 만나는 판석 건넘을 world-space JSON으로
확정한다. renderer는 카메라나 날씨로 배치를 다시 추론하지 않고 도랑 한 indexed mesh와 판석 한 merged
mesh 이하로 조립한다. texture·물 animation·shadow caster는 추가하지 않으며 일반 농촌의 빈 plan은
material조차 만들지 않는다. `check:drainage`와 `shoot:drainage`가 순수 정책/경사/공간 계약과 실제 제품
근경·부감 OFF/ON, 자원 예산, 반복 geometry hash를 나눠 고정한다.

GitHub #16은 [`exterior-detail.md`](exterior-detail.md)의 공통 창호 grammar와 선택 FULL **주거** 주출입문 상호작용이다. Three 없는 불변 plan이
문·창 크기, 창 하부 머름, 문짝 lowerPanel, reveal, frame, threshold, primary entrance와 후속 pivot/footwear
anchor를 소유하고, `giwa.js`·`walls.js`·대표 종가 `buildHanok`은 한 assembler로 이를 렌더링한다. 문은 머름을
갖지 않으며 기존 하부 청판 rail을 별도 의미로 보존한다. 프레임은 기존 envelope 목재에 병합하고 절제된 철물은
texture 없는 palette material 하나로 FULL/selected overlay에만 남긴다. 신발은 이 anchor를 소비하는 순수 plan과
얇은 Three adapter로 분리하고, 정적 prototype이 아니라 선택된 focus overlay에서만 한 켤레를 소유한다. 맑은 날의
짚신과 `rain`의 나막신 전환은 실제 제품 경로에서 검증하며 focus-out 때 회수한다. 경첩 쪽 한 짝만 별도 owner로
분리해 청판·고리·띠와 함께 안쪽으로 열며, 순수 임계감쇠 state와 Three runtime을 분리한다. 초가·대표 종가는
열린 뒤 벽이 재등장하지 않도록 기존 frame batch에 고정 암부를 병합하고 초가 보·판재는 실제 개구 폭에서
분할한다. 실제 leaf/빈 문간의 명시적 down/up만 toggle하며 모든 조상의 visibility/layer를 확인한다. `hero`는
카메라·편집 분류일 뿐 주거 역할이 아니므로 `heroStyle: 'palace'` 관아·객사와 궁·사찰 compound는 주 전각 역할이
최적화 root까지 보존되기 전에는 제품 runtime을 만들지 않는다. drag·focus-out·rebuild·dispose는 문 상태와 host
graph, 신발 overlay를 각 소유권 경계에서 정리한다. 아궁이 service opening과 거주 창호는 합치지 않는다.
선택 root 밖의 가림은 문 hit까지의 유한 선분만 조회하는 Three 없는 uniform-grid DDA가 맡는다. 일반집 계획
몸체/지붕 또는 commit된 FULL bounds, 일반 필지 담/문틀, 종가 담·닫힌 대문·행각 지붕, 정자 기단·기둥·수렴
지붕, 공용 소품, 사찰 전각·담·닫힌 문, 궁장/광화문, 도성 성벽/열린 홍예, 시전과 실제 yard/guardian tree
anchor를 작은 의미 형상으로 미리 인덱싱하며 겨울에는 줄기만 남긴다. 전체 담 ring·precinct AABB는 만들지 않아
문·홍예·중정의 빈 공간을 보존한다. Hanyang 전체 scene raycast는 수만 InstancedMesh instance를 pointermove마다
순회하므로 채택하지 않았다. 필지 commit과 flora 교체 때만 해당 record를 원자 갱신하고 query hot path는 후보
배열·Set을 만들지 않는다. forest/scatter는 기존 focus tree-fade 정책이 계속 소유한다. 성문 문루 상부, 궁 내부
일곽, 사찰 소품은 아직 외부 semantic 범위가 아니며 선택 root 내부는 실제 first-surface ray가 맡는다.

GitHub #10은 초가·기와 ㅡ·ㄱ·ㄷ의 문·창 plan을 FULL renderer와 집 편집기에 연결했다. 문 수·창 수·문 너비·창
너비·문 높이·창 높이 여섯 축의 기본값과 shape별 안전 범위는 `residential-openings.js` 한 곳에서 정규화되고, Svelte는 이 capability로
한국어 단위·범위를 표시한 뒤 직렬화 가능한 엔진 params만 보낸다. 공통 조립 경계가 모든 계획 개구를 정확히 한
번 패널과 창호 detail batch로 만들며 남향 primary anchor, 대청, 기와 부엌 span과 초가 부엌 service opening을
보존한다. commit된 일반집은 마지막으로 승인된 전체 spec을 소유해 이후의 부분 patch가 다른 축을 지우지 않는다.
종류 변경은 대상 종류 기본값에서 시작하고 집 재굴림은 현재 종류만 유지한 채 편집값을 초기화한다. compact
`vedit` URL은 실제로 달라진 종류와 여섯 개구부 축만 최대 8필지까지 기록하며 잘못된 payload는 전부 거부한다.
GLB는 transient focus 표현은 제외하되 commit된 일반집 overlay와 그 편집을 포함하고, 대체된 base LOD는 export
동안만 숨긴다.

GitHub #12 복합 가람 생성기는 [`temple-generator.md`](temple-generator.md)의 계약대로 구현됐다. Three 없는 순수 local-space 계획과 Three.js 조립·dispose를 분리하고, 22–30m 암자형·36–48m 중정형·52–72m 다원형을 제공한다. 마을은 실제 직사각 footprint를 필지·도로·식생 전에 예약하며, 편집 패널은 전각 수·중정 여백·축 굴절·석탑·석등·종루·당간지주·부도를 계획 옵션으로 갱신한다. 남측 일조 통로와 26° focus 카메라는 같은 `frontDir` 계약을 쓴다.

사찰 원본 조립 트리는 편집·두부 조립용으로만 유지하고, 부감에서는 재질별 병합해 대표 다원형을 2,681콜에서 111콜로 낮춘다. 순수 계약과 독립 WebGL 수명주기/성능 게이트, 실제 앱 focus 캡처를 분리해 일상 검증은 가볍게 유지한다.

GitHub #131은 농가 전체를 소품으로 채우지 않고 결정론적으로 선택한 약 5.7%의 가구에만 봄 볍씨 준비·가을
타작·겨울 땔감 기록을 함께 계획한다. Three 없는 `yard-life-plan.js`가 필지별 hash stream과 실제
처마·대문 동선·일조·마당 hard object를 사용하고, `yard-life-record-contract.js`가 worker나 외부 저장 경계를
건넌 JSON의 정확한 계절·날씨·variant·part·재료·footprint를 geometry 할당 전에 검증한다. 세 계절의 서비스·작업
슬롯을 좌표까지 포함한 정확한 합집합으로 먼저 예약한다. 실제 돌·흙·기와담 몸체 반두께와 hard gap, 도로 회랑을
공유하므로 계절 전환이 담·과실수·근경 풀을 관통시키지 않으며, 리빌드는 편집으로 바뀐 주거 종류에서 다시 계획한다.
대표 seed의 작은 마을에서도 충분한 후보가 있으면 가장 가까이 선택된 한 가구를 결정론적으로 남겨 규모별 희소성이
우연히 0이 되지 않게 한다.

재사용 renderer는 호출자가 빌려준 texture 없는 여섯 역할 material을 소유하지 않고 최대 여섯 개의 고정
opaque screen-door batch로 물리 geometry를 만든다. 격리 fixture는 최대 6 역할 draw·texture 0·program 3을
지키고, 계절·날씨·shared detail LOD·wave는 새 자원 없이 가중치만 바꾼다. byte-identical rebuild는 메시를
교체하지 않고, 바뀐 record는 같은 ID의 진행 중 전환 가중치와 원래 easing 시간곡선을 이어받는다. 저장된 LOD callback까지 먼저 평가한
뒤에만 geometry를 교체해 실패한 rebuild가 기존 메시 identity나 dispose 소유권을 흔들지 않는다. 부감 진입 때
한 번만 0 coverage를 올린 뒤 배열 할당·record scan 없이 CPU와 draw를 함께 쉬고, 제품 세 계절은 같은 카메라
layer OFF/ON 픽셀 기여와 자원 plateau를 고정한다.
근경 풀은 기존 RNG 후보를 모두 만든 뒤 생활상 합집합과 겹친 후보만 안정적으로 제거하므로 위치 스트림·한
InstancedMesh·드로우콜은 그대로다. 근거와 제품 번역 한계는 [`yard-life.md`](yard-life.md), 재사용 API와
검증 분리는 [`external-reuse.md`](external-reuse.md)·[`verification.md`](verification.md)에 고정했다.

구조의 다음 후보는 palette의 canvas provider 주입과 engine village/focus controller지만, 새 기능보다 자동 검증을 먼저 추가하는 조건으로만 진행한다.

## 최근 마무리 상태

현재 Git 이력 기준으로 궁 전각 재질 공유(#149), 마을 critters(#152와 후속 LOD), BGM 복원 회귀, 모바일/개요 패널 수정(#154/#155)이 반영돼 있다. 이 문서는 changelog가 아니므로 세부 완료 목록은 Git 이력을 사용한다.

## 메모리 승격 원칙

개인 Claude Code 메모리는 작업 이력의 중요한 입력이지만 완료·폐기안, 도구별 지시, 임시 경로도 섞여 있다. 장기 규칙은 `AGENTS.md`, 이 문서, 검증 가이드, 활성 브리프로 옮기고 레포가 개인 경로에 의존하지 않게 한다.

## 갱신 규칙

- 기능이나 구조 계약이 바뀌면 같은 작업에서 이 문서와 관련 검증 문서를 갱신한다.
- 사용자 결정이 기존 항목을 뒤집으면 날짜와 이유를 남긴다.
- 코드와 문서가 다르면 실행 결과를 확인해 문서를 즉시 고친다.
