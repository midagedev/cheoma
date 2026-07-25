# UI 정돈 감사 · 재설계안

상태: **감사·제안** (구현 계약 아님). 사용자가 A/B 중 한 안을 고르면 그 안이 계약으로 승격되고, 이 문서의
"승계" 절이 `ui-design.md`·`mode-integration.md` 개정 범위를 지정한다.

기준 커밋: `142d637`. 측정 환경: 고정 스냅샷 dev 서버, Chrome(headless), deviceScaleFactor 1,
뷰포트 1280×800 / 1024×640 / 844×390(coarse pointer) / 390×844(coarse) / 360×780(coarse).
이번 라운드는 소스를 수정하지 않았다(이 문서 1개만 신규).

측정 시점 주의 — `device.perf` 정의 변경이 병행 중이었다. 감사 대상(`142d637`)은
`perf = touch || w <= 900`이고, 병행 라운드가 이를 `perf = phone = touch && min(w,h) <= 520`으로
좁히고 있다. `hideActions = device.perf && editing`이 이 값을 소비하므로 그 변경 후에는
**태블릿·좁은 데스크톱 창에서 액션바가 더 이상 사라지지 않는다**(개선). 폰(세로 390×844·가로 844×390)은
두 정의 모두 `perf=true`이므로 아래 P1·P2의 "사진 찍기 미노출" 판정은 변경과 무관하게 유효하다.

승계 관계:
- `ui-design.md` §2 레이아웃 스케치는 "우상 다이얼 / 우하 액션 / 좌하 낙관 / 우측 한지 패널"의 4슬롯 모델이다.
  현재 구현은 여기에 **좌상 ModeToggle·RenderStyleToggle·좌상 컨텍스트 카드**가 추가되면서 좌상 슬롯이
  3중 점유 상태가 되었다. 아래 P1·P4는 그 3중 점유의 직접 결과다.
- `mode-integration.md` §5.5 원칙 2(단일 컨텍스트 패널)·원칙 5(마을 패널 = 마을의 편집기)는 유지 대상이다.
  A안은 이 원칙을 건드리지 않는다. B안은 원칙 2의 "모프" 표현을 "탭+모프"로 재해석하므로 §5.5 개정을 동반한다.
- `ui-design.md` §4.6(조작 안내)·§4.7(키보드 건물 탐색)의 배치 전제는 P5·P8에서 갱신이 필요하다.

---

## 1. 컴포넌트 인벤토리

### 1.1 Svelte 컴포넌트 (`app/src/components/`)

| 컴포넌트 | 역할 | 진입 경로 | 상태 소유 | 데스크톱 / 모바일 차이 | 중복·겹침 |
|---|---|---|---|---|---|
| `App.svelte` (1335줄) | 전체 오케스트레이터. 엔진 이벤트 20종 수신, URL 동기화, 라이프사이클 타이머, 흐름 클록, 워크 입력 | 루트 | 유일한 진실원(`ui`, `villageOpts`, `editParams`, `villageEditing`, `focusMorph`, `cine`, `veil`, `waving` 등 30여 개 `$state`) | 없음 | — |
| `Hero.svelte` | 진입 타이틀(로고 + 입장) | `?hero` 기본 ON, `?shot`·`?village=1` 제외 | 없음(props) | 가로폰만 타이틀 축소 | — |
| `ModeToggle.svelte` | 둘러보기(村) / 집 보기(家) 2-state | 상시(시네마틱 중 언마운트) | 없음. `mode`는 App 파생 | 좌상 고정. 터치는 padding↑(47px) | 좌상 슬롯을 `RenderStyleToggle`·`ctxcard`와 공유 |
| `RenderStyleToggle.svelte` | 풍경(景) / 수묵(墨) | 상시(시네마틱 중 언마운트) | 없음 | 좌상, ModeToggle 아래 고정 | **`ctxcard`와 좌표 완전 중복(P4)** |
| `EnvironmentDial.svelte` | 3링 다이얼(시간·계절·날씨) + 하단 3버튼(환경 굴리기 ⟳ / 노을빛 / 시간 흐르기) | 상시. `.chroma` 페이드 대상 | `spins`, `dragging`(로컬) | 우상 고정. 세로 모바일 svg 158px 축소, 가로폰 126px. `.shifted`는 모바일에서 무효화 | `.chroma` 페이드 그룹에 속해 패널만 남는 비대칭(P6) |
| `ActionBar.svelte` | 우하 도장 액션: (다시 짓기) / 드론 ▷ / 거닐기 步 / 사진 찍기 / 공유 / 사운드 ♪ | 상시. 터치+편집 중엔 App이 미노출(`hideActions`) | 없음 | 터치는 `raised`(bottom 96px)·z42. 편집 중 전면 숨김 | 공유·다시 짓기가 ContextPanel과 이중 구현(P9) |
| `ContextPanel.svelte` (737줄) | **단일 컨텍스트 패널**: 브레드크럼 + 건물 선택 + 마을 섹션(규모·궁·절·상세 13축) + 집 섹션(스키마 24~26축) + sticky 푸터(다시 짓기·내보내기·공유) | 마을 씬 상주(`sceneVillage`), 히어로 랜딩·시네마틱 중 `open=false` | `dragVal`, `showVDetail`, `showAdv`, `navigationDraftId`(로컬). 값은 App 소유 | `BottomSheet variant="context"` 경유 → 데스크톱 좌상 카드 / 세로모바일 바텀시트 / **가로폰은 데스크톱 카드 경로**(P1) | 유형탭·공유·리롤이 `ParamPanel`과 병존 |
| `ParamPanel.svelte` | 레거시 단일건물 패널: 유형 4종 탭 / 확장 一·ㄱ·ㄷ / 병합 / 슬라이더 | `?hero=0`·`?village` 아닌 세션에서 건물 선택 시 | `timers`(디바운스) | `BottomSheet variant="right"` → 우측 드로어 / 세로모바일 시트(스크림·닫기 X) | ContextPanel과 정보구조 이중 유지(P10) |
| `BottomSheet.svelte` | 패널 셸 3형태: `.panel`(우측 드로어) / `.ctxcard`(좌상 카드) / `.sheet`(바텀시트 3-detent) | ContextPanel·ParamPanel이 사용 | `snap`, `dragY`, `sheetH`, `dragging` | `device.sheet`(≤768px & portrait)만 시트. 그 외 전부 데스크톱 경로 | `detent` prop이 사문화(P3) |
| `SealLabel.svelte` | 낙관(브랜드) + 씨앗번호 + ⓘ + EN/한 | 상시. `.chroma` 페이드 대상. 세로시트+편집 시 숨김 | 없음(i18n 전역) | 터치는 타깃 확대 | 참고자료 트리거 2개(낙관·ⓘ). 언어 설정이 브랜딩 자리에 |
| `HoverLabel.svelte` | 커서 옆 미니 라벨(유형·칸수 / 문 열기·닫기) | 마을 씬 `villageHover` 이벤트 | 없음 | 호버 전용 → **터치에서 영구 미노출**(P7) | — |
| `SceneGuide.svelte` | 최초 안정 프레임 조작 안내 4줄 | 마을 씬 안착 후 1회(localStorage 기억) | 없음 | 세로모바일 bottom 170px, 가로폰 88px | **ActionBar와 겹침**(P5) |
| `CinematicOverlay.svelte` | 드론·거닐기 중 장면 라벨 + 종료 버튼 | `cine.active` | 없음 | 터치 패딩↑ | 시네마틱 중 유일한 복귀 창구 |
| `ReferenceModal.svelte` | 참고 자료·크레딧 모달(`docs/credits.md` 파싱) | 낙관·ⓘ 클릭 | 로컬 포커스 트랩·검색 | 세로모바일 풀스크린 시트, 그 외 84vh 중앙 | 감사 결과 **문제 없음**(유일하게 반응형·포커스 관리가 정합) |

### 1.2 UI 상태·스키마 라이브러리 (`app/src/lib/`)

| 파일 | 역할 | UI 정돈 관점 |
|---|---|---|
| `edit-schema.js` | 집 편집 스키마(초가 26필드 / 기와 24 / 종가 8 / 관아 15 / 궁궐 9 / 절 11~14) + 마을 스키마(13필드 3그룹) | 정돈의 실제 레버. 섹션 순서·`adv` 플래그·라벨키가 전부 여기 |
| `device.svelte.js` | `sheet`/`touch`/`landscapePhone`/`compact`/`perf` matchMedia 단일 소스 | `landscapePhone`을 **아무 컴포넌트도 소비하지 않음** → P1의 근인. `perf` 정의는 병행 변경 중(위 주의) |
| `scene-guide.js` | 안내 가시 조건 9개 게이트 | 조건은 정밀하나 배치가 P5 |
| `building-navigation.js` | 건물 탐색 후보 정규화·상태 | 라벨 규약이 `기와집 N` 순번뿐 → P8 |
| `i18n.svelte.js` | ko/en 라벨 사전 | `s_<key>`/`sec_<id>`/`vsec_<id>` 3계열 혼재 |
| `live-edit-scheduler.js` | 드래그 프리뷰 병합·놓을 때 커밋 | 적정 |
| `url.js`·`scene-snapshot.js`·`share-scene.js`·`residential-edit-url.js` | 주소·공유 계약 | UI 표면과 무관 |

### 1.3 three.js 측 UI(씬 내 어포던스) — `app/src/engine/` + `src/env/`

| 표현 | 소유 | DOM UI와의 역할 분담 | 정합성 |
|---|---|---|---|
| `highlightParcel` 호버 하이라이트 | `engine.js` 마을 핸들 | `HoverLabel`(DOM)과 한 이벤트에서 동기 | 정합. 단 둘 다 호버 전용 |
| `OutlinePass` 윤곽(`outline.selectedObjects`) | `engine.js` | 단일건물 씬 호버 전용. focus 중엔 강제 해제 | 마을 씬 호버는 하이라이트, 단일건물은 아웃라인 — **두 씬이 서로 다른 어포던스** |
| 커서 변경(`domElement.style.cursor`) | `engine.js` | 클릭 가능 신호 | 정합 |
| focus 링(닭·연기·바람풀·등롱) | `src/env/focus.js` | 앰비언스. UI 아님 | 정합(UI로 오인되지 않음) |
| 문 열기/닫기 인터랙션 | `engine.js` focus 전용 | `HoverLabel`이 힌트 문구 담당 | **터치에 힌트 경로 없음 + `SceneGuide` 4줄에도 미기재**(P7) |
| `debugOverlayBox`·`debugFocus`·`debugParcels` | `engine.js` | 검증 훅. 제품 UI 아님 | 정합(누출 없음) |
| 먹 안개 베일(`.veil`) | `App.svelte` DOM | 생성 프리즈 은닉 | 정합 |
| 뷰 시프트(`view-shift.js`) | 엔진 | DOM 크롬 rect를 실측해 피사체를 가시영역으로 | 크롬이 화면의 88%를 덮으면 시프트할 여백이 없어 무력화(P2) |

---

## 2. 문제 목록

심각도: **S1** 기능 도달 불가 / **S2** 사용 불가 수준의 정보구조·가시성 / **S3** 정돈·일관성.

### P1 (S1) 가로 폰에서 편집 UI가 구조적으로 사용 불가

`BottomSheet`는 `device.sheet`(`max-width:768px and portrait`)만 시트로 전환한다. 가로 폰(844×390)은
`device.landscapePhone=true`이지만 이 값을 소비하는 컴포넌트가 없어 **데스크톱 좌상 카드 경로**를 탄다.
카드 높이는 `max-height: calc(100vh - clamp(10px,1.6vh,22px) - 200px)` = 177px로 클램프된다.

실측(844×390, 집 focus):

```
.ctxcard   y=62  h=180
 ├ .ctxhead  h=151   (브레드크럼 28 + 건물 선택 select 44 + 상태문 + 구분선)
 ├ .ctxscroll h=26   ← 내용 1629px  (62배 초과)
 └ .ctxfoot  h=79    y=240..319 이지만 카드 bottom=242 + overflow:hidden → 2px만 노출
```

히트테스트: `이 집 다시 짓기` → `covered:CANVAS`, `공유` → `covered:CANVAS`, `사진 찍기` → **absent**
(`hideActions = device.perf && editing`으로 ActionBar 전체 미노출). 즉 **가로 폰에서 집에 들어가면
다시 짓기·내보내기·공유·사진 찍기 어느 것도 누를 수 없고**, 편집 슬라이더는 26px 창으로 봐야 한다.
증거: `p04-landscape-house-card.png`, `m10-landscape-house`.

### P2 (S1) 세로 모바일 — 세 detent 모두 실패

`.sheet`는 `max-height:88vh` = 743px(390×844)이고 detent는 translateY로만 표현된다.

| detent | 시트 top | 조작 가능 컨트롤 | 문제 |
|---|---|---|---|
| peek(기본) | 762 | **1개**(손잡이) | 아무 것도 안 보임 |
| half | 442 | 21개(부감) | 스크롤 뷰포트 `clientH=438`인데 **화면 안은 98px**. 끝까지 내려도 마지막 컨트롤 `bottom=1159 > vh 844` → **도달 불가**. `ActionBar`(y=690)는 시트(z46 > z42)에 완전히 가려짐 |
| full | 101 | 47개 | 씬 가시 영역 101px(12%) — **편집 중인 집이 안 보인다** |

`#118 U1`이 헤더·푸터를 시트 상단에 도킹해 액션 매몰을 막았지만, **스크롤 본문 자체가 뷰포트 밖으로
341px 밀려나는 근인**은 남아 있다. 증거: `m02-village-half.png`, `m05-house-focus-sheet.png`,
`p01-phone-half-scrolled-bottom.png`. 360×780에서도 동일(`sheetfoot y=882`).

### P3 (S1) focus-in이 시트를 열지 않는다 — `detent` prop 사문화

`BottomSheet` 주석은 "detent prop 으로 컨텍스트 전환 시 외부에서 detent 요청(부감=peek, 근접=half)"을
계약으로 적고 `$effect`도 구현되어 있으나, `App.svelte`가 `<ContextPanel detent={null} …>`로 **하드코딩**해
넘긴다. `ContextPanel`도 이 prop을 그대로 통과시키기만 한다.

실측: 세로 모바일에서 `debugFocus` 전후 `data-snap`이 `peek → peek`. 히어로 랜딩 직후(`m12-hero-landed`)도
`peek` + 조작 가능 컨트롤 **0/64**. 즉 모바일 첫 사용자는 종가에 착륙한 뒤 "펼치기" 손잡이를 찾아 누르지
않으면 편집·리롤·공유의 어느 창구도 만나지 못한다.

### P4 (S1) `RenderStyleToggle`이 컨텍스트 패널 브레드크럼을 덮는다 (전 뷰포트)

두 요소가 같은 좌표를 계산한다.

```
.render-style  left: clamp(10,1.6vw,22)   top: clamp(62px, 1.6vh+52, 74px)   z-index 40
.ctxcard       left: clamp(10,1.6vw,22)   top: calc(clamp(10,1.6vh,22) + 52) z-index 32
→ 1280×800에서 둘 다 (20, 65). z40이 이기므로 카드 헤더 위에 그려진다.
```

히트테스트 `.crumb.root.link`(= focus-out 정규 창구) → 데스크톱 `covered:render-style`,
가로폰도 동일. **부감에서는 `마을` 제목과 `33호` 배지가, 근접에서는 focus-out 버튼이 가려진다.**
ESC·ModeToggle이 우회로로 남아 기능 전체가 죽지는 않지만, `mode-integration.md` §5.5 원칙 1이 지정한
"마을 브레드크럼" 창구는 현재 클릭할 수 없다. 증거: `d01-village-aerial.png`, `d04-house-focus-edit.png`.

### P5 (S2) `SceneGuide`가 `ActionBar`를 가린다

1280×800 부감: guide `x 366..914, y 662..776`, actions `x 894..1250, y 718..776` → x 894..914 겹침.
1024×640에서도 겹침. 안내 카드는 `pointer-events:none`이라 클릭은 통과하지만 드론 ▷ 버튼이 시각적으로
반쯤 가려진다(첫 사용자가 정확히 보는 프레임에서). 가로폰에서는 guide가 `ctxcard`까지 덮는다
(`p04`). 증거: `d01-village-aerial.png`, `p03-landscape-aerial-card.png`.

### P6 (S2) `.chroma` 감상 페이드의 대상 선택이 뒤집혀 있다

3초 무조작 시 페이드되는 것은 `SealLabel`·`EnvironmentDial`·`ActionBar`이고, **가장 큰 크롬인
`ContextPanel`(데스크톱 300×587 = 화면 높이 73%)과 좌상 토글 2종은 그대로 남는다.**
"씬이 주인공"이라는 `ui-design.md` §2 의도와 반대 방향이다. 세로 모바일에서도 시트 peek 손잡이는 상주한다.

부수: 모바일 상단 `ModeToggle`(x 10..230)과 `EnvironmentDial`(x 222..380) 바운딩 박스가 8px 겹친다
(390px 폭, `modeXdial: true`). 링 여백 덕에 지금은 시각적 충돌이 약하지만 ≤380px 폭에서는 실제로 겹친다.

### P7 (S2) 발견 가능성 — 터치에서 사라지는 인터랙션

- 문 열기/닫기: `focus` 중 문 호버 → `HoverLabel` 힌트. **터치에는 호버가 없어 힌트가 영구 미노출**이고
  `SceneGuide` 4줄(둘러보기·확대·집 선택·복귀)에도 없다. 즉 터치 사용자에게 이 인터랙션은 존재하지 않는다.
- 유형 라벨·칸수도 같은 라벨에만 실려 있어 터치에서는 집을 눌러 들어가기 전까지 무엇인지 알 수 없다.
- 마을 부감의 호버 하이라이트도 터치 미적용 → "집을 탭하면 반응한다"는 신호가 탭 이후에만 온다.

### P8 (S2) 건물 선택기가 한양 규모에서 붕괴

`#building-navigation`은 native select이고 한양(R500)에서 **옵션 297개**, 라벨은 `기와집 1 … 기와집 297`
순번뿐이다(`building-navigation.js` `NAVIGATION_LABEL_KEYS`). 구역·대로·랜드마크 문맥이 없어 선택 의미가
없고, 이 select가 sticky 헤더에서 44~90px를 상시 점유해 P1(가로폰 26px 스크롤)의 절반을 만든다.
증거: `d07-hanyang-aerial.png`(`options: 297`).

### P9 (S3) 중복 컨트롤

| 기능 | 구현 위치 | 비고 |
|---|---|---|
| 공유 | `ActionBar .seal[data-action=share]` / `ContextPanel .hbtn.share` / `ParamPanel .share` | 3곳. 터치+편집이면 액션바가 사라져 패널 것만 남는 조건부 이관 |
| 다시 짓기 | `ActionBar .seal.primary`(단일건물 새 씨앗) / `ContextPanel .rebuild`(마을 웨이브) / `ContextPanel .hbtn.reroll`(이 집) | 같은 "재(再)" 은유로 의미 3종 |
| 내보내기 | `ContextPanel .glb`(마을) / `.hbtn.glb`(집) | 액션바엔 없음 — 액션 위계가 두 표면에 갈림 |
| 유형 선택 | `ParamPanel` 4종(궁·절·기와·초가) / `ContextPanel` 2종(기와·초가) | 같은 축, 다른 어휘 |
| 참고 자료 | `SealLabel .brand` / `.info` | 동일 동작 트리거 2개 |
| 접기 토글 | `마을 상세` / `고급` — 동일 `.advtoggle` 룩, 다른 층위 | 어느 것이 무엇을 접는지 위계 불명 |

### P10 (S3) 계층 혼재 — 한 패널이 4종 성격을 담는다

`ContextPanel` 한 컨테이너 안에 (1) **탐색**(건물 선택+이동), (2) **생성 파라미터**(마을 13축, 재생성 커밋),
(3) **편집 파라미터**(집 24~26축, 라이브), (4) **출력**(내보내기·공유)이 섞여 있다. 셋은 커밋 의미가 다르다
— 마을 축은 전-마을 웨이브(3.6s), 집 축은 라이브 rAF, 특수 컴파운드는 놓을 때 재생성.
같은 룩의 슬라이더가 세 가지 다른 대가를 갖는데 UI에 그 구분이 없다.

동시에 "보기" 성격의 컨트롤은 세 코너로 흩어져 있다: 렌더 스타일(좌상) / 시간·계절·날씨·노을·흐름(우상) /
사진·공유·사운드·시네마틱(우하). 반대로 `ParamPanel`(확장 一·ㄱ·ㄷ, 병합 合)은 마을 경로에 대응 개념이 없어
두 정보구조가 병존한다.

### P11 (S3) 두 접기 그룹 모두 기본 펼침 → 폴드 초과

사용자 지시(2026-07-19 "고급설정 숨기지 말 것")로 `showVDetail`·`showAdv` 기본 `true`다. 결과:

| 뷰포트 | 스크롤 창 | 내용 | 초과 |
|---|---|---|---|
| 1280×800 부감 | 322px | 580px | 1.8× |
| 1280×800 집 편집 | 309px | 1145px | 3.7× |
| 1024×640 집 편집 | 151px | 1145px | 7.6× |
| 844×390 집 편집 | 26px | 1629px | 62× |

지시 자체는 유지 대상이다(접기가 답이 아님). 문제는 **패널 셸이 그 분량을 담을 크기를 갖지 못한다**는 것이며,
`.ctxcard`의 `max-height: 100vh - 200px` 상수 200이 그 상한을 임의로 고정한다.

### P12 (S3) 상태 표시 불일치

`ModeToggle`은 2-state(둘러보기/집 보기)지만 실제 상태는 부감·전환중·집 focus·거닐기·드론·수묵의 조합이다.
- 시네마틱 진입 시 `ModeToggle`·`RenderStyleToggle`이 **언마운트**되고 복귀 창구는 `CinematicOverlay` 종료
  버튼뿐(ESC도 동작하나 표시 없음).
- 수묵 모드는 mode와 직교인데 바로 아래 같은 룩의 세그먼트로 놓여 같은 축처럼 읽힌다.
- 전환 중(`villageZooming`) 표시는 `mode='house'`로 선점되어, 되돌아가는 중인지 들어가는 중인지 구분 없음.
- 마을 상세 슬라이더는 `aria-label`/`aria-valuetext`가 없고(값이 `1.00`으로만 읽힘), 집 편집 슬라이더는
  둘 다 있다 — 같은 패널 안에서 접근성 규약이 갈린다.

---

## 3. 재설계안

### A안 — 보수: 슬롯 정돈 + 셸 수리 + 중복 제거 (구조 유지)

정보구조와 `mode-integration.md` §5.5 원칙을 그대로 두고, **좌상 3중 점유·시트 detent·가로폰 경로**라는
세 개의 기하 결함을 고치고 중복 컨트롤을 단일화한다.

```
데스크톱 1280×800 (A안)
┌──────────────────────────────────────────────────────────────┐
│ [村 둘러보기│家 집 보기]                          ◔ 환경 다이얼 │
│ ┌───────────────────────┐                        ⟳  ◑  ☾    │ ← 렌더 스타일(景/墨)을
│ │ 마을 › 초가        33호│                        景 墨       │   다이얼 액션 행으로 이설
│ │ ─────────────────────  │                                    │
│ │ [건물 선택 ▾] 접힘 기본 │        (씬 — 풀블리드)              │
│ │ 규모 ──●──── 마을      │                                    │
│ │ □궁 □절                │                                    │
│ │ − 마을 상세 (펼침 유지) │                                    │
│ │   지형 3 · 구성 4 · 어휘 4                                   │
│ ├───────────────────────┤                                    │
│ │ 再 마을 다시 짓기       │  ← sticky 푸터 유지                 │
│ │ ⬗ 마을 내보내기         │                                    │
│ └───────────────────────┘                                    │
│ 처마 #2529 ⓘ  EN·한        [안내 카드]  [사진][공유][♪][▷][步] │ ← 안내 x-클램프로 액션바 회피
└──────────────────────────────────────────────────────────────┘
```

```
세로 모바일 390×844 (A안)  — detent 배선 복구 + 시트 높이를 detent별로 상한
 부감(peek 기본)                  근접(focus-in → half 자동)
┌──────────────┐                ┌──────────────┐
│[村│家]   ◔   │                │[村│家]   ◔   │
│              │                │              │
│   (씬)       │  씬 60% 상시    │   (편집 중인  │  씬 46% 상시 가시
│              │                │    집이 보인다)│
│              │                ├──────────────┤
├──────────────┤                │   ⌃ 접기      │
│  ⌄ 편집 열기  │                │ 마을 › 초가   │
└──────────────┘                │ 再 이 집 다시 │  헤더·푸터 도킹 유지
                                │ ─ 스크롤 본문 │  ← 본문 높이 = 가시 영역 실측
                                └──────────────┘
```

- **A1 (P4 해소)** `RenderStyleToggle`을 좌상에서 제거하고 `EnvironmentDial` 하단 액션 행(⟳·노을·흐름 옆)의
  네 번째 칩으로 이설. 좌상은 `ModeToggle` + `ctxcard` 2단만 남아 충돌이 원천 소멸하고, "보기" 성격 컨트롤이
  우상 한 곳으로 모인다(B안 IA를 부분 선취하는 저비용 조치).
- **A2 (P2·P3 해소)** `BottomSheet` detent를 **translateY가 아니라 가시 높이**로 정의한다.
  `half`는 `max-height: 54vh`, `full`은 `max-height: 88vh`로 각각 두고 detent 전환 시 높이를 바꾼다
  → 스크롤 본문이 뷰포트 밖으로 나가지 않는다. `App.svelte`가 `detent`를 실제로 전달
  (`detent = villageEditing || villageZooming ? 'half' : 'peek'`)해 사문화된 계약을 되살린다.
- **A3 (P1 해소)** `BottomSheet`가 `device.landscapePhone`을 소비한다. 가로폰은 **좌측 40% 폭 오버레이 패널**
  (`top:8px; bottom:8px; width:min(340px,42vw)`)로 전환해 카드 `max-height 100vh-200px` 상수를 벗어난다.
  헤더의 건물 선택기는 접힘 기본(A4)이라 스크롤 본문이 200px 이상 확보된다.
- **A4 (P8·P11 완화)** 건물 선택기를 헤더 상주에서 **접이식 행**으로 내리고(기본 접힘, 배지로 현재 건물만 표시),
  옵션을 [랜드마크(종가·궁·절·관아) → 현재 주변 N채 → 최근 방문]으로 상한 20개 그룹핑
  (`<optgroup>`), 라벨에 도로·구역 문맥을 붙인다(`가로 3의 기와집`).
- **A5 (P5·P6)** `SceneGuide`를 `left:50%` 중앙 고정에서 **액션바 폭을 뺀 가용 중앙**으로 클램프
  (`max-width: calc(100vw - 좌우 크롬)`), 가로폰에서는 패널 아래로. `.chroma` 페이드 그룹에
  `ContextPanel`(부감·미편집 상태에서만)과 `.modewrap`을 포함시켜 감상 페이드를 실제로 "씬만 남기기"로 만든다.
  모바일 상단은 `ModeToggle`을 글리프만(村/家) 축약해 220px → 96px로 줄여 다이얼과의 8px 겹침 제거.
- **A6 (P9)** 공유는 **액션바 1곳**으로 단일화하고 `hideActions`를 폐기(편집 중에도 액션바 유지, 시트/패널과
  겹치지 않는 슬롯이 A2·A3로 확보됨). 패널 푸터는 컨텍스트 전용 액션(다시 짓기·내보내기)만 갖는다.
  참고 자료 트리거는 ⓘ 하나로.
- **A7 (P7)** `SceneGuide`에 다섯 번째 줄 "문을 눌러 열고 닫기"(focus 컨텍스트에서만 표시) 추가 +
  터치에서 focus 진입 시 문 위 1회 펄스 힌트(기존 `HoverLabel`을 tap-hint로 재사용).
- **A8 (P12)** `ModeToggle`에 전환 중 상태(`aria-busy` + 세그먼트 진행 표시) 추가, 시네마틱 중에도
  `ModeToggle`을 언마운트하지 않고 비활성 표시로 상주. 마을 상세 슬라이더에 `aria-label`/`aria-valuetext` 부여.

바뀌는 컴포넌트: `BottomSheet`(detent·landscapePhone — 핵심), `App.svelte`(detent 전달·hideActions 폐기·
chroma 그룹), `RenderStyleToggle`→`EnvironmentDial`(이설), `ContextPanel`(헤더 접이식·a11y),
`SceneGuide`(클램프·5번째 줄), `ModeToggle`(축약·상태), `ActionBar`(shifted 규칙 재계산),
`building-navigation.js`(그룹핑·라벨).

모바일 대응: A2·A3가 세로·가로를 각각 정면으로 다룬다. 씬 가시율 목표 — 부감 ≥60%, 근접 편집 ≥46%.
구현 규모: **중간**(컴포넌트 7개 + lib 1개, 신규 개념 0). 리스크: **낮음**.
`?shot=1` 경로는 크롬을 띄우지 않아 골든 스크린샷 픽셀 불변. `detent`·`hideActions` 변경은
`check:app`·모바일 하네스로 게이트 가능. 유일한 주의점은 `view-shift.js`의 `OCCLUSION_SELECTOR`가
새 레이아웃 rect를 그대로 읽으므로 A3의 좌측 패널이 즉시 반영된다(추가 배선 불필요).

### B안 — 재구성: [보기 / 만들기 / 공유] 3축 IA

크롬을 성격으로 3그룹으로 재편하고, 컨텍스트 패널을 "모프"에서 **명시적 2탭 + 모프**로 바꾼다.

```
데스크톱 1280×800 (B안)
┌──────────────────────────────────────────────────────────────┐
│ 마을 › 초가                                    ┌── 보기 ────┐ │
│ (브레드크럼이 ModeToggle을 대체 — 클릭=focus-out) │ ◔ 다이얼   │ │
│                                                │ 景│墨      │ │
│                    (씬 — 풀블리드)              │ ⟳ ◑ ☾     │ │
│                                                └───────────┘ │
│  ┌── 만들기 ────────────┐                                     │
│  │ [ 마을 ] [ 집 ]       │ ← 명시적 탭(카메라 모프와 동기)      │
│  │ 규모 ──●──── 마을     │                                     │
│  │ 지형 ▸ 구성 ▸ 어휘 ▸  │ ← 그룹 아코디언(하나만 펼침)         │
│  │ 再 다시 짓기          │                                     │
│  └──────────────────────┘                                     │
│ 처마 #2529 ⓘ         ┌── 공유 ──────────────┐                 │
│                      │ 사진 · 링크 · ⬗ 모델 · ♪ │ ← 단일 독     │
└──────────────────────┴──────────────────────┘─────────────────┘
```

```
세로 모바일 390×844 (B안) — 2 detent(peek / 60vh), 씬 40% 상시 보장
┌──────────────┐        ┌──────────────┐
│ 마을›초가  ◔  │        │ 마을›초가  ◔  │
│              │        │   (씬 40%)    │
│   (씬)       │        ├──────────────┤
│              │        │[마을][집]  ⌃ │
├──────────────┤        │ 지붕 ▾        │  그룹 하나만 펼침 →
│ ⌄ 만들기 · 공유│        │  물매 ──●──   │  스크롤 자체가 짧아짐
└──────────────┘        │ 再 · 사진 · 링크│
                        └──────────────┘
```

- 브레드크럼이 `ModeToggle`을 흡수(집 클릭=진입, 브레드크럼=복귀). 좌상 3중 점유 문제가 정의상 소멸.
- "보기" 카드 하나가 시간·계절·날씨·노을·흐름·렌더 스타일을 전부 소유 → P10의 3코너 분산 해소.
- "공유" 독 하나가 사진·링크·모델 내보내기·사운드를 소유 → P9 중복 3곳이 1곳으로.
- "만들기" 패널은 **탭 2개 + 그룹 아코디언(동시 1개 펼침)**. 사용자 지시("숨기지 말 것")는 *접기 기본*이
  아니라 *전 축 노출*의 요구이므로, 전 축을 유지하면서 한 번에 한 그룹만 펼쳐 스크롤 초과(P11)를 구조적으로
  없앤다. 커밋 대가가 다른 축(웨이브/라이브/놓을 때)을 그룹 헤더에 배지로 표시(P10).
- 모바일은 detent를 2개로 줄이고 상한 60vh → 편집 중에도 씬 40% 상시 가시(P2 해소). 가로폰은 좌측 42% 패널.

바뀌는 컴포넌트: `ModeToggle`(폐기·브레드크럼으로 흡수), `RenderStyleToggle`(폐기·보기 카드로 흡수),
`EnvironmentDial`(보기 카드로 확장), `ActionBar`(공유 독으로 재정의), `ContextPanel`(탭+아코디언 재작성),
`BottomSheet`(2 detent·landscapePhone), `ParamPanel`(레거시 — 같은 셸로 통합 또는 정식 폐기 결정 필요),
`App.svelte`(mode 파생·hideActions·chroma 그룹 재배선), `edit-schema.js`(그룹 우선순위·커밋 등급 메타 추가).

모바일 대응: 데스크톱과 같은 3축을 그대로 축소 적용(위치만 재배치) — 현재처럼 모바일 전용 예외 규칙
(raised·hideActions·shifted 무효화)이 누적되지 않는다는 점이 B안의 실질 이득.
구현 규모: **큼**(컴포넌트 8개 + 스키마 메타 + 문서 개정). 리스크: **중~높음**.
`mode-integration.md` §5.5 원칙 1·2 재해석(명시적 보기 버튼 → 브레드크럼, 모프 → 탭+모프)이 필수이고,
`ui-design.md` §2 레이아웃·§4.7 키보드 탐색 절도 함께 갱신해야 한다. `?village=1`·공유 URL·`?hero=0`
레거시 경로의 회귀 표면이 넓다.

### 결정 (2026-07-25)

**사용자가 B안(3축 재구성)을 선택했다.** 감사의 권고는 A안이었으나 사용자는 근본 정돈을 택했다.
구현 시 유의: ① P1~P5 기하 결함이 B안 구현에서도 반드시 해소되는지 개별 검증(부산물로 여기지 말 것)
② `mode-integration.md` §5.5 재해석과 `ui-design.md` 갱신을 같은 라운드에서 문서화
③ §4의 판정 지표(가시 높이 ≥200px, 편집 중 씬 ≥40%, 히트테스트)를 앱 하네스 게이트로 신설
④ ParamPanel은 통합이 아니라 정식 폐기로(사용자가 재구성을 택한 취지와 일관).

### (참고) 감사 시점의 권고 — A안 (채택되지 않음)

근거:

1. 상위 5개 문제(P1~P5) 중 정보구조 문제는 하나도 없다. 전부 **좌표 충돌·셸 크기·배선 누락**이며 A안이
   그 4개(A1~A3, A5)를 직접 고친다. B안은 같은 결함을 IA 재편의 부산물로 고치므로 리스크 대비 이득이 낮다.
2. P3는 이미 작성된 계약(`detent` 요청)이 `detent={null}` 한 줄 때문에 죽어 있는 것으로, A안에서 **한 줄**로
   되살아난다. 이런 종류가 다수라 보수안의 비용효율이 높다.
3. 지금 라운드의 목표는 릴리스 마무리이고 `mode-integration.md` §5.5는 사용자 재피드백으로 확정된 계약이다.
   그 원칙을 재해석하는 변경은 별도 라운드로 분리하는 것이 안전하다.
4. 단, B안의 두 요소는 **A안에 선취해 넣는다**: (i) 렌더 스타일을 우상 "보기"로 이설(A1) — 좌상 충돌을
   고치는 가장 짧은 길이면서 3코너 분산도 줄인다. (ii) 모바일 편집 시 씬 최소 가시율 보장(A2의 54vh 상한) —
   "편집하는데 대상이 안 보인다"는 P2의 본질이 IA가 아니라 상한값이기 때문이다.

A안 이후에도 남는 것(다음 라운드 후보): P10의 커밋 대가 시각화, `ParamPanel` 폐기 여부 결정,
그룹 아코디언 도입, 브레드크럼-ModeToggle 통합.

---

## 4. 재현·게이트

측정 재현(소스 수정 없이 관찰만):

```
# 고정 스냅샷 dev (본체 5173 불침해, 전용 포트·cacheDir)
cd <snapshot>/app && npx vite --config <전용 config: host 127.0.0.1, port 454x, 전용 cacheDir>
```

- 부감: `/?village=1&vseed=7&time=sunset` → `window.__engine.village.getState().active` 대기
- 집 focus: `window.__engine.village.debugParcels()` → `debugFocus(parcelId)`
- 한양: `&vscale=hanyang` → `#building-navigation` 의 `options.length`
- 뷰포트: 1280×800 / 1024×640 / 844×390(coarse) / 390×844(coarse) / 360×780(coarse)
- `.chroma` 3초 감상 페이드가 캡처를 방해하므로 `mouse.move` + `addStyleTag('.chroma{opacity:1!important}')`
- 판정 지표(권장 게이트 값): `.ctxscroll`/`.scroll`의 **화면 안 가시 높이 ≥ 200px**,
  스크롤 최하단에서 마지막 컨트롤 `inViewport === true`, 주요 액션 히트테스트가 `hittable`,
  `.crumb.root.link` 히트테스트가 `hittable`, 편집 중 씬 가시율 ≥ 40%.

구현 라운드에서는 위 지표를 `tools/`의 앱 하네스로 고정해야 한다(현재 이 항목들을 검사하는 게이트는 없다 —
그래서 P1~P4가 릴리스 직전까지 남았다). 헤드리스 절대 프레임 시간은 판정에 쓰지 않는다.
