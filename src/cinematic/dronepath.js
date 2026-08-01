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
const CANOPY_CLEAR = 2.5;           // 수관 상단 위 기본 여유
const CANOPY_MARGIN = 1.0;          // 정확 해에 얹는 여유(그리드 보간 오차 흡수)
const CANOPY_SCAN = 48;             // 정확 해 선형 스캔 단계

// ── 오빗 ──
const ORBIT_ARC_MIN = 215 * DEG;
const ORBIT_ARC_SPAN = 55 * DEG;    // 시드 변주 폭
const ORBIT_BACKLIT_AT = 0.45;      // 완전 역광각이 오는 오빗 진행률
const ORBIT_ENTRY_ARC = 46 * DEG;   // 접선 진입점 위상 여유
const ORBIT_EXIT_ARC = 26 * DEG;
// 제어점 간격. 시선을 방향장으로 저작하므로 오빗 중 랜드마크 추적 오차 ≈ step²/8 이다 —
//   13° 면 0.4° 로 프레임 안에서 흔들림이 보이지 않는다(26° 는 1.5° = 30° 화각의 5%).
const ORBIT_STEP = 13 * DEG;
// 상승 리빌 최소 방위 이동 — 결말이 방사 직선(짧은 꼬리)이 되지 않게.
// 2026-08-01: 100° 로 늘렸다. 상승 리빌은 "골목 진행 방향 → 마을을 돌아보는 방향" 으로 요를 180°
//   가까이 돌려야 하는데, 짧은 방사 상승에 그 회전을 담으면 40~115°/s 가 된다(실측). 호를 늘려
//   회전에 거리를 준다.
const CLIMB_MIN_SWEEP = 100 * DEG;

// ── 속도 서사(2026-08-01 5차 재설계) ──
// 종전 가중치는 **드론 영상 문법의 정확한 역상**이었다(실측 village 구간 중앙값: 진입 13.9 · 선회 8.97 ·
//   저공 7.8 · 리빌 11.8 m/s). 즉 고도 36m 의 부감이 가장 빠르고 고도 10m 의 저공 패스가 가장 느렸다.
//   지각 속도는 대지속도가 아니라 **시차**(v / 근접물 거리)이므로, 이 배치는 두 구간을 동시에 죽인다:
//   부감은 빠를 이유가 없고(원경은 아무리 빨라도 느리게 읽힌다), 저공은 유일한 속도감의 자리인데 느리다.
//   그래서 지속 속도비가 14/7.8 ≈ 1.8 밖에 되지 않았고 전체가 "등속 유람선"으로 읽혔다(사용자 판정).
// 새 배치는 실제 드론 편집의 에너지 곡선이다(닫힌 루프이므로 주기적이어야 한다):
//   느린 리빌 시작(0.44) → 상승하며 가속(1.46) → 이음매 정점 통과(1.20) → 활강 감속(0.72) →
//   느린 선회(0.62) → 접선 이탈 가속(1.05) → 저공 스윕(1.50, 최고) → 뱅크(1.28) → 골목(1.45) → 다시 리빌.
//   저작 속도비 1.50/0.44 = **3.4배**, 구간 중앙값 기준으로도 3배 이상이 나온다(보고서 표 참조).
// 왜 정점(crane)만 여전히 빠른가: 진입 정점은 프레임 피치 -38°(도성 부감)이고 그 자세의 **시간 점유**가
//   커지면 진입 구간 전체가 평면도로 읽힌다(품질 계약 T13 이 median 16~26° 로 그것을 막는다). 정점은
//   활강으로 통과하는 것이 원 설계이자 드론 문법(다이빙 접근)이므로 그대로 두고, 대신 링 진입에서
//   0.72 까지 감속시켜 선회로 "내려앉는" 감속을 만든다.
const CRANE_W0 = 1.25;              // 이음매(정점) 통과
const CRANE_W1 = 0.82;              // 나선 하강 끝
const W_ENTRY_FAR = 0.74;
const W_ENTRY_NEAR = 0.60;          // 링 접선 진입 — 선회로 내려앉는 감속
const W_ORBIT = 0.80;               // 선회는 느리다(각속도로 읽히는 구간이라 대지속도는 낮아도 된다)
// 접선 이탈 → 스윕 진입은 **이동(transit)** 이지 구경이 아니다. 링에서 가로까지 사이트를 가로지르는
//   이 구간은 capital 에서 400m·고도 83m 를 소비하는데, 여기 표본이 늘면 저공 구간 전체의 프레임 내용
//   지표가 통째로 무너진다(실측 T15 무특징 지면 41% · T16 전경 밀착 45% · 하단 중앙 8% — 전부 전이
//   표본이 만든 값이다. 저공 스팬 본체는 종전과 같은 코스다). 종전 소스는 이 구간이 저공 본체보다
//   2배 빨라 표본이 적었고, 5차에서 본체를 빠르게 만들면서 그 비가 뒤집혔다. 전이는 본체보다 다시
//   빠르게 둔다 — 드론 문법으로도 "가로를 향해 내리꽂는 이동"이 맞다.
const W_ORBIT_EXIT = 1.35;          // 접선 이탈 = 가속의 시작
const W_SWEEP_ENTRY = 1.35;
const W_SWEEP = 0.92;               // 지붕 바다 저공 스윕 — 투어 최고 속도
const W_BANK = 1.30;                // 뱅크 선회는 살짝 속도를 흘린다(롤이 그 자리에서 최대가 된다)
const W_LANE = 0.88;                // 골목 저공 — 담이 가장 가까운 구간
// 상승 리빌의 속도 프로파일은 CLIMB 표가 소유한다(리빌 전반이 투어에서 가장 느리다).

// ── 뱅킹(롤) ── 2026-08-01 5차 재설계. 종전 투어는 롤이 항상 0 이라 방향 전환이 "레일 위를 도는
//   카메라"로 읽혔다(사용자 판정). 롤은 **저작 상수가 아니라 궤적에서 유도**한다: 조화 선회(coordinated
//   turn)의 물리 관계 tan φ = v·ω / g 를 그대로 쓴다(v = 대지속도, ω = **속도벡터**의 수평 회전율).
//   그래서 직선 구간은 자동으로 0 이고, 곡률이 큰 저공 뱅크에서만 기울며, 속도를 올리면 같은 곡률에서
//   더 눕는다 — 가짜 상수 롤과 달리 궤적·속도와 항상 정합한다.
// ROLL_GAIN 은 의도된 촬영술적 과장이다(실기체 배율 1.0). FPV 계열 편집이 뱅크를 과장해 보여 주는 것과
//   같은 이유로 1.0 은 화면에서 거의 읽히지 않는다(선회 5.5° · 저공 뱅크 25°). 과장은 v·ω 비례를 깨지
//   않도록 **atan 안쪽**에 넣는다: 작은 각에서는 선형 배율, 큰 각에서는 자연 포화.
const ROLL_GAIN = 1.0;
const ROLL_G = 9.81;
const ROLL_MAX = 24 * DEG;
// 롤 시정수 — 실기체 짐벌·자세 루프가 이 정도로 눕는다. 이보다 짧으면 곡률 잡음이 롤 떨림으로 새고,
//   길면 뱅크가 선회보다 늦게 도착해 어색하다. 주기 Hann 창이라 이음매에서도 연속이다(T1).
const ROLL_SMOOTH_SEC = 1.0;
const ROLL_GRID = 2048;
// 롤 권한(구간별) — 같은 물리식에 곱하는 연출 계수다. 선회는 랜드마크를 짐벌로 고정한 샷이라 기체가
//   기울어도 화면 수평이 거의 유지되는 것이 실제 촬영이고(3축 짐벌), 저공 패스는 반대로 뱅크가 속도감의
//   본체다. 부감 나선도 실제로는 계속 뱅크 상태이지만 그것을 그대로 보이면 와이드 establishing 이
//   더치 앵글이 된다(실측 gain 1.7·권한 0.8 에서 진입 구간 롤 중앙값 11.5°). 인덱스 = leg 태그.
const ROLL_AUTHORITY = [0.45, 0.38, 1.0, 0.45];
// 뱅크 선회 두 점만 권한을 올린다 — 저공에서 방향을 바꾸는 이 두 점이 투어에서 뱅크가 가장 크게 읽혀야
//   하는 자리이고(속도도 여기서 높다), 곡률만으로는 스윕 직선 구간과 구분되지 않는다.
const ROLL_BANK_AUTHORITY = 1.15;
// 롤 각속도 상한(°/s). 화면 수평선이 이보다 빨리 돌면 뱅크가 아니라 흔들림으로 읽힌다(실기체는 훨씬
//   빠르지만 그건 조종이지 촬영이 아니다). 실기 감각: 20° 뱅크에 1.5초 ≈ 13°/s.
// **구현은 확산이 아니라 원뿔(슬루) 제한이다.** 확산형(총합 보존) 리미터를 먼저 써 봤다가 기각했다:
//   좁고 높은 첨점을 깎는 대신 넓은 고원으로 퍼뜨려 7 픽스처 전 구간의 롤 max 가 상한에 붙었고,
//   그래도 실측 롤 각속도는 저공에서 120°/s 로 남았다(첨점의 상승 에지는 그대로였기 때문). 원뿔 제한은
//   값을 **줄이기만** 하므로 첨점이 낮아지면서 에지 기울기도 함께 내려간다.
const ROLL_RATE_MAX = 14 * DEG;

// ── 미세 접힘 가드(2026-08-01) ── 사용처 주석에 근거. 반전 문턱은 저작된 큰 전환(142~143°)보다 낮게 두되
//   길이 조건(max(8, R*0.06))이 그것을 걸러 내므로 안전하다.
const FOLD_TURN = 118 * DEG;
const FOLD_PULL = 0.7;
const FOLD_PASSES = 4;

// ── 프레임 기하(2026-08-01 비전 FIX) ──
// 부감 계열의 시선은 "어떤 점을 본다"가 아니라 **피사체를 화면 어디에 놓는가**로 저작한다.
//   깊이 δ(피사체 하강각)에 있는 대상은 NDC y = -tan(δ - p)/tan(fv/2) 에 맺힌다. 그래서
//     p = δ + atan(yTarget·tan(fv/2))  … 피사체를 yTarget 에 놓는 프레임 피치
//     δ = p - atan(yTarget·tan(fv/2))  … 그 피치를 만드는 고도/거리 비
//   위치는 (고도, 저작된 피치) → 거리로 파생한다. 거리를 고정하고 피치를 저작하면 피사체가 프레임
//   밖으로 나가고(정점 -38° 에서 NDC +1.3), 고도를 파생시키면 한양에서 428m 까지 뜬다.
const AERIAL_Y_TARGET = -0.08;      // 피사체 중심의 화면 세로 위치(NDC, 음수 = 중앙보다 아래)
// ── 시선 리드룸(2026-08-01 5차) ──
// 선회에서 랜드마크를 프레임 **정중앙**에 못박으면 회전대에 올려놓은 모형처럼 읽힌다(사용자 판정의
//   "레일 카메라" 인상에 요를 고정한 이 정중앙 조준도 기여한다). 실제 촬영은 피사체를 진행 방향의
//   반대쪽으로 살짝 밀어 **앞쪽에 여백(리드룸)**을 남긴다 — 카메라가 어디로 가고 있는지가 프레임에
//   들어온다. 값은 화면 가로 NDC 이고, 부호는 선회 방향에서 파생한다(저작 상수가 아니다).
// 0.16 인 이유: 선회 가로 점유 목표가 0.36 이므로 피사체는 중심 ±0.18 을 차지한다. 0.16 을 밀면
//   피사체는 [-0.34, +0.02] 에 앉아 반대편에 34% 의 여백이 생기면서도 프레임 안에 온전히 남는다
//   (품질 계약 T9 랜드마크 수평 화각 포함·T14 가로 점유는 그대로 성립한다 — 둘 다 실측으로 확인).
const AERIAL_X_LEAD = 0.16;
const CRANE_PITCH_TOP = 38 * DEG;   // 진입 정점(도성 위 부감) — 비전 지정
const CRANE_WIDE_AT = 0.42;         // 이 진행률까지 정점 피치가 와이드 대역으로 눕는다
const ORBIT_PITCH = 18 * DEG;       // 선회 — 피사체가 "얇은 수평 띠"로 읽히지 않는 대역
const ORBIT_FOV = 34;               // 비전 지정(종전 30 → 랜드마크가 프레임을 덜 채웠다)
// ── 선회 상승·렌즈 크리프(2026-08-01 3차 비전 C항) ──
// 종전 선회는 패스 전체에서 Δ고도 0.03~0.38m · Δfov 0 이라 **요만 돌아가는 회전대**로 읽혔다(비전 실측).
//   완만한 상승과 렌즈 크리프를 얹어 드론이 살아 있게 만든다.
// 반경은 상승분을 **프레임 피치가 유지되는 양**만큼 따라간다(Δr = Δy/tan δ). 그래야 (a) 저작된 프레임
//   피치가 표류하지 않고 (b) 피사체 근단 하강각이 오히려 δ 로 수렴해 프레임 하단 여백이 좁아지지 않는다
//   (보상 없이 상승만 하면 한양 하단 여백 6.3%→3.3% 로 T14 를 깬다 — 실측).
// 다만 그 양이 반경 대비 크면(소규모: 마을 +41%) 피사체가 작아진다. 그래서 **렌즈 크리프가 되돌릴 수 있는
//   만큼**으로 상한을 둔다: (1+grow) = tanHalf(fov)/tanHalf(fov·(1-creep)). 이 상한에서 피사체 겉보기 폭은
//   패스 내내 출발값 이상이므로 T14 가로 점유 하한이 구조적으로 안전하다(완화가 아니라 파생이다).
const ORBIT_CLIMB_M = 10;           // 비전 지정 8~12m
const ORBIT_LENS_CREEP = 0.176;     // 비전 지정 34°→28° 와 같은 비율(해석된 화각에 상대 적용)
// 선회 고도 하한 — 링 위 국소 민가 지붕 평균에서 이만큼은 띄운다. 낮고 가까운 위상 구간에서
//   프레임 하단 30% 가 지붕 덩어리가 되던 결함(landmark-orbit-village)의 수치 계약.
const ORBIT_ROOF_HEADROOM = 8;
// 주 피사체 프레임 배치 — 하단 여백 하한과 세로 점유 하한(프레임 비율). 선회 반경이 이 조건에서
//   파생된다. 품질 계약 T14 가 같은 수치를 독립적으로 다시 잰다.
const SUBJECT_BOTTOM_MARGIN_MIN = 0.05;
const SUBJECT_HEIGHT_MIN_FRAC = 0.12;
const REVEAL_PITCH = 20 * DEG;      // 와이드 계열 -20°±3 (비전 지정)
// 선회 피사체 유효 질량비 — 필지(plot)에는 곽담·문전 마당이 포함되어 실제로 눈에 읽히는 건축 덩어리는
//   그보다 작다. 적합 조건을 plot 으로 풀면 반경이 과대해져 궁이 화면 폭 1/4 로 작아진다(2차 비전).
const ORBIT_SUBJECT_MASS = 0.72;
// 주 피사체가 프레임 폭에서 차지할 목표 비율(품질 계약 T14 하한 0.30 위로 여유). 이 값에 닿을 때까지
//   렌즈를 좁힌다(반경은 하단 여백 적합 조건이 잠그고 있어 더 줄일 수 없다).
const ORBIT_WIDTH_TARGET = 0.36;
// 와이드 프레임에서 능선(=안개 지평선)이 놓일 화면 세로 위치(NDC). 0.84 → 상단 8% 가 하늘·헤이즈.
//   능선이 카메라보다 **위**에 오면 프레임 상단을 채워 top-down 지도 인상이 된다(마을 과교정).
//   그래서 와이드 구간 고도에 "능선을 이 위치로 내려보내는" 하한을 건다.
const WIDE_RIDGE_NDC = 0.84;
// 저공 패스 화각 — 42° 는 근경 담·기와 덩어리의 접지선이 하단 밖으로 잘렸다(2차 비전: 마을 8장 중 6장).
//   화각을 넓히면 같은 피치·고도에서 최전경 접지선이 프레임 안으로 들어오고 전경 와이프도 살아난다.
const FLY_FOV = 56;
// 저공 코스가 "필지 띠 안쪽"이어야 한다 — 스팬 표본에서 건물 볼륨이 이 거리 안에 있는 비율(전경 와이프).
const HUG_R = 15;

// ── 축(스윕·골목) 선택 ──
const AXIS_CANDIDATES = 12;         // 프로파일링할 도로 후보 상한(비용 상한, 결정론적 정렬)
const AXIS_MIN_LEN = 44;
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

  const safeFloor = (x, z, clear) => {
    const g = H(x, z) + GROUND_CLEAR;
    const rt = roofTopAt(obstacles, x, z);
    return rt != null ? Math.max(g, rt + (clear != null ? clear : ROOF_CLEAR)) : g;
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
  const pitchForSubject = (dep, fov) => dep + Math.atan(AERIAL_Y_TARGET * tanHalfV(fov));
  // 와이드 프레임 고도 하한 — 주산 능선이 프레임 상단을 채우지 않게 카메라를 능선 위로 올린다.
  //   능선이 NDC 0.84 에 오려면 그 하강각이 (pitch - atan(0.84·tanHalf)) 여야 한다. 마을 규모는
  //   능선(52m)이 카메라(54m)와 거의 같은 높이라 이 하한이 실제로 개입하고, 한양은 이미 능선보다
  //   46m 높아 개입하지 않는다(2차 비전: "한양은 적정, 마을만 과교정").
  const ridgeY = groundC + Hmax;
  const ridgeDist = Math.max(R * 0.9, Math.abs(site.mountainZ || -R) + R * 0.4);
  const wideYFloor = (pitch, fov) => {
    const drop = pitch - Math.atan(WIDE_RIDGE_NDC * tanHalfV(fov));
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
  const aimAtSubject = (pos, subject, fov, lead) => {
    const dx = subject.x - pos.x, dz = subject.z - pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const dep = Math.atan((pos.y - subject.y) / d);
    const yaw = Math.atan2(dx, dz) - (lead ? Math.atan(lead * hHalfTan(fov)) : 0);
    return {
      dir: dirFromPitch(yaw, pitchForSubject(dep, fov)),
      dist: Math.hypot(d, pos.y - subject.y),
    };
  };
  const addAerial = (leg, subject, az, y, pitch, fov, w) => {
    const st = aerialAt(subject, az, y, pitch, fov);
    const look = aimAtSubject(st.pos, subject, fov);
    addDir(leg, st.pos, look.dir, look.dist, fov, w, subject);
    return st;
  };

  // 화각 파생 — 프레임에 무엇이 담기는지는 수평 화각이 정한다.
  const hHalfOf = (fov) => Math.atan(Math.tan(fov * 0.5 * DEG) * FRAME_ASPECT);
  const aheadDist = Math.max(16, R * 0.12);
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
  const syntheticAxis = (az) => {
    const m = fabC;
    const half = Math.max(38, Math.min(R * 0.5, 200));
    return [
      { x: m.x - Math.sin(az) * half, z: m.z - Math.cos(az) * half },
      { x: m.x, z: m.z },
      { x: m.x + Math.sin(az) * half, z: m.z + Math.cos(az) * half },
    ];
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
  // 스윕 축은 오빗 이탈점이 정해진 뒤 고른다(연결성 항이 그 점을 필요로 한다).
  let sweepPick = null;
  const pickSweep = (from) => {
    for (const c of candidates) {
      if (!sweepPick || sweepScore(c, from) > sweepScore(sweepPick, from)) sweepPick = c;
    }
    return sweepPick ? trimAxis(sweepPick) : syntheticAxis(axisAz);
  };
  // 골목 축은 스윕이 확정된 뒤에 고른다 — 프레임 내용·등급만 보면 스윕 종점 **뒤쪽**의 골목이
  //   뽑혀 연결부가 헤어핀이 되고(실측 41°/s), 저공에서 카메라가 제자리 선회를 한다.
  const pickLane = (from, exitHeading) => {
    const turn = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const score = (c) => {
      const ends = [c.pts[0], c.pts[c.pts.length - 1]];
      let best = 0;
      for (const e of ends) {
        const gap = Math.hypot(e.x - from.x, e.z - from.z) || 1;
        const bearing = Math.atan2(e.x - from.x, e.z - from.z);
        // 진행 방향 앞쪽에 있고 너무 멀지 않은 끝점을 가진 축을 선호한다.
        const ahead = 1 - turn(bearing, exitHeading) / Math.PI;
        const near = 1 / (1 + gap / (R * 0.45));
        best = Math.max(best, 0.25 + 0.75 * ahead * (0.45 + 0.55 * near));
      }
      return c.prof.mean * Math.min(1, c.len / (AXIS_TARGET_LEN * 0.55))
        * (c.level === 'soro' ? 1.25 : c.level === 'jungno' ? 1.1 : 0.8) * best * barePenalty(c);
    };
    let pick = null;
    for (const c of candidates) {
      if (sweepPick && c.road === sweepPick.road) continue;
      if (!pick || score(c) > score(pick)) pick = c;
    }
    return pick;
  };

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

  // ── 오빗 기하 ──
  const orbitTarget = aimOf(primary);
  const orbitDir = rng() < 0.5 ? 1 : -1;
  const orbitArc = ORBIT_ARC_MIN + rng() * ORBIT_ARC_SPAN;
  // 완전 역광각(카메라가 태양 반대편)이 오빗 진행 45% 지점에 오도록 시작 위상을 역산.
  const orbitTh0 = (sunKnown ? backAz : 0) - orbitDir * orbitArc * ORBIT_BACKLIT_AT;
  const orbitPt = (th, r) => ({
    x: primary.x + (r != null ? r : orbitR) * Math.sin(th),
    z: primary.z + (r != null ? r : orbitR) * Math.cos(th),
  });
  // ── 선회 반경·고도는 **프레임 적합 조건**에서 함께 푼다 ──
  //   저작하는 것은 프레임 피치(-18°)와 피사체 배치이고, 고도는 반경에서 파생된다. 반경까지 크기
  //   휴리스틱(footprint×1.5)으로 두면 궁처럼 깊은 곽(150m)이 147m 거리에서 프레임 세로를 다 먹고
  //   **근단이 하단 밖으로 잘린다**(실측 하단여백 -38%). 그래서 근단 하강각이 프레임 하단에서 5%
  //   안쪽에 들어올 때까지 반경을 키운다. 링 위 국소 지붕 헤드룸도 같은 루프에서 반영한다
  //   (고도가 오르면 근단 하강각이 다시 커진다).
  //   링을 따라 (a) 국소 민가 지붕 헤드룸 (b) **안전 하한**(지형·지붕 클리어런스, 나중에 floorLift 가
  //   반드시 적용한다)을 함께 본다. (b)를 빼면 능선을 스치는 위상에서 리프트가 고도를 올려 근단
  //   하강각이 커지고 프레임 하단이 다시 잘린다(실측 town/capital/hanyang 충족 64~83%).
  const ringFloorAt = (r) => {
    let need = -Infinity;
    for (let i = 0; i < 24; i++) {
      const p = orbitPt((i / 24) * Math.PI * 2, r);
      const d = roofDensityAt(parcelObstacles, p.x, p.z, 14);
      if (d.hits) need = Math.max(need, d.meanTop + ORBIT_ROOF_HEADROOM);
      need = Math.max(need, safeFloor(p.x, p.z));
    }
    return need;
  };
  //   화각도 함께 푼다: 작은 랜드마크(초락 종가)는 34° 프레임에서 가로 26% 밖에 차지하지 못한다.
  //   적합 조건(하단 여백)을 지키는 한에서 렌즈를 좁혀 피사체를 키운다.
  const orbitSolveAt = (fovDeg) => {
    const dep = depressionFor(ORBIT_PITCH, fovDeg);
    const tv = tanHalfV(fovDeg);
    // 최악은 대각 정점이다 — max(footW, footD)/2 로 잡으면 모델은 "들어온다"고 하고 실제 대각
    //   근단은 프레임 밖으로 나간다(실측 하단여백 -31%). 다만 기준은 **건축 덩어리**(plot × 질량비)다:
    //   plot 전체로 풀면 궁 반경이 229m 까지 커져 화면 폭 1/4 로 작아졌다(2차 비전 4항).
    const halfSpan = Math.hypot(primary.footW, primary.footD) * 0.5 * ORBIT_SUBJECT_MASS * 1.02;
    // 프레임 하단에서 5% 안쪽 / 상단에서 5% 안쪽에 해당하는 하강각.
    const bottomLimit = ORBIT_PITCH + Math.atan(tv * (1 - 2 * SUBJECT_BOTTOM_MARGIN_MIN));
    const r0 = 0.5 * primary.ext * 1.5 + Math.max(R * 0.07, 10);
    let r = r0, y = 0;
    for (let it = 0; it < 48; it++) {
      const floor = ringFloorAt(r);
      y = orbitTarget.y + r * Math.tan(dep);
      if (Number.isFinite(floor)) y = Math.max(y, floor);
      const near = Math.atan((y - primary.baseY) / Math.max(4, r - halfSpan));
      const far = Math.atan((y - (primary.baseY + primary.h)) / (r + halfSpan));
      // 세로 점유가 너무 작아지면(멀어지면) 더 키우지 않는다 — 얇은 띠는 반대쪽 결함이다.
      if (near <= bottomLimit || (near - far) <= SUBJECT_HEIGHT_MIN_FRAC * fovDeg * DEG) break;
      if (r > r0 * 3.2) break;
      r *= 1.05;
    }
    // 가로 점유 = 피사체 덩어리 폭의 시각각 / 프레임 수평 화각.
    // **좁은 면**을 기준으로 잡는다 — 품질 계약은 전 위상의 최소 가로 점유를 보고, 그 최소는
    //   피사체가 짧은 변을 보이는 위상에서 나온다(대각으로 잡으면 계약과 다른 양을 최적화한다).
    const massW = Math.min(primary.footW, primary.footD) * 0.5 * ORBIT_SUBJECT_MASS;
    const widthFrac = Math.atan(massW / Math.max(8, r)) / Math.atan(tv * FRAME_ASPECT);
    // 상승 보상 반경 증가분(위 상수 주석). 적합 조건 루프에는 **넣지 않는다**: 끝 상태를 적합에 넣으면
    //   세로 점유 브레이크가 먼저 걸려 해석된 화각·반경이 통째로 달라진다(실측 마을 fov 24/r71 → fov 32/r56).
    const growMax = tv / tanHalfV(fovDeg * (1 - ORBIT_LENS_CREEP)) - 1;
    const radiusRise = Math.min(ORBIT_CLIMB_M / Math.tan(dep), r * growMax);
    return { r, y, fov: fovDeg, widthFrac, radiusRise };
  };
  const orbitFrame = (() => {
    let best = null;
    for (const fovDeg of [ORBIT_FOV, 32, 30, 28, 26, 24, 22]) {
      const cand = orbitSolveAt(fovDeg);
      if (!best || cand.widthFrac > best.widthFrac) best = cand;
      if (cand.widthFrac >= ORBIT_WIDTH_TARGET) return cand;
    }
    return best;
  })();
  const orbitR = orbitFrame.r;
  const orbitY = orbitFrame.y;
  const orbitFov = orbitFrame.fov;
  // 선회 종단 기하 — 이탈 접선·진입 반경 계약이 이 값을 쓴다(상승·크리프 뒤의 실제 링).
  const orbitREnd = orbitR + orbitFrame.radiusRise;
  const orbitYEnd = orbitY + ORBIT_CLIMB_M;
  const orbitFovEnd = orbitFov * (1 - ORBIT_LENS_CREEP);

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
  const addDir = (leg, pos, dir, dist, fov, w, subject, rollAuth) => {
    stations.push({
      leg, pos, dist: Math.max(AIM_MIN, dist), fov, w,
      az: Math.atan2(dir.x, dir.z),
      pitch: Math.asin(Math.min(1, Math.max(-1, -dir.y))),
      // 프레이밍 피사체가 있는 스테이션은 안전 리프트가 확정된 뒤 시선을 다시 푼다(아래 refresh).
      subject: subject || null,
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

  // ① crane-in — 역광측 상공에서 시작해 사이트를 **감아 돌며 하강**하는 진입 나선. 오빗 접선
  //   진입점에서 끝난다.
  //   왜 방사 직선이 아닌가: 오빗 시작 위상은 역광 순간을 오빗 중반에 두려고 정해지므로 진입점은
  //   접근 방위에서 100~155° 떨어진다. 두 점을 직선으로 이으면 카메라가 도성을 가로질러 북쪽 산
  //   밖까지 날아가고, 시선은 그 사이에 180° 를 뒤집어야 해서 "거의 수직 하향" 구간이 생겼다(실측
  //   dy=-0.96). 나선은 같은 방위 변화를 긴 호에 나눠 담아 회전을 3~8°/s 로 눕힌다.
  //   고도·프레임 피치를 저작하고 **거리**를 파생한다. 접선 진입 두 점의 고도도 같은 규칙으로
  //   ORBIT_PITCH 에서 파생해 진입 활강 전체가 한 피치 대역 안에서 눕는다.
  const az0 = backAz + jitter(13);
  const entryTh = orbitTh0 - orbitDir * ORBIT_ENTRY_ARC;
  const entryFarR = orbitR * 1.55, entryNearR = orbitR * 1.18;
  const entryFar = orbitPt(entryTh, entryFarR);
  const entryNear = orbitPt(entryTh, entryNearR);
  const entryFarY = Math.max(orbitY,
    orbitTarget.y + entryFarR * Math.tan(depressionFor(ORBIT_PITCH, 33)));
  const entryNearY = Math.max(orbitY,
    orbitTarget.y + entryNearR * Math.tan(depressionFor(ORBIT_PITCH, orbitFov)));
  // 진입 나선의 방위 감김 — 상승 리빌이 **같은 감김 방향**으로 az0 에 도착해야 두 구간의 방위 구간이
  //   겹치지 않는다(2026-08-01 3차 비전 B항, 아래 climb 블록에서 소비). 블록 밖으로 끌어 올린 이유는
  //   그것뿐이고 진입 나선의 계산 자체는 종전과 같다.
  const entryAzC = Math.atan2(entryFar.x - coreSubject.x, entryFar.z - coreSubject.z);
  const craneSweep = Math.atan2(Math.sin(entryAzC - az0), Math.cos(entryAzC - az0));
  {
    const fovOf = (f) => 34 + 2 * Math.sin(Math.PI * f);
    // 정점 반경은 저작 피치(-38°)에서 파생 — 이것이 "도성 위 부감" 진입 구도를 만든다.
    // 진입 정점은 의도된 top-down 이라 능선을 프레임에 넣지 않는다. 다만 하강하며 와이드 대역으로
    //   눕는 구간이 능선을 상단에 두려면 정점 고도부터 그 하한 위에 있어야 한다.
    const wideFloor = wideYFloor(REVEAL_PITCH, 34);
    const apex = aerialAt(coreSubject, az0,
      Math.max(groundC + Math.max(Hmax * 0.95, R * 0.30), wideFloor), CRANE_PITCH_TOP, fovOf(0));
    const yTop = apex.pos.y;
    const radApex = apex.d;
    const sweep = craneSweep;
    const steps = Math.max(4, Math.round(Math.abs(sweep) / (30 * DEG)));
    // 피치 프로파일: 정점(-38°) → f=0.3 에서 와이드(-20°) → 진입점에서 선회 피치(-18°).
    //   **반경은 고도와 이 피치에서 파생**한다(반경을 따로 블렌딩하면 능선 하한이 고도를 올릴 때
    //   피치가 -35° 까지 다시 서 버린다 — 실측 crane median 30.8°).
    const cranePitchAt = (f) => CRANE_PITCH_TOP
      + (REVEAL_PITCH - CRANE_PITCH_TOP) * smootherstep(Math.min(1, f / 0.28))
      + (ORBIT_PITCH - REVEAL_PITCH) * smootherstep(Math.max(0, (f - 0.28) / 0.72));
    // 파생 반경 상한 — 피치가 눕는 동안 반경이 진입 반경을 크게 넘어 부풀면 나선이 밖으로 나갔다가
    //   되돌아오며 곡률이 조여져 요가 몰아친다(실측 132°/s).
    const radCap = Math.max(radApex, entryFarR * 1.2 + Math.hypot(entryFar.x - coreSubject.x, entryFar.z - coreSubject.z) * 0.2);
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      const e = smootherstep(f);
      const fov = fovOf(f);
      const pitch = cranePitchAt(f);
      // 능선 하한은 와이드 구간에만 걸고 진입점 근처에서 놓아 준다(진입 활강은 선회 피치로 수렴한다).
      const floorF = f < 0.6 ? wideFloor
        : wideFloor + (entryFarY - wideFloor) * smootherstep((f - 0.6) / 0.4);
      const yWant = Math.max(yTop + (entryFarY - yTop) * e, Math.min(yTop, floorF));
      const derived = (yWant - coreSubject.y) / Math.tan(depressionFor(pitch, fov));
      const st = aerialAt(coreSubject, az0 + sweep * f, yWant, pitch, fov,
        derived > radCap ? radCap : null);
      const pos = st.pos;
      // 시선 피사체는 시가지 매스에서 랜드마크로 옮겨 가되, 배치 불변식(yTarget)은 유지된다.
      const subject = blend(coreSubject, orbitTarget, e * 0.85);
      const look = aimAtSubject(pos, subject, fov);
      addDir(0, pos, look.dir, look.dist, fov, CRANE_W0 + (CRANE_W1 - CRANE_W0) * f, subject);
    }
    {
      const pos = V(entryFar.x, Math.max(entryFarY, safeFloor(entryFar.x, entryFar.z) + 2), entryFar.z);
      const framed = blend(coreSubject, orbitTarget, 0.92);
      const look = aimAtSubject(pos, framed, 33);
      addDir(0, pos, look.dir, look.dist, 33, W_ENTRY_FAR, framed);
    }
    {
      const pos = V(entryNear.x, Math.max(entryNearY, safeFloor(entryNear.x, entryNear.z) + 2), entryNear.z);
      const look = aimAtSubject(pos, orbitTarget, orbitFov);
      addDir(0, pos, look.dir, look.dist, orbitFov, W_ENTRY_NEAR, orbitTarget);
    }
  }

  // ② landmark-orbit — 부분 선회. 시선은 고정 랜드마크.
  //   2026-08-01(3차 비전 C항): 반경 상수·고도 상수·화각 상수였던 종전 선회는 **회전대**로 읽혔다.
  //   패스에 걸쳐 완만한 상승 + 렌즈 크리프를 얹고, 반경은 상승분을 부분만 따라간다(위 상수 주석).
  //   램프는 smootherstep 이라 선회 진입·이탈에서 반경·고도의 도함수가 0 이고(제어점 곡선이 접선을
  //   꺾지 않는다), 세 양이 모두 단조라 되돌아오는 구간이 없다.
  const orbitSteps = Math.max(7, Math.round(orbitArc / ORBIT_STEP));
  for (let i = 0; i <= orbitSteps; i++) {
    const f = i / orbitSteps;
    const e = smootherstep(f);
    const th = orbitTh0 + orbitDir * orbitArc * f;
    const fov = orbitFov + (orbitFovEnd - orbitFov) * e;
    const p = orbitPt(th, orbitR + orbitFrame.radiusRise * e);
    const pos = V(p.x, orbitY + ORBIT_CLIMB_M * e, p.z);
    // 리드룸은 **선회 본체에만** 건다. 진입 활강·상승 리빌은 피사체가 시가지 매스라 "진행 방향"이
    //   프레임 안에서 의미를 갖지 않고, 이음매(T1)와 중복 판정(T17)이 걸린 구간이기도 하다.
    //   부호: 방위가 orbitDir 방향으로 진행하므로 피사체를 그 반대쪽(뒤쪽)으로 밀어 앞을 비운다.
    const look = aimAtSubject(pos, orbitTarget, fov, -orbitDir * AERIAL_X_LEAD);
    addDir(1, pos, look.dir, look.dist, fov, W_ORBIT, orbitTarget);
  }
  // 선회 **본체**의 양 끝 제어점을 참조로 잡아 둔다. 아래 세분 패스가 스테이션을 끼워 넣으면 인덱스가
  //   밀리고, 끼워 넣어진 전이 스테이션은 앞 스테이션의 leg 태그(=1)를 물려받으므로 "leg===1 의 마지막"
  //   으로는 선회 본체의 끝을 찾을 수 없다(실측: capital 선회 반경 판정이 이탈 접선까지 포함해 86~108m).
  const orbitStFirst = stations[stations.length - orbitSteps - 1];
  const orbitStLast = stations[stations.length - 1];


  // ③ street-flythrough — 접선 이탈 → 지붕 바다 저공 스윕 → 골목/개울 저공 패스.
  const exitTh = orbitTh0 + orbitDir * (orbitArc + ORBIT_EXIT_ARC);
  // 이탈 접선은 선회 **종단** 링에서 나간다(선회가 반경·고도를 키우며 끝나므로 출발 링을 쓰면 그 자리에서
  //   안쪽으로 꺾인다 — 3차 비전 C항의 상승·크리프가 들어오면서 생긴 정합 조건이다).
  // 다만 링이 사이트에 비해 크면(capital: 궁 곽담이 커서 선회 반경 210m, R 280m) 1.55배 접선이 도성 밖
  //   350m 로 나가 그 프레임의 하단 절반이 통째로 원경 맨지형이 된다(실측 무특징 34%→40%). 사이트 안으로
  //   묶는다 — 링에서 최소 12% 는 벌려 접선 이탈의 성격은 유지한다.
  const exitR = Math.min(orbitREnd * 1.55, Math.max(orbitREnd * 1.12, R * 0.95));
  const exitPt = orbitPt(exitTh, exitR);
  const sweepOriented = orientFrom(pickSweep(exitPt), exitPt);
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
    const floored = targetY.map((v, i) => Math.max(v,
      guardRaw[Math.max(0, i - 1)], guardRaw[i], guardRaw[Math.min(pts.length - 1, i + 1)]));
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
      let ax = 0, az0s = 0;
      for (const f of [0.75, 1.0, 1.5]) {
        const q = polyAtExt(pts, cum, cum[i] + aheadDist * f);
        ax += q.x / 3; az0s += q.z / 3;
      }
      const az = Math.atan2(ax - pts[i].x, az0s - pts[i].z) + offset;
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
  const sweepSt = spanStations(sweepOriented, {
    leg: 2, clear: FLY_ROOF_CLEAR, fov: FLY_FOV, w: W_SWEEP, n: 9,
    drop: FLY_DROP_DEG, side: FLY_SWEEP_SIDE,
  });
  // 오빗 이탈 — 다음 소재(스윕 시작부)를 향해 접선으로 빠져나간다. 시선은 랜드마크에서 "지금 향해
  //   가는 곳"으로 **구면 보간**한다(두 목표점의 중간점은 카메라 근처에 떨어질 수 있다 — 그 특이점이
  //   45° 급하강 시선과 55°/s 회전의 원인이었다).
  {
    // 이탈점은 선회 고도에서 **내려가며** 나간다. 종전은 한 번 더 올라갔는데(+max(Hmax·0.10, R·0.03))
    //   그 고도·화각이 진입 나선 하강 구간과 겹쳐 같은 엽서가 됐고(실측 진입↔저공 근사중복 0.78~1.22),
    //   동시에 프레임 하단 절반이 원경 맨지형으로 채워졌다(실측 capital 무특징 34%→40%). 저공 패스로
    //   가는 길이므로 하강이 안무상 자연스럽고 두 결함을 함께 없앤다. 링 안전 하한은 지킨다.
    const exitDrop = Math.max(Hmax * 0.06, R * 0.02);
    const pos = V(exitPt.x,
      Math.max(orbitYEnd - exitDrop, safeFloor(exitPt.x, exitPt.z) + 2), exitPt.z);
    const aim = blendAim(aimTo(pos, orbitTarget), aimTo(pos, sweepSt[0].pos), 0.55);
    // 이탈·진입 화각은 저공 와이드(56°)를 향해 **단조로 열린다**. 종전 34→38 은 진입 나선 하강 구간의
    //   화각(30~36°)과 겹쳐, 부분 선회 특성상 이탈 접선이 진입 접선에서 18~73° 밖에 떨어지지 않는 구조와
    //   합쳐져 같은 엽서를 만들었다(실측 진입↔저공 0.78~1.22). 렌즈를 먼저 열어 두 구간을 문법으로 가른다.
    addDir(2, pos, dirOfAim(aim),
      Math.hypot(sweepSt[0].pos.x - pos.x, sweepSt[0].pos.z - pos.z), FLY_EXIT_FOV, W_ORBIT_EXIT);
  }
  // 스윕 진입 — 스팬 시작점 뒤 상공에서 내려앉는다(접선 정렬).
  const sweepEntryPos = (() => {
    const s0 = sweepSt[0].pos, s1 = sweepSt[1].pos;
    const l = Math.hypot(s1.x - s0.x, s1.z - s0.z) || 1;
    const back = Math.max(24, aheadDist * 1.4);
    return V(s0.x - (s1.x - s0.x) / l * back, s0.y + Math.max(10, Hmax * 0.14),
      s0.z - (s1.z - s0.z) / l * back);
  })();
  // 전이(오빗 이탈 → 스팬 시작) 사이에 **저공 접근 활강 제어점을 넣는 안은 실측이 기각했다**
  //   (2026-08-01 5차). 링이 큰 규모에서 그 전이는 시가지가 아니라 **빈 지형** 위를 지나므로, 고도를
  //   내리면 프레임이 원경 시가지 대신 근경 맨땅으로 채워진다: capital 무특징 지면 38% → 49%(상한 36).
  //   빈 구간은 낮게 스치는 것보다 **높게, 빠르게** 지나가는 편이 프레임 내용이 낫다. 그래서 전이에는
  //   제어점을 더하지 않고 속도 가중만 높인다(W_ORBIT_EXIT · W_SWEEP_ENTRY).
  add(2, sweepEntryPos, sweepSt[0].target, FLY_ENTRY_FOV, W_SWEEP_ENTRY);
  for (const d of sweepSt) pushDesc(d);
  const sweepExitHeading = (() => {
    const a = sweepSt[sweepSt.length - 2].pos, b = sweepSt[sweepSt.length - 1].pos;
    return Math.atan2(b.x - a.x, b.z - a.z);
  })();
  const lanePick = pickLane(sweepSt[sweepSt.length - 1].pos, sweepExitHeading);
  const laneBase = lanePick ? trimAxis(lanePick) : syntheticAxis(axisAz + Math.PI / 2);
  // 골목 축 방향 선택 — 진입(스윕 종점에서 오는 선회량)과 **이탈**(상승 리빌로 나가는 선회량)의
  //   합이 작은 쪽으로 놓는다. 이탈만 무시하면 골목 끝에서 카메라가 뒤를 돌아보는 180° 요 플립이
  //   생긴다(실측 172°/s). 상승 리빌은 역광측으로 나가므로 그 방위를 이탈 기준으로 쓴다.
  const laneOriented = (() => {
    const from = sweepSt[sweepSt.length - 1].pos;
    const exitRef = polar(C, backAz, R * 0.5);
    const turn = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const score = (pts) => {
      const a = pts[0], b = pts[1], y = pts[pts.length - 2], z = pts[pts.length - 1];
      const entryHeading = Math.atan2(b.x - a.x, b.z - a.z);
      const approach = Math.atan2(a.x - from.x, a.z - from.z);
      const exitHeading = Math.atan2(z.x - y.x, z.z - y.z);
      const onward = Math.atan2(exitRef.x - z.x, exitRef.z - z.z);
      return turn(entryHeading, approach) + turn(exitHeading, onward);
    };
    const fwd = laneBase.slice(), rev = laneBase.slice().reverse();
    return score(rev) < score(fwd) ? rev : fwd;
  })();
  const laneSt = spanStations(laneOriented, {
    leg: 2, clear: FLY_LANE_CLEAR, fov: FLY_FOV, w: W_LANE, n: 8,
    drop: FLY_LANE_DROP_DEG, side: FLY_LANE_SIDE, altCap: FLY_LANE_ALT_CAP,
  });
  // 스윕 → 골목 연결 — 한 번 살짝 들어올려 방향을 바꾼다(저공에서 급선회 대신 완만한 호).
  //   두 점으로 나눠 방향 전환을 분산한다(한 점이면 그 인덱스 구간에서 시선이 몰아친다).
  //   두 점을 직선 중점에 두면 스윕과 골목이 마주 볼 때 그 자리가 헤어핀이 된다. 대신 **진행
  //   방향으로 한 번 지나갔다가 골목 뒤에서 되돌아 들어오는** 뱅크 선회로 놓고 속도도 낮춘다.
  {
    const a = sweepSt[sweepSt.length - 1], b = laneSt[0];
    // 연결부 상승은 낮게 — 이 구간이 높으면 프레임이 특징 없는 지면으로 채워진다(2026-08-01 비전).
    const rise = Math.max(4, Hmax * 0.055);
    const da = aimOfDir(descDir(a)), db = aimOfDir(descDir(b));
    const la = descDist(a), lb = descDist(b);
    const sep = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
    const gap = Math.max(20, sep);
    const laneHeading = (() => {
      const p = laneSt[0].pos, q = laneSt[1].pos;
      return Math.atan2(q.x - p.x, q.z - p.z);
    })();
    // ── 뱅크 두 점의 배치 ──
    // 리드는 두 스팬이 **가까울 때 오히려 커야** 한다. 종전 `min(gap*0.45, …)` 은 반대여서, 스윕 종점과
    //   골목 시점이 거의 붙은 배치(capital: 두 스팬 사이 20m)에서 리드가 9m 로 줄고 두 뱅크 점이 3~6m
    //   간격의 지그재그가 됐다(실측 제어점 turn 137°/150°, 세그먼트 2.78m).
    // 그리고 진행 방향 성분만으로 놓으면 두 방위가 마주 볼 때(capital 176°) 골목 시점이 스윕 종점 **뒤**에
    //   있으므로 두 점이 Z 로 접힌다. 회전량에 비례해 **선회 쪽 측면 성분**을 넣어 같은 쪽으로 벌린 평행
    //   루프로 만든다: 회전이 작으면 종전과 같은 리드 배치이고, 180° 에 가까우면 반경 있는 U턴이 된다.
    // 왜 중요한가: 호길이 균일 시간축은 접힘의 왕복 호길이를 정직하게 세므로, 그 프레임의 실제 변위가
    //   반으로 줄어 프레임 속도가 19.7→8.7 로 떨어진다(실측 점프 9.4~11.0, 계약 상한 3.6).
    const lead = Math.max(Math.min(gap * 0.45, Math.max(24, R * 0.10)), Math.max(12, R * FLY_BANK_LEAD_MIN));
    const bankTurn = shortest(laneHeading - sweepExitHeading);
    const bankSide = Math.abs(bankTurn) / Math.PI;
    const sgn = bankTurn >= 0 ? 1 : -1;
    // az 증가 방향의 수평 수직벡터(측면 오프셋과 같은 규약).
    const qx = Math.cos(sweepExitHeading) * sgn, qz = -Math.sin(sweepExitHeading) * sgn;
    const fwd = lead * (1 - 0.35 * bankSide), lat = lead * 1.1 * bankSide;
    const p1r = V(a.pos.x + Math.sin(sweepExitHeading) * fwd + qx * lat, a.pos.y + rise * 0.75,
      a.pos.z + Math.cos(sweepExitHeading) * fwd + qz * lat);
    const p2r = V(b.pos.x - Math.sin(laneHeading) * fwd + qx * lat, b.pos.y + rise * 0.55,
      b.pos.z - Math.cos(laneHeading) * fwd + qz * lat);
    // 방위 성분만으로는 접힘을 막을 수 없다: 두 방위가 **같은데** 골목 시점이 스윕 종점 뒤에 있는 배치
    //   (capital 실측)에서는 p1 이 앞, p2 가 더 뒤로 가서 Z 가 된다. a→b 축 위의 진행 순서를 강제한다 —
    //   측면 성분(뱅크 모양)은 그대로 두고 축 성분만 구간으로 클램프하므로 접힘이 원리적으로 없다.
    // ── 2026-08-01 5차 FIX: 축 순서 강제는 **두 스팬이 실제로 떨어져 있을 때만** 정의된다 ──
    //   종전 코드는 축 단위벡터를 `gap`(하한 20m 이 걸린 값)으로 나눠 만들었다. 두 스팬이 붙어 있는
    //   배치(capital 실측 sep 2.69m)에서 그 벡터는 길이 0.13 의 **비단위** 벡터가 되고, 클램프 구간
    //   [gap·0.15, gap·0.45] = [3, 9] 도 2.69m 짜리 축 위에서는 의미가 없다. 결과는 두 뱅크 점이
    //   수평으로 0.17m·0.47m 안에 몰리고 y 만 5m 떨어지는 **수직 급강하**였다(실측 수평 30.5→4.1m/s ·
    //   수직 -27m/s · 프레임 속도 점프 2.2~3.6). 저공이 빨라질수록 이 결함이 그대로 커진다.
    //   분리가 리드에 비해 작으면 축을 포기하고 **접선 원호 U턴**으로 놓는다: 선회 쪽 측면에 중심을 둔
    //   반경 r 의 원에서 진입·이탈 헤딩 사이 호를 1/3·2/3 로 나눈 두 점이라, a≈b 여도 두 점은 항상
    //   2r·sin(Δ/6) 이상 벌어지고 수평 진행이 사라지지 않는다.
    let p1, p2;
    // 두 스팬이 **붙어 있고 방향도 같으면**(capital 실측: 같은 가로의 두 소로 구간이 x≈-50→0 과
    //   x≈2→50 으로 이어진다 — sep 2.9m, 전환 각 ~0°) 연결이라는 사건 자체가 없다. 그런데도 뱅크
    //   제어점 두 개와 상승(rise 4.6m)을 밀어 넣으면, 3m 짜리 수평 구간에 +3.7m/-4.8m 지그재그가 들어가
    //   그 자리에서 수직 속도가 ±27m/s 로 튄다(실측 프레임 점프 24.2). 이 배치의 올바른 처리는
    //   **제어점을 넣지 않는 것**이다 — 스플라인이 스윕 꼬리에서 골목 머리로 그대로 이어지고, 그것이
    //   "하나의 연속 저공 런"이라는 사실과도 일치한다.
    const contiguous = sep <= Math.max(8, lead * 0.7) && Math.abs(bankTurn) < 35 * DEG;
    if (contiguous) {
      p1 = null; p2 = null;
    } else if (sep > Math.max(8, lead * 0.7)) {
      const bux = (b.pos.x - a.pos.x) / sep, buz = (b.pos.z - a.pos.z) / sep;
      const orderOnAxis = (p, lo, hi) => {
        const s = (p.x - a.pos.x) * bux + (p.z - a.pos.z) * buz;
        const t = Math.min(hi, Math.max(lo, s));
        return V(p.x + (t - s) * bux, p.y, p.z + (t - s) * buz);
      };
      p1 = orderOnAxis(p1r, sep * 0.15, sep * 0.45);
      p2 = orderOnAxis(p2r, sep * 0.55, sep * 0.85);
    } else {
      const r = Math.max(10, lead * 0.85);
      // 중심은 선회 쪽 측면(qx,qz 는 이미 선회 부호가 곱해진 단위 수직벡터).
      const ox = a.pos.x + qx * r, oz = a.pos.z + qz * r;
      // a 는 중심에서 -q 방위에 있다. 위치의 반경 벡터는 속도와 같은 각속도로 도므로, 그 방위에
      //   bankTurn·f 를 더한 점이 호 위의 점이다(방위 규약 az=atan2(x,z), 점 = O + r·(sin az, cos az)).
      const baseAz = Math.atan2(-qx, -qz);
      const arcAt = (f) => {
        const th = baseAz + bankTurn * f;
        return V(ox + Math.sin(th) * r, 0, oz + Math.cos(th) * r);
      };
      const q1 = arcAt(1 / 3), q2 = arcAt(2 / 3);
      p1 = V(q1.x, a.pos.y + rise * 0.75, q1.z);
      p2 = V(q2.x, b.pos.y + rise * 0.55, q2.z);
    }
    if (p1 && p2) {
      addDir(2, p1, dirOfAim(blendAim(da, db, 0.3)), la + (lb - la) * 0.3, FLY_BANK_FOV, W_BANK, null, ROLL_BANK_AUTHORITY);
      addDir(2, p2, dirOfAim(blendAim(da, db, 0.75)), la + (lb - la) * 0.75, FLY_BANK_FOV + 1, W_BANK * 0.97, null, ROLL_BANK_AUTHORITY);
    }
  }
  // 상승호 방위를 먼저 확정한다(골목 꼬리 선회의 대상이 필요하다).
  const laneEndPre = laneSt[laneSt.length - 1].pos;
  const laneEndAzPre = Math.atan2(laneEndPre.x - coreSubject.x, laneEndPre.z - coreSubject.z);
  const climbRawPre = Math.atan2(Math.sin(az0 - laneEndAzPre), Math.cos(az0 - laneEndAzPre));
  // 방위 감김은 **최단 경로**를 쓴다. 2026-08-01 3차 비전 B항(진입↔리빌 프레임 중복)을 "상승호를
  //   진입 나선과 같은 방향으로 감아 방위 구간을 분리한다"로 풀어 봤으나 실측이 기각했다: 최단 경로의
  //   부호가 반대인 시드에서는 먼 쪽(200~260°)으로 돌아야 하고, 그러면 (a) 투어가 10~17% 부풀며
  //   (마을 176→199s · 초락 183→209s · town 140→164s) (b) 두 호의 합이 한 바퀴에 닿아 반대편에서 다시
  //   만난다. 실측 진입↔리빌 최소 근사중복 점수는 hamlet 0.95→2.35 · capital 1.04→2.45 로 좋아졌지만
  //   village 1.47→0.42 · village/2026 4.65→0.38 로 더 나빠져 순효과가 없었다. 중복은 방위가 아니라
  //   **프레임 문법**(아래 CLIMB 화각 프로파일)으로 분리한다.
  const climbSweepPre = Math.abs(climbRawPre) >= CLIMB_MIN_SWEEP
    ? climbRawPre : (climbRawPre >= 0 ? 1 : -1) * CLIMB_MIN_SWEEP;
  // 선회 대상은 시가지 중심이 아니라 **상승호 중간점**이다. 저공 코스가 시가지 중심을 스치면(capital
  //   에서 5~20m) 중심 방위가 몇 미터 사이에 180° 돌아 각속도가 133°/s 로 터진다(실측). 상승호 위의
  //   점은 항상 0.35R 이상 떨어져 있어 방위가 잘 정의된다.
  const preTurnTarget = (() => {
    const rad = Math.max(R * 0.35, orbitR);
    const p = polar(coreSubject, laneEndAzPre + climbSweepPre * 0.5, rad);
    return V(p.x, groundC + Math.max(Hmax * 0.35, R * 0.10), p.z);
  })();
  // 골목 꼬리 네 점이 시선을 미리 마을 쪽으로 돌리기 시작한다. 상승 리빌에서 한꺼번에 돌리면 짧은
  //   경로에 180° 가 몰려 각속도가 폭발하고(실측 115°/s), 두 점에만 담아도 7m 간격에 70° 가 들어가
  //   39°/s 가 된다. 네 점에 가속하듯 배분한다.
  const LANE_TAIL_TURN = [0.55, 0.36, 0.20, 0.08];
  for (let i = 0; i < laneSt.length; i++) {
    const d = laneSt[i];
    const back = laneSt.length - 1 - i;
    if (back >= LANE_TAIL_TURN.length) { pushDesc(d); continue; }
    // **요만** 돌린다. 피치까지 섞으면 저공에서 마을 중심을 겨누는 각(≈2~9°)이 프레임을 눕혀
    //   상단 하늘이 30% 로 열린다(실측). 저공의 프레임 피치는 -15° 그대로 유지한다.
    const forward = aimOfDir(descDir(d));
    const aim = {
      az: blendAim(forward, aimTo(d.pos, preTurnTarget), LANE_TAIL_TURN[back]).az,
      pitch: forward.pitch,
    };
    addDir(d.leg, d.pos, dirOfAim(aim), descDist(d), d.fov, d.w);
  }

  // ④ pullback-reveal — 저공에서 능선 위로 상승하며 전경 공개, 이음매(=①의 시작점)로 복귀.
  //   방사 직선 상승이 아니라 마을을 감아 도는 상승호 — 올라가는 동안 앵글이 계속 바뀐다.
  // 상승은 방사 직선이 아니라 마을을 감아 도는 호다(방위·최소 스윕은 위에서 확정).
  const laneEnd = laneEndPre;
  const laneEndAz = laneEndAzPre;
  const climbSweep = climbSweepPre;
  // 상승 스테이션도 부감 규칙을 따른다: 저작하는 것은 고도와 **와이드 프레임 피치**(-20°±3)이고
  //   거리는 파생된다. 마지막 두 점만 이음매(정점 -38°) 쪽으로 피치를 섞어 방향 전환을 분산한다.
  // 고도 프로파일을 앞쪽에서 더 올린다 — 피치를 눕히지 않고(반경은 피치에서 파생) 경로를 길게 만들어
  //   요 회전에 시간을 준다. aim 램프는 골목 꼬리에서 이미 시작된 회전을 이어받는다.
  // ── 화각 프로파일 = 리빌의 정체성(2026-08-01 3차 비전 B항) ──
  // 종전 41→34 는 진입 나선의 34~36 과 사실상 같은 렌즈였다. 진입과 리빌은 고도·프레임 피치 프로파일이
  //   서로의 **시간 역상**이므로(둘 다 부감 -20° 대역을 지난다) 렌즈까지 같으면 방위가 달라도 같은 엽서로
  //   읽힌다(비전 실측: 마을 pullback t030 ≈ crane-in t030). 리빌 본체를 광각으로 벌려 "계곡 전경"이라는
  //   다른 문법으로 만든다 — 진입은 접근(표준), 리빌은 전경 공개(광각). 이음매(=진입 정점)로는 마지막
  //   두 점에서 수렴시켜 루프 이음매의 fov 연속(T1)을 지킨다.
  //   피치는 저작값이라 광각화가 프레임 피치를 바꾸지 않고, 파생 반경도 depressionFor 의 2° 변화뿐이다.
  //   대신 하늘 대역이 리빌에서 약 11% 열린다(상한 40%) — 능선·헤이즈가 프레임에 들어오는 쪽이다.
  // ── 후퇴 이징은 **후반에 몰린다**(2026-08-01 4차 비전 차단 항목) ──
  // 종전 고도 프로파일은 k=0.18 에서 이미 Hmax·0.45 였다. 그래서 구간 t=0.3 시점에 카메라가 마을 전경
  //   부감에 올라와 있었고, 광각(fov 46~50)이 그 고도를 상쇄해 진입 나선 t=0.3 과 **피사체 화면 폭이
  //   같아졌다**(실측 마을 11.0% vs 11.8% = 비 1.08, 한양 26.5% vs 22.1%). 렌즈로 문법을 갈라도 배율이
  //   같으면 같은 엽서다 — 투어의 첫 패스와 마지막 패스가 같은 그림으로 시작한다.
  // 리빌은 **리빌할 대상에서 출발해야** 한다: 전반은 선회 종료 배율(처마선·마당이 읽히는 대역)에 머물고,
  //   후퇴의 대부분을 후반 40%(k ≥ 0.70)에 싣는다. 끝점은 그대로라 이음매(T1)·투어 길이·방위 계약은
  //   건드리지 않는다. 분리 축이 방위가 아니라 배율이라는 것이 비전의 처방이다.
  // 화각 램프도 **뒤집었다**. 3차의 "리빌 본체 광각"은 배율 분리와 정면 충돌한다: 광각이 낮아진 고도를
  //   상쇄해 피사체가 다시 작아지고(실측 고도·속도만 고치면 한양 화면 폭 비 1.00, 즉 완전히 같은 배율)
  //   결국 같은 엽서로 돌아온다. 리빌의 자연스러운 문법은 그 반대다 — **랜드마크에서 출발해 물러나며
  //   열린다**. 전반은 선회 종료 렌즈에 가깝게 좁고(25~34°), 후퇴와 함께 광각(46°)으로 열린 뒤 이음매
  //   화각(34°)으로 수렴한다. 진입 나선의 34~36° 대역과는 전반에서 화각으로도 갈린다.
  const CLIMB = [
    // 속도 가중도 함께 후반으로 몰린다. 시간축은 τ ∝ ∫ds/w 이므로 기하만 낮추면 전반 호길이가 짧아져
    //   구간 t=0.3 이 오히려 뒤쪽 k 로 밀린다(실측: 고도만 낮췄을 때 화면 폭 11.8%→13.5% 에 그쳤다).
    //   전반을 느리게 통과시켜야 t=0.3 이 랜드마크 배율 대역에 머문다. 골목 이탈 가중(0.56)과도 이어진다.
    // ── 5차: 리빌은 **낮은 곳에서 시작해야 리빌이다** ──
    // 종전 전반 고도는 max(Hmax·0.19, R·0.044) 로, 마을에서 이미 지면 위 30m 대였다. 즉 "지붕 뒤에
    //   숨어 있다가 올라오며 열린다"가 아니라 **처음부터 열려 있는 부감에서 더 물러나는** 후퇴였다.
    //   전반 두 점의 고도를 골목 이탈 고도 대역까지 내리고(0.19→0.105, 0.22→0.135) 속도도 더 낮춰
    //   (0.46→0.44, 0.50→0.48) 리빌의 출발이 전경 능선·지붕에 가려진 상태에서 시작하게 한다.
    //   후반 세 점은 손대지 않았으므로 상승폭(=열리는 양)이 그만큼 커진다. 안전은 aerialAt 의
    //   safeFloor 클램프와 리프트 격자가 그대로 지킨다 — 저작 고도는 하한이지 최종값이 아니다.
    { k: 0.22, y: [0.105, 0.026], fov: 25, w: 0.28, pitch: 0.0, aim: 0.62 },
    { k: 0.42, y: [0.135, 0.034], fov: 27, w: 0.33, pitch: 0.0, aim: 0.74 },
    { k: 0.58, y: [0.30, 0.074], fov: 32, w: 0.46, pitch: 0.0, aim: 0.84 },
    { k: 0.78, y: [0.55, 0.160], fov: 46, w: 0.88, pitch: 0.0, aim: 0.93 },
    // 꼬리 두 점의 **속도 가중**은 1.16/1.20 → 1.40/1.55 로 올렸다. 이음매 꼬리(피치가 정점 -38° 로 서는
    //   구간)의 시간 점유가 크면 프레임 피치 median 이 T13 와이드 대역(16~26°)을 넘는다(실측 26.7°).
    //   상한은 프레임 최대 속도가 정한다: 1.78 에서 한양 피크가 35.4m/s 로 T2 상한 34 를 넘었다
    //   (피크 ≈ 평균 × w/w̄). 이음매 쪽 **피치 혼합**은 0.2/0.5 → 0.16/0.40 으로 낮췄다: 후퇴가 후반으로
    //   몰리면서 리빌이 이음매 근처에 더 오래 머물러 진입 나선 τ0.03 과 근사 중복이 났고(실측 한양 0.65),
    //   피치를 덜 세우면 파생 반경이 커져 그 구간이 정점 바깥으로 물러난다.
    // 이 점은 정점 **위로** 넘어간다. 정점 아래에서 수렴하면 리빌의 마지막 접근이 진입 나선의 하강 경로를
    //   안쪽에서 따라가 이음매 근방에서 같은 프레임이 된다(실측 한양 crane τ0.03 ↔ reveal τ0.91, 70m).
    //   마루를 넘어 내려앉는 편이 안무로도 자연스럽고 두 경로를 수직으로 가른다.
    { k: 0.90, y: [1.06, 0.335], fov: 42, w: 1.40, pitch: 0.16, aim: 1.0 },
    { k: 1.0, y: [0.95, 0.300], fov: 34, w: 1.55, pitch: 0.40, aim: 1.0 },
  ];
  // 시선은 골목 이탈 방향에서 부감 배치로 **구면 보간**한다(점 보간이 아니라 방향 보간이라 중간
  //   조준점이 카메라 근처에 떨어지는 특이점이 없다).
  const laneExitAim = { az: stations[stations.length - 1].az, pitch: stations[stations.length - 1].pitch };
  const laneExitY = laneSt[laneSt.length - 1].pos.y;
  for (const c of CLIMB) {
    // 전반(좁은 대역)의 화각은 **선회가 이미 푼 랜드마크 렌즈**를 바닥으로 삼는다. 저작 상수만 쓰면 궁처럼
    //   큰 랜드마크(한양 곽 150m)에서 화면 폭이 90% 까지 차 프레임을 넘칠 위험이 있다(실측). 선회 종단
    //   화각은 그 규모의 피사체가 프레임에 적절히 앉도록 이미 해석된 값이라, 그 1.05배를 하한으로 두면
    //   규모에 상관없이 "랜드마크가 읽히되 넘치지 않는" 대역이 된다. 광각 구간(≥40)은 그대로 둔다.
    const cFov = c.fov < 40 ? Math.max(c.fov, orbitFovEnd * 1.05) : c.fov;
    const pitch = REVEAL_PITCH + (CRANE_PITCH_TOP - REVEAL_PITCH) * c.pitch;
    // 상승 리빌은 **단조 상승**이어야 한다. 저작 고도만 쓰면 골목 이탈 고도(회랑 지붕 하한이 올려 둔
    //   값, capital 실측 15.3m)보다 리빌 첫 점이 낮아져 카메라가 그 자리에서 급강하한다
    //   (실측 수평 30.5→6.5m/s · 수직 -26.8m/s · 프레임 점프 2.5m/s). 골목 이탈 고도를 하한으로 깔면
    //   "리빌은 낮게 시작한다"는 의도는 그대로 살면서 하강 성분이 원리적으로 사라진다.
    const yBase = Math.max(groundC + Math.max(Hmax * c.y[0], R * c.y[1]), laneExitY);
    // 상승 후반(와이드 프레임)은 능선 하한을 받는다. 전반은 아직 저공에서 올라오는 구간이라 제외.
    // 상승 후반(와이드 프레임)은 **그 스테이션의 실제 피치**로 능선 하한을 받는다 — 대표 피치로 한 번만
    //   잡으면 피치가 22~24° 인 표본에서 능선이 다시 프레임 상단에 붙는다(실측 밴드 2% → 9%).
    //   진입 나선에는 같은 처방을 쓰지 않는다: 진입 후반은 선회 진입 활강이라 고도가 낮아야 하고,
    //   거기에 하한을 걸면 투어 전체가 부풀어 저공 구간의 시간·코스 채점이 무너졌다(실측 커버리지 56%).
    const y = c.k >= 0.5 ? Math.max(yBase, Math.min(yBase * 2.4, wideYFloor(pitch, cFov))) : yBase;
    // 반경 하한 — 외딴집처럼 orbitR > R 인 규모에서 상승 시작점이 선회 원 안쪽에 놓이면 결말이 3초짜리
    //   꼬리가 된다. 다만 전반 계수를 0.55 로 두면 후퇴 이징을 후반에 몰아도(위 CLIMB 주석) 반경이 먼저
    //   붙잡혀 t=0.3 배율이 그대로다. 시작 계수만 낮추고 끝점(1.0)은 유지한다.
    const radFloor = orbitR * (0.35 + 0.65 * c.k);
    const derived = (y - coreSubject.y) / Math.tan(depressionFor(pitch, cFov));
    const st = aerialAt(coreSubject, laneEndAz + climbSweep * c.k, y, pitch, cFov,
      derived >= radFloor ? null : radFloor);
    const pos = st.pos;
    const look = aimAtSubject(pos, coreSubject, cFov);
    addDir(3, pos, dirOfAim(blendAim(laneExitAim, aimOfDir(look.dir), c.aim)), look.dist, cFov, c.w,
      c.aim >= 0.9 ? coreSubject : null);
  }
  // 마지막 제어점 다음은 닫힌 곡선이므로 ①의 첫 점으로 이어진다 — 그 구간이 이 leg 의 꼬리다.

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
        if (Math.min(m1, m2) >= foldLen) continue;
        const cos = (v1x * v2x + v1z * v2z) / (m1 * m2);
        if (cos > Math.cos(FOLD_TURN)) continue;
        // 3차원 전체를 당긴다. 수평만 당기면 capital 프레임당 속도 변화가 13.2 로 남는다 — 그 시드의
        //   접힘은 회랑 지붕 하한이 만든 **수직** 첨점이기 때문이다(수평 지그재그만 있는 것이 아니다).
        stations[i].pos = V(b.x + ((a.x + c.x) * 0.5 - b.x) * FOLD_PULL,
          b.y + ((a.y + c.y) * 0.5 - b.y) * FOLD_PULL,
          b.z + ((a.z + c.z) * 0.5 - b.z) * FOLD_PULL);
        fixed++;
      }
      if (!fixed) break;
    }
  }

  // ── 방향 변화 상한 세분 ── 스테이션 간 방향차가 상한을 넘으면 그 사이를 나눈다. 위치는 직선 보간
  //   (전이 구간에만 발동하므로 경로 형상은 사실상 그대로), 방향은 slerp, leg 태그는 앞 스테이션을
  //   물려받아 구간 경계 인덱스를 흔들지 않는다.
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
    for (let i = 0; i < N; i++) {
      const st = stations[i];
      if (!st.subject) continue;
      const lifted = V(st.pos.x, st.pos.y + liftOf(i / N), st.pos.z);
      const look = aimAtSubject(lifted, st.subject, st.fov);
      st.az = Math.atan2(look.dir.x, look.dir.z);
      st.pitch = Math.asin(Math.min(1, Math.max(-1, -look.dir.y)));
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
  const solveCanopy = (dirOf, distOf) => {
    const raw = new Float64Array(LIFT_GRID);
    if (canopies.length) {
      // 요구량은 **단조**여야 한다: 시선을 수관 **위로** 넘기는 해만 쓴다. "여유가 확보되는 최소 고도"를
      //   스캔으로 찾으면 시선이 수관 아래로 지나가는 해가 뽑힐 수 있고, 그 해집합은 y 에 대해 위로
      //   닫혀 있지 않아서 리프트를 확산시킨 중간 고도가 다시 잎을 지난다(실측 -1.31m).
      //   광선 방향은 고정이므로 카메라를 올리면 수관 수평 최근접점에서의 광선 높이도 같은 만큼 오른다.
      for (let i = 0; i < LIFT_GRID; i++) {
        const t = liftT[i];
        const p = basePos[i];
        const y0 = p.y + floorLift[i];
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
        // 상한 — 어떤 경우에도 수관 회피가 투어 고도 체계를 뒤집지 않는다.
        raw[i] = Math.min(Math.max(0, need), Math.max(20, Hmax * 0.35));
      }
    }
    return raw;
  };
  let canopyRaw = solveCanopy((t) => look.dirAt(t), (t) => look.distAt(t));
  const canopyLift = spreadPeriodic(canopyRaw, rampCells);
  const liftGrid = new Float64Array(LIFT_GRID);
  for (let i = 0; i < LIFT_GRID; i++) liftGrid[i] = floorLift[i] + canopyLift[i];
  // 격자는 τ_A 균일이므로 리프트도 τ_A 로 읽는다.
  const liftAt = (t) => gridAt(liftGrid, axisA.tauOf(t));
  // 2차 해결 — 수관 리프트까지 반영한 최종 고도에서 프레이밍 시선을 다시 푼다(궁 근단이 프레임
  //   하단 밖으로 잘리던 잔차의 원인은 수관 리프트가 카메라를 41m 올린 뒤에도 시선이 그대로였던 것).
  look = buildLook(liftAt);
  // 재해결로 시선이 바뀌었으니 수관 요구량을 다시 풀어 커진 만큼만 합산한다(단조 → 수렴).
  {
    const again = solveCanopy((t) => look.dirAt(t), (t) => look.distAt(t));
    let grew = false;
    for (let i = 0; i < LIFT_GRID; i++) {
      if (again[i] > canopyRaw[i]) { canopyRaw[i] = again[i]; grew = true; }
    }
    if (grew) {
      const lift2 = spreadPeriodic(canopyRaw, rampCells);
      for (let i = 0; i < LIFT_GRID; i++) liftGrid[i] = floorLift[i] + lift2[i];
      look = buildLook(liftAt);
    }
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
  const POS_SMOOTH_SEC = 0.16;
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
    { name: 'crane-in', kind: 'establish' },
    { name: 'landmark-orbit', kind: 'orbit' },
    { name: 'street-flythrough', kind: 'flythrough' },
    { name: 'pullback-reveal', kind: 'reveal' },
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
    // 방위 감김 진단 — 진입 나선과 상승 리빌의 방위 구간이 겹치지 않는지(3차 비전 B항) 게이트가 본다.
    azimuth: {
      az0Deg: +(az0 / DEG).toFixed(1),
      craneSweepDeg: +(craneSweep / DEG).toFixed(1),
      laneEndAzDeg: +(laneEndAz / DEG).toFixed(1),
      climbSweepDeg: +(climbSweep / DEG).toFixed(1),
    },
    orbit: {
      radius: +orbitR.toFixed(2), y: +orbitY.toFixed(2), fov: orbitFov,
      // 선회 종단(상승·반경·렌즈 크리프 뒤). 게이트가 "회전대가 아니다"를 이 값으로 판정한다.
      radiusEnd: +orbitREnd.toFixed(2), yEnd: +orbitYEnd.toFixed(2), fovEnd: +orbitFovEnd.toFixed(2),
      climb: ORBIT_CLIMB_M,
      arcDeg: +(orbitArc / DEG).toFixed(1), dir: orbitDir,
      target: { x: +orbitTarget.x.toFixed(2), y: +orbitTarget.y.toFixed(2), z: +orbitTarget.z.toFixed(2) },
      // 선회 **본체**의 투어 시각 창(τ). leg 'landmark-orbit' 의 t1 은 이탈 접선 구간까지 포함하므로
      //   "반경 상수·랜드마크 프레임" 같은 선회 계약은 이 창에서만 판정해야 한다.
      t0: +axis.tauOf(stations.indexOf(orbitStFirst) / N).toFixed(6),
      t1: +axis.tauOf(stations.indexOf(orbitStLast) / N).toFixed(6),
    },
    sweep: {
      len: +polyLen(sweepOriented).toFixed(1),
      road: sweepPick ? (sweepPick.level || 'road') : 'synthetic',
    },
    lane: {
      len: +polyLen(laneOriented).toFixed(1),
      road: lanePick ? (lanePick.level || 'road') : 'synthetic',
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
