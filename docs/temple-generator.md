# 재사용 가능한 한국 사찰 생성기 설계

> - **상태**: 대기 설계
> - **관련 이슈**: GitHub #12 — 절 크기·구성·편집 다양화
> - **선행 조건**: 사찰 터 재배치 #5 리뷰·머지
> - **목표 경계**: `src/`의 framework-agnostic Three.js 모듈, `app/` 의존 금지

## 1. 목표와 현재 공백

사용자가 원하는 것은 특정 산사 한 채가 아니라, 규모와 지형에 따라 아름답고 서로 다른 한국 사찰이 나타나는 생성기다. 산속·계류변·마을 가장자리·도성 안을 모두 지원해야 하며, 한 동짜리 구성도 작은 암자형의 한 변형일 뿐 유일한 결과가 아니다.

현재 `buildTempleCluster()`는 `buildParcel({style:'temple'})` 한 번만 호출한다. 경내에는 빈 좌대 네 개가 놓이지만 기존 `src/props/temple.js`의 삼층석탑·석등·당간지주·부도는 사용하지 않는다. 즉 자산 부족이 아니라 **순수 가람 계획과 의미 기반 배치가 없는 것**이 핵심 공백이다.

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

## 3. 모듈 경계

생성기는 세 층으로 나눈다.

1. `planTempleCompound(options)` — Three.js 없이 local-space 순수 데이터만 만든다.
2. `buildTempleCompound(plan, resources?)` — 계획을 Three.js group으로 조립한다.
3. village adapter — site의 `baseY`, world transform, terrain apron, approach를 결합한다.

공개 소비자는 `src/api/`를 통하고, 내부 계획기는 village나 Svelte를 import하지 않는다. 다른 프로젝트는 terrain/village 없이도 local-space 가람만 만들 수 있어야 한다. 렌더러는 건물·프롭 위치를 새로 추론하지 않고 plan을 그대로 소비한다.

권장 계획 데이터:

```js
{
  seed,
  variant,          // compact | courtyard | extended
  width, depth,
  axis,
  courtyards: [{ id, polygon, level }],
  buildings: [{ id, role, style, position, yaw, bays, depthBays, level }],
  gates: [{ id, role, position, yaw }],
  props: [{ id, role, kind, position, yaw, scale }],
  paths: [{ id, role, points, width }]
}
```

모든 ID와 배열 순서는 seed에 대해 안정적이어야 한다. village 배치가 큰 가람을 렌더 단계에서 임의 확대해서는 안 된다. 변형이 요구하는 실제 footprint를 사찰 터 계획에 먼저 전달해 필지·도로·식생 예약이 같은 경계를 쓰게 한다.

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

편집 패널은 렌더 오브젝트를 직접 조작하지 않고 계획 옵션을 갱신한다.

- seed, variant, 전체 폭/깊이.
- 전각 수와 주불전/부불전 bays.
- 축 굴절 정도, 중정 여백, 단차 수.
- 문루·종루·요사 포함 여부.
- 석탑 유형/개수, 석등/당간지주/부도 포함 여부.
- 단청 강도나 palette는 geometry 계획과 분리한다.

옵션 변경은 같은 seed에서 건물/프롭 ID를 가능한 한 보존해 선택 상태와 애니메이션이 불필요하게 깨지지 않게 한다.

## 6. 품질과 검증 기준

- 순수 계획: 규모×변형×다중 seed에서 polygon 겹침, 보행축 폐쇄, footprint 이탈, 비결정성을 검사한다.
- 역사성: 역할별 배치 규칙을 자동 검사하되, 모든 사찰을 완전 대칭 한 템플릿으로 만들지 않는다.
- 시각: compact/courtyard/extended 각각 부감·진입·중정·주불전 근접 PNG를 직접 본다.
- 성능: 건물 재질을 공유하고 반복 프롭은 가능한 경우 merge/instance한다. 변형별 draw call과 program delta를 기록한다.
- 수명주기: 독립 생성 결과에 명시적 dispose 계약을 제공하고 호출자 소유 재질은 보존한다.
- 재사용: public API bundle이 Svelte·village runtime 없이 성공해야 한다.

완료 최소선은 세 변형이 실질적으로 다른 실루엣과 동선을 만들고, 그중 둘 이상이 여러 전각을 가지며, 준비된 사찰 프롭이 의미 있는 위치에 등장하는 것이다. 현재 한 동짜리 경내를 단순히 랜덤 프롭으로 채우는 것은 완료로 보지 않는다.

## 7. 작업 분할

1. 순수 plan schema와 겹침/결정론 게이트.
2. compact/courtyard/extended local-space 계획기.
3. 기존 building·prop을 소비하는 renderer와 dispose.
4. village 터 계획의 가변 footprint 연동.
5. `src/api/` 공개 façade와 standalone 하네스.
6. Svelte 편집 패널 연결.

각 단계는 독립 파일과 독립 게이트를 가져 병렬 작업 시 같은 조립 파일을 동시에 수정하지 않게 한다.
