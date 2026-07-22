# 단청 표현 계약

> - **상태**: 현재 계약 + 구현 근거 리서치
> - **기준일**: 2026-07-22
> - **범위**: 궁궐·관아 전각과 사찰 전각의 절차 단청. 특정 현존 건물의 복원도는 아니다.

## 1. 적용 경계

단청은 목재 보호, 결함 은폐, 건물의 권위와 종교적 장엄을 함께 나타내는 건축 채색이다. 이 생성기에서는 `palace`와 `temple`에만 적용한다. `giwa` 반가와 `choga` 민가는 단청 설정, CanvasTexture, 패널 제어를 모두 만들지 않는다. 이는 조선시대 일반 가옥의 고급 채색 제한과 레포의 기존 유형 경계를 함께 지키기 위한 계약이다.

공통 색 어휘는 청·적·황·백·흑의 오방색을 기반으로 하되, 화면에서는 뇌록 바탕, 석간주/주홍, 삼청 계열 청색, 황토색, 호분 계열 백색으로 번역한다. 금빛은 금속 광택이 아니라 전통 안료 문양의 황색으로 표현한다.

## 2. 공식 자료에서 가져온 위계

국가유산청 국가유산포털은 단청을 다음 순서의 격식으로 설명한다.

1. 가칠단청: 뇌록·석간주 등 단색 바탕
2. 긋기단청: 먹선과 백선 중심
3. 모로단청: 부재 끝 머리초를 그리고 중앙 계풍은 선으로 정리
4. 금모로단청: 중앙 일부에 금문양을 더함
5. 금단청: 중앙을 금문양·별화로 빽빽하게 채움

출처: [국가유산청 국가유산포털, 단청](https://www.heritage.go.kr/heri/html/HtmlPage.do?pageNo=1_9_1_0&pg=%2Fcul%2FcultureEasySub01_13.jsp)

국립문화유산연구원의 궁궐·사찰 단청 안료 분석은 목재 위에 바탕층, 백토 계열 초벌, 뇌록 가칠, 채색층이 놓이는 층위를 확인한다. 조사한 서울·경기 궁궐 단청은 남부 사찰에서 흔한 화려한 금단청보다 모로단청 계열이 주를 이루며, 궁궐에는 값비싼 청색 광물 안료도 사용되었다. 이 결과는 ‘궁이면 무조건 최고 채도의 금단청’이라는 단순화를 금지하는 근거다.

- [국립문화유산연구원, 궁궐·사찰 단청 안료 분석 보도자료](https://nrich.go.kr/kor/boardView.do?bbs_idx=42127&bbscd=33&menuIdx=283)
- [국립문화유산연구원, 궁궐 단청 안료의 과학적 분석 연구 보고서](https://portal.nrich.go.kr/kor/originalUsrView.do?info_idx=8560&menuIdx=1046)

국가유산청 무형유산 해설은 궁궐 정전과 사찰 대웅전 같은 최상위 건물에는 금단청을 쓸 수 있고, 건물 위계에 따라 금단청에서 모로·긋기로 낮아진다고 설명한다. 따라서 궁의 기본값은 모로로 두되 사용자가 최상위 전각을 의도할 때 격식 축을 올릴 수 있고, 사찰 컴파운드는 중심 불전만 금단청 계열을 유지한다.

출처: [국가유산청 국가유산 해설, 단청장](https://m.cha.go.kr/public/commentary/culSelectDetail.do?ccbaAsno=00280000&ccbaCtcd=31&ccbaKdcd=22&menuId=03)

## 3. 생성기로의 번역

공개 파라미터는 두 축이다.

- `dancheongClarity` (`0..1`): 오래되어 바랜 도막에서 선명한 새 채색까지. 안료 대비와 마모 흔적을 함께 조절한다.
- `dancheongSplendor` (`0..1`): 모로 → 금모로 → 금의 문양 밀도. 재료의 반짝임이 아니라 계풍을 채우는 정도를 바꾼다.

기본값과 위계는 다음과 같다.

| 대상 | 선명도 | 격식 | 계약 |
| --- | ---: | ---: | --- |
| 궁·관아 | 0.68 | 0.28 | 모로. 머리초와 긋기, 비워 둔 중앙 계풍이 기본 |
| 사찰 중심 불전 | 0.62 | 0.82 | 금. 예불 공간의 중심만 가장 장엄 |
| 사찰 부속 불전 | 중심값에서 하향 | 최대 0.56 | 금모로 이하 |
| 사찰 요사·누각·산문 | 중심값에서 하향 | 최대 0.30 | 모로 |
| 기와집·초가 | 없음 | 없음 | 단청 리소스와 UI를 만들지 않음 |

위계 경계는 `src/builder/dancheong.js`의 `dancheongGrade()` 한 곳이 소유한다. 사찰의 공간 계획은 색 변화로 달라지지 않는다. `TemplePlan`과 worker/sync 해시는 그대로이고, 렌더 조립기만 전각 역할에 맞는 팔레트를 고른다.

## 4. 재사용·성능·수명 계약

- `src/builder/dancheong.js`는 Three와 DOM에 의존하지 않는 정규화·위계·Canvas2D 화가다. 다른 프로젝트는 같은 두 축과 painter를 재사용할 수 있다.
- 실제 Canvas 생성과 `THREE.CanvasTexture` 적응은 `src/builder/palette.js`에만 있다.
- 화면의 연속 축은 각 8구간(9레벨)으로 양자화한다. source key는 `(style, clarityBucket, splendorBucket, motifKind)`이고, 불변 Canvas LRU는 최대 96개다.
- 같은 key는 Canvas 픽셀만 공유한다. Texture와 Material 객체는 팔레트별로 소유하므로 한 궁의 편집이나 `dispose()`가 다른 궁·사찰을 바꾸지 않는다.
- 단청 변형은 모두 `MeshStandardMaterial`과 baked color map을 사용한다. 커스텀 셰이더나 프로그램 변형을 추가하지 않는다.
- 궁 컴파운드는 한 단청 팔레트로 전각 병합 바닥을 유지한다. 사찰은 중심/부속/생활의 최대 3팔레트만 허용한다.
- `buildBuilding()`은 `disposeBuilding()`, `buildPalaceCompound()`는 `disposePalaceCompound()`, `buildTempleCompound()`는 `disposeTempleCompound()`와 짝을 이룬다. 호출자가 준 팔레트는 호출자 소유다.
- CanvasTexture는 baked map이므로 GLB 정화 단계에서도 색이 보존된다. 단청 설정 자체는 `extras`로 내보내지 않는다.

## 5. 공개 사용 예

```js
import {
  PRESETS,
  buildBuilding,
  disposeBuilding,
  buildPalaceCompound,
  disposePalaceCompound,
} from './src/api/building.js';

const hall = buildBuilding({
  ...PRESETS.korea,
  dancheongClarity: 0.8,
  dancheongSplendor: 0.35,
});

const palace = buildPalaceCompound({
  tier: 'capital',
  dancheong: { clarity: 0.8, splendor: 0.35 },
});

disposeBuilding(hall);
disposePalaceCompound(palace);
```

앱 패널은 코어 객체를 직접 만지지 않는다. 궁은 `presetOverrides`, 사찰은 `templeOptions` 공개 재생성 경로를 통해 두 값을 전달하며, focus를 나갔다 들어와도 현재값을 유지한다.

## 6. 검증

```bash
npm run check:dancheong
npm run check:dancheong:browser
npm run check:dancheong:app
npm run check:worker
```

순수 게이트는 적용 유형, 기본 위계, clamp/bucket, 패널 라우팅을 검사한다. 브라우저 게이트는 source 불변성·LRU 상한, 동시 팔레트 오염, caller/owned dispose, 궁 드로콜 불변, 사찰 3단계 위계, WebGL 프로그램 상한, GLB CanvasTexture 보존과 고정 구도 PNG 차이를 검사한다. 앱 게이트는 실제 한국어 패널 입력이 공개 `templeOptions`를 거쳐 컴파운드를 재생성하고 패널·runtime spec이 같은 값을 유지하는지 검사한다. 절대 headless frame time은 성능 판정에 사용하지 않는다.

## 7. 의도적 한계

- 현존 건물 한 채의 시대별 중수 상태를 재현하는 보존과학 모델이 아니다.
- 부재별 문양 명칭과 배치는 위계의 핵심인 머리초·계풍·금문양을 읽히게 하는 절차적 축약이다.
- 낮은 LOD에서 장식을 별도 geometry로 늘리지 않는다. 멀리서는 기존 실제 외피/색과 LOD 정책을 따른다.
