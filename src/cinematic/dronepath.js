import * as THREE from 'three';

// 시네마틱 감상 — 드론 **연속 비행 투어** (태스크 #32, 2026-08-01 재설계).
//
// 종전(#103·#30)은 "특정 샷 4종을 각각 재현하는 독립 패스" 였다. 패스마다 시작·끝 속도가 0 이고
// 패스 사이는 위치 컷이라, 관광 소개 영상이 아니라 정지 컷 4장을 이어 붙인 슬라이드였다. 사용자
// 판정에 따라 **하나의 닫힌 연속 경로**로 다시 세운다.
//
//   createDronePaths({ site, plan, heightAt, seed, sunAzimuth, canopies }) → [ leg, ... ] (4구간)
//     leg = { name, kind, duration, sample(t01) → { pos, lookAt, fov },
//             t0, t1, tourDuration, sampleTour(tau01), tour }
//
// ── 왜 여전히 "4개 배열" 인가 ──
//   구간(leg)은 독립 패스가 아니라 **하나의 투어 곡선 위 시간 창**이다. leg k 의 t01=1 과 leg k+1 의
//   t01=0 은 같은 투어 시각을 가리키므로 위치·속도·시선이 정확히 일치한다(컷 0). 마지막 구간의
//   끝은 첫 구간의 시작(닫힌 곡선의 이음매)이라 체인을 무한 순환해도 컷이 생기지 않는다.
//   배열 형태·이름·kind·duration 계약을 유지하는 이유는 소비면(app/src/engine/cinematic-runtime.js
//   체인, CinematicOverlay 라벨, verify-cinewire 배선 계약, shoot-cine 단독 재생)을 건드리지 않고
//   경로 문법만 교체하기 위해서다. 카메라 전용 변경이므로 재질·포스트·드로우콜 델타는 0 이다.
//
// ── 경로 문법(전 규모 공통, 소재는 규모별로 다름) ──
//   ① crane-in       역광측 상공 → 하강 접근(진입). 마지막에 오빗 접선 위로 활강해 들어간다.
//   ② landmark-orbit 주 랜드마크(궁/절/종가/관아/정자/당산나무) 부분 선회 215~270°.
//   ③ street-flythrough 오빗 접선 이탈 → 지붕 바다 저공 스윕 → 골목/개울 저공 패스(연속 2구간).
//   ④ pullback-reveal 저공에서 능선 위로 상승하며 전경 공개 → 이음매(=①의 시작점)로 복귀.
//
// ── 연속성이 성립하는 근거 ──
//   위치·시선 모두 닫힌 centripetal CatmullRom(C¹) 이고, 두 곡선은 **제어점 인덱스**로 정렬된다
//   (같은 곡선 파라미터 t 에서 샘플). 시간축은 호길이 균일화 + 주기 부드러운 속도 가중 w(t) 로
//   만들어 |dP/dτ| ∝ w(t) 이므로 속도가 연속이고 어디서도 0 이 되지 않는다(구간별 ease 금지 —
//   ease 를 걸면 구간 경계마다 정지·재출발이 생긴다).
//
// ── 안전(관통 금지) ──
//   지형·지붕 하한과 수관 시선 관통은 **샘플별 클램프가 아니라 t 그리드에서 미리 푼 리프트**를
//   주기 smootherstep 으로 확산시켜 적용한다. 클램프로 걸면 필지 경계 한 프레임에 고도가 계단으로
//   튀어 시선 각속도가 폭발한다(종전 라운드의 실측 69~152°/s). 하드 안전망은 그리드 사이 잔차에만
//   개입한다. 계약은 tools/check-cine-quality.mjs(T1~T12) 가 지킨다.
//
// 좌표 규약(site.js): +z=남(앞·진입·개울), -z=북(뒤·주산). 모든 거리·고도는 site.R·Hmax 파생이라
//   siteR 30(외딴집)~520(한양) 연속 규모에서 같은 문법이 성립한다.

const DEG = Math.PI / 180;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
// smootherstep(C²): 리프트 확산·가중 램프 공용.
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// 지형 위 최소 클리어런스(>1.5m 요구, 여유 포함)와 건물 지붕 위 최소 클리어런스.
const GROUND_CLEAR = 2.0;
const ROOF_CLEAR = 2.0;
// 프록시(adapter buildProxies)와 동일한 필지 여유 — 관통 판정 보수화.
const FOOT_PAD = 1.12;

// ── 시가지 밀도 스캔 ── 도로 폴리라인의 어느 구간이 "시가지"인지 지붕 히트로 판정한다.
// 최장 도로를 그대로 쓰면 capital 처럼 대로가 도성 밖까지 뻗은 규모에서 경로 후반이 빈 들판이 된다.
export const DENSITY_DISC_RATIO = 0.12;   // 원판 반경 = R * 0.12
const DENSITY_MIN_ROAD_LEN = 60;          // 이보다 짧은 도로는 트리밍할 구조가 없다(합성 픽스처 포함)
const DENSITY_MIN_SPAN_RATIO = 0.22;      // 목표 스팬 길이(도로 길이 비율)
const DENSITY_MIN_SPAN_ABS = 90;          // 목표 스팬 길이(절대, m)
const DENSITY_THRESHOLD_RATIO = 0.3;      // 시가지 판정 문턱 = max(1, 0.3 × 최대 히트)

// 저공 스윕 고도 — 경로 국소 지붕 상단 이동평균 위 이 높이.
const FLY_ROOF_CLEAR = 3.5;
const FLY_LANE_CLEAR = 2.8;         // 골목 패스는 한 단계 더 낮게(스침)
const FLY_FALLBACK_ROOF = 8;        // 지붕이 드문 구간의 기준 지붕고(초가 6.5 ~ 기와 9 사이)
const FLY_ROOF_TRUST_HITS = 3;      // 원판 히트가 이 수 이상일 때만 지붕 추정을 온전히 신뢰
// 저공 고도 기준선의 원판 반경(m) — **고정값**이다. 밀도 원판(R*0.12)을 쓰면 한양에서 60m 반경이
//   서로 무관한 지붕을 평균해 카메라가 국소 지붕 위 8~10m 로 떠오르고(저공 표본 32%→22%),
//   품질 계약이 쓰는 판정 원판(18m = 필지 한 겹)과도 정의가 어긋난다.
const FLY_BASELINE_DISC = 18;
// 저공 패스 하향각 — 2026-08-01 비전 FIX: 10° 는 지평선이 프레임 30~48% 에 걸리고 상단 35~55% 가
//   빈 하늘이 됐다(fov 42 에서 하늘 27%). 15° 면 하늘 15%, 프레임 하단이 근경 지붕·담으로 채워져
//   리딩라인이 생긴다. 26° 이상은 RTS 평면도가 되므로(#30) 이 값이 상·하한 사이의 기준이다.
const FLY_DROP_DEG = 17;
// 골목 패스만 한 단계 더 눕힌다(2026-08-01 3차 비전 A항). 지붕 바다 스윕은 지붕 면을 보여 주어야 해서
//   17° 가 맞지만, 담 사이를 스치는 골목 패스에서 같은 각을 쓰면 프레임 하단이 카메라 직하 노면판이 된다.
const FLY_LANE_DROP_DEG = 14;
// 골목 패스의 **지면 기준** 고도 상한·하한(m). 종전에는 국소 지붕 이동평균만 기준이라 지붕이 높거나
//   드문 구간에서 카메라가 지면 위 12m 부감으로 떠올랐고, 프레임 하단 중앙이 빈 흙 노면이 됐다
//   (3차 비전 A항). 담 머리 높이 근처에서만 "고샅을 스친다"가 성립한다.
const FLY_LANE_ALT_CAP = 8.5;
const FLY_LANE_ALT_MIN = GROUND_CLEAR + 1.2;
// 측면 오프셋(m) — 노선 중심을 그대로 날면 프레임 하단 중앙이 노면이다. 조준을 기울인 같은 쪽(밀집측)으로
//   비행선을 밀어 담 한 줄이 하단 중앙을 대각으로 지나 리딩라인이 되게 한다. KEEP 은 건물 볼륨(FOOT_PAD
//   1.12 로 이미 부풀려진) 밖에 남겨야 하는 최소 이격 — 이 안으로 들어가면 직하 지붕 리프트가 발동해
//   카메라가 계단으로 튄다.
const FLY_SWEEP_SIDE = 3.5;
const FLY_LANE_SIDE = 4.5;
const FLY_SIDE_KEEP = 3.0;
// 담을 스치는 코스에서 지면 기준 상한이 "지붕 위 여유"와 맞물리면 한 프레임짜리 수직 계단이 생긴다
//   (실측 한양 dy 56m/s → 프레임 속도 57.7m/s, 속도 점프 45.7). 원인은 리프트 격자 간격(1.2m)보다 짧은
//   필지 모서리 교차라 격자가 놓치고 하드 안전망이 그 프레임에서만 발동하는 것이다. 상한을 **회랑 안 최고
//   지붕 위 여유** 아래로는 내리지 않아 교차가 계단을 만들 여지를 원천에서 없앤다. 회랑 반경은
//   측면 오프셋 + 이격 + 스플라인 벌지 여유.
const FLY_CORRIDOR_R = 5.5;
const FLY_CORRIDOR_CLEAR = ROOF_CLEAR + 0.6;
// 회랑 지붕 하한이 감당하는 최대 리프트(m) — 이보다 큰 요구량은 넓은 교차이므로 리프트 격자에 맡긴다.
// 3.0 → 1.5: 아래 미세 접힘 가드가 들어온 뒤로는 계단 억제를 이 하한에 크게 의존하지 않아도 되고,
//   3.0 은 한양에서 저공 표본을 fly 53%→29% 로 깎았다(높은 지붕 옆을 지날 때 과하게 들어올린다).
const FLY_GUARD_MAX_LIFT = 1.5;
// 측면 오프셋의 최대 변화율(전진 간격 대비) — 미세 헤어핀 방지. 0.35 에서는 capital 프레임 속도 점프가
//   5.7 로 남았고 0.18 에서 1.1 로 떨어졌다(하단 중앙 피복은 59%→56% 로만 내려간다). 사용처 주석에 근거.
const FLY_SIDE_SLOPE = 0.18;
// 이탈 접선·스윕 진입의 화각. 저공 와이드(FLY_FOV)를 향해 단조로 열린다 — 자세한 근거는 사용처 주석.
const FLY_EXIT_FOV = 42;
const FLY_ENTRY_FOV = 48;
// 스윕→골목 뱅크 선회 두 점의 화각.
const FLY_BANK_FOV = 40;
// 뱅크 리드의 규모 기준 하한 비율(사용처 주석에 근거).
const FLY_BANK_LEAD_MIN = 0.05;
// 시선 원뿔 내 지붕 히트 — 카메라 위치의 밀도만 보면 "옆에는 집이 있는데 프레임은 비어 있는" 구간을
//   놓친다. 수평 반각 안 5방향 × 4단 거리 = 20 표본.
const FLY_CONE_SAMPLES = 5;
const FLY_CONE_RINGS = 4;
const FLY_CONE_FAR_RATIO = 1.6;           // 원뿔 사거리 = aheadDist * 1.6
const FLY_CONE_MIN_HITS = 3;              // 20 표본 중 이만큼은 건축이어야 프레임이 비지 않는다
const FLY_TRIM_MIN_SPAN = 40;             // 원뿔 트리밍이 스팬을 이 아래로 줄이지는 않는다
// ── 개활지에서는 내려가지 않는다(2026-08-01 6차 비전 FIX-2) ──
// 비전 실측: 마을 저공 구간 τ0.60~0.73 이 필지 밀집대가 아니라 개천·논 개활지를 통과했고, 그 구간의
//   프레임에는 건축이 한 채도 없었다(원뿔 히트 0/20 인 제어점 4개 — 스윕 꼬리 2 + 뱅크 선회 2).
//   축 선택(denseRoadSpan·원뿔 트리밍)은 **카메라 위치**의 밀도로 스팬을 고르지만, 스팬 꼬리의
//   스테이션은 aheadDist 의 0.75~1.5 배 앞을 조준하므로 스팬 밖(정착지 경계 너머)을 본다. 그래서
//   위치는 필지 옆인데 프레임은 빈 들판인 구간이 남는다(실측 nearD 5.4m · 원뿔 0/20).
// 처방은 축을 다시 고르는 것이 **아니다**: 축을 바꾸면 스팬이 짧아져 다른 규모(한양 중로 323m)의
//   코스까지 흔들린다. 대신 이미 있는 원뿔 척도를 고도에 연결한다 — 프레임에 건축이 없는 스테이션은
//   저공 대역에서 들어올려 "빈 구간은 높게, 빠르게 지나간다"(위 스윕 전이 주석과 같은 원리)로 만든다.
//   건축이 있는 스테이션에서는 need 가 -Infinity 라 **수치적으로 무변경**이므로, 스팬 전체가 밀집대인
//   규모(한양·도성·읍성 — 실측 최소 히트 6)는 이 항이 원리적으로 발동하지 않는다.
const FLY_OPEN_MIN_HITS = 3;
// 2026-08-02: 18 → 23. 이 값은 **스테이션 저작 고도**이고 최종 표본은 이웃 최대 → 3탭 평균 →
//   경유지 평활 → centripetal CR 새그를 차례로 지나며 내려앉는다(실측 저작 18 → 표본 중앙값 12.3).
//   계약(T23)이 재는 것은 표본이므로 저작에 그 낙차만큼 여유를 실어야 둘이 정합한다.
const FLY_OPEN_AGL = 23;                  // 개활 구간의 지면 기준 고도 하한(m)
const FRAME_ASPECT = 16 / 9;              // 수평 화각 파생용(프레임에 담기는 범위는 수평이 정한다)

// ── 투어 시간축 ──
// 호길이·시간 매핑 그리드. **프레임 간격보다 촘촘해야** 한다: 셀 안에서는 t 가 τ 에 선형이므로
//   셀 평균 속도만 w 에 맞고, 셀이 프레임보다 크면 제어점 knot 에서 원곡선의 매개속도 불연속
//   (centripetal CR 은 세그먼트별로 [0,1] 로 재매개되므로 인접 세그먼트 길이비만큼 |dP/dt| 가
//   튄다)이 그대로 프레임 속도에 나타난다(실측 프레임당 ±12m/s).
// 2026-08-01: 49152 로 올렸다. 한양처럼 투어가 길면(224s) 프레임당 τ 스텝이 셀 1.2개에 불과해
//   제어점 knot 에서의 매개속도 불연속이 프레임 속도로 새어 나왔다(실측 프레임당 6.65m/s).
//   셀을 프레임의 1/3 이하로 두면 knot 이 프레임 안에서 평균된다.
const TOUR_GRID = 49152;
// 리프트 이전 예비 매핑(방향 평활 커널 폭의 시간 기준 + 방향장 인덱싱). 방향장을 이 표로 읽으므로
//   표가 거칠면 조각선형 kink 가 각속도의 프레임간 변화로 나타난다(실측 15.4°/s).
const TOUR_GRID_A = 16384;
const TOUR_SPEED_MIN = 8.0;         // 평균 대지속도 하한(m/s) — 소규모에서 기어가지 않게
const TOUR_SPEED_MAX = 17.2;          // 상한 — 한양에서 항공기처럼 날지 않게(전이 피크 ×1.3)
const TOUR_SPEED_K = 0.06;         // 평균 대지속도 = clamp(R * K)
const TOUR_SEC_MIN = 62;
const TOUR_SEC_MAX = 233;

// ── 시선(짐벌) ──
// 시선은 목표**점** 곡선이 아니라 **방향장 + 프레이밍 거리**로 저작한다. 목표점을 보간하면 전이
//   구간에서 보간된 목표점이 카메라에 접근하고(실측 6~16m) 그 특이점에서 각속도가 150°/s 로
//   폭발한다. 방향으로 저작하면 그 특이점이 원리적으로 존재하지 않는다.
const DIR_GRID = 4096;
// 2026-08-01 5차: 0.85 → 1.05. 저공 구간이 빨라지면 같은 코스 곡률이 더 짧은 시간에 소비되므로 합성
//   각속도가 그만큼 오른다(실측 village 저공 23.5°/s, 계약 T3 상한 23). 저작 요 상한(AUTHOR_YAW_RATE)은
//   이미 w/w̄ 로 정규화돼 있어 자동으로 따라오지만, 시차·피치 성분은 따라오지 않는다. 짐벌 관성을 늘리는
//   쪽이 맞는 처방이다 — 무거운 짐벌은 빠른 기체에서 더 필요하고, 화면에서도 더 시네마틱하다.
const DIR_SMOOTH_SEC = 1.05;        // 짐벌 관성 — 이 폭의 Hann 창으로 방향장을 시간축에서 평활
// 스테이션 간 방향 변화 상한. 이를 넘으면 보간 스테이션을 끼워 넣는다(위치는 직선 보간, 방향은 slerp).
//   단위벡터를 Catmull-Rom 으로 보간하면 인접 방향이 크게 벌어진 구간에서 곡선이 원점 근처를 지나
//   정규화 후 엉뚱한 방향(실측: 거의 수직 하향 dy=-0.97)으로 튄다. 그 특이점을 원천에서 없앤다.
const MAX_STATION_TURN = 50 * DEG;
// 저작 단계 요 팬 상한(°/s)과 완화 반복. 전이 구간(골목 이탈 → 상승 리빌)의 요 스윙 총량은
//   시드·규모마다 크게 달라 고정 배분 램프로는 잡히지 않는다(실측 34~133°/s). 상한을 넘는 구간의
//   초과분만 이웃으로 넘겨 재분배한다 — 등속 선회·조준은 건드리지 않는다.
// 2026-08-01 3차 비전 D항: 실측 요 스파이크(한양 저공 30.5°/s · 마을 리빌 25.6 · 마을 진입 22.6)에 대해
//   "15°/s 근처 캡"이 지시됐다. 22 → 15 로 내렸다. 실측 결과 시선 각속도 max 가 전 규모 31.8 → 21.7°/s,
//   p99 26.4 → 19.0 이 되고 커버리지는 사실상 유지된다(capital 리빌 100%→97%, 그 밖 변화 없음).
//   13 까지 내리면 max 18.7 이 되지만 capital 리빌 커버리지가 87% 로, town 리빌이 96% 로 떨어져 조준이
//   눈에 보이게 뒤처진다 — 그 값은 리드에 수치로 보고했다.
// ── 이 상한이 규제하는 양(2026-08-01 4차, 선언·실측 정합) ──
//   이것은 **제어점 사이의 요(yaw) 팬 각속도** 상한이지 화면 각속도 상한이 아니다. 실제로 보이는 것은
//   요·피치·경로 유발 시차가 합쳐진 **합성 각속도**이고, 그 값은 (a) 잔차의 Catmull-Rom 오버슈트
//   (b) 피치 성분 때문에 항상 이 상한보다 크다. 4차에서 dt 추정의 w̄ 정규화 버그를 고쳐 둘의 간극이
//   실측 max 31.8 → 21.2°/s 로 좁혀졌다(p99 14.9~18.1). 합성 각속도를 직접 규제하는 것은 이 상한이
//   아니라 품질 계약 T3(max 23 / p99 20)이다 — 두 수치가 다른 것은 서로 다른 양이기 때문이며,
//   "15°/s 캡"이라는 표현은 이 저작 상한만을 가리킨다.
// ── 2026-08-02 (#42 R2) 15 → 19 ──
// 여정 문법에는 3차 비전 당시 없던 요구가 하나 생겼다: **플라이바이는 피사체를 프레임에 담은 채
//   지나가야 한다**(6차 비전 FIX ③). 최근접에서 필요한 팬은 pull·v/d 이고 마을 실측으로 11~13°/s 라
//   15° 상한과의 여유가 2°/s 밖에 없다. 그 여유로는 글라이드→플라이바이 전이의 요 수요를 흡수하지
//   못해 완화 패스가 초과분을 **플라이바이 안쪽으로 재분배**했고, 조준이 통째로 뒤처져 최근접
//   시선-피사체 이각이 58.1° 로 남았다(수평 반각 35.7° 밖 = 피사체가 프레임에 없다).
// 실측 스윕(완화 패스만 바꾸고 나머지 고정): 상한 15 → 이각 58.1° · 17 → 44.4 · 19 → 31.0 ·
//   21 → 29.8 · 완화 무효 → 26.7(= Hann 짐벌 관성만 남은 하한). 19 에서 반각 안으로 들어오고
//   21 이상은 개선이 0.1° 뿐이라 상한을 더 헐겁게 할 이유가 없다.
// **화면 각속도 계약(T3 max 23 / p99 20)은 그대로다** — 이 상한은 저작 단계의 요 팬 상한이고 T3 는
//   요·피치·시차의 합성 각속도를 재생 표본에서 다시 잰다(위 문단 참조). 완화가 아니라 저작 여유의
//   재배분이며, T3 가 실측으로 그것을 감시한다.
// ── 2026-08-02 (#42 R6) 위 R2 문단은 **적용되지 않았다**. 값은 15 그대로이고, 그래야 한다 ──
// R2 가 예고한 19 는 이 라운드에서 실제로 측정했고 T3 가 그것을 막는다. 스윕(이 상한만 바꾸고
//   나머지 고정, R6 소스): 19°/s 에서 플라이바이 최근접 이각은 확실히 좋아지지만(village/2026
//   51.8° → 27.1°) 시선 각속도가 여섯 픽스처에서 계약을 깬다 — p99 hamlet 21.6 · village 20.8 ·
//   town 22.4 · capital 21.1 · hanyang 20.7 · village/2026 20.4 (상한 20), max town 23.4 ·
//   hanyang 23.1 (상한 23). 반대로 13 · 11 로 내리면 완화가 떠안는 초과분이 커져 플라이바이
//   근단 절단이 -21.4% · -49.3% 로 무너진다. 15 는 그 두 벽 사이의 값이다.
// R2 문단은 기록으로 남긴다(그 라운드의 판단 근거였다). 값을 다시 올리려는 라운드는 위 T3 실측을
//   먼저 반증해야 한다.
const AUTHOR_YAW_RATE = 15 * DEG;
const YAW_RELAX_PASSES = 120;

// ── 안전 리프트 ──
// 그리드는 **호길이 균일**로 깐다(t 균일은 세그먼트 길이차 때문에 간격이 0.2~7m 로 벌어져 집 한 채가
//   격자 사이로 빠지고, 그 t 에서만 하드 안전망이 9m 를 들어올려 수직 텔레포트가 된다 — 실측).
// 2026-08-01 5차: 0.8 → 0.45. 리프트 격자 사이의 잔차는 **하드 안전망**이 한 프레임에 메우고, 그
//   한 프레임짜리 수직 계단이 프레임 속도 점프로 나타난다(실측 hamlet: y 17.65 가 3프레임 유지되다
//   0.18m 계단 → 수직 속도 -11m/s, 프레임 점프 3.97m/s). 저공 구간이 빨라질수록 같은 계단이 더 큰
//   점프가 되므로(점프 ∝ 속도) 격자를 프레임 이동거리 아래로 내린다: 저공 최고 속도 30m/s 에서
//   프레임 이동은 0.5m 이므로 0.45m 격자면 계단이 항상 격자에 먼저 잡힌다.
const LIFT_SPACING = 0.45;          // 목표 간격(m)
const LIFT_GRID_MIN = 1024;
const LIFT_GRID_MAX = 12288;
const LIFT_RAMP_T = 0.02;           // 투어 길이의 2% 로 확산(100s 투어에서 2s)
const LIFT_MARGIN = 0.45;           // 사용처 주석에 근거(격자 사이 잔차 흡수 → 하드 안전망 무발동)
// 2026-08-02: 2.5 → 4.5 / 1.0 → 2.0. 요구량은 **리프트 격자**(τ_A 표) 위에서 풀고 적용은 주기 확산
//   뒤의 **곡선 표본**에서 일어나므로, 두 표를 왕복하는 보간 오차와 CR 새그가 1m 안팎 남는다. 수관
//   여유는 y 를 r/ry(≈3.9배)로 늘려 재는 양이라 그 1m 가 계약값 -3.8 로 증폭돼 보인다. LIFT_MARGIN 이
//   지형·지붕 잔차에 대해 하는 일을 수관에도 똑같이 해 준다 — 임계 완화가 아니라 저작 여유다.
const CANOPY_CLEAR = 4.5;           // 수관 상단 위 기본 여유
const CANOPY_MARGIN = 2.0;          // 정확 해에 얹는 여유(그리드 보간 오차 흡수)
const CANOPY_SCAN = 48;             // 정확 해 선형 스캔 단계

// ── 여정(journey) 문법 ── 2026-08-02, 3차 전면 재설계(#42).
// 종전 두 판은 모두 **샷 타입의 연쇄**였다: 크레인 장면 → 선회 장면 → 거리 장면 → 후퇴 장면. 이음새를
//   아무리 매끄럽게(C¹·속도 연속·컷 0) 만들어도 사용자 판정은 "장면 전환"이었다. 문제는 이음새의
//   수학이 아니라 문법이었고, 그중 **오빗이 가장 큰 배신자**다 — 피사체를 도는 순간 카메라가
//   "촬영 중"이 되고 여정이 끊긴다.
// 새 문법의 한 줄: **카메라는 감독이 아니라 파일럿이다.** 모든 프레이밍은 비행에서 발생하고, 비행은
//   목적지가 있는 한 줄기 여정이다. 그래서 저작하는 양 자체가 바뀐다:
//     종전  (피사체, 피사체 주위 방위, 절대 고도, 프레임 피치)
//     현행  (경유지, 지표·지붕 위 **클리어런스**, 진행 방향)
//   고도가 저작 절대값이 아니라 클리어런스이므로 능선을 넘을 땐 낮게 스치고 계곡으로 활강하며
//   지붕 바다 위를 일정 높이로 흐른다 — 지형 추종(terrain-hugging)이 파생 결과가 아니라 정의다.
// **오빗은 문법에서 삭제됐다.** 랜드마크는 도는 것이 아니라 넓은 호로 스쳐 지나간다(flyby): 프레임에
//   들어와 커지고, 지나치며 시선이 자연히 따라가다 놓아준다. 정지·정점 체류·station-keeping 없음.

// 진행 축 = 태양 방위. 카메라가 backAz 쪽에서 중심을 향하면 진행 방위가 정확히 sunAz 이므로
//   (backAz = sunAz + π) "태양을 향해 난다"가 경유지 배치에서 자동으로 성립한다. 앱 기본 sunset
//   역광이 셀링 포인트이므로 여정의 주 방향이 그 밴드를 물게 두는 것이 look 계약이기도 하다.
const RUN_AZ_JITTER = 9;            // 진행 축의 시드 변주(°) — 밴드 안에서만 흔든다
const APPROACH_R = 1.48;            // 진입 시작 반경 = R × 이 값(분지 밖에서 들어온다)
// 여정이 지형 메시 안에 머무는 비율. 이보다 밖은 worldedge 안개라 "지면 위를 난다"가 성립하지 않는다.
const TERRAIN_KEEP = 0.93;
const APPROACH_PITCH = 15 * DEG;    // 원경 진입 프레임 피치(와이드 — 능선·태양이 상단 밴드에 남는다)
const APPROACH_RIDGE_NDC = 0.62;    // 진입 첫 프레임에서 주산 능선이 앉는 화면 세로 위치(NDC)
const APPROACH_FOV = 38;
const APPROACH_STEPS = 3;

// ── 지형 추종(terrain-hugging) ── 고도는 절대값이 아니라 **지표·지붕 위 클리어런스**로 저작한다.
//   같은 상수가 외딴집(R30)에서도 한양(R520)에서도 같은 비행 성격을 만든다 — 지표가 규모를 안다.
const AGL_VALLEY = 12;              // 계곡 활강·개천 통과의 지면 위 고도(m)
const AGL_VALLEY_ROOF = 5.0;        // 그 구간이 지붕을 만나면 지붕 위로 이만큼
const AGL_CLIMB = 22;               // 산비탈 등반 — 사면 위 이 높이를 유지하며 따라 오른다
const AGL_CREST = 27;               // 능선 마루 통과 여유
const AGL_RETURN = 34;              // 복귀 호의 지표 위 하한(능선 밴드 하한과 max 로 합성)
const VALLEY_STEPS = 5;
const CLIMB_STEPS = 6;
const RETURN_STEPS = 6;
// 등반 중 중심 쪽 시선 혼합 램프(2026-08-02 #42 R3, A항). 사용처 주석에 근거·실측.
//   양 끝은 이웃 비트와 잇는다: 플라이바이 꼬리 실효 pull 0.444 → 등반 → 복귀 머리 pull.
const CLIMB_CENTRE_PULL = [0.30, 0.38, 0.44, 0.48, 0.50, 0.48];
// 인접 경유지 세그먼트 길이비 상한(2026-08-02 #42 R3). 사용처 주석에 근거·실측.
const SEG_RATIO_MAX = 1.8;

// ── 플라이바이 ── 랜드마크를 도는 대신 **옆으로 지나간다**. 저작하는 것은 측면 이격(stand-off)과
//   통과 고도뿐이고, "커졌다가 놓아준다"는 피사체 성장률은 그 기하에서 파생된다(저작하지 않는다).
// FLYBY_PULL 이 이 문법의 안전핀이다: 시선이 진행 방향에서 피사체로 끌리는 **최대** 비율이며 1.0 이
//   곧 오빗(피사체 고정)이다. 0.62 면 최근접에서도 진행 방향 성분이 우세해 피사체가 프레임을
//   가로질러 흘러간다 — 그것이 "스쳐 지나간다"의 수치 정의다.
// 12° 인 이유: 통과는 수평 비행이라 프레임 피치가 가장 서는 비트인데, 그러면 상단 하늘이 프레임의
//   37% 를 먹는다(실측, sky = (1 - tan p / tan(fv/2))/2). 이 값이 그 비율을 20% 대로 내리고, 동시에
//   피사체를 프레임 위쪽으로 밀어 근단 절단 여유도 함께 벌어준다.
// 2026-08-02 (#42 R2): 12 → 19. 이 값은 하늘 비율만 정하는 것이 아니라 **측면 이격을 지배한다**.
//   이격 해는 d = halfSpan + rise / tan(framePitch + atan(tv·(1-2·BOTTOM_SOLVE))) 이고 rise 는
//   통과 고도(= 피사체 전고 × FLYBY_EYE)라 규모와 무관하게 14~21m 다. 12° 에서는 limit 이 14.5° 밖에
//   되지 않아 마을 이격이 82m 로 풀렸고(실측), 그 이격에 종방향 리드(이격×1.5)까지 붙으면서 통과선이
//   시가지 반경(필지 p90 85m)의 두 배 밖으로 나갔다 — τ0.37~0.59 에 마을이 프레임에서 사라진
//   6차 비전 FIX ①의 기하적 원인이 이것이다. 19° 면 같은 식에서 limit 25.1° · 이격 51m 로 통과선이
//   직물 안에 들어오고, 하늘 비율은 오히려 **내려간다**(피치가 서면 지평선이 위로 올라간다).
//   상한은 T13 플라이바이 대역(3~20°)이고 19° 는 저작 기본값이라 pull 혼합 뒤 median 은 그보다 낮다.
const FLYBY_PITCH = 19 * DEG;
const FLYBY_FOV = 40;
// 2026-08-02 (#42 R2): 0.20 → 0.10. 리드룸은 최근접 이각에 그대로 더해진다(fov 26 에서 4.7°).
//   아래 in-frame 조건이 그 각을 실제 예산으로 세게 되면서, 리드룸이 클수록 필요한 렌즈가 넓어져
//   피사체가 오히려 작아진다. 리드룸은 구도 장치이지 예산을 먹을 자리가 아니라 절반으로 줄인다.
const FLYBY_LEAD = 0.10;            // 최근접에서 피사체를 화면 가로 NDC 로 밀어내는 양(리드룸)
// 0.78 인 이유는 기하다. 최근접에서 피사체 방위는 진행 방위에서 90° 떨어지므로, 남는 각은
//   (1-pull)·90° 다. 0.62 면 34.2° 로 수평 반화각(fov40 에서 32.9°)을 **넘어** 피사체가 최근접
//   순간에 프레임 밖으로 나간다(실측: 플라이바이 구간 피사체 커버리지 24%, 하단 여백 -306%).
//   0.78 이면 19.8° 라 프레임 안에 온전히 남고, 그때 화면 가로 위치는 ±0.56 을 오가므로 진폭이
//   1.12 — 오빗 판정 문턱(0.70)의 1.6배다. 즉 **프레임에 담기면서도 못박히지 않는다**.
// 2026-08-02 (#42 R2): 0.78 → 0.86. 위 계산은 옳았지만 **그때 쓰던 렌즈가 아니었다**: 화각 선택이
//   가로 점유를 최대화하느라 항상 가장 좁은 후보(26°)로 수렴했고, 그 렌즈의 수평 반각은 22.3° 라
//   0.78 의 잔여 34.2° 는커녕 19.8° + 리드룸 4.7° 도 담지 못했다. 실측 최근접 시선-피사체 이각은
//   전 픽스처 23.7~78.4° 로 **모두 화각 밖**이었다(하단 여백 -886%·가로 점유 5698% 같은 특이값은
//   깊이가 0 에 붙은 투영이다). 처방은 둘이다: ① 아래 flybySolveAt 의 in-frame 조건으로 화각이
//   잔여각을 감당하게 하고 ② 잔여각 자체를 줄인다. 0.86 의 잔여는 12.6° 라 fov 40 의 반각 32.9° 안에
//   피사체 반각까지 얹고도 남는다. 오빗 문턱은 T24 가 **감긴 각**(80°)으로 재므로 이 값과 무관하다 —
//   실측 감김은 18~69° 로 여유가 크고, 직선 통과라 거리 조건 ③이 먼저 끊는다.
const FLYBY_PULL = 0.74;
// 통과 진행률별 끌림(대칭 아님 — 놓아주는 쪽이 빠르다).
// 2026-08-02 (#42 R2) 재저작: 종전 [0.26,0.52,0.84,1.0,0.72,0.38,0.14] 은 **저작 요 각속도 상한을
//   스스로 깨는 램프**였다. 시선 방위는 base + pull·(bearing - base) 이므로 스테이션 간 요 변화에는
//   ① 방위각 변화(최근접에서 2·atan(간격/2d) ≈ 19~22°) 와 ② **pull 변화 × 잔여 이각**(0.28 × 60° ≈ 17°)
//   두 항이 있고, 종전 램프는 ②만으로 상한을 넘겼다. 넘긴 초과분은 완화 패스가 이웃으로 재분배하므로
//   조준이 통째로 **뒤처지고**, 그 결과 최근접 프레임의 시선-피사체 이각이 59~72° 로 남았다(실측
//   village 59.2° · town 52.2° — 수평 반각 35.7/40.9° 밖). 심하면 램프 꼬리에서 요가 **역전**한다
//   (village i39→i41 에서 az 175.7→153.4 인데 bearing 은 229→256 으로 반대 방향).
//   최근접 근방을 평평하게 두면 ②가 사라져 요 변화가 방위각 변화만 남고, 그것은 상한 안이다.
//   "다가와 커졌다가 지나치며 놓여난다"는 성격은 꼬리의 하강(0.86→0.52)이 그대로 유지한다.
//   램프의 최고점은 반드시 1.0 이다 — FLYBY_PULL 이 "최근접에서의 끌림"이라는 선언과
//   램프 최고점이 어긋나면 실효 pull 이 조용히 내려간다(0.86 으로 두었더니 실효 0.688).
const FLYBY_PULL_RAMP = [0.55, 0.80, 0.95, 1.0, 0.97, 0.84, 0.60];
const FLYBY_STANDOFF_K = 1.35;      // 측면 이격 = 피사체 반경 × 이 값(하한)
const FLYBY_WIDTH_TARGET = 0.34;    // 최근접에서 피사체가 프레임 가로에서 차지할 목표 비율
// 1.15 = 용마루보다 조금 위. 0.72(피사체 중심 근처)로 두면 시선이 거의 수평이 되어 (a) 상단 하늘이
//   프레임의 38% 를 먹고 (b) 근단 하강각이 프레임 하단을 넘는다 — 둘 다 같은 원인(피사체 깊이각이
//   거의 0)에서 나온다. 조금 위를 지나면 두 지표가 함께 풀리고, "옆을 스쳐 간다"는 성격은 측면
//   이격이 지킨다(위로 넘어가는 부감이 되려면 이격이 고도보다 작아져야 하는데 그 반대다).
const FLYBY_EYE = 1.15;
// 7 인 이유는 지형 추종이다. 5 점이면 리드 구간에서 제어점 간격이 87m 가 되어, 그 사이에서 지표가
//   오르면 카메라 고도는 직선인데 AGL 이 12m → 3m 로 꺼진다(실측 p05 3.2m). 간격을 지형 기복 스케일
//   아래로 내리면 저작 클리어런스가 표본에서도 성립한다.
const FLYBY_STEPS = 7;
// 이격 해에 쓰는 하단 여백 — 계약 하한(5%)이 아니라 그보다 큰 값이다. 저작 고도는 최종 고도가 아니기
//   때문이다: 경유지 3탭 평활이 통과 고도의 첨점을 깎고 centripetal CR 이 제어점 사이에서 새그를
//   만들어, 실제 최근접 프레임은 저작보다 더 눕는다(실측 저작 9.8° vs 표본 8.2° → 여백 -17%).
//   해에 여유를 실어 그 차이를 흡수한다.
const FLYBY_BOTTOM_SOLVE = 0.27;
// 피사체 덩어리 비율 — 필지(plot)에는 곽담·마당이 포함되어 실제로 읽히는 건축 덩어리는 그보다 작다.
const SUBJECT_MASS = 0.72;

// ── 복귀 호 ── 능선을 넘은 뒤 분지 바깥을 크게 돌아 진입점으로 돌아온다. 이것이 루프를 닫는 방식이며,
//   "되감기"가 아니라 **상승 이탈 후 넓게 선회해 돌아오는** 실제 드론 코스다. 시선은 진행 방향을
//   주로 하고 중심 쪽으로 조금씩 더 끌려 마지막에 진입 시선과 만난다(이음매 연속).
const RETURN_PITCH = 17 * DEG;
const RETURN_FOV = 46;              // 광각 — 여정의 결말은 계곡 전경이다
// 2026-08-02 (#42 R2, 6차 비전 FIX ②): 램프 전체를 앞당긴다. 실측 sb-village-24(τ≈0.89)에서 좌측
//   60% 가 빈 산비탈이고 마을이 우측 가장자리였다 — 복귀 **호 길이**가 아니라 시선 배분 문제이므로
//   호를 늘리지 않고(금지된 축) 중심 혼합만 올린다. 진행 방향 성분은 여전히 남으므로(최대 0.88)
//   "돌아오는 길"의 이동감은 유지된다.
const RETURN_CENTRE_PULL = [0.40, 0.54, 0.68, 0.80, 0.90];   // 중심 쪽 시선 혼합 램프
// 복귀 호가 도는 방위각. **저작값에서 기하를 파생**한다(기하에서 각을 재고 부족하면 한 바퀴 더 주는
//   방식은 실측이 기각했다 — 113° 가 최소 120° 에 못 미치자 -473° 가 되어 복귀가 투어의 67% 를
//   먹었다, 마을 실측 투어 213s·복귀 142s). 진입 방위에서 이 각만큼 되돌아간 자리가 복귀 시작점이고,
//   크레스트는 거기서 다시 RETURN_ENTRY_ARC 만큼 앞이다. 그래서 능선을 **어깨**로 넘게 된다 —
//   정상은 넘는 자리가 아니고, 어깨로 넘으면 복귀 호도 짧아진다.
// 132° 는 과했다: 큰 규모에서 복귀 호가 투어 시간의 46~55% 를 먹어 저공 비트가 통째로 희석됐다
//   (한양 실측 복귀 54.8% · 글라이드 12.2%). 여정의 무게는 마을 위에 있어야 하므로 귀로를 줄인다.
const RETURN_SWEEP = 106 * DEG;
const RETURN_ENTRY_ARC = 22 * DEG;  // 등반이 크레스트에 닿을 때 이미 감겨 있어야 하는 위상
const CREST_SCAN = 18 * DEG;        // 크레스트 후보 스캔 반폭(가장 높은 지점을 고른다)
const RETURN_R1 = 1.05;             // 복귀 종단 반경 = 진입 반경 × 이 값

// ── 근접도 연동 속도 ── 지각 속도는 대지속도가 아니라 **시차**(v / 근접물 거리)다. 종전은 이것을
//   구간 상수 열 개(W_CRANE·W_ORBIT·W_SWEEP…)로 저작했는데, 고도가 지형을 따라 변하는 순간 그 표와
//   실제 근접도가 어긋난다. 이제 속도 가중을 **클리어런스의 함수로 유도**한다: 낮게 날수록 빠르다.
//   한 줄이 표 열 개를 대체하고, 지형 추종과 속도 서사가 구조적으로 정합한다.
// 램프는 **로그**다. smootherstep 을 절대 미터에 걸었더니 0 근처가 너무 평평해 실제로 쓰이는
//   클리어런스 대역(12~80m)이 전부 최고 속도 쪽에 몰렸고, 투어 속도 스프레드가 1.60 까지 떨어졌다
//   (실측). 시차는 1/거리라 로그가 지각과도 맞는 축이다. 상한은 절대값이 아니라 **규모 종속**이어야
//   한다 — 마을(Hmax 52)에서 135m 클리어런스는 존재하지 않으므로 상수 상한은 도달하지 않는다.
// ── 2026-08-02 (#42 R4) 절대 바닥 85m 폐지 → 저작 천장(AGL_RETURN)과 규모 항으로 ──
// 바로 위 문단이 이미 선언한 원리("상한은 절대값이 아니라 규모 종속이어야 한다 — 존재하지 않는
//   클리어런스를 상한으로 두면 램프가 그 위쪽에 닿지 않는다")를 **작은 규모에도 일관되게** 적용한다.
//   종전의 절대 바닥 85m 는 그 선언과 모순이었다: 외딴집(Hmax 18)·초락(Hmax 30)의 투어에 실제로
//   나타나는 클리어런스는 최대 37m·42m 이라 램프의 위쪽 40% 가 통째로 쓰이지 않았고, 속도 가중이
//   1.52~0.84 대역에 눌려 투어 속도 스프레드가 2.08·2.29 에 고정됐다(계약 T20 하한 3.0).
// 식의 **형태**는 파생이다: 바닥 = 저작이 만드는 최고 클리어런스(복귀 호 하한 AGL_RETURN), 규모 항 =
//   지형 기복 Hmax, 상한 = 종전 램프가 이미 쓰던 큰 규모 값. 계수 1.45 와 상한 95 는 **실측 스윕**으로
//   골랐다(K = 1.00 / 1.35 / 1.45 / 1.65 를 전 픽스처 게이트로 돌려 비교): 1.45·cap95 는 마을·도성·
//   한양의 램프를 사실상 종전 값에 두면서(마을 85 → 75.4 · 도성 85 → 95 · 한양 95.2 → 95) 외딴집
//   85 → 34 · 초락 85 → 43.5 로 작은 규모만 실제 대역에 맞춘다. 실측 스프레드 외딴집 2.08 → 4.15 ·
//   초락 2.29 → 3.0+ · 마을 3.23 → 3.2 대(불변) — 즉 큰 규모의 속도 서사는 건드리지 않는다.
const PROX_NEAR = 10;               // 이 클리어런스(m) 이하는 최고 속도
const PROX_FAR_K = 1.45;            // 상한 = clamp(Hmax × 이 값, [AGL_RETURN, PROX_FAR_CAP])
const PROX_FAR_CAP = 95;            // 큰 규모의 램프를 종전 값에 묶어 두는 상한(위 주석)
const W_PROX_NEAR = 1.52;
const W_PROX_FAR = 0.40;
// 연출 계수 — 유도된 속도에 곱한다. 여정에서 "보여 주는" 순간(크레스트·리빌)은 느리고, 볼 것이 없는
//   이동은 빠르다. 이것만이 저작 상수이고 나머지는 전부 기하에서 나온다.
const W_CREST = 0.60;
// 2026-08-02 (#42 R2): 0.90 → 0.62. 플라이바이의 조준 팬 속도는 pull·v/d 이고, 직물 안으로 들어온
//   이격(52~150m)에서 v 를 낮추지 않으면 그 값이 저작 요 상한을 넘어 완화 패스가 조준을 뒤로
//   밀어낸다(실측 최근접 이각 31~94°). 랜드마크를 지날 때 속도를 죽이는 것은 연출로도 맞고
//   (여정에서 "보여 주는" 순간은 느리다 — W_CREST 와 같은 원리), 기하 제약을 만들지 않는다.
const W_FLYBY = 0.78;
const W_TRANSIT = 0.88;
// 복귀 호는 **귀로**다. 클리어런스가 크니 유도 속도는 이미 낮고, 거기에 연출 계수까지 낮추면 복귀
//   하나가 투어 시간의 절반을 먹는다(실측). 앞부분은 이동으로 빠르게, 마지막 30% 만 리빌 속도로 눕힌다.
// 1.75 는 과했다 — 유도 속도 0.91 에 곱해 1.59 가 되면서 지붕 글라이드(1.52)보다 **빨라졌고**,
//   클리어런스↔속도 상관이 +0.58 로 뒤집혔다(실측). 근접도 서사가 깨지지 않는 범위에서만 올린다.
const W_RETURN = 1.55;
const W_RETURN_TAIL = 0.70;
// 등반의 하강 기울기 상한(수평 1m 당 m). 사면 안부를 따라 내려가되 절벽처럼 떨어지지는 않는다.
const CLIMB_DROP_SLOPE = 0.20;

// ── 짐벌 문법 ── 피치가 고도 변화를 **선행**한다(다이브 전 틸트다운). 다음 세그먼트의 경로 기울기를
//   보고 피치를 미리 눕히므로, 실기 조종에서 짐벌이 기체보다 먼저 움직이는 것과 같은 순서가 된다.
//   수평선 안정은 뱅킹(아래 ROLL_*)이 담당하고, 시선은 진행 방향 기반이다.
const PITCH_LEAD_GAIN = 0.85;       // 경로 기울기각 → 프레임 피치 반영 비율(하강)
// 상승에는 같은 이득을 쓰지 않는다. 다이브 전 틸트다운은 실기 문법이지만 **등반 중 틸트업은 아니다** —
//   사면을 오르는 드론은 짐벌을 지형에 물린 채 오르고, 시선을 들면 프레임이 하늘로 차 버린다
//   (실측: 대칭 이득에서 등반 피치가 하한 3° 에 붙고 상단 빈 하늘이 44%).
// 2026-08-02 (#42 R2): 0.35 → 0.12. 플라이바이가 직물 안에서 끝나면서 등반 기울기가 가팔라졌고,
//   같은 이득이 등반 피치를 6.9° 까지 내려 상단 빈 하늘이 35% 가 됐다(T13 상한 40% 를 투어 최대
//   44% 로 넘긴 원인). 위 주석이 이미 "등반 중 틸트업은 실기 문법이 아니다"라고 적은 방향이라
//   값을 그 선언에 맞춘다 — 사면을 오르는 드론은 짐벌을 지형에 물린 채 오른다.
const PITCH_LEAD_UP = 0.12;
const PITCH_FLOOR = 3 * DEG;
const PITCH_CEIL = 34 * DEG;

// ── 뱅킹(롤) ── 2026-08-01 5차에서 유도식(조화 선회 tan φ = v·ω/g)을 세웠고 그것은 문법과 무관하게
//   옳으므로 그대로 이월한다. 저작 상수가 아니라 궤적에서 유도되므로 직선은 자동으로 0 이고, 곡률이
//   큰 저공에서만 기울며, 속도를 올리면 같은 곡률에서 더 눕는다.
// ROLL_GAIN 은 의도된 촬영술적 과장이다(실기체 배율 1.0). 과장은 v·ω 비례를 깨지 않도록 **atan 안쪽**에
//   넣는다: 작은 각에서는 선형 배율, 큰 각에서는 자연 포화.
const ROLL_GAIN = 1.0;
const ROLL_G = 9.81;
const ROLL_MAX = 24 * DEG;
// 롤 시정수 — 실기체 짐벌·자세 루프가 이 정도로 눕는다. 이보다 짧으면 곡률 잡음이 롤 떨림으로 새고,
//   길면 뱅크가 선회보다 늦게 도착해 어색하다. 주기 Hann 창이라 이음매에서도 연속이다(T1).
// 2026-08-02 (#42 R2): 1.0 → 1.15. 여정 기하가 바뀌면서(플라이바이가 직물 안 현으로 들어오고 등반이
//   가팔라졌다) 곡률 첨점이 늘어 마을 픽스처의 롤 프레임 잔차가 0.122° 로 떨어짐 계약(POSE-3, 0.1°)을
//   넘겼다. 롤은 궤적에서 유도되므로 유도식이 아니라 **짐벌 시정수**로 흡수하는 것이 맞는 자리다.
const ROLL_SMOOTH_SEC = 1.45;
const ROLL_GRID = 2048;
// 롤 권한(비트별) — 같은 물리식에 곱하는 연출 계수다. 인덱스 = leg 태그(아래 LEGS 순서).
//   원경 진입·복귀 호는 와이드 establishing 이라 더치 앵글이 되면 안 되고(권한을 낮춘다), 계곡 활강·
//   지붕 글라이드·플라이바이는 뱅크가 속도감의 본체다.
const ROLL_AUTHORITY = [0.50, 0.92, 1.0, 1.0, 0.86, 0.60];
// 롤 각속도 상한(°/s). 화면 수평선이 이보다 빨리 돌면 뱅크가 아니라 흔들림으로 읽힌다.
// **구현은 확산이 아니라 원뿔(슬루) 제한이다.** 확산형(총합 보존) 리미터는 좁고 높은 첨점을 깎는 대신
//   넓은 고원으로 퍼뜨려 상승 에지 기울기를 그대로 남긴다(실측 저공 120°/s). 원뿔 제한은 값을
//   **줄이기만** 하므로 첨점이 낮아지면서 에지 기울기도 함께 내려간다.
const ROLL_RATE_MAX = 11 * DEG;

// ── 미세 접힘 가드 ── 사용처 주석에 근거. 반전 문턱은 저작된 큰 전환보다 낮게 두되 길이 조건
//   (max(8, R*0.06))이 그것을 걸러 내므로 안전하다.
const FOLD_TURN = 118 * DEG;
// 되꺾임 문턱 — 이보다 큰 반전은 길이와 무관하게 병리다(사용처 주석에 근거·실측).
const FOLD_REVERSE = 155 * DEG;
const FOLD_PULL = 0.7;
const FOLD_PASSES = 4;

// ── 프레임 기하 ──
// 부감 계열의 시선은 "어떤 점을 본다"가 아니라 **피사체를 화면 어디에 놓는가**로 저작한다.
//   깊이 δ(피사체 하강각)에 있는 대상은 NDC y = -tan(δ - p)/tan(fv/2) 에 맺힌다. 그래서
//     p = δ + atan(yTarget·tan(fv/2))  … 피사체를 yTarget 에 놓는 프레임 피치
//     δ = p - atan(yTarget·tan(fv/2))  … 그 피치를 만드는 고도/거리 비
const AERIAL_Y_TARGET = -0.08;      // 피사체 중심의 화면 세로 위치(NDC, 음수 = 중앙보다 아래)
// 원경 진입 첫 스테이션의 같은 값. 사용처(far-approach pushWp) 주석에 근거·실측.
const APPROACH_Y_TARGET = -0.72;
// 와이드 프레임에서 능선(=안개 지평선)이 놓일 화면 세로 위치(NDC). 능선이 카메라보다 **위**에 오면
//   프레임 상단을 채워 top-down 지도 인상이 된다.
const WIDE_RIDGE_NDC = 0.84;
// 주 피사체 프레임 배치 — 하단 여백 하한과 세로 점유 하한(프레임 비율). 플라이바이 이격이 이 조건에서
//   파생된다. 품질 계약이 같은 수치를 독립적으로 다시 잰다.
const SUBJECT_BOTTOM_MARGIN_MIN = 0.05;
const SUBJECT_HEIGHT_MIN_FRAC = 0.12;
// 저공 패스 화각 — 42° 는 근경 담·기와 덩어리의 접지선이 하단 밖으로 잘렸다(2차 비전: 마을 8장 중 6장).
//   화각을 넓히면 같은 피치·고도에서 최전경 접지선이 프레임 안으로 들어오고 전경 와이프도 살아난다.
const FLY_FOV = 56;
// 저공 코스가 "필지 띠 안쪽"이어야 한다 — 스팬 표본에서 건물 볼륨이 이 거리 안에 있는 비율(전경 와이프).
const HUG_R = 15;

// ── 축(스윕·골목) 선택 ──
const AXIS_CANDIDATES = 12;         // 프로파일링할 도로 후보 상한(비용 상한, 결정론적 정렬)
const AXIS_MIN_LEN = 44;
// 지붕 글라이드 축이 실제로 지붕 위를 지나야 하는 표본 비율(반경 18m 원판에 민가 지붕이 있는 비율).
//   이 아래면 도로 대신 합성 축(시가지 관통)을 쓴다.
const GLIDE_ROOF_MIN = 0.5;
const AXIS_TARGET_LEN = 170;        // 길이 보너스 포화 — 프레임 내용이 길이를 이기게
const AXIS_SIDE_OFFSETS = [0, 14 * DEG, -14 * DEG, 24 * DEG, -24 * DEG];
// 프레임 안 무특징 지면 — 지면 표본이 건축에서 이 거리보다 멀면 "특징 없음"으로 본다. 저공 코스
//   채점에 이 비율을 넣는다(2026-08-01 비전: 프레임 60% 가 특징 없는 지면이던 구간이 있었다).
const BARE_R = 12;
// 하드 컷은 두지 않는다 — 후보를 걸러내면 한양에서 365m 소로(밀집·저공 유지)가 탈락하고 99m 중로가
//   뽑혀 저공 표본이 32%→21% 로 떨어졌다. 곱셈 감점만으로 선택을 기울인다.
const BARE_PENALTY_POW = 1.5;

// 필지 유형별 지붕 상단 높이 추정(m). adapter buildProxies 의 H 와 동일 축척.
const parcelRoofH = (p) => (p.hero ? 14 : (p.kind === 'giwa' ? 9 : 6.5));
const facingY = (dir) => (dir ? Math.atan2(dir.x, dir.z) : 0);

// ── 장애물(건물 볼륨) ── 필지·궁·절을 회전 바운딩박스(OBB) + 지붕 상단 y 로. 드론 경로 생성과
//    검증이 이 단일 정의를 공유(계약면). world 매핑은 parcelMatrix/buildProxies 규약과 정합:
//    (wx-cx, wz-cz) = (lx·cos + lz·sin, -lx·sin + lz·cos).
export function buildObstacles(plan, heightAt) {
  const H = typeof heightAt === 'function' ? heightAt
    : (plan && plan.site && plan.site.heightAt) || (() => 0);
  const obs = [];
  // tag: 'parcel' | 'palace' | 'temple' — 저공 고도 기준선은 기념 건축(궁·절)을 제외한다.
  //   포함하면 궁 접근 구간에서 이동평균이 +18m 지붕을 물어 카메라가 민가 위 8m 로 떠오른다.
  const add = (cx, cz, bw, bd, rotY, top, tag) => {
    obs.push({
      cx, cz, hw: bw * 0.5 * FOOT_PAD, hd: bd * 0.5 * FOOT_PAD,
      cos: Math.cos(rotY), sin: Math.sin(rotY), top, tag: tag || 'parcel',
    });
  };
  for (const p of (plan.parcels || [])) {
    let bw = p.plotW, bd = p.plotD, lcx = 0, lcz = 0;
    const pts = p.shape && p.shape.pts;
    if (pts && pts.length >= 3) {
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (const q of pts) { if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x; if (q.z < mnz) mnz = q.z; if (q.z > mxz) mxz = q.z; }
      bw = mxx - mnx; bd = mxz - mnz; lcx = (mnx + mxx) / 2; lcz = (mnz + mxz) / 2;
    }
    const rotY = facingY(p.frontDir) + (p.yaw || 0);
    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    const wcx = p.center.x + lcx * cos + lcz * sin;
    const wcz = p.center.z - lcx * sin + lcz * cos;
    const baseY = (p.baseY != null) ? p.baseY : H(p.center.x, p.center.z);
    add(wcx, wcz, bw, bd, rotY, baseY + parcelRoofH(p), 'parcel');
  }
  const f = plan.features || {};
  if (f.palace) add(f.palace.x, f.palace.z, f.palace.plotW || 60, f.palace.plotD || 90, facingY(f.palace.frontDir), H(f.palace.x, f.palace.z) + 18, 'palace');
  if (f.temple) add(f.temple.x, f.temple.z, 40, 40, 0, H(f.temple.x, f.temple.z) + 13, 'temple');
  return obs;
}

// (x,z) 에서 가장 가까운 건물 볼륨까지의 수평 거리(안이면 0). 프레임 안 "무특징 지면" 판정의 단일
//   정의다 — 원판 히트 수로 대신하면 집에서 8m 떨어진 노면이 전부 무특징으로 잡힌다.
export function obstacleDistance(obs, x, z) {
  let best = Infinity;
  for (const o of obs) {
    const dx = x - o.cx, dz = z - o.cz;
    const lx = Math.abs(dx * o.cos - dz * o.sin) - o.hw;
    const lz = Math.abs(dx * o.sin + dz * o.cos) - o.hd;
    const d = (lx <= 0 && lz <= 0) ? 0 : Math.hypot(Math.max(0, lx), Math.max(0, lz));
    if (d < best) best = d;
  }
  return best;
}

// (x,z) 위에 있는 건물의 최고 지붕 상단 y(없으면 null).
export function roofTopAt(obs, x, z) {
  let top = -Infinity;
  for (const o of obs) {
    const dx = x - o.cx, dz = z - o.cz;
    const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
    if (Math.abs(lx) <= o.hw && Math.abs(lz) <= o.hd && o.top > top) top = o.top;
  }
  return top > -Infinity ? top : null;
}

// ── 수관(보호수) 볼륨 ── plan.features.guardianTrees 만이 계획 단계에 존재하는 유일한 수목 소스다.
//   마당 과실수(gardens.js yardTreeAnchors)는 렌더 시점에 tree-rng 로 결정되므로 plan 에 없다 —
//   외부에서 그 앵커를 얻은 호출자는 createDronePaths({ canopies }) 로 같은 형식으로 덧붙일 수 있다.
//   형상은 gardens.js 의 우산형 수관과 정합: 전고 h = 14*scale, 중심 h*0.72, 수평 반경 radius,
//   수직 반경 h*0.26 인 편평 타원체.
export function buildCanopies(plan, heightAt) {
  const H = typeof heightAt === 'function' ? heightAt
    : (plan && plan.site && plan.site.heightAt) || (() => 0);
  return ((plan.features && plan.features.guardianTrees) || []).map((g) => {
    const ground = H(g.x, g.z);
    const h = 14 * (g.scale || 1);
    return { x: g.x, z: g.z, y: ground + h * 0.72, r: g.radius, ry: h * 0.26, top: ground + h };
  });
}

// 선분(카메라→타깃)과 수관 타원체의 최소여유. 음수면 시선이 잎을 지난다.
//   y 를 r/ry 로 늘려 구 문제로 환원한 뒤 선분-점 최소거리.
export function segmentCanopyGap(p, q, c) {
  const k = c.r / c.ry;
  const py = c.y + (p.y - c.y) * k;
  const qy = c.y + (q.y - c.y) * k;
  const vx = q.x - p.x, vy = qy - py, vz = q.z - p.z;
  const vv = vx * vx + vy * vy + vz * vz || 1;
  let t = ((c.x - p.x) * vx + (c.y - py) * vy + (c.z - p.z) * vz) / vv;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x + vx * t - c.x, py + vy * t - c.y, p.z + vz * t - c.z) - c.r;
}

// (x,z) 주변 원판의 지붕 히트 수와 상단 통계 — 시가지 밀도의 단일 정의(중심 + 0.45/0.85 링 각 8방).
export function roofDensityAt(obs, x, z, radius) {
  let hits = 0, sum = 0, max = -Infinity;
  const at = (px, pz) => {
    const t = roofTopAt(obs, px, pz);
    if (t == null) return;
    hits++; sum += t; if (t > max) max = t;
  };
  at(x, z);
  for (const f of [0.45, 0.85]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      at(x + Math.cos(a) * f * radius, z + Math.sin(a) * f * radius);
    }
  }
  return { hits, meanTop: hits ? sum / hits : null, maxTop: hits ? max : null };
}

// 도로 폴리라인 길이.
function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}
// 주 도로 선택(대로 우선, 길이 가중). 도보 자동산책과 공유하는 폴백 규칙.
export function mainRoad(plan) {
  const roads = plan.roads || [];
  let best = null, bestScore = -1;
  for (const r of roads) {
    if (!r.pts || r.pts.length < 2) continue;
    const w = r.level === 'daero' ? 3 : r.level === 'jungno' ? 2 : r.level === 'soro' ? 1.2 : 1;
    const s = polyLen(r.pts) * w;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return best;
}
// 폴리라인 누적 호길이와 임의 호길이 지점.
function polyCum(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return cum;
}
function polyAt(pts, cum, s) {
  const total = cum[cum.length - 1] || 1;
  const t = Math.min(total, Math.max(0, s));
  let i = 1; while (i < cum.length && cum[i] < t) i++;
  const a = pts[i - 1], b = pts[Math.min(i, pts.length - 1)];
  const seg = (cum[Math.min(i, cum.length - 1)] - cum[i - 1]) || 1;
  const f = (t - cum[i - 1]) / seg;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}
// 스팬 밖으로도 접선 방향으로 외삽하는 지점(전방 조준점 산출용).
function polyAtExt(pts, cum, s) {
  const total = cum[cum.length - 1] || 1;
  if (s >= 0 && s <= total) return polyAt(pts, cum, s);
  if (s > total) {
    const a = polyAt(pts, cum, Math.max(0, total - 4)), b = pts[pts.length - 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const k = s - total;
    return { x: b.x + (b.x - a.x) / l * k, z: b.z + (b.z - a.z) / l * k };
  }
  const a = pts[0], b = polyAt(pts, cum, Math.min(total, 4));
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const k = -s;
  return { x: a.x + (a.x - b.x) / l * k, z: a.z + (a.z - b.z) / l * k };
}

// ── 시가지 밀도 스팬 ── 폴리라인을 따라 밀도를 스캔하고 문턱을 넘는 **연속 최장 구간**만 남긴다.
//   드론 저공 패스와 도보 자동산책이 이 단일 정의를 공유한다(둘 다 밀도 0 구간을 지나지 않는다).
//   짧은 도로(합성 픽스처·좁은 골목)는 트리밍할 구조가 없으므로 원본을 그대로 돌려준다.
export function denseRoadSpan(pts, obs, R) {
  const empty = { pts, trimmed: false, total: pts.length > 1 ? polyLen(pts) : 0, span: null };
  if (!pts || pts.length < 2) return empty;
  const total = polyLen(pts);
  if (total < DENSITY_MIN_ROAD_LEN) return empty;
  const cum = polyCum(pts);
  const radius = R * DENSITY_DISC_RATIO;
  // 프로브 간격이 넓으면 시가지 사이의 짧은 빈 구멍이 프로브 사이로 빠져 "연속 밀집 구간" 안에
  //   들어온다. 1m 간격으로 스캔한다.
  const n = Math.min(600, Math.max(16, Math.round(total)));
  const hits = new Array(n + 1);
  let maxHits = 0;
  for (let i = 0; i <= n; i++) {
    const p = polyAt(pts, cum, (i / n) * total);
    hits[i] = roofDensityAt(obs, p.x, p.z, radius).hits;
    if (hits[i] > maxHits) maxHits = hits[i];
  }
  if (maxHits === 0) return empty;
  const thr = Math.max(1, Math.ceil(DENSITY_THRESHOLD_RATIO * maxHits));
  let bestA = -1, bestB = -1, runA = -1;
  for (let i = 0; i <= n; i++) {
    if (hits[i] >= thr) {
      if (runA < 0) runA = i;
      if (bestA < 0 || i - runA > bestB - bestA) { bestA = runA; bestB = i; }
    } else runA = -1;
  }
  if (bestA < 0) return empty;
  // 코어(문턱 이상)만 남기면 조밀한 시드에서 스팬이 40m 로 짧아진다. 목표 길이까지 **밀도가 0 이
  // 아닌 동안만** 바깥으로 넓힌다 — 빈 들판은 어떤 경우에도 들이지 않는다.
  const targetSpan = Math.min(total, Math.max(total * DENSITY_MIN_SPAN_RATIO, DENSITY_MIN_SPAN_ABS));
  const probeStep = total / n;
  let a = bestA, b = bestB;
  while ((b - a) * probeStep < targetSpan) {
    const canA = a > 0 && hits[a - 1] > 0;
    const canB = b < n && hits[b + 1] > 0;
    if (!canA && !canB) break;
    if (canB && (!canA || hits[b + 1] >= hits[a - 1])) b++;
    else a--;
  }
  // 끝점은 **자격을 통과한 프로브 위치 그대로** 둔다. 반 스텝 밖으로 늘리면 그 반 스텝이 밀도 0
  //   주머니에 떨어져 경로 꼬리가 빈 들판을 지난다.
  const s0 = Math.max(0, (a / n) * total);
  const s1 = Math.min(total, (b / n) * total);
  if (s1 - s0 >= total - 1e-6) return empty;
  const out = [polyAt(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push({ x: pts[i].x, z: pts[i].z });
  }
  out.push(polyAt(pts, cum, s1));
  if (out.length < 2) return empty;
  return { pts: out, trimmed: true, total, span: [s0, s1] };
}

// ── 시선 원뿔 내 지붕 히트 ── 프레임에 건축이 담기는지의 척도. 카메라 위치 밀도(denseRoadSpan)와
//   달리 **시선 방향**을 본다. hHalf 는 수평 반각(vFOV 와 종횡비에서 파생), far 는 원뿔 사거리.
export function coneRoofHits(obs, px, pz, az, hHalf, far) {
  let hits = 0, total = 0;
  const mid = (FLY_CONE_SAMPLES - 1) / 2;
  for (let a = 0; a < FLY_CONE_SAMPLES; a++) {
    const th = az + ((a - mid) / mid) * hHalf;
    for (let d = 1; d <= FLY_CONE_RINGS; d++) {
      total++;
      const r = (far * d) / FLY_CONE_RINGS;
      if (roofTopAt(obs, px + Math.sin(th) * r, pz + Math.cos(th) * r) != null) hits++;
    }
  }
  return { hits, total };
}

// 스팬 폴리라인의 원뿔 프로파일 — 최선 조준각에서의 평균·최소 히트. 축 선택의 척도다.
export function spanConeProfile(pts, obs, { hHalf, far }) {
  const cum = polyCum(pts);
  const total = cum[cum.length - 1] || 1;
  const n = 20;
  const tanAt = (s) => {
    const a = polyAt(pts, cum, Math.max(0, s - 2)), b = polyAt(pts, cum, Math.min(total, s + 2));
    return Math.atan2(b.x - a.x, b.z - a.z);
  };
  let best = null;
  for (const aim of AXIS_SIDE_OFFSETS) {
    let sum = 0, min = Infinity;
    for (let k = 0; k <= n; k++) {
      const s = (k / n) * total;
      const p = polyAt(pts, cum, s);
      const h = coneRoofHits(obs, p.x, p.z, tanAt(s) + aim, hHalf, far).hits;
      sum += h; if (h < min) min = h;
    }
    const mean = sum / (n + 1);
    if (!best || mean > best.mean) best = { aim, mean, min };
  }
  return best;
}

// 스팬 양 끝에서 안쪽으로, 시선 원뿔이 비는 구간을 잘라낸다. 진행방향은 항상 s 증가 방향이다.
export function trimSpanByCone(pts, obs, { aimSigned, hHalf, far, minSpan }) {
  if (!pts || pts.length < 2) return pts;
  const cum = polyCum(pts);
  const total = cum[cum.length - 1] || 1;
  if (total <= minSpan) return pts;
  const step = Math.max(2, total / 40);
  const okAt = (s) => {
    const p = polyAt(pts, cum, s);
    const a = polyAt(pts, cum, Math.max(0, s - step));
    const b = polyAt(pts, cum, Math.min(total, s + step));
    const tanAz = Math.atan2(b.x - a.x, b.z - a.z);
    return coneRoofHits(obs, p.x, p.z, tanAz + aimSigned, hHalf, far).hits >= FLY_CONE_MIN_HITS;
  };
  let s0 = 0, s1 = total;
  while (s1 - s0 > minSpan && !okAt(s1)) s1 -= step;
  while (s1 - s0 > minSpan && !okAt(s0)) s0 += step;
  if (s0 <= 0 && s1 >= total) return pts;
  const out = [polyAt(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push({ x: pts[i].x, z: pts[i].z });
  }
  out.push(polyAt(pts, cum, s1));
  return out.length >= 2 ? out : pts;
}

// 폴리라인을 호길이 등간격 n점으로 재샘플(제어점 등속화).
function resample(pts, n) {
  const cum = polyCum(pts);
  const total = cum[cum.length - 1] || 1;
  const out = [];
  for (let k = 0; k < n; k++) out.push(polyAt(pts, cum, (k / (n - 1)) * total));
  return out;
}

// ── 결정론 로컬 rng ── 전역 Math.random 을 건드리지 않는다(마을 시드창 규약: 생성 파이프라인이
//   Math.random 을 시드 스트림으로 바꿔 끼운 창 안에서 이 함수가 호출될 수 있다).
function tourRng(seed) {
  let s = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 닫힌 균일 Catmull-Rom 스칼라 보간(C¹) — fov·속도 가중을 제어점에 authoring 하고 곡선 파라미터
//   t 로 읽는다. 위치·시선 곡선과 **같은 인덱스 규약**(t*N = 제어점 인덱스)이라 정렬이 어긋나지 않는다.
function closedScalarAt(values, t) {
  const n = values.length;
  const p = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(p), w = p - i;
  const at = (k) => values[((k % n) + n) % n];
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * w + c * w * w + d * w * w * w);
}

// 주기 그리드 확산 — raw 요구량(≥0)을 smootherstep 창으로 퍼뜨린다. 클램프 계단을 만들지 않으면서
//   피크에서는 요구량 전부가 적용된다(항상 하한 이상).
function spreadPeriodic(raw, halfWidth) {
  const n = raw.length;
  const out = new Float64Array(n);
  const w = Math.max(1, Math.round(halfWidth));
  for (let i = 0; i < n; i++) {
    let best = 0;
    for (let j = i - w; j <= i + w; j++) {
      const k = ((j % n) + n) % n;
      if (raw[k] <= 0) continue;
      const v = raw[k] * smootherstep(1 - Math.abs(j - i) / (w + 1));
      if (v > best) best = v;
    }
    out[i] = best;
  }
  return out;
}
const gridAt = (grid, t) => {
  const n = grid.length;
  const p = (((t % 1) + 1) % 1) * n;
  const i0 = Math.floor(p), i1 = (i0 + 1) % n;
  return grid[i0] + (grid[i1] - grid[i0]) * (p - i0);
};

// ── 랜드마크 목록 ── 계획이 실제로 아는 좌표만 쓴다(렌더에서 되추론 금지). rank 는 "관광 소개
//   영상이 무엇을 주인공으로 두는가"의 고정 순서이고, 동순위는 없다(결정론).
function collectLandmarks(plan, site, H) {
  const f = plan.features || {};
  const C = site.center, R = site.R;
  const out = [];
  const push = (rank, kind, x, z, ext, h, baseY, foot) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    out.push({
      rank, kind, x, z, ext: Math.max(12, ext), h,
      baseY: baseY != null ? baseY : H(x, z),
      // 실제 바닥 치수(없으면 ext 정사각) — 프레임 배치 계약이 얇은 띠/하단 절단을 판정할 때 쓴다.
      footW: foot ? foot[0] : Math.max(12, ext),
      footD: foot ? foot[1] : Math.max(12, ext),
    });
  };
  if (f.palace) {
    push(9, 'palace', f.palace.x, f.palace.z,
      Math.max(f.palace.plotW || 60, f.palace.plotD || 90), 18, null,
      [f.palace.plotW || 60, f.palace.plotD || 90]);
  }
  if (f.temple) {
    push(7, 'temple', f.temple.x, f.temple.z,
      Math.max(f.temple.compoundWidth || 40, f.temple.compoundDepth || 40), 13, f.temple.baseY,
      [f.temple.compoundWidth || 40, f.temple.compoundDepth || 40]);
  }
  const hero = (plan.parcels || []).find((p) => p.hero);
  // 궁이 있으면 종가는 주인공이 아니지만(도성은 궁이 주인공) 부주제로는 유효하다.
  if (hero) {
    push(f.palace ? 6 : 8, 'hero', hero.center.x, hero.center.z,
      Math.max(hero.plotW, hero.plotD) * 1.2, 14, hero.baseY, [hero.plotW, hero.plotD]);
  }
  if (f.govCore) push(5, 'gov', f.govCore.x, f.govCore.z, 42, 13);
  const gates = (f.cityWall && f.cityWall.gates) || [];
  for (const g of gates) {
    // 성문은 문루 자체가 소재다. 남문(도시 주축)을 우선하도록 name 순서가 아니라 각도로 고정한다.
    if (g.name && /south|남/.test(String(g.name))) push(4.5, 'gate', g.x, g.z, Math.max(24, g.width * 1.6), 16);
  }
  if (f.pavilion) push(3, 'pavilion', f.pavilion.x, f.pavilion.z, (f.pavilion.radius || 6) * 2.6, 7);
  const tree = (f.guardianTrees || [])[0];
  if (tree) push(2, 'tree', tree.x, tree.z, (tree.radius || 8) * 2, 14 * (tree.scale || 1));
  // 마지막 폴백 — 집이 없는 구성(houses:0)에서도 투어는 성립해야 한다.
  push(0, 'core', C.x, C.z, Math.max(40, R * 0.12), 12);
  out.sort((a, b) => b.rank - a.rank);
  return out;
}

export function createDronePaths({
  site, plan, heightAt, seed = 0, sunAzimuth = null, canopies: extraCanopies = null,
} = {}) {
  const H = typeof heightAt === 'function' ? heightAt : (site && site.heightAt) || (() => 0);
  const R = site.R, C = site.center, Hmax = site.Hmax || R * 0.3;
  const obstacles = buildObstacles(plan, H);
  const parcelObstacles = obstacles.filter((o) => o.tag === 'parcel');
  const canopies = buildCanopies(plan, H).concat(extraCanopies || []);
  const rng = tourRng((seed >>> 0) ^ 0x7a0d51);
  const groundC = H(C.x, C.z);

  // 역광 방위 — 카메라가 태양 반대편에 서면 피사체가 카메라와 태양 사이에 놓인다(rim 성립).
  //   태양 방위를 모르면 backAz=0 → +z(남) 이라 종전 규약(남향 진입)과 같다.
  const sunKnown = Number.isFinite(sunAzimuth);
  const backAz = sunKnown ? Math.atan2(-Math.sin(sunAzimuth), -Math.cos(sunAzimuth)) : 0;
  const polar = (o, az, d) => ({ x: o.x + Math.sin(az) * d, z: o.z + Math.cos(az) * d });
  const jitter = (deg) => (rng() * 2 - 1) * deg * DEG;

  // 카메라가 수관을 **통과**하는 것은 시선 관통(T6/solveCanopy)과 다른 결함이고, 종전 safeFloor 는
  //   지형·지붕만 봤다. 구문법의 저공은 항상 도로 위였고 도로에는 보호수가 없어 이 구멍이 드러나지
  //   않았다. 새 문법의 계곡 활강은 도로가 아니라 **진행 축**(태양 방위)을 따라가므로 보호수 위를
  //   그대로 지난다 — 실측 한양 τ0.051 최소여유 -7.17m 는 시선이 아니라 **기체**가 잎 속에 있던 것이고,
  //   그래서 시선 쪽 반복 해결로는 닫히지 않았다. 수평 원판 안이면 수관 상단 위로 바닥을 올린다.
  const canopyFloorAt = (x, z) => {
    let top = -Infinity;
    for (const c of canopies) {
      const dx = x - c.x, dz = z - c.z;
      const rr = c.r + CANOPY_CLEAR;
      if (dx * dx + dz * dz <= rr * rr) top = Math.max(top, c.top + CANOPY_CLEAR);
    }
    return top;
  };
  const safeFloor = (x, z, clear) => {
    const g = H(x, z) + GROUND_CLEAR;
    const rt = roofTopAt(obstacles, x, z);
    const base = rt != null ? Math.max(g, rt + (clear != null ? clear : ROOF_CLEAR)) : g;
    return Math.max(base, canopyFloorAt(x, z));
  };
  // 지표·지붕 위 클리어런스로 고도를 정의한다 — 이 함수가 "지형 추종"의 단일 정의다.
  //   (플라이바이 이격 해가 실제 통과 고도를 알아야 하므로 저작 블록보다 앞에 둔다.)
  const aglAt = (x, z, agl, roofClear) => {
    const g = H(x, z) + Math.max(GROUND_CLEAR, agl);
    const rt = roofTopAt(obstacles, x, z);
    return rt != null ? Math.max(g, rt + (roofClear != null ? roofClear : ROOF_CLEAR)) : g;
  };

  // ── 소재 선택 ──
  const marks = collectLandmarks(plan, site, H);
  const primary = marks[0];
  const secondary = marks.find((m) => m !== primary
    && Math.hypot(m.x - primary.x, m.z - primary.z) > R * 0.12) || primary;
  const aimOf = (m) => V(m.x, m.baseY + m.h * 0.5, m.z);

  // 부감 피사체 — 시가지 매스 그 자체다. 종전에는 조준점을 중심 **너머**(0.30R)로 밀고 능선 어깨
  //   높이까지 들어올렸는데, 그 두 가지가 하강각을 8° 로 눌러 상단 35~55% 를 빈 하늘로 만들었다
  //   (2026-08-01 비전). 이제 조준점은 시가지 중심의 지면 근처이고, 하늘 비율은 프레임 피치가 정한다.
  const fabricCentre = () => {
    const ps = plan.parcels || [];
    if (!ps.length) return { x: C.x, z: C.z };
    let x = 0, z = 0;
    for (const q of ps) { x += q.center.x; z += q.center.z; }
    return { x: x / ps.length, z: z / ps.length };
  };
  const fabC = fabricCentre();
  const coreSubject = V(fabC.x, H(fabC.x, fabC.z) + Math.max(6, Hmax * 0.07), fabC.z);

  // ── 프레임 기하 파생 ──
  const tanHalfV = (fov) => Math.tan(fov * 0.5 * DEG);
  //   피사체를 yTarget 에 놓기 위해 필요한 하강각(고도/거리 비의 각).
  const depressionFor = (pitch, fov) => Math.max(3 * DEG,
    pitch - Math.atan(AERIAL_Y_TARGET * tanHalfV(fov)));
  //   실제 기하(하강각)에서 피사체를 yTarget 에 놓는 프레임 피치.
  //   yT 는 피사체를 놓을 화면 세로 위치(NDC). 기본은 AERIAL_Y_TARGET 이고, 원경 진입만 이것을
  //   아래로 내린다 — 근거는 pushWp 의 yTarget 주석.
  const pitchForSubject = (dep, fov, yT) => dep
    + Math.atan((yT != null ? yT : AERIAL_Y_TARGET) * tanHalfV(fov));
  // 와이드 프레임 고도 하한 — 주산 능선이 프레임 상단을 채우지 않게 카메라를 능선 위로 올린다.
  //   능선이 NDC 0.84 에 오려면 그 하강각이 (pitch - atan(0.84·tanHalf)) 여야 한다. 마을 규모는
  //   능선(52m)이 카메라(54m)와 거의 같은 높이라 이 하한이 실제로 개입하고, 한양은 이미 능선보다
  //   46m 높아 개입하지 않는다(2차 비전: "한양은 적정, 마을만 과교정").
  const ridgeY = groundC + Hmax;
  const ridgeDist = Math.max(R * 0.9, Math.abs(site.mountainZ || -R) + R * 0.4);
  //   능선선을 프레임 세로 ndc 에 놓는 고도. 진입은 APPROACH_RIDGE_NDC 를, 그 밖 와이드 대역은
  //   WIDE_RIDGE_NDC 를 쓴다(피치 대역이 다르면 같은 상수로 둘 다 만족하지 않는다).
  const ridgeYFloor = (pitch, fov, ndc) => {
    const drop = pitch - Math.atan(ndc * tanHalfV(fov));
    return drop <= 0 ? -Infinity : ridgeY + ridgeDist * Math.tan(drop);
  };
  //   수평 방위 az(카메라 → 피사체) + 프레임 피치 → 단위 시선.
  const dirFromPitch = (az, pitch) => V(
    Math.sin(az) * Math.cos(pitch), -Math.sin(pitch), Math.cos(az) * Math.cos(pitch));
  //   부감 스테이션: 피사체 주위 방위 az(피사체에서 카메라를 보는 방위)·고도 y·프레임 피치를 저작하고
  //   **거리**를 파생한다. 시선은 항상 "피사체가 yTarget" 이라는 불변식으로 만든다.
  //   고도는 **안전 하한 위로 미리 올려** 둔다: 나중에 리프트가 카메라를 들어올리면 저작된 프레임
  //   피치가 무너지고(실측 정점 -38° → -49.6°), 피사체 배치 불변식을 지키려면 시선이 더 눕는다.
  //   거리는 클램프된 고도에서 다시 파생하므로 3회 반복으로 수렴한다.
  const aerialAt = (subject, az, yWanted, pitch, fov, radOverride) => {
    let y = yWanted, d = radOverride || 12, p = polar(subject, az, d);
    for (let it = 0; it < 3; it++) {
      d = radOverride != null ? radOverride
        : Math.max(12, (y - subject.y) / Math.tan(depressionFor(pitch, fov)));
      p = polar(subject, az, d);
      y = Math.max(yWanted, safeFloor(p.x, p.z) + 2);
    }
    return { pos: V(p.x, y, p.z), d };
  };
  //   lead: 화면 가로 NDC 로 피사체를 밀어낼 양(부호 포함, 없으면 정중앙). 피사체를 NDC x 에 놓으려면
  //   조준 방위를 그 반대쪽으로 atan(x·tanHalfH) 만큼 돌린다(세로 배치와 같은 원근 관계).
  const hHalfTan = (fov) => tanHalfV(fov) * FRAME_ASPECT;
  const aimAtSubject = (pos, subject, fov, lead, yT) => {
    const dx = subject.x - pos.x, dz = subject.z - pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const dep = Math.atan((pos.y - subject.y) / d);
    const yaw = Math.atan2(dx, dz) - (lead ? Math.atan(lead * hHalfTan(fov)) : 0);
    return {
      dir: dirFromPitch(yaw, pitchForSubject(dep, fov, yT)),
      dist: Math.hypot(d, pos.y - subject.y),
    };
  };

  // 화각 파생 — 프레임에 무엇이 담기는지는 수평 화각이 정한다.
  const hHalfOf = (fov) => Math.atan(Math.tan(fov * 0.5 * DEG) * FRAME_ASPECT);
  const aheadDist = Math.max(16, R * 0.12);
  // 개활 판정을 적용할 만큼 시가지가 있는가(위 FLY_OPEN_* 주석의 필지 20 문턱).
  const denseFabric = (plan.parcels || []).length >= 20;
  const coneFar = aheadDist * FLY_CONE_FAR_RATIO;
  const laneHHalf = hHalfOf(FLY_FOV);
  const discR = R * DENSITY_DISC_RATIO;

  // ── 저공 축(스윕·골목) ──
  // 후보를 길이×등급으로 12개까지 좁힌 뒤(비용 상한) 밀도 스팬 + 원뿔 프로파일로 채점한다.
  // 저공 고도 기준선 — 기념 건축 제외(궁 접근 구간에서 카메라가 민가 위 8m 부감으로 떠오르지
  //   않게). 관통 방지(safeFloor)는 여전히 전체 obstacles 를 쓴다.
  const spanBaseline = (p) => {
    const d = roofDensityAt(parcelObstacles, p.x, p.z, FLY_BASELINE_DISC);
    const terrain = H(p.x, p.z) + FLY_FALLBACK_ROOF;
    if (!d.hits) return terrain;
    const w = Math.min(1, d.hits / FLY_ROOF_TRUST_HITS);
    return d.meanTop * w + terrain * (1 - w);
  };
  // 저공 프레임의 지면 표본 — 평지 근사(hit 거리 = 고도/tan δ)로 충분하다. 채점용이라 정확한
  //   레이캐스트(게이트가 하는 일)까지 갈 필요가 없다.
  const spanBareFraction = (pts, clear, dropDeg) => {
    const cum = polyCum(pts);
    const total = cum[cum.length - 1] || 1;
    const tv = tanHalfV(FLY_FOV), th = tv * FRAME_ASPECT;
    let bare = 0, n = 0;
    for (let k = 0; k <= 11; k++) {
      const sArc = (k / 11) * total;
      const p = polyAt(pts, cum, sArc);
      const a = polyAt(pts, cum, Math.max(0, sArc - 4));
      const b = polyAt(pts, cum, Math.min(total, sArc + 4));
      const az = Math.atan2(b.x - a.x, b.z - a.z);
      const ground = H(p.x, p.z);
      const camY = spanBaseline(p) + clear;
      const alt = Math.max(2, camY - ground);
      // 프레임 **하단 절반**만 본다(2차 비전: 하단 45% 가 맨 지면이던 결함의 척도).
      for (const ndcY of [-0.9, -0.65, -0.4, -0.15]) {
        const dep = dropDeg * DEG - Math.atan(ndcY * tv);
        if (dep <= 2 * DEG) continue;
        const d = alt / Math.tan(dep);
        if (!Number.isFinite(d) || d > R * 2) continue;
        for (const ndcX of [-0.7, 0, 0.7]) {
          const lat = d * ndcX * th;
          const gx = p.x + Math.sin(az) * d + Math.cos(az) * lat;
          const gz = p.z + Math.cos(az) * d - Math.sin(az) * lat;
          n++;
          if (obstacleDistance(obstacles, gx, gz) > BARE_R) bare++;
        }
      }
    }
    return n ? bare / n : 1;
  };
  // 전경 와이프 — 스팬을 따라 건물 볼륨이 HUG_R 안에 상주하는 표본 비율. 필지 띠 밖(개천·수림 경계)을
  //   타는 코스는 이 값이 낮다.
  const spanHugFraction = (pts) => {
    const cum = polyCum(pts);
    const total = cum[cum.length - 1] || 1;
    let hug = 0;
    for (let k = 0; k <= 23; k++) {
      const p = polyAt(pts, cum, (k / 23) * total);
      if (obstacleDistance(obstacles, p.x, p.z) <= HUG_R) hug++;
    }
    return hug / 24;
  };

  const roadCandidates = () => {
    const pool = (plan.roads || [])
      .filter((r) => r.pts && r.pts.length >= 2)
      .map((r) => ({
        road: r,
        raw: polyLen(r.pts),
        w: r.level === 'daero' ? 3 : r.level === 'jungno' ? 2 : r.level === 'soro' ? 1.2 : 1,
      }))
      .sort((a, b) => (b.raw * b.w) - (a.raw * a.w))
      .slice(0, AXIS_CANDIDATES);
    const out = [];
    for (const cand of pool) {
      const span = denseRoadSpan(cand.road.pts, obstacles, R).pts;
      const len = polyLen(span);
      if (len < AXIS_MIN_LEN) continue;
      const prof = spanConeProfile(span, obstacles, { hHalf: laneHHalf, far: coneFar });
      const bare = spanBareFraction(span, FLY_ROOF_CLEAR, FLY_DROP_DEG);
      const hug = spanHugFraction(span);
      out.push({ pts: span, road: cand.road, level: cand.road.level || null, len, prof, bare, hug });
    }
    return out;
  };
  // 합성 축 — 도로가 없거나(외딴집·houses:0) 전부 짧은 구성에서도 저공 패스는 성립해야 한다.
  // 합성 축의 앵커는 필지 중심의 산술평균이다. **가장 조밀한 필지 근방**을 앵커로 쓰는 안을 실측이
  //   기각했다: 도성에서 축이 시가지 안쪽으로 들어가 프레임 내용은 좋아졌지만(피사체 커버리지 30→35%)
  //   계곡 활강 종점에서 글라이드 시점까지의 전이가 길어져 그 이음에서 속도가 0.91m/s 까지 떨어지고
  //   (계약 하한 2) 프레임당 변화 3.61·시선 각속도 p99 20.2 로 연속성 계약 셋이 함께 깨졌다.
  //   내용 한 지표를 얻고 안전·연속성 셋을 잃는 거래이므로 되돌린다.
  // ── 합성 축은 **푸는** 것이다 (2026-08-02 #42 R3, C항) ──
  // 종전은 fabC 를 진행 방위로 지나는 직선 하나였다. 길이는 보장되지만 **그 직선이 지붕 위를 지난다는
  //   보장이 전혀 없다**: 실측 지붕 점유 capital 0.20 · hanyang 0.47(도로 후보에는 0.87~1.00 이 있었다).
  //   그 축을 쓰면 개활 리프트가 정당하게 발동해 글라이드 전체가 지면 위 23m 부감이 되고, 저공 대역
  //   표본이 0% 가 된다 — 도성·한양의 T7·T15·T16 실패가 여기서 나왔다. 합성 축은 "도로가 없거나 전부
  //   짧을 때 쓰는 **시가지 관통 가상 가로**"이므로, 관통이 성립하는 현을 결정론 격자로 고른다.
  //   방위 13 × 측면 오프셋 5 = 65 후보이고 채점은 도로 후보와 같은 축(지붕 점유 × 직물 포함 ×
  //   진행 방위 동점처리)이라, 두 후보군이 같은 기준으로 비교된다.
  // (참고: 이 함수는 아래 axisRoofFrac·axisInFabric·fabricR 보다 앞에 선언되지만, 호출은 축 확정
  //   블록에서 일어나므로 그 시점에 전부 초기화돼 있다.)
  const SYNTH_AZ_SCAN = 55 * DEG;
  // 합성 축 해 스위치 — 리드 판단으로 켰다, 2026-08-02, warm 표본 확장과 함께.
  const SYNTH_SOLVE = true;
  const syntheticAxis = (azWant) => {
    // 2026-08-02 #42 R3 시도·기각: 길이도 함께 풀어(현 반길이 4후보 × 길이 보너스) 성긴 규모에서
    //   짧고 조밀한 현이 이기게 해 보았다. capital 은 172m, hanyang 은 370m 를 골랐고 **둘 다 나빠졌다**
    //   (전체 실패 20 → 26: capital 저공 표본 6%→5% · T28 무건축 0s→6.5s, hanyang 은 T2·T7·T14·T16 이
    //   새로 깨졌다). 저공 비트의 어휘 지표는 축의 **밀도**만이 아니라 축 위에 머무는 **시간**이 함께
    //   정하므로, 길이를 깎으면 전이 비중이 늘어 밀도 이득을 그대로 상쇄한다. 길이는 고정으로 둔다.
    const half = Math.max(38, Math.min(R * 0.5, 200));
    const make = (az, lat) => {
      const qx = Math.cos(az), qz = -Math.sin(az);
      const mx = fabC.x + qx * lat, mz = fabC.z + qz * lat;
      return [
        { x: mx - Math.sin(az) * half, z: mz - Math.cos(az) * half },
        { x: mx, z: mz },
        { x: mx + Math.sin(az) * half, z: mz + Math.cos(az) * half },
      ];
    };
    // ── 2026-08-02 #42 R3: 이 해는 **보류 상태로 코드에 남긴다** ──
    // 위 문단의 진단(합성 축 지붕 점유 capital 0.20 · hanyang 0.47)과 처방은 그대로 유효하고, 실측으로
    //   품질 계약 실패를 크게 줄인다(전체 20 → 이 해를 끄면 27; capital T7·T15·T16, hanyang T7·T14·T16 이
    //   이 해에 달려 있다). 그런데 해를 켜면 한양의 **경로 전체가 달라지면서** check:cine-warm 이 깨진다:
    //   워밍이 링크하는 프로그램이 154 → 153 으로 하나 줄고, 그 하나가 재생 중 τ0.047 에 링크되어
    //   투어 중 +1 스톨이 된다(이분 확인: 이 해만 되돌리면 PASS, 이 해만 켜면 FAIL — 다른 R3 변경은
    //   무관하다). 원인은 이 파일이 아니라 **워밍 표본 스코프**다(engine.js warmTourDetailShaders 가
    //   leg 당 t01 6점만 훑는다 — 경로가 바뀌면 그 6점이 같은 재질을 더 이상 지나지 않는다).
    //   그 파일은 이번 라운드의 파일 경계 밖이고 check:cine-warm 은 회귀 금지 계약이므로, 해를 끈 채
    //   리드에 실측과 함께 넘긴다. 스코프가 넓어지면 아래 한 줄(SYNTH_SOLVE)을 켜면 된다.
    // 탐색 폭을 줄여(방위 ±55°→±20°, 오프셋 5→3) 경로 변화를 작게 만드는 안도 실측이 기각했다:
    //   품질 실패는 27 그대로이고 warm 은 여전히 FAIL(τ0.022, 153→155). 문제는 변화의 **크기**가
    //   아니라 워밍 표본이 그 재질을 지나느냐이므로, 경로가 조금이라도 바뀌면 같은 결과다.
    if (!SYNTH_SOLVE) return make(azWant, 0);
    let best = null, bestScore = -Infinity;
    for (let k = -6; k <= 6; k++) {
      const az = azWant + (k / 6) * SYNTH_AZ_SCAN;
      for (const f of [0, 0.25, -0.25, 0.45, -0.45]) {
        const pts = make(az, fabricR * f);
        const align = 0.85 + 0.15 * (0.5 + 0.5 * Math.cos(shortest(az - azWant)));
        const s = Math.pow(Math.max(0.04, axisRoofFrac(pts)), 1.2)
          * Math.pow(Math.max(0.05, axisInFabric(pts)), 1.4) * align;
        if (s > bestScore) { bestScore = s; best = pts; }
      }
    }
    return best || make(azWant, 0);
  };
  const axisAz = Math.atan2(C.x - site.entrance.x, C.z - site.entrance.z);
  const candidates = roadCandidates();
  // 채점에 무특징 지면 비율을 곱한다 — 프레임 절반 이상이 빈 지면인 코스는 "지붕 바다"가 아니다.
  const barePenalty = (c) => Math.pow(1 - Math.min(0.95, c.bare), BARE_PENALTY_POW)
    // 전경 밀착이 없는 코스(정착지 밖 개천·수림 경계)는 강하게 감점한다.
    * Math.pow(Math.max(0.05, c.hug), 1.6);
  // 연결성 — 스팬 시작이 들어오는 지점에서 멀면 그 전이가 저공 구간의 **시간**을 잡아먹는다(실측:
  //   한양 저공 표본이 leg 의 20% 까지 떨어졌다). 내용이 주도권을 갖도록 약한 항으로 둔다.
  const nearness = (c, from) => {
    if (!from) return 1;
    let best = Infinity;
    for (const e of [c.pts[0], c.pts[c.pts.length - 1]]) {
      best = Math.min(best, Math.hypot(e.x - from.x, e.z - from.z));
    }
    return 0.55 + 0.45 / (1 + best / (R * 0.5));
  };
  const sweepScore = (c, from) => c.prof.mean * Math.min(1, c.len / AXIS_TARGET_LEN)
    * barePenalty(c) * nearness(c, from);
  const trimAxis = (c) => trimSpanByCone(c.pts, obstacles, {
    aimSigned: c.prof.aim, hHalf: laneHHalf, far: coneFar, minSpan: FLY_TRIM_MIN_SPAN,
  });
  // 축 선택은 여정 저작 블록이 **진행 방향 밴드 선호**를 곱해 직접 고른다(아래 glidePick). 종전의
  //   pickSweep/pickLane 두 단계(스윕 축 + 그 뒤 골목 축)는 저공 구간을 두 샷으로 나누던 구문법의
  //   잔재라 삭제했다 — 여정에는 저공 런이 하나뿐이고 그것이 지붕 글라이드다.

  // 밀집측 조준 — 비행축 정면 시선은 프레임 절반을 노면으로 채운다. 실측 원뿔 히트로 부호·크기를 정한다.
  // 저공 조준의 오프액시스 후보는 좁게 둔다 — 24° 로 틀면 노변 담·기와가 프레임 **중앙**으로 들어와
  //   근거리에서 하단이 잘린다(2차 비전 2항). 담은 프레임 가장자리를 스치는 와이프여야 한다.
  const AIM_OFFSETS = [0, 10 * DEG, -10 * DEG, 16 * DEG, -16 * DEG];
  const bestSideOffset = (pts) => {
    const cum = polyCum(pts);
    const total = cum[cum.length - 1] || 1;
    let best = 0, bestHits = -1;
    for (const off of AIM_OFFSETS) {
      let sum = 0;
      for (let k = 0; k <= 24; k++) {
        const s = (k / 24) * total;
        const p = polyAt(pts, cum, s);
        const a = polyAt(pts, cum, Math.max(0, s - 3));
        const b = polyAt(pts, cum, Math.min(total, s + 3));
        sum += coneRoofHits(obstacles, p.x, p.z, Math.atan2(b.x - a.x, b.z - a.z) + off,
          laneHHalf, coneFar).hits;
      }
      if (sum > bestHits) { bestHits = sum; best = off; }
    }
    return best;
  };
  // 진행 방향 정렬 — 들어오는 쪽에 가까운 끝이 시작이 되게 뒤집는다(스플라인이 되돌아가는 훅 방지).
  const orientFrom = (pts, from) => {
    const a = pts[0], b = pts[pts.length - 1];
    const da = Math.hypot(a.x - from.x, a.z - from.z);
    const db = Math.hypot(b.x - from.x, b.z - from.z);
    return db < da ? pts.slice().reverse() : pts.slice();
  };

  // ── 플라이바이 기하 ── 랜드마크를 **도는** 대신 옆으로 지나간다. 그래서 푸는 양이 "선회 반경"이
  //   아니라 **측면 이격(stand-off)** 이다. 두 조건에서 함께 푼다:
  //     ① 최근접에서 피사체 근단이 프레임 하단 밖으로 잘리지 않는 하강각
  //     ② 그 이격에서 피사체가 프레임 가로를 충분히 채우는 렌즈(작은 종가가 26% 로 쪼그라들지 않게)
  //   통과 고도는 피사체 **옆**이다(기단 + 전고 × FLYBY_EYE). 위로 넘어가면 그건 부감이지 플라이바이가
  //   아니고, 지붕 바다에서 갑자기 솟아오르는 고도 계단도 만든다.
  const flybyTarget = aimOf(primary);
  const massHalfW = Math.min(primary.footW, primary.footD) * 0.5 * SUBJECT_MASS;
  // 최악은 대각 정점이다 — max(footW, footD)/2 로 잡으면 모델은 "들어온다"고 하고 실제 대각 근단은
  //   프레임 밖으로 나간다.
  // 최근접 코너까지의 거리 감소분은 hw·|q·x̂| + hd·|q·ẑ| 이고 그 상한은 hw + hd 다. hypot/2 로 잡으면
  //   축 정렬 통과에서 최대 1.41배 과소평가되어 근단이 프레임 밖으로 나간다(실측 하단 여백 -22.5%).
  //   품질 계약(T14)이 AABB 8정점을 그대로 투영하므로, 저작도 같은 최악 경계를 써야 둘이 정합한다.
  const massHalfSpan = (primary.footW + primary.footD) * 0.5 * SUBJECT_MASS * 1.02;
  const flybyY0Author = primary.baseY + primary.h * FLYBY_EYE;
  // ── 통과 고도는 저작값이 아니라 **지표가 정한다** (2026-08-02 #42 R2) ──
  // 이격 해는 rise(= 카메라가 피사체 기단 위로 서는 높이)를 저작 통과 고도로 가정했는데, 실제 통과
  //   고도는 `Math.max(yWant, aglAt(...))` 이라 랜드마크 주변 지표가 기단보다 높으면 저작값을 훌쩍
  //   넘는다(실측 hamlet: 저작 eyeY 17.8 vs 실제 camY 42.2 — rise 40.5). rise 가 2.5배면 같은 이격에서
  //   하강각이 그만큼 서고 근단이 프레임 하단 밖으로 나간다(실측 하단 여백 -6.8%).
  //   이격 대역의 지표를 먼저 재서 rise 를 실제값으로 만든 뒤 푼다 — 두 번 도는 것으로 수렴한다
  //   (지표 하한은 이격에 약하게만 의존한다).
  const flybyRingFloor = (rad) => {
    let top = flybyY0Author;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = flybyTarget.x + Math.cos(a) * rad, z = flybyTarget.z + Math.sin(a) * rad;
      top = Math.max(top, aglAt(x, z, AGL_VALLEY, FLY_ROOF_CLEAR));
    }
    return top;
  };
  let flybyY0 = flybyY0Author;
  const flybySolveAt = (fovDeg) => {
    const tv = tanHalfV(fovDeg);
    // 프레임 하단 여백은 **실제 프레임 피치**에서 나온다. 저작 상수(FLYBY_PITCH)로 풀면 안 된다:
    //   최근접 시선은 진행 방향과 피사체 조준의 pull 혼합이고 그 값이 저작 피치보다 훨씬 눕는다
    //   (마을 실측 저작 12° vs 표본 5.4°). 그 차이만큼 이격이 모자라 근단이 하단 밖으로 나갔다.
    const framePitchAt = (dd) => {
      const dep = Math.atan((flybyY0 - (primary.baseY + primary.h * 0.5)) / Math.max(4, dd));
      return FLYBY_PULL * (dep - Math.atan(AERIAL_Y_TARGET * tv)) + (1 - FLYBY_PULL) * FLYBY_PITCH;
    };
    // **고정점으로 푼다**(증가 루프가 아니라). 증가 루프는 세로 점유 브레이크나 상한에서 먼저 끊겨
    //   조건을 만족하지 못한 해를 내놓았고, 그 해가 화각 선택의 후보로 올라가면 가장 좁은 렌즈가
    //   가로 점유 최대라는 이유로 뽑혀 하단 절단이 더 심해졌다(실측 -17% → -40%).
    //   d = halfSpan + (camY - baseY) / tan(framePitch(d) + atan(tv·(1-2m))) 는 우변이 d 에 대해
    //   단조 증가라 반복이 수렴한다.
    const rise = Math.max(0.5, flybyY0 - primary.baseY);
    const d0 = Math.max(massHalfSpan * FLYBY_STANDOFF_K, Math.max(R * 0.05, 12));
    let d = d0;
    for (let it = 0; it < 40; it++) {
      const limit = framePitchAt(d) + Math.atan(tv * (1 - 2 * FLYBY_BOTTOM_SOLVE));
      const next = Math.max(d0, massHalfSpan + rise / Math.max(0.02, Math.tan(limit)));
      if (Math.abs(next - d) < 0.05) { d = next; break; }
      d = d + (next - d) * 0.6;
    }
    const near = Math.atan(rise / Math.max(4, d - massHalfSpan));
    const far = Math.atan((flybyY0 - (primary.baseY + primary.h)) / (d + massHalfSpan));
    const hHalf = Math.atan(tv * FRAME_ASPECT);
    const widthFrac = Math.atan(massHalfW / Math.max(8, d)) / hHalf;
    // ── in-frame 예산(2026-08-02 #42 R2) ── 최근접에서 시선은 진행 방향에서 pull 만큼만 끌리므로
    //   피사체 중심은 잔여 (1-pull)·90° 만큼 축에서 벗어나 있고, 거기에 리드룸과 피사체 자체의
    //   반각이 더해진다. 그 합이 수평 반각을 넘으면 피사체는 최근접 프레임 **밖**이다 — 종전 화각
    //   선택은 이 조건을 몰라 가로 점유만 보고 항상 가장 좁은 렌즈를 골랐고, 그래서 7 픽스처가
    //   전부 화각 밖이었다(실측 이각 23.7~78.4° vs 반각 22.3°).
    const needHalf = (1 - FLYBY_PULL) * (Math.PI / 2)
      + Math.atan(FLYBY_LEAD * tv * FRAME_ASPECT)
      + Math.atan(massHalfSpan / Math.max(8, d));
    return {
      d,
      fov: fovDeg,
      widthFrac,
      // 세로 점유가 하한 아래면 얇은 띠다 — 그 화각은 후보에서 뺀다(반대쪽 결함).
      ok: (near - far) >= SUBJECT_HEIGHT_MIN_FRAC * fovDeg * DEG && hHalf >= needHalf,
      inFrame: hHalf - needHalf,
    };
  };
  // 화각·이격 후보 탐색을 함수로 둔다 — 통과선 방위가 정해진 뒤 **실제 통과선 지표**로 한 번 더 푼다
  //   (아래 통과선 블록의 재해). 두 호출은 순수하고 같은 입력에서 같은 결과다.
  const flybyPick = () => {   // ← 현재 flybyY0 에서 화각 후보를 훑는다(통과 고도는 호출자가 정한다).
    let best = null, widest = null;
    // 후보를 **넓은 쪽으로 확장**한다(52·48·44). 좁은 렌즈만 두면 in-frame 예산을 만족하는 후보가
    //   하나도 없는 규모가 생기고, 그러면 폴백이 다시 화각 밖 해를 내놓는다.
    for (const fovDeg of [48, 44, FLYBY_FOV, 38, 35, 32, 30, 28, 26]) {
      const cand = flybySolveAt(fovDeg);
      if (!widest || cand.inFrame > widest.inFrame) widest = cand;
      if (!cand.ok) continue;
      if (!best || cand.widthFrac > best.widthFrac) best = cand;
      if (cand.widthFrac >= FLYBY_WIDTH_TARGET) return cand;
    }
    // 어떤 화각도 조건을 못 채우면 **예산이 가장 여유로운** 렌즈로 간다. 종전 폴백(가장 넓은 렌즈)은
    //   세로 점유만 보던 시절의 규칙이고, 지금은 화각 밖으로 나가는 것이 얇은 띠보다 나쁘다.
    return best || widest || flybySolveAt(FLYBY_FOV);
  };
  // 1패스: 저작 통과 고도로 이격을 어림 → 그 이격 대역의 지표 하한으로 통과 고도를 어림 → 화각·이격을
  //   함께 푼다. 방위가 정해지기 전이라 여기서는 원 표본이 최선의 대리이고, 통과선이 확정되는 아래
  //   블록에서 **실제 통과선 지표**로 한 번 더 푼다.
  flybyY0 = flybyRingFloor(flybySolveAt(FLYBY_FOV).d);
  let flybyFrame = flybyPick();
  let flybyStandoff = flybyFrame.d;
  let flybyFov = flybyFrame.fov;

  // ── 제어점(스테이션) 저작 ── 각 점은 { pos, dir, dist, fov, w(속도가중), leg }.
  //   dir 은 단위 시선 방향, dist 는 프레이밍 거리(lookAt = pos + dir*dist). 목표점을 직접 보간하지
  //   않는 이유는 위 DIR_GRID 주석 참조.
  const stations = [];
  // 최소 프레이밍 거리 — 시선 거리가 짧으면 같은 속도에서 시차 회전(v/d)만으로 각속도가 커진다
  //   (외딴집 R=30 에서 18m·9m/s = 29°/s). 방향만 의미가 있는 값이라 하한을 올려도 프레임은 같다.
  const AIM_MIN = Math.max(24, R * 0.06);
  const unit = (dx, dy, dz) => {
    const m = Math.hypot(dx, dy, dz) || 1;
    return V(dx / m, dy / m, dz / m);
  };
  const dirTo = (pos, target) => unit(target.x - pos.x, target.y - pos.y, target.z - pos.z);
  const aimOfDir = (d) => ({ az: Math.atan2(d.x, d.z), pitch: Math.asin(Math.min(1, Math.max(-1, -d.y))) });
  const aimTo = (pos, target) => aimOfDir(dirTo(pos, target));
  //   시선의 1차 표현은 **(yaw, pitch)** 다. 단위벡터를 보간하면 요가 뒤집히는 전이(골목 이탈 →
  //   상승)에서 두 방향의 대원이 천정·천저를 지나 카메라가 수직으로 고꾸라진다(실측 pitch 76°).
  //   짐벌은 그런 회전을 하지 않는다: 요는 짧은 쪽으로 팬하고 피치는 따로 눕는다.
  const addDir = (leg, pos, dir, dist, fov, w, subject, rollAuth, framing) => {
    stations.push({
      leg, pos, dist: Math.max(AIM_MIN, dist), fov, w,
      az: Math.atan2(dir.x, dir.z),
      pitch: Math.asin(Math.min(1, Math.max(-1, -dir.y))),
      // 프레이밍 피사체가 있는 스테이션은 안전 리프트가 확정된 뒤 시선을 다시 푼다(아래 refresh).
      subject: subject || null,
      // 재해결에 필요한 저작 의도. **pull 이 이 문법의 핵심 계약이다**: 재해결이 pull 을 무시하고
      //   피사체를 정조준하면 플라이바이가 그 자리에서 오빗이 된다(피사체가 프레임에 못박힌다).
      //   진행 방향 성분(baseAz/basePitch)을 함께 들고 있다가 같은 비율로 다시 섞는다.
      pull: framing ? framing.pull || 0 : (subject ? 1 : 0),
      lead: framing ? framing.lead || 0 : 0,
      yTarget: framing ? framing.yTarget : null,
      baseAz: framing ? framing.baseAz : Math.atan2(dir.x, dir.z),
      basePitch: framing ? framing.basePitch : Math.asin(Math.min(1, Math.max(-1, -dir.y))),
      // 뱅킹 권한 — 롤 자체는 궤적에서 유도하고 이 값만 저작한다(위 ROLL_AUTHORITY 주석).
      rollAuth: rollAuth != null ? rollAuth : ROLL_AUTHORITY[leg],
    });
  };
  const add = (leg, pos, target, fov, w, rollAuth) => {
    const m = Math.hypot(target.x - pos.x, target.y - pos.y, target.z - pos.z) || 1;
    addDir(leg, pos, dirTo(pos, target), m, fov, w, null, rollAuth);
  };
  // 짐벌 혼합 — 요는 짧은 쪽으로, 피치는 선형. 구면 보간(단위벡터 slerp)은 요가 뒤집힐 때
  //   대원이 천저를 지나므로 카메라 회전 모델로 쓸 수 없다.
  const shortest = (d) => Math.atan2(Math.sin(d), Math.cos(d));
  const blendAim = (a, b, k) => ({
    az: a.az + shortest(b.az - a.az) * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k,
  });
  const dirOfAim = (aim) => dirFromPitch(aim.az, aim.pitch);
  const blend = (a, b, k) => V(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  여정 기하 — 경유지(waypoint)와 그 사이의 성격만 정한다. 제어점 저작은 아래 단일 패스가 한다.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 비트는 "샷"이 아니라 **목적지**다. 각 비트가 다음 비트로 이어지는 이유는 편집이 아니라
  //   "다음 갈 곳이 이미 프레임 안에 있기 때문"이다. 그래서 경유지는 전부 사이트 기하에서 나온다:
  //     원경 진입점(분지 밖 역광측) → 개천 건너 계곡 활강 → 시가지 가장자리 → 지붕 바다 글라이드
  //     → 랜드마크 플라이바이 → 주산 사면 등반·능선 크레스트 → 분지 바깥 복귀 호 → 진입점.

  // 진입 방위(=역광측)와 진행 방위(=태양 방위). jitter 는 진입 방위에만 걸고 진행은 파생한다 —
  //   그래야 "태양을 향해 난다"가 시드와 무관하게 성립한다.
  const approachAz = backAz + jitter(RUN_AZ_JITTER);
  const runAz = approachAz + Math.PI;
  // 등반 선회·복귀 호의 회전 방향(시드 변주). 여정 전체가 이 한 부호로 감긴다.
  const turnSign = rng() < 0.5 ? 1 : -1;

  // 근접도 → 속도 가중. 낮게 날수록 빠르다(위 PROX_* 주석).
  const proxFar = Math.max(AGL_RETURN, Math.min(PROX_FAR_CAP, Hmax * PROX_FAR_K));
  const proxSpan = Math.log(proxFar / PROX_NEAR) || 1;
  const wForClearance = (clear) => {
    const s = clamp01(Math.log(Math.max(PROX_NEAR, clear) / PROX_NEAR) / proxSpan);
    return W_PROX_NEAR + (W_PROX_FAR - W_PROX_NEAR) * s;
  };
  const clearanceOf = (p) => p.y - (safeFloor(p.x, p.z) - GROUND_CLEAR);

  // 진입 시작 고도 — 능선을 프레임의 지정 세로 위치에 놓는 고도(위 APPROACH_RIDGE_NDC). 그래야
  //   첫 프레임 상단이 하늘·헤이즈이고 태양 방위가 화면에 남는다(정점이 완전 하방 부감이 되던 결함).
  // ── 여정의 외곽 반경 ── **지형 메시 밖으로 나가지 않는다.**
  // 종전은 R 비율만 썼고, 그 값이 전 규모에서 terrainR 을 넘었다(실측 마을 266 vs 162 · 도성 414 vs
  //   236 · 한양 740 vs 380). 지형 반경은 분지 + 고정 버퍼로 클램프되고 그 바깥은 worldedge 안개이므로,
  //   진입과 복귀 호의 바깥 절반이 **지면이 없는 허공** 위를 날고 있었다. 그 한 줄이 세 결함을 동시에
  //   만든다: (a) 복귀 호가 불필요하게 길어져 투어 시간의 절반을 먹고 (b) 진입 프레임에 시가지가 담기지
  //   않으며 (c) 평균 속도 가중이 무너져 저공 피크가 계약 상한을 넘는다(한양 37.1m/s).
  // 절대 바닥(R+55)은 외딴집에서 진입 비트가 2.2s 로 쪼그라드는 것을 막는 항이고, 지형 상한이 그보다
  //   우선한다 — 지면이 없는 곳으로 나가느니 진입이 짧은 편이 낫다.
  const outerR = Math.min(Math.max(R * APPROACH_R, R + 55),
    (site.terrainR || R * 1.3) * TERRAIN_KEEP);
  const approachDist = outerR;
  const approachPt = polar(C, approachAz, approachDist);
  // 지형 상한이 진입 거리를 줄였으므로 고도도 함께 내려야 한다 — 같은 낙차를 짧은 수평 거리에
  //   담으면 활강이 가팔라지고, 피치 선행이 그것을 그대로 프레임에 반영해 진입 첫 프레임이 29.6° 로
  //   서 버린다(실측 capital). 그러면 능선 위 하늘 밴드가 0 이 되어 "태양을 향해 들어온다"가 사라진다.
  const approachY = Math.max(
    aglAt(approachPt.x, approachPt.z, Math.max(Hmax * 0.40, R * 0.10)),
    ridgeYFloor(APPROACH_PITCH, APPROACH_FOV, APPROACH_RIDGE_NDC));

  // 진행 축 위의 점(s = 중심으로부터의 거리, 진입측이 양수).
  const runLineAt = (s) => polar(C, approachAz, s);
  // 시가지 가장자리 — 진행 축을 따라 지붕이 처음 나타나는 거리. 계곡 활강이 어디서 끝나고 지붕
  //   글라이드가 어디서 시작하는지의 단일 정의다(규모별 상수를 두지 않는다).
  const fabricEdgeS = (() => {
    for (let s = R * 1.35; s > R * 0.06; s -= R * 0.025) {
      const p = runLineAt(s);
      if (roofDensityAt(parcelObstacles, p.x, p.z, discR).hits > 0) return s;
    }
    return R * 0.4;
  })();
  // ── 직물 envelope ── "여정의 안쪽 비트가 머물러야 하는 원". 중심은 시가지 무게중심(fabC)이고
  //   반경은 **필지 분포에서 파생**한다(저작 상수가 아니다): 필지 중심 거리의 p90 이 시가지 본체의
  //   가장자리이고, 그 밖은 논·개천·수림이라 저공으로 지나면 프레임이 숲으로 찬다.
  // 6차 비전 FIX ① 의 수치 정의다: 플라이바이가 이 원 밖으로 나가면서 카메라가 산비탈 수림 위
  //   AGL 11m 를 날았고(sb-village-14 암전 · 15 캐노피 내부), 그 18초 동안 마을이 프레임에 없었다.
  //   진행 축 스캔이 주는 fabricEdgeS 는 **한 방향** 값이라 시가지가 비대칭이면 과대·과소평가된다 —
  //   둘의 큰 쪽을 쓰되 규모 하한(R·0.18)으로 외딴집·초락에서 원이 붕괴하지 않게 한다.
  const fabricR = (() => {
    const ps = plan.parcels || [];
    const floor = Math.max(R * 0.18, 30);
    if (!ps.length) return Math.max(fabricEdgeS, floor);
    const d = ps.map((p) => Math.hypot(p.center.x - fabC.x, p.center.z - fabC.z))
      .sort((a, b) => a - b);
    const p90 = d[Math.min(d.length - 1, Math.floor(d.length * 0.9))];
    return Math.max(p90, fabricEdgeS * 0.75, floor);
  })();
  // 비전 지정값 그대로 — 직물 가장자리의 0.9 안쪽까지만 들어간다(가장자리 필지도 프레임에 남게).
  const FABRIC_KEEP = 0.9;
  const fabricKeepR = fabricR * FABRIC_KEEP;

  // 계곡 활강은 실제 진입로(동구)를 지나야 한다 — 진행 축을 site.entrance 쪽으로 밀되 양 끝에서
  //   0 으로 수렴시켜(테이퍼) 축 자체는 태양 방위에 남긴다. 개천 건널목이 그 근처라 물이 전경을
  //   와이프하는 프레임도 여기서 나온다.
  const entr = site.entrance || runLineAt(R * 0.9);
  const entrLat = (() => {
    const qx = Math.cos(approachAz), qz = -Math.sin(approachAz);
    return (entr.x - C.x) * qx + (entr.z - C.z) * qz;
  })();

  // ── 능선 크레스트 ── **저작된 복귀 호에서 위치를 파생한다**(반대가 아니다). 복귀는 진입 방위에서
  //   RETURN_SWEEP 만큼 되돌아간 자리에서 시작하고, 크레스트는 거기서 다시 RETURN_ENTRY_ARC 앞이다.
  //   그 방위대는 구조적으로 진행 방향의 **어깨**(runAz ± 26°)라 (a) 등반이 계속 앞으로 나아가면서
  //   주산을 만나고 (b) 정상이 아니라 넘을 수 있는 어깨로 크레스트하며 (c) 복귀 호 길이가 시드와
  //   무관하게 일정하다. 기하에서 각을 재고 부족하면 한 바퀴 더 주던 종전 방식은 실측이 기각했다:
  //   113° 가 최소 120° 에 못 미치자 -473° 가 되어 복귀 하나가 투어의 67% 를 먹었다(마을 213s 중 142s).
  const returnAz0 = approachAz - turnSign * RETURN_SWEEP;
  const returnSweep = turnSign * RETURN_SWEEP;
  const crest = (() => {
    // 크레스트도 지형 안이어야 한다 — 한양은 주산 능선(mountainZ -510)이 terrainR(380) 밖이라
    //   무보정으로 두면 등반이 허공에서 끝난다.
    const rr = Math.min(Math.max(R * 0.78, Math.abs(site.mountainZ || -R) * 0.94), outerR * 0.94);
    const a0 = returnAz0 - turnSign * RETURN_ENTRY_ARC;
    let best = null;
    for (let k = -3; k <= 3; k++) {
      const a = a0 + (k / 3) * CREST_SCAN;
      const p = polar(C, a, rr);
      const h = H(p.x, p.z);
      if (!best || h > best.h) best = { x: p.x, z: p.z, h, az: a, r: rr };
    }
    return best;
  })();
  // 스팬 → 제어점 서술자. 국소 지붕 상단 이동평균 + 스침 여유, 전방 조준(밀집측 오프액시스 + 10° 하향).
  const spanStations = (base, { leg, clear, fov, w, n, drop, side = 0, altCap = null }) => {
    const axisPts = resample(base, n);
    const axisCum = polyCum(axisPts);
    const axisTotal = axisCum[axisCum.length - 1] || 1;
    const offset = bestSideOffset(axisPts);
    // ── 측면 오프셋(2026-08-01 3차 비전 A항) ── 조준을 기울인 쪽(밀집측)으로 비행선을 밀어 담 한 줄이
    //   프레임 하단 중앙을 대각으로 지나게 한다. 조준을 옆으로만 틀면 담은 하단 **코너**에만 걸리고
    //   하단 중앙은 그대로 노면판이다(실측: 하단 중앙 20% 건축 피복 village 50% / capital 60%).
    //   부호 규약: az = atan2(dx, dz) 에서 az 증가 방향의 수평 수직벡터는 (cos az, -sin az) 이므로
    //   조준 오프셋 부호와 같은 쪽이다.
    const headingAtIdx = (i) => {
      const a = polyAt(axisPts, axisCum, Math.max(0, axisCum[i] - 3));
      const b = polyAt(axisPts, axisCum, Math.min(axisTotal, axisCum[i] + 3));
      return Math.atan2(b.x - a.x, b.z - a.z);
    };
    const sideSign = (() => {
      if (offset > 1e-6) return 1;
      if (offset < -1e-6) return -1;
      // 조준이 정면이면 건축이 가까운 쪽으로 붙는다(스팬 전체 합으로 판정 — 결정론).
      let r = 0, l = 0;
      for (let i = 0; i < axisPts.length; i++) {
        const h = headingAtIdx(i);
        const px = Math.cos(h), pz = -Math.sin(h);
        r += obstacleDistance(obstacles, axisPts[i].x + px * side, axisPts[i].z + pz * side);
        l += obstacleDistance(obstacles, axisPts[i].x - px * side, axisPts[i].z - pz * side);
      }
      return r <= l ? 1 : -1;
    })();
    // 스테이션별 허용 최대 오프셋 — 건물 볼륨 밖 최소 이격을 지키는 가장 큰 값.
    const allow = axisPts.map((p, i) => {
      if (side <= 0) return 0;
      const h = headingAtIdx(i);
      const px = Math.cos(h) * sideSign, pz = -Math.sin(h) * sideSign;
      for (let k = 8; k >= 1; k--) {
        const d = (side * k) / 8;
        if (obstacleDistance(obstacles, p.x + px * d, p.z + pz * d) >= FLY_SIDE_KEEP) return d;
      }
      return 0;
    });
    // ── 오프셋 변화율 제한 ── 허용값을 그대로 쓰면 인접 스테이션의 측면 오프셋이 0↔4.5m 로 튀고, 그 폭이
    //   전진 간격(스팬/스테이션 수, capital 스윕에서 5.9m)에 맞먹으면 스플라인이 그 사이에서 되돌아가는
    //   **미세 헤어핀**을 만든다. 호길이 균일 시간축은 왕복 호길이를 정직하게 세므로 그 프레임의 실제
    //   변위가 반으로 줄어 프레임 속도가 19.7→8.7 로 떨어진다(실측 capital 점프 11.0). 양방향 러닝 민으로
    //   Lipschitz 로 만든다 — 값은 오직 **줄어들기만** 하므로 이격 안전은 그대로 보존된다.
    {
      const slope = FLY_SIDE_SLOPE * (axisTotal / Math.max(1, axisPts.length - 1));
      for (let i = 1; i < allow.length; i++) allow[i] = Math.min(allow[i], allow[i - 1] + slope);
      for (let i = allow.length - 2; i >= 0; i--) allow[i] = Math.min(allow[i], allow[i + 1] + slope);
    }
    const pts = axisPts.map((p, i) => {
      if (allow[i] <= 0) return p;
      const h = headingAtIdx(i);
      return {
        x: p.x + Math.cos(h) * sideSign * allow[i],
        z: p.z - Math.sin(h) * sideSign * allow[i],
      };
    });
    const cum = polyCum(pts);
    // 전방 조준 방위 — 한 점이 아니라 세 지점의 평균이다(아래 출력 루프 주석). 개활 판정이 **같은**
    //   방위를 써야 한다: 축 트리밍이 쓰는 국소 접선으로 재면 실제 프레임이 보는 곳과 다르고, 그
    //   차이가 스팬 꼬리에 빈 프레임을 남긴 원인이다(위 FLY_OPEN_* 주석).
    const aimAzAt = (i) => {
      let ax = 0, azs = 0;
      for (const f of [0.75, 1.0, 1.5]) {
        const q = polyAtExt(pts, cum, cum[i] + aheadDist * f);
        ax += q.x / 3; azs += q.z / 3;
      }
      return Math.atan2(ax - pts[i].x, azs - pts[i].z) + offset;
    };
    const raw = pts.map(spanBaseline);
    // ── 고도 프로파일 ── 세 단계로 만든다.
    //   ① 지붕 기준선(+ 골목이면 지면 기준 상·하한)
    //   ② 회랑 지붕 하한: 기준선이 국소 지붕 **평균**이라 평균보다 높은 지붕 한 채가 경로 아래로
    //      들어오면 리프트가 그 자리에서만 올라가고, 그 첨점이 시간축의 호길이 밀도를 튀게 해 한 프레임의
    //      수평 이동이 반으로 줄었다(실측 capital 프레임 속도 19.7→9.5, 점프 10.2). 스윕·골목 모두에 건다.
    //   ③ 하한은 roofTopAt 이 계단함수라 그 자체가 첨점을 만든다. **이웃 최대로 계단을 넓힌 뒤** 3탭
    //      평균으로 평활한다. 넓힌 다음 평균이므로 세 표본 모두 원래 하한 이상이고, 따라서 평균도
    //      하한 이상이다 — 안전은 보존되고 프로파일만 Lipschitz 가 된다.
    const corridorNeed = pts.map((p) => {
      let guard = roofTopAt(obstacles, p.x, p.z);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const t = roofTopAt(obstacles,
          p.x + Math.cos(a) * FLY_CORRIDOR_R, p.z + Math.sin(a) * FLY_CORRIDOR_R);
        if (t != null && (guard == null || t > guard)) guard = t;
      }
      return guard == null ? -Infinity : guard + FLY_CORRIDOR_CLEAR;
    });
    const targetY = pts.map((p, i) => {
      let sum = 0, cnt = 0;
      for (let k = i - 1; k <= i + 1; k++) {
        if (k < 0 || k >= raw.length) continue;
        sum += raw[k]; cnt++;
      }
      const roofY = sum / cnt + clear;
      if (altCap == null) return roofY;
      const ground = H(p.x, p.z);
      return Math.max(ground + FLY_LANE_ALT_MIN, Math.min(roofY, ground + altCap));
    });
    // 하한은 **스칠 만큼 가까운** 지붕에만 건다. 옆으로 지나가는 높은 건축(궁 18m·종가 14m)까지 넘겨
    //   버리면 저공 자체가 사라진다(실측 한양 저공 표본 43%→14%). 판정 근거: 격자가 놓치는 것은 폭이
    //   격자 간격(0.8~1.1m)보다 좁은 **모서리 스침**이고, 그때 필요한 리프트는 작다. 큰 요구량은 넓은
    //   교차에서만 나오고 그것은 리프트 격자가 이미 완만하게 흡수한다.
    const guardRaw = corridorNeed.map((need, i) => (
      need - targetY[i] <= FLY_GUARD_MAX_LIFT ? need : -Infinity));
    // 개활 하한 — 프레임(시선 원뿔)에 건축이 없는 스테이션만 지면 기준으로 들어올린다. 건축이 있으면
    //   -Infinity 라 max() 가 항등이고, 따라서 스팬 전체가 밀집대인 규모에서는 이 항이 존재하지 않는
    //   것과 같다. 이웃 최대 → 3탭 평균은 회랑 하한과 같은 처리라 계단 없이 램프가 된다.
    // 필지 20 미만(외딴집·초락)에는 걸지 않는다. 그 규모에서 원뿔 프로브는 점 표본이라 집 한두 채를
    //   **구조적으로** 놓치고(품질 계약 T8·T15·T16 이 같은 이유로 같은 문턱에서 완화한다), 그러면
    //   스팬 전체가 "개활지"로 판정돼 저공 패스 자체가 사라진다(실측 solo 저공 표본 24%→2%).
    //   그 규모에서는 산·논이 프레임의 정당한 주인공이라는 것도 같은 계약이 이미 인정한 사실이다.
    // 개활 판정 사거리는 **프레임 깊이**여야 한다. 축 채점용 coneFar(aheadDist×1.6 = 도성 54m)를
    //   그대로 쓰면 도로변 건축이 20~30m 물러난 도성에서 20 표본이 전부 그 앞을 스쳐 "개활"로
    //   오판되고, 그 오판이 글라이드 전체를 지면 위 23m 로 들어올린다 — 저공 대역 표본이 0% 가 된
    //   실측(capital)의 원인이 이것이다. 품질 계약(T8)이 커버리지를 재는 사거리와 같은 축척으로 맞춘다.
    // ── 사거리는 **규모에 따라 둘이다** (2026-08-02 #42 R3) ──
    // 위 문단이 넓힌 사거리(max(coneFar, R·0.45))는 도성·한양의 오판을 막지만, 그만큼 개활 판정이
    //   느슨해져 마을 규모에서는 계약이 "개활"이라 부르는 스테이션을 놓친다. 계약(T23)이 쓰는 정의는
    //   **좁은 쪽**(aheadDist×1.6)이고, 그 계약은 R ≤ 190 에서만 적용된다 — 큰 규모에서는 저공 코스가
    //   이미 밀집대 안이라 그 항이 의미가 없다는 같은 이유에서다. 그래서 저작도 그 경계를 따른다:
    //   마을 규모에서는 계약과 같은 좁은 사거리로 판정하고, 큰 규모에서는 넓은 사거리를 유지한다.
    //   실측(village): 넓은 사거리만 쓰면 개활 표본의 지면 기준 고도 중앙값이 12.1m 로 계약 하한 18m
    //   아래에 남았다(넓은 원뿔이 20~30m 뒤의 지붕을 세어 그 스테이션을 개활에서 빼기 때문).
    // 경계값은 계약의 INTRO_REVEAL_MAX_R 과 같은 자리에 둔다 — 저작과 계약이 같은 규모 경계를 본다.
    const OPEN_NARROW_MAX_R = 190;
    const openFar = R <= OPEN_NARROW_MAX_R ? coneFar : Math.max(coneFar, R * 0.45);
    const openRaw = pts.map((p, i) => (
      !denseFabric
        || coneRoofHits(obstacles, p.x, p.z, aimAzAt(i), hHalfOf(fov), openFar).hits >= FLY_OPEN_MIN_HITS
        ? -Infinity : H(p.x, p.z) + FLY_OPEN_AGL));
    // ── 개활 리프트는 이웃으로 넓히지 않는다(2026-08-02 #42 R5) ──
    // 회랑 하한(guardRaw)은 roofTopAt 이 **계단함수**라 이웃 최대로 넓혀야 첨점이 사라진다 — 그것은
    //   지붕과의 충돌을 막는 **안전** 하한이므로 넓혀도 손해가 없다. 개활 리프트는 성격이 다르다:
    //   프레이밍 선호이고, 넓히면 개활 스테이션 하나가 스팬의 3/11(+ 램프)을 저공 대역 밖으로
    //   밀어낸다. 그 손실을 T7(저공 대역 표본 하한·글라이드 저공 비율)이 그대로 받는다.
    // 실측(같은 소스, 이 항만 토글): capital 저공 대역 4%→5% · 글라이드 저공 23%→30% 로 두 FAIL 이
    //   함께 풀리고, village 48%·hanyang 72%·town 77% 는 무변경이다(그 규모는 개활 스테이션이
    //   0 개라 항등). 3탭 평균은 그대로 뒤에 있으므로 프로파일은 여전히 Lipschitz 다.
    const floored = targetY.map((v, i) => Math.max(v,
      guardRaw[Math.max(0, i - 1)], guardRaw[i], guardRaw[Math.min(pts.length - 1, i + 1)],
      openRaw[i]));
    const yAt = floored.map((_, i) => {
      let sum = 0, cnt = 0;
      for (let k = i - 1; k <= i + 1; k++) {
        if (k < 0 || k >= floored.length) continue;
        sum += floored[k]; cnt++;
      }
      return sum / cnt;
    });
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const y = yAt[i];
      // 전방 조준점은 한 점이 아니라 세 지점의 평균이다. 국소 접선을 그대로 겨누면 굽은 골목에서
      //   시선이 노선 곡률을 그대로 따라가 요 각속도가 60°/s 를 넘는다(실측). 리드 구간을 길게
      //   평균하면 같은 "가로를 따라가는" 인상이면서 회전이 완만해진다.
      const az = aimAzAt(i);
      out.push({
        leg, fov, w,
        pos: V(pts[i].x, y, pts[i].z),
        target: V(pts[i].x + Math.sin(az) * aheadDist,
          y - aheadDist * Math.tan(drop * DEG),
          pts[i].z + Math.cos(az) * aheadDist),
      });
    }
    return out;
  };
  const pushDesc = (d) => add(d.leg, d.pos, d.target, d.fov, d.w);
  const descDir = (d) => dirTo(d.pos, d.target);
  const descDist = (d) => Math.hypot(d.target.x - d.pos.x, d.target.y - d.pos.y, d.target.z - d.pos.z);
  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  경유지 → 경로(route) → 제어점. **단일 패스**다: 비트 경계에 특별 취급이 하나도 없다.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 종전은 구간마다 별도의 저작 블록이 있었고 그 사이를 잇는 전이 제어점을 따로 만들었다(오빗 이탈,
  //   스윕 진입, 뱅크 두 점, 골목 꼬리 선회…). 전이가 **저작 단위**로 존재하는 한 그것은 장면 전환이다.
  //   이제 경유지는 하나의 닫힌 리스트이고, 방위는 다음 경유지들에서·피치는 다음 세그먼트의 기울기에서
  //   나온다. 이음매도 그냥 i+1 이다.
  const route = [];
  const pushWp = (leg, pos, o) => {
    route.push({
      leg,
      pos,
      fov: o.fov,
      basePitch: o.basePitch,
      wMult: o.wMult != null ? o.wMult : 1,
      aimAz: o.aimAz != null ? o.aimAz : null,
      subject: o.subject || null,
      pull: o.pull || 0,
      lead: o.lead || 0,
      // 피사체를 놓을 화면 세로 위치(NDC). null 이면 전역 AERIAL_Y_TARGET.
      yTarget: o.yTarget != null ? o.yTarget : null,
      // 2026-08-02 (#42 R2) 시도·기각: 진입 선행을 0.35 → 0.10 으로 내려 첫 프레임 피치를 눕히면
      //   T22 능선 밴드가 열릴 것으로 봤으나 실측은 0.0% 그대로였고(밴드는 화각이 정한다 — 아래
      //   APPROACH_FOV 실험 주석 참조), 대신 **check:cine-warm 이 깨졌다**: 시선이 덜 눕자 원경
      //   프레임에 새 재질이 들어와 투어 중 프로그램이 +2 링크됐다(village t0.506 · hanyang t0.585).
      //   유지 계약이 우선하므로 되돌린다.
      // 피치 선행 계수 — 진입은 **와이드 establishing** 이라 활강 기울기를 그대로 반영하면 안 된다.
      //   지형 상한이 진입 거리를 줄여 활강이 가팔라지자 첫 프레임이 29.6° 로 서면서 능선 위 하늘
      //   밴드가 0 이 됐다(실측). 다이브 선행은 저공 비트의 문법이고 원경 진입의 문법이 아니다.
      pitchLead: o.pitchLead != null ? o.pitchLead : 1,
      // 쪼갠 점이 지표 클리어런스 바닥을 물려받는다(위 간격 균등화 블록).
      aglFloor: o.aglFloor != null ? o.aglFloor : null,
    });
  };

  // ── ① far-approach ── 분지 밖 역광측에서 태양을 향해 들어온다. 마을은 아직 능선 그늘의 실루엣이고
  //   프레임 상단은 하늘·헤이즈다. 여기서 이미 "저기로 간다"가 보이므로 다음 비트가 예고된다.
  // 진입 → 계곡 활강 경계는 **시가지 가장자리에서 파생**한다. outerR 이 지형 상한에 걸리면 규모마다
  //   R 비율이 달라지므로 상수 비율로는 두 비트의 성격이 유지되지 않는다.
  const APPROACH_S1 = fabricEdgeS + (outerR - fabricEdgeS) * 0.45;
  const approachLowAgl = Math.max(Hmax * 0.30, R * 0.085);
  for (let i = 0; i < APPROACH_STEPS; i++) {
    const f = i / APPROACH_STEPS;   // 마지막 점은 계곡 활강이 이어받는다(경계 중복 없음)
    const s = approachDist + (APPROACH_S1 - approachDist) * f;
    const p = runLineAt(s);
    const e = smootherstep(f);
    const y = Math.max(approachY + (aglAt(p.x, p.z, approachLowAgl) - approachY) * e,
      aglAt(p.x, p.z, GROUND_CLEAR + 4));
    pushWp(0, V(p.x, y, p.z), {
      fov: APPROACH_FOV, basePitch: APPROACH_PITCH, wMult: W_TRANSIT,
      subject: coreSubject, pull: 0.86, aglFloor: approachLowAgl, pitchLead: 0.35,
      // ── 진입 프레임에서 마을은 **아래쪽**에 앉는다(2026-08-02 #42 R3) ──
      // T22 능선 밴드가 전 규모에서 0.0% 였던 원인은 고도가 아니라 **프레임 피치**다. 실측(τ0.018):
      //   village pd 24.4° · town 23.6 · capital 28.5 — 저작 APPROACH_PITCH 15° 의 1.6~1.9배다.
      //   진입 스테이션은 pull 0.86 으로 시가지를 프레이밍하므로 피치는 사실상 **하강각**이 정하고,
      //   그 하강각은 카메라가 능선 위에 서는 한 줄어들지 않는다. 그래서 고도를 올리는 종전 처방
      //   (ridgeYFloor)이 역효과였다: 진입 거리 D(≈150m)가 능선 거리(216m)보다 짧아 카메라를 1m
      //   올리면 하강각이 1/D 만큼 늘고 능선 앙각은 1/ridgeDist 만큼만 줄어, **밴드가 오히려 닫힌다**.
      // 남는 축은 구도뿐이고, 그것이 원래 옳은 구도다 — 원경 진입에서 마을은 프레임 아래에 작게
      //   앉고 위쪽은 능선·헤이즈·태양이다. 피사체를 NDC yTarget 에 놓으면 프레임 피치가 정확히
      //   atan(|yT|·tanHalfV) 만큼 눕으므로(pitchForSubject), 밴드를 구도로 직접 연다.
      //   -0.45 는 그 각이 fov 38 에서 8.8° 가 되는 자리이고, 실측 ndc 1.26 → 0.78 (밴드 11%) 이다.
      //   램프로 두어 계곡 활강(yT 기본 -0.08)으로 넘어갈 때 프레임이 튀지 않게 한다.
      yTarget: APPROACH_Y_TARGET + (AERIAL_Y_TARGET - APPROACH_Y_TARGET) * smootherstep(f),
    });
  }

  // ── ② valley-run ── 계곡으로 활강해 개천을 건너 시가지 가장자리까지 낮게 흐른다. 축은 태양 방위
  //   그대로이고, 측면 테이퍼가 코스를 동구(site.entrance)로 밀어 물·논이 전경을 와이프한다.
  const VALLEY_S1 = Math.max(fabricEdgeS * 0.72, R * 0.30);
  {
    const qx = Math.cos(approachAz), qz = -Math.sin(approachAz);
    for (let i = 0; i < VALLEY_STEPS; i++) {
      const f = i / (VALLEY_STEPS - 1);
      const s = APPROACH_S1 + (VALLEY_S1 - APPROACH_S1) * f;
      const p = runLineAt(s);
      const lat = entrLat * Math.sin(Math.PI * f) * 0.85;
      const x = p.x + qx * lat, z = p.z + qz * lat;
      // 활강의 앞부분에서 진입 고도가 계속 내려와 AGL_VALLEY 로 수렴한다(고도 계단 없음).
      const agl = Math.max(AGL_VALLEY,
        approachLowAgl * (1 - smootherstep(Math.min(1, f / 0.45))));
      // 계곡 활강은 **마을을 향해 들어가는** 비트다. 순수 진행 방향 조준으로 두면 축이 site.center
      //   기준인데 시가지 무게중심은 그것과 어긋나 있어(도성·한양은 궁이 북에 치우친다) 프레임에
      //   시가지가 한 표본도 담기지 않는 배치가 나온다(실측 capital valley 커버리지 0%).
      //   진행 방향이 여전히 우세하도록 절반만 끌어당긴다.
      pushWp(1, V(x, aglAt(x, z, agl, AGL_VALLEY_ROOF), z), {
        fov: 50, basePitch: 13 * DEG, wMult: 1.0, aglFloor: AGL_VALLEY,
        subject: coreSubject, pull: 0.5,
      });
    }
  }

  // ── ③ rooftop-glide ── 지붕 바다 위를 일정 클리어런스로 흐른다. 축 선택은 종전 채점기(밀도 스팬 +
  //   원뿔 프로파일 + 무특징 지면 감점 + 전경 밀착)를 그대로 쓰되 **진행 방향 밴드 선호**를 곱한다.
  //   그 항이 없으면 되돌아가는 가로가 뽑혀 여정이 U턴한다(2차 소스는 그 U턴을 뱅크 두 점으로 감쌌다).
  const glideFrom = route[route.length - 1].pos;
  // 축이 **지붕 위를 곧게 흐르는가**를 직접 잰다. 종전 채점(원뿔 프로파일·무특징 감점·전경 밀착)은
  //   전부 "프레임에 무엇이 담기는가"의 대리 지표라, 도성처럼 도로가 넓은 빈터를 지나거나 되꺾이는
  //   배치에서 통과해 버렸다 — 실측 capital: 280m 소로가 뽑혔는데 17 표본 중 13 이 반경 18m 안에
  //   지붕이 한 채도 없었고(그래서 개활 리프트가 정당하게 발동해 저공 대역 표본이 0% 가 됐다),
  //   게다가 그 축은 중간에서 180° 되꺾여 여정이 그 자리에서 U턴했다.
  //   두 항을 곱으로 얹는다: ① 지붕 밀도 점유 ② 직진성(양 끝 직선거리 / 폴리라인 길이).
  const axisRoofFrac = (pts) => {
    const q = resample(pts, 15);
    let hit = 0;
    for (const p of q) if (roofDensityAt(parcelObstacles, p.x, p.z, FLY_BASELINE_DISC).hits > 0) hit++;
    return hit / q.length;
  };
  const axisStraight = (pts) => {
    const a = pts[0], b = pts[pts.length - 1];
    return Math.hypot(b.x - a.x, b.z - a.z) / Math.max(1, polyLen(pts));
  };
  // 축이 **직물 안**에 있는가 — 저공 비트는 시가지 위를 흘러야 한다. 종전 채점(원뿔·무특징·전경 밀착)은
  //   전부 프레임 내용의 대리 지표라, 도성처럼 대로가 도성 밖으로 뻗은 배치에서 시가지를 벗어난 축이
  //   통과했다(실측 capital: 하단 무특징 67% · 전경 밀착 42% · 하단중앙 피복 0% · 저공 표본 0%).
  //   직물 envelope 은 이미 플라이바이가 쓰는 정의이므로 같은 원으로 잰다(단일 정의).
  const axisInFabric = (pts) => {
    const q = resample(pts, 15);
    let inR = 0;
    for (const p of q) if (Math.hypot(p.x - fabC.x, p.z - fabC.z) <= fabricKeepR) inR++;
    return inR / q.length;
  };
  // 비트가 성립하는 최소 축 길이. 이보다 짧으면 글라이드 레그의 대부분이 **연결 전이**가 되어,
  //   축 위의 프레임 어휘(T7 저공·T16 하단중앙)가 전이 표본에 희석된다.
  const glideNeed = Math.max(AXIS_MIN_LEN * 1.6, R * 0.30);
  const glidePick = (() => {
    // 2026-08-02 #42 R3 시도·기각: 길이(glideNeed)를 후보 **필터**로 걸어 "긴 도로가 있는데 채점이
    //   짧은 쪽을 뽑는" 경우를 막아 보았다. 한양은 좋아졌지만(169m 대로) 도성이 84.7m 소로에 갇혀
    //   T8 글라이드 커버리지 4% · T15 무특징 93% · T28 무건축 8.1s 로 무너졌다(전체 실패 26 → 30).
    //   길이 부족의 올바른 해는 후보를 좁히는 것이 아니라 **합성 축을 제대로 푸는 것**이었다
    //   (위 syntheticAxis 주석). 필터는 되돌리고 채점은 종전대로 전 후보에서 한다.
    let best = null, bestScore = -Infinity;
    for (const c of candidates) {
      const oriented = orientFrom(c.pts, glideFrom);
      const a = oriented[0], b = oriented[oriented.length - 1];
      const head = Math.atan2(b.x - a.x, b.z - a.z);
      const roofFrac = Math.pow(Math.max(0.04, axisRoofFrac(c.pts)), 1.2);
      const straight = Math.pow(Math.max(0.05, axisStraight(c.pts)), 1.6);
      // 밴드 선호는 **곱셈 감점**이라 하드 컷이 아니다. 0.32 로 깔았더니 진행 방향에 잘 맞는 53m
      //   소로가 159m 중로를 이겨 글라이드가 5.2s 로 쪼그라들었다(capital 실측) — 내용이 방향을
      //   이기게 바닥을 올린다.
      // 밴드 선호는 **동점 처리**에 가깝게 둔다. 0.58 로 깔았더니 진행 방위에 맞지만 프레임이 빈
      //   축이 뽑혀 저공 대역 표본이 0% 가 됐다(capital 실측: 무특징 지면 80% · 하단중앙 피복 0%).
      //   여정이 되돌아가지 않게 하는 것이 목적이지 축을 고르는 것이 목적이 아니다 — 내용이 이긴다.
      const align = 0.85 + 0.15 * (0.5 + 0.5 * Math.cos(shortest(head - runAz)));
      const inFab = Math.pow(Math.max(0.05, axisInFabric(c.pts)), 1.4);
      const s = sweepScore(c, glideFrom) * align * roofFrac * straight * inFab;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  })();
  // 축이 짧으면 글라이드가 비트로 성립하지 않는다(지붕 바다를 "흐른다"가 아니라 스쳐 지나간다).
  //   합성 축은 시가지 중심을 진행 방위로 관통하므로 길이가 보장된다.
  // ── 축 확정 ── 도로 후보와 합성 축 중 하나. **내용이 길이를 이긴다**(2026-08-02 #42 R3, C항).
  // 종전 순서는 길이를 첫 관문으로 두고, 후보가 need 에 못 미치면 "둘 중 긴 쪽"을 골랐다. 합성 축은
  //   길이가 R·1.0(도성 280m · 한양 400m)으로 **정의상 항상 길기 때문에**, 그 한 줄이 대규모에서
  //   도로 후보를 통째로 기각해 왔다. 실측(2026-08-02): 한양은 roofFrac 0.87 인 178m 대로와 1.00 인
  //   145m 중로를 두고도 roofFrac **0.47** 인 400m 합성 축을 썼고, 도성은 roofFrac 1.00 인 94m 소로를
  //   두고 roofFrac **0.20** 인 280m 합성 축을 썼다. 그 축이 지붕 위를 지나지 않으니 개활 리프트가
  //   정당하게 발동해 저공 대역 표본이 0% 가 된다 — T7·T15·T16 의 도성·한양 실패가 전부 이 한 줄에서
  //   나왔다. (R2 진단이 "도성 밖 소로를 뽑는다"로 읽은 것은 아래 info.glide.road 가 실제 사용 축이
  //   아니라 glidePick 의 등급을 보고하던 **보고 버그** 때문이다. 함께 고친다.)
  // 새 순서: ① 지붕 밀도 ② 직물 포함 ③ 길이. 셋 다 합성 축이 **더 나을 때만** 합성으로 간다.
  let glideSynthetic = !glidePick;
  const glideAxis = (() => {
    const picked = glidePick ? orientFrom(trimAxis(glidePick), glideFrom) : null;
    const synth = orientFrom(syntheticAxis(runAz), glideFrom);
    const use = (v) => { glideSynthetic = (v === synth); return v; };
    if (!picked) return use(synth);
    // ① 지붕 밀도: 도로 후보 자체가 지붕 위를 지나지 않을 수 있다. denseRoadSpan 의 밀도는 **전체
    //   obstacles**(궁·절 포함)로 재므로, 도성에서는 108×150 궁곽을 따라가는 길이 "밀집"으로 잡히고
    //   실제로는 민가가 한 채도 없다(capital 실측 17 표본 중 13 이 반경 18m 내 지붕 0).
    const synthRoof = axisRoofFrac(synth);
    const pickedRoof = axisRoofFrac(picked);
    if (pickedRoof < Math.min(GLIDE_ROOF_MIN, synthRoof)) return use(synth);
    // ② 직물: 지붕 밀도를 통과해도 축 자체가 시가지 원 밖이면 저공 어휘가 성립하지 않는다.
    if (axisInFabric(picked) < Math.min(0.75, axisInFabric(synth))) return use(synth);
    // ③ 길이: 여기까지 왔는데도 짧다면 **길이를 만족하는 도로 후보가 아예 없는 구성**이다(위 필터가
    //   이미 걸렀다). 그때만 종전 규칙 — 둘 중 긴 쪽 — 으로 간다. 합성 축이 시가지 무게중심을
    //   진행 방위로 관통하므로 길이가 보장되는 자리이고, 이 분기가 초락·외딴집의 폴백이다.
    if (polyLen(picked) < glideNeed) {
      return use(polyLen(picked) > polyLen(synth) ? picked : synth);
    }
    return use(picked);
  })();
  const glideSt = spanStations(glideAxis, {
    leg: 2, clear: FLY_ROOF_CLEAR, fov: FLY_FOV, w: 1, n: 11,
    drop: FLY_DROP_DEG, side: FLY_SWEEP_SIDE,
  });
  const glideWpStart = route.length;
  for (const d of glideSt) {
    const hd = Math.hypot(d.target.x - d.pos.x, d.target.z - d.pos.z) || 1;
    pushWp(2, d.pos, {
      fov: FLY_FOV,
      basePitch: Math.atan2(d.pos.y - d.target.y, hd),
      aimAz: Math.atan2(d.target.x - d.pos.x, d.target.z - d.pos.z),
      // 지붕 글라이드는 여정의 **본론**이다. 유도 속도가 이미 최고(클리어런스가 가장 작다)라
      //   연출 계수를 1.0 로 두면 시간 점유가 13% 밖에 되지 않아 저공 어휘 지표(T7·T16·T23)가
      //   전이 표본에 희석된다. 조금 눌러 화면에 머무는 시간을 준다 — 속도 서사는 복귀 대비
      //   2.5배가 남는다(실측).
      wMult: 0.85,
      aglFloor: FLY_ROOF_CLEAR + 6,
    });
  }

  // ── 글라이드 꼬리 조준 해제(2026-08-02 #42 R2) ──
  // 글라이드는 밀집측 오프액시스 + 전방 리드로 조준을 **덮어쓴다**(aimAz). 그 조준은 축 위에서는
  //   옳지만 축이 끝나는 자리에서는 다음 비트(통과선)의 진행 방향과 무관해, 두 스테이션 사이에서
  //   저작 조준이 100° 이상 튄다(실측 마을 147°). 그 초과분은 요 완화 패스가 이웃으로 재분배하므로
  //   **플라이바이 조준이 통째로 뒤처지고** 최근접 프레임에서 피사체가 화각 밖으로 밀린다.
  //   마지막 두 경유지에서 오버라이드를 놓아주면 일반 규칙(다음 두 경유지 평균 = 통과선 진입점)이
  //   대신 들어와 방위가 연속이 된다. 축 본체의 오프액시스 조준(T15·T16 이 재는 것)은 그대로다.
  for (let k = Math.max(glideWpStart, route.length - 2); k < route.length; k++) route[k].aimAz = null;


  // ── ④ landmark-flyby ── **도는 것이 아니라 지나간다.** 통과선은 랜드마크를 스치며 능선 등반 시작점을
  //   향하고(다음 목적지가 프레임 안에 있다), 랜드마크는 그 선에서 정확히 flybyStandoff 만큼 옆에 있다.
  //   시선은 진행 방향에서 피사체로 최대 FLYBY_PULL 까지만 끌렸다가 놓아준다 — 그 상한이 "오빗이
  //   아니다"의 수치 정의이고, 품질 계약 T24 가 프레임 안 가로 위치 진폭으로 그것을 다시 잰다.
  // 통과선의 조준점(다음 목적지). 종전은 max(R·0.42, 이격×1.6) 이라 이격이 커질수록 문이 **밖으로**
  //   밀려 통과선이 직물을 뚫고 나가는 방향을 잡았다. 등반 시작점은 직물 가장자리여야 하므로
  //   (그래야 플라이바이가 시가지 위에서 끝나고 등반이 사면을 만난다) 직물 안으로 클램프한다.
  const climbGate = polar(C, crest.az,
    Math.min(Math.max(R * 0.42, flybyStandoff * 1.2), fabricKeepR + Math.hypot(fabC.x - C.x, fabC.z - C.z)));
  const glideExit = route[route.length - 1].pos;
  // 글라이드가 빠져나가는 진행 방위 — 통과선이 이것을 이어받아야 여정이 U턴하지 않는다.
  const glideHeadAz = (() => {
    const a = route[Math.max(0, route.length - 2)].pos;
    return Math.atan2(glideExit.x - a.x, glideExit.z - a.z);
  })();
  const flybyGeom = {};
  {
    // 통과선은 **랜드마크를 기준으로** 놓는다. 글라이드 이탈점에서 방위를 잡던 종전 구성은, 그 점이
    //   이미 랜드마크를 지나쳐 있는 배치에서 최근접점이 선의 **시작**이 되어 버렸다 — "다가가서 스쳐
    //   간다"가 아니라 "이미 지나친 자리에서 멀어진다"가 된다(실측: 최근접 τ 가 비트 시작이고 그
    //   프레임에서 피사체가 수평 화각 밖 2.5~6.5배). 이제 s=0 이 최근접이고 앞뒤로 lead 만큼 대칭이라,
    //   피사체가 자라며 다가왔다가 지나치며 놓여난다는 성격이 기하에서 보장된다.
    // ── 통과선은 반지름이 아니라 **현(chord)** 이다 (2026-08-02 #42 R2, 6차 비전 FIX ①) ──
    // 종전 방위는 "랜드마크 → 등반 문" 한 방향이었다. 등반 문은 정의상 능선 쪽(=시가지 밖)이므로
    //   그 방위는 구조적으로 직물의 **반지름**이고, 통과선은 최근접점을 지나자마자 시가지를 벗어난다
    //   (실측 아웃바운드 현 길이: village 27.9m · town 14.8m · capital 11.0m · village/2026 **-3.0m** —
    //   마지막은 최근접점이 이미 직물 밖이라는 뜻이다). 그 결과가 τ0.37~0.59 의 프레임 소실이고,
    //   AGL 11m 로 산비탈 수림 위를 나는 sb-village-14(암전)·15(캐노피 내부)다.
    // 그래서 방위를 **푼다**: 직물 원을 가로지르는 현 중에서 (a) 안쪽 구간이 길고 (b) 글라이드 쪽에서
    //   들어와 (c) 등반 문 쪽으로 빠지는 것을 결정론 스캔으로 고른다. 후보는 1° 격자라 시드·규모와
    //   무관하게 재현된다. 이격(flybyStandoff)과 프레이밍 해는 건드리지 않는다 — 방위만 바뀐다.
    const climbAz = Math.atan2(climbGate.x - flybyTarget.x, climbGate.z - flybyTarget.z);
    const chordOf = (az) => {
      const cx = Math.cos(az), cz = -Math.sin(az);
      const lat = (glideExit.x - flybyTarget.x) * cx + (glideExit.z - flybyTarget.z) * cz;
      const sd = lat >= 0 ? 1 : -1;
      const ox = flybyTarget.x + cx * sd * flybyStandoff - fabC.x;
      const oz = flybyTarget.z + cz * sd * flybyStandoff - fabC.z;
      const b = ox * Math.sin(az) + oz * Math.cos(az);
      const cc = ox * ox + oz * oz - fabricKeepR * fabricKeepR;
      const disc = b * b - cc;
      if (disc <= 0) return { az, side: sd, s0: 0, s1: 0, usable: 0 };
      const rt = Math.sqrt(disc);
      const s0 = -b - rt, s1 = -b + rt;
      // 쓸 수 있는 양은 **양쪽 중 짧은 쪽**이다. 한쪽만 길면 "다가왔다 지나친다"가 성립하지 않는다.
      return { az, side: sd, s0, s1, usable: Math.max(0, Math.min(-s0, s1)) };
    };
    const passPick = (() => {
      let best = null;
      for (let k = 0; k < 360; k++) {
        const az = climbAz + (k - 180) * DEG;
        const cand = chordOf(az);
        // 이탈이 등반 문 쪽 — 다음 목적지가 프레임 안에 있어야 한다.
        const outAlign = 0.5 + 0.5 * Math.cos(shortest(az - climbAz));
        // ── 글라이드 진행 방위의 **연속** ── 이 항이 빠지면 통과선이 글라이드 반대쪽으로 잡혀
        //   여정이 이음매에서 U턴한다. 실측(마을): 글라이드 꼬리에서 조준 방위가 4m 세그먼트 위로
        //   144°·149° 튀었고(제어점 i24~26 · i29~31), 그 초과분을 요 완화 패스가 플라이바이 안쪽으로
        //   재분배해 최근접 조준이 31° 뒤처졌다 — 피사체가 프레임 밖으로 나간 직접 원인이다.
        //   지수를 크게 두는 이유: 이것은 취향이 아니라 **연속성 제약**이라 다른 항보다 세야 한다.
        const cont = 0.5 + 0.5 * Math.cos(shortest(az - glideHeadAz));
        // 등반 문 방향은 **하드 선호**다: 통과선이 계곡 활강과 같은 현이 되면 두 비트가 같은 그림을
        //   반복하고(T17) 프레임 안 피사체가 큰 호로 감겨 오빗으로 읽힌다(T24). 실측으로 확인했다 —
        //   현 길이만 최대화한 안은 T17 0.49~0.61 · T24 80~87° 로 네 픽스처를 동시에 깼다.
        const score = cand.usable * Math.pow(outAlign, 6.0) * Math.pow(cont, 1.2);
        if (!best || score > best.score) best = { ...cand, score };
      }
      // 현이 아예 없는 구성(외딴집: 직물이 이격보다 작다)에서는 종전 방위로 되돌아간다.
      return best && best.usable > 1e-3 ? best : { ...chordOf(climbAz), score: 0 };
    })();
    const passAz = passPick.az;
    const qx = Math.cos(passAz), qz = -Math.sin(passAz);
    // 이격 방향은 글라이드 이탈점이 있는 쪽 — 진입이 랜드마크를 가로지르지 않는다.
    const side = passPick.side;
    // ── 통과 고도를 **실제 통과선**에서 다시 푼다 (2026-08-02 #42 R4) ──
    // R2 가 통과 고도를 지표에서 파생시킨 것은 옳았지만, 그 지표를 **이격 반경의 원 전체**에서 최댓값으로
    //   재는 것은 카메라가 가지 않는 자리(랜드마크 뒤편 산비탈)를 통과 고도에 끌어들인다. 원은 최근접점을
    //   모를 때의 대리였고, 여기서는 방위·측면이 이미 확정돼 있으므로 대리가 필요 없다.
    // 실측(종전 원 최댓값 → 통과선): 외딴집 rise 29.0 · 초락 42.9 · 도성 46.1 — 셋 다 통과선 위 지표보다
    //   훨씬 높았다. rise 가 부풀면 하단 절단을 피하려고 이격이 함께 부풀고(d = halfSpan + rise/tan),
    //   그만큼 피사체가 프레임에서 작아진다(T14 가로 점유 외딴집 27.6% · 초락 24.0%, 하한 32%) 동시에
    //   통과 AGL 이 저작 밴드를 넘는다(T25 도성 p95 50.1m, 밴드 상한 43.2). 통과선의 **최근접 창**
    //   (bump ≥ 0.5, 즉 |sn| ≤ 0.5 — 프레이밍이 실제로 판정되는 구간)만 재고, 그 밖은 경유지별
    //   aglAt 클램프가 그대로 안전을 진다.
    const passFloor = (rad) => {
      let top = flybyY0Author;
      for (let k = -6; k <= 6; k++) {
        const sAt = (k / 6) * 0.5 * Math.max(rad * 0.9, R * 0.12);
        const x = flybyTarget.x + qx * side * rad + Math.sin(passAz) * sAt;
        const z = flybyTarget.z + qz * side * rad + Math.cos(passAz) * sAt;
        top = Math.max(top, aglAt(x, z, AGL_VALLEY, FLY_ROOF_CLEAR));
      }
      return top;
    };
    flybyY0 = passFloor(flybyStandoff);
    flybyFrame = flybyPick();
    flybyStandoff = flybyFrame.d;
    flybyFov = flybyFrame.fov;
    flybyGeom.eyeYPass = +flybyY0.toFixed(2);
    // 이격이 바뀌었으므로 직물 현도 같은 방위에서 다시 잰다(방위·측면은 그대로).
    { const re = chordOf(passAz); passPick.s0 = re.s0; passPick.s1 = re.s1; }
    const oX = flybyTarget.x + qx * side * flybyStandoff;
    const oZ = flybyTarget.z + qz * side * flybyStandoff;
    // 종방향 리드가 길수록 피사체가 **자라는 시간**이 길어진다(성장률이 저작이 아니라 기하에서 나온다).
    const leadWant = Math.max(flybyStandoff * 1.5, R * 0.20);
    // 비트가 사라지지 않을 최소 리드 — 이격의 절반(그보다 짧으면 피사체가 자랄 시간이 없다).
    //   양쪽에 같은 하한을 걸어 "지나친 뒤 놓아준다"가 항상 성립하게 한다(비대칭 리드는 최근접점을
    //   비트 끝으로 밀어 T14 가 등반 첫 스테이션을 최근접으로 잡는 병리를 만들었다 — 실측 town
    //   최근접 57.5m @t1.00, 하단 여백 -109%).
    const leadFloor = Math.max(flybyStandoff * 0.9, R * 0.12);
    const leadIn = Math.max(leadFloor, Math.min(leadWant, -passPick.s0));
    const leadOut = Math.max(leadFloor, Math.min(leadWant, passPick.s1));
    const chord = { s0: passPick.s0, s1: passPick.s1 };
    flybyGeom.leadWant = +leadWant.toFixed(1);
    flybyGeom.leadIn = +leadIn.toFixed(1);
    flybyGeom.leadOut = +leadOut.toFixed(1);
    flybyGeom.chord = chord ? [+chord.s0.toFixed(1), +chord.s1.toFixed(1)] : null;
    flybyGeom.oDist = +Math.hypot(oX - fabC.x, oZ - fabC.z).toFixed(1);
    const glideY = glideExit.y;
    for (let i = 0; i < FLYBY_STEPS; i++) {
      const f = i / (FLYBY_STEPS - 1);
      // **정규 통과 진행률**로 배치한다(-1 진입 … 0 최근접 … +1 이탈). 리드가 비대칭이라(직물 현
      //   클램프) 절대 s 로 등간격 배치하면 s=0 이 제어점 사이에 떨어지고, 그러면 pull 램프의 최고점
      //   (index 3 = 1.0)이 최근접과 어긋난다 — 최근접 프레임에서 시선이 진행 방향으로 남아 피사체가
      //   화각 밖으로 나갔다(실측 village 하단 여백 -353% · 가로 점유 1260% = 화각 밖 특이값).
      const sn = -1 + 2 * f;
      const lead = sn >= 0 ? leadOut : leadIn;
      const sAt = sn * lead;
      const x = oX + Math.sin(passAz) * sAt, z = oZ + Math.cos(passAz) * sAt;
      // 최근접에서 통과 고도(피사체 옆)까지 부드럽게 솟았다 내려온다 — 지붕 바다에서 솟는 계단이 없다.
      const bump = smootherstep(Math.max(0, 1 - Math.abs(sn)));
      const yWant = glideY + (flybyY0 - glideY) * bump;
      pushWp(3, V(x, Math.max(yWant, aglAt(x, z, AGL_VALLEY, FLY_ROOF_CLEAR)), z), {
        fov: flybyFov, basePitch: FLYBY_PITCH, wMult: W_FLYBY,
        subject: flybyTarget,
        pull: FLYBY_PULL * FLYBY_PULL_RAMP[Math.min(FLYBY_PULL_RAMP.length - 1, i)],
        lead: -side * FLYBY_LEAD,
        aglFloor: AGL_VALLEY,
      });
    }
  }

  // ── ⑤ ridge-climb ── 주산 사면을 **스치며** 오른다. 고도가 지표 위 클리어런스라 사면 기복이 그대로
  //   비행 프로파일이 되고, 능선이 프레임에서 자라며 다가온다. 직선 등반이 아니라 **선회 등반**이라
  //   크레스트에 도달할 때 이미 복귀 호 방위로 감겨 있다(마루에서 꺾지 않는다).
  {
    const from = route[route.length - 1].pos;
    const crestOut = polar(C, returnAz0, crest.r * 1.02);
    const L = Math.hypot(crestOut.x - from.x, crestOut.z - from.z) || 1;
    // ── 이탈 접선 · 진입 접선(2026-08-02 #42 R3, B항) ──
    // 종전은 from→crestOut 현의 **중점을 옆으로 밀어** 이차 베지에로 감았다. 그 구성은 등반이
    //   출발하자마자 통과선과 무관한 방향으로 꺾이고, 시드에 따라 그 호가 랜드마크 위로 되돌아온다:
    //   실측 등반 첫 스테이션의 랜드마크 거리가 플라이바이 이격보다 **더 가까웠다**(town 26m vs 이격
    //   63.7 · capital 39 vs 136.6 · hanyang 97 vs 147.6). 그러면 통과의 정점이 플라이바이 레그 밖으로
    //   밀려 T14 가 최근접을 t1.00 에서 잡고(실측 town 43.1m@t1.00 · capital 120.0@t1.00 ·
    //   hanyang 131.3@t1.00), 화면에서는 "지나쳐 간다"가 아니라 "도착했다 꺾인다"로 읽힌다.
    // 3차 베지에로 두 접선을 모두 못박는다:
    //   ① 출발 접선 = 통과선의 이탈 방위. 통과선 위에서 랜드마크까지의 거리는 hypot(이격, s) 라
    //      s 가 커지는 방향으로 **단조 증가**하므로, 등반 초입이 그 접선을 물면 되돌아옴이 기하에서
    //      사라진다(레그 경계의 클램프가 아니라 곡선의 성질이다).
    //   ② 도착 접선 = 복귀 호의 시작 접선. polar(C, az, r) 의 az 미분이 (cos az, -sin az) 이고 감김
    //      부호가 turnSign 이므로 그 방향을 그대로 쓴다 — 마루에서 꺾지 않는다는 종전 선언의 구현이다.
    const exitAz = (() => {
      const a = route[Math.max(0, route.length - 2)].pos;
      return Math.atan2(from.x - a.x, from.z - a.z);
    })();
    const c1x = from.x + Math.sin(exitAz) * L * 0.24;
    const c1z = from.z + Math.cos(exitAz) * L * 0.24;
    const inX = turnSign * Math.cos(returnAz0), inZ = -turnSign * Math.sin(returnAz0);
    const c2x = crestOut.x - inX * L * 0.45;
    const c2z = crestOut.z - inZ * L * 0.45;
    let climbY = from.y;
    let prevX = from.x, prevZ = from.z;
    for (let i = 1; i <= CLIMB_STEPS; i++) {
      const f = i / CLIMB_STEPS;
      const u = 1 - f;
      const b0 = u * u * u, b1 = 3 * u * u * f, b2 = 3 * u * f * f, b3 = f * f * f;
      const x = b0 * from.x + b1 * c1x + b2 * c2x + b3 * crestOut.x;
      const z = b0 * from.z + b1 * c1z + b2 * c2z + b3 * crestOut.z;
      const agl = AGL_CLIMB + (AGL_CREST - AGL_CLIMB) * smootherstep(f);
      // 하강 **기울기 제한**. 엄격한 단조(max 누적)로 두면 사면 앞의 안부를 지날 때 고도가 붙잡혀
      //   지표 위 66m 로 떠오르고(마을 실측 p50 66m) 그건 등반이 아니라 부감이다. 반대로 지표를
      //   그대로 따르면 안부에서 급강하가 된다. 내려가되 CLIMB_DROP_SLOPE 보다 가파르게는 못 내려간다.
      const seg = Math.hypot(x - prevX, z - prevZ) || 1;
      climbY = Math.max(aglAt(x, z, agl), climbY - CLIMB_DROP_SLOPE * seg);
      prevX = x; prevZ = z;
      // ── 등반 중에도 시선은 직물을 놓지 않는다(2026-08-02 #42 R3, A항) ──
      // 종전 등반은 subject 가 없어 시선이 순수 진행 방향이었다. 진행 방향은 정의상 능선(=시가지 밖)
      //   이므로 프레임에 건축이 한 표본도 남지 않는다 — 실측(지형 가림을 반영한 프레임 레이캐스트)
      //   으로 마을 픽스처의 **무건축 연속 구간이 11.9s(τ0.469~0.625) · 13.6s(τ0.491~0.661)** 였고,
      //   그 구간이 통째로 등반 레그다. 비전 재판정이 지목한 죽은 프레임(τ0.64~0.74)은 그 꼬리다.
      // 처방은 이미 계곡 활강·복귀 호가 쓰는 것과 같다: 진행 방향 우세를 유지한 채 중심 쪽으로 끌린다.
      //   등반은 피사체에서 **멀어지는** 비트라 거리 조건(±15%)이 구조적으로 깨지므로 T24 오빗 판정과
      //   무관하고, 램프의 양 끝을 이웃 비트(플라이바이 꼬리 pull 0.44 · 복귀 머리 pull)와 맞춰 두면
      //   요 수요도 새로 생기지 않는다.
      pushWp(4, V(x, climbY, z), {
        fov: 44, basePitch: 15 * DEG,
        wMult: f > 0.75 ? W_CREST : 0.94,
        subject: coreSubject,
        pull: CLIMB_CENTRE_PULL[Math.min(CLIMB_CENTRE_PULL.length - 1, i - 1)],
        aglFloor: AGL_CLIMB,
      });
    }
  }

  // ── ⑥ return-arc ── 능선을 넘어 분지 바깥을 크게 돌아 진입점으로 돌아온다. 여정의 결말이자 루프의
  //   폐합이며, 시선이 진행 방향에서 중심 쪽으로 조금씩 더 끌려 마지막에 진입 시선과 만난다
  //   (이음매 연속은 저작이 아니라 이 램프의 자연스러운 끝이다).
  {
    const crestY = route[route.length - 1].pos.y;
    const r0 = crest.r * 1.02, r1 = Math.min(approachDist * RETURN_R1, outerR);
    for (let i = 1; i <= RETURN_STEPS; i++) {
      const f = i / RETURN_STEPS;
      const e = smootherstep(f);
      // 반경은 **후반에 몰아서** 벌린다. 선형·smootherstep 으로 벌리면 평균 반경이 커져 호길이가
      //   그대로 시간이 된다. 크레스트 반경 근처를 오래 유지하다 마지막에 진입 반경으로 나간다.
      const p = polar(C, returnAz0 + returnSweep * f, r0 + (r1 - r0) * e * e);
      const y = Math.max(crestY + (approachY - crestY) * e, aglAt(p.x, p.z, AGL_RETURN));
      pushWp(5, V(p.x, y, p.z), {
        fov: RETURN_FOV, basePitch: RETURN_PITCH,
        wMult: f < 0.7 ? W_RETURN : W_RETURN_TAIL,
        subject: coreSubject,
        pull: RETURN_CENTRE_PULL[Math.min(RETURN_CENTRE_PULL.length - 1, i - 1)],
        aglFloor: AGL_RETURN,
      });
    }
  }

  // ── 경유지 간격 균등화 ── centripetal CatmullRom 은 세그먼트마다 [0,1] 로 재매개되므로, 인접
  //   세그먼트의 길이비가 크면 그 knot 에서 |dP/dt| 가 그 비만큼 튄다(이 파일 TOUR_GRID 주석의 실측).
  //   비트마다 저작 밀도가 다르면(지붕 글라이드 11점/91m vs 플라이바이 7점/540m) 그 비가 10:1 을
  //   넘고, 그것이 프레임 속도 점프로 그대로 나온다(한양 실측 최대 38.8m/s · 프레임당 변화 6.5m/s,
  //   계약 상한 34/3.6). 저작 밀도를 비트마다 맞추는 대신 **긴 세그먼트를 쪼갠다** — 위치·시선·속도
  //   가중을 선형 보간하고 고도는 지표 위 클리어런스로 다시 바닥을 잡으므로, 지형 추종이 오히려 는다.
  {
    const targetGap = () => {
      const g = [];
      for (let i = 0; i < route.length; i++) {
        const a = route[i].pos, b = route[(i + 1) % route.length].pos;
        g.push(Math.hypot(b.x - a.x, b.z - a.z));
      }
      g.sort((x, y) => x - y);
      return g[Math.floor(g.length / 2)] || 1;
    };
    const gap = Math.max(12, targetGap() * 1.6);
    for (let pass = 0; pass < 6; pass++) {
      // ── 이웃 세그먼트 길이비 상한 (2026-08-02 #42 R3) ──
      // 전역 상한(gap = 중앙값×1.6)만으로는 **국소** 비를 못 잡는다: 중앙값이 큰 규모에서는 gap 이
      //   커져, 짧은 세그먼트 옆의 긴 세그먼트가 상한 아래로 통과한다. 실측(2026-08-02, 계곡 활강 →
      //   지붕 글라이드 이음): capital cp13 이 10.1m ↔ 28.2m(2.8배) · hanyang cp11 이 31.9 ↔ 40.0 ·
      //   village cp10 이 7.4 ↔ 17.7. **전 규모의 프레임 잔차 최대점(T21)이 정확히 그 자리**였고,
      //   capital 은 같은 자리에서 프레임 속도가 0.91m/s 까지 떨어지고 점프가 5.49 였다(T2).
      //   centripetal CR 은 세그먼트마다 [0,1] 로 재매개되므로 국소 길이비가 곧 |dP/dt| 계단이다 —
      //   재는 양이 국소 비이므로 상한도 국소여야 한다. 하한 8m 는 이 조임이 무한 세분으로 가지
      //   않게 하는 바닥(프레임 이동거리의 열 배 이상이라 곡선 형상에는 영향이 없다).
      const segLen = [];
      for (let i = 0; i < route.length; i++) {
        const a = route[i].pos, b = route[(i + 1) % route.length].pos;
        segLen.push(Math.hypot(b.x - a.x, b.z - a.z));
      }
      const out = [];
      let split = 0;
      for (let i = 0; i < route.length; i++) {
        const e = route[i], nx = route[(i + 1) % route.length];
        out.push(e);
        const d = Math.hypot(nx.pos.x - e.pos.x, nx.pos.z - e.pos.z);
        const nb = Math.min(segLen[(i - 1 + route.length) % route.length],
          segLen[(i + 1) % route.length]);
        const cap = Math.min(gap, Math.max(8, nb * SEG_RATIO_MAX));
        const parts = Math.min(6, Math.ceil(d / cap));
        if (parts <= 1) continue;
        split++;
        for (let k = 1; k < parts; k++) {
          const f = k / parts;
          const x = e.pos.x + (nx.pos.x - e.pos.x) * f;
          const z = e.pos.z + (nx.pos.z - e.pos.z) * f;
          const yLin = e.pos.y + (nx.pos.y - e.pos.y) * f;
          // 고도는 선형 보간 **위에** 지표 클리어런스 바닥을 다시 건다. 두 경유지 사이에서 지표가
          //   솟으면 직선 보간은 그 언덕을 뚫거나 AGL 이 꺼진다(실측 플라이바이 AGL p05 3.2m).
          const floorAgl = Math.min(e.aglFloor != null ? e.aglFloor : AGL_VALLEY,
            nx.aglFloor != null ? nx.aglFloor : AGL_VALLEY);
          // 2026-08-02 #42 R3 시도·기각: 개활 하한(FLY_OPEN_AGL)을 쪼갠 점에도 걸어 저공 레그의
          //   **연결 전이**까지 덮어 보았다. 계약(T23)이 재는 개활 표본의 고도 중앙값은 village
          //   12.1m 그대로였고(조준 방위를 다음 경유지 방향으로 근사했는데, 계약은 재생 표본의 실제
          //   시선 방위로 재므로 두 판정이 같은 표본을 고르지 않는다) 대신 전이 고도가 올라가면서
          //   village 속도 스프레드가 2.97 · 시선 p99 20.0 로 T20·T3 를 깨고 capital 저공 표본이
          //   5%→3% 로 내려갔다(전체 실패 20 → 25). 되돌린다.
          const y = Math.max(yLin, aglAt(x, z, floorAgl, FLY_ROOF_CLEAR));
          out.push({
            leg: e.leg,
            pos: V(x, y, z),
            fov: e.fov + (nx.fov - e.fov) * f,
            basePitch: e.basePitch + (nx.basePitch - e.basePitch) * f,
            wMult: e.wMult + (nx.wMult - e.wMult) * f,
            pitchLead: e.pitchLead + (nx.pitchLead - e.pitchLead) * f,
            // 전방 조준 오버라이드는 **이어받지 않는다** — 쪼갠 점은 진행 방향에서 방위를 새로 푼다.
            aimAz: null,
            subject: e.subject && nx.subject === e.subject ? e.subject : null,
            pull: e.subject && nx.subject === e.subject ? e.pull + (nx.pull - e.pull) * f : 0,
            lead: e.lead + (nx.lead - e.lead) * f,
            yTarget: e.yTarget != null && nx.yTarget != null
              ? e.yTarget + (nx.yTarget - e.yTarget) * f
              : (e.yTarget != null ? e.yTarget : nx.yTarget),
            aglFloor: floorAgl,
          });
        }
      }
      route.length = 0;
      for (const o of out) route.push(o);
      if (!split) break;
    }
  }

  // ── 경로 평활(고도·화각) ── 비트 사이에서 저작 의도가 다르면 한 경유지 폭의 계단이 남는다. 주기
  //   3탭 평균 한 번으로 그 계단만 지운다(안무는 경유지 간격 스케일이라 손대지 않는다). 안전은
  //   아래 리프트 격자와 하드 안전망이 그대로 지키므로 여기서 하한을 다시 걸지 않는다.
  {
    const n = route.length;
    const ys = route.map((e) => e.pos.y);
    const fs = route.map((e) => e.fov);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      route[i].pos.y = (ys[a] + ys[i] * 2 + ys[b]) * 0.25;
      route[i].fov = (fs[a] + fs[i] * 2 + fs[b]) * 0.25;
    }
  }

  // ── 제어점 저작(단일 패스) ── 방위는 **다음 경유지들**에서, 피치는 **다음 세그먼트의 기울기**에서.
  //   경로가 닫혀 있으므로 이 계산에는 비트 경계가 존재하지 않는다.
  // 해를 함수로 둔다 — 이 값들은 전부 **경유지 위치의 함수**이고, 아래 미세 접힘 가드가 그 위치를
  //   옮기기 때문이다(2026-08-02 #42 R6, A-1). 같은 입력에서 같은 결과인 순수 함수다.
  const solveStation = (i) => {
    const n = route.length;
    const at = (k) => route[((k % n) + n) % n].pos;
    const e = route[i];
    const p = e.pos;
    const b = at(i + 1), c2 = at(i + 2);
    // 리드 평균 — 한 점만 겨누면 굽은 가로에서 시선이 노선 곡률을 그대로 따라가 요가 몰아친다.
    const headAz = e.aimAz != null ? e.aimAz
      : Math.atan2((b.x + c2.x) * 0.5 - p.x, (b.z + c2.z) * 0.5 - p.z);
    const runD = Math.hypot(b.x - p.x, b.z - p.z) || 1;
    // **피치가 고도 변화를 선행한다**: 다음 세그먼트의 기울기를 지금 프레임에 반영하므로, 활강 전에
    //   틸트다운이 먼저 오고 등반 전에 시선이 먼저 든다. 실기 짐벌이 기체보다 먼저 움직이는 순서다.
    const slope = Math.atan2(p.y - b.y, runD);
    const leadK = e.pitchLead != null ? e.pitchLead : 1;
    const lead = (slope >= 0 ? PITCH_LEAD_GAIN : PITCH_LEAD_GAIN * PITCH_LEAD_UP) * leadK;
    const pitch = Math.max(PITCH_FLOOR,
      Math.min(PITCH_CEIL, e.basePitch + lead * slope));
    let aim = { az: headAz, pitch };
    let dist = Math.max(AIM_MIN, Math.hypot(c2.x - p.x, c2.y - p.y, c2.z - p.z));
    if (e.subject && e.pull > 0) {
      const look = aimAtSubject(p, e.subject, e.fov, e.lead, e.yTarget);
      aim = blendAim(aim, aimOfDir(look.dir), e.pull);
      dist = Math.max(AIM_MIN, look.dist);
    }
    // 속도는 **클리어런스에서 유도**한다(저작 상수가 아니다). 낮게 날수록 빠르다.
    return { aim, dist, headAz, pitch, w: wForClearance(clearanceOf(p)) * e.wMult };
  };
  {
    for (let i = 0; i < route.length; i++) {
      const e = route[i];
      const s = solveStation(i);
      addDir(e.leg, e.pos, dirOfAim(s.aim), s.dist, e.fov, s.w, e.subject, ROLL_AUTHORITY[e.leg],
        { pull: e.pull, lead: e.lead, baseAz: s.headAz, basePitch: s.pitch, yTarget: e.yTarget });
    }
  }

  // ── 미세 접힘 가드 ── 이웃 스테이션이 **짧은 세그먼트로 되돌아오는** 배치가 생기면(스팬 축 선택·측면
  //   오프셋·연결부 기하가 시드마다 달라 어느 규모에서든 생길 수 있다) 그 자리에서 위치 곡선이 왕복하고,
  //   호길이 균일 시간축은 그 왕복을 정직하게 세므로 그 한 프레임의 **변위**가 절반으로 떨어진다
  //   (실측 프레임 속도 19.7→8.7, 프레임당 변화 5.7~14.8m/s, 계약 상한 3.6). 시드마다 개별 기하를 손보는
  //   대신 일반 가드로 둔다: 큰 반전(>FOLD_TURN)이 **짧은 세그먼트**와 함께 오면 그 스테이션을 이웃 현의
  //   중점 쪽으로 당긴다. 긴 세그먼트의 큰 전환(오빗 이탈 142°, 이음매 143°)은 길이 조건이 걸러 내므로
  //   저작된 안무는 건드리지 않는다. 시간축 쪽에서 비용을 평활하는 대안은 기각됐다(buildTimeAxis 주석).
  {
    const foldLen = Math.max(8, R * 0.06);
    for (let pass = 0; pass < FOLD_PASSES; pass++) {
      let fixed = 0;
      for (let i = 0; i < stations.length; i++) {
        const n = stations.length;
        const a = stations[(i - 1 + n) % n].pos, b = stations[i].pos, c = stations[(i + 1) % n].pos;
        const v1x = b.x - a.x, v1z = b.z - a.z, v2x = c.x - b.x, v2z = c.z - b.z;
        const m1 = Math.hypot(v1x, v1z), m2 = Math.hypot(v2x, v2z);
        if (m1 < 1e-6 || m2 < 1e-6) continue;
        const cos = (v1x * v2x + v1z * v2z) / (m1 * m2);
        // ── 되꺾임(reversal)은 길이 조건을 타지 않는다 (2026-08-02 #42 R4) ──
        // 위 문단의 길이 조건은 **저작된 큰 전환**(오빗 이탈 142°·이음매 143°)을 보호하려고 둔 것인데,
        //   그 조건이 저작에 존재하지 않는 병리까지 함께 통과시켰다: 계곡 활강 → 지붕 글라이드 이음과
        //   글라이드 → 플라이바이 이음에서 경로가 **정확히 180° 되돌아온다**(capital 실측 cos -0.999
        //   @40.3m/28.2m · cos -1.000 @46.1m/64.6m — 둘 다 min 세그먼트가 foldLen 16.8m 를 넘어
        //   가드가 건너뛰었다). 되꺾임은 저공 축의 끝이 들어오는 지점보다 **뒤에** 있을 때 생기고,
        //   화면에서는 30m/s 로 날다 한 점에서 멈췄다 되돌아가는 것으로 읽힌다(그 자리의 프레임 속도
        //   실측 0.48m/s — T2 하한 2.0 의 1/4). 저작된 전환은 최대 143° 이므로 155° 를 넘는 반전은
        //   정의상 안무가 아니다 — 그 경우에만 길이 조건을 면제한다.
        const reversal = cos <= Math.cos(FOLD_REVERSE);
        if (!reversal && Math.min(m1, m2) >= foldLen) continue;
        if (cos > Math.cos(FOLD_TURN)) continue;
        // 3차원 전체를 당긴다. 수평만 당기면 capital 프레임당 속도 변화가 13.2 로 남는다 — 그 시드의
        //   접힘은 회랑 지붕 하한이 만든 **수직** 첨점이기 때문이다(수평 지그재그만 있는 것이 아니다).
        stations[i].pos = V(b.x + ((a.x + c.x) * 0.5 - b.x) * FOLD_PULL,
          b.y + ((a.y + c.y) * 0.5 - b.y) * FOLD_PULL,
          b.z + ((a.z + c.z) * 0.5 - b.z) * FOLD_PULL);
        // 경유지와 스테이션은 이 지점까지 1:1 이고 위치 객체를 공유한다. 가드가 새 벡터를 넣으면 그
        //   공유가 끊기므로 경유지 쪽도 함께 옮긴다 — 아래 재해가 경유지 위치에서 방위를 다시 푼다.
        route[i].pos = stations[i].pos;
        fixed++;
      }
      if (!fixed) break;
    }
    // ── 접힘 가드가 위치를 옮겼으면 **방위를 다시 푼다** (2026-08-02 #42 R6, A-1) ──
    // 저작 방위는 진행 방향(다음 두 경유지의 평균)에서 나오므로 **위치의 함수**다. 가드는 위치만
    //   옮기고 방위를 그대로 두었고, 그래서 가드가 되꺾임을 편 자리에 "펴진 경로 + 되꺾임 시절의 조준"
    //   이 남았다. 화면에서 그것은 1m 남짓 이동하는 동안 카메라가 116~165° 를 홱 도는 것이다.
    // 실측(가드 직후 저작 스테이션, 완화 전): village i27→i28 이 1.13m 위 -164.6° · village/2026
    //   i27→i28 이 1.43m 위 115.7°. 그 자리의 시간 예산은 0.05s(바닥)라 상한이 0.75° 이므로 완화
    //   패스가 떠안는 초과분이 한 자리에서 ~150° 다. 완화는 총 감김을 보존하는 재분배이므로 그
    //   초과분은 이웃 비트로 밀려나고, village/2026 에서는 8 스테이션 뒤 플라이바이 최근접까지 가서
    //   조준을 26.6° → 53.2° 로 뒤처지게 했다(수평 반각 38.4° 밖 = 피사체가 프레임 밖, T14 하단
    //   여백 -7.5%). 즉 이 초과분은 저작된 안무가 아니라 **낡은 조준이 만든 유령**이다.
    // 가드는 수렴하면 더 옮기지 않으므로(fixed === 0 에서 멈춘다) 재해는 한 번으로 충분하다.
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      const s = solveStation(i);
      st.az = s.aim.az;
      st.pitch = s.aim.pitch;
      st.dist = s.dist;
      st.baseAz = s.headAz;
      st.basePitch = s.pitch;
      st.w = s.w;
    }
  }

  // ── 방향 변화 상한 세분 ── 스테이션 간 방향차가 상한을 넘으면 그 사이를 나눈다. 위치는 직선 보간
  //   (전이 구간에만 발동하므로 경로 형상은 사실상 그대로), 방향은 slerp, leg 태그는 앞 스테이션을
  //   물려받아 구간 경계 인덱스를 흔들지 않는다.
  // 2026-08-02 #42 R3 시도·기각: 이 세분에 **길이비 조건**을 함께 걸어(이웃 세그먼트의 1.8배 상한)
  //   최종 스테이션 간격의 비까지 조여 보았다. T21 프레임 잔차는 거의 그대로였고(capital 0.359 →
  //   0.267, 여전히 상한 0.22 초과) 대신 끼워 넣은 점의 방향이 blendAim 선형 보간이라 요·피치 장이
  //   흔들려 village/2026 의 시선 각속도가 24.6°/s(p99 22.1)로 계약 T3 를 깼다. 길이비는 **경유지**
  //   단계에서만 조인다(위 균등화 블록) — 그 단계의 보간은 저작 의도를 함께 나르지만, 여기서의
  //   보간은 이미 확정된 시선 장에 점을 끼워 넣는 것이라 성질이 다르다.
  {
    const out = [];
    for (let i = 0; i < stations.length; i++) {
      const a = stations[i], b = stations[(i + 1) % stations.length];
      out.push(a);
      const turn = Math.max(Math.abs(shortest(b.az - a.az)), Math.abs(b.pitch - a.pitch));
      const parts = Math.ceil(turn / MAX_STATION_TURN);
      for (let k = 1; k < parts; k++) {
        const f = k / parts;
        const aim = blendAim(a, b, f);
        out.push({
          leg: a.leg,
          subject: null,
          pos: V(a.pos.x + (b.pos.x - a.pos.x) * f, a.pos.y + (b.pos.y - a.pos.y) * f,
            a.pos.z + (b.pos.z - a.pos.z) * f),
          az: aim.az,
          pitch: aim.pitch,
          dist: a.dist + (b.dist - a.dist) * f,
          fov: a.fov + (b.fov - a.fov) * f,
          w: a.w + (b.w - a.w) * f,
          rollAuth: a.rollAuth + (b.rollAuth - a.rollAuth) * f,
        });
      }
    }
    stations.length = 0;
    for (const s of out) stations.push(s);
  }

  // ── 곡선 ──
  const N = stations.length;
  const posCurve = new THREE.CatmullRomCurve3(stations.map((s) => s.pos), true, 'centripetal');
  // ── 시간축 A(예비) ── 리프트 이전 원곡선의 호길이·속도가중 매핑. 방향 평활 커널 폭을 **초 단위**로
  //   잡기 위한 기준이며, 최종 시간축(B)은 리프트·안전망까지 반영해 다시 만든다.
  const buildTimeAxis = (grid, posOf) => {
    const arc = new Float64Array(grid + 1);
    const tau = new Float64Array(grid + 1);
    let prev = posOf(0);
    for (let j = 1; j <= grid; j++) {
      const p = posOf(j / grid);
      const d = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
      arc[j] = arc[j - 1] + d;
      tau[j] = tau[j - 1] + d / Math.max(0.25, closedScalarAt(weights, (j - 0.5) / grid));
      prev = p;
    }
    // 셀별 호길이를 이동평균으로 평활해 미세 접힘의 시간 도둑질을 없애 보려 했으나 실측이 기각했다:
    //   창(1.6m)이 프레임 이동거리의 몇 배라 centripetal CR **knot 에서의 매개속도 불연속**까지 프레임
    //   스케일로 퍼뜨려, 전 규모에서 프레임당 속도 변화가 4.9~14.8m/s 로 오히려 커졌다. 시간축은 셀별
    //   호길이를 그대로 쓰고(격자를 프레임보다 촘촘히 깔아 knot 을 평균), 접힘은 제어점 기하에서 없앤다.
    const total = tau[grid] || 1;
    for (let j = 0; j <= grid; j++) tau[j] /= total;
    return {
      arcLength: arc[grid],
      // τ → t (단조 증가 표의 역보간).
      tOf: (u) => {
        const x = clamp01(u);
        let lo = 0, hi = grid;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (tau[mid] <= x) lo = mid; else hi = mid;
        }
        const seg = (tau[hi] - tau[lo]) || 1;
        return (lo + (x - tau[lo]) / seg) / grid;
      },
      // t → τ (구간 경계 시각·방향장 인덱싱).
      tauOf: (t) => {
        const g = clamp01(t) * grid;
        const i0 = Math.floor(g), i1 = Math.min(grid, i0 + 1);
        return tau[i0] + (tau[i1] - tau[i0]) * (g - i0);
      },
    };
  };
  // 속도 가중·화각은 리프트와 무관하므로 시간축보다 먼저 잡는다. 시선(요·피치·거리)만 리프트 확정
  //   뒤에 다시 푼다(아래 재해결 블록).
  const weights = stations.map((s) => s.w);
  const fovs = stations.map((s) => s.fov);
  const speed = Math.min(TOUR_SPEED_MAX, Math.max(TOUR_SPEED_MIN, R * TOUR_SPEED_K));
  const axisA = buildTimeAxis(TOUR_GRID_A, (t) => posCurve.getPoint(t));
  const durA = Math.min(TOUR_SEC_MAX, Math.max(TOUR_SEC_MIN, axisA.arcLength / speed));

  // ── 안전 리프트(지형·지붕 → 수관 시선) ── **호길이 균일** 격자(τ_A)에서 요구량을 풀고 주기 확산.
  const LIFT_GRID = Math.min(LIFT_GRID_MAX,
    Math.max(LIFT_GRID_MIN, Math.round(axisA.arcLength / LIFT_SPACING)));
  const liftT = new Float64Array(LIFT_GRID);      // 격자 셀 → 곡선 파라미터 t
  const basePos = new Array(LIFT_GRID);
  for (let i = 0; i < LIFT_GRID; i++) {
    liftT[i] = axisA.tOf(i / LIFT_GRID);
    basePos[i] = posCurve.getPoint(liftT[i]);
  }
  const rampCells = LIFT_RAMP_T * LIFT_GRID;
  const floorRaw = new Float64Array(LIFT_GRID);
  for (let i = 0; i < LIFT_GRID; i++) {
    const p = basePos[i];
    const need = safeFloor(p.x, p.z) - p.y;
    // 요구량이 있는 자리에는 여유를 얹는다. safeFloor 는 (x,z) 의 **계단함수**라 격자 사이에서 잔차가
    //   남고, 그 잔차를 하드 안전망이 한 프레임에 메우면서 수직 계단이 생긴다(실측 hamlet: 3프레임
    //   고도 고정 후 0.18m 계단 → 수직 속도 -10.9m/s, 프레임 속도 점프 3.92m/s = 계약 상한 3.6 초과).
    //   여유는 리프트가 걸리는 구간에만 붙으므로 저공 대역 어휘(T7)를 전역으로 밀어 올리지 않는다.
    floorRaw[i] = need > 0 ? need + LIFT_MARGIN : 0;
  }
  const floorLift = spreadPeriodic(floorRaw, rampCells);
  // ── 시선 해결(2패스) ── 리프트가 확정된 고도에서 프레이밍 시선을 다시 풀고, 요·피치 장을 다시
  //   만든다. 수관 리프트는 시선을 알아야 풀리므로(닭-달걀) 바닥 리프트로 1차 해결 → 수관 리프트 →
  //   전체 리프트로 2차 해결한다. 스테이션 위치는 불변이라 두 번 호출해도 같은 입력에서 같은 결과다.
  const buildLook = (liftOf) => {
    // ── 프레이밍 시선 재해결 ── 안전 리프트가 확정된 뒤, 피사체를 프레이밍하는 스테이션의 시선을
    //   **리프트된 고도**에서 다시 푼다. 리프트는 카메라를 들어올리지만 저작 시점의 시선은 그대로여서
    //   피사체가 프레임 아래로 밀려 내려가고, 깊은 곽(궁 150m)은 근단이 하단 밖으로 잘렸다(실측 -27%).
    //   위치 곡선은 t=i/N 에서 정확히 그 스테이션을 지나므로 그 지점의 리프트가 곧 최종 수직 오프셋이다.
    //   재해결은 **저작된 pull 비율을 그대로 다시 적용한다**. 정조준으로 되돌리면 플라이바이가
    //   오빗이 되고(피사체 못박힘) 진행 방향 성분이 사라진다.
    for (let i = 0; i < N; i++) {
      const st = stations[i];
      if (!st.subject || st.pull <= 0) continue;
      const lifted = V(st.pos.x, st.pos.y + liftOf(i / N), st.pos.z);
      const look = aimAtSubject(lifted, st.subject, st.fov, st.lead, st.yTarget);
      const blended = blendAim(
        { az: st.baseAz, pitch: st.basePitch }, aimOfDir(look.dir), st.pull);
      st.az = blended.az;
      st.pitch = blended.pitch;
      st.dist = Math.max(AIM_MIN, look.dist);
    }

      // ── 요 팬 완화 ── **프레이밍 재해결 직후**에 돈다. 재해결은 리프트된 고도에서 조준을 다시 풀며
    //   요를 저작값으로 되돌리므로, 완화를 그 앞에서 하면 무효화된다(실측: 완화 후에도 31°/s 잔존). 스테이션 요를 **시간 가중 라플라시안**으로 확산시킨다. 하드 캡은
    //   루프 총 감김을 만족시킬 수 없을 때 잔차를 한 이음매에 몰아 오히려 그 자리에서 터진다. 확산은
    //   총 감김을 보존하면서(선형 램프의 라플라시안은 0 — 등속 선회는 그대로다) **곡률만** 깎으므로
    //   전이 구간의 급팬만 눕는다. 실측 34~133°/s → 23~29°/s.
    {
      const n = stations.length;
      const speedEst = Math.min(TOUR_SPEED_MAX, Math.max(TOUR_SPEED_MIN, R * TOUR_SPEED_K));
      const dt = new Float64Array(n);
      const gaps = new Float64Array(n);
      const wMid = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = stations[i], b = stations[(i + 1) % n];
        gaps[i] = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z);
        wMid[i] = Math.max(0.05, 0.5 * (a.w + b.w));
      }
      // 국소 대지속도는 speedEst × w 가 **아니다**. 시간축이 τ ∝ ∫ds/w 이므로 실제로는
      //   speed_local = speed_mean × w / w̄  (w̄ = 호길이 가중 조화평균)이다. w̄ 를 빼먹으면 상한이
      //   1/w̄ 배만큼 헐거워지고, 더 나쁘게는 **한 구간의 가중치를 바꾸면 다른 구간의 실효 상한이 같이
      //   움직인다**(실측: 리빌 전반 가중을 0.98→0.46 으로 내리자 외딴집 저공 구간 각속도가 20.2→26.3°/s).
      //   w̄ 로 정규화하면 상한이 선언대로 °/s 를 뜻하고 구간 간 결합도 사라진다.
      let arcSum = 0, arcOverW = 0;
      for (let i = 0; i < n; i++) { arcSum += gaps[i]; arcOverW += gaps[i] / wMid[i]; }
      const wBar = arcOverW > 0 ? arcSum / arcOverW : 1;
      for (let i = 0; i < n; i++) {
        dt[i] = Math.max(0.05, gaps[i] / Math.max(1, speedEst * (wMid[i] / wBar)));
      }
      // 언랩 + 이음매 고정(감김 보존).
      const yaw = new Float64Array(n + 1);
      yaw[0] = stations[0].az;
      for (let i = 1; i < n; i++) yaw[i] = yaw[i - 1] + shortest(stations[i].az - yaw[i - 1]);
      yaw[n] = yaw[n - 1] + shortest(stations[0].az - yaw[n - 1]);
      // 상한을 **넘는 구간만** 완화한다(전역 라플라시안 확산은 순응 구간의 조준까지 흐트러뜨려
      //   피사체가 프레임에서 빠졌다 — 실측 커버리지 100%→62%).
      for (let pass = 0; pass < YAW_RELAX_PASSES; pass++) {
        let worst = 0;
        for (let i = 0; i < n; i++) {
          const d = yaw[i + 1] - yaw[i];
          const cap = AUTHOR_YAW_RATE * dt[i];
          const over = Math.abs(d) - cap;
          if (over <= 0) continue;
          worst = Math.max(worst, over);
          const shift = Math.sign(d) * over * 0.5;
          if (i > 0) yaw[i] += shift;
          if (i + 1 < n) yaw[i + 1] -= shift;
        }
        if (worst < 1e-4) break;
      }
      for (let i = 0; i < n; i++) stations[i].az = yaw[i];
    }

  // 요·피치 장(단위벡터 보간은 요 반전 구간에서 천저를 지난다).
    // 시선은 **요·피치 장**으로 보간한다.
    //   요는 루프를 돌며 언랩하고, 총 감김 W 를 선형항으로 빼 잔차를 주기함수로 만든다:
    //     yaw(t) = closedSpline(residual, t) + W·t,  residual[i] = yaw[i] - W·i/N
    //   이렇게 하면 이음매에서도 요가 연속이고(잔차가 주기), 총 회전은 보존된다.
    const yawUnwrapped = new Float64Array(N);
    yawUnwrapped[0] = stations[0].az;
    for (let i = 1; i < N; i++) {
      yawUnwrapped[i] = yawUnwrapped[i - 1] + shortest(stations[i].az - yawUnwrapped[i - 1]);
    }
    const yawWinding = (yawUnwrapped[N - 1]
      + shortest(stations[0].az - yawUnwrapped[N - 1])) - yawUnwrapped[0];
    const yawResidual = new Float64Array(N);
    for (let i = 0; i < N; i++) yawResidual[i] = yawUnwrapped[i] - yawWinding * (i / N);
    const pitches = stations.map((s) => s.pitch);
    const dists = stations.map((s) => s.dist);

    // ── 짐벌 관성 ── 방향장을 **시간축(τ_A)** 위에서 Hann 창으로 평활한다. 저작된 전이(오빗 이탈,
    //   골목 진입, 상승 시작)는 제어점 하나 폭의 좁은 스파이크를 남기는데, 실제 드론 짐벌도 그런
    //   순간 회전을 하지 못한다. 창은 주기적이므로 이음매에서도 연속이다.
    const yawGrid = new Float64Array(DIR_GRID);
    const pitchGrid = new Float64Array(DIR_GRID);
    {
      const rawYaw = new Float64Array(DIR_GRID);
      const rawPitch = new Float64Array(DIR_GRID);
      for (let i = 0; i < DIR_GRID; i++) {
        const u = i / DIR_GRID;
        const t = axisA.tOf(u);
        // 스테이션 인덱스 영역의 요를 시간 영역 잔차로 옮긴다(u=1 에서 다시 u=0 값이 되도록).
        rawYaw[i] = closedScalarAt(yawResidual, t) + yawWinding * (t - u);
        rawPitch[i] = closedScalarAt(pitches, t);
      }
      const hw = Math.max(1, Math.round((DIR_SMOOTH_SEC / durA) * DIR_GRID));
      for (let i = 0; i < DIR_GRID; i++) {
        let sy = 0, sp = 0, sw = 0;
        for (let j = -hw; j <= hw; j++) {
          const k = ((i + j) % DIR_GRID + DIR_GRID) % DIR_GRID;
          const w = 0.5 * (1 + Math.cos((Math.PI * j) / (hw + 1)));
          sy += rawYaw[k] * w; sp += rawPitch[k] * w; sw += w;
        }
        yawGrid[i] = sy / sw;
        pitchGrid[i] = sp / sw;
      }
    }
    // 격자 사이는 닫힌 Catmull-Rom(C¹)로 읽는다 — 선형 보간은 셀마다 각속도 계단을 만든다.
    const dirAt = (t) => {
      const u = axisA.tauOf(t);
      const yaw = closedScalarAt(yawGrid, u) + yawWinding * u;
      const pitch = closedScalarAt(pitchGrid, u);
      return dirFromPitch(yaw, pitch);
    };
    const distAt = (t) => Math.max(AIM_MIN, closedScalarAt(dists, t));

    return { dirAt, distAt };
  };
  let look = buildLook((t) => gridAt(floorLift, axisA.tauOf(t)));
  const dirAt = (t) => look.dirAt(t);
  const distAt = (t) => look.distAt(t);

  // 수관 리프트는 시선을 알아야 풀리고, 시선은 리프트를 알아야 확정된다 — 해결→리프트→재해결을
  //   한 번 더 돌려 마지막 시선에서도 시선이 잎을 지나지 않게 한다(실측 solo -5.7m).
  // applied: 이미 적용된 수관 리프트(격자). **이것을 반드시 반영해야** 반복이 수렴한다 — 종전은
  //   매 패스 리프트 이전 고도에서 다시 풀어서, 시선이 눕는 만큼 요구량이 계속 커지기만 하고
  //   적용분이 요구를 갚았다는 사실을 영영 보지 못했다(실측 한양 -7.17m 잔존, 반복해도 그대로).
  //   반환값은 **추가** 요구량이고, 광선 방향이 고정된 한 카메라를 δ 올리면 광선도 정확히 δ 오르므로
  //   그 차분이 곧 남은 부족분이다.
  const solveCanopy = (dirOf, distOf, applied) => {
    const raw = new Float64Array(LIFT_GRID);
    if (canopies.length) {
      // 요구량은 **단조**여야 한다: 시선을 수관 **위로** 넘기는 해만 쓴다. "여유가 확보되는 최소 고도"를
      //   스캔으로 찾으면 시선이 수관 아래로 지나가는 해가 뽑힐 수 있고, 그 해집합은 y 에 대해 위로
      //   닫혀 있지 않아서 리프트를 확산시킨 중간 고도가 다시 잎을 지난다(실측 -1.31m).
      //   광선 방향은 고정이므로 카메라를 올리면 수관 수평 최근접점에서의 광선 높이도 같은 만큼 오른다.
      for (let i = 0; i < LIFT_GRID; i++) {
        const t = liftT[i];
        const p = basePos[i];
        const y0 = p.y + floorLift[i] + (applied ? applied[i] : 0);
        const d = dirOf(t), dist = distOf(t);
        const hLen = Math.hypot(d.x, d.z) || 1e-6;
        const aim = { x: p.x + d.x * dist, y: y0 + d.y * dist, z: p.z + d.z * dist };
        let need = 0;
        for (const c of canopies) {
          // 판정은 실제 선분(카메라→조준점) 여유로 한다 — 품질 계약 T6 이 재는 것과 같은 양이다.
          if (segmentCanopyGap({ x: p.x, y: y0, z: p.z }, aim, c) >= CANOPY_MARGIN) continue;
          // 광선의 수평 최근접 파라미터(호길이)와 그 지점의 수평 이격.
          const sHit = ((c.x - p.x) * d.x + (c.z - p.z) * d.z) / (hLen * hLen);
          // 카메라와 **조준점 사이**만 본다. 1.5배로 늘려 두면 조준점 훨씬 뒤(광선이 이미 지하로 내려간
          //   구간)의 나무가 잡혀 카메라를 47m 들어올린다(실측 capital 진입 정점 -38°→-51°). 조준점보다
          //   먼 수관은 건물처럼 원경 가림이며 이 계약의 대상이 아니다.
          // 필요량은 "수관 위로 넘기기"로 계산한다(단조). 최근접 파라미터는 선분 안으로 클램프한다.
          if (sHit <= 0) continue;
          const sc = Math.min(sHit, dist);
          const rayY = y0 + d.y * sc;
          need = Math.max(need, (c.top + CANOPY_CLEAR) - rayY);
        }
        // 상한은 **누적값**에 건다(아래 반복 블록) — 여기서는 이번 패스의 추가 요구량만 낸다.
        raw[i] = Math.max(0, need);
      }
    }
    return raw;
  };
  const liftGrid = new Float64Array(LIFT_GRID);
  for (let i = 0; i < LIFT_GRID; i++) liftGrid[i] = floorLift[i];
  // 격자는 τ_A 균일이므로 리프트도 τ_A 로 읽는다.
  const liftAt = (t) => gridAt(liftGrid, axisA.tauOf(t));
  // ── 수관 회피 반복 ── 요구량 → 확산 적용 → 그 고도에서 프레이밍 시선 재해결 → 남은 부족분.
  //   프레이밍 시선을 가진 스테이션에서는 카메라를 올리면 조준이 그만큼 더 눕어 광선이 수관 쪽에서
  //   다시 내려가므로, 적용분을 되먹이지 않으면 영원히 수렴하지 않는다(위 solveCanopy 주석).
  const canopyRaw = new Float64Array(LIFT_GRID);
  const canopyApplied = new Float64Array(LIFT_GRID);
  // 상한 — 어떤 경우에도 수관 회피가 투어 고도 체계를 뒤집지 않는다.
  const canopyCap = Math.max(20, Hmax * 0.35);
  for (let pass = 0; pass < 6; pass++) {
    const need = solveCanopy((t) => look.dirAt(t), (t) => look.distAt(t), canopyApplied);
    let grew = false;
    for (let i = 0; i < LIFT_GRID; i++) {
      if (need[i] <= 1e-3) continue;
      const next = Math.min(canopyCap, canopyRaw[i] + need[i]);
      if (next > canopyRaw[i] + 1e-4) { canopyRaw[i] = next; grew = true; }
    }
    if (!grew) break;
    const spread = spreadPeriodic(canopyRaw, rampCells);
    for (let i = 0; i < LIFT_GRID; i++) {
      canopyApplied[i] = spread[i];
      liftGrid[i] = floorLift[i] + spread[i];
    }
    look = buildLook(liftAt);
  }

  // 리프트까지 반영한 경로(하드 안전망 제외) — 시간축 B 의 기준. 안전망은 (x,z) 의 계단함수이므로
  //   어떤 격자로도 완전히 연속화되지 않는다. 그것을 시간축에 넣으면 그 셀에서 카메라가 정지했다가
  //   수직으로 튀는 병리(실측 549m/s)가 되므로, 시간축은 계단 없는 이 경로로 만들고 안전망은
  //   샘플 시점에만 마지막 방어로 둔다(잔차는 아래 T2·T4 계약이 감시한다).
  const posLifted = (t) => {
    const p = posCurve.getPoint((((t % 1) + 1) % 1));
    p.y += liftAt(t);
    return p;
  };
  // 평활 보정은 시간축 B 가 만들어진 뒤에야 정의되므로(τ 가 필요하다) 훅으로 두고 아래에서 채운다.
  //   시간축·롤 격자는 보정 **이전**의 posLifted 로 만든다: 보정량이 밀리미터~센티미터라 호길이·곡률
  //   통계에 무의미하고, 서로를 물고 도는 정의를 만들지 않는 편이 낫다.
  let posSmoothHook = null;
  const posAtT = (t) => {
    const p = posLifted(t);
    if (posSmoothHook) posSmoothHook(t, p);
    const fl = safeFloor(p.x, p.z);
    if (p.y < fl) p.y = fl;
    return p;
  };

  // ── 시간축 B(최종) ──
  const axis = buildTimeAxis(TOUR_GRID, posLifted);
  const arcLength = axis.arcLength;
  const tourDuration = Math.min(TOUR_SEC_MAX, Math.max(TOUR_SEC_MIN, arcLength / speed));

  // ── 프레임 스케일 위치 평활(2026-08-01 B-0, 화면 떨림 결함) ──
  // 사용자 판정: "드론뷰에 화면이 자꾸 막 떨린다". 순수 노드 실측으로 원인을 좁힌 결과:
  //   · 하드 안전망 경합(리드 유력 가설)은 **실재하나 드물다** — 종전 소스에서 투어당 0~20 프레임
  //     (0.02~0.15%)만 개입했고, LIFT_MARGIN 도입 뒤 전 규모 0 프레임이 됐다.
  //   · 시선은 원래 깨끗하다(고주파 잔차 p99 0.002° ≈ 1/20 픽셀).
  //   · 남은 것은 **위치의 국소 첨점**이다: 투어당 4~15회, 프레임 스케일 변위 최대 0.13~0.53°
  //     (1600x900·fov40 에서 3~12 픽셀). 20초에 한 번꼴로 화면이 한 프레임 튄다.
  // 원인은 스플라인의 미분 차수다. 이 경로는 설계상 **C¹**(위치·속도 연속)이고 C² 가 아니라서,
  //   인접 제어점 간격이 크게 다른 knot 에서 곡률이 계단으로 뛴다(capital 실측 117m 세그먼트 옆
  //   6.8m 세그먼트 — 17배). 곡률 계단은 곧 가속 계단이고, 한 프레임짜리 변위 첨점으로 나타난다.
  // 처방은 제어점 재배치가 아니라 **τ 영역의 좁은 저역통과**다: 첨점(1~3 프레임 = 0.02~0.05s)만
  //   지우고 안무(0.5s 이상)는 손대지 않는 폭을 쓴다. 격자는 리프트·롤과 같은 방식(주기 Hann)이라
  //   이음매에서 연속이고, 보정은 **원 경로와의 차분**으로 저장해 안전망보다 앞에 더한다 —
  //   따라서 지형·지붕 클리어런스는 posAtT 의 하드 안전망과 T4·T5 계약이 그대로 지킨다.
  // 2026-08-02 (#42 R3): 0.16 → 0.40. R3 의 여정 기하(등반 3차 베지에·합성 축 재해·경유지 길이비
  //   조임)를 다 적용한 뒤에도 **계곡 활강 → 지붕 글라이드 이음**에 잔차 최대점이 남았다(실측
  //   capital 0.359° · hanyang 0.240°, 계약 T21 상한 0.22). 그 자리는 한두 프레임 첨점이 아니라
  //   0.1s 폭의 실제 곡률 계단이라(전 규모의 잔차 최대점이 같은 이음에 몰린다) ±2프레임 폭의 창으로는
  //   지워지지 않는다 — 창을 그 사건의 폭 위로 올리는 것이 맞는 처방이다.
  //   실측 잔차 max(전 규모): 0.16 → 0.056~0.359 · 0.28 → 0.039~0.245 · 0.40 → 0.029~0.199 ·
  //   0.48 → 0.025~0.181. 0.40 에서 전 픽스처가 상한 안에 들어오고 최악에 약 10% 여유가 남는다.
  //   안무 보존 조건(0.5s 이상은 손대지 않는다)은 그대로다: 창 **전폭**이 0.40s 이므로 반폭은 0.2s 다.
  //   보정은 여전히 원 경로와의 차분이고 하드 안전망보다 앞에 더해지므로, 지형·지붕·수관 클리어런스는
  //   T4·T5·T6 가 그대로 지킨다(실측 지형 min 2.45m · 직하지붕 2.20m · 수관 2.72m — 전부 불변).
  const POS_SMOOTH_SEC = 0.40;
  const POS_SMOOTH_GRID = 32768;
  const smoothDX = new Float64Array(POS_SMOOTH_GRID);
  const smoothDY = new Float64Array(POS_SMOOTH_GRID);
  const smoothDZ = new Float64Array(POS_SMOOTH_GRID);
  {
    const rx = new Float64Array(POS_SMOOTH_GRID);
    const ry = new Float64Array(POS_SMOOTH_GRID);
    const rz = new Float64Array(POS_SMOOTH_GRID);
    for (let j = 0; j < POS_SMOOTH_GRID; j++) {
      const p = posLifted(axis.tOf(j / POS_SMOOTH_GRID));
      rx[j] = p.x; ry[j] = p.y; rz[j] = p.z;
    }
    const hw = Math.max(1, Math.round((POS_SMOOTH_SEC / tourDuration) * POS_SMOOTH_GRID));
    for (let j = 0; j < POS_SMOOTH_GRID; j++) {
      let sx = 0, sy = 0, sz = 0, sw = 0;
      for (let d = -hw; d <= hw; d++) {
        const k = ((j + d) % POS_SMOOTH_GRID + POS_SMOOTH_GRID) % POS_SMOOTH_GRID;
        const w = 0.5 * (1 + Math.cos((Math.PI * d) / (hw + 1)));
        sx += rx[k] * w; sy += ry[k] * w; sz += rz[k] * w; sw += w;
      }
      smoothDX[j] = sx / sw - rx[j];
      smoothDY[j] = sy / sw - ry[j];
      smoothDZ[j] = sz / sw - rz[j];
    }
  }
  posSmoothHook = (t, p) => {
    const u = axis.tauOf(t);
    p.x += closedScalarAt(smoothDX, u);
    p.y += closedScalarAt(smoothDY, u);
    p.z += closedScalarAt(smoothDZ, u);
  };

  // ── 뱅킹(롤) 유도 ── 최종 시간축 위에서 **속도벡터**의 수평 회전율 ω 와 대지속도 v 를 재고 조화
  //   선회식 φ = atan(GAIN·v·ω/g) 로 롤을 만든다. 저작 상수가 아니므로 직선에서는 정확히 0 이고,
  //   같은 곡률이라도 빠르게 지나면 더 눕는다(속도 서사와 자동으로 정합한다).
  // 부호 규약: az = atan2(dx,dz) 가 증가하는 방향이 화면 **왼쪽**으로의 선회이고(카메라 x축 =
  //   (-cos az, 0, sin az)), camera.rotateZ(+θ) 는 up 을 -x(왼쪽)으로 눕힌다. 조화 선회는 up 이
  //   선회 안쪽으로 눕는 것이므로 두 부호가 그대로 일치한다 — 소비면은 rotateZ(roll) 한 줄이면 된다.
  const rollAuths = stations.map((s) => s.rollAuth);
  const rollGrid = new Float64Array(ROLL_GRID);
  {
    const dtCell = tourDuration / ROLL_GRID;
    const P = new Array(ROLL_GRID);
    for (let j = 0; j < ROLL_GRID; j++) P[j] = posLifted(axis.tOf(j / ROLL_GRID));
    const head = new Float64Array(ROLL_GRID);
    const spd = new Float64Array(ROLL_GRID);
    for (let j = 0; j < ROLL_GRID; j++) {
      const a = P[j], b = P[(j + 1) % ROLL_GRID];
      head[j] = Math.atan2(b.x - a.x, b.z - a.z);
      spd[j] = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / dtCell;
    }
    for (let j = 0; j < ROLL_GRID; j++) {
      const k = (j + 1) % ROLL_GRID;
      const omega = shortest(head[k] - head[j]) / dtCell;
      const v = 0.5 * (spd[j] + spd[k]);
      const auth = Math.max(0, closedScalarAt(rollAuths, axis.tOf(j / ROLL_GRID)));
      // 상한은 **평활 이전**에 건다. 뒤에 걸면 (스침 기하에서 수백 도까지 나오는) 원 첨점이 평활을
      //   거치며 상한보다 훨씬 높고 넓은 봉우리로 남고, 그 봉우리를 상한에서 자르면 상승 에지의
      //   기울기가 그대로 살아 롤 각속도가 폭발한다(실측 저공 120°/s).
      rollGrid[j] = Math.max(-ROLL_MAX, Math.min(ROLL_MAX,
        auth * Math.atan((ROLL_GAIN * v * omega) / ROLL_G)));
    }
    // 주기 Hann 평활 — 곡률 잡음(격자 셀 0.05~0.11s)이 롤 떨림으로 새지 않게. 창이 주기적이라
    //   루프 이음매에서도 롤이 연속이다(T1 이 이음매를 별도로 단언한다).
    {
      const hw = Math.max(1, Math.round((ROLL_SMOOTH_SEC / tourDuration) * ROLL_GRID));
      const src = rollGrid.slice();
      for (let j = 0; j < ROLL_GRID; j++) {
        let s = 0, sw = 0;
        for (let d = -hw; d <= hw; d++) {
          const k = ((j + d) % ROLL_GRID + ROLL_GRID) % ROLL_GRID;
          const w = 0.5 * (1 + Math.cos((Math.PI * d) / (hw + 1)));
          s += src[k] * w; sw += w;
        }
        rollGrid[j] = s / sw;
      }
    }
    // 원뿔(슬루) 제한 — 어떤 셀도 이웃과 cap 이상 차이날 수 없다. 상·하 원뿔을 번갈아 조여 수렴시킨다.
    //   두 연산 모두 |값| 을 키우지 않으므로 롤이 없던 자리에 롤이 생기지 않는다.
    {
      const cap = ROLL_RATE_MAX * dtCell;
      for (let round = 0; round < 4; round++) {
        for (let j = 0; j < ROLL_GRID; j++) {
          const p = (j - 1 + ROLL_GRID) % ROLL_GRID;
          if (rollGrid[j] > rollGrid[p] + cap) rollGrid[j] = rollGrid[p] + cap;
        }
        for (let j = ROLL_GRID - 1; j >= 0; j--) {
          const q = (j + 1) % ROLL_GRID;
          if (rollGrid[j] > rollGrid[q] + cap) rollGrid[j] = rollGrid[q] + cap;
        }
        for (let j = 0; j < ROLL_GRID; j++) {
          const p = (j - 1 + ROLL_GRID) % ROLL_GRID;
          if (rollGrid[j] < rollGrid[p] - cap) rollGrid[j] = rollGrid[p] - cap;
        }
        for (let j = ROLL_GRID - 1; j >= 0; j--) {
          const q = (j + 1) % ROLL_GRID;
          if (rollGrid[j] < rollGrid[q] - cap) rollGrid[j] = rollGrid[q] - cap;
        }
      }
    }
  }

  const sampleTour = (u) => {
    const t = axis.tOf(u);
    const pos = posAtT(t);
    const d = dirAt(t), dist = distAt(t);
    return {
      pos,
      lookAt: V(pos.x + d.x * dist, pos.y + d.y * dist, pos.z + d.z * dist),
      fov: closedScalarAt(fovs, t),
      // 라디안. 소비면은 lookAt 뒤 camera.rotateZ(roll) 한 줄로 적용한다(위 부호 규약 주석).
      roll: closedScalarAt(rollGrid, clamp01(u)),
    };
  };

  // ── 구간(leg) = 투어 곡선 위 시간 창 ──
  const LEGS = [
    { name: 'far-approach', kind: 'approach' },
    { name: 'valley-run', kind: 'descent' },
    { name: 'rooftop-glide', kind: 'glide' },
    { name: 'landmark-flyby', kind: 'flyby' },
    { name: 'ridge-climb', kind: 'climb' },
    { name: 'return-arc', kind: 'return' },
  ];
  const bounds = LEGS.map((_, k) => axis.tauOf(stations.findIndex((s) => s.leg === k) / N));
  const info = {
    stations: N,
    // 진단용 제어점 덤프(순수 JSON) — 게이트·프로브가 저작 의도와 샘플을 대조할 수 있다.
    controlPoints: stations.map((s, i) => ({
      i, leg: s.leg, w: +s.w.toFixed(3), fov: +s.fov.toFixed(1),
      x: +s.pos.x.toFixed(2), y: +s.pos.y.toFixed(2), z: +s.pos.z.toFixed(2),
      dy: +(-Math.sin(s.pitch)).toFixed(3), pitchDeg: +(s.pitch / DEG).toFixed(1),
      azDeg: +(s.az / DEG).toFixed(1), dist: +s.dist.toFixed(1),
      pull: +(s.pull || 0).toFixed(3),
    })),
    arcLength: +arcLength.toFixed(2),
    duration: +tourDuration.toFixed(2),
    meanSpeed: +(arcLength / tourDuration).toFixed(2),
    primary: {
      kind: primary.kind, x: +primary.x.toFixed(2), z: +primary.z.toFixed(2),
      h: primary.h, baseY: +primary.baseY.toFixed(2),
      footW: +primary.footW.toFixed(1), footD: +primary.footD.toFixed(1),
    },
    secondary: { kind: secondary.kind, x: +secondary.x.toFixed(2), z: +secondary.z.toFixed(2) },
    // 여정 진단 — 게이트·평면도 플롯이 "무엇을 지나 어디로 가는가"를 이 값으로 재구성한다.
    journey: {
      approachAzDeg: +(approachAz / DEG).toFixed(1),
      runAzDeg: +(runAz / DEG).toFixed(1),
      sunAzDeg: sunKnown ? +(sunAzimuth / DEG).toFixed(1) : null,
      turnSign,
      fabricEdge: +fabricEdgeS.toFixed(1),
      crest: { x: +crest.x.toFixed(2), z: +crest.z.toFixed(2), h: +crest.h.toFixed(2), azDeg: +(crest.az / DEG).toFixed(1) },
      returnSweepDeg: +(returnSweep / DEG).toFixed(1),
      approachY: +approachY.toFixed(2),
    },
    // 플라이바이 — "도는 것이 아니라 지나간다"의 저작값. 게이트가 성장률·이격을 이 값과 대조한다.
    flyby: {
      standoff: +flybyStandoff.toFixed(2),
      fov: flybyFov,
      widthFrac: +flybyFrame.widthFrac.toFixed(3),
      eyeY: +flybyY0.toFixed(2),
      maxPull: FLYBY_PULL,
      target: { x: +flybyTarget.x.toFixed(2), y: +flybyTarget.y.toFixed(2), z: +flybyTarget.z.toFixed(2) },
      // 직물 envelope 와 통과선 클램프(진단) — 게이트·프로브가 이탈 여부를 이 값으로 재구성한다.
      fabricR: +fabricR.toFixed(1),
      fabricKeepR: +fabricKeepR.toFixed(1),
      ...flybyGeom,
    },
    glide: {
      len: +polyLen(glideAxis).toFixed(1),
      // **실제로 쓴 축**을 보고한다. 종전은 glidePick(후보 채점의 승자)의 등급을 그대로 찍어, 폴백이
      //   합성 축을 골랐을 때도 'soro'·'jungno' 로 보고했다 — R2 진단이 도성·한양의 결함을 "도성 밖
      //   소로 선택"으로 오독한 원인이다(#42 R3 C항).
      road: glideSynthetic ? 'synthetic' : (glidePick.level || 'road'),
      roofFrac: +axisRoofFrac(glideAxis).toFixed(2),
      inFabric: +axisInFabric(glideAxis).toFixed(2),
    },
    legs: LEGS.map((l, k) => ({
      name: l.name,
      t0: +bounds[k].toFixed(6),
      t1: +(k + 1 < LEGS.length ? bounds[k + 1] : 1).toFixed(6),
    })),
  };
  return LEGS.map((leg, k) => {
    const t0 = bounds[k];
    const t1 = k + 1 < LEGS.length ? bounds[k + 1] : 1;
    return {
      name: leg.name,
      kind: leg.kind,
      duration: Math.max(1, tourDuration * (t1 - t0)),
      // 구간 경계에서 위치·속도·시선이 이어진다: leg k 의 t01=1 과 leg k+1 의 t01=0 이 같은 τ 다.
      sample(t01) { return sampleTour(t0 + (t1 - t0) * clamp01(t01)); },
      t0,
      t1,
      tourDuration,
      sampleTour,
      tour: info,
    };
  });
}
