# 당산 문화경관 (의례 공터·당집)

> - **상태**: 조사·제품 번역 계약
> - **관련 이슈**: GitHub #150 item D
> - **조사 기준일**: 2026-07-26
> - **대상**: hamlet·village 규모에서 기존 보호수(당산나무) 수관 아래의 **선택적** 의례 공터와
>   작은 당집
> - **비대상**: 전국 당산 빈도표, 성황당·서낭당의 전 유형 복원, 당산제 연출·인물·무속 퍼포먼스,
>   새로운 신목 생성, town·capital·hanyang 기본 배치

이 문서는 이미 존재하는 마을 보호수 landmark에 낮은 빈도로 붙는 문화경관 레이어의 근거와
제품 한계를 고정한다. **확인된 사실**, **공간 해석**, **제품 수치**를 분리하며, 확인되지 않은
전국 비율을 절차 확률로 가장하지 않는다.

## 1. 조사 범위와 증거 강도

한국민족문화대백과사전의 지역·마을신앙 항목과 국립민속박물관 한국민속대백과사전의 당산나무
설명은 다음을 공통으로 말한다.

| 사실 | 증거 강도 | 제품 번역 |
| --- | --- | --- |
| 마을 수호 신목(당산나무) 아래·주변에서 동제·당산제가 행해진다 | 강함 | 기존 `guardianTrees` 수관을 host로 소비 |
| 제 전에 나무 주위에 황토를 깔고 금줄을 친다(지역 사례) | 중간(지역 서술) | 수관 안 **낮은 의례 공터** 1개로 절제 |
| 당집·당산(小屋)·돌제단이 나무와 함께 구성되기도 한다 | 중간 | **선택** 소형 당집 + 낮은 돌제단 |
| 금줄은 부정 차단용 왼새끼 의례 표시 | 강함 | 기존 보호수 프로토의 금줄 유지(이 레이어가 복제하지 않음) |
| 전국 촌락의 당집 설치 비율·표준 평면 | **미확정** | 낮은 제품 auto-rate, 전국 빈도로 주장 금지 |

무주·곡성 등 지역 항목은 당산나무·누석단·당집·성황당이 **마을마다 한두 가지만** 선택되거나
앞뒤 축으로 이어진다고 서술한다. 이는 “모든 마을에 당집·공터가 상시 있다”는 근거가 아니라
**선택적·지역 변주**의 근거다.

## 2. 제품 계획 계약

### 2.1 하나의 순수 계획

`src/village/dangsan-plan.js`가 Three·DOM 없이 다음을 결정한다.

- host 보호수(`role`, 수관 반경, 위치)
- 수관 **안** 의례 공터 중심·반경·terrain `surfaceY`
- 낮은 돌제단 위치·치수
- 선택적 당집(소형 gable·thatch covering 표기) footprint
- empty plan + `reason` (`disabled` / `ineligible-scale` / `low-rate-skip` / `no-clear-slot` …)

같은 seed·site·guardians는 sync/Worker에서 같은 JSON record를 낸다. 전용 seed stream
`(seed ^ 0xd4a50150)`을 쓰므로 기존 마을 plan RNG·후속 결정론을 소비하지 않는다.

### 2.2 선택 규칙

1. **규모**: `hamlet`·`village`만 허용. `town`·`capital`·`hanyang`는 강제 옵션이어도 empty.
2. **opt-in**: `opts.dangsan === true` 강제 시도, `false` 항상 empty, 미지정 시 auto.
3. **auto-rate**: 제품값 `0.14`. 이는 화면 희소성을 위한 수치이며 **전국 당산 빈도가 아니다**.
4. **당집**: 사이트가 잡힐 때 제품값 `0.42`로 한 번 더 시도. 공터만 성공하고 당집이 실패하면
   공터만 남긴다(축소·관통 금지).
5. **host**: `entrance`+props 우선, 이어서 entrance·central. 새 나무를 만들지 않는다.
6. **수관 소비**: 공터·당집 전부가 host `radius` 안에 들고, 밑동 `trunkClearance`(제품 3.15m) 밖.

### 2.3 공간 회피

공터·당집은 다음을 침범하지 않는다.

- 필지 폴리곤, 논, 도로 ribbon(+margin)
- 개울 예약, 성벽/성문 vegetation corridor
- 정자 footprint, 마을 public props
- 다른 보호수 밑동
- 당집만: 각 주거의 30° 저동지 `solarAccess` (`circleBlocksSolarAccess`)

렌더러가 카메라 거리로 위치를 다시 고르지 않는다.

## 3. 얇은 렌더 계약

`src/village/dangsan-geometry.js`는 borrowed materials만 사용한다.

| 역할 | 내용 | 드로우 |
| --- | --- | --- |
| `stone` | 공터 디스크 + 낮은 테두리 + 2단 돌제단 | ≤1 |
| `wood` | 당집 몸체 + 맞배 두 패널 + 용마루(별도 thatch 재질군 없음) | ≤1 |

합계 **≤ +2 draws**. 새 texture·program family·point light 금지. 수명은 geometry만
renderer 소유, material은 호출자(마을 팔레트) 소유.

제품 조립은 `populate.js`가 공유 `villagePalette.stone/wood`를 빌려 붙인다. wave 정적 목록에
`village-dangsan`을 포함한다.

## 4. 제품 수치 (사료값 아님)

| 항목 | 값 | 근거 성격 |
| --- | --- | --- |
| clearing radius | 2.05 m | 수관 안 가독·충돌 여유 |
| trunk clearance | 3.15 m | 기존 돌단·금줄 프로토와 겹침 방지 |
| altar | 1.12 × 0.58 × 0.42 m | 낮은 제단 실루엣 |
| dangjip body | 1.55 × 1.28 × 1.48 m | 사람 한 명이 드나들 수 있는 小屋 암시 |
| auto-rate | 0.14 | 희소 제품 정책 |
| dangjip-rate | 0.42 | 공터가 있을 때의 선택 비율 |

## 5. 공개 API

- 순수: `src/api/dangsan-plan.js` — `planDangsan`, `validateDangsanPlan`, `dangsanHardObstacles`
- 렌더: `src/api/dangsan.js` — `buildDangsan`, `disposeDangsan`, `DANGSAN_MATERIAL_ROLES`
- 마을 통합: `planVillage({ dangsan: true|false })` → `plan.dangsan`

## 6. 검증

- `npm run check:dangsan` — Three-free 배치·수관·도로·필지·일조·결정론·scale 정책
- 라우팅: `src/village/dangsan-*.js` / `src/api/dangsan*.js` 변경 시 core + app + worker

## 7. 명시적 비목표

- 성황당·서낭당·산신당의 건물 유형 분화
- 당산제 일정·제관·농악 연출
- 황토 텍스처 복제, 금줄 메시 재생성
- 도성·읍치 기본 당산 경관
- “전통마을이면 항상 당집이 있다”는 전국 빈도 주장
