# 검증 가이드

> - **상태**: 현재 계약
> - **기준일**: 2026-07-22

이 프로젝트에는 전통적인 unit-test/lint/typecheck 프레임워크가 없다. 대신 빠른 정적·golden 계약, 실제 Worker, 전체 앱 Playwright smoke, 도메인별 시각 하네스를 위험에 맞게 조합한다.

## 기본 준비

루트 `package.json`은 Playwright와 PNG 전후 비교(`pngjs`) 도구용이고 `app/package.json`은 SPA용이다. 도구 버전은 lockfile과 함께 고정한다.

```bash
npm install
cd app && npm install
```

추가 dev 서버는 사용자의 서버를 건드리지 않고 `127.0.0.1`, 임시 포트, 고유 Vite `cacheDir`를 사용한다. 영구 `check:*` 도구는 이 격리를 스스로 수행한다.

영구 browser 하네스의 기본값 `CHEOMA_BROWSER=auto`는 host GPU를 사용할 수 있는 설치된 Chrome을 먼저 시도하고, 없거나 시작할 수 없으면 Playwright bundled Chromium으로 되돌아간다. 선택된 browser는 항상 로그에 남고, WebGL을 사용하는 하네스는 실제 renderer도 기록한다.

```bash
CHEOMA_BROWSER=chrome npm run check:app    # Chrome 필수, 시작 실패도 실패
CHEOMA_BROWSER=chromium npm run check:app  # pinned bundled Chromium 필수
```

서로 다른 backend의 wall time은 성능 전후 수치로 비교하지 않는다. bundled Chromium이 SwiftShader인 환경에서도 계약은 유지되지만 shader link가 훨씬 느릴 수 있다.

`check:worker`는 예외적으로 Playwright-pinned Chromium을 고정한다. 이 게이트의 scene/proxy hash는 worker-vs-sync뿐 아니라 고정 browser JS runtime의 byte baseline을 비교하므로, 자동 업데이트되는 system Chrome으로 기준을 바꾸지 않는다. 이 경로는 WebGL을 렌더하지 않아 GPU 이점도 없다.

## 검증 계층

반복 작업에서는 변경 경로를 먼저 보고 영향받은 게이트만 실행한다.

```bash
npm run check:pr -- --dry-run  # 변경 파일, 선택 이유, 실행 예정 명령
npm run check:pr               # 빠른 core + 영향받은 browser/worker/build 게이트
```

`check:pr`는 core 계약을 항상 실행한다. 여러 변경의 게이트는 합집합으로 한 번씩 실행하며, `src/env/rim.js`는 좁은 `check:rim`을 명시적으로 추가한다. 알 수 없는 새 경로, 검증 도구, dependency manifest/lockfile, public aggregate API, merge-base 해석 실패는 조용히 축소하지 않고 `check:full`로 승격한다. `--base <ref>`, `CHEOMA_CHECK_BASE`, `--files-from <file|->`, `--full`, `--json`을 지원하며 `--json`은 실행하지 않는 machine-readable plan을 뜻한다. 비공개 Claude memory인 untracked `.claude/`는 변경 탐색에서 제외한다.

PR을 머지하기 직전에는 `npm run check:full`을 한 번 실행한다. 이는 `check:all`에 실제 DoF 앱 흐름, Hanyang LOD의 연속-frame focus+wave 흐름, production build를 더한다. 빠른 게이트가 전체 게이트를 대체하는 것이 아니라 반복 횟수를 줄이는 구조다.

## 표준 명령

```bash
npm run check               # 구조 + DoF/광학 + 10개 plan golden + 순수 형상 불변식
npm run check:pr            # 변경 영향 기반 반복 게이트
npm run check:full          # 머지 전 전체 계약 + production build
npm run check:dof           # 축방향 초점 + 원형 HDR 보케의 순수 계약
npm run check:dancheong     # 궁/사찰 단청 범위·위계·버킷·패널 라우팅 순수 계약
npm run check:dancheong:browser # source/수명/성능/GLB + 저·고격식 PNG 시각 계약
npm run check:dancheong:app # 실제 패널 입력 → 공개 API → 사찰 컴파운드 재생성 계약
npm run check:dof:app       # 실제 focus 전환 + StableBokeh 깊이 패스 계약
npm run check:atmosphere    # Three 없는 시간대·석양 profile 동기 계약
npm run check:environment   # Three 없는 계절·날씨 호환 상태와 장면 목록 계약
npm run check:house-diversity # 필지·살림 위계→ㅡ/ㄱ/ㄷ, ㄷ 4칸·실제 처마 fit 계약
npm run check:residential-openings # 초가·기와 shape별 문/창 수·폭·primary 순수 계약
npm run check:residential-edit-url # 종류+여섯 개구부 축 compact URL codec 계약
npm run check:residential-edit-url:browser # commit→URL→reload/focus 실제 앱 계약
npm run check:opening-detail # 문·창 frame·머름·threshold·anchor 순수 계약
npm run check:threshold-life # 짚신/나막신 크기·문간 clearance·결정론 계약
npm run check:door-motion   # primary 문짝 한 짝의 순수 hinge·임계감쇠·반전 계약
npm run check:door-occlusion # 유한 선분 semantic grid·오목 집/정자/전각/시전/계절 수목 차폐 계약
npm run check:winter:app    # 실제 앱의 겨울·적설 표면·shader/draw 예산 계약
npm run check:lod           # 주택 3단계 LOD + 생활 디테일 + 표현 소유권 계약
npm run check:lod:app       # 한양 focus/hop 뒤 한양→town wave를 잇는 전체 앱 계약
npm run check:lod:focus     # 한양 focus/hop/out만 선택 실행
npm run check:wave:app      # town→village wave·동물·ambient·취소 수명주기
npm run check:petals        # 계절 꽃잎·낙엽의 거리 휴면 + 눈·비 회귀
npm run check:citywall      # 성곽 contour·사대문·필지·도로·지형 밀착 계약
npm run check:roads         # stable ID·junction·lens 정리·도로 회랑 spatial 계약
npm run check:surface       # 결정론 흙 표면 source·world UV·수명주기 빠른 계약
npm run check:surface:browser # 흙길 OFF/ON·반복/shimmer·program/texture·GLB 계약
npm run check:layout        # 좌향·집 fit·도로/개울/논·일조/정자/보호수·밀도 계약
npm run check:live-edit     # 실시간 편집 병합·적응 케이던스·commit/취소 순수 계약
npm run check:shader-warm   # 해제된 서브트리와 GPU 링크 polling 수명 계약
npm run check:live-edit:browser # 실제 range 입력(단건 재건축 앱 게이트 공유)
npm run check:parcel-rebuild # 단건 필지 재건축·flora 재배치 순수 계약
npm run check:parcel-rebuild:browser # 실제 패널·카메라·지속 LOD·렌더 예산
npm run check:temple       # Three 없는 복합 가람 계획·일조·마을 예약 계약
npm run check:temple:browser # 독립 WebGL 조립·dispose·부감 병합 성능 계약
npm run check:wall-gate     # 6종 담·비전면 대문의 plan/render 중심 일치
npm run check:yard          # 마당나무·부속채·장독대 등 hard object clearance
npm run check:building-clearance # 기단·대지·개구부·지붕 접합의 깊이 소유권
npm run check:wave          # 마을 재생성 scenery 배타 소유·재질 불변·취소 계약
npm run check:choga-roof    # 초가 지붕/벽 접합만 빠르게 검사
npm run check:roof-seams    # straight-skeleton 기와지붕 face 이음새 검사
npm run check:cinematic     # 막다른 길·±π·드론 시선의 각속도/각가속도 순수 계약
npm run check:cinematic:app # 실제 Hero 등장·집 재생성·입력 인계·모바일/reduced-motion
npm run check:app           # 실제 Vite 앱 Playwright smoke
npm run check:ink:app       # PBR↔수묵 UI·URL·색공간·pass 휴면·모바일·픽셀 계약
npm run check:build         # OS 임시 outDir의 격리 production build
npm run check:worker        # sync/Worker/fallback 전체 마을 계약
npm run check:audio         # 실제 Web Audio 생성·종료 수명주기 계약
npm run check:all           # core/app/환경/worker/audio/temple/parcel/surface 통합 게이트
npm run shoot:dof           # 고정 seed·정지 프레임 DoF 미감 비교(PNG는 OS 임시 폴더)
npm run shoot:bokeh         # 제어 광원 원형비·정지 동일성·저속 패닝 보케 fixture
npm run shoot:focus-level   # 16° 주택·종가·관아 hero·궁·사찰 실제 앱 구도 6장
npm run shoot:sky           # 실제 앱의 낮/세 석양/밤·구름·달·광선·그림자 캡처
npm run shoot:winter        # check:winter:app과 같은 겨울/설경 PNG 증거 생성
npm run shoot:ink           # check:ink:app과 같은 부감 PBR/수묵·근경 PNG 증거 생성
npm run shoot:wave          # 대표 village 먹안개 handoff·그림자·program plateau 촬영
npm run shoot:wave:full     # hamlet/village/capital/hanyang 전체 시각 행렬
npm run shoot:threshold-life # dry/wet·scale·topology별 민가 문간 신발 근접 촬영
npm run shoot:door          # 실제 앱 주거 primary 문 닫힘/중간/열림 정면·사선 6장
```

영향 범위가 넓은 구조 변경은 반복 중 `check:pr`, 머지 전 `check:full`을 사용한다. `check:all`은 core/app/petals/worker/audio에 독립 사찰 WebGL과 단건 재건축 앱 계약을 더한다.

```bash
cd app
npm run build
```

clean snapshot이 필요하면 사용자 dev server와 기존 산출물을 건드리지 않는 임시 `outDir`를 사용한다. 반복 incremental build를 같은 별도 outDir에 덮어쓰면 boot-time uniform 오류가 날 수 있다.

## 영구 게이트

### `npm run check`

`tools/check-fast.mjs`가 다음 계약을 독립 Node process로 격리해 제한 병렬 실행한다. 기본 동시성은 `min(4, availableParallelism)`이고 `CHEOMA_CHECK_JOBS=1`처럼 재현할 수 있다. 상세 출력은 선언 순서로 묶여 나오며 개별/전체 시간이 표시된다. 첫 실패는 즉시 알리고 새 검사를 더 배정하지 않되 이미 실행 중인 격리 process는 정리될 때까지 기다린다.

- `check:architecture`
  - `src/`→Svelte/app 금지.
  - 앱의 코어 import는 `src/api/`로 한정.
  - 코어 내부→public façade 역참조 금지.
  - generator→runtime 금지, 기존 village→runtime은 adapter shim만 허용.
  - 상대 import 해석, `src/` cycle 0, core 방향 검사.
  - `village-plan` dependency closure의 THREE·DOM·browser 전역 금지.
- `check:building-clearance`
  - 기본·최소·최대·clamp 경계 ㄱ자 기와집 기단의 아래켜·위켜·줄눈·갑석이 각각 하나의 오목 솔리드만 소유하고, 날개는 유지하면서 안마당 쪽 빈 영역을 메우지 않는지 실제 production geometry로 검사한다.
  - 궁·절·초가·기와·반가의 최하단 기초가 보이는 상단 높이를 바꾸지 않고 대지 아래로 6cm 묻히며, 필지 마당이 성토면에서 6cm 분리되는지 검사한다.
  - 판벽 봉창의 보이는 면이 벽보다 2cm 앞에 있고 맞배 박공벽이 지붕 아래로 16cm 물리는 공통 계약을 검사한다. 깊이 순서는 `polygonOffset`이나 카메라에 의존하지 않는다.
  - 기와집·초가의 부엌 장면이 마당 높이 개구·문짝·문지방·솥·불씨·화광 의미 부재를 공유하고, 외벽 밖 독립 화덕 매스로 되돌아가지 않는지 검사한다.
  - 초가 기본·최소·최대와 기와 ㅡ·ㄱ·ㄷ FULL fixture에서 순수 plan의 문·창 개수·폭·높이가 실제 패널에 그대로 적용되고, primary anchor·frame/hardware batch·부엌 service opening이 각각 하나인지 검사한다. 1.05m 문짝 경계 양쪽의 detail/texture 짝수 일치와 얕은 초가에서 최대폭 동측 창이 실제 부엌 frame span을 침범하지 않는 극한 fixture도 포함하며, 최대 fixture의 메시·재질 예산을 제한한다.
- `check:residential-openings`
  - 초가 3/5칸과 기와 ㅡ·ㄱ·ㄷ의 shape별 슬롯·개수/폭 capability·남향 primary·대청/부엌 제외·seed 결정론을 Three 없이 검사한다.
  - runtime 편집 spec과 Svelte schema가 같은 여섯 축·범위·단위·`building` route를 쓰고 shape/type 변경 뒤 canonical 값으로 정규화되는지 검사한다.
- `check:residential-edit-url`
  - parcel ID·종류·여섯 개구부 축을 stable ID 순서의 compact `vedit` v1 payload로 왕복하고, 기본 상태는 URL을 늘리지 않는지 검사한다.
  - 중복/비유한/범위 밖/알 수 없는 종류·필지, 8필지·768자 상한 초과 payload를 부분 적용 없이 전부 거부한다.
- `check:residential-edit-url:browser`
  - 실제 앱에서 여섯 축 편집을 commit한 뒤 URL을 다시 열어 같은 필지를 focus했을 때 전체 spec과 geometry가 복원되는지 검사한다.
  - 잘못된 payload가 장면 일부를 바꾸지 않는지, 종류/commit/재굴림/focus 전환이 public runtime을 거쳐 URL과 동기화되는지 확인한다.
- `check:opening-detail`
  - 문·창 grammar가 Three·DOM·전역 RNG 없이 같은 seed에서 같은 불변 plan을 반환하는지 검사한다.
  - 머름을 창 하부 apron/rail로만 배치하고 문 하부 청판 rail은 `lowerPanel`로 분리하는지, reveal·frame·threshold와 primary entrance의 최소 철물, pivot·footwear anchor가 개구 범위와 공통 surface-clearance를 지키는지 검사한다.
  - `check:building-clearance`는 이어서 실제 궁·절·기와·초가·대표 종가가 frame/hardware 각각 한 batch와 primary entrance 하나를 갖고 hardware를 MID에 넣지 않는지 확인한다.
- `check:threshold-life`
  - 민가 primary 문간 한 켤레가 마른 조건의 짚신·젖은 조건의 나막신으로 제한되고 실물 기반 사람 크기 범위, 문지방·열린 출입 폭·선택한 문설주 clearance를 지키는지 검사한다.
  - 같은 seed의 JSON-safe deep-frozen 결과, 객체 키 순서·BigInt·순환 seed 정규화와 전역 RNG 비의존을 검사한다. 문폭·topology·landing surface가 달라지면 placement signature가 반드시 바뀌고 무관한 지붕 축에는 안정적인지도 검사한다.
  - `check:building-clearance`는 정적 건물에 신발이 전혀 없는지와 mirror·비등방 host scale에서도 pair의 세계 length/width가 실측 범위를 유지하는지 확인한다. 실제 focus-only geometry batch·재질·날씨 교체·dispose와 Reference UI의 네 canonical URL·라이선스 문구는 `check:app`, topology 변경 preview의 재생성 및 동일-signature rigid rebase는 `check:parcel-rebuild:browser`가 맡는다.
  - `npm run shoot:threshold-life`는 `0.7×`·`1.4×` 및 비등방 scale, 기와집 4칸↔3칸 경계, dry·wet 문간을 실제 production builder로 근접 촬영하고 신발 batch의 calls/triangles delta와 세계 bounds를 함께 기록한다. 기본 출력은 OS 임시 폴더다.
- `check:door-motion`
  - primary 문의 경첩 쪽 한 짝 폭, jamb-edge pivot, 안쪽 signed angle을 Three·DOM·전역 RNG 없이 검사한다.
  - 임계감쇠 진행이 같은 step sequence에서 byte-stable하고, 중간 반전에도 각도·속도가 끊기지 않으며, seek·dispose가 결정적이고 멱등인지 검사한다.
  - `check:building-clearance`는 FULL primary 다짝 문의 실제 한 짝 panel·청판·rail/seam·철물만 pivot 아래에서 강체로 움직이고 frame·나머지 짝은 고정되는지 이어서 검사한다. 초가·대표 종가의 고정 암부 깊이와 열린 ray 첫 표면, 숨은 panel/pivot/root 및 layer 불일치 배제, 해제 뒤 부모·transform·geometry/material 소유권 복원도 수치로 확인한다.
- `check:door-occlusion`
  - 선택 문 hit까지의 유한 ray segment만 uniform-grid DDA로 순회하고, 같은 record가 여러 cell에 걸쳐도 한 번만 검사하는지 확인한다.
  - ㄱ·ㄷ의 오목한 빈 마당, 일반 담과 road-side 개구, 종가 담/대문/wing, 정자 외접 상자의 빈 모서리와 수렴 지붕, 사찰 전각/담/문, 궁장/광화문, 도성 성벽/홍예, 시전 polygon과 공용 소품을 실제 순수 계획 형상과 대조한다.
  - 선택 필지에서는 host 집 record만 제외하고 같은 owner의 담·문은 유지하는지, 회전된 commit bounds가 원본 impostor를 즉시 대체하는지 확인한다.
  - 실제 flora anchor를 미리 갱신해 여름 수관·겨울 줄기를 구분하고, 필지 복수 record·flora 교체 뒤 낡은 cell/record가 남지 않는지 검사한다.
- `check:house-diversity`
  - 일반 기와집 prototype group을 4개로 고정하면서 ㅡ·ㄱ 좌우·ㄷ 레퍼토리를 유지하고, 작은 필지가 ㄷ을 받지 않으며 ㄷ은 항상 4칸 이상인지 검사한다.
  - 고정 town의 일반 필지가 최소 3.5배 면적 범위와 충분한 연속 폭·높이·색 범위를 유지하고, ㅡ자 편집에서 무효 날개축을 숨기며 3/4칸 본채 폭이 실제 반응 하한에서 시작하는지 검사한다.
  - 실제 FULL/MID/FAR 공통 처마 모서리가 부정형 필지 안에 0.3m 여유를 두고 이웃 처마와 겹치지 않는지, ㄷ이 fit factor/유효 scale 하한 아래로 축소되지 않는지 검사한다.
  - 동일 seed에서 rank·wealth·필지·마을 규모가 집 폭·높이와 instanceColor 톤에 단조 신호를 주며 전역 `Math.random`을 쓰지 않는지 검사한다.
  - `check:app`은 미러 ㄱ이 focus/edit에서도 같은 방향인지, 기와↔초가 전환이 대상 기본값·벽 어휘·코어 clamp를 패널과 일치시키는지, 토폴로지가 다른 ㅡ/ㄷ이 파생 기와 반복·창호 무늬를 보존하면서 의미상 같은 팔레트를 공유해 재질 120·텍스처 60 상한을 지키는지 검사한다.
- `check:dof`
  - 월드 초점점을 카메라 위치와의 직선거리가 아니라 카메라 전방축 깊이로 변환하고, 부모 rig 변환과 near/far 경계를 반영하는지 검사.
  - DoF 양과 aperture가 하나의 controller에서 단조롭게 켜지고 꺼지며, 중간 반전 뒤 잔여 효과가 남지 않는지 검사.
  - 장식용 Points·Line·Sprite와 `depthWrite=false` 또는 명시적으로 제외한 객체가 깊이 기여자로 분류되지 않는지 검사.
  - 중간 opacity의 `alphaHash` 생활 디테일이 stock override depth에서 완전 불투명 occluder로 되지 않고, opacity 1에서는 다시 깊이에 합류하는지 검사.
  - 원형 HDR 보케가 중심+8/12/20 동심원, 총 41개 고정 표본으로 광학 중심과 단위 원을 지키며 화면좌표/시간 난수 없이 stock과 같은 color-fetch 예산을 쓰는지 검사.
  - 셰이더가 동적 uniform 배열 없이 기존 `BokehPass` uniform/API를 보존하는지 검사.
- `check:dancheong`
  - 궁 기본 모로, 사찰 중심 불전 금·부속 금모로·요사 모로의 위계와 두 공개 축 clamp를 검사한다.
  - 기와집·초가에는 설정과 패널 축이 없고, 궁 `presetOverrides`·사찰 `templeOptions`로만 재생성되는지 검사한다.
- `check:dancheong:browser`
  - 동일 source key의 불변 Canvas 재사용과 팔레트별 Texture 소유, LRU 96 상한, 서로 다른 궁·사찰의 편집·dispose 격리를 검사한다.
  - 궁 저/고격식 드로콜·재질 수가 같고 사찰 위계 팔레트가 3개 이하인지, 프로그램 수·병합 드로콜 상한을 검사한다.
  - CanvasTexture가 GLB에 남는지 확인하고 OS 임시 폴더에 궁·사찰 저/고격식 PNG 4장을 쓴다.
- `check:dancheong:app`
  - 실제 한국어 패널의 선명도/격식 입력을 바꾸고 `templeOptions` 공개 API 호출, 재생성된 중심 불전의 위계, 패널/runtime spec 동기화를 검사한다.
- `check:atmosphere`
  - 금빛·홍빛·보랏빛 석양이 같은 태양 방향을 유지하면서 sky/fog/light와 post 값을 함께 제공하는지 검사한다.
  - 시간대 별칭과 잘못된 스타일 입력이 안정된 기본값으로 정규화되는지, profile registry가 Three·DOM 없이 import 가능한지 검사한다.
- `check:plan`
  - hamlet/village/town/capital/hanyang × temple OFF/ON 10개 전체 plan SHA-256.
  - 같은 입력 반복 결정론.
  - 전역 `Math.random` 미사용.
  - 입력 옵션 불변.
- `check:temple`
  - compact/courtyard/extended의 최소·최대 크기 × 3 seed, 총 18개 순수 계획의 반복 결정론과 전역 `Math.random` 미사용을 검사한다.
  - 담장·남측 산문·마당·전각·의미 기반 석조물, footprint 내부성, 전각/프롭 겹침과 주불전 남측 일조 통로를 검사한다. 정자를 통로 안에 고의로 넣은 반례가 반드시 실패해야 한다.
  - solo/hamlet/village/town/capital/hanyang adapter가 실제 폭·깊이를 예약하고 남측 문에서 도로·성문 또는 road-free solo 중심으로 이어지는지 검사한다.
- `check:roads`
  - 도로 ID 유일성, 교차/T접속 junction의 양방향 역참조, 자기교차 0, 국소 회전 45° 이하를 검사한다. 독립 brute-force 교차 목록과 비교해 누락된 junction도 찾는다.
  - 같은 두 도로가 물리적 merge 반경 안에서 다시 만나 바늘구멍형 lens를 남기지 않는지 역검사한다.
  - `road-spatial.js`의 최근접·폭 포함 clearance를 brute-force 결과와 비교하고, 같은 seed의 도로·junction snapshot 결정론을 확인한다.
- `check:surface`
  - Three·DOM 없는 packed-earth source의 고정 hash, seed 결정론, 전역 `Math.random` 미사용과 호출자 변경 격리를 검사한다.
  - albedo 평균·표준편차와 wrap 경계 기울기가 저대비·무봉합 예산 안인지, 어댑터가 albedo sRGB/height non-color와 repeat·trilinear mipmap·anisotropy를 명시하는지 검사한다.
  - 실제 도로의 회전 월드 XZ UV, 단일 mesh/material, 빈 도로 texture 0, object-tree 해제 시 geometry/material/두 texture가 각각 한 번만 dispose되는지 검사한다.
- `check:layout`
  - 종가·관아·궁역 남향, 일반 필지 최종 좌향 65° 상한과 seed마다 남축 ±60° 안 70% 이상인 군집, `frontDir` 하나로 poly·집·담·픽킹 회전이 일치하는지 검사한다.
  - frontage/infill 필지가 stable road ID·접점을 소유하고 최근 도로측 담 변의 `gateEdge/gateT`를 저장하는지 검사한다. 대문 직전의 1cm probe가 필지 밖이고 도로를 향하며, 대문→도로 선분이 자기 처마를 관통하지 않고 접근 거리가 상한 안인지 확인한다. 필지·실제 처마가 폭을 가진 도로와 개울 둑을 침범하지 않는지도 같이 검사한다.
  - 실제 variant 처마가 자기 필지 안에 0.3m 여유를 남기고 이웃 필지·처마·궁역·논과 겹치지 않는지, 축소율·유효 scale 하한과 뒤안 이동폭을 검사한다. runtime 단건 재굴림의 같은 fit sequence도 대표 필지에서 재현한다.
  - 개별 seed와 scale 합계의 호수 하한으로 과도한 빈집 회귀를 막는다. 모든 이웃 지붕 쌍이 실제 높이·지형과 30° 저각 햇빛 기준의 1.5m 창 일조를 지키는지, 남측 `solarAccess`, 정자 실제 지붕·focus 화면 폭, 높이 있는 마을 소품, 보호수 실제 수관, 논, 개울, 숲/근경 식생 index가 같은 radius-aware footprint 계약을 쓰는지 검사한다. 중심선은 비키지만 화면 가장자리를 덮는 합성 정자 반례도 포함한다.
  - 모든 규모·seed의 개울 1,095개 종단에서 다섯 수면 lane이 실제 terrain-grid 삼각면보다 clearance 위인지,
    해석 수면에서 과도하게 뜨지 않는지, `-x` 흐름을 거슬러 올라가는 구간이 없는지 검사한다.
  - capital/hanyang의 명시적 대하천은 60–120m 실제 수면, 충적 어깨, 상설교 없는 나루, 접합된 남안 길, 최소 5/8가구의 포구 취락을 함께 검사한다. 각 렌더 단면의 실제 `point.half`로 수면 매입과 world-edge 6m 여유를 검사해 안개 밴드의 테이퍼를 순수 계약으로 고정한다.
- `check:wall-gate`
  - 실제 `buildVillageWall()`로 `tile/stone/mud/brush/hedge/open` 6종을 만들어 plan의 `gateEdge/gateT`와 물리 문틀 중심·회전이 일치하는지 검사한다. `shape.edges`가 없는 hero의 비전면 대문과 finite geometry도 함께 검사한다.
- `check:wave`
  - 실제 `createRerollWave()`를 번들해 전 구간의 정적 scenery가 old/incoming 중 정확히 하나만 보이고, handoff peak에 veil=1·shadow=0인지 검사한다.
  - 공유 재질 identity·opacity·transparent·depthWrite·version이 불변이며, 궁 병합 root가 건물 tofu wave에 합류하고 cancel/dispose가 반복해도 소유권과 transform이 정상화되는지 확인한다.
- `check:yard`
  - `yard-layout.js`의 순수 위치 계약을 실제 flora renderer와 함께 번들해 5개 규모 × 3개 seed의 최종 마당나무를 검사한다. 부속채·낟가리·빨래줄은 수관, 낮은 장독대·텃밭·정원석은 줄기 밑동 반경으로 피하며 자연스러운 수관 돌출은 허용한다.
  - Issue #17에서 확인된 `hamlet:7:p0` 장독대 관통점과 `hanyang:7`의 같은 부속채 local footprint를 고정 회귀로 둔다. 한양 fixture는 일조 배치로 필지 ID가 이동해도 그 footprint와 과실수를 함께 가진 집을 의미로 찾아, 안전한 다른 슬롯으로 이동한 뒤의 나무 수와 반복 결정론을 확인한다.
- `check:parcel-rebuild`
  - hamlet/village/town의 81개 재건축에서 같은 seed 결과, 불변 원본 envelope, 누적 축소 없음, 실제 처마 fit, 남향·도로 접근·일조 계약을 검사한다.
  - 정자의 실제 지붕이 재건축 뒤의 `solarAccess`나 갱신된 `planParcelFocus()` 화면 폭을 가리면 후보를 거부한다.
  - 실제 마당나무가 있는 필지를 골라 모든 마당 hard object와 확장된 편집 처마를 커밋하고, 동일 seed flora 결과·충돌 0·소유자 anchor 변화와 dispose를 검사한다. 빈 수목 fixture만으로 통과할 수 없다.
  - 앱 게이트는 여섯 개구부 축의 부분 patch가 이전 commit을 보존하고, 명시적 종류 변경은 대상 기본값에서 시작하며 집 재굴림은 종류만 유지하는지 확인한다. 지붕만 바꾼 commit과 재굴림은 compact URL에 거짓으로 직렬화하지 않는다.
- `check:live-edit`
  - 50개 동시 입력이 한 preview로 병합되고, 빠른 재생성은 32ms 하한을 쓰며 cooldown 중 최신 값이 유실되지 않는지 검사한다.
  - commit이 대기 preview를 폐기해 정확히 한 번만 실행되고, focus epoch 취소 뒤 이미 dequeue된 callback도 다른 필지에 적용되지 않으며 dispose 뒤 입력을 거부하는지 검사한다.
- `check:lod`
  - 부감 46° 광각, 필지 20°·hero 18°·궁 24°·사찰 26° 망원과 보상 dolly가 피사체 화면 크기를 보존하고, 생활·입자 LOD 및 point sprite 크기를 바꾸지 않는지 검사.
  - 모든 한양 주택 청크의 `FAR ↔ MID ↔ FULL` 거리 경계와 양방향 히스테리시스, 3D 대지 거리, 공간 분할을 검사.
  - 카메라 절대 Y가 아닌 시선 셀의 지형 상대 고도로 근접 생활·입자 weight와 `FAR/MID/NEAR` 활성화를 결정하는지 검사.
  - 필지마다 원경 mass·중거리 envelope·전체 인스턴스·선택 overlay 중 정확히 한 표현만 보이고 집·담·mass 은닉이 함께 전환되는지 검사.
  - 원경 mass가 실제 variant 치수에서 초가 우진각과 기와 ㅡ·ㄱ 좌우·ㄷ 지붕을 파생하고, 역할별 실제 팔레트와 기단을 유지하는지 검사.
- `check:lod:app`
  - Hanyang 337개 일반 필지를 실제 앱 루트에서 focus-in/hop/out하며 매 프레임 표현 배타성을 검사.
  - 선택 필지의 base flock UUID가 근경 wake·필지 hop·원경 sleep 전체에서 같고, 같은 필지 focus ring에 두 번째 닭 무리가 없는지 검사.
  - 규모 wave의 old/incoming 장면 환경 동기, 고정 조명 풀, 입력 잠금, pending build 이탈 후 stale promotion·scene-direct 잔여 0을 검사.
- `check:citywall`
  - 79개 contour(R=74/128/176/250/400/440/500, 64-seed 순환 + 실제 실패 seed)에서 `+z=남`, 폐합, 자기교차 없음, world-edge 내부를 검사.
  - 사대문 위치·외향 normal·성문 구멍이 같은 contour sampler와 일치하며, 육축은 고밀도 지형 표본에 묻히되 18.5m 물리 상한을 넘지 않는지 검사.
  - 화면과 같은 terrain-grid 삼각면으로 벽·여장·육축 표고를 검사하고, 몸체–여장 접합 높이, 길이·곡률 오차 예산, cyclic miter 이음과 성문 구간 비움을 검사.
  - 성문 연결로의 법선 정렬·개구 유효폭·35° 이하 곡률 전환을 검사한다. 도로 ribbon/join은 계획선을 바꾸지 않고 실제 terrain 삼각형에 clip되며, 모든 footprint가 외곽 warp 이전 영역에 남고 내부 표본이 지형을 관통하지 않아야 한다.
  - 실제 한양 plan의 일반 필지·시전·도로는 성 안, 위성 부락은 성 밖, 모든 필지는 지형 안인지 검사.
  - 외부 남문길은 성곽을 한 번만 통과하고 실제 개울 교차점의 다리와 이어지며, 위성 부락·수목·바위·보호수 수관이 사대문 진입 corridor를 막지 않는지 검사.
  - 강제 성곽을 켠 hamlet/village/town/capital, 성곽을 끈 Hanyang도 필지 경계·도로 문법·반복 결정론을 유지하는지 검사한다. 호수를 1채로 낮춘 전 tier의 개울/건천 조합도 성곽에 필요한 최소 지형 span을 예약해 생성 예외 없이 wall을 유지해야 한다.
  - 보호수는 hamlet/village 1주, town 2주, capital/hanyang 3주의 필수 역할을 실제 수관 여유로 배치한다. 안전한 빈터가 끝내 없으면 충돌하거나 조용히 누락하지 않고 명시적으로 실패한다.
- `check:choga-roof`
  - 지붕의 둥근사각 평면 좌표와 역변환이 같은 높이를 내는지 검사.
  - 기본형, 세 가지 마을 변형, 앱 편집 UI 32개 경계 행렬, standalone GUI 최대형과 96개 고정-seed 파라미터 조합을 검사.
  - 벽선과 실제 Float32 지붕 삼각 edge의 교차점 사이까지 조밀하게 확인해 정점 사이 관통도 차단.
  - 벽 상단은 이엉 표면 아래 안전 피복을 유지하며, 기본 지붕 vertex hash는 불변.
- `check:roof-seams`
  - 정규 기와집 편집 UI의 ㄱ 평면 치수·물매 243개 경계 조합, 일반 주택 ㅡ·4칸 ㄷ production fixture, 종가 ㅡ·ㄱ·ㄷ 평면(2~4칸)의 모든 face 상단 체인을 검사.
  - 기존 균등 sampler가 기본·경계 기와집에서 이음새 오차를 재현하는지 먼저 확인한 뒤, 원래 ridge junction·진행 순서 보존을 단언.
  - Vite로 앱의 단일 three를 불러 실제 production Float32 geometry 1,458개 face를 만들고, junction 오차와 face당 135정점·672 index 예산 불변을 함께 검사.
- `check:verification-plan`
  - docs-only와 DoF/weather/village/wave/audio/app 변경의 영향 합집합을 검사한다.
  - 중복 경로를 제거하고 unknown·unsafe path·base 실패가 full로 닫히는지 검사한다.

plan 기준값은 `tools/plan-contract.json`에 있다. 의도된 기능 변경도 실제 데이터 diff를 검토한 뒤 fixture를 갱신한다. 사찰 터 변경에서는 temple ON 사례만 변할 수 있다.

### `npm run check:temple:browser`

`temple.html`을 독립 정적 서버에서 열어 `src/api/temple.js`의 세 변형을 실제 WebGL로 조립한다.

- 실제 렌더 bounds가 마을이 예약한 경내와 2.5m 처마·담장 여유 안에 있는지 검사한다.
- 카메라가 남측 `frontDir` 접근 공간에서 26° 망원으로 보는지 검사한다.
- `disposeTempleCompound()`의 성공·멱등성, 호출자 palette 보존, 자체 palette와 geometry 해제를 검사한다.
- raw와 부감 merge의 삼각형·semantic count 동등성을 확인하고, merge가 draw call을 85% 이상 줄이며 모든 변형을 140콜 이하로 유지하는지 검사한다.

`temple.html?variant=compact|courtyard|extended`는 같은 모듈을 사람이 회전해 보는 영구 하네스다. `shot=1`, `debug=1`, `probe=1`, `merged=1`을 조합할 수 있다.

### `npm run check:surface:browser`

`tools/surface-materials-harness.html`의 같은 도로를 고정 카메라에서 OFF/ON으로 렌더하고 PNG를 OS 임시 폴더에 쓴다. draw call·triangle·material +0, texture +2, shader program family 최대 +1, 평균 명도 변화 3% 이내를 확인한다. half-tile 상관과 wrap 경계, 0.012m 카메라 평행 이동 전후 차이로 반복·seam·shimmer를 제한하고, 네 번 생성/해제 texture plateau와 실제 glTF JSON의 DataTexture albedo image도 검사한다. Chrome 기준 약 3–4초의 좁은 게이트라 `check:all`에 포함하며 surface/road 경로는 `check:pr`에서도 이를 선택한다.

### `npm run check:app`

`tools/check-app-smoke.mjs`는 임시 cache와 포트로 실제 Svelte/Vite 앱을 부팅해 다음을 확인한다.

- URL seed/scale이 plan에 도달하고 village scene과 canvas가 생성된다.
- 마을 둘러보기·집 보기의 화면 등가 줌 범위와 near plane 값이 유효하다.
- 집 보기 최소 거리가 착지 구도의 42%를 유지해 최대 줌인에서도 카메라가 건물 내부로 들어가지 않는다.
- 둘러보기에서 예전 자동 진입 임계보다 가까이 줌해도 집이 선택되지 않고, 집 보기에서 예전 자동 복귀 임계보다
  멀리 줌아웃해도 선택이 유지된다. 이때 근경 DoF weight는 0으로 내려가며, 명시적 focus/return만 상태를
  바꾸고 UI는 `둘러보기`/`집 보기`로 읽힌다. 같은 줌아웃에서 카메라 고도가 29° 이상으로 크레인 업해
  남측 일조축의 정자·높은 공공 오브젝트가 만드는 전경 차폐를 넘는다. 직접 마을 URL의 실제 집 보기 버튼도 단일건물 씬으로 나가지 않고 종가
  focus를 시작한다.
- 명명된 drone path 시작·중단과 walker 초기화가 된다.
- hero parcel과 focus detail overlay가 공개 앱 API로 연결된다.
- 실제 화면에 보이는 주거 초가 primary 문만 hover/click할 수 있고, 숨은 LOD/조립 조상이나 layer가 다른 owner는 target/occluder가 아니다. 보이는 담·다른 채가 뒤쪽 문을 가리면 통과 선택하지 않으며, 같은 문을 누른 중간 반전은 pose가 튀지 않고 drag는 열림으로 오인되지 않는다. focus-out·재건축은 닫힌 상태와 pivot 수명을 복원한다. 실제 capital 궁·사찰 focus와 town의 `heroStyle: 'palace'` 관아 focus에는 runtime·screen target·pivot이 생기지 않지만, `heroStyle: 'hanok'` 종가에는 그대로 생긴다.
- 시간·계절·날씨 setter 호출 중 browser error가 없다.
- 환경 OFF/종료가 Texture 배경과 FogExp2의 객체·타입·정밀한 조명 값을 원상 복원한다.
- full-app pass가 `Render → Grade/Rim → Bloom → Bokeh → Flare → Outline → Output` 순서이며 Output이 마지막이다.
- 단일 건물 타입 변경이 공용 카메라 framing 경로를 사용해 예외 없이 완료된다.
- 확장 ghost가 실제 merge와 같은 순수 배치를 쓰고 숨은 canvas/건물 생성을 하지 않는다.
- `disposeBuilding()`이 주입된 `P.mats`를 보존하며, 보이는 초가를 6회 재생성해도 GPU texture 수가 plateau를 유지한다.
- 민가 정자살·세살 텍스처가 궁궐의 주칠·뇌록 팔레트를 재사용하지 않고, 합성 팔작 사찰에는 궁궐 전용 잡상·취두가 없으며 궁에는 유지되는지 실제 Canvas와 production building으로 검사한다.
- 실제 낙관을 눌러 고증 감사에 쓴 부엌·구들, 궁궐 지붕 장식, 창호 철물, 짚신·나막신 출처 묶음의 적용 문구와 원문 링크, 안전한 외부 링크 속성이 Reference UI에 렌더되는지 확인한다. 창호 항목은 정적 민가·사찰 철물 어휘와 선택 FULL 주거만의 inward jamb-edge pivot 적용, 관아·궁·사찰 compound 제외, 열림 각도·감쇠가 실측 복원이 아닌 제품 결정임을 함께 보여야 한다. 신발 항목은 네 canonical URL과 라이선스 문구, 맑음/비 조건의 적용 범위를 실제 파싱 결과로 확인한다.
- 엔진 종료가 환경의 geometry/material/texture를 정확히 한 번씩 해제하고 environment group을 scene에서 분리한다.
- `engine.dispose()`를 두 번 호출해도 안전하고 canvas와 엔진 소유 debug hook(`__season` 포함)이 남지 않는다.

### `npm run check:ink:app`

`tools/check-ink-app.mjs`는 같은 실제 앱 부팅에서 PBR 부감, 완전 수묵 부감, 일반 한옥의 20° 망원 수묵 근경을 비교한다.

- 기본 PBR에서는 종이 texture와 normal target을 만들지 않고 `mode` URL 토큰도 쓰지 않는지 확인한다.
- 실제 낙관을 눌러 Reference 모달을 열고 국립중앙박물관·Met·국가유산포털의 자료명, 수묵 활용 기준, 라이선스, 안전한 원문 링크가 렌더되는지 확인한다.
- native Enter/Space 조작, 두 버튼의 `aria-pressed`, 엔진 상태, `?mode=ink` 공유 URL과 새로고침 복원이 하나의 상태를 가리키는지 검사한다.
- 전환 mix가 단조롭고 축소 raw-beauty copy가 Render 바로 뒤, Ink가 단일 `OutputPass` 바로 앞에 있으며, 완전 수묵에서 grade·bloom·Bokeh·flare가 모두 휴면하는지 검사한다.
- 부감과 DoF·림·플레어가 있는 근경에서 같은 시뮬레이션 상태를 framebuffer로 두 번 읽어, PBR pass sleep 전후 평균 차이 0.05 이하·최대 채널 차이 1 이하인지 검사한다.
- shader program 증가는 raw-copy shader를 포함해 6 이하, 축소 normal pass의 draw call은 원 장면 이하로 제한하고, 장식·대기 객체가 가짜 깊이를 만들지 않는지 확인한다. PBR 복귀 후 beauty capture count가 더 늘지 않아야 한다.
- 수묵 화면이 충분히 탈색되면서 농묵·중간톤·밝은 한지 여백을 함께 보존하는지 픽셀 통계로 검사한다.
- 390×844 모바일에서 컨트롤이 화면 안의 44px target을 유지하고 shader/runtime 오류가 없는지 확인한다.

비교 PNG는 OS 임시 폴더에만 남긴다. 부감은 산세·안개 여백과 전경 수목의 선 밀도를, 근경은 처마·초가지붕의 선 계층과 건축 가독성을 직접 확인한다.

### `npm run check:parcel-rebuild:browser`

`tools/check-parcel-rebuild-browser.mjs`는 실제 과실수가 있고 정자에 가까운 일반 필지를 격리 Vite 앱에서 선택한다.

- 집 푸터가 `이 집 다시 짓기`와 `내보내기` 두 동작만 제공하고 “다시 보기”·“GLB” 레거시 문구가 없는지 검사한다.
- 실제 처마 range에 48개 `input`을 한 task에서 보내 숫자와 처마 footprint가 change 전에 최신값으로 보이되 지오메트리 preview는 1회, flora identity는 그대로인지 검사한다. `change` 뒤에는 flora batch가 정확히 한 번 교체되고, 대기 input 직후 focus-out해도 stale rebuild가 없으며 재진입 값은 마지막 commit으로 복원돼야 한다.
- 실제 버튼을 눌러 마을 seed를 바꾸지 않은 채 필지 경계·집·마당·수목이 새 seed로 커밋되는지 확인한다.
- 편집 처마·마당 hard object·일조/시선에 대한 수목 충돌이 0이고 flora가 여전히 단일 병합 group/layer 예산을 지키는지 검사한다.
- 실제 카메라가 갱신된 남측 계획과 일치하며 정자 지붕이 일조 통로나 XZ 시선을 가리지 않는지 확인한다.
- focus-out과 재진입 뒤에도 오버레이·편집 spec·rebuild seed가 유지되고 FAR/MID/FULL/overlay 중 하나만 보이는지 검사한다.
- headless wall time 대신 shader program delta와 draw-call delta를 제한하고, 전/후/focus-out PNG는 OS 임시 폴더에 남겨 직접 확인한다.

### `npm run check:dof:app`

`tools/check-dof-app.mjs`는 격리된 실제 Vite 앱에서 제품의 focus tween을 직접 표본화한다.

- 부감 46° 광각에서 필지 20° 망원으로 화각이 단조롭게 전환되고, focus-out은 반대로 복귀한다.
- focus-in/out, 장거리 필지 hop, 전환 중 반전에서 초점이 현재 시선의 카메라 축 깊이를 따라가며 aperture가 overshoot나 잔여 없이 변한다.
- 실제 Bokeh 프레임 한 장에서 파티클·선·sprite·비깊이 재질을 제외하고, `instFade` 수목은 color pass와 같은 dither 구멍을 유지한다.
- 깊이 패스 뒤 가시성, 원래 material, `scene.overrideMaterial`, 배경이 모두 복원되며 하늘은 가짜 깊이를 만들지 않는다.
- 근경 보케가 고정 41-tap 원형 HDR kernel 하나를 사용하고 browser error가 없는지 검사한다.

이 게이트는 headless shader link 비용 때문에 `check:all`에 포함하지 않고 DoF·카메라·post 변경에서 별도로 실행한다. 절대 소요 시간은 성능 수치로 사용하지 않는다.

### `npm run check:environment`와 `npm run check:winter:app`

`tools/check-environment-state.mjs`는 Three와 DOM 없이 봄·여름·가을·겨울과 맑음·비·눈의 호환 행렬을 검사한다. 계절 변경은 호환되지 않는 날씨를 맑음으로 돌리고, 날씨 변경의 눈은 겨울로, 겨울의 비는 봄비로 이동한다. seed와 환경 다이얼은 이 순수 상태와 가중 장면 목록을 공유한다.

`tools/check-winter-app.mjs`는 실제 Vite 앱에서 맑은 겨울과 설경을 비교한다. 지붕·지형·식생·외부 소품이 하나의 적설 시계를 소비하고, 새 geometry 경로 없이 draw call 증가 1 이하와 shader program 증가 24 이하를 지키는지 검사한다. 눈 화면은 맑은 겨울보다 밝되 평균 휘도가 210 미만이어야 하며, shader/runtime 오류와 비·눈 상태 불일치가 없어야 한다. PNG는 OS 임시 폴더에만 남긴다.

### `npm run shoot:sky`

`tools/shoot-sky-atmosphere.mjs`는 실제 Vite 앱에서 일반 필지를 제품 focus 경로로 선택한 뒤 tween을 결정적으로 끝내고 낮·금빛/홍빛/보랏빛 석양·밤을 한 번의 browser boot로 촬영한다.

- scene-level sky가 마을 모드에서도 남고 dome이 근경 카메라를 따라가는지 검사한다.
- 정확한 16° 카메라 고도에서 1.65–2.5m 문 높이 target을 바라보고 별도 하늘 편향 없이 전경 마당을 화면에 남기는지 검사한다.
- 이 마당 우선 구도에서는 원경 구름 bank나 달이 기본 프레임 밖으로 나갈 수 있다. 구름 bank가 투영되지 않으면 픽셀 기여가 없어야 하고, 달·구름 전용 프레임에서 scene-level 대기 수명과 실제 픽셀을 별도로 검사한다.
- 원경 구름 16개가 한 draw call이고 실제 픽셀을 만들며, 상공 구름과 같은 태양 상태로 rim·빛줄기·지면 그림자를 내는지 검사한다.
- 세 석양 이미지가 실제로 구분되고 낮에는 저고도 rim/광선이 꺼지는지 검사한다.
- 밤에는 달과 구름을 같은 프레임에 둘 수 있고, 근접한 그림자용 billboard가 망원 하늘을 덮지 않으며 달빛 그림자가 낮보다 약한지 검사한다.
- 전체 town 장면 draw call이 1,000 미만이고 browser error가 없는지 검사한다.

PNG는 OS 임시 폴더에 남긴다. 하늘·구름·focus composition 변경에서는 수치 PASS만 보지 말고 금빛 석양과 달 프레임을 직접 연다.

### `npm run shoot:focus-level`

`tools/shoot-focus-level.mjs`는 격리된 실제 Vite 앱에서 기와집·초가·종가·관아형 hero·궁·사찰을 차례로 선택한다. 제품과 같은 카메라 트윈 적용기를 결정적으로 끝내므로 각 1.9초 전환을 기다리지 않으며, 다음을 수치와 PNG로 함께 확인한다.

- 일반 주택과 종가의 화면 중심은 지붕 높이가 아닌 1.65–2.5m 문 높이 범위를 조준하고, 안전 가시성 dolly 뒤에도 카메라는 그 target을 향한 정확한 16° 고도를 유지한다.
- 종가 landing과 직접 `집 보기`는 정면 표식, 열린 마당 표본, focus 닭 ray, 대문·등롱이 실제 프레임 안에 남는지 검사한다. focus ring은 실시간 1.8초를 기다리지 않고 `debugAdvanceFocusRing(3.2)`로 결정적으로 정착시키며, 닭 ON/OFF pure-canvas 비교가 100픽셀 이상 달라야 한다.
- 일반 기와·초가의 semantic 마당 소품은 카메라 광선의 첫 메시로 실제 노출되는지, 적어도 한 대표 주거의 focus 동물이 pure-canvas 픽셀을 만드는지 검사한다. 관아형 hero는 같은 ring lifecycle을 쓰더라도 주거용 안마당 닭을 만들지 않아야 한다.
- 일반 주택의 카메라 XZ 시선이 계획된 남측 `solarAccess` 개방부 안을 지나고, 정자가 집의 문·처마가 들어오는 화면 폭을 가리지 않는다.
- 궁과 사찰은 각각 지면 위 3.2m, 3m를 조준한다.
- 계획된 프레이밍과 실제 `OrbitControls.target`이 일치한다.
- 사찰을 암자형↔다원형으로 편집하면 전각·기념물 기본값과 패널 spec이 함께 바뀌고 실제 overlay bounds도 20m 이상 달라지는지 검사한다.
- 여섯 구도에서 앞집 지붕·산·패널에 선택 건물이 과도하게 가려지지 않는지 사람이 직접 확인한다.

PNG는 `shots/`를 오염시키지 않고 로그에 출력된 OS 임시 폴더에 저장한다. 카메라 조준·화각·선택 구도를 바꿀 때 `check:lod`, `check:worker`와 함께 실행한다.

### `npm run check:lod:focus`와 `npm run check:wave:app`

`tools/check-lod-app.mjs`는 같은 구현을 `--scenario=focus|wave|full`로 나눈다. 기본 `full`은 기존 Hanyang focus/hop/out 뒤 Hanyang→town 실제 연속-frame wave를 모두 유지한다.

- `focus`: Hanyang의 모든 일반 필지 표현, hero/일반 필지 focus·hop·out, stable flock identity와 FAR/MID/FULL을 검증한다.
- `wave`: 더 작은 town→village 제품 경로에서 근경 wake부터 부감 sleep, old/incoming ambient ownership, 환경 동기, 고정 조명 pool, 실제 wave 종료, pending solo build 취소와 stale promotion 방지를 검증한다.
- `full`: 두 시나리오를 한 browser/page에서 이어 실행해 merge gate의 Hanyang 연속-frame 범위를 보존한다.

wave 관련 반복 수정은 `check:wave`와 `check:wave:app`으로 빠르게 확인하고, merge 전 `check:full`에서 Hanyang 범위를 한 번 더 확인한다.

### `npm run check:audio`

`tools/check-audio.mjs`는 실제 Web Audio 노드의 `start/stop`, `connect/disconnect`를 계측한다. 종료 시 모든 시작 소스와 연결 노드가 짝을 이루어 정리되고, 이중 `dispose()`와 종료 후 public API 호출이 새 오디오 그래프를 만들지 않는지 확인한다. 오프라인 종·개울 합성의 RMS도 검사해 무음 회귀를 막는다.

Headless ANGLE은 shader link 중 render frame이 매우 느릴 수 있다. 따라서 이 빠른 smoke는 1.9초 tween이 wall clock 1.9초 안에 끝난다고 단언하지 않고, 동기 상태 설정과 유한한 계약값을 검사한다. 타임아웃 진단이 필요하면 `CHEOMA_APP_SMOKE_TIMEOUT_MS`를 임시로 낮출 수 있다.

### `npm run check:worker`

`tools/check-worker-contract.mjs`는 실제 module Worker가 동작하는 임시 Vite 서버를 만들고 village/town/capital/hanyang에서 다음을 비교한다.

- 동기 `createVillage`.
- `createVillageAsync` 실제 Worker 경로.
- `createVillageAsync`의 `?worker=0` fallback.
- 전체 scene graph 구조, geometry, instance buffer, 기본 material hash.
- pick proxy bbox·center·dims·spec·framing hash.
- 단건 `getPickProxy(id)`와 전체 descriptor의 동일성, 없는 ID의 `null`, 반환 Box/Vector의 방어 복제.
- `VillageHandle.dispose()`가 sync/async 각각의 소유 자원을 정확히 한 번 해제하고 모듈 공유 재질은 보존하며, 이중 종료와 종료 후 재진입·detail/debug API가 불활성인지 확인한다.
- `populateVillageSteps` label과 순서.
- 실제 Worker 생성 수와 성공 메시지 수.

현재 골든 scene/proxy hash는 도구 안에 명시돼 있다. sync/async끼리 같더라도 골든과 다르면 실패한다. 이 값은 구조 이동 때 갱신하지 않는다.

## 문법과 API 번들

변경 파일의 빠른 문법 검사는 esbuild를 사용한다.

```bash
npx esbuild src/village/plan.js --bundle --format=esm --outfile=/dev/null
```

루트에는 `three`가 없고 앱에만 설치돼 있으므로 전체 공개 façade만 확인할 때는 peer 의존으로 제외한다.

```bash
npx esbuild src/api/index.js --bundle --format=esm \
  --external:three '--external:three/*' --outfile=/dev/null
```

이 검사는 export 충돌과 문법을 확인하지만 browser runtime을 대신하지 않는다.

## 도메인 하네스

가장 가까운 `tools/*.mjs`를 plain `node`로 실행한다. 각 도구의 주석과 실제 구현을 먼저 읽고 범위를 과대평가하지 않는다.

| 도구 | 현재 용도 | 한계 |
| --- | --- | --- |
| `tools/check-determinism.mjs` | 일부 plan 반복성 보조 검사 | worker·forest·temple 전체 계약이 아니다. |
| `tools/verify-solo-app.mjs` | 외딴집·절 단독 populate와 browser error | 전체 앱·worker 검사가 아니다. |
| `tools/check-cinematic-turns.mjs` | 브라우저 없이 ±π 최단각, 각속도·각가속도, 주도로 시작점, 합성 막다른 길 반복 왕복 | 실제 마을 지형과 앱 카메라 배선은 확인하지 않는다. |
| `tools/check-cinematic-reveal.mjs` | Three 없이 arrival/rebuild의 seed 결정론, 정확한 양 끝점, 0 끝점 속도, 최대 시선 회전, compact/reduced-motion, solar-opening 안전 구도의 결정론·카메라 고도·망원 보상, fitted 처마/계획 공공 소품 blocker, 막힌 기존점의 hysteresis 배제 | 실제 OrbitControls·DoF·조립은 확인하지 않는다. |
| `tools/check-cinematic-reveal-app.mjs` | 실제 Hero 버튼과 focus 집 재생성에서 연속/전후 PNG, 실제 fitted 지붕·계획 feature 가시성 개선, 일반 focus와 final 동일성, target/lookAt, DoF, program plateau, camera-inside-blocker 거부, pointer/key exact handoff와 같은 wheel 이벤트의 실제 dolly, 모바일·reduced-motion | 모든 seed의 미학을 대신하지 않으며 고정 제품 fixture를 검사한다. |
| `tools/verify-cine.mjs` | 세 규모 drone path와 walker 100초 수학·결정론 | 앱 배선은 확인하지 않는다. |
| `tools/verify-cinewire.mjs` | 앱 패스 경계 시선 상한·시네마틱·GLB·focus 장시간 배선 | 전용 production outDir를 먼저 만들어야 하고 headless에서 오래 걸린다. |
| `tools/check-audio.mjs` | 합성음 RMS, 시간·날씨·BGM 배선, source/node teardown | 공유 `AudioContext` 자체는 닫지 않으며 시작/정지·연결/해제 identity를 비교한다. |
| `tools/check-dof.mjs` | 축방향 초점, 단일 DoF controller, 깊이 기여 분류, 고정 41-tap 원형 kernel의 순수 계약 | 실제 depth prepass와 전환 배선은 앱 게이트가 맡는다. |
| `tools/check-dof-app.mjs` | 실제 광각↔망원 focus/hop/reversal과 StableBokeh 깊이 제외·상태 복원 | Bokeh 실제 렌더는 한 프레임만 수행하며 미감 판정을 대신하지 않는다. |
| `tools/check-road-contract.mjs` | stable ID·junction 양방향 참조, 자기교차·좁은 lens, 곡률, road spatial index | 지형·재질에서 길이 자연스럽게 읽히는지는 시각 하네스로 본다. |
| `tools/check-layout-contract.mjs` | 남향 군집·도로측 대문·실제 지붕 fit·단건 재굴림·도로/개울/논·집 사이 겨울 일조·정자 실면적/화면 폭·높이 있는 마을 소품·보호수·밀도 계약 | 대표 seed 순수 데이터 검사로, 실제 광학적 차폐 미감은 앱 캡처로 확인한다. |
| `tools/check-wall-gate-contract.mjs` | 6종 담과 hero의 도로측 대문 중심·회전·finite geometry | Node에서 실제 담 생성기를 bundle하며, 완성 화면의 미감은 보지 않는다. |
| `tools/check-yard-layout-contract.mjs` | 마당나무와 부속채·장독대·낟가리·빨래줄·텃밭·정원석의 의미별 footprint, 장독대/부속채 충돌 재현, 수목 유지율 | 실제 수관/밑동의 XZ 계약이며 계절별 가지 실루엣의 미감은 focus 이미지로 본다. |
| `tools/check-parcel-rebuild-contract.mjs` | 불변 필지 envelope, 재건축 결정론, 정자 일조/카메라, 실제 편집 처마와 마당 수목 재배치 | renderer/DOM 없이 실행하며 UI·부감 지속 소유권은 앱 게이트가 맡는다. |
| `tools/check-live-edit-scheduler.mjs` | 50→1 최신값 병합, 재생성 비용 기반 cooldown, commit 우선권, focus epoch 취소·dispose | DOM/THREE 없는 순수 케이던스이며 실제 slider·지오 변화는 공유 앱 게이트가 맡는다. |
| `tools/check-shader-warm.mjs` | GPU program polling 중 해제된 material 회수, 살아 있는 program 완료 대기, compile 실패 no-op | 실제 WebGL 경합은 `verify-panels.mjs`의 빠른 hero focus-out/리롤 pageerror 0으로 보완한다. |
| `tools/check-parcel-rebuild-browser.mjs` | 실제 range preview/commit/취소, 여섯 개구부 축의 부분 patch·종류 변경·재굴림, 두 버튼, 재건축 commit, 남측 카메라, 정자 clearance, flora batch, focus-out 지속 LOD, program/draw-call delta | seed 7의 대표 과실수 필지 한 건이며 전체 규모/seed 수학은 순수 게이트가 맡는다. |
| `tools/check-residential-edit-url.mjs` | stable sort된 compact `vedit` v1 왕복·기본 URL 생략·8필지/768자 상한·malformed fail-closed | renderer 없는 codec 계약이며 실제 commit/reload는 browser 게이트가 맡는다. |
| `tools/check-residential-edit-url-browser.mjs` | 실제 여섯 축 commit→URL→reload→focus geometry 복원과 malformed payload 전부 거부 | 대표 p2 한 필지이며 모든 seed의 배치 미감은 대신하지 않는다. |
| `tools/shoot-layout-solar.mjs` | 실제 앱의 부감·공중·기와/초가 focus, `frontDir`·`solarAccess`·보호수 overlay와 가림 진단 | seed·규모·시간·계절·날씨를 `CHEOMA_LAYOUT_*`로 고정한다. `CHEOMA_LAYOUT_SCENE=parcel`과 `CHEOMA_LAYOUT_PARCEL=p254`처럼 정확한 필지도 재현하며 PNG는 OS 임시 폴더에 쓴다. |
| `tools/shoot-dof.mjs` | 고정 seed의 가을 석양 기와집과 여름밤 초가를 정지시켜 DoF OFF/강도별 PNG 생성 | 결과는 OS 임시 폴더에 쓰며 보케 원형, 광원 분리, 피사체 가림을 직접 판정한다. |
| `tools/shoot-bokeh-fixture.mjs` | 실제 composer 위 제어 HDR 광원의 원형비, 반복 픽셀 동일성, 8단계 저속 패닝을 계측·촬영 | 중앙 depth gather 때문에 초점면 불투명 표면과 겹친 전경 광원은 퍼지지 않는 한계를 별도 probe로 기록한다. |
| `tools/check-choga-roof.mjs` | 초가 지붕/벽 접합, 변형·편집 극값, 지붕 vertex hash | 재질·조명 미감은 `shoot-thatch.mjs` 전후 이미지를 직접 본다. |
| `tools/check-roof-seams.mjs` | 기와지붕 face 상단의 ridge knot 보존, UI 평면·칸수·높이 경계 | 마루장 아래의 실제 음영·미감은 `shoot-cg3.mjs` 근접 앵글로 본다. |
| `tools/check-building-clearance.mjs` | 기초 매입, 마당 lift, ㄱ자 기단 단일 depth owner, 판벽 봉창 face clearance, 맞배 벽 tuck, 기와/초가 공유 부엌 개구와 돌출 상한 | 실제 접지선·기단 줄눈·부엌 개구 미감은 기와/초가 격리 하네스와 `layout.html` 필지 4종을 직접 본다. |
| `tools/check-door-motion-contract.mjs` | primary 한 짝 폭·jamb-edge pivot·안쪽 signed angle, 결정적 임계감쇠·중간 반전·dispose | renderer 없는 순수 운동 계약이며 실제 가림·입력·문짝 실루엣은 앱 게이트와 `shoot:door`가 맡는다. |
| `tools/check-door-occlusion-contract.mjs` | 선택 문까지의 유한 semantic grid, ㄱ/ㄷ concavity, 일반/종가 담·문, 정자·소품, 사찰 전각·담·문, 궁장/광화문, 성벽/홍예, 시전, 계절 수관, 회전 commit bounds, 필지/flora refresh, 후보 상한 | forest/scatter 수목 fade, 성문 문루 상부·궁 내부 일곽·사찰 소품, 선택 root 내부 actual surface는 각각 기존 소유자가 담당한다. |
| `tools/shoot-door-interaction.mjs` | 실제 앱의 보이는 주거 primary 문 닫힘/중간/열림을 정면·사선 6장으로 촬영 | `CHEOMA_DOOR_TARGET=giwa\|choga\|hero`로 대상을 고른다. 초가·hero에서는 문틀·고정 짝 유지, 경첩 sweep, 열린 뒤 벽 대신 고정 암부가 보이는지 직접 판정하며 PNG는 OS 임시 폴더에 쓴다. hero는 제품 카메라를 바꾸지 않고 debug opening world frame의 마당 안쪽 검증 시점을 쓴다. |
| `tools/check-citywall.mjs` | 성곽 단일 contour, 실제 terrain-grid에 밀착한 사대문·벽·indexed 도로, gate/parcel/warp 경계 | 재질·산세와의 조화는 `shoot-hanyang.mjs`의 동일 seed 전후 이미지를 직접 본다. |
| `tools/check-lod.mjs` | 주택 FAR/MID/FULL 히스테리시스, 필지 표현 소유권, 시선-셀 생활 디테일의 순수 계약 | 실제 root 가시성·focus/wave 수명은 앱 게이트가 맡는다. |
| `tools/check-lod-app.mjs` | `focus/wave/full` 선택 실행: Hanyang focus/hop/out과 town→village fast wave 또는 Hanyang 전체 연속 흐름 | 빠른 wave가 Hanyang multi-chunk full을 대체하지 않아 merge 전 `check:full`을 유지한다. |
| `tools/check-wave-contract.mjs` | scenery 배타 소유, 공유 재질 불변, 궁 tofu wave, cancel/dispose 멱등성 | 순수 계약으로 먹안개 미감과 실제 shader program 수는 보지 않는다. |
| `tools/shoot-wave.mjs` | 실제 Vite 앱의 고정 progress 전환, 재질/version/cache key 불변, 그림자·program plateau | 기본은 대표 village 한 규모이며 `shoot:wave:full`이 전체 규모를 담당한다. old/new seed·환경·구간은 `CHEOMA_WAVE_*`로 고정한다. |
| `tools/shoot-hanyang.mjs` | 한양 aerial/high/남·동·서·북문/eye/cull과 draw-call·triangle 수 | 절대 frame time은 판단하지 않으며 임시 출력 디렉터리를 명시한다. |
| `tools/shoot-vcritters.mjs` | 근경 소동물 wake·원경 sleep과 새 떼 유지, 대표 컷 | 기본 출력은 OS 임시 디렉터리이며 `CHEOMA_CRITTER_OUT`으로 재지정할 수 있다. |
| `tools/verify-gltf.mjs` | FULL/FAR 카메라 독립 export, scenery·transient focus 제외, commit된 일반집 overlay 포함과 대체 base LOD 제외, GLB 라운드트립·예산 | 기본 출력은 OS 임시 디렉터리이며 `CHEOMA_GLTF_OUT`으로 재지정할 수 있다. |
| `tools/check-rim-facing.mjs` | 실제 WebGL에서 N·V 실루엣, 실제 태양 N·L, V·L 역광, directDiffuse=0·그림자·제품형 비그림자 fill·`receiveShadow=false` 반례, 50% penumbra 비율, 실제 cloud-shadow callback/cache-key 합성, 추가 shadow fetch 0, HDR 에너지 상한, instanceColor·program plateau; `--app`은 시간을 멈춘 최종 16° 석양 focus에서 실제 마을 cloud+rim 지붕과 OFF/ON A/B | 고정 fixture와 대표 실앱 한 장이 모든 seed·재질의 미학을 대신하지 않는다. |
| `tools/verify-rim101.mjs` | 림 재질군 uniform, 제외 규칙, shader 오류, program plateau | 미학적 강도와 색은 이미지 직접 판정이 필요하다. |
| `tools/shoot-flare.mjs` | flare ON/OFF 기여량, 시간·날씨 소멸, 대표 골든아워 컷 | 베이스 씬의 미세 비결정성이 있어 절대 픽셀 동일성보다 ON/OFF 차이와 직접 비교를 본다. |
| `tools/shoot-templesite.mjs` | 사찰 위치·낙차·접근·backdrop·draw call과 이미지 | 동기 populate 경로이며 `mode=old`는 과거 급사면 비교일 뿐 직전 before가 아니다. |
| `tools/shoot-forest.mjs` | 인스턴스 숲 부감·능선·계절 시각 | 사찰 수치와 Worker 일치는 별도 검사한다. |
| `tools/shoot-relief.mjs` | 지형 기복·패드 접지·축대·물 시간대, 한양 대하천 양안·나루 원·근경 | 필지 성토 3m 초과·부유, 직사각 수면 끝, 나루배·포구 취락의 실루엣은 이미지로 직접 판정한다. 사찰 path/mask는 별도 확인한다. |
| `tools/verify-panels.mjs` | 앱 패널의 개울/성곽/논 옵션, wave commit·시드 유지, hero focus-out/리롤 예외 | 먼저 `cd app && npx vite build --outDir dist-panels --emptyOutDir`로 전용 빌드를 만든다. |
| `tools/verify-forest.mjs` | 폐기된 캐노피 쉘 이력 | 현재는 실패 예상이므로 실행하지 않는다. |

## 시각·성능 판정

에이전트는 생성 PNG를 직접 열어 관통, 실루엣, 숲 프레이밍, 길의 연속성을 본다. DoF 변경은 같은 고정 seed·카메라·시간의 정지 프레임에서 OFF/ON을 비교해 피사체가 선명한지, 광원이 원형 보케로 분리되는지, 흐림이 가림이나 깊이 오류를 숨기지 않는지 함께 본다. 수치 통과는 미학적 통과를 대신하지 않는다. 렌더 도구의 임시 파일은 OS 임시 디렉터리를 쓰고 개인 Claude scratch 경로를 하드코딩하지 않는다.

Headless ANGLE은 shader link를 직렬화하므로 절대 frame time을 실제 성능 수치로 인용하지 않는다. program 수 변화, draw call, 결정론 hash, 오류 수를 우선한다. 임시 이미지는 scratch 경로에 두고, 영구 하네스가 명시한 gate 산출물이 아니면 기존 `shots/` 증거를 덮어쓰지 않는다.

## 변경 유형별 최소 매트릭스

| 변경 | 최소 게이트 |
| --- | --- |
| 반복 중 모든 변경 | `npm run check:pr -- --dry-run`, `npm run check:pr` |
| 순수 plan·수학 | 라우터가 선택한 core와 관련 수치 하네스 |
| village generator/runtime/worker | 라우터가 선택한 app/worker, 필요 시 대표 시각 하네스 |
| 앱 engine/UI | 라우터가 선택한 app/build |
| shader/material/post/roof | 라우터 게이트 + program count와 고정 시드 이미지 직접 판정 |
| 건축 고증·공식 자료 반영 | [`architectural-authenticity.md`](architectural-authenticity.md) 체크리스트 + `check:building-clearance` + `check:app` Reference UI + 같은 카메라 전후 PNG |
| 창호 외관·철물·주거 primary 문 상호작용 | [`exterior-detail.md`](exterior-detail.md) + `check:opening-detail` + `check:door-motion` + `check:door-occlusion` + `check:building-clearance` + `check:app`의 실제 visible/layer ray·semantic grid 가림·궁/사찰 제외·hop/rebuild 수명·Reference UI + `CHEOMA_DOOR_TARGET=choga\|hero npm run shoot:door` 정면/사선 PNG·calls/programs/textures |
| 사찰 터 배치 | 아래 사찰 매트릭스 + 머지 전 `check:full` |
| PR 머지 직전 | `npm run check:full` |

## 사찰 터 작업 검증 매트릭스

[`SANSA-HANDOFF.md`](../SANSA-HANDOFF.md)를 구현할 때 최소한 다음을 남긴다.

| 항목 | 규모/경로 | 통과 기준 |
| --- | --- | --- |
| 문법 | 변경한 plan/generator/forest 파일 | esbuild exit 0 |
| 위치 수치 | village, capital 및 추가 seed/scale | footprint 낙차, 실제 road/gate 접근, world/stream/city wall clearance를 브리프와 비교 |
| 시각 | aerial, temple, focus | 관통 없음, 단일 거대 선반·원형 민둥 clearing 없음, 연속 진입로 |
| 성능 | village | render calls < 1000, 진입로 신규 ≤ 2 calls |
| 절 OFF 회귀 | 같은 seed | 기존 base plan golden 불변 |
| 결정론 | sync / Worker / fallback | 전체 scene와 proxy 계약 일치, 의도된 temple 골든만 갱신 |
| 런타임 | 앱과 하네스 | pageerror 0, console-error 0 |

before/after는 같은 코드 경로, seed, `mode=current`로 보관한다. `mode=old`는 과거 급사면 문제를 설명하는 비교 컷에만 쓴다. 산과 숲이 사찰을 둘러싸는지는 미감 보너스이며 통과 필수조건이 아니다.
