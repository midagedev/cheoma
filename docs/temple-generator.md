# 재사용 가능한 한국 사찰 생성기 설계

> - **상태**: 현재 계약·구현 완료
> - **관련 이슈**: GitHub #12 — 절 크기·구성·편집 다양화, GitHub #122 — 전각 역할별 건축 위계, GitHub #150 E — 문·단·누하 진입 시퀀스
> - **기준일**: 2026-07-26
> - **선행 조건**: 사찰 터 재배치 #5, 남측 일조·focus 구도 #15
> - **목표 경계**: `src/`의 framework-agnostic Three.js 모듈, `app/` 의존 금지

## 1. 목표와 현재 공백

사용자가 원하는 것은 특정 산사 한 채가 아니라, 규모와 지형에 따라 아름답고 서로 다른 한국 사찰이 나타나는 생성기다. 산속·계류변·마을 가장자리·도성 안을 모두 지원해야 하며, 한 동짜리 구성도 작은 암자형의 한 변형일 뿐 유일한 결과가 아니다.

이 공백은 #12에서 닫혔다. 기존 `buildParcel({style:'temple'})` 한 번과 빈 좌대 네 개 대신 순수 `TemplePlan`이 전각·담장·문·마당·길·삼층석탑·석등·당간지주·부도를 의미로 배치하고, 독립 renderer와 village adapter가 같은 계획을 소비한다.

## 2. 실증에서 가져올 공간 언어

한국 사찰은 단일 고정 축 복제가 아니다.

- 통도사는 계류를 따라 세 영역이 이어지고, 핵심 예불축이 진입축과 직교한다.
- 법주사는 두 신앙 축의 교차점에 팔상전을 두는 복합 축을 보인다.
- 선암사는 일주문·종루·만세루·대웅전과 여러 부속 전각이 위계 있는 일곽을 만든다.
- 부석사는 제한된 터에서 전각·석탑·석등의 높이와 단을 달리하고 성글게 배치해 답답함을 피한다. 석등은 무량수전 앞의 예불 축에 놓인다.
- 초기 평지가람의 탑–금당–강당 정형은 중요한 계보지만, 조선기 사찰 전체를 하나의 정방형 템플릿으로 고정할 근거는 아니다.

근거:

- [통도사 가람배치](https://www.koreansansa.net/ktp/sansa/sansa_020504.do)
- [법주사 가람배치](https://www.koreansansa.net/eng/sansa/sansa_020304.do)
- [선암사 가람배치](https://www.koreansansa.net/eng/sansa/sansa_020104.do)
- [부석사 전각·석탑·석등 배치](https://www.koreansansa.net/eng/sansa/sansa_020701.do)
- [국립문화유산연구원 가람배치 사전](https://portal.nrich.go.kr/kor/archeologyUsrView.do?idx=10011&menuIdx=792)

### 2.1 전각 역할 위계의 근거와 한계

국립문화유산연구원 「가람배치」는 금당·문·강당·경루·종루·승방이 서로 다른 규모와 위치 규칙을 갖는다고
설명한다. 한국학중앙연구원 「절」은 불전을 본존을 봉안하는 중심 건물로, 강당을 설법·법요 공간으로,
승당/승방·주고를 수행·거주·살림 공간으로, 산문과 종각을 진입·의식 법구의 별도 건물로 구분한다.
「보제루」는 중심 불전 정면의 누각이 법요와 설법을 수용하고 때로 불이문의 기능도 함께 하며, 그 곁에
종각이 놓이는 사례를 설명한다.

국가유산포털의 실제 지정 사례는 하나의 고정 지붕 문법을 일반화하지 못하게 한다. 송림사 대웅전은
5×3칸 다포계 겹처마 맞배이고, 부석사 무량수전은 주심포 팔작의 중심 불전이며, 부석사 안양루와 범종각은
각루로 별도 분류된다. 따라서 cheoma는 주불전에 송림사형 맞배/다포와 무량수전형 팔작/주심포 두 절제된 repertoire를 두되,
부불전·강당·요사·누각은 상대적으로 낮은 매스와 얕은 처마·성긴 공포로 단계화한다.

이 출처들은 **전각 역할과 실제 형식의 다양성**을 확인할 뿐, 전국 사찰의 보편 높이 비율·처마 깊이·공포
빈도 분포를 제공하지 않는다. `architecturalRank` 1–4와 수치 간격은 특정 문화유산의 실측 복제가 아니라,
가까운 화면에서 역할을 읽히게 하면서 병합 예산을 지키는 제품 해석이다. 원문 이미지·도면은 번들에
복제하지 않는다.

## 3. 모듈 경계

생성기는 다음 층으로 구현한다.

1. `src/temple/plan.js#planTempleCompound(options)` — Three.js 없이 local-space 순수 데이터만 만든다.
2. `src/temple/entry-sequence.js` — 속→성 진입 시퀀스(문·단·누하·중정) 순수 기록과 산지 에이프런 단 계약.
3. `src/temple/compound.js#buildTempleCompound(plan, resources?)` — 계획을 Three.js group으로 조립하고 `disposeTempleCompound()`로 소유 자원을 해제한다.
4. `src/village/temple-plan.js`와 `src/generators/village/features.js` — site의 `baseY`, 회전 transform, terrain apron, approach, 식생 예약을 결합한다.

외부 소비자는 Three 없는 `src/api/temple-plan.js` 또는 renderer까지 포함한 `src/api/temple.js`를 쓴다. 내부 계획기는 village나 Svelte를 import하지 않는다. 다른 프로젝트는 terrain/village 없이도 local-space 가람만 만들 수 있고, 렌더러는 건물·프롭 위치나 역할별 지붕·공포·처마를 새로 추론하지 않고 plan을 그대로 소비한다. 순수 `src/temple/role-hierarchy.js`가 역할 repertoire, builder parameter 변환, 실제 처마 polygon을 함께 소유한다. 진입 순서는 `entry-sequence.js`가 소유하며 variant 이름만으로 두 번째 동선을 만들지 않는다.

권장 계획 데이터:

```js
{
  schemaVersion: 2,
  seed,
  variant,          // compact | courtyard | extended
  width, depth,
  axis,
  courtyards: [{ id, polygon, level, elevation }],
  buildings: [{
    id, role, style, position, yaw, frontBays, sideBays,
    architecturalRank, roofGrammar, bracketGrammar, eaveGrammar, massingGrammar,
    eaveFootprint, footprint,
    // gate-pavilion pass-under only:
    passUnder: { openLower: true, corridorWidth, corridorHeight },
  }],
  enclosures: [{ id, role, polygon, gateId }],
  gates: [{ id, role, position, yaw }],
  props: [{ id, role, kind, position, yaw, scale }],
  paths: [{ id, role, points, width }],
  entrySequence: {
    schemaVersion: 1,
    profile,          // flat | mountain
    stages: [{ id, kind, order, role, position, level, elevation, refId, ... }],
  },
}
```

모든 ID와 배열 순서는 seed에 대해 안정적이어야 한다. village 배치가 큰 가람을 렌더 단계에서 임의 확대해서는 안 된다. 변형이 요구하는 실제 footprint를 사찰 터 계획에 먼저 전달해 필지·도로·식생 예약이 같은 경계를 쓰게 한다.

현재 생성 계획은 `schemaVersion: 2`다. v1은 전각 역할·기본 footprint만 소유했고 지붕·공포 grammar가
없었으므로, 순수 `normalizeTemplePlan()` 입력 경계가 seed·role·id로 한 번만 v2를 복원한다. 이 승격은
입력을 변경하지 않고 결정론적이며, v2 renderer는 승격이 끝난 완전한 grammar만 소비한다. 버전이 없거나
2보다 높은 미래 schema는 묵시적으로 추정하지 않고 명시적으로 거절한다.

## 4. 최소 변형군

| 변형 | 목표 규모 | 건물 구성 | 석조물·진입 |
| --- | --- | --- | --- |
| compact | 22–30m | 주불전 1 + 선택 요사/작은 문 1 | 석등 1, 선택 부도; 짧은 길 |
| courtyard | 36–48m | 주불전 + 문루/누각 + 좌우 요사·강당 중 2 | 축상 석탑 또는 석등 쌍, 외전 당간지주 |
| extended | 52–72m | 2개 일곽, 주불전·부불전·종루·문루·요사 5–8동 | 탑원/석등/당간지주, 외곽 부도 영역 |

역할 규칙:

- `main-hall`은 최상위 예불 마당을 지배하되 항상 정중앙 직선축일 필요는 없다.
- `gate-pavilion`과 `court`는 속→성의 진입 시퀀스를 읽게 한다.
- 석등은 주불전 앞 예불축을 강조하고, 석탑은 변형에 따라 중심축·쌍탑·교차축 노드 중 하나를 쓴다.
- 당간지주는 외전 또는 첫 진입 영역의 표식으로만 선택하며 보행축을 막지 않는다.
- 부도는 핵심 중정에 장식처럼 놓지 않고 extended/별도 외곽 영역에서만 사용한다.
- 프롭 개수보다 비움과 시선축이 우선이다. 큰 가람도 모든 슬롯을 채우지 않는다.

### 4.1 진입 시퀀스 (문 · 단 · 누하 · 중정)

`src/temple/entry-sequence.js`가 plan 소유 순수 기록으로 진입 동선을 고정한다. `+z`가 남쪽이므로 방문자는 남→북(큰 z → 작은 z)으로 걷는다.

| profile | compact | courtyard / extended |
| --- | --- | --- |
| `flat` (기본) | `gate` → `court` | `gate` → `stair-apron` → `pass-under` → `court` |
| `mountain` | `gate` → `stair-apron` → `court` | 같은 네 단계. `stair-apron.stairMode = 'apron-tiers'` |

- **gate**: 남측 `south-gate` 기록. 기존 산문 메시를 재사용한다.
- **stair-apron**: 평지는 `single-run` 얕은 단, 산지는 중정 `level`/`elevation` 에이프런 단이 곧 계단이다. 산지 extended는 외전 중정(낮음)과 예불 중정(높음)을 단으로 묶는다.
- **pass-under (누하)**: courtyard/extended만. `gate-pavilion` 역할의 raised hall이 예불 중정 남연에 앉고 `passUnder.openLower`로 하층 회랑을 연다. 벽체를 생략한 기둥+지붕 볼륨으로 보행축을 관통시키며, 궁궐 잡상·취두를 추가하지 않는다. 개방 하층은 남측 일조 차폐로 세지 않는다.
- **court**: 예불 중정(`role: 'worship'`).

옵션 `entryProfile: 'mountain' | 'flat'`(또는 `profile`)은 `plan.settings.entryProfile`과 `entrySequence.profile`에 기록된다. 렌더러는 stage 순서를 재추론하지 않고 plan 기록을 소비한다. draw/program 예산은 기존 temple palette·병합 경로를 유지한다.

## 5. 편집 계약

편집 패널은 렌더 오브젝트를 직접 조작하지 않고 `templeOptions`를 통해 계획 옵션을 갱신한다.

- `variant`, 전각 수, 축 굴절 정도, 중정 여백.
- 석탑 없음/한 기/쌍탑/자동, 석등 수, 종루·당간지주·부도 포함 여부.
- 마을이 예약한 최대 크기에 들어가는 변형만 패널에 노출한다.
- 변형을 바꾸면 그 문법의 전각·기념물 기본값을 함께 다시 시드해 UI 숫자와 planner clamp가 어긋나지 않게 한다.
- 폭·깊이는 마을 재생성 전에 터 계획이 소유한다. focus 편집이 예약 경계를 몰래 키우지 않는다.

옵션 변경은 같은 seed에서 건물/프롭 ID를 가능한 한 보존해 선택 상태와 애니메이션이 불필요하게 깨지지 않게 한다.

## 6. 품질과 검증 기준

- 순수 계획: `npm run check:temple`이 30개 변형·크기·seed fixture와 6개 마을 adapter에서 겹침, 실제 처마 footprint 이탈, 역할 위계, 결정론, 남측 일조축, 접근로, 주불전 현판 대역(§8), 그리고 courtyard/extended의 `gate|stair-apron|pass-under|court` 진입 순서·남→북 진행·누하 openLower를 검사한다. mountain fixture는 에이프런 단 stairMode를 고정한다. 별도 v1 fixture는 새 architecture 필드를 모두 제거한 뒤 deterministic v2와 동일하게 승격되는지, 누락·미래 schema가 거절되는지도 고정한다.
- 역사성: 역할별 배치 규칙을 자동 검사하되, 모든 사찰을 완전 대칭 한 템플릿으로 만들지 않는다.
- 시각: `temple.html`에서 compact/courtyard/extended의 부감·남측 26° 망원 구도를 직접 보고, `npm run shoot:focus-level`로 실제 앱의 사찰 focus와 편집 전환을 확인한다.
- 성능: `npm run check:temple:browser`가 raw/부감 merge 삼각형 동등성과 draw call을 기록한다. 2026-08-05 Chrome/Apple M1 Pro 기준 장면은 compact `863→99`, courtyard `1745→115`, extended `2925→141`이며, 병합본은 **142콜**·7 programs, 전체 재질은 72개 이하를 유지한다(재질 49/57/70). 병합 상한을 140에서 올린 근거와 실측은 §8.3 — programs는 불변이다. raw는 그 사이 여러 라운드의 디테일 추가로 이동했다(현판 직전 baseline `853/1735/2915`, 현판 이전 병합 `97/113/139`). 브라우저/드라이버가 다른 절대 시간은 비교하지 않는다.
- 현판: `npm run check:temple`이 순수 기록(치수·대역·무자)을 고정하고, `npm run check:temple:browser`가 **실제로 렌더된** 현판 하나를 주불전 정면에서 확인한다. 소스 문자열 검사만으로는 부족하다 — 호출부를 남긴 채 아무것도 그리지 않는 렌더러도 통과했다(2026-08-05 FAIL-first 실측).
- 수명주기: 독립 생성 결과의 dispose 성공·멱등성과 호출자 palette 보존, 자체 palette 해제를 실제 WebGL 브라우저에서 검사한다.
- 재사용: public API bundle이 Svelte·village runtime 없이 성공해야 한다.

완료 최소선은 세 변형이 실질적으로 다른 실루엣과 동선을 만들고, 그중 둘 이상이 여러 전각을 가지며, 준비된 사찰 프롭이 의미 있는 위치에 등장하는 것이다. 현재 한 동짜리 경내를 단순히 랜덤 프롭으로 채우는 것은 완료로 보지 않는다.

## 7. 구현 결과와 유지 규칙

1. compact는 22–30m 암자형, courtyard는 36–48m 중정형, extended는 52–72m 두 일곽으로 계획한다.
2. courtyard와 extended는 반드시 여러 전각을 가지며, extended는 내부 담장과 산문을 실제 같은 선에 둔다.
3. 주불전 앞 `solarAccess`에는 다른 전각이나 높은 석탑·당간을 두지 않는다. 순수 게이트가 정자를 고의로 통로에 넣은 반례도 거부해야 한다.
4. 마을 adapter는 실제 직사각 폭·깊이를 필지·도로·개울·숲보다 먼저 예약한다. 30m solo는 주거·도로·개울을 억지로 겹치지 않고 절만 있는 마른 분지와 중앙 진입을 쓴다.
5. 부감에서는 재질별 정적 병합본만 보이고 focus에서는 편집 가능한 원본 계획을 재생성한다. 호출자 palette와 모듈 공유 프롭 자원의 소유권을 바꾸지 않는다.
6. 사찰 카메라는 `frontDir`을 따라 남측 진입 공간에서 26° 망원으로 지면 위 3m를 조준한다. 일조축과 카메라축은 서로 다른 렌더 보정을 만들지 않는다.
7. 모든 전각은 `architecturalRank`, `roofGrammar`, `bracketGrammar`, `eaveGrammar`, `massingGrammar`와 그 결과인 `eaveFootprint`를 v2 plan에 저장한다. 렌더러·충돌·경계는 같은 값을 소비하며 역할명으로 두 번째 문법이나 손으로 맞춘 plot box를 만들지 않는다. 역할 기반 복원은 오직 v1→v2 입력 upgrader 안에서만 허용한다.
8. courtyard/extended는 plan-owned `entrySequence`로 `gate → stair-apron → pass-under → court` 순서를 유지한다. 누하는 개방 하층 `gate-pavilion`이며 궁궐 장식을 쓰지 않는다. 산지 profile은 별도 자유 계단 대신 에이프런 단으로 단차를 읽힌다.
9. 주불전에는 무자 현판 한 매가 걸린다(§8). 위치·치수는 순수 `src/temple/plaque-plan.js`가 소유하고 renderer는 그 기록만 소비한다. 부속 전각·문루·궁·관아·민가에는 달지 않는다.

계획·renderer·village adapter·앱 schema·브라우저 게이트가 독립 파일을 가져 후속 병렬 작업이 같은 조립 파일을 불필요하게 공유하지 않게 한다.

## 8. 주불전 현판 (무자 편액)

사료 사진의 사찰 주불전에는 어칸 처마 밑에 현판이 걸려 있고, cheoma의 전각은 그 자리가 비어 있어 갭이 컸다. `src/temple/plaque-plan.js`가 Three 없는 순수 기록으로 현판 한 매를 소유하고, `compound.js`는 그 기록을 그대로 소비한다. 글자는 넣지 않는다(무자) — 서체를 절차적으로 지어내면 고증이 아니라 창작이 되고, 텍스처 한 장이 병합 예산과 프로그램 계열을 늘린다.

### 8.1 근거와 그 한계

- 한국학중앙연구원 sillokwiki 「현판」: 편액은 "건물의 앞부분 높은 곳에 설치하여 건물의 명호를 알려주는 액자"이고 "규격은 건물의 규모나 성격에 따라 정해졌"다. → **크기는 건물에 종속된 변수**이므로 절대 치수를 고정하지 않고 어칸 폭 비율로 유도한다(`docs/architectural-authenticity.md` §9의 마당 L/H와 같은 자세).
- 실측 표본: 여수 흥국사 봉황루 안쪽 '공북루' 편액 **가로 280cm × 세로 120cm**(법보신문 「이것이 한국 불교 최초」 64. 편액). 세로/가로 ≈ 0.43. 기사가 이 크기를 "웅장하다"고 쓰므로 **상한 표본**으로 읽는다.
- 형태: 위계가 높은 현판은 가장자리에 테두리를 두르고 길상 무늬를 넣으며, 바탕은 흰색·검은색이 대표적이고 주요 전각에는 검은 바탕이 쓰인다(나무위키 「현판」; 광화문 현판 검은 바탕·금박 글씨 복원 보도). → 어두운 바탕판 + 밝은 테두리 몰딩.

출처는 **역할·형태·위치의 관례**를 확인할 뿐, 전국 사찰 현판의 폭·높이·설치 높이 분포를 제공하지 않는다. 아래 비율은 §2.1과 같은 성격의 제품 해석이며 특정 문화유산의 실측 복제가 아니다.

### 8.2 규칙

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 대상 | `architecturalRank === 4` 전각(주불전) 1동 · 정면 칸수 홀수 | 주불전은 유일한 rank-4(§7-7). 짝수 칸은 중앙축에 칸이 아니라 기둥이 온다 |
| 판 폭 | 어칸 폭 × 0.56 (기본 4.2m → 2.352m local, world 1.93–2.12m) | 어칸 종속. 두 기둥이 각 0.92m 이상 남는다 |
| 판 높이 | 폭 × 0.43 (world 0.83–0.91m) | 공북루 편액 120/280 |
| 판 두께 | 0.09m, 몰딩 rail 0.11m · 도출 0.03m | 테두리로 읽히는 최소치 |
| 수평 위치 | 어칸 중앙(전각 로컬 `x = 0`) | 관례 |
| 수직 위치 | 상단 = 평방 윗면(공포대 시작) − 0.06m. 창방을 물고 어칸 문 위로 내려온다 | "건물 앞부분 높은 곳" + 공포대 불침범 |
| 전후 위치 | 창방 앞면(기둥선 + 0.13m)에 고정, 앞면은 평방 앞면 안쪽 | 처마·평방 그늘 안 |
| 재질 | 전각 팔레트 차입 — 바탕 `planwall`(판벽 0x4a3a28, **metalness 0**), 몰딩 `wood`(백골) | 신규 재질·텍스처·clone·프로그램 0 (§8.3) |

### 8.3 예산과 불변

- **재질 metalness는 0이어야 한다.** 처마 밑은 환경맵이 없어 metalness가 스페큘러를 하나도 벌지 못하면서 디퓨즈만 깎는다 — 순손실이다. 최초 구현은 병합 그룹을 늘리지 않으려고 `hardware`(metalness 0.42)를 차입했고, 그 결과 판 내부가 휘도 0.21에 98% 고정된 검은 클램프로 떨어져 "현판이 아니라 구멍"으로 읽혔다(2026-08-05 비전 FIX). 무광 `planwall`로 교체하면 바닥 휘도가 **0.21 → 5.63**(27×)으로 올라온다. 차입 재질을 clone·변형해 metalness만 끄는 길은 금지 — 다른 `hardware` 소비자에게 번지고 프로그램 캐시키를 흔든다.
- 그 대가는 병합 그룹 +1 = **+2 draw call**(컬러 패스 1 + 그림자 패스 1): compact 97→**99**, courtyard 113→**115**, extended 139→**141**, 재질 48/56/69→49/57/70. programs는 7 불변. 그래서 `check:temple:browser`의 병합 콜 상한을 **140 → 142**로 재핀했다(귀속 주석·파생·FAIL-first 2건은 그 단언 위에 주석으로 남겼다).
- 계측 주의: "새 재질 = +2콜"은 팔레트 목록이 아니라 **그 경내가 실제로 그리는 집합**으로 판단한다. 같은 실험을 `woodBoard`로 하면 콜이 전혀 움직이지 않는다 — 맞배 부속 전각이 이미 그리는 재질이다.
- 전각당 +5 mesh / **+60 삼각형**. 마을 정적 병합 뒤 오브젝트 수는 불변이고 picking proxy 해시도 불변이다.
- 절이 포함된 씬 골든만 이동한다(2026-08-05 `check:worker`: village/town/capital/hanyang 이동, `includeTemple:false`인 mja·snapshot 케이스는 바이트 동일). 순수 plan 골든은 불변 — 현판은 plan에 저장되는 필드가 아니라 grammar에서 유도되는 파생 기록이다.
- 하지 말 것: 글자·서체 추가, 현판 전용 재질/텍스처/프로그램 생성, 부속 전각·문루로 확대(§8.4), 렌더러에서 위치 재추론, 야간 발광 태그 부여.

### 8.4 그늘 속 판을 측정할 때

현판 검수는 두 번 계측기에 속았다. 둘 다 판정이 아니라 측정 설계의 문제였다.

- **판 내부 "계조"는 이 조명 구조에서 0이 정상이다.** 처마 그늘의 평평한 수직면은 태양이 닿지 않고 hemisphere 광만 받는데, 그 값은 법선만으로 결정되므로 판 전면이 **한 값**이다(실측: compact·courtyard의 p05 = p95, 98%가 바닥값). 그래서 "그라디언트 > 0"은 재질로 달성할 수 없는 조건이고, 실제로 움직이는 지표는 **바닥 휘도**와 **몰딩 대비**다(§8.3, molding−board 20–53). extended만 gradient 44가 나오는 건 그 무대에서 판 일부에 빛이 닿기 때문이며, 이는 위 설명의 반증이 아니라 확인이다.
- **가까운 정면 캡처(`view=plaque`)는 판 상단 약 30%를 가린다.** 카메라가 판 중심보다 1.1m 위에 있어 처마 소프릿(13.4m)과 평방 립(14.95m)이 판(15m) 앞을 지난다 — `scratch` 오클루전 레이캐스트로 확인했다. 픽셀 프로브는 판의 스크린 rect 전체가 아니라 가시 대역(하단 몰딩 위 ~15% ~ 상단 가림 아래 ~62%)만 표본해야 한다. 제품의 focus 카메라는 마당에서 **올려다보므로** 이 가림은 캡처 도구의 성질이지 제품 결함이 아니다.

### 8.5 유보된 것

- **문루(누각) 편액**: 보제루·안양루 같은 누각에도 편액이 걸리고 공북루 표본 자체가 누각 것이다. 다만 누하 `gate-pavilion`은 rank 2로 주불전보다 두 단 낮고, 개방 하층 위 상층 정면에 다시 대역을 정의해야 해 이 라운드에서는 넣지 않았다. 넣을 때는 rank 4 전용 게이트 단언을 확장해야 한다.
- **바탕 재질 선택지**: `planwall`(0x4a3a28, 바닥 휘도 5.63, molding−board 24.7/53.4/49.9) 대신 `woodBoard`(0x574531, 바닥 9.91 — 1.76× 밝음)를 쓰면 **병합 콜이 전혀 늘지 않아 상한 재핀도 불필요**하지만(97/113/139) 몰딩 대비가 약 17% 준다(20.5/49.2/43.0). 현재는 의미(판벽=어두운 널)와 대비를 택해 `planwall` + 재핀으로 두었다. 되돌리려면 `compound.js`의 재질 한 줄, 게이트 두 곳의 재질 단언, 상한 142→140을 함께 돌리면 된다.
- **사용자 노출 출처 등록**: `docs/credits.md` 항목 신설은 성문 현판 라운드와 겹치므로(같은 「현판」 출처군) 리드가 한 항목으로 합쳐 등록한다. 위 URL은 그 항목의 입력이다.
  - <https://dh.aks.ac.kr/sillokwiki/index.php/현판(懸板)>
  - <http://www.beopbo.com/news/articleView.html?idxno=58863>
  - <https://namu.wiki/w/현판>
  - <https://www.ytn.co.kr/_ln/0106_201801302244118945>
