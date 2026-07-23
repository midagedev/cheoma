# 진경산수 수묵 렌더 계약

> - **상태**: 현재 계약 + 구현 근거 리서치
> - **기준일**: 2026-07-22
> - **범위**: 제품의 PBR↔수묵 표현 전환, 색공간·성능·접근성·검증

## 미학 원칙

cheoma의 수묵 모드는 3D 장면을 단순한 흑백 외곽선으로 바꾸는 필터가 아니다. 조선 진경산수의 관찰과 재구성 방식을 따라, 실제로 생성된 지형·건축의 특징은 보존하되 화면에서 읽혀야 할 산세와 여백을 선택적으로 강조한다.

1. **실경을 출발점으로 삼는다.** 중국 화보의 도식을 복제하기보다 현장에서 본 우리 산천의 지형적 특징을 바탕으로 한다.
2. **사실성과 표현성을 함께 둔다.** 정선은 실제 인왕산의 특징을 살리면서 치마바위를 높이고 보이지 않는 계류를 더해 화면을 더 힘있게 구성했다. 따라서 절차 지형의 계획이나 seed를 바꾸지 않으면서 명암 덩어리·능선·안개 여백을 렌더 단계에서 선별한다.
3. **모든 면을 같은 선으로 두르지 않는다.** 가까운 건물의 실루엣과 처마는 또렷하게, 먼 산의 내부 삼각면은 약하게 하여 저폴리 면분할이 펜선처럼 드러나지 않게 한다.
4. **여백은 대기 원근이다.** 인왕제색도의 산이 비와 안개로 비워진 공간 위에 떠오르듯, 밝은 종이색과 거리 감쇠를 정보의 부재가 아니라 깊이 표현으로 사용한다.
5. **붓질 어휘를 명암에 번역한다.** 수직 준법의 암벽, 짧은 횡선·점의 수목, 넓은 먹 번짐을 각각 실루엣, 숲의 중간톤, 종이 위 명암 덩어리로 번역한다.

## 조사 근거

- [국립중앙박물관, 인왕제색도 큐레이터 추천](https://www.museum.go.kr/MUSEUM/contents/M0501000000.do?relicRecommendId=962060&schM=view): 실제 지형의 특징을 살리되 치마바위를 높이고 보이지 않는 계류를 추가한 의도적 재구성을 설명한다.
- [국립중앙박물관, 인왕제색도 수어영상 해설](https://vcm.museum.go.kr/MUSEUM/contents/M0506000000.do?arcId=18702&catCustomType=post&catId=11804): 단순한 실경 복제가 아니라 특징과 정서를 강조하며, 먹이 짙은 바위·안개 여백·소나무 숲의 작은 집을 대비시킨다고 설명한다.
- [국립중앙박물관, 우리 강산을 그리다: 화가의 시선, 조선시대 실경산수화](https://www.museum.go.kr/MUSEUM/contents/M0202030000.do?act=past&exhiSpThemId=3803&listType=list&menuId=past&schM=view): 현장 사생, 창의적 화면 구성, 개성 있는 필묵을 진경산수의 핵심으로 제시한다.
- [The Met, Mountain and Water: Korean Landscape Painting, 1400–1800](https://www.metmuseum.org/ko/essays/mountain-and-water-korean-landscape-painting-1400-1800): 실경의 지형뿐 아니라 심리적·미술사적 의미를 함께 담는 방식과 인왕제색도의 과감한 화면 절단, 안개에서 솟는 산을 설명한다.
- [The Met, Diamond Mountains: Travel and Nostalgia in Korean Art](https://www.metmuseum.org/exhibitions/listings/2018/diamond-mountains/exhibition-gallery): 정선의 날카로운 수직선, 소나무·수목의 짧은 횡선과 점, 넓은 담묵을 구체적인 회화 어휘로 소개한다.
- [국가유산포털, 정선 필 금강전도](https://www.heritage.go.kr/heri/cul/culSelectDetail.do?VdkVgwKey=11%2C02170000%2C11&pageNo=1_1_1_1): 작품의 공식 명칭·시대·국가유산 기본 정보를 확인하는 기준이다.

방문자가 앱 안에서도 이 근거와 이용조건을 확인할 수 있도록 기관별 자료명·활용·URL·라이선스를 `docs/credits.md`에 함께 유지한다. 이 파일은 구현 판단까지 설명하는 자립적인 연구 계약이고, `docs/credits.md`는 제품 Reference 모달의 단일 콘텐츠 원천이다.

## 코드와 수명주기 경계

- `src/render/ink-state.js`와 가벼운 `src/api/render-style.js`는 Three·DOM 없는 `pbr | ink` 상태 어휘와 정규화만 소유한다.
- `src/render/ink.js`는 재사용 가능한 `InkPass`, 종이 texture, normal/depth 선별과 셰이더를 소유한다. 앱·Svelte·URL을 알지 않는다.
- `src/api/ink.js`가 외부 소비자에게 WebGL 수묵 pass를 공개한다. URL은 이 무거운 그래프가 아니라 `src/api/render-style.js`만 소비하며, shader warm 전용 `src/api/rendering.js`의 가벼운 import 계약도 유지한다.
- `app/src/engine/ink-mode-runtime.js`가 제품 전환, post pass 휴면, composer 삽입·제거, dispose를 소유한다.
- `app/src/components/RenderStyleToggle.svelte`는 키보드와 보조기기 상태를 표현하고 엔진 상태는 가지지 않는다.

`mode=ink`는 카메라의 `explore | focus`와 독립된 **표현 모드**다. 공유 URL은 수묵일 때만 `?mode=ink`를 기록하며 PBR은 파라미터를 제거해 기존 URL을 보존한다. 새로고침은 첫 준비 프레임 전에 URL 상태를 복원한다.

## 렌더·성능 불변식

- 기본 PBR 순서는 `Render → Grade/Rim → Bokeh → Bloom → Flare → Outline → Output`이다. 광학적 DoF가 먼저 조리개상을 만들고 그 뒤의 bloom이 센서·후처리 헤이즈를 더한다.
- 수묵 pass는 처음 요청할 때만 만든다. 축소 `InkBeautyCapturePass`가 `Render` 직후 선형 HDR 농담 원본을 한 번 복사하고, `Ink`는 `Outline`과 `Output` 사이에 삽입된다. `OutputPass`는 언제나 마지막 하나이며 ACES tone mapping과 sRGB 변환은 여기서 한 번만 한다.
- 수묵 셰이더의 종이색은 Output의 ACES 변환을 고려해 선형 HDR에서 역보정한다. 독립 `NoToneMapping` 소비자는 이 보정을 건너뛴다.
- 전환은 0.72초 동안 PBR 결과와 수묵 결과를 단조롭게 섞는다. 완전한 수묵 상태에서는 grade, Bokeh, bloom, flare fullscreen pass를 쉬게 하고 돌아올 때 불투명 수묵 화면 뒤에서 먼저 깨운다. Bokeh가 쉬면 내부의 반해상도 highlight prefilter와 source scatter도 함께 그리지 않는다. 농담은 post 전 raw beauty에서만 산출하므로 sleep 전후 출력이 픽셀 단위로 같다. 추가 scene render가 없는 Fresnel rim과 태양광은 raw beauty의 동적인 조명 일부로 유지한다.
- normal/depth pass는 Points, Line, Sprite, `depthWrite=false`, 명시적 제외 객체를 그리지 않는다. DoF가 `userData.dofDepthMaterial`로 원경 창불의 실제 광원 깊이를 받더라도 수묵 normal은 그 소스 전용 재질을 소비하지 않으므로 창불이 표면 윤곽이 되지 않는다. 넓은 태양 글로우는 명시적 DoF 깊이도 소유하지 않고 배경/원경 gather로 남아 투명한 꼬리가 깊이를 가리지 않는다. 중간 `alphaHash` 인스턴스는 본 렌더와 같은 screen-door fade를 사용해 완전 불투명 가림막이 되지 않는다.
- normal target과 raw-beauty copy를 desktop 0.75배, compact/coarse 0.5배로 줄인다. 종이·최종 색 합성은 화면 해상도를 유지한다. PBR 복귀 뒤 copy pass도 비활성화되어 최초 PBR과 같은 pass work로 돌아간다.
- 종이 무늬는 결정론적이며 plan, terrain, village RNG를 소비하지 않는다. 수묵 전환이 마을 scene hash를 바꿔서는 안 된다.

## 검증

```bash
npm run check:ink:app
npm run shoot:ink
```

실제 앱 게이트는 기본 PBR lazy 상태, 제품 Reference 모달의 기관별 근거·라이선스·안전한 외부 링크, 키보드 Enter/Space, `aria-pressed`, URL 동기화와 새로고침 복원, 단조로운 전환, 단일 Output-last 순서, 완전 수묵의 PBR pass 휴면, 부감·근경 sleep 전후 픽셀 동일성, PBR 복귀 뒤 beauty copy 휴면, shader/program 상한, 깊이 제외, 모바일 44px target, 화면 통계와 런타임 오류 0을 검사한다. PNG는 레포에 쌓지 않고 OS 임시 폴더에 남겨 직접 비교한다.
