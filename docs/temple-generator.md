# 재사용 가능한 한국 사찰 생성기 설계

> - **상태**: 현재 계약·구현 완료
> - **관련 이슈**: GitHub #12 — 절 크기·구성·편집 다양화, GitHub #122 — 전각 역할별 건축 위계
> - **기준일**: 2026-07-24
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

생성기는 다음 세 층으로 구현한다.

1. `src/temple/plan.js#planTempleCompound(options)` — Three.js 없이 local-space 순수 데이터만 만든다.
2. `src/temple/compound.js#buildTempleCompound(plan, resources?)` — 계획을 Three.js group으로 조립하고 `disposeTempleCompound()`로 소유 자원을 해제한다.
3. `src/village/temple-plan.js`와 `src/generators/village/features.js` — site의 `baseY`, 회전 transform, terrain apron, approach, 식생 예약을 결합한다.

외부 소비자는 Three 없는 `src/api/temple-plan.js` 또는 renderer까지 포함한 `src/api/temple.js`를 쓴다. 내부 계획기는 village나 Svelte를 import하지 않는다. 다른 프로젝트는 terrain/village 없이도 local-space 가람만 만들 수 있고, 렌더러는 건물·프롭 위치나 역할별 지붕·공포·처마를 새로 추론하지 않고 plan을 그대로 소비한다. 순수 `src/temple/role-hierarchy.js`가 역할 repertoire, builder parameter 변환, 실제 처마 polygon을 함께 소유한다.

권장 계획 데이터:

```js
{
  schemaVersion: 2,
  seed,
  variant,          // compact | courtyard | extended
  width, depth,
  axis,
  courtyards: [{ id, polygon, level }],
  buildings: [{
    id, role, style, position, yaw, frontBays, sideBays,
    architecturalRank, roofGrammar, bracketGrammar, eaveGrammar, massingGrammar,
    eaveFootprint, footprint,
  }],
  enclosures: [{ id, role, polygon, gateId }],
  gates: [{ id, role, position, yaw }],
  props: [{ id, role, kind, position, yaw, scale }],
  paths: [{ id, role, points, width }]
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

## 5. 편집 계약

편집 패널은 렌더 오브젝트를 직접 조작하지 않고 `templeOptions`를 통해 계획 옵션을 갱신한다.

- `variant`, 전각 수, 축 굴절 정도, 중정 여백.
- 석탑 없음/한 기/쌍탑/자동, 석등 수, 종루·당간지주·부도 포함 여부.
- 마을이 예약한 최대 크기에 들어가는 변형만 패널에 노출한다.
- 변형을 바꾸면 그 문법의 전각·기념물 기본값을 함께 다시 시드해 UI 숫자와 planner clamp가 어긋나지 않게 한다.
- 폭·깊이는 마을 재생성 전에 터 계획이 소유한다. focus 편집이 예약 경계를 몰래 키우지 않는다.

옵션 변경은 같은 seed에서 건물/프롭 ID를 가능한 한 보존해 선택 상태와 애니메이션이 불필요하게 깨지지 않게 한다.

## 6. 품질과 검증 기준

- 순수 계획: `npm run check:temple`이 30개 변형·크기·seed fixture와 6개 마을 adapter에서 겹침, 실제 처마 footprint 이탈, 역할 위계, 결정론, 남측 일조축, 접근로를 검사한다. 별도 v1 fixture는 새 architecture 필드를 모두 제거한 뒤 deterministic v2와 동일하게 승격되는지, 누락·미래 schema가 거절되는지도 고정한다.
- 역사성: 역할별 배치 규칙을 자동 검사하되, 모든 사찰을 완전 대칭 한 템플릿으로 만들지 않는다.
- 시각: `temple.html`에서 compact/courtyard/extended의 부감·남측 26° 망원 구도를 직접 보고, `npm run shoot:focus-level`로 실제 앱의 사찰 focus와 편집 전환을 확인한다.
- 성능: `npm run check:temple:browser`가 raw/부감 merge 삼각형 동등성과 draw call을 기록한다. 2026-07-24 Chrome/Apple M1 Pro 기준 장면은 compact `845→97`, courtyard `1517→113`, extended `2685→139`이며, 병합본은 140콜·7 programs, 전체 재질은 72개 이하를 유지한다. 브라우저/드라이버가 다른 절대 시간은 비교하지 않는다.
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

계획·renderer·village adapter·앱 schema·브라우저 게이트가 독립 파일을 가져 후속 병렬 작업이 같은 조립 파일을 불필요하게 공유하지 않게 한다.
