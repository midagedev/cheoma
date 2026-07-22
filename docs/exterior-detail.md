# 창호 외관 디테일 계약

> - **상태**: 계약 + 리서치
> - **기준일**: 2026-07-22
> - **범위**: 궁·사찰·기와집·초가의 문·창 프레임, 창 하부 머름, 문짝 하부 청판 rail, 문지방,
>   절제된 철물·근접 민가 신발과 후속 상호작용 anchor
> - **비범위**: 문 열림 애니메이션, 실내 생성, 인물, 특정 문화유산의 정밀 복원

## 1. 목적

창호는 지붕 아래의 평면 텍스처가 아니라 출입·채광·환기 기능을 구분하는 건축 부재로 읽혀야 한다. 동시에
일반 주택 수십 채가 반복되는 마을에서 집마다 별도 재질·텍스처·draw call을 만들 수는 없다. 이 계약은 확인된
창호 어휘를 얕은 입체 실루엣으로 번역하고, MID/FAR와 결정론을 보존하면서 후속 문 상호작용과 생활 소품이 같은
출입구 데이터를 재사용하게 한다.

## 2. 확인된 사실

건축공간연구원(AURI) 국가한옥센터의 「한옥의 시공 — 창호와 천장」은 다음을 설명한다.

- 출입을 위한 `호(戶)`와 빛·조망·환기를 위한 `창(窓)`은 기능이 다르다.
- 목재 창호는 소목이 만들며, 머름은 창 하부에 들이는 시설로 창의 높이를 정한다.
- 판문은 세로 판재를 가로 부재로 엮고, 살문은 살을 짜 뒤에 창호지나 비단을 댄다.
- 세살문은 대표적인 살문이며 궁궐·사찰에는 더 화려한 꽃살창도 쓰였다.

국가유산청 국가유산포털의 경복궁 근정전 정밀실측 철물 상세도는 문고리, 고리갈쇠, 고정쇠, 돌쩌귀, 원산,
자물쇠, 경첩, 새발장식이라는 궁궐 창호 철물 어휘를 한 건물의 실측 사례로 확인하게 한다.

국립익산박물관 소장품 「짚신」(양수 197)은 한국-조선, 볏짚, 길이 24cm·너비 11cm로 기록되고 서민이 널리
신었다고 해설한다. 같은 기관의 「나막신」(익산 2975)은 한국-조선, 나무, 현존 길이 19.2cm·너비 6.6cm인
운두형으로 발등을 덮고 둥근 코와 평평한 바닥, 앞이 조금 들린 형상을 기록한다. 국립중앙박물관의
「삿갓을 쓰고 나막신을 신은 소동파 <동파입극도(東坡笠屐圖)>」 해설은 옛 비 오는 날 나막신을 챙긴 용례를
명시한다. 문화체육관광부·Korea.net의 「Things Newcomers Need to Know to Live in Korea」는 전통 한옥을
포함한 집에 들어갈 때 신발을 벗는 생활 관습을 설명한다.

## 3. 제품 해석과 한계

- `src/builder/opening-detail-plan.js`는 문/창, 크기, 창 하부 머름, 문짝 하부 `lowerPanel`, reveal, 프레임,
  문지방, 철물, primary entrance,
  pivot과 footwear anchor를 Three 없이 불변 순수 데이터로 만든다. 같은 입력과 seed는 같은 JSON을 반환하고
  전역 `Math.random`을 쓰지 않는다. 공개 결과의 seed는 number/string으로 정규화되므로 BigInt·객체 seed를 받은
  경우에도 결과 전체를 `JSON.stringify`할 수 있고, 객체 키 순서는 stable seed identity에 영향을 주지 않는다.
- 다른 프로젝트와 앱의 후속 interaction은 `src/api/opening-detail.js`의 최소 façade를 사용한다. 내부 builder는
  façade를 역참조하지 않고 구현 모듈을 직접 사용해 `src/`의 의존 방향을 보존한다.
- `src/builder/opening-details.js`는 일반 기와집 벽체, 대표 종가 `buildHanok`, 궁·사찰·초가 공용 벽체가 같은
  plan을 소비하게 한다. 문양 텍스처는 미세 살 짜임을 계속 담당하고, 얕은 jamb·head·sill·문짝 이음·문지방만
  실루엣을 만든다.
- 일반 초가·기와집은 `src/layout/residential-openings.js`의 칸별 문·창 plan을
  `src/builder/residential-opening-details.js`에서 이 detail grammar와 결합한다. planner의 개수·폭·남향 primary를
  패널과 frame에 그대로 쓰며, 한 개구를 생략하거나 두 번 조립하면 fail closed한다. 부엌 아궁이는 이 목록에
  들어오지 않는 별도 service opening이다. 초가·기와집 모두 `kitchen-opening-spatial.js`의 실제 개구+frame span을
  renderer와 공유하며, 합법 최대 폭에서도 그 span에 닿는 동측 창 슬롯을 미리 제외한다. 문짝 texture 반복 수도
  별도 폭 임계값을 갖지 않고 같은 detail plan의 `leafCount`를 소비한다.
- AURI의 머름 설명은 창 하부 시설에 한정해 적용한다. window plan은 개구 sill 아래 음의 local-y에 style 기본
  또는 명시 높이의 `meoreum-apron`과 `meoreum-rail`을 두며, door plan의 머름 높이는 0이다. 문 텍스처 하부의
  기존 청판 경계는 별도 `lowerPanel`/`lower-panel-rail`로 기록하므로 출입 통과부를 머름으로 오인하지 않는다.
- 철물은 모든 문짝에 반복하지 않고 primary entrance 한 곳에만 둔다. 궁은 작은 경첩 띠 두 개, pivot cap 두 개,
  고리 하나의 제한된 실측 어휘를 쓰고, 민가·사찰은 더 절제된 경첩 띠 두 개와 고리 하나만 보인다. 모든 유형의
  실제 pivot은 렌더 장식 수와 무관하게 순수 anchor 데이터로 유지한다.
- 근정전 실측도의 장식판과 치수를 일반 민가에 복제하지 않는다. 현재 민가 철물은 실측도에서 확인한 기능
  어휘 중 작은 경첩 띠와 고리만 남긴 **제품 해석**이고, 보이는 pivot cap은 생략한다. 이는 특정 시대·지역·신분의
  민가 철물을 입증하거나 정밀 복원한 결과가 아니다.
- `src/props/threshold-life-plan.js`는 primary footwear anchor를 소비해 민가 문간 한 켤레만 계획한다. 마른
  조건은 널리 쓰인 짚신, 명시적인 젖은 조건은 비 용례가 확인된 나막신이다. 조선 나막신을 계절 일반 장식이나
  신분 표지로 확대 해석하지 않으며 현대 고무신은 만들지 않는다. 각 신발의 실제 소장품 치수 범위를 저폴리
  화면 가독성에 맞게 약 24~26cm 길이로 제한한다.
- 신발은 문 중앙이 아니라 문설주 바깥에 한 켤레를 붙인다. 기와집의 대표 문은 seed에 따라 대청 왼쪽 또는
  오른쪽 문이 될 수 있으므로 residential plan이 개구부 로컬 `+u` 기준의 난간 없는 대청 쪽(`clearSide`)을
  명시한다. 신발은 그 방향을 소비하되 정적 철물과 미래 pivot 방향은 바꾸지 않는다. 순수 plan이 threshold 끝, 열린 출입 폭,
  선택한 문설주와의 양의 clearance 및 placement signature를 기록한다. `src/props/threshold-life.js`는 최종 opening
  basis에서 위치·회전과 landing reference만 소비하고 집의 `footprintScale`·필지 비등방 scale은 제거한다. 따라서
  처마·문간 위치는 편집된 집을 따르되 신발 자체는 세계 단위 24~26cm 범위를 유지한다. 문을 여는 상태는 여전히
  별도 범위다. 아궁이·솥을 위한 `kitchen-hearth.js`는 거주 창호와
  다른 service opening이므로 합치지 않는다.

## 4. LOD·재질·수명 계약

- MID는 기존 `door`·`hanji`·`salchang` 텍스처와 envelope 목재를 유지한다. 프레임·문지방은 기존
  `wood`/`woodDark` 재질 그룹에 병합되므로 MID에 새 재질 그룹을 추가하지 않는다.
- 작은 철물은 palette-owned `hardware` 재질 하나를 공유하고 `lodEnvelope`를 받지 않는다. 따라서 FULL과
  selected overlay에만 있으며 집 수와 무관하게 변주·청크당 최대 한 geometry/material 그룹으로 병합된다.
- `hardware`는 새 텍스처를 만들지 않고 기존 MeshStandard shader 계열을 쓴다. 개별 문마다 재질 clone,
  포인트라이트, 독립 LOD 임계값을 만들지 않는다.
- 짚신/나막신 한 켤레는 `thresholdLife` vertex-color 재질 하나와 한 geometry batch만 쓴다. 텍스처·투명도·
  독립 wave controller는 없으며 `lodEnvelope`와 snow surface를 받지 않는다. 정적 건물 prototype이나 FULL
  chunk에는 넣지 않고 선택된 집의 focus overlay가 생성·교체·해제를 독점한다. 따라서 많은 집에 같은 신발이
  반복되거나 부감 draw call이 늘지 않는다. preview는 topology·문폭·anchor·surface가 모두 같은 placement signature일
  때만 기존 batch를 rigid rebase하고, 하나라도 바뀌면 순수 plan과 mesh를 다시 만든다. 맑은 날은 짚신, 실제
  `rain` 전환은 나막신 plan을 소비한다.
- 각 건물은 `primary-opening-anchor`와 `primary-opening-panel`을 정확히 하나 노출한다. anchor의 plan은 JSON-safe
  데이터이며, 후속 interaction/footwear는 이 marker를 찾고 focus-out·rebuild·dispose 수명에 맞춰 상태를
  소유해야 한다. Svelte가 Three 상태를 소유해서는 안 된다.

## 5. 검증

- `npm run check:opening-detail`: 순수 결정론, 불변 데이터, vocabulary, 창 머름과 문 lowerPanel의 배타성,
  frame·threshold·유형별 철물 범위,
  primary pivot/footwear anchor와 전역 RNG 비의존을 검사한다.
- `npm run check:threshold-life`: dry/wet 종류, 실물 기반 크기 범위, 문지방·출입 폭·문설주 clearance, preview
  placement signature, JSON-safe deep freeze, 객체·BigInt seed 결정론, 전역 RNG 비의존을 검사한다.
- `npm run check:building-clearance`: 실제 궁·사찰·일반 기와·초가·대표 종가 production geometry에서
  frame/hardware가 각각 한 batch이고, primary entrance가 하나이며 철물이 MID에 섞이지 않는지 검사한다. 초가
  기본·최소·최대와 기와 ㅡ·ㄱ·ㄷ은 planner와 실제 패널의 개수·폭, 부엌 분리, 메시·재질 상한도 함께 검사하고,
  `-1.4×0.7×1.25` mirror·비등방 host basis에서도 신발 pair의 세계 length/width가 바뀌지 않는지 확인한다.
  기와 ㅡ·ㄱ·ㄷ × 대청 좌우 primary seed × 최소·기본·최대 문 폭/개수 18개 production fixture는 실제 툇마루
  bounds 안에 신발이 남고 리턴 난간·대청 바닥·출입구와 겹치지 않는지도 검사한다.
- `npm run check:app`: 네 기와집 topology가 `hardware` 재질 하나를 공유하고 FULL decomp마다 한 그룹만 가지며,
  일반 기와↔초가와 대표 종가 rebuild가 anchor/panel/frame/hardware를 정확히 하나씩 교체·해제하는지 검사한다.
  정적 마을에는 신발이 없고 focus에서만 한 batch가 생기는지, 실제 clear→rain 전환이 짚신→나막신으로 바뀌며
  이전 자원을 한 번만 해제하는지, focus-out이 이를 회수하는지도 재질·텍스처·program 상한 및 실제 Reference UI와
  함께 검사한다.
- 시각 판정은 같은 seed·카메라·시간의 전후 PNG를 직접 비교한다. 프레임이 창호지를 과도하게 가리거나 검은
  테두리로만 읽히지 않는지, 문고리가 원경에서 노이즈가 되지 않는지, 벽과 겹쳐 깜빡이지 않는지 본다.
- 2026-07-22 고정 town ㄷ자 컷의 측정은 calls 842→849, triangles 5,841,310→5,891,054, textures 44→44였다.
  같은 초가 컷은 calls 501→505, textures 26→26이었다. Headless 시간은 성능 근거로 쓰지 않는다.
- 머름 의미 수정과 대표 종가 통합 뒤 production opening 예산은 일반 기와 552+144, 궁 1224+208, 사찰
  1032+144, 초가 240+144, 종가 444+144 triangles(frame+hardware)다. 실제 대표 종가 rebuild는 이전 opening
  geometry 두 개를 각각 한 번 해제했고 rebase 후 shader program은 135→136으로 제한됐다.
- residential plan 통합 뒤 fixture 기준 FULL 예산은 초가 기본 4개 개구/75 meshes/31 materials, 초가 최대
  13/92/32, 기와 ㅡ 5/137/43, ㄱ 5/158/51, ㄷ 최대 20/248/64다. 개수가 늘어도 frame/hardware는 건물당
  각각 한 batch이며 개구 수에 비례한 texture나 detail draw batch를 만들지 않는다.
- 2026-07-22 신발 근접 캡처에서 focus overlay 한 켤레는 짚신 232 triangles, 나막신 184 triangles이고 모두
  calls +1, 기존 장면 워밍 뒤 programs +1이다. 실제 앱의 대표 종가 rebuild는 frame·hardware·신발 geometry를
  각각 한 번 해제하고 programs 증가를 +2 이하(기존 rebuild 계열 + vertex-color 신발 계열)로 제한했다. 정적 마을은
  신발 geometry와 call을 전혀 제출하지 않는다. 절대 시간은 비교하지 않는다.

## 6. 원문과 이용조건

- 건축공간연구원 국가한옥센터, 「한옥의 시공 — 창호와 천장」:
  https://www.hanokdb.kr/theology/sub_04
- 국가유산청 국가유산포털, 「경복궁 근정전 정밀실측 문고리·고리갈쇠·고정쇠·돌쩌귀·원산·자물쇠·경첩·새발장식 철물 상세도」:
  https://www.heritage.go.kr/heri/cul/chartImgHeritage.do?file_seq=2839493&title3d=%EB%8F%84%EB%A9%B4_%EA%B5%AD%EB%B3%B4_%EA%B2%BD%EB%B3%B5%EA%B6%81+%EA%B7%BC%EC%A0%95%EC%A0%84_%EC%A0%95%EB%B0%80%EC%8B%A4%EC%B8%A1+%EB%AC%B8%EA%B3%A0%EB%A6%AC%EF%BC%8F%EA%B3%A0%EB%A6%AC%EA%B0%88%EC%87%A0%EF%BC%8F%EA%B3%A0%EC%A0%95%EC%87%A0%EF%BC%8F%EB%8F%8C%EC%A9%8C%EA%B7%80%EF%BC%8F%EC%9B%90%EC%82%B0%EF%BC%8F%EC%9E%90%EB%AC%BC%EC%87%A0%EF%BC%8F%EA%B2%BD%EC%B2%A9%EF%BC%8F%EC%83%88%EB%B0%9C%EC%9E%A5%EC%8B%9D+%EC%B2%A0%EB%AC%BC+%EC%83%81%EC%84%B8%EB%8F%84
- 국립익산박물관, 「짚신」(양수 197):
  https://iksan.museum.go.kr/site/kor/html/sub04/0402.html?cate_code=&cate_gubun=&id=PS0100101400100019700000&mode=V
- 국립익산박물관, 「나막신」(익산 2975):
  https://iksan.museum.go.kr/site/kor/html/sub04/0402.html?cate_code=&cate_gubun=&id=PS0100101400000297500000&mode=V
- 국립중앙박물관, 「삿갓을 쓰고 나막신을 신은 소동파 <동파입극도(東坡笠屐圖)>」:
  https://www.museum.go.kr/MUSEUM/contents/M0501000000.do?pageSize=10&relicRecommendCategory=&relicRecommendId=165924&sc=&schM=view&sv=
- 문화체육관광부·Korea.net, 「Things Newcomers Need to Know to Live in Korea」:
  https://www.korea.net/koreanet/fileDownload?fileUrl=FILE%2FPDF%2Fgeneral%2F201209_liveinkorea_en.pdf

AURI·국립익산박물관·Korea.net 페이지는 저작권 보호 자료이므로 이용조건을 자산 재사용 전에 다시 확인한다.
국립중앙박물관 해설은 공공누리 제3유형(출처표시+변경금지)이다. 국가유산포털 자료도 상세 페이지의 저작권·
공공누리 유형을 자산 재사용 전에 다시 확인해야 한다. 저장소와 앱에는 원문 도면·이미지를 복제하지 않고 링크,
사실 요약, 독자적으로 만든 저해상도 절차 geometry만 포함한다.
