# 창호 외관 디테일 계약

> - **상태**: 계약 + 리서치
> - **기준일**: 2026-07-23
> - **범위**: 궁·사찰·기와집·초가의 문·창 프레임, 창 하부 머름, 문짝 하부 청판 rail, 문지방,
>   절제된 철물·근접 민가 신발, 선택 FULL **주거** 주출입문 상호작용, 실제 창호에 붙는 야간 원경 불빛
> - **비범위**: 실내 생성, 인물, 특정 문화유산의 정밀 복원

## 1. 목적

창호는 지붕 아래의 평면 텍스처가 아니라 출입·채광·환기 기능을 구분하는 건축 부재로 읽혀야 한다. 동시에
일반 주택 수십 채가 반복되는 마을에서 집마다 별도 재질·텍스처·draw call을 만들 수는 없다. 이 계약은 확인된
창호 어휘를 얕은 입체 실루엣으로 번역하고, MID/FAR와 결정론을 보존하면서 문 상호작용과 생활 소품이 같은
출입구 데이터를 재사용하게 한다.

## 2. 확인된 사실

건축공간연구원(AURI) 국가한옥센터의 「한옥의 시공 — 창호와 천장」은 다음을 설명한다.

- 출입을 위한 `호(戶)`와 빛·조망·환기를 위한 `창(窓)`은 기능이 다르다.
- 목재 창호는 소목이 만들며, 머름은 창 하부에 들이는 시설로 창의 높이를 정한다.
- 판문은 세로 판재를 가로 부재로 엮고, 살문은 살을 짜 뒤에 창호지나 비단을 댄다.
- 세살문은 대표적인 살문이며 궁궐·사찰에는 더 화려한 꽃살창도 쓰였다.

같은 기관의 「한옥의 감상」은 창호지를 실내 쪽에 붙이고, 이를 통과한 빛이 실내를 밝은 분위기로 만들며 외부에서는 살 무늬가
읽힌다고 설명한다. 따라서 화면에 보이는 빛의 기준면은 필지 중심이나 벽 바깥의 임의 점이 아니라 실제 살과
한지 면이다. 이 설명은 창호의 구성과 주간 채광 효과에 관한 근거이지, 밤의 외부 휘도나 색을 정한 자료는 아니다.

국립민속박물관 웹진 「빛으로 밝히고 조명으로 통하다」는 양초·호롱·석유등 같은 작은 연소 광원을 생활 조명의
역사 안에서 소개한다. 이는 현대 전기식 면광원과 다른 **점광원 어휘**의 근거다. 모든 집·모든 방이 켜졌다는
근거나 정확한 밝기·색온도·점멸 주기·점등 비율을 제공하지는 않는다.

국가유산청 국가유산포털의 경복궁 근정전 정밀실측 철물 상세도는 문고리, 고리갈쇠, 고정쇠, 돌쩌귀, 원산,
자물쇠, 경첩, 새발장식이라는 궁궐 창호 철물 어휘를 한 건물의 실측 사례로 확인하게 한다.

국립익산박물관 소장품 「짚신」(양수 197)은 한국-조선, 볏짚, 길이 24cm·너비 11cm로 기록되고 서민이 널리
신었다고 해설한다. 같은 기관의 「나막신」(익산 2975)은 한국-조선, 나무, 현존 길이 19.2cm·너비 6.6cm인
운두형으로 발등을 덮고 둥근 코와 평평한 바닥, 앞이 조금 들린 형상을 기록한다. 국립중앙박물관의
「삿갓을 쓰고 나막신을 신은 소동파 <동파입극도(東坡笠屐圖)>」 해설은 옛 비 오는 날 나막신을 챙긴 용례를
명시한다. 문화체육관광부·Korea.net의 「Things Newcomers Need to Know to Live in Korea」는 전통 한옥을
포함한 집에 들어갈 때 신발을 벗는 생활 관습을 설명한다.

## 3. 제품 해석과 한계

- #81의 제품 번역은 일부 거주 창호만 seed-stable하게 켜고 나머지 방은 어둡게 둔다. 작은 호롱불을 연상시키는
  절제된 따뜻한 색·낮은 에너지·미세한 flicker는 아름다움과 화면 가독성을 위한 구현 선택이며 사료가 정한
  측광 복원이 아니다. 집 전체 벽이나 처마를 발광시키지 않고 실제 한지 면만 빛의 화면 위치를 소유한다.

- `src/builder/opening-detail-plan.js`는 문/창, 크기, 창 하부 머름, 문짝 하부 `lowerPanel`, reveal, 프레임,
  문지방, 철물, primary entrance,
  pivot·footwear anchor와 고정 개구면 중심의 `focus` anchor를 Three 없이 불변 순수 데이터로 만든다. `focus`는
  움직이는 문짝이나 문지방이 아니라 닫힌 개구 높이의 절반과 고정 reveal 면을 가리킨다. 같은 입력과 seed는 같은 JSON을 반환하고
  전역 `Math.random`을 쓰지 않는다. 공개 결과의 seed는 number/string으로 정규화되므로 BigInt·객체 seed를 받은
  경우에도 결과 전체를 `JSON.stringify`할 수 있고, 객체 키 순서는 stable seed identity에 영향을 주지 않는다.
- 다른 프로젝트와 앱의 후속 interaction은 `src/api/opening-detail.js`의 최소 façade를 사용한다. 내부 builder는
  façade를 역참조하지 않고 구현 모듈을 직접 사용해 `src/`의 의존 방향을 보존한다.
- `src/builder/opening-details.js`는 일반 기와집 벽체, 대표 종가 `buildHanok`, 궁·사찰·초가 공용 벽체가 같은
  plan을 소비하게 한다. 문양 텍스처는 미세 살 짜임을 계속 담당하고, 얕은 jamb·head·sill·문짝 이음·문지방만
  실루엣을 만든다. 초가와 대표 종가는 열린 문 뒤의 벽면이 다시 드러나지 않도록 같은 opening basis에서 고정
  암부 plane을 만들고 기존 `opening-frame-details`/`woodDark` batch에 병합한다. 초가의 중간 보와 하부 판재 띠도
  주출입문의 실제 계획 폭에서 분할되어 개구를 가로지르지 않는다.
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
  잠재 pivot은 렌더 장식 수와 무관하게 순수 anchor 데이터로 유지한다. 이 정적 의미가 곧 제품 상호작용 허용을
  뜻하지는 않는다.
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
  독립된 motion/runtime 계약이 소유한다. 아궁이·솥을 위한 `kitchen-hearth.js`는 거주 창호와
  다른 service opening이므로 합치지 않는다.

## 4. 주출입문 상호작용 계약

- 제품 상호작용은 일반 기와집·초가와 `heroStyle: 'hanok'`인 대표 주거 한옥의 선택 FULL overlay에만 허용한다.
  `hero`는 카메라·편집 분류이지 주거 의미가 아니다. 따라서 `heroStyle: 'palace'`인 관아·객사 코어와 궁·사찰
  builder가 재사용 가능한 primary 의미 geometry를 갖더라도, 주 전각 역할이 병합 뒤까지 보존되지 않은 현재
  compound에서는 임의의 한 문을 고르지 않는다. 실제 관아·궁·사찰 focus에는 runtime, 화면 target, pivot이 모두 없다.

- `src/interaction/door-motion.js`는 Three·DOM·앱·전역 RNG 없이 불변 JSON-safe motion plan과 가변 progress
  state를 만든다. 공개 순수 진입점은 `src/api/door-motion.js`다. 목표가 바뀌면 현재 각도와 속도를 이어받는
  임계감쇠 운동으로 반전하며, 60Hz bounded substep 뒤 정확한 0/1에 정착한다.
- 다짝 문 전체를 한 외곽 경첩으로 돌리지 않는다. plan의 `leafWidth`, `leafCenterU`, `meetingU`가 경첩 쪽
  바깥 한 짝을 특정하고, builder는 `primary-opening-panel` active leaf와 고정된 나머지 짝을 별도 geometry로
  만든다. 초가는 원래 한 짝이므로 문짝 전체가 active leaf다. 기와집의 하부 청판, active meeting seam,
  고리와 경첩 띠만 같은 pivot을 쓰며 jamb·head·threshold·다른 leaf·창·머름은 고정된다.
- pivot은 active leaf의 바깥 모서리와 일치하고 열린 각도는 안쪽 약 78.6°다. 개구부와 footwear의 논리 basis는
  벽면에 고정하고 `pivot.outward`만 보이는 문짝 면을 소유하므로, 초가 암부나 기와 panel 깊이를 맞추기 위해
  신발까지 바깥으로 밀지 않는다. hinge side는 현재 폭이 아니라 opening identity에서 파생되어 연속 폭 편집 중
  반대 문설주로 점프하지 않는다. runtime은 실제 panel의 local
  폭과 중심이 순수 plan의 한 짝 범위와 0.1mm 안에서 일치할 때만 활성화한다. 문 운동은 geometry·material·
  texture·light를 새로 만들지 않고 기존 host 객체를 일시 reparent한다.
- 필지 변주는 집을 반전하거나 X/Y/Z를 서로 다르게 늘릴 수 있다. runtime은 닫힌 panel의 affine world matrix를
  분해하지 않고 그대로 보존하되, 경첩점에는 host scale을 상쇄한 orthonormal frame을 둔다. 따라서 문이 움직이는
  동안 세계 공간 경첩 반경과 Gram metric이 일정하고, 닫힘·dispose 뒤에는 원래 parent/local matrix가 정확히 돌아온다.
- 초가와 대표 종가의 암부 plane은 각각 panel 뒤 3.2cm, 5.2cm에 고정된다. 양면을 위한 네 삼각형을 기존 frame
  batch에 합쳐 닫힌 면은 바꾸지 않고 열린 깊이만 읽히게 하며, draw call·material·shader program을 늘리지 않는다.
- 제품 입력은 선택된 FULL focus overlay 한 곳만 대상으로 한다. pointer down/up이 모두 실제로 보이는 active
  leaf 또는 열려 비워진 그 leaf의 문간에 있고 이동량이 6px 이하일 때만 toggle한다. 문간 hit는 순수 ray/plane
  교차라 보이지 않는 mesh를 만들지 않는다. Three의 recursive raycast가 숨은 조상을 자동 배제하지 않는 점을
  보완해 hit부터 선택 root까지 모든 조상의 `visible`과 raycaster layer를 검사한다. 숨은 LOD·조립 owner는 target도
  occluder도 아니다. 선택 root 밖은 전체 scene raycast 대신 먼저 얻은 문 hit까지의 유한 선분만
  `src/runtime/village/door-occlusion.js`의 Three 없는 uniform-grid DDA로 조회한다. 고정 인덱스는 일반집의
  계획 몸체·지붕 또는 commit된 실제 FULL bounds, 일반 필지 담 run·문설주·상인방, 종가 담·닫힌 대문·행각 지붕,
  정자의 다각 기단·기둥 링·위로 좁아지는 지붕, 공용 소품, 사찰의 회전 전각·담 run·닫힌 대문, 궁장과 광화문,
  도성 성벽과 열린 홍예의 육축·상인방, 시전 다각형을 작은 record로 기록한다. 전체 담 ring이나 궁궐 precinct를
  하나의 거대 AABB로 막지 않으므로 실제 문·홍예·중정의 빈 공간은 통과한다. 실제 마당·보호수 anchor는 flora
  생성·교체 때 별도 인덱스로 미리 만들고 겨울에는 낙엽 수관을 제외해 줄기만 차폐한다. forest/scatter는 focus
  수목 fade가 별도로 소유하므로 중복 등록하지 않는다. 아직 성문 문루 상부, 궁궐 내부 일곽, 사찰 소품은 이
  외부 semantic index의 범위가 아니다. 선택 root 내부는 실제 first-surface ray가 계속 담당한다. 따라서 한양의
  수만 tree instance를 pointermove마다 순회하거나 첫 hover에서 인덱스를 만들지 않으면서 대표적인 이웃 건축·
  담·대문·소품·근경 수목 뒤의 문을 관통 선택하지 않는다. drag는 OrbitControls에 남으며 필지 선택으로 새지 않는다.
- 첫 accepted `pointerdown`이 pointerId 소유권을 얻는다. mouse와 touch가 각자 primary여도 뒤 포인터가 이를
  덮어쓰지 못하고, 일치하는 `pointerup`만 click을 완성한다. `pointercancel`, `lostpointercapture`, window blur는
  해당 소유권을 해제해 오래된 down hit가 다음 입력에서 문을 열지 못하게 한다.
- focus-out, LOD 전환, reroll, rebuild와 dispose는 문을 닫고 원래 parent/local transform을 복원한 뒤 빈 pivot을
  제거한다. persistent overlay도 다시 focus될 때 닫힌 새 runtime을 얻는다. listener와 GPU resource의 수명은
  builder/handle 소유권 밖으로 새지 않는다.

### 4.1 근경 DoF 의미 초점

- 선택 주거의 근경 DoF는 `primary-opening-anchor`가 가진 불변 `focus`를 세계점으로 바꿔 사용한다. 카메라
  `controls.target`은 구도와 OrbitControls를 계속 소유하지만 초점면을 대신하지 않으며, 경첩 운동 중인 active leaf도
  초점점을 움직이지 않는다. 그래서 문짝을 열거나 닫아도 문틀·창살·철물이 놓인 주출입 개구면이 선명하게 남는다.
- 세계점 탐색과 행렬 적용은 focus overlay가 생기거나 교체되는 진입·필지 hop·재건축·재굴림에서만 한 번 수행한다.
  정착 render loop에는 overlay traversal, raycast, 초점용 객체 할당이 없다. focus-in은 현재 조준점에서 도착 문까지,
  hop은 출발 문에서 도착 문까지 같은 camera easing으로 보간하고, focus-out은 DoF 양이 0이 될 때까지 출발 문을 고정한다.
- 독립 주거처럼 순수 primary anchor가 정확히 하나일 때만 의미점을 채택한다. 병합 뒤 주 전각 역할을 확정할 수 없는
  궁·사찰·관아 복합체나 잘못된 anchor는 `controls.target`으로 fail closed하며 임의의 문을 고르지 않는다. 이 경로는
  카메라 구도, DoF kernel, 조명, LOD, 문 상호작용을 바꾸거나 GPU resource·pass·material·draw call을 추가하지 않는다.

### 4.2 야간 창호 불빛 계약 (#81)

- 일반 초가·기와집의 고정 창호 plan은 opening id, 한지 면 중심, 개구면 로컬 축과 외향 법선을 Three 없이 한 번
  확정한다. 원경 불빛은 FULL renderer와 똑같은 변주·mirror·실제 house fit·필지 `frontDir`·회전·중심·지면 높이·
  비등방 scale 변환을 소비한다. `plotW`/`plotD` 중심, 임의 극좌표, 렌더 파일 치수 재추론은 금지한다.
- anchor는 움직이는 primary 문짝과 분리된 **고정 한지 면**이다. 보이는 불빛 중심은 실제 panel 외측으로
  `OPENING_FACE_CLEARANCE` 2cm만 분리하며, 같은 opening id의 실제 한지 emissive가 근경 LOD를 이어받는다.
  좌표 변환을 두 번 적용하거나 벽·지붕·담 위에 자유 부유하는 보정점은 허용하지 않는다.
- 기존 원경 `THREE.Points`는 색 패스에서 `depthTest=true`, `depthWrite=false`를 사용한다. 집 몸체·지붕·담·지형·
  수목처럼 카메라에 가까운 불투명 표면이 빛을 정상적으로 가리고, additive·bloom·DoF 보케는 가림 뒤의 픽셀을
  되살리지 않는다. DoF가 켜진 프레임에는 같은 점 크기·원형 discard·가시성 vertex 계약을 쓰는 전용 packed-depth
  material로 기존 depth target에 한 번 더 그려 source-depth scatter의 실제 광원 깊이를 제공한다. 반대 벽을 뚫거나
  지붕·하늘 위로 비치는 점은 실패다.
- seed-stable 점등 분포는 일부 방을 어둡게 유지한다. 낮에는 제출하지 않고, 밤의 색 패스는 현재의 단일
  `THREE.Points` geometry/material/program을 재사용한다. source-depth 지원은 같은 geometry를 쓰는 depth material·
  program 각 1개와 DoF 프레임의 depth draw 1회만 더하며 triangle·texture·render target·색 draw 증가는 0이다.
  `PointLight`, 집별 mesh/material, 프레임별 scene traversal·raycast·heap allocation도 0이어야 한다.
- FAR/MID/FULL은 하나의 불빛 의미를 중복 소유하지 않는다. 렌즈 등가 거리와 근경 fade는 기존 uniform에
  합성하고, focus/rebuild/reroll/hop과 wave의 old/incoming exclusive ownership에서 팝·잔상·이중 불빛이 없어야
  한다. commit된 편집 집은 마지막 승인 opening plan과 실제 fit을 즉시 권위값으로 삼는다.
- 궁·사찰·정자는 임의의 원형 점 분포로 채우지 않는다. 조립 뒤까지 역할이 보존된 실제 창호·등롱·석등 anchor가
  있을 때만 같은 계약에 참여하고, 그렇지 않으면 불빛을 생략한다. ‘어두움’이 ‘근거 없는 부유 불빛’보다 안전한
  fail-closed 결과다.

## 5. LOD·재질·수명 계약

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
  데이터이며 footwear와 interaction runtime은 이 marker를 찾고 focus-out·rebuild·dispose 수명에 맞춰 상태를
  소유한다. `primary-opening-panel`은 한 짝 크기이며 제품이
  허용한 선택 FULL 주거 runtime은 `primary-door-pivot` 하나를 추가하지만 새 재질/program 계열은 만들지 않는다.
  Svelte는 Three 상태를 소유하지 않고 canvas pointer 결과만 표시한다.

## 6. 검증

- `npm run check:nightlights`는 실제 초가·기와 ㅡ·ㄱ·ㄷ prototype에서 수집한 38개 opening anchor의 id/한지 면/
  외향 법선, mirror, JSON-safe deep freeze와 반복 결정론을 검사한다. 이어 실제 `planVillage` 필지 변환과 합성
  hero·궁 소유자, 저작 anchor가 없는 사찰·정자의 fail-closed, 고정 owner slot, focus overlay 교체·원복,
  wave·dispose 수명과 단일 Points 색 패스의 1 draw/0 triangle/1 material/1 program/0 texture/0 light, DoF depth의
  추가 1 draw/1 material/1 program/0 target 예산을 검사한다.
- `npm run shoot:nightlights`는 실제 앱의 고정 seed에서 aerial/MID/focus 밤 프레임과 같은 카메라의 정면·후면
  depth-on/depth-off 프레임을 촬영한다. 한지 면에 붙은 절제된 따뜻한 bloom/bokeh, 불투명 집·담 뒤의 실제
  깊이 가림, 어두운 방의 공존과 자유 부유점 부재를 직접 판정한다. 같은 실행에서 focus와 재건축이 고정 owner
  slot·geometry·material을 재사용하면서 실제 opening 위치를 따라가는지도 확인한다.
- `check:worker`는 sync/Worker/fallback의 scene bytes·일반 dispose 수명을, `check:parcel-rebuild:browser`는
  focus/edit/probe 실패 뒤 창불·문 owner 복원을 맡는다. `check:app`은 항목별 References UI와 전체 앱 부팅을
  확인하고, 넓은 회귀 범위는 `check:full`로 마감한다.

- `npm run check:opening-detail`: 순수 결정론, 불변 데이터, vocabulary, 창 머름과 문 lowerPanel의 배타성,
  frame·threshold·유형별 철물 범위,
  primary pivot/footwear/focus anchor와 전역 RNG 비의존을 검사한다. focus는 개구면의 고정 중심이며 door leaf 운동과
  독립인지도 확인한다.
- `npm run check:threshold-life`: dry/wet 종류, 실물 기반 크기 범위, 문지방·출입 폭·문설주 clearance, preview
  placement signature, JSON-safe deep freeze, 객체·BigInt seed 결정론, 전역 RNG 비의존을 검사한다.
- `npm run check:door-motion`: 한 짝 폭·jamb-edge pivot·안쪽 signed angle, 결정적 임계감쇠, 중간 반전 무스냅,
  정확한 정착과 idempotent dispose를 검사한다.
- `npm run check:door-occlusion`: ㄱ·ㄷ 빈 마당 통과와 실제 wing 차폐, 일반 담/대문 개구, 정자 외접 상자의
  빈 모서리·기둥·수렴 지붕, 공용 소품, 사찰 중정·회전 전각·담/문, 궁장/광화문, 도성 성벽/홍예, 시전 다각형,
  선택 host만 제외하는 owner 규칙, 회전된 commit bounds, 여름 수관/겨울 줄기, 필지·flora 원자 refresh와 유한
  선분 DDA 후보 상한을 Three·DOM 없이 검사한다.
- `npm run check:building-clearance`: 실제 궁·사찰·일반 기와·초가·대표 종가 production geometry에서
  frame/hardware가 각각 한 batch이고, primary entrance가 하나이며 철물이 MID에 섞이지 않는지 검사한다. 초가
  기본·최소·최대와 기와 ㅡ·ㄱ·ㄷ은 planner와 실제 패널의 개수·폭, 부엌 분리, 메시·재질 상한뿐 아니라
  각 fixture의 닫힘/중간/열림 picking·안쪽 swing·dispose까지 함께 검사하고,
  `-1.4×0.7×1.25` mirror·비등방 host basis에서도 신발 pair의 세계 length/width가 바뀌지 않는지 확인한다.
  기와 ㅡ·ㄱ·ㄷ × 대청 좌우 primary seed × 최소·기본·최대 문 폭/개수 18개 production fixture는 실제 툇마루
  bounds 안에 신발이 남고 리턴 난간·대청 바닥·출입구와 겹치지 않는지도 검사한다.
  같은 production fixture의 moving owner가 정확히 한 짝 폭인지, 반전·비등방 host에서도 세계 경첩 반경과
  Gram metric이 일정한지, 안쪽 sweep, 닫힘/중간/열림 picking, frame 고정, panel/청판/seam/hardware 강체 동행,
  고정 암부의 ray 깊이, 숨은 조상·layer 배제와 host 복원도 검사한다. 선택 root 밖의 가림은 위 순수 semantic
  gate와 실제 앱 입력 경로가 맡는다.
- `npm run check:app`: 네 기와집 topology가 `hardware` 재질 하나를 공유하고 FULL decomp마다 한 그룹만 가지며,
  일반 기와↔초가와 대표 종가 rebuild가 anchor/panel/frame/hardware를 정확히 하나씩 교체·해제하는지 검사한다.
  정적 마을에는 신발이 없고 focus에서만 한 batch가 생기는지, 실제 clear→rain 전환이 짚신→나막신으로 바뀌며
  이전 자원을 한 번만 해제하는지, focus-out이 이를 회수하는지도 재질·텍스처·program 상한 및 실제 Reference UI와
  함께 검사한다. 또한
  실제 초가 focus에서 hover/click/drag/중간 반전과 열린 문간 close action이 동작하는지, 교차 pointer type·
  cancel·lost capture·blur가 click 소유권을 깨뜨리지 않는지, 숨은 owner를 고르거나
  compound 차폐를 관통하지 않는지, 초가→대표 종가 hop이 이전 runtime·pivot·host graph를 회수하는지,
  대표 종가 rebuild가 네 opening/threshold geometry를 정확히 한 번 해제하는지 검사한다.
  별도 실제 capital/town 앱은 궁·사찰과 `heroStyle: 'palace'` 관아 focus에 runtime·screen target·pivot이 생기지
  않는 의미 기반 범위 제한을 검사한다.
- 시각 판정은 같은 seed·카메라·시간의 전후 PNG를 직접 비교한다. 프레임이 창호지를 과도하게 가리거나 검은
  테두리로만 읽히지 않는지, 문고리가 원경에서 노이즈가 되지 않는지, 벽과 겹쳐 깜빡이지 않는지 본다.
- `npm run check:dof:app`은 실제 focus-in·필지 hop·focus-out과 재건축에서 조준점→문·문→문·출발 문 고정 수명,
  복합체 fallback, 정착 프레임의 캐시 불변을 검사한다. `npm run shoot:door-dof`는 같은 주거·카메라·시간에서 기존
  조준 깊이와 의미 문 깊이를 A/B 촬영해 primary 문양과 철물의 선명도, 뒤쪽 광원의 원형 보케를 직접 판정한다.
- 2026-07-22 고정 town ㄷ자 컷의 측정은 calls 842→849, triangles 5,841,310→5,891,054, textures 44→44였다.
  같은 초가 컷은 calls 501→505, textures 26→26이었다. Headless 시간은 성능 근거로 쓰지 않는다.
- active leaf 분리와 가변 residential plan 통합 뒤 production opening 예산은 일반 기와 324+24+144,
  궁 1212+24+208, 사찰 1020+24+144, 초가 244+24+144, 종가 436+24+144
  triangles(fixed frame+moving leaf detail+hardware)다.
- fixture 기준 FULL 예산은 초가 기본 4개 개구/78 meshes/31 materials, 초가 최대 13/95/32,
  기와 ㅡ 5/140/43, ㄱ 5/161/51, ㄷ 최대 20/251/64다. 개수가 늘어도 frame/hardware는 건물당
  각각 한 batch이며 개구 수에 비례한 texture나 detail draw batch를 만들지 않는다.
- 2026-07-22 신발 근접 캡처에서 focus overlay 한 켤레는 짚신 232 triangles, 나막신 184 triangles이고 모두
  calls +1, 기존 장면 워밍 뒤 programs +1이다. 실제 앱의 대표 종가 rebuild는 frame·hardware·신발 geometry를
  각각 한 번 해제하고 programs 증가를 +2 이하(기존 rebuild 계열 + vertex-color 신발 계열)로 제한했다. 정적 마을은
  신발 geometry와 call을 전혀 제출하지 않는다. 절대 시간은 비교하지 않는다.
- `npm run shoot:door`는 실제 앱에서 닫힘/중간/열림의 정면·사선 6장을 임시 디렉터리에 만든다.
  `CHEOMA_DOOR_TARGET=choga|hero`로 두 고정 암부 대상을 따로 촬영하며 hero는 읽기 쉬운 낮이 기본이다.

## 7. 원문과 이용조건

- 건축공간연구원 국가한옥센터, 「한옥의 시공 — 창호와 천장」:
  https://www.hanokdb.kr/theology/sub_04
- 건축공간연구원 국가한옥센터, 「한옥의 감상」:
  https://www.hanokdb.kr/theology/sub_03
- 국립민속박물관 웹진, 「빛으로 밝히고 조명으로 통하다」:
  https://webzine.nfm.go.kr/2018/09/06/%EB%B9%9B%EC%9C%BC%EB%A1%9C-%EB%B0%9D%ED%9E%88%EA%B3%A0-%EC%A1%B0%EB%AA%85%EC%9C%BC%EB%A1%9C-%ED%86%B5%ED%95%98%EB%8B%A4/
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

AURI·국립민속박물관·국립익산박물관·Korea.net 페이지는 저작권 보호 자료이므로 이용조건을 자산 재사용 전에 다시 확인한다.
국립중앙박물관 해설은 공공누리 제3유형(출처표시+변경금지)이다. 국가유산포털 자료도 상세 페이지의 저작권·
공공누리 유형을 자산 재사용 전에 다시 확인해야 한다. 저장소와 앱에는 원문 도면·이미지를 복제하지 않고 링크,
사실 요약, 독자적으로 만든 저해상도 절차 geometry만 포함한다.
