// 전체 village scene graph 계약: sync, async worker, async fallback이 같은 결과를 만들어야 한다.
// Vite를 독립 cacheDir로 직접 띄워 실제 module Worker 변환과 메시지 왕복까지 검사한다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-worker-contract-'));
const threeMain = join(ROOT, 'app/node_modules/three/build/three.module.js');
const threeAddons = join(ROOT, 'app/node_modules/three/examples/jsm/');
const html = '<!doctype html><meta charset="utf-8"><title>worker contract</title>';
const expectedSteps = [
  'plan', 'setup+clearance', 'terrain', 'mist+water', 'roads+paddy', 'parcels/houses',
  'features+wall+sijeon', 'merges', 'trees', 'forest', 'flora',
  'animals+night+bloom+cloudshadow',
];
const expectedSceneHashes = {
  // #12: the variable rectangular precinct is reserved before parcels and
  // vegetation, then rendered as the compact/courtyard/extended TemplePlan.
  // #49 extends the solar/focus-frame contract to pavilion eaves and feature
  // props. #13 replaces overlapping rectangular giwa podiums with one concave
  // solid and sinks every building foundation. #21 reserves a monotonically
  // graded stream valley and adds the visible five-lane water ribbon. #40 adds
  // metre-scale settlement relief to every tier; explicit river mode remains a
  // separate non-golden scenario. #56 gives temple roles distinct dancheong
  // palettes; #8 retains four giwa groups but changes their exact geometry to
  // ㅡ + mirrored ㄱ + fitted four-bay ㄷ. #11 replaces duplicated exterior
  // stove masses with one recessed residential kitchen scene and neutralizes
  // civilian lattice textures. #30 adds deterministic world-space road UVs;
  // the texture bytes stay outside this structural hash. #16 adds shared static
  // opening frames, window meoreum aprons, restrained FULL-only hardware, and
  // splits the active primary leaf from the fixed remainder. #10 carries the
  // six residential opening axes through the variant bytes and renders those
  // selected openings in every FULL giwa/choga prototype. Choga and hanok keep
  // a fixed dark recess while residential primary-door and footwear anchors
  // share the same renderer-free opening plan. The reviewed 24° focus elevation
  // and #95's 10° parcel lens lengthen the protected focus corridor while the
  // projected house size stays fixed. Pavilions and public props therefore move
  // only among already-valid planned candidates. The structural byte change is
  // confined to roots downstream of those positions (merged landmarks and the
  // terrain's structure-clearance colour field in the reviewed capital split);
  // houses, roads, paddies, temple, trees, flora, animals, night lights, and bloom
  // stay byte-identical. #81 replaces inferred lot lights with fixed renderer-
  // authored opening anchors. #96 replaces their point sprite with one physical
  // instanced hanji quad batch that carries authored anchor, outward normal, and
  // opening dimensions. The intentional geometry/material/triangle change updates
  // every scale hash while pick proxies remain byte-identical. Front-side rejection,
  // source depth, and the fixed 1+1 draw family are covered by the dedicated lighting
  // gates. #112 splits solid walls on rendered terrain into bounded horizontal
  // steps while preserving flat/soft-boundary output and every pick proxy byte.
  // #122 writes each temple hall's role-ranked roof/bracket/eave/massing grammar
  // and actual eave polygon into the pure plan. Temple meshes and serialized
  // plans therefore change at every scale, while residential geometry and pick
  // proxies remain unchanged.
  // #128 preserves every sijeon placement byte and replaces only the Hanyang
  // market-row meshes with the planned two-bay column/opening/bench grammar.
  // The other scales and all pick proxies therefore remain byte-identical.
  // #131 adds one stable named yard-life group at every scale and, for selected
  // households, texture-free seasonal geometry that is prebuilt but asleep in
  // summer. The reviewed planner reserves every exact seasonal position, clears
  // the rendered solid-wall body plus hard gap, and retains one deterministic
  // safe owner when a sufficiently populated small tier would otherwise select
  // none. Those scene-graph and placement changes update every scale hash while
  // every parcel pick proxy remains exact.
  // #135 replaces only FULL mud-wall body boxes with bounded inward packed-earth
  // surfaces and sparse physical fibre geometry. Existing mud/jipjul materials,
  // wall footprints, parcel transforms, gates, LOD ownership, and every pick
  // proxy remain exact. The geometry bytes and triangle totals therefore change
  // at every scale without changing planning or selection state.
  // #139 adds no scene object to village/town, and adds one bounded physical
  // drainage group only to eligible capital/Hanyang roads. The pure plan owns
  // exact terrain heights and gate crossings; sync, Worker, and fallback consume
  // identical records. Pick proxies and every pre-existing scene subtree remain
  // byte-identical.
  // #144 keeps the existing prototype counts but changes ordinary-house choice
  // and dimensions to a fitted 3/4/5-bay, 0/1/2-connected-wing hierarchy.
  // FULL/MID/FAR consume the same variant geometry, so every scale's residential
  // scene bytes and fitted pick bounds change. Detached FULL-only aux probabilities
  // remain unchanged and are deliberately outside this cross-LOD hierarchy.
  // Sync, real module Worker, and ?worker=0 fallback must still match exactly.
  // #145 moves only the existing choga 창방·장여·도리 vertices into one
  // roof-aware 민도리 stack and removes the unsupported beam overrun beyond the
  // column lines. Object, material, and triangle ownership stay unchanged; the
  // pure and production clearance gates verify the new geometry at every house
  // tier. Pick proxies and all planning bytes remain exact.
  // #146 replaces the old FULL-only wall decoration with one parcel-planned
  // detached building whose exact roof footprint survives FAR/MID/FULL. Every
  // accepted source is merged once by borrowed palette role, so the scene bytes
  // deliberately change while sync, real Worker, and fallback remain identical.
  // #153 removes the pick-box-derived fill/edge resources and keeps one reusable
  // roof-footprint corner marker. Planning and proxy bytes stay exact; only the
  // runtime scene resource topology changes.
  // 룩 복원 Phase 1: 저층 운해 링과 능선 물안개 뱅크의 대기 기하가 바뀌고(링은 방위·표고 종속
  // 두께를 갖고 골에 두껍게 고이며 능선 어깨에서 얇아진다, 뱅크는 원경/중경 2단), 그 위에 주거
  // 근접 렌즈가 10°→16° 로 광각화됐다. 렌즈는 보정 dolly 거리를 96m→≈60m 로 줄이므로
  // `view-clearance.js` 의 focus 시야 corridor 가 짧아지고, 그 corridor 를 피해 배치되는
  //   ① 정자·공공 소품(pavilion-plan / public-props-plan — plan 단계)
  //   ② 식생 마스크(vegetation-spatial makeVegetationMask — populate 단계)
  // 가 함께 움직인다. capital 처럼 plan 바이트가 그대로인 규모도 ②만으로 씬이 바뀐다.
  // 재질·프로그램·필지·건물·도로·논·동물 소유권은 손대지 않았고, 세 경로(sync / 실제 module
  // Worker / ?worker=0 폴백)는 이 재기준 시점에도 서로 바이트 동일했다 — 결정론 손상이 아니라
  // 의도된 씬 변화다.
  // 같은 라운드의 ③: 주거 focus 카메라 자리 숲 배제(`vegetation-spatial.js` FOCUS_EYE_CLEARANCE).
  // 짧아진 dolly 는 사면 필지에서 카메라를 실제로 수관 안에 세울 수 있고(capital/4 p23 실측:
  // 피사체 43m, 가림 나무 6.9m) 그러면 프레임 전체가 저폴리 캐노피 한 장이 된다. 시야 선택기는
  // 지형·건축 blocker 만 보므로 수목은 배치 단계에서 비켜야 한다. 나무 수가 소폭 줄어 삼각형이
  // 함께 줄어들고, 재질·프로그램·필지·건물 소유권은 불변이다.
  // 룩 복원 Phase 3.5(나무 룩 단계 0·1, docs/tree-look.md §5): 식생 프로토 지오메트리와 계절색만
  // 바뀐 재기준이다. 캐노피 어휘를 원뿔·등축구에서 "위도 프로파일로 조각한 20면체 잎덩이"로 바꾸고
  // (구체 노멀 전사 + 재질 flatShading 해제), 계절 팔레트에 고도·그루별 농담 층화를 넣었다.
  //   · 배치 결정론 불변: 크런치는 rng 를 새로 소비하지 않고(t·mosaic 은 기존 자리 그대로) 색만
  //     다르게 계산한다. 프로토 XZ 반경도 FOREST_VISUAL_RADIUS·SCATTER_TREE_VISUAL_RADIUS 안이며,
  //     마당 과실수는 inward 모드로 구 ico 반경 이내에 머물러 수용 집합이 좁아지지 않는다.
  //   · 그래서 네 규모의 pick proxy 바이트는 전부 불변이고(주거·필지·도로·논 소유권 불침해),
  //     바뀐 것은 나무·관목 지오메트리 속성과 instanceColor 버퍼다.
  //   · 재기준 시점에 sync / 실제 module Worker / ?worker=0 폴백 세 경로가 서로 바이트 동일했다
  //     — 결정론 손상이 아니라 의도된 씬 변화다.
  // Phase 4 고증 수정(docs/architectural-authenticity.md §7.5 W1·W2·W3): 재료 판독성만 바꾼 재기준.
  //   ① 막돌 면(담 몸체·토담 굽·사괴석 하단·장독 platform·모서리 기둥)의 UV 를 공유 월드 타일
  //      치수로 환산한다 — 정점 위치·면 수·재질·텍스처는 그대로이고 uv 속성 값만 바뀐다.
  //   ② 초가 담 이엉 coping 의 마루 반경이 내려가고 집줄(M.jipjul, 기존 재질) 링이 걸린다 — 정점이
  //      늘어나므로 삼각형 총계가 함께 오른다.
  //   ③ 한양 시전 개구마다 판문 한 짝(plan 파생 순수값)이 서고, 지붕면이 마을이 이미 가진 공유 기와
  //      캔버스를 재사용하는 재질로 바뀐다 — 시전은 여전히 단일 병합 그룹이다.
  //   plan 은 손대지 않았다: 네 규모의 pick proxy 바이트가 전부 불변이고(placement·필지·도로·논·
  //   yard-life 소유권 불침해), 재기준 시점에 sync / 실제 module Worker / ?worker=0 폴백 세 경로가
  //   서로 바이트 동일했다 — 결정론 손상이 아니라 의도된 씬 변화다.
  // 룩 복원 Phase 2 뒷산 완만화(src/village/site.js SCALE_ANCHORS.ridgeH·mainPeaks): 사용자 지시로
  //   배산 능선 고도를 규모별 −25~−43% 낮추고 봉우리 초과분을 깎았다. 지형 heightfield 가 바뀌므로
  //   지형·숲·기복 패드·필지 앉힘 y 가 전부 따라 움직이는, 의도된 씬 변화다(하늘 밴드 확보 + 역광
  //   실루엣). 지형 반경·숲 밀도·필지 수 분포는 불변이며(시드 8개 평균 town 63.1→63.0), 재기준
  //   시점에 sync / 실제 module Worker / ?worker=0 폴백 세 경로가 서로 바이트 동일했다 — 결정론
  //   손상이 아니다.
  // focus 컷어웨이 식생 동반 은닉(부유 수관 해소): 컷 평면에 걸치는 산 나무 인스턴스를 통째로 빼기
  //   위해 `village-forest` 의 네 InstancedMesh(소나무·활엽·원경 블롭·암괴)에 기존 instFade 어휘의
  //   InstancedBufferAttribute(전부 1.0 = 완전 불투명)를 하나 붙인다. hashThreeGroup 은 지오메트리
  //   속성 이름과 배열 전체를 접으므로 씬 해시가 네 규모 모두 바뀌지만, 오브젝트 수·삼각형 수·
  //   instanceMatrix·instanceColor·재질·pick proxy 바이트는 전부 불변이다(재기준 직전 실측: 이 등록만
  //   끄면 네 규모가 구 골든과 정확히 일치, objects/triangles 동일). 재기준 시점에 sync / 실제 module
  //   Worker / ?worker=0 폴백 세 경로가 서로 바이트 동일했다 — 결정론 손상이 아니라 의도된 씬 변화다.
  //   재기준(2026-07-26, 고증 §7.4-9·-10): 싸리울 살이 자연 가지처럼 높이·굵기·기울기 변주를
  //   받고 가로재가 곧은 레일에서 교대 엮음으로 바뀌었으며(`village/walls.js`), capital·hanyang
  //   대문 건넘 판석이 직각 다듬돌에서 꼭짓점을 안쪽으로 당긴 자연석 윤곽이 됐다
  //   (`village/drainage-geometry.js`) — 네 규모 모두 지오메트리 바이트가 의도적으로 바뀐다.
  //   재기준 직전 실측: 네 규모의 sync 해시와 실제 module Worker 해시가 서로 동일했고
  //   pick proxy 바이트(`expectedProxyHashes`)는 전부 불변이며, snapshot·mja optin fixture 의
  //   sync / Worker / `?worker=0` 폴백 3경로 교차 비교도 PASS 였다 — 결정론 손상이 아니다.
  // 기와집 지붕면 UV 와 수키와 롤이 등파라미터 부채꼴에서 세계좌표 등간격 기왓골로 바뀌어,
  //   ㄱ·ㄷ 평면 giwa 를 포함한 네 규모의 지붕 지오메트리 바이트가 의도적으로 변했다(ㅡ자 단독은
  //   불변). 재기준 직전 실측: 네 규모 모두 worker == `?worker=0` 폴백 바이트 동일, proxy 해시
  //   전부 불변, snapshot·mja 3경로 교차 비교 PASS — 역시 결정론 손상이 아니다.
  // 지면 석재 정합: 디딤돌·댓돌이 지면 아래로 매입되고 기단 상면의 depth owner 가 갑석 하나로
  //   정리되면서(동일평면 5개소 제거) 네 규모의 석재 좌표 바이트가 의도적으로 변했다. 재기준 직전
  //   실측: 네 규모 모두 sync == worker == `?worker=0` 폴백 바이트 동일, proxy 해시 전부 불변
  //   (794d1a99 / c41c0e59 / b652961a / 0f53368a), snapshot·mja 3경로 교차 PASS — 결정론 손상 아님.
  // 종가(hanok) 본채가 podium/columns/walls/roof 이름 그룹으로 묶이면서(조립 애니가 부재 순서로
  //   재생되도록) Group 노드 3개가 추가되고 hashThreeGroup 순회 순서가 바뀐다 — 지오메트리는 불변.
  //   capital 이 그대로인 것이 범위 증거다: capital 히어로는 관아(궁 계열)라 이 변경을 받지 않는다.
  //   재기준 직전 실측: 세 규모 모두 sync == worker == 폴백 바이트 동일, proxy 해시 네 규모 전부 불변
  //   (794d1a99 / c41c0e59 / b652961a / 0f53368a), snapshot·mja 3경로 교차 PASS.
  // 소동물(개·고양이·까치·새 떼) 개체수가 밀도 기반으로 늘고, 관절 애니용 정점 속성(aPivot/aSwing)과
  //   개체별 털색 instanceColor 가 붙어 네 규모의 씬 바이트가 의도적으로 변한다. hashThreeGroup 이
  //   geometry attribute·instanceMatrix·instanceColor 를 접으므로 이 레이어는 해시에 포함된다.
  //   결정론은 온전: proxy 바이트 네 규모 전부 불변, plan 골든 10개 불변, sync = Worker = `?worker=0`
  //   폴백 동일(이 상수를 갱신한 뒤 두 모드 모두 PASS 로 확인). 이 레이어는 finishVillage 이후 붙고
  //   전용 rng 만 소비하므로 seeded 스트림 자체는 건드리지 않는다.
  // 마당 하드 오브젝트가 직사각형 authored 슬롯 대신 실제 필지 폴리곤 ∩ 담 두께 안쪽으로 투영되면서
  //   위치가 바뀌어 네 규모의 씬 바이트가 의도적으로 변했다(수정 전 6494개 중 1456개가 폴리곤 밖,
  //   필지 65%에 걸쳐 최대 3.56m 돌출). **이번에는 proxy 해시도 함께 움직인다** — 통상과 다르며 원인은
  //   확인됐다: `focus-blockers.js#parcelFocusDetailAnchors` 가 근접 카메라 구도 anchor 를
  //   `yardHardObstacles` 위치에서 직접 파생하므로 장독대가 옮겨지면 anchor 와 카메라 해가 함께 옮겨진다.
  //   재기준 직전 실측: 네 규모 모두 worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 3경로 교차 PASS.
  // 필지·마당 규모(#165): LOT_*_SCALE 과 STRUCTURE_SCALE 을 분리하고 농촌 siteR·필지 깊이를 키워
  //   앞마당(멍석 2.1m 하한, L/H 대역)을 회복했다. 필지 배치·지붕 fit·마당 소품·식생·소동물 밀도가
  //   함께 움직이므로 네 규모 씬 바이트와 pick proxy 가 의도적으로 변한다. 재기준 직전 실측:
  //   네 규모 모두 worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 3경로 교차 PASS.
  // 기와 켜 후속(암·수 across 피치 통일 0.34, 물매 UV 호길이, 회첨 튜브 eaveV): 수키와 롤 수·
  //   회첨 튜브 길이·면 UV 가 바뀌어 네 규모 씬 바이트가 의도적으로 변한다. proxy 는 불변
  //   (지붕 fit/필지 배치 무관). 재기준 직전 실측: worker == `?worker=0` 폴백 바이트 동일.
  // #20 운무 절단 + 부감 담장선: edge-mist 표고 제곱 pool·yCap, ridge-mist 2단 앵커 튜닝,
  //   forest-crunch 마을 인접 수관 높이/폭 감쇠와 mtn/infill 밀도 재배치가 숲 인스턴스·운해
  //   지오메트리를 바꾼다. 목표 그루수·plan 시드는 유지. 재기준 직전 실측: 네 규모 모두
  //   sync == worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 3경로 교차 PASS.
  // Perf campaign (2026-07): chunk LOD minSiteR 340→220 so town+capital join the
  //   FAR/MID/FULL stack (hidden MID/FULL roots + impostors change scene bytes).
  //   Hanyang already enabled; village stays single-representation but pick/scene
  //   cohort bytes moved with the same build. 재기준 직전 실측: 네 규모 모두
  //   sync == worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 3경로 교차 PASS.
  // Rafters under skeleton roofs sit a few cm deeper so the DoubleSide tile shell
  // does not share depth with the underside "ceiling" read (assembly z-fighting).
// #211 U1 부감 분지 가장자리: edge-mist thickness/outerDrop/opacity, ridge-mist
  //   opacity, village terrain far vertex-color ramp. Proxy 불변(plan/pick 무관).
  // #217: plan-owned 2–3 gate-crossing slabs (seed-local size/thickness, lower deck).
  //   Only Hanyang golden seed 20260716 emits crossings on the capital/hanyang pair
  //   for this cohort (capital that seed has runs but zero gate crossings).
  //   재기준 직전 실측: 네 규모 모두 sync == worker == `?worker=0` 폴백 바이트 동일.
// #223 회첨골 기와 줄: giwa FULL valley-maru sugiwa course UV. objects/proxy 불변.
  // #218a: Hanyang sijeon plan-owned row breaks every segmentShops; only Hanyang
  //   scene hash moves (breaks are blockers without solid mass). Proxy unchanged.
  // #222 scatter instanceColor 값 층화(docs/tree-look.md §10): 외곽 산포 나무에 forest 와
  //   같은 그루별 곱틴트 버퍼를 붙인다. vertexColors(덩이) × instanceColor(그루). 배치 rng·
  //   매트릭스·밀도·드로우콜 불변 → 네 규모 proxy 바이트 전부 불변. hashThreeGroup 이
  //   instanceColor 를 접으므로 scene 해시만 의도적으로 변한다. forest 절대색 수식은
  //   foliage-value-stratify 로 이설했으나 수치 drift 0. 재기준 직전 실측: 네 규모 모두
  //   worker == `?worker=0` 폴백 바이트 동일, mja·snapshot 3경로 교차 PASS.
  // Roof shell thickness: zero-thickness DoubleSide tile faces co-owned the room-
  //   ceiling plane; each face now has outer FrontSide + offset underside, with
  //   rafters cleared below the shell. Scene geometry/triangle counts change at
  //   every scale; pick proxies stay byte-identical. Assembly moves the roof as
  //   one rigid group (visibility-only chunk stagger).
  // Roof z-fight series (fde574e..2fe0266, release polish): outer tile shells gain
  //   real thickness with FrontSide skins + offset undersides, gaepan rim/shell depth
  //   moves, and rafters clear below the shell — intended geometry at every scale.
  //   The series shipped without re-baselining; parity sync == worker == `?worker=0`
  //   fallback re-verified byte-identical at this re-baseline (proxy bytes unchanged).
  // R1 산 식생 구조화(구한말 사진 고증, 2026-07-30): 곡률 종속 캐노피(골 뭉침·볼록 등날 억제),
  //   크레스트 밴드 억제, 화강암 노두 격상(개수·크기·노출장), 노송 개체 티어, 사철 관목층(bloom-scrub
  //   +1 오브젝트), 성곽 회랑 확폭(TREE_WALL_CORRIDOR, forest 전용 — 플랜 해시 불변), TREE_MIN_D_K
  //   1/61→1/69(뺏긴 유효면적 보상 팩킹). 총 그루수 village −3%/capital·hanyang +10%. 재기준 직전
  //   실측: 네 규모 모두 worker == `?worker=0` 폴백 바이트 동일(hanyang 732d7d09 양 경로 일치),
  //   proxy 해시 4종 전부 불변, mja·snapshot 3경로 교차 PASS.
  //   (동 라운드 3차 재기준 = R1.1 비전 보정: 곡률 샘플러 6m 양자화 메모(crunch ×3.2→×1.16),
  //    암반 크기·알베도·저지 배제 보정, 크레스트 0.88→0.70 + 노송 2%·3.0배, 관목 스케일 재조정,
  //    renorm 1.22·시도 상한 22 — 총 그루수 village +3%/capital +13%/hanyang +10%.)
  //   (동 라운드 4차 = R1.2: 암반 유효 밴드 0.66~0.86 소프트 페이드 — 최상단 무목·안개 밴드의
  //    "접시 위 돌" 배제 — + 매립 0.75w, 밴드 내 수락 게이트 완화·시도 상한 ×120 으로 개수 회복
  //    14/28/52. 나무 버퍼는 rock 회피 면적 변화로만 미세 이동.)
  // R2 지붕 바다(2026-07-30, 구한말 사진 고증): 한양·capital 필지 밀집(LOT 0.78/0.92·0.88,
  //   고샅 0.6×·0.58×, 앵커 392/112), dimsFor 티어 임계 +0.12(초가↑), 초가 볼륨(thatchThick
  //   0.52·eaveOverhang 1.15 — 전 규모 초가 지오메트리 변동), 소로 muteK 0.93/0.96, 배치 급경사
  //   게이트 변 12분할·1.25m, 축대 커버리지=담 발치 동일 수식, 대문 랜딩 35% 캡 제거. 필지·지붕
  //   OBB 가 움직여 proxy 4종도 함께 재기준. 재기준 직전 실측: 네 규모 모두 worker == `?worker=0`
  //   폴백 바이트 동일, snapshot·mja 3경로 교차 PASS — 결정론 손상 아님.
  // R2.2 비전 후속(2026-07-30): 초가 처마 tier 스코프(농촌 preset 1.0 환원, 도성만 1.15 —
  //   parcel.urbanEave 스탬프), 급경사 12분할 게이트 도성 스코프(농촌 배치 R1 완전 복원 —
  //   village/town proxy 가 R1 골든값 fef7a386/3f7f776c 으로 복귀한 것이 그 증거), 도성 소로·골목
  //   폭 0.65×, 도성 court/패드 0x746b56, FAR 초가 처마 띠 0.30. 농촌 씬은 thatchThick 변주만
  //   잔존. 재기준 직전 실측: 네 규모 모두 worker == 폴백 바이트 동일.
  // R2.3(2026-07-31): 비전 재판정 반영 — 도성 지면 절반 환원(0x807560)·초가 roofTone 리프트(urbanEave
  //   스탬프 생성 시점 이동)·소로 알베도 평지 블렌드·위성 dimsFor/스탬프 원복·고샅 0.48/0.50 +
  //   논배미 부유(>8m)·도로 리본 겹침 게이트(post-rng 재검사만 — 추첨 스트림 보존).
  //   농촌 배치는 R1 동일 유지(proxy fef7a386/3f7f776c 불변이 증거), 농촌 풀씬은 배미 게이트 파생만.
  //   재기준 직전 실측: 네 규모 모두 worker == 폴백 바이트 동일(각 2회), snapshot·mja 교차 PASS.
  // #31 fog 부활 + 보상값 되감기(2026-07-31): scene fog 가 마을 모드에서 한 번도 발화하지 않았음이
  //   실측 확정돼(near = R*2.2 가 지형 지름보다 멀다 — capital 616m vs 최원 지오메트리 279m,
  //   fogFactor 0) 밴드를 카메라 거리 파생으로 교체했다. 그동안 그 부재를 메우려 올려둔 보상값
  //   네 개를 함께 되감았고, 그중 **edge-mist 링 opacity 0.64 → 0.46** 이 생성 씬의 재질 속성이라
  //   네 규모 씬 해시가 의도적으로 이동한다. 나머지 셋은 씬 바이트에 안 걸린다(V_EDGE_HAZE_AMT·
  //   램프는 셰이더 문자열 상수, mist 고도 바닥 둘은 런타임 가중치, fog near/far 는 런타임 uniform).
  //   지오메트리·배치·rng 스트림은 불변 — proxy 4종(fef7a386/3f7f776c/046ecd22/0ee8aaee) 전부 불변이
  //   그 증거이고 objects/triangles 카운트도 동일하다.
  //   재기준 직전 실측: 네 규모 모두 worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 교차 PASS.
  // #31-2 지형 과세척 되감기(2026-07-31, 비전 A/B 2라운드): fog 부활 후 남은 지형 전용 이중
  //   계상을 걷어낸다. 정점색 원경 감쇠 cFar 0.55 → 0.30(terrain.js colorAt) — 이 항은 지형만
  //   갖고 수관·암반에는 대응항이 없어서, fog 와 합산된 초과분이 "원경 지형만 유백색 필드가 되고
  //   그 위 나무·암반이 데칼로 뜨는" 지각 결함으로 나타났다. **정점색이라 네 규모 씬 해시가
  //   의도적으로 이동한다**(1라운드는 mist opacity 만이었다). 같은 라운드의 노을 대기색 정합
  //   (atmosphere-profiles gold/crimson/violet fog)은 런타임 uniform 이라 바이트 무관.
  //   배치·기하·rng 스트림 불변 — proxy 4종(fef7a386/3f7f776c/046ecd22/0ee8aaee)과 objects/
  //   triangles 카운트가 전부 불변인 것이 증거.
  //   재기준 직전 실측: 네 규모 모두 worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 교차 PASS.
  // #31-3 지형 대기 보상항 **제거**(2026-07-31, 리드 처방 (a)): 정점색 cFar 감쇠와 aEdge 엣지 소실
  //   헤이즈를 항째로 삭제했다. r3 프로브가 두 가설을 반증한 결과다 — 인스턴스는 fog 를 동일하게
  //   수령하고(나무/지형 비 sunset 0.700 vs day 0.729, fog 휘도 3배 차이에도 4% 이동) 인스턴스
  //   std(0.055~0.077)는 지형 std(0.104~0.107)보다 낮다. 즉 결함은 진폭이 아니라 지형만 갖는 평균
  //   리프트였고, 그 두 항이 fog 복구 후 이중 계상이 된 것이다.
  //   씬 바이트가 두 경로로 이동한다: (1) 정점색에서 cFar lerp 와 겨울 버퍼 `(1-far)` 항이 빠졌고,
  //   (2) 지오메트리에서 `aEdge` Float32 어트리뷰트가 사라졌다. 배치·rng·삼각형 수는 불변 —
  //   proxy 4종(fef7a386/3f7f776c/046ecd22/0ee8aaee)·objects·triangles 전부 불변이 증거.
  // #31-4 절단면 소실 환원(2026-07-31, 비전 4라운드): edge-mist 링 opacity 0.46 → 0.64. #31-1 의
  //   감축은 **부감** 근거였는데(원경 깊이는 fog 가 공급), 저고도 flythrough 는 절단면이 카메라에서
  //   100~160m 라 fog 가 ≈0.22 밖에 안 걸린다. 구 조합(edge haze 0.34 + fog ≈0.48)이 #31-3 헤이즈
  //   삭제로 절반이 되어 절단면 실루엣 대비가 두 배가 됐고, 그것이 "능선 뒤 계단형 톱니 슬래브"로
  //   드러났다(픽셀 귀속: 지형 33.0% vs 하늘 33.6%, 링 지분 14.5%). 지형 셰이더에 보상항을 다시
  //   넣지 않고 절단면 소실 담당 장치(이 링)를 원래 세기로 되돌렸다 — 환원 후 링 지분 19.1%.
  //   고도 감쇠(EDGE_MIST_AERIAL_FLOOR 0.5)는 유지 → 부감 실효 0.320(구 0.600 의 절반).
  //   같은 라운드의 rim fog 참여·ridge-mist 백색 리프트 0.04 는 런타임(유니폼·셰이더)이라 바이트
  //   무관하다. ★ #31-5 정정: 여기서 "새 떼 fog:true·BIRD_BOOST 도 런타임이라 무관"이라고 적었던
  //   것은 틀렸다 — 새 떼 재질은 해시되는 씬에 포함된다(#31-5 에서 색만 바꿨는데 네 규모 해시가
  //   움직인 것이 증거). 즉 이 라운드의 이동은 링 opacity **와 새 떼 재질** 합산이다.
  //   재기준 직전 실측: 네 규모 모두 worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 교차 PASS.
  // #31-5 새 떼 알베도(2026-07-31, 비전 5라운드): 0x2b2e28 → 0x3a3e36. 프로브가 "fog 편입이 적용
  //   안 됐다"는 전제를 반증했다 — 개체 깊이 74.3/107.5/127.6m 에서 화소가 기대 fogFactor
  //   0.038/0.099/0.135 를 단조 추종한다(37,41,38 → 46,45,44 → 54,48,49). 무리가 안 씻긴 듯 보인
  //   이유는 무리가 카메라 74~128m 에 있어 그 깊이 대기가 4~14% 뿐인데 배후 능선은 400m+ 로 80%
  //   를 받기 때문 = 정상적인 대기 원근. 남은 실제 원인은 상대휘도 0.027 의 거의 순검정 알베도이고,
  //   그 "먹점" 관습은 배경이 중간값이던 시절 저작됐다. 새 떼 재질이 씬 해시에 포함되므로 네 규모
  //   해시가 이동한다(배치·기하 불변 — proxy 4종·objects·triangles 전부 불변이 증거).
  //   재기준 직전 실측: 네 규모 모두 worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 교차 PASS.
  // 천장 z-fight(2026-08-01, 커밋 61c0a45): buildHanok 의 회벽이 창방과 같은 높이에서 끝나 상면 캡
  //   두 장이 동일평면(y=2.700, 둘 다 up, 겹침 ~60m²)이었다. 회벽을 창방 밑(wallH − 0.16)까지만
  //   올리고 창방을 그 위에 1cm 파고들게 얹어 캡을 삼키므로 벽·창방 정점이 함께 이동한다.
  //   **귀속은 단독 측정이다**: 61c0a45(개천 이전) 워크트리에서 village/town 해시가 아래 새 값과
  //   완전히 같고 proxy(fef7a386/3f7f776c)·objects·triangles 도 불변이었다 — 즉 이 이동은 개천이
  //   아니라 천장 수정 단독이며, 기하 변경이 아닌 정점 좌표 변경이다. capital 은 이 경로의 히어로
  //   반가를 쓰지 않아 골든이 불변이다(같은 측정에서 PASS 유지가 증거).
  //   재기준 직전 실측: worker == `?worker=0` 폴백 바이트 동일, snapshot·mja 교차 PASS.
  // R4-B 판석교 재작(2026-08-01): 평석교 데크를 널돌 2열에서 고증 구성(멍엣돌·귀틀석·청판석,
  //   한국민족문화대백과사전 「평석교」)으로 재작하고 교각 수·하상 깊이를 접지 계약
  //   (stream-spatial#bridgeSlabPiers·bedY)에서 받게 했다. builder/bridge.js 는 규모 공유 경로라
  //   판석교를 쓰는 village 씬 해시가 이동한다. **populate 기하 단독 이동의 증거**: village 의
  //   plan-contract 해시·bytes 불변 + proxy fef7a386 불변 + town/capital(홍예교라 판석 데크 무관)
  //   완전 불변. 재기준 직전 실측(리드 2026-08-01): worker == `?worker=0` 폴백 바이트 동일
  //   (0681db44 양 경로 일치), snapshot·mja 교차 PASS.
  // 벽머리 깊이 스택(2026-08-01, 조립 반자 z-fight 재발): `layout/hanok.js` 에서 (a) 회벽 상단을
  //   창방 몸통 안 11cm 로 올리고 압출 원점을 벽머리로 옮겨(스케일 피벗 이동) 정착 스쿼시가 상면을
  //   창방 밖으로 밀지 못하게 했고, (b) 기단 몸통 상면을 갑석 안으로 3cm 더 가라앉혀 갑석 상면과의
  //   접선 접촉을 없앴다. 정지 포즈 파사드·재질·씬그래프는 불변이고 움직인 것은 정점 좌표뿐이다.
  //   **단독 변인 증거(재기준 직전 실측 2026-08-01)**: `hanok.js` 만 수정 전으로 되돌리면 네 규모가
  //   구 골든과 정확히 일치했다(village 0681db44 / town bd6ba713 / capital d187e903 / hanyang
  //   b2a0e799 전부 PASS). 또 objects·triangles 가 수정 전후 완전 동일하다(village 635/2284221,
  //   town 3330/5024809, hanyang 5878/25564031) — 노드·삼각형이 아니라 좌표만 바뀐 변경이다.
  //   capital 이 불변인 것이 범위 증거다: capital 히어로는 관아(궁 계열)라 buildHanok 을 타지 않는다
  //   (같은 파일의 '종가 파트 그룹' 재기준 항목과 동일한 논리). proxy 해시는 네 규모 전부 불변
  //   (fef7a386 / 3f7f776c / 046ecd22 / 6bd5f82a) — 픽킹·구도 해 불침해. 재기준 시점에 sync ==
  //   실제 module Worker == `?worker=0` 폴백이 세 경로 모두 바이트 동일, snapshot·mja 교차 PASS.
  // #29 히어로 전역 병합(2026-08-02): 아래 hanyang 항목 주석의 단독 변인 근거 참조.
  //   village/town/capital 도 비-mja 히어로(종가)를 품으므로 같은 구조 변경으로 scene 해시만 이동.
  //   proxy·triangles 불변, objects 감소(채별 그룹 → 전역 1 병합 그룹).
  // worldedge 링 테두리 행 캡(2026-08-03, #23 쐐기 전용 라운드): EDGE_RIM_CAP_MUL 2.4 —
  //   운해 링의 테두리 두 행(rMid·rOut)만 yCap×2.4 까지 등고를 따라, 불투명 crest 가 지형
  //   절단면 아래에 묻히던 방위(village 37.3% / capital 24.3% / hanyang 13.6%, 순수 노드 실측)를
  //   세 규모 전부 0% 로. 내부 행·strengthAt pool 은 yCap 그대로라 방위별 두께·농도 분포 불변.
  //   링 기하는 네 규모 공유 경로(clouds.js#buildEdgeMistRing)라 scene 해시가 전부 이동한다.
  //   **단독 변인 증거(재기준 직전 실측 2026-08-03)**: proxy 네 규모 전부 불변(fef7a386 /
  //   3f7f776c / 046ecd22 / c5517350), objects·triangles 도 전부 불변(village 594/2,284,221 ·
  //   town 3,161/5,024,809 · capital 2,186/5,663,398 · hanyang 5,358/25,598,200) — 노드·삼각형이
  //   아니라 링 정점 좌표만 바뀐 변경이다. sync == 실제 module Worker == `?worker=0` 폴백이
  //   세 경로 모두 바이트 동일(에이전트 실측 + 리드 재실행). 같은 부팅 픽셀 A/B 는 전 뷰
  //   changed ≤1.11%·rim 그라디언트 불변이고 비전 판정 SHIP(회귀 0)·개천 계곡 대역 변경 0.
  village: 'fb6e812e:eebd220a:e394b51b:e978e6b2',
  town: '50483e3f:0ea24fd7:dd1576e6:a284d039',
  capital: '7a786fe7:d01f2f0b:bf9cbf51:cba6c7eb',
  // R3-A(2026-07-31): 성문·성곽 형태 격상(#19) — 홍예 개구(비 0.20)·여장 톱니+총안(494+90타)·
  //   성벽 2켜 석재 위계·배터 육축+코니스·중층 문루. 성곽은 한양 전용이라 hanyang 해시만 이동
  //   (village/town/capital/mja/snapshot 골든 불변이 증거). proxy 0ee8aaee 불변 = 픽킹·편집 불침해.
  //   재기준 직전 실측: worker == 폴백 바이트 동일, async 불일치 0줄.
  // R3-A2(2026-07-31): 2라운드 표면 정리(플랫 셰이딩 석재·줄눈 본드·홍예 그늘 캐스터 제거·총안
  //   슬릿·접합 배터) + 문루 단청(city-gate rank, 사용자 승인). 동일 근거: hanyang 해시만 이동,
  //   proxy 0ee8aaee 불변, worker == 폴백 바이트 동일·async 불일치 0줄.
  // #31-5 동일 라운드: 한양도 새 떼 알베도로 이동(proxy 0ee8aaee 불변).
  // R3-B(2026-07-31): 문전 마당(#19 Phase B) — 성문 안쪽 접근 예약을 필지 배치에도 적용하고
  //   시전 행랑 도달 한계를 분지 0.9R 에서 성벽 안쪽으로 옮겼다. 계획 변경이므로 hanyang 해시가
  //   이동한다(village/town/capital/mja/snapshot 골든 불변이 한양 전용 변경의 증거).
  //   **proxy 는 이번에 이동한다**(0ee8aaee → 8266fb35): 문전 마당 blocker 가 필지 배치를 바꾸므로
  //   픽 프록시가 따라 움직이는 것이 정상이며, 프록시 개수·축·안정 ID 규약은 그대로다(프록시 계약
  //   게이트 통과가 증거). 재기준 직전 실측: worker == 폴백 바이트 동일, async 불일치 0줄.
  // 천장 z-fight + R4-A 합산(2026-08-01). 이 한 줄만 두 변인이 겹치므로 **각각 단독으로 측정**했다:
  //   ① 61c0a45(천장 수정, 개천 이전) 워크트리 = 52967784:4dabdf0e:9a3ff6f4:9ca9e24e ·
  //      proxy 8266fb35(불변) · objects 4818 · tri 23,639,144 → 천장 수정분.
  //   ② 현재(f3323f5, 개천 포함) = 아래 값 · proxy bba4f24a · objects 4723 · tri 23,624,240 → 개천분.
  //   proxy 가 이번에 이동하는 것은 R4-A 가 필지·논 계획을 바꾸기 때문이다(성 밖 논 계약, 거주 한선
  //   = 성벽, 수문 개구부). 프록시 개수·축·안정 ID 규약은 그대로이며 프록시 계약 게이트 통과가 증거.
  // R4-A(2026-07-31~08-01): 개천 도성 관류(streamZ 0.30R → 0.16R, 사행 ×0.5, 도성 구간 골짜기 어깨
  //   10m), 건천 하상 정점색, 오간수문(성벽 통과부마다 홍예 5개 수문 — 성벽 재질 공유로 드로우콜 +0),
  //   논 성저십리 계약·거주 한선 성벽·한양 개 상한 38. 전부 한양 전용이라 village/town/capital/mja/
  //   snapshot 골든이 불변인 것이 증거다. 재기준 직전 실측: worker == 폴백 바이트 동일.
  // R4-B(2026-08-01): 개천 마감 — 호안 석축(creek-bank-plan/geometry, props 화강암 차용으로
  //   드로우콜 +0), 벤치 횡단 접지(creekCrossingSpanHalf)·잔여 횡단부 판석교·남촌 중로 하도 밖
  //   물림(offStreamZ)·도성 개천 홍예 금지·물색 저채도. plan-contract 한양 골든이 같은 라운드에
  //   함께 이동(063066b5/6391478f — r4-creek-b 실측과 리드 재실행 실측 일치). proxy 이동
  //   (bba4f24a → 6bd5f82a)은 남촌 중로 재배선이 필지·지붕 OBB 를 움직이는 계획 변경의 정상
  //   추종이며 프록시 개수·안정 ID 계약 게이트는 통과. 재기준 직전 실측(리드): worker ==
  //   `?worker=0` 폴백 바이트 동일(b2a0e799 양 경로 일치).
  // 벽머리 깊이 스택(2026-08-01): 위 village/town 항목과 같은 단일 변경. 한양에도 종가(hanok)
  //   히어로 필지가 있어 함께 이동한다(근거·단독 변인 실측은 village 항목 참조).
  // #29 히어로 전역 병합(2026-08-02): 비-mja 히어로를 채별 mergeStatic 에서 전역 1회
  //   mergeStatic(ids)+스타일별 공유 재질/canonicalize 로 접음. 씬 그래프 토폴로지만 바뀌고
  //   (village-heroes 한 그룹 + 소스 레인지 접기 프록시), 정점/삼각형 합과 픽 프록시는 불변.
  //   **단독 변인 증거(재기준 직전 실측 2026-08-02)**:
  //   - proxy 4종 전부 불변(fef7a386 / 3f7f776c / 046ecd22 / 6bd5f82a) — 픽킹·구도 해 불침해.
  //   - triangles 4종 전부 불변(village 2284221 / town 5024809 / capital 5663398 /
  //     hanyang 25564031) — 지오 합이 같고 병합 구조만 접힌 증거.
  //   - objects 는 병합으로 감소(village 594, town 3161, capital 2186, hanyang 5541):
  //     채당 hero-* 그룹 N개 → village-heroes 1그룹 + 재질 메시 소수. 감소 폭 = 접힌
  //     중간 Object3D/메시 수(채별 재질 메시가 전역 재질 버킷으로 합쳐진 결과).
  //   - mja optin·snapshot 골든 불변 — mjaHouse 경로는 병합 제외, 스냅샷 시리얼 무관.
  //   - worker == `?worker=0` 폴백 바이트 동일(아래 신 해시 양 경로 일치), async 불일치 0.
  //   - 이 변경(populate 히어로 블록 + buildHeroParcel materials 옵트인)만 되돌리면 구 골든
  //     4종(village 84affbdc… / town 63cc99e7… / capital d187e903… / hanyang 41000769…)이
  //     재현됨(구조 diff 귀속).
  // #21 R5 궁·관아 위계(2026-08-02): 궁 컴파운드 기하(정전 칸 폭·행각 깊이·궁장·지대석)와
  //   궁역 앞 도시면(광장·육조거리 축선·관아 슬롯·궁장 밖 이격·도로 금지 구역)이 함께 들어갔다.
  //   **단독 변인 증거(재기준 직전 실측 2026-08-02)**:
  //   - **hanyang 해시만 이동한다.** village(0681db44…)·town(bd6ba713…)·capital(ca415f99…)·
  //     mja optin·snapshot 골든은 전부 불변이다. capital worker fixture 는 궁을 켜지 않으므로
  //     궁 변경이 그 씬에 닿지 않는다는 것이 같은 실행 안에서 확인된다.
  //   - proxy 는 한양만 이동(6bd5f82a → 5511f335) — 필지·지붕 OBB 가 실제로 움직였으므로
  //     정상이다. village/town/capital 프록시 3종은 같은 실행에서 불변.
  //   - **objects·triangles 도 이동한다**(hanyang 5541→5596 / 25,564,031→25,510,629).
  //     이 라운드는 #29 처럼 그래프만 접는 변경이 아니라 **내용이 바뀌는 계획·기하 변경**이므로
  //     그게 정상이다. 방향도 설명된다: 궁이 커져 삼각형이 늘고(궁 병합 904,508→921,424),
  //     히어로가 관아로 대체되며 총 히어로 삼각형이 줄어(≈723k→581k) 순감했다. 오브젝트는
  //     관아 4채·행각 세그먼트 증가분만큼 늘었다.
  //   - worker == `?worker=0` 폴백 바이트 동일(아래 신 해시 양 경로 일치), async 불일치 0.
  //   - 이 라운드의 `src/` 변경 7개 파일만 되돌리면 구 골든 9ff92c07… 이 재현된다
  //     (실측: `git show HEAD:<file>` 로 되돌린 트리에서 재현 확인).
  // #23 R5b 궁역 서편 채움 + 관아 축선 분포(2026-08-02): `src/` 변경은 두 파일뿐이다
  //   (palace.js 서편 곽 3종 추가 · palace-precinct-plan.js 관아 열 span 종속화).
  //   **단독 변인 증거(재기준 직전 실측 2026-08-02, `scratch/r5b/worker-revert.log`)**:
  //   - 그 두 파일을 `git show HEAD:<file>` 로 되돌린 트리에서 **구 골든이 그대로 재현된다**
  //     (hanyang d8620dc1… / proxy 5511f335 / objects 5596 / triangles 25,510,629).
  //   - 같은 두 실행에서 village(5c6e9658…)·town(42f854e6…)·capital(ca415f99…)·mja optin·
  //     snapshot 골든은 전부 불변이다. capital worker fixture 는 궁을 켜지 않고, capital
  //     프로필은 관아 슬롯이 아예 없다(magistracy.max 0).
  //   - proxy 는 한양만 이동(5511f335 → c5517350) — 관아 슬롯이 옮겨가며 도성 필지·지붕 OBB 가
  //     실제로 움직였으므로 정상이다.
  //   - **objects 감소(5596→5358)·triangles 증가(25,510,629→25,598,200)** 는 계획 재배치의
  //     결과이고 방향까지 설명된다. 같은 시드 계획 실측(before→after): 기와 77→70 · 초가
  //     320→327 · 도로 64→62 · 마당나무 종 561→557 · 장독 382→378. 기와 한 채가 초가보다
  //     훨씬 무거우므로 기와 7채가 초가로 바뀌면 오브젝트가 크게 준다. 삼각형은 반대로
  //     궁 서편 채움(+144,802 — 순수 실측 919,904→1,064,706)이 그 감소분을 넘어서 순증했다.
  //   - worker == `?worker=0` 폴백 바이트 동일(아래 신 해시 양 경로 일치), async 불일치 0.
  // R3-① 문루 공포대(2026-08-04, #23): 힌트 밴드 → 다포 포열(주포+간포, 외출목 2단,
  //   외목도리) + 하층 판벽 상단을 창방 밑면까지 + 포벽 폐합(상층은 개방 유지). 성곽은
  //   한양 전용이라 hanyang 해시만 이동(village/town/capital/mja/snapshot 전부 불변이 증거).
  //   **단독 변인 증거(재기준 직전 실측)**: proxy c5517350 불변(계획·지붕 OBB 무이동),
  //   objects 5358 불변(기존 병합 배치 흡수 — 드로우콜 델타 0의 독립 확인), triangles
  //   25,598,200 → 25,612,936 = +14,736이 순수 노드 citywall 기하 실측 델타(렌더 +29,472의
  //   절반, 그림자 패스 제외)와 정확히 일치. sync == 실제 module Worker == ?worker=0 폴백
  //   바이트 동일, 비전 2라운드 SHIP(슬릿 폐합 확인 포함).
  // G8 문루 질량(2026-08-04, #54): 몸체를 육축 상면 0.90 폭으로 확대(실물 주칸 3.62~3.73m,
  //   남문 7→9칸), 하층 처마가 육축 총폭의 1.00~1.30, 상층 정면 폭=하층, 육축 노출 ≤0.85.
  //   성곽은 한양 전용 — hanyang 해시만 이동(village/town/capital/mja/snapshot 불변이 증거).
  //   **단독 변인 증거(재기준 직전 실측)**: proxy c5517350 불변(필지·지붕 OBB 무이동),
  //   objects 5358 불변(병합 버킷 흡수 — 순수 노드 city-wall objects=9 불변, 드로우콜 델타 0),
  //   triangles 25,612,936 → 25,620,184 = +7,248이 순수 노드 성곽 기하 실측 델타(64,802→72,050)와
  //   정확히 일치. sync == module Worker == ?worker=0 폴백 바이트 동일. 비전 SHIP(질량 관계 달성).
  // #54 시전 접근로(2026-08-04): 남대문로 jungno→daero 승격 + 성곽 도성 행랑 runCap 해제
  //   (프리픽스 캡 26 이 51레코드를 종로 서단에 몰던 버그) + 문전 마당 필지·시전 배제 14m
  //   (GATE_FORECOURT_PLAN_DEPTH, 사용자 결정 대역 12~18m) + 예약 코어 일조 통로 행랑 배제.
  //   성곽 도성 전용 — hanyang 만 이동(village/town/capital scene·proxy·mja·snapshot 전부 불변이
  //   범위 증거). **이번엔 proxy 도 이동**(c5517350 → 395b740a): 행랑 footprint 가 필지 blocker 라
  //   도성 필지 배치가 바뀐 결과다(계획 골든 hanyang:base p397 유지, tools/plan-contract.json
  //   _sijeonApproachRebaseline 참조). sync == module Worker == ?worker=0 폴백 바이트 동일.
  //   FAIL-first: tools/check-sijeon-approach.mjs 가 수정 전 소스에서 19건 실패.
  // #54 행랑 벽체 완결(2026-08-04): 시전 파사드 v3 — 배면벽·측벽·박공벽·전면 상벽 신설로
  //   지붕이 벽체 질량 위에 앉는다(개방 골조가 성문 접근로 망원에서 "부유 지붕판"으로 읽히던
  //   결함). 시전 geometry 전용 — hanyang scene 만 이동, **proxy 395b740a 불변**(계획·필지·
  //   지붕 OBB 무이동)·village/town/capital/mja/snapshot 불변·plan 골든 불변(파사드는 계획
  //   JSON 밖)이 범위 증거. objects 5042 불변, triangles 25,214,500 → 25,230,260 = +15,760이
  //   순수 노드 파사드 실측 델타(점포당 +80 × 197)와 정확히 일치(구값은 리드 직전 실측).
  //   FAIL-first: check-sijeon-contract 벽체 단언이 수정 전 소스에서 실패(walls=undefined).
  // #54 슬라이스 B 성벽 안면 부속 밴드(2026-08-05): 신규 kind 'gateQuarter' — 성문 좌우 성벽
  //   안면의 낮은 초가 부속채(마을 팔레트 4역할 차입, mergeStatic 1회). 도성 전용 — hanyang 만
  //   이동, proxy 395b740a 불변(필지·지붕 OBB 무이동), village/town/capital/mja/snapshot 불변.
  //   objects 5042→5047(+5)·triangles 25,230,260→25,230,876(+616)이 순수 노드 buildGateQuarter
  //   직접 실측(objects 5·triangles 616·44tri/채)과 정확히 일치. worker == ?worker=0 폴백 바이트
  //   동일. 계획 골든 재기준은 tools/plan-contract.json _gateQuarterRebaseline 참조.
  //   FAIL-first: tools/check-gate-quarter.mjs no-band 변형 1건·crowd-wall 29건·forecourt 48건 실패.
  hanyang: '17636529:69f1c025:98b6ee8b:99cd1639',
};
const expectedProxyHashes = {
  // #22 visibility uses #8's fitted roof OBBs plus planned feature blockers.
  // #56's palace/temple dancheong edit axes remain in the proxy contract. #8 also
  // exposes the authored giwa bay width so the shape-aware editor can start at
  // the first effective mainHalfW rather than presenting a dead slider range.
  // #10 adds the six normalized residential opening axes to the public proxy.
  // Product focus keeps the door-height target at the exact reviewed shared
  // 24° courtyard elevation. #95 applies the 10° physical parcel lens from the
  // authored 23° reference lens. #136 retains that authored distant frame and
  // records the exact 3×3 terrain cutaway depth; only a plane that would reach
  // the house falls back to the first safe camera interval. Safe candidates still
  // scale XZ and Y together and all four proxy counts/isolation contracts remain
  // unchanged.
  // #144 intentionally changes the same ordinary-house fitted roof bounds read
  // by focus/edit proxies; stable IDs and proxy counts remain unchanged.
  // #146 keeps the fitted main-house bounds and proxy count exact. The public
  // editor descriptor reports only safely accepted auxiliary requests, and the
  // same oriented auxiliary volumes now participate in the camera solver.
  // The fixed Hanyang cohort has one affected safe framing; smaller cohorts keep
  // their prior camera bytes because no auxiliary intersects their candidates.
  // #151 adds stable renderer-free household-detail anchors. A detail may choose
  // another one of the same three bounded south-opening candidates only inside
  // the existing one-of-nine architectural hysteresis; scene bytes, proxy
  // counts, and sync/Worker/fallback parity remain unchanged.
  // #155 adds the JSON-safe semantic focus subject consumed by the app's
  // UI-safe viewport adapter. Regular houses expose their fitted roof/detail
  // anchors, while palace/temple proxies expose representative hall + flat
  // courtyard bounds and frame those instead of the full reserved precinct.
  // Scene bytes remain exact; only the public proxy descriptor changes.
  // 룩 복원 Phase 1: 주거 근접 focus 고도가 24° 도면 구도에서 눈높이대(9°)로 되돌아가고, 렌즈가
  // 10°→16° 로 광각화됐다. `planParcelFocus` 가 그 고도와 렌즈로 카메라 오프셋·거리·fov 를 모두
  // 푸므로 네 규모의 프록시 카메라 바이트가 함께 움직인다. 프록시 개수·ID·피사체 경계·격리
  // 계약은 그대로다.
  // 뒷산 완만화(위 씬 재기준과 같은 변경): 필지 지반고와 사면이 바뀌므로 focus 카메라가 푸는
  //   오프셋·거리·near 컷어웨이 바이트가 함께 움직인다. 프록시 개수·ID·피사체 경계·격리 계약은 그대로다.
  // 필지·마당 규모(#165): 필지 위치·크기·yardHardObstacles 가 바뀌고 focus detail anchor 가
  //   그 위치에서 파생되므로 네 규모 proxy 바이트가 함께 움직인다. 프록시 개수·격리 계약은 유지.
  // #20: 숲 배치 재배치가 focus 시야 corridor 식생 배제·카메라 해 바이트에 소폭 반영된다
  //   (프록시 개수·ID·격리 계약 유지). 재기준 직전 실측: worker == 폴백 바이트 동일.
  // Perf campaign town/capital LOD: FAR/MID/FULL 청크가 focus 거리·corridor 식생
  //   바이트에 반영된다 (프록시 개수·ID·격리 계약 유지).
  // R2 지붕 바다: 필지 위치·크기·지붕 OBB 변동 → proxy 재기준(개수·ID·격리 계약 유지).
  // R2.2: 농촌 배치 R1 복원으로 village/town 은 R1 골든값 그대로 복귀, 도성 2종만 신규
  //   (urbanEave 스탬프·소로 폭·급경사 게이트가 도성 필지·지붕 OBB 를 움직임).
  // R2.3: 도성 2종만 갱신(고샅·roofTone 스탬프가 도성 필지·지붕 OBB 를 움직임), 농촌은 R1 값 유지.
  village: 'fef7a386',
  town: '3f7f776c',
  capital: '046ecd22',
  // R4-A(2026-08-01): 한양만 이동. 개천이 논을 성 밖으로 밀고 거주 한선을 성벽으로 옮기므로 필지·
  //   지붕 OBB 가 따라 움직인다. 같은 라운드의 천장 z-fight 수정은 이 프록시를 움직이지 않았다
  //   (61c0a45 단독 측정에서 8266fb35 불변). 개수·안정 ID·격리 계약은 유지.
  // R4-B(2026-08-01): 남촌 중로를 하도 밖으로 물리는 재배선이 도성 필지·지붕 OBB 를 움직여
  //   한양만 이동. village proxy fef7a386 불변(판석교 재작은 proxy 를 건드리지 않는 증거).
  // #21 R5(2026-08-02): 한양만 이동. 궁역 앞 광장·궁장 밖 이격 링·관아 슬롯·도로 금지 구역이
  //   도성 필지와 지붕 OBB 를 움직이므로 픽 프록시가 따라 움직인다. village/town/capital
  //   프록시 3종은 같은 실행에서 불변이고(fef7a386 / 3f7f776c / 046ecd22), 이 라운드의
  //   `src/` 7개 파일만 되돌린 트리에서 구 값 6bd5f82a 가 재현된다(실측 2026-08-02).
  //   프록시 개수·안정 ID·격리 계약은 유지.
  // #23 R5b(2026-08-02): 한양만 이동. 관아 열이 축선 span 종속으로 바뀌며 예약 blocker 가
  //   옮겨졌고, 그 하류로 도성 필지·지붕 OBB 가 움직인다(기와 77→70·초가 320→327).
  //   village/town/capital 프록시 3종은 같은 실행에서 불변이고(fef7a386 / 3f7f776c /
  //   046ecd22), 이 라운드의 `src/` 2개 파일만 되돌린 트리에서 구 값 5511f335 가 재현된다
  //   (실측 2026-08-02). 서편 채움(palace.js)은 궁 컴파운드 내부라 필지 프록시를 만들지 않는다.
  //   프록시 개수·안정 ID·격리 계약은 유지.
  // #54 시전 접근로(2026-08-04): 한양만 이동. 행랑 footprint 가 필지 blocker 라 캡 해제 +
  //   남대문로 daero 승격 + 문전 마당 14m 로 도성 필지 배치가 바뀌었고, 그 하류로 지붕 OBB 가
  //   움직인다. village/town/capital 프록시 3종은 같은 실행에서 불변(fef7a386 / 3f7f776c /
  //   046ecd22) — 성곽 도성 전용 변경의 범위 증거. 계획 골든 재기준은 tools/plan-contract.json
  //   _sijeonApproachRebaseline 참조. 프록시 개수·안정 ID·격리 계약은 유지.
  hanyang: '395b740a',
};

const server = await createServer({
  appType: 'custom',
  cacheDir,
  configFile: false,
  root: ROOT,
  logLevel: 'error',
  plugins: [{
    name: 'worker-contract-page',
    configureServer(vite) {
      vite.middlewares.use('/__worker-contract', (_req, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(html);
      });
    },
  }],
  resolve: {
    alias: [
      { find: /^three\/addons\//, replacement: threeAddons },
      { find: /^three$/, replacement: threeMain },
    ],
    dedupe: ['three'],
  },
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
let failed = false;
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  // Scene/proxy goldens are cross-path determinism bytes, not a render benchmark. Keep the
  // Playwright-pinned JS/browser runtime here; system Chrome versions can legitimately round
  // generated Float32 data differently even when worker and sync still agree with each other.
  browser = await chromium.launch();
  console.log('[verification-browser] browser=chromium mode=pinned-worker-goldens');

  async function compare(mode) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await page.goto(`${base}/__worker-contract${mode === 'fallback' ? '?worker=0' : ''}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });

    const result = await page.evaluate(async () => {
      const NativeWorker = window.Worker;
      const workerStats = { started: 0, succeeded: 0, failed: 0, terminated: 0 };
      window.Worker = class ContractWorker extends NativeWorker {
        constructor(...args) {
          super(...args);
          workerStats.started++;
          this.addEventListener('message', (event) => {
            if (event.data?.ok) workerStats.succeeded++;
            else workerStats.failed++;
          });
          this.addEventListener('error', () => workerStats.failed++);
        }
        terminate() {
          workerStats.terminated++;
          return super.terminate();
        }
      };

      const [
        { createVillage, createVillageAsync },
        { hashThreeGroup, hashVillagePickProxies },
        { isSharedResource },
        { CITY_WALL_DIMENSIONS, cityWallVegetationBlocked },
        { FOREST_VISUAL_RADIUS },
        { VILLAGE_LENS, dollyScaleForFov },
        { makeVegetationMask, yardCanopyBlocked },
        { parcelLocalPoint },
        { yardHardObstacles, yardTreeIntersectsHardObstacle },
        { planYardLife, yardLifeRecordsToHardObstacles },
        { SCATTER_TREE_VISUAL_RADIUS },
        { decodeSceneSnapshot, encodeSceneSnapshot },
        { VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT },
        { Material },
      ] = await Promise.all([
        import('/src/village/adapter.js'),
        import('/tools/lib/hash-three-group.mjs'),
        import('/src/core/three-resources.js'),
        import('/src/village/citywall-contour.js'),
        import('/src/village/forest-crunch.js'),
        import('/src/camera/optics.js'),
        import('/src/village/vegetation-spatial.js'),
        import('/src/village/parcel-contract.js'),
        import('/src/village/yard-layout.js'),
        import('/src/village/yard-life-plan.js'),
        import('/src/generators/village/trees.js'),
        import('/app/src/lib/scene-snapshot.js'),
        import('/src/village/options.js'),
        import('/app/node_modules/three/build/three.module.js'),
      ]);
      const probeLifecycle = (handle) => {
        const yardLife = handle.group.userData.yardLife || null;
        const owned = new Set();
        const shared = new Set();
        const add = (resource) => {
          if (!resource?.dispose) return;
          (isSharedResource(resource) ? shared : owned).add(resource);
        };
        const addMaterial = (material) => {
          if (!material) return;
          add(material);
          for (const value of Object.values(material)) if (value?.isTexture) add(value);
          for (const uniform of Object.values(material.uniforms || {})) {
            const value = uniform?.value;
            if (value?.isTexture) add(value);
            else if (Array.isArray(value)) for (const item of value) if (item?.isTexture) add(item);
          }
        };
        const addObject = (object) => {
          add(object.geometry);
          const materials = Array.isArray(object.material)
            ? object.material
            : (object.material ? [object.material] : []);
          for (const material of materials) addMaterial(material);
        };
        handle.group.traverse(addObject);
        for (const proxy of handle.getPickProxies()) addObject(proxy.mesh);
        const counts = new Map();
        let sharedDisposals = 0;
        const onOwned = (event) => counts.set(event.target, (counts.get(event.target) || 0) + 1);
        const onShared = () => { sharedDisposals++; };
        for (const resource of owned) resource.addEventListener('dispose', onOwned);
        for (const resource of shared) resource.addEventListener('dispose', onShared);
        return {
          finish() {
            for (const resource of owned) resource.removeEventListener('dispose', onOwned);
            for (const resource of shared) resource.removeEventListener('dispose', onShared);
            const yardLifeDebug = yardLife?.debug?.() || null;
            return {
              owned: owned.size,
              disposed: counts.size,
              duplicates: [...counts.values()].filter((count) => count !== 1).length,
              duplicateDetails: [...counts.entries()]
                .filter(([, count]) => count !== 1)
                .slice(0, 8)
                .map(([resource, count]) => ({ type: resource.type || resource.constructor?.name, name: resource.name || '', count })),
              shared: shared.size,
              sharedDisposals,
              yardLifeDisposed: yardLifeDebug?.disposed === true
                && yardLifeDebug?.productMaterialsDisposed === true
                && yardLifeDebug?.resources?.geometries === 0
                && yardLifeDebug?.resources?.derivedMaterials === 0,
            };
          },
        };
      };
      const postDisposeInactive = (handle) => {
        const scene = new handle.group.constructor();
        let beforeObjects = 0;
        handle.group.traverse(() => { beforeObjects++; });
        const parcelId = handle.plan.parcels[0]?.id;
        handle.enterVillageMode({ scene });
        handle.debugShowProxies(true);
        const detail = handle.showParcelDetail(parcelId);
        let afterObjects = 0;
        handle.group.traverse(() => { afterObjects++; });
        return scene.children.length === 0
          && beforeObjects === afterObjects
          && detail === null
          && handle.getPickProxy(parcelId) === null
          && handle.getPickProxies().length === 0
          && handle.updateLod(null) === 0;
      };
      const vegetationContract = (handle) => {
        const wall = handle.plan.features?.cityWall;
        const mask = makeVegetationMask(handle.plan, handle.plan.site);
        let checked = 0;
        const failures = [];
        handle.group.traverse((object) => {
          if (!object.isInstancedMesh || ![
            'forest-pine', 'forest-broad', 'forest-far', 'forest-rocks',
            'scatter-pine', 'scatter-broad',
          ].includes(object.name)) return;
          const array = object.instanceMatrix.array;
          for (let i = 0; i < object.count; i++) {
            const o = i * 16;
            const point = { x: array[o + 12], z: array[o + 14] };
            const sx = Math.hypot(array[o], array[o + 1], array[o + 2]);
            const sz = Math.hypot(array[o + 8], array[o + 9], array[o + 10]);
            const factor = object.name === 'forest-pine' ? FOREST_VISUAL_RADIUS.pine
              : object.name === 'forest-broad' ? FOREST_VISUAL_RADIUS.broad
                : object.name === 'forest-far' ? FOREST_VISUAL_RADIUS.far
                  : object.name === 'forest-rocks' ? FOREST_VISUAL_RADIUS.rock
                    : object.name === 'scatter-pine' ? SCATTER_TREE_VISUAL_RADIUS.pine
                      : SCATTER_TREE_VISUAL_RADIUS.broad;
            const radius = Math.max(sx, sz) * factor;
            const blockedByLayout = mask(point.x, point.z, radius);
            const blockedByWall = wall && cityWallVegetationBlocked(wall, point, {
              corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
              gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
              gateApproachMargin: radius,
            });
            checked++;
            if ((blockedByLayout || blockedByWall) && failures.length < 8) failures.push({
              name: object.name, index: i, radius, x: point.x, z: point.z,
              blockedByLayout, blockedByWall: !!blockedByWall,
            });
          }
        });
        for (const [index, anchor] of (handle.group.userData.guardianAnchors || []).entries()) {
          const radius = anchor.r || 0;
          const blocked = wall && cityWallVegetationBlocked(wall, anchor, {
            corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
            gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
            gateApproachMargin: radius,
          });
          checked++;
          if (blocked && failures.length < 8) failures.push({
            name: 'flora-guardian', index, radius, x: anchor.x, z: anchor.z,
          });
        }
        const parcelById = new Map(handle.plan.parcels.map((parcel) => [parcel.id, parcel]));
        for (const [index, anchor] of (handle.group.userData.yardTreeAnchors || []).entries()) {
          const parcel = parcelById.get(anchor.parcelId);
          const local = parcel && parcelLocalPoint(parcel, anchor);
          const gardenOptions = Number.isFinite(anchor.hwagyeX)
            ? { exact: true, side: anchor.gardenSide, hwagyeX: anchor.hwagyeX }
            : undefined;
          const hardObstacles = parcel ? [
            ...yardHardObstacles(parcel, gardenOptions),
            ...yardLifeRecordsToHardObstacles(
              handle.group.userData.yardLifeRecords,
              anchor.parcelId,
            ),
          ] : [];
          const blocked = !parcel || !(anchor.radius > 0)
            || !(anchor.trunkRadius > 0)
            || yardCanopyBlocked(parcel, local, anchor.radius)
            || mask.spatial.blocksYardCanopy(anchor.x, anchor.z, anchor.radius)
            || yardTreeIntersectsHardObstacle(local, {
              canopyRadius: anchor.radius,
              trunkRadius: anchor.trunkRadius,
            }, hardObstacles);
          checked++;
          if (blocked && failures.length < 8) failures.push({
            name: 'flora-yard', index, parcelId: anchor.parcelId,
            radius: anchor.radius, x: anchor.x, z: anchor.z,
          });
        }
        const plannedGuardians = handle.plan.features?.guardianTrees || [];
        const renderedGuardians = handle.group.userData.guardianAnchors || [];
        if (plannedGuardians.length !== renderedGuardians.length && failures.length < 8) {
          failures.push({
            name: 'flora-guardian-count',
            planned: plannedGuardians.length,
            rendered: renderedGuardians.length,
          });
        }
        return { pass: failures.length === 0, checked, failures };
      };
      const yardLifeContract = (handle) => {
        const debug = handle.debugYardLife?.();
        const records = handle.group.userData.yardLifeRecords || [];
        const source = JSON.stringify(debug?.records || []);
        let hash = 0x811c9dc5;
        for (let index = 0; index < source.length; index++) {
          hash ^= source.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193);
        }
        const signature = (hash >>> 0).toString(16).padStart(8, '0');
        const group = handle.group.getObjectByName('village-yard-life');
        const pass = !!debug
          && debug.season === 'summer'
          && debug.weather === 'clear'
          && debug.recordCount === records.length
          && debug.records?.length === records.length
          && debug.activeRecords === 0
          && debug.submittedDrawCalls === 0
          && debug.allocatedDrawCalls <= 6
          && debug.textures === 0
          && debug.productBorrowedMaterials === 6
          && debug.productMaterialsDisposed === false
          && group?.visible === false
          && typeof group?.userData.waveFade?.setWeight === 'function';
        return {
          pass,
          recordCount: debug?.recordCount ?? -1,
          activeRecords: debug?.activeRecords ?? -1,
          allocatedDrawCalls: debug?.allocatedDrawCalls ?? -1,
          signature,
        };
      };
      const auxiliaryContract = (handle) => {
        const planned = handle.plan.parcels.filter((parcel) => parcel.auxiliary);
        const group = handle.group.getObjectByName('village-auxiliaries');
        const sourceIds = group?.userData?.srcIds;
        const source = JSON.stringify(planned.map((parcel) => [
          parcel.id,
          parcel.auxiliary,
        ]));
        let hash = 0x811c9dc5;
        for (let index = 0; index < source.length; index++) {
          hash ^= source.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193);
        }
        const states = planned.map((parcel) => handle.lodState(parcel.id));
        const empty = planned.length === 0
          && handle.plan.stats?.auxiliaries === 0
          && group == null;
        const populated = planned.length > 0
          && handle.plan.stats?.auxiliaries === planned.length
          && group?.children.length > 0
          && group.children.length <= 6
          && sourceIds instanceof Set
          && sourceIds.size === planned.length
          && planned.every((parcel) => sourceIds.has(parcel.id))
          && states.every((state) => state?.auxiliaryPresent
            && state.auxiliaryVisible
            && !state.auxiliaryHidden)
          && group.children.every((mesh) => mesh.isMesh
            && mesh.castShadow
            && mesh.receiveShadow);
        const pass = empty || populated;
        return {
          pass,
          planned: planned.length,
          meshes: group?.children.length ?? -1,
          sourceIds: sourceIds?.size ?? -1,
          signature: (hash >>> 0).toString(16).padStart(8, '0'),
        };
      };
      const crossKindYardLifeContract = (handle) => {
        const first = handle.group.userData.yardLifeRecords?.[0];
        if (!first) return { pass: true, skipped: true };
        const parcelId = first.owner.parcelId;
        const parcel = handle.plan.parcels.find((candidate) => candidate.id === parcelId);
        if (!parcel || !['giwa', 'choga'].includes(parcel.kind)) {
          return { pass: false, skipped: false, reason: 'missing residential owner' };
        }
        const kind = parcel.kind === 'choga' ? 'giwa' : 'choga';
        const rebuilt = handle.rebuildParcel(parcelId, { kind }, { persist: true });
        const planningParcels = handle.plan.parcels.map((candidate) => (
          candidate.id === parcelId ? { ...candidate, kind } : candidate
        ));
        const expected = planYardLife(planningParcels, { seed: handle.plan.seed });
        const actual = handle.group.userData.yardLifeRecords || [];
        return {
          pass: !!rebuilt && JSON.stringify(actual) === JSON.stringify(expected),
          skipped: false,
          parcelId,
          kind,
          expectedRecords: expected.filter((record) => record.owner.parcelId === parcelId).length,
          actualRecords: actual.filter((record) => record.owner.parcelId === parcelId).length,
        };
      };
      const landmarkLensContract = (handle, { requirePalace = false, requireTemple = true } = {}) => {
        const DEG = Math.PI / 180;
        const failures = [];
        let checked = 0;
        const specs = [
          { id: 'palace', profile: VILLAGE_LENS.palace, fit: 1.12, padding: 0.12, targetLift: 3.2, required: requirePalace },
          { id: 'temple', profile: VILLAGE_LENS.temple, fit: 1.16, padding: 0.14, targetLift: 3, required: requireTemple },
        ];
        for (const spec of specs) {
          const proxy = handle.getPickProxy(spec.id);
          if (!proxy) {
            if (spec.required) failures.push({ id: spec.id, reason: 'missing' });
            continue;
          }
          checked++;
          const framing = proxy.cameraFraming;
          const semanticWidth = proxy.focusBounds
            ? proxy.focusBounds.max.x - proxy.focusBounds.min.x
            : proxy.dims.x;
          const semanticDepth = proxy.focusBounds
            ? proxy.focusBounds.max.z - proxy.focusBounds.min.z
            : proxy.dims.z;
          const extent = Math.max(semanticWidth, semanticDepth);
          const expectedReferenceDistance = (extent * 0.5)
            / Math.tan(spec.profile.referenceFov * 0.5 * DEG) * spec.fit
            + extent * spec.padding;
          const physicalDistance = framing.position.distanceTo(framing.target);
          const scale = dollyScaleForFov(spec.profile.referenceFov, spec.profile.fov);
          const screenEquivalentDistance = physicalDistance / scale;
          const referencePreserved = framing.referenceFov === spec.profile.referenceFov;
          const fovPreserved = framing.fov === spec.profile.fov;
          const compositionPreserved = Math.abs(screenEquivalentDistance - expectedReferenceDistance) <= 1e-8;
          const targetLift = framing.target.y - proxy.worldCenter.y;
          const doorTargetPreserved = Math.abs(targetLift - spec.targetLift) <= 1e-8;
          if (!referencePreserved || !fovPreserved || !compositionPreserved || !doorTargetPreserved) {
            failures.push({
              id: spec.id,
              fov: framing.fov,
              referenceFov: framing.referenceFov,
              screenEquivalentDistance,
              expectedReferenceDistance,
              targetLift,
              expectedTargetLift: spec.targetLift,
            });
          }
        }
        return { pass: failures.length === 0, checked, failures };
      };
      const mjaStaticContract = (handle) => {
        const parcels = handle.plan.parcels.filter((parcel) => parcel.mjaHouse);
        const parcel = parcels[0];
        const access = parcel?.access;
        const proxy = parcel && handle.getPickProxy(parcel.id);
        const detail = parcel && handle.showParcelDetail(parcel.id);
        const anchors = [];
        detail?.group?.traverse((object) => {
          if (object.name === 'primary-opening-anchor') anchors.push(object);
        });
        const compound = detail?.group?.getObjectByName('mja-house');
        const anchor = anchors[0];
        const pass = parcels.length === 1
          && parcel?.id === 'p0'
          && handle.plan.stats?.mjaHouses === 1
          && parcel.mjaHouse.kind === 'mja-banga'
          && parcel.mjaHouse.wings.length === 2
          && parcel.mjaHouse.wings[0]?.roofSystem === 'independent-paljak'
          && parcel.mjaHouse.wings[1]?.roofSystem === 'continuous-u'
          && parcel.mjaHouse.gate?.id === 'mja:gate:south'
          && parcel.mjaHouse.gate?.kind === 'integrated-middle-gate'
          && parcel.mjaHouse.gate?.wingId === parcel.mjaHouse.wings[1]?.id
          && parcel.solarAccess?.localStart === parcel.mjaHouse.solarTarget.point.z
          && parcel.solarAccess?.halfWidth === (
            parcel.mjaHouse.solarTarget.corridor[1].x
              - parcel.mjaHouse.solarTarget.corridor[0].x
          ) * 0.5
          && access?.gateRole === 'front'
          && typeof access.roadId === 'string' && access.roadId.length > 0
          && Number.isFinite(access.gatePoint?.x) && Number.isFinite(access.gatePoint?.z)
          && Number.isFinite(access.roadPoint?.x) && Number.isFinite(access.roadPoint?.z)
          && proxy?.buildingSpec?.editable === false
          && proxy?.buildingSpec?.compound === true
          && detail?.compound === true
          && compound?.userData.mjaHouseHandle?.doorMotion === 'static'
          && compound?.userData.mjaDoorMotionExcluded === true
          && anchors.length === 1
          && anchor?.userData.openingDetailPlan?.mjaStatic === true
          && handle.primaryDoorState(parcel.id) === null
          && handle.togglePrimaryDoor(parcel.id) === null;
        return {
          pass,
          parcelCount: parcels.length,
          parcelId: parcel?.id || null,
          roadId: access?.roadId || null,
          editable: proxy?.buildingSpec?.editable,
          compound: detail?.compound === true,
          anchorCount: anchors.length,
          doorMotion: compound?.userData.mjaHouseHandle?.doorMotion || null,
        };
      };

      const abortName = async (promise) => {
        try { await promise; return 'resolved'; }
        catch (error) { return error?.name || 'unknown'; }
      };
      const preAborted = new AbortController();
      preAborted.abort();
      const preAbortName = await abortName(createVillageAsync(
        { scale: 'village', seed: 20260716 },
        { signal: preAborted.signal },
      ));
      const duringAbort = new AbortController();
      const abortSteps = [];
      const duringAbortName = await abortName(createVillageAsync(
        { scale: 'village', seed: 20260717 },
        {
          signal: duringAbort.signal,
          budgetMs: -1,
          onStep(label) {
            abortSteps.push(label);
            if (label === 'terrain') duringAbort.abort();
          },
        },
      ));
      const lateAbort = new AbortController();
      const lateAbortSteps = [];
      const yardLifeDisposals = new Map();
      const originalMaterialDispose = Material.prototype.dispose;
      Material.prototype.dispose = function disposeTrackedYardLifeMaterial() {
        if (this.name?.startsWith('yard-life-')
          || this.name?.startsWith('village-yard-life-')) {
          yardLifeDisposals.set(this.name, (yardLifeDisposals.get(this.name) || 0) + 1);
        }
        return originalMaterialDispose.call(this);
      };
      let lateAbortName;
      try {
        lateAbortName = await abortName(createVillageAsync(
          { scale: 'capital', seed: 20260716 },
          {
            signal: lateAbort.signal,
            budgetMs: -1,
            onStep(label) {
              lateAbortSteps.push(label);
              if (label === 'flora') lateAbort.abort();
            },
          },
        ));
      } finally {
        Material.prototype.dispose = originalMaterialDispose;
      }
      const stepsAtAbort = abortSteps.length;
      const schedulerFailureName = await abortName(createVillageAsync(
        { scale: 'village', seed: 20260718 },
        { nextFrame() { throw new Error('scheduler-fail'); } },
      ));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const abortContract = {
        preAbortName,
        duringAbortName,
        schedulerFailureName,
        steps: abortSteps,
        stopped: abortSteps.length === stepsAtAbort,
        lateAbortName,
        lateAbortSteps,
        lateAbortYardLifeDisposals: Object.fromEntries(yardLifeDisposals),
        lateAbortYardLifeLifecycle: yardLifeDisposals.size === 14
          && [...yardLifeDisposals.values()].every((count) => count === 1),
      };
      const scales = ['village', 'town', 'capital', 'hanyang'];
      const cases = [];
      for (const scale of scales) {
        const opts = { scale, seed: 20260716, includeTemple: true };
        const sync = createVillage(opts);
        const steps = [];
        const asyncHandle = await createVillageAsync(opts, {
          budgetMs: 8,
          nextFrame: (callback) => requestAnimationFrame(callback),
          onStep: (label) => steps.push(label),
        });
        const syncHash = hashThreeGroup(sync.group);
        const asyncHash = hashThreeGroup(asyncHandle.group);
        const syncProxyHash = hashVillagePickProxies(sync);
        const asyncProxyHash = hashVillagePickProxies(asyncHandle);
        const vegetation = vegetationContract(sync);
        const syncYardLife = yardLifeContract(sync);
        const asyncYardLife = yardLifeContract(asyncHandle);
        const syncAuxiliary = auxiliaryContract(sync);
        const asyncAuxiliary = auxiliaryContract(asyncHandle);
        const auxiliaryPass = syncAuxiliary.pass
          && asyncAuxiliary.pass
          && syncAuxiliary.planned === asyncAuxiliary.planned
          && syncAuxiliary.meshes === asyncAuxiliary.meshes
          && syncAuxiliary.signature === asyncAuxiliary.signature;
        const yardLifePass = syncYardLife.pass
          && asyncYardLife.pass
          && syncYardLife.recordCount === asyncYardLife.recordCount
          && syncYardLife.signature === asyncYardLife.signature;
        const crossKindYardLife = scale === 'capital'
          ? crossKindYardLifeContract(sync)
          : { pass: true, skipped: true };
        const lensRequirements = { requirePalace: scale === 'hanyang', requireTemple: true };
        const syncLandmarkLenses = landmarkLensContract(sync, lensRequirements);
        const asyncLandmarkLenses = landmarkLensContract(asyncHandle, lensRequirements);
        const defaultMjaOff = !sync.plan.parcels.some((parcel) => parcel.mjaHouse)
          && !asyncHandle.plan.parcels.some((parcel) => parcel.mjaHouse)
          && sync.plan.opts.mjaHouse === undefined
          && asyncHandle.plan.opts.mjaHouse === undefined
          && sync.plan.stats?.mjaHouses === undefined
          && asyncHandle.plan.stats?.mjaHouses === undefined;
        const syncProbe = probeLifecycle(sync);
        const asyncProbe = probeLifecycle(asyncHandle);
        sync.dispose();
        sync.dispose();
        asyncHandle.dispose();
        asyncHandle.dispose();
        const inactive = postDisposeInactive(sync) && postDisposeInactive(asyncHandle);
        const syncLifecycle = syncProbe.finish();
        const asyncLifecycle = asyncProbe.finish();
        const lifecyclePass = [syncLifecycle, asyncLifecycle].every((result) => (
          result.owned > 0
          && result.disposed === result.owned
          && result.duplicates === 0
          && result.sharedDisposals === 0
          && result.yardLifeDisposed
        )) && inactive;
        cases.push({
          scale,
          equal: syncHash.hash === asyncHash.hash && syncProxyHash.hash === asyncProxyHash.hash,
          syncHash,
          asyncHash,
          syncProxyHash,
          asyncProxyHash,
          steps,
          lifecyclePass,
          syncLifecycle,
          asyncLifecycle,
          inactive,
          vegetation,
          yardLifePass: yardLifePass && crossKindYardLife.pass,
          auxiliaryPass,
          syncAuxiliary,
          asyncAuxiliary,
          syncYardLife,
          asyncYardLife,
          crossKindYardLife,
          syncLandmarkLenses,
          asyncLandmarkLenses,
          defaultMjaOff,
        });
      }

      // #141 is intentionally absent from every historical scene golden above.
      // One explicit product context must create exactly one static p0 compound,
      // and that opt-in scene/picking/lifecycle contract must remain identical
      // through synchronous, real Worker, and ?worker=0 fallback generation.
      const mjaOptions = {
        scale: 'village',
        seed: 141,
        includeTemple: false,
        mjaHouse: VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT,
      };
      const mjaSync = createVillage(mjaOptions);
      const mjaSteps = [];
      const mjaAsync = await createVillageAsync(mjaOptions, {
        budgetMs: 8,
        nextFrame: (callback) => requestAnimationFrame(callback),
        onStep: (label) => mjaSteps.push(label),
      });
      const mjaSyncHash = hashThreeGroup(mjaSync.group);
      const mjaAsyncHash = hashThreeGroup(mjaAsync.group);
      const mjaSyncProxyHash = hashVillagePickProxies(mjaSync);
      const mjaAsyncProxyHash = hashVillagePickProxies(mjaAsync);
      const mjaSyncStatic = mjaStaticContract(mjaSync);
      const mjaAsyncStatic = mjaStaticContract(mjaAsync);
      const mjaSyncProbe = probeLifecycle(mjaSync);
      const mjaAsyncProbe = probeLifecycle(mjaAsync);
      mjaSync.dispose();
      mjaSync.dispose();
      mjaAsync.dispose();
      mjaAsync.dispose();
      const mjaInactive = postDisposeInactive(mjaSync) && postDisposeInactive(mjaAsync);
      const mjaSyncLifecycle = mjaSyncProbe.finish();
      const mjaAsyncLifecycle = mjaAsyncProbe.finish();
      const mjaLifecyclePass = [mjaSyncLifecycle, mjaAsyncLifecycle].every((lifecycle) => (
        lifecycle.owned > 0
        && lifecycle.disposed === lifecycle.owned
        && lifecycle.duplicates === 0
        && lifecycle.sharedDisposals === 0
        && lifecycle.yardLifeDisposed
      )) && mjaInactive;
      const mjaCase = {
        equal: mjaSyncHash.hash === mjaAsyncHash.hash
          && mjaSyncProxyHash.hash === mjaAsyncProxyHash.hash,
        steps: mjaSteps,
        syncHash: mjaSyncHash,
        asyncHash: mjaAsyncHash,
        syncProxyHash: mjaSyncProxyHash,
        asyncProxyHash: mjaAsyncProxyHash,
        syncStatic: mjaSyncStatic,
        asyncStatic: mjaAsyncStatic,
        lifecyclePass: mjaLifecyclePass,
        syncLifecycle: mjaSyncLifecycle,
        asyncLifecycle: mjaAsyncLifecycle,
        inactive: mjaInactive,
      };

      // #108: one deliberately tiny scene proves that the canonical URL
      // option envelope feeds the same sync, real-worker, and ?worker=0
      // generation paths. Keep this outside the four historical scene goldens:
      // it is a transport/determinism acceptance case, not a fifth art golden.
      const advancedInput = {
        state: {
          seed: 108,
          preset: 'korea',
          time: 'day',
          sunsetLook: 'gold',
          season: 'summer',
          weather: 'clear',
          expansion: 1,
        },
        overrides: {
          preset: true,
          time: true,
          sunsetLook: true,
          season: true,
          weather: true,
        },
        village: {
          seed: 20260724,
          scale: 'solo',
          character: 'yeoyeom',
          includePalace: false,
          includeTemple: false,
          siteR: 30,
          undAmpK: 0,
          ridgeHK: 0.5,
          streamMeanderK: 2.5,
          stream: false,
          river: true,
          paddyDensityK: 0,
          treeDensityK: 0,
          cityWall: false,
          sijeon: false,
          char01: 0.2,
          diversityK: 0,
          houses: 1,
          wallWeights: {
            tile: 1.5,
            stone: 1.25,
            mud: 0.75,
            brush: 0.5,
            hedge: 1,
            open: 0,
          },
        },
      };
      const advancedPayload = encodeSceneSnapshot(advancedInput);
      const advancedDecoded = decodeSceneSnapshot(advancedPayload);
      const advancedRoundtrip = advancedDecoded && encodeSceneSnapshot({
        state: {
          seed: advancedDecoded.seed,
          preset: advancedDecoded.preset,
          time: advancedDecoded.time,
          sunsetLook: advancedDecoded.sunsetLook,
          season: advancedDecoded.season,
          weather: advancedDecoded.weather,
          expansion: advancedDecoded.expansion,
        },
        overrides: advancedDecoded.overrides,
        village: advancedDecoded.village,
        flow: advancedDecoded.flow,
        residentialEdits: advancedDecoded.residentialEdits,
        focusedParcelId: advancedDecoded.focusedParcelId,
        view: advancedDecoded.view,
      });
      const decodedOptions = advancedDecoded?.village;
      const codecPass = !!advancedPayload
        && advancedRoundtrip === advancedPayload
        && decodedOptions?.siteR === 30
        && decodedOptions?.houses === 1
        && decodedOptions?.stream === false
        && decodedOptions?.river === true
        && decodedOptions?.wallWeights?.tile === 1.5
        && decodedOptions?.wallWeights?.stone === 1.25
        && decodedOptions?.wallWeights?.mud === 0.75
        && decodedOptions?.wallWeights?.brush === 0.5
        && decodedOptions?.wallWeights?.hedge === 1
        && decodedOptions?.wallWeights?.open === 0;

      let advancedCase = {
        codecPass,
        payload: advancedPayload,
        roundtrip: advancedRoundtrip,
        equal: false,
        planOptionsPass: false,
        steps: [],
      };
      if (decodedOptions) {
        const sync = createVillage(decodedOptions);
        const steps = [];
        const asyncHandle = await createVillageAsync(decodedOptions, {
          budgetMs: 8,
          nextFrame: (callback) => requestAnimationFrame(callback),
          onStep: (label) => steps.push(label),
        });
        const syncHash = hashThreeGroup(sync.group);
        const asyncHash = hashThreeGroup(asyncHandle.group);
        const syncProxyHash = hashVillagePickProxies(sync);
        const asyncProxyHash = hashVillagePickProxies(asyncHandle);
        const tuning = sync.plan.opts.tuning;
        const planOptionsPass = sync.plan.opts.siteR === 30
          && sync.plan.opts.target === 1
          && sync.plan.site.stream === null
          && tuning.stream === false
          && tuning.river === true
          && tuning.treeDensityK === 0
          && tuning.paddyDensityK === 0
          && tuning.wallWeights?.tile === 1.5
          && tuning.wallWeights?.open === 0;
        advancedCase = {
          codecPass,
          payload: advancedPayload,
          roundtrip: advancedRoundtrip,
          equal: syncHash.hash === asyncHash.hash
            && syncProxyHash.hash === asyncProxyHash.hash,
          planOptionsPass,
          steps,
          syncHash,
          asyncHash,
          syncProxyHash,
          asyncProxyHash,
        };
        sync.dispose();
        asyncHandle.dispose();
      }
      return { cases, mjaCase, advancedCase, workerStats, abortContract };
    });
    await page.close();
    return { ...result, errors };
  }

  const advancedModeHashes = [];
  const mjaModeHashes = [];
  for (const mode of ['worker', 'fallback']) {
    const result = await compare(mode);
    console.log(`\n${mode === 'worker' ? 'async worker' : 'async fallback (?worker=0)'}`);
    for (const item of result.cases) {
      const stepsEqual = JSON.stringify(item.steps) === JSON.stringify(expectedSteps);
      const baselineEqual = item.syncHash.hash === expectedSceneHashes[item.scale]
        && item.syncProxyHash.hash === expectedProxyHashes[item.scale];
      const proxyApiPass = item.syncProxyHash.singleContract && item.asyncProxyHash.singleContract;
      const landmarkLensPass = item.syncLandmarkLenses.pass && item.asyncLandmarkLenses.pass;
      const pass = item.equal && stepsEqual && baselineEqual && proxyApiPass && landmarkLensPass
        && item.lifecyclePass && item.vegetation.pass && item.yardLifePass
        && item.auxiliaryPass && item.defaultMjaOff;
      failed ||= !pass;
      console.log(`${item.scale.padEnd(9)} ${pass ? 'PASS' : 'FAIL'}  ${item.syncHash.hash}  proxy=${item.syncProxyHash.hash}`
        + `  objects=${item.syncHash.objects} triangles=${item.syncHash.triangles}`);
      if (!item.equal) console.log(`          async ${item.asyncHash.hash}  proxy=${item.asyncProxyHash.hash}`);
      if (!baselineEqual) {
        console.log(`          expected ${expectedSceneHashes[item.scale]}  proxy=${expectedProxyHashes[item.scale]}`);
      }
      if (!stepsEqual) console.log(`          steps ${JSON.stringify(item.steps)}`);
      if (!proxyApiPass) console.log('          getPickProxy descriptor parity/isolation contract failed');
      if (!landmarkLensPass) {
        console.log(`          landmark lenses sync=${JSON.stringify(item.syncLandmarkLenses)} async=${JSON.stringify(item.asyncLandmarkLenses)}`);
      }
      if (!item.lifecyclePass) {
        console.log(`          lifecycle sync=${JSON.stringify(item.syncLifecycle)} async=${JSON.stringify(item.asyncLifecycle)} inactive=${item.inactive}`);
      }
      if (!item.vegetation.pass) console.log(`          vegetation ${JSON.stringify(item.vegetation)}`);
      if (!item.yardLifePass) {
        console.log(`          yard-life sync=${JSON.stringify(item.syncYardLife)} async=${JSON.stringify(item.asyncYardLife)} crossKind=${JSON.stringify(item.crossKindYardLife)}`);
      }
      if (!item.auxiliaryPass) {
        console.log(`          auxiliary sync=${JSON.stringify(item.syncAuxiliary)} async=${JSON.stringify(item.asyncAuxiliary)}`);
      }
      if (!item.defaultMjaOff) console.log('          default village unexpectedly enabled an mja house');
    }
    const mja = result.mjaCase;
    const mjaStepsEqual = JSON.stringify(mja.steps) === JSON.stringify(expectedSteps);
    const mjaProxyApiPass = mja.syncProxyHash.singleContract
      && mja.asyncProxyHash.singleContract;
    const mjaPass = mja.equal
      && mjaStepsEqual
      && mjaProxyApiPass
      && mja.syncStatic.pass
      && mja.asyncStatic.pass
      && mja.lifecyclePass;
    failed ||= !mjaPass;
    console.log(`mja optin ${mjaPass ? 'PASS' : 'FAIL'}  ${mja.syncHash.hash}`
      + `  proxy=${mja.syncProxyHash.hash}`
      + `  objects=${mja.syncHash.objects} triangles=${mja.syncHash.triangles}`);
    if (!mja.equal) {
      console.log(`          async ${mja.asyncHash.hash}  proxy=${mja.asyncProxyHash.hash}`);
    }
    if (!mjaStepsEqual) console.log(`          steps ${JSON.stringify(mja.steps)}`);
    if (!mjaProxyApiPass) console.log('          mja getPickProxy descriptor parity/isolation contract failed');
    if (!mja.syncStatic.pass || !mja.asyncStatic.pass) {
      console.log(`          static sync=${JSON.stringify(mja.syncStatic)} async=${JSON.stringify(mja.asyncStatic)}`);
    }
    if (!mja.lifecyclePass) {
      console.log(`          lifecycle sync=${JSON.stringify(mja.syncLifecycle)} async=${JSON.stringify(mja.asyncLifecycle)} inactive=${mja.inactive}`);
    }
    mjaModeHashes.push({
      mode,
      scene: mja.syncHash.hash,
      proxy: mja.syncProxyHash.hash,
    });
    const advanced = result.advancedCase;
    const advancedStepsEqual = JSON.stringify(advanced.steps) === JSON.stringify(expectedSteps);
    const advancedProxyApiPass = advanced.syncProxyHash?.singleContract
      && advanced.asyncProxyHash?.singleContract;
    const advancedPass = advanced.codecPass
      && advanced.equal
      && advanced.planOptionsPass
      && advancedStepsEqual
      && advancedProxyApiPass;
    failed ||= !advancedPass;
    console.log(`snapshot  ${advancedPass ? 'PASS' : 'FAIL'}  ${advanced.syncHash?.hash || 'no-scene'}`
      + `  proxy=${advanced.syncProxyHash?.hash || 'no-proxy'}`
      + `  payload=${advanced.payload?.length || 0}b`);
    if (!advanced.codecPass) {
      console.log(`          codec payload=${JSON.stringify(advanced.payload)} roundtrip=${JSON.stringify(advanced.roundtrip)}`);
    }
    if (!advanced.equal) {
      console.log(`          async ${advanced.asyncHash?.hash || 'no-scene'}  proxy=${advanced.asyncProxyHash?.hash || 'no-proxy'}`);
    }
    if (!advanced.planOptionsPass) console.log('          decoded advanced options did not reach the planner intact');
    if (!advancedStepsEqual) console.log(`          steps ${JSON.stringify(advanced.steps)}`);
    if (!advancedProxyApiPass) console.log('          snapshot getPickProxy descriptor parity/isolation contract failed');
    advancedModeHashes.push({
      mode,
      scene: advanced.syncHash?.hash,
      proxy: advanced.syncProxyHash?.hash,
    });
    const workerPass = mode === 'worker'
      ? result.workerStats.started === 1
        && result.workerStats.succeeded >= result.cases.length + 2
        && result.workerStats.failed === 0
        && result.workerStats.terminated === 0
      : result.workerStats.started === 0 && result.workerStats.terminated === 0;
    const abortPass = result.abortContract.preAbortName === 'AbortError'
      && result.abortContract.duringAbortName === 'AbortError'
      && result.abortContract.lateAbortName === 'AbortError'
      && result.abortContract.schedulerFailureName === 'Error'
      && result.abortContract.stopped
      && result.abortContract.steps.at(-1) === 'terrain'
      && result.abortContract.lateAbortSteps.at(-1) === 'flora'
      && result.abortContract.lateAbortYardLifeLifecycle;
    failed ||= !workerPass || !abortPass || result.errors.length > 0;
    console.log(`worker messages: ${JSON.stringify(result.workerStats)} ${workerPass ? 'PASS' : 'FAIL'}`);
    console.log(`abort lifecycle: ${JSON.stringify(result.abortContract)} ${abortPass ? 'PASS' : 'FAIL'}`);
    for (const error of result.errors) console.error(error);
  }
  const snapshotCrossModePass = advancedModeHashes.length === 2
    && advancedModeHashes[0].scene === advancedModeHashes[1].scene
    && advancedModeHashes[0].proxy === advancedModeHashes[1].proxy;
  failed ||= !snapshotCrossModePass;
  console.log(`\nsnapshot sync/worker/fallback: ${snapshotCrossModePass ? 'PASS' : 'FAIL'} ${JSON.stringify(advancedModeHashes)}`);
  const mjaCrossModePass = mjaModeHashes.length === 2
    && mjaModeHashes[0].scene === mjaModeHashes[1].scene
    && mjaModeHashes[0].proxy === mjaModeHashes[1].proxy;
  failed ||= !mjaCrossModePass;
  console.log(`mja sync/worker/fallback: ${mjaCrossModePass ? 'PASS' : 'FAIL'} ${JSON.stringify(mjaModeHashes)}`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

if (failed) {
  console.error('\nWORKER CONTRACT: FAIL');
  process.exitCode = 1;
} else {
  console.log('\nWORKER CONTRACT: PASS');
}
