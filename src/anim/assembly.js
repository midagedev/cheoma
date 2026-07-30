// 조립(시공) 애니메이션 — 프레임워크 무관 ES 모듈.
//   playAssembly(building, { duration=5, onDone, amp=1 }) →
//     { update(dt) → done:boolean, skip(), seek(t01), isDone() }
//
// 파라메트릭 모델이 "지어지는" 순간을 보여준다. 시공 순서대로 파트가 스태거되며,
// 각 파트는 제자리 아래에서 떠올라 안착한다. 안착 순간 **두부 물리**(스쿼시&스트레치)로
// 눌렸다 펴지며 출렁 복원한다 — 수묵 산수(정적) 위에 통통한 두부 물리의 대비가 이 앱의
// 시그니처 감성. 이 이징 언어는 조립·칸 확장·머지·마을 리롤 웨이브가 공유한다
// (아래 tofuRise/tofuBob/tofuScale export 가 단일 출처 — 방언을 새로 만들지 말 것).
//
// 방향 계약: 기단·기둥·벽·공포는 제자리 **아래에서** 떠오르고, 지붕만 **위에서** 내려앉는다(상량).
// PART_DROP 의 부호가 그 방향이고, 정착 반동은 두 경우 모두 위쪽이다(접촉면에서 멀어지는 방향).
// 방향은 속도 프로파일도 뒤집는다: 올라오는 부재는 감속(던져 올린 것), 내려앉는 부재는 가속(중력).
// 내려앉는 강체는 여기에 두 가지가 더 붙는다 — 단단한 좌대(SETTLE_SEAT_RIGID)와 접촉에서 0 이 되는
// 롤 정렬(ROOF_ROLL_DEG). 셋 다 "떨어진다"를 "인양해 얹는다"로 바꾸기 위한 것이다(2026-07-30).
//
// 시맨틱 조립 그룹: 지붕은 **강체 한 덩어리**로 움직인다(그룹 transform 하나만).
// 자식별 독립 Y/스케일은 기와 외피·방 천장 하면·서까래의 authored 깊이 스택을 깨
// z-fighting 을 만든다. 등장 순서만 시맨틱 청크(서까래→통덩어리→잡상)와 켜 흐름으로
// visible 스태거한다. 빌더가 지붕 그룹에 userData.asmChunked=true 를 달면 자식을
// userData.asmGroup 태그로 묶어 청크 등장 순서를 정하고, 태그 없는 자식은 'body' 청크.
// 청크 **내부** 켜 흐름: 처마(낮은 면)→용마루(높은 면) 순으로 드러난다.
//
// 부재 리플("다라라락", 사용자 지시 2026-07-26): 반복 부재(기둥열·기단 켜·횡부재 켜)는
// 한꺼번에 올라오지 않고 **아주 약간의 시간차**로 흐른다. 종전에도 자식별 스태거는
// 있었지만 (a) 배열 인덱스 순서라 공간적으로 무의미했고 (b) 이웃 간격이 ~26ms(60fps 1.5
// 프레임)라 수학적으로 비가시였다. 지금은 순서를 **기하에서 유도**하고(아래 ORDER)
// 이웃 간격에 하한(MIN_RIPPLE_SEC)을 둔다.
//
// 원상복구 보장: position.y·scale·rotation·visible 만 건드리고, 종료·중단·seek 시 원값으로 정확히
// 복원한다. 시작 시 각 자식의 원 transform 을 저장하므로 regenerate 와 경합해도 skip()으로
// 안전히 되돌린다. (기존 ?assemble=1 데모 셸 seek/skip 경로 호환 유지.)

const PART_ORDER = ['podium', 'columns', 'walls', 'brackets', 'roof'];

// Depth-critical under-eave stack: outer tile + structural 개판 (+ eave band lip)
// + rafters. Room 반자 is deferred (docs/ceiling.md).
// Hiding only the shell left rafters free to rise through the plate/창방 band
// ("기둥 위에 반자" residual after the shell-only gate).
const ROOF_SHELL_NAMES = new Set(['roof-tile-outer', 'roof-gaepan', 'roof-eave-band']);

function isRoofShellPiece(obj) {
  if (!obj) return false;
  if (ROOF_SHELL_NAMES.has(obj.name)) return true;
  // Builders may omit names on intermediate clones; still tag gaepan materials.
  if (obj.userData?.roofLayer === 'gaepan') return true;
  if (obj.material?.userData?.isRoofGaepan) return true;
  if (obj.material?.userData?.paletteKey === 'gaepan') return true;
  return false;
}

/** Shell + rafters: coplanar scrape risk against plate/창방 while the rigid roof rises. */
function isUnderEaveCritical(obj) {
  if (!obj) return false;
  if (isRoofShellPiece(obj)) return true;
  if (obj.userData?.asmGroup === 'rafters') return true;
  if (obj.userData?.roofLayer === 'rafter') return true;
  return false;
}

/** Keep each roof-tile-outer / roof-gaepan pair on the same visible bit. */
function lockRoofShellVisibility(roofGroup) {
  if (!roofGroup?.children?.length) return;
  for (let i = 0; i < roofGroup.children.length - 1; i++) {
    const a = roofGroup.children[i];
    const b = roofGroup.children[i + 1];
    if (a?.name === 'roof-tile-outer' && b?.name === 'roof-gaepan') {
      b.visible = a.visible;
    }
  }
  // Eave band sits on the same physical shell stack; if the outer is hidden the
  // band alone reads as a coplanar lip on the rising gaepan.
  for (let i = 0; i < roofGroup.children.length; i++) {
    const band = roofGroup.children[i];
    if (band?.name !== 'roof-eave-band') continue;
    // Prefer the preceding outer on this face (add order: outer, gaepan, band).
    let outer = null;
    for (let j = i - 1; j >= 0; j--) {
      if (roofGroup.children[j]?.name === 'roof-tile-outer') {
        outer = roofGroup.children[j];
        break;
      }
    }
    if (outer) band.visible = outer.visible;
  }
}

// 파트별 타임라인 윈도(전체 duration 대비 비율). 시공 순서 스태거, 살짝 겹쳐 흐름을 만든다.
//   지붕 창 0.74 → 0.70: 지붕은 어느 건물에서나 클라이맥스 부재이고, 그 창의 절반이 공중 구간
//   (u<IMPACT)이다. 0.26 창에서는 히어로 조립(몸채 창 7.4s)에서도 공중 시간이 0.96s 뿐이라
//   0.25s 간격 캡처에 1~3장만 남았다(2026-07-30 판정: "공중 프레임 1장, 0.25초 미만 팝").
//   0.30 창이면 2.22s 모션 / 1.11s 공중 — 라이브 프레임에 4장 이상 남는다.
//   단, 지붕 창은 여기 적힌 값이 **상한**이다: ROOF_LIFT_OF_MASS 가 여행거리를 깎으면 창도 같은
//   비율로 좁아진다(끝은 고정, 시작만 늦어짐). 실제 종가는 [0.836, 1.00] 로 좁혀져 공중 0.61s 다.
//   그래서 이 표의 숫자로 지붕 타이밍을 단정하지 말고 plan() 의 window/airborneSec 을 볼 것.
const PART_WINDOWS = {
  podium:   [0.00, 0.26],
  columns:  [0.18, 0.48],
  walls:    [0.42, 0.64],
  brackets: [0.58, 0.82],
  roof:     [0.70, 1.00],
};

// 파트별 낙하 거리 배수(묵직함 차등 — 기단은 작게, 지붕은 크게 움직인다).
//   **음수 = 위에서 내려앉는다(상량).** 지붕만 음수다. 아래에서 밀어 올리던 구 모델은 개판·서까래가
//   평방/창방 띠를 통과해야 해서 "정착 직전까지 지붕 전체를 숨기는" 게이트가 필요했고, 그 결과 클립에서
//   지붕이 공중에 있는 프레임이 정확히 0 이었다(2026-07-29 21프레임 판정: 기와 껍질이 애니메이션 없이
//   팝인). 위에서 내려오는 강체는 통과할 것이 없고 — 브래킷은 아래에서, 지붕은 위에서 서로를 향해
//   접근하므로 관통이 원리적으로 불가능하다 — 첫 프레임부터 보인다. 실제 시공 순서(상량)와도 맞는다.
//   지붕 3.4 → 2.0 (2026-07-30 사용자 판정: "위에서 뚝 떨어지는 인상이 부자연스럽다"). 3.4 는 실제
//   종가에서 여행거리 5.30m 이고, 그때 공중 처마선이 7.58m 까지 올라가 **자기 용마루(5.92m)보다
//   1.66m 높았다**(2026-07-31 실측) — 다 지어진 집 위 허공에 지붕이 통째로 떠 있는 프레임이다.
//   이 배수만으로는 부족하다: dropBase 는 layout.totalH 에 비례하는데 buildHanok 은 layout 을 달지
//   않아 폴백 12m(실제의 2배)가 쓰이기 때문이다. 그래서 최종 여행거리는 ROOF_LIFT_OF_MASS 상한이
//   기하에서 정한다(종가 1.71m, 처마 피크 3.98m < 용마루 5.92m). 이 배수는 상한에 닿지 않는
//   큰 건물(궁 등)에서만 실제 값이 된다.
//   거리를 줄이면서도 **접촉 속도는 보존한다**(3.91 → 3.85 m/s): 하강 프로파일을 중력형(가속)으로
//   뒤집어 접촉 속도가 1.67배로 오르고(riseVelDown 참조), 상한이 걸린 만큼 접근 시간도 같은 비율로
//   줄이므로 속도가 유지된다 — 두부 계약(무게=진폭 아님, 접근 속도)이 그대로다.
const PART_DROP = { podium: 0.7, columns: 1.0, walls: 0.9, brackets: 0.85, roof: -2.0 };

// 파트별 두부 탄성 진폭(스쿼시&스트레치 강도). 기둥은 스프링처럼 튀고, 지붕은 절제한다.
//   지붕 0.32 → 0.22: 구 모델은 접촉에서 변형이 정확히 0 이라 스트레치가 **상승 중에만**(대부분
//   시야 밖) 보였다. 모멘텀 연속 모델은 접촉 순간에도 변형이 남으므로, 같은 게인이면 팔작 지붕의
//   들린 처마 끝이 낫처럼 과장돼 보인다(캡처 판정 cont-34). 처마 선은 이 프로젝트의 서명이므로
//   (look-grammar: 실루엣 우선) 지붕만 게인을 낮춘다 — 정착 스쿼시는 여전히 읽힌다(≈3%).
//   주의: 지붕 값은 **강체 경로에서 효력이 없다**. 강체 지붕은 allowScale=false 라 스쿼시가 없고,
//   모멘텀 모델의 tofuBob 은 amp 를 쓰지 않는다(진폭이 접촉 속도에서 유도되므로). 지붕 정착의
//   절제는 좌대 강성 SETTLE_SEAT_RIGID 가 소유한다 — 여기 0.22 는 legacy A/B 경로 전용이다.
const PART_TOFU = { podium: 0.13, columns: 0.28, walls: 0.17, brackets: 0.20, roof: 0.22 };

// 강체 지붕이 좌대에 앉을 때의 롤 정렬(도). 인양된 지붕이 살짝 기울어 접근해 접촉 직전 수평으로
//   맞춰지는 인상 — "떨어진다"와 "얹힌다"를 가르는 가장 값싼 단서다(2026-07-30). 축은 용마루 축
//   (지배축)이라 용마루 선은 수평을 유지하고 한쪽 처마만 내려간다(팔작 실루엣 보존, look-grammar).
//   2.2°는 히어로 프레임에서 양단 차 31cm(12px @720p) — 보이지만 기울어짐이 실수로 읽히지 않는 폭.
//   포락은 tofuRise 그대로라 **접촉에서 정확히 0**(정착 이후 회전 흔들림 없음 — 후행 wobble 기각 계약).
const ROOF_ROLL_DEG = 2.2;

// 지붕 여행거리 상한 = 지붕 덩어리가 앉는 높이(그룹 localCenter.y)의 45%.
//   PART_DROP 만으로는 부족했다(2026-07-31 실측): dropBase 는 `userData.layout.totalH` 에 비례하지만
//   **buildHanok(히어로 종가)은 layout 을 달지 않아** 폴백 12m 가 쓰인다. 실제 종가 높이는 5.98m 이므로
//   구 여행거리 5.30m 는 건물 전체 높이의 89% 였고, 처마단(2.27m)에서 출발점이 7.57m —
//   **자기 용마루(5.92m)보다 높은 곳**이었다. 그것이 "하늘에서 떨어진다"의 정체다.
//   판정 기준은 그래서 프레임 비율이 아니라 기하다: **공중의 처마선이 자기 용마루선을 넘지 않는다.**
//   0.45 는 네 프리셋 실측에서 그 조건을 여유 있게 만족한다(종가 1.71m·처마피크 3.98 < 용마루 5.92,
//   기와집 2.03m·5.46 < 6.27, 날개 1.80m·4.69 < 5.73, 궁은 상한에 닿지 않아 3.17m 유지).
//   상한이 걸리면 **접근 시간도 같은 비율로 줄여** 접촉 속도를 보존한다(무게=접근 속도 계약).
//   그래서 이 상한은 "느리게 둥실 내려오는" 쪽으로 새지 않는다 — 짧고 낮은 인양이 된다.
const ROOF_LIFT_OF_MASS = 0.45;
// window.__asmRoofRoll: 캡처 A/B 용 런타임 오버라이드(0 = 롤 없음). __tofuStretch 와 같은 관례.
function rollDeg() {
  if (typeof window !== 'undefined' && typeof window.__asmRoofRoll === 'number') return window.__asmRoofRoll;
  return ROOF_ROLL_DEG;
}

// 지붕 시맨틱 청크 순서(작을수록 먼저). 태그 없는 부재의 기본 청크는 'body'.
//  rafters(서까래) → body(기와/이엉 통덩어리) → finial(잡상 등 미니팝).
const ROOF_SEQ = { rafters: 0, body: 1, finial: 2 };
const DEFAULT_CHUNK = 'body';

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// 접촉 시점(자식 로컬 진행도 u 기준). u<IMPACT 는 제자리로 접근하는 구간, 이후는 두부 정착.
//   (구 SHELL_REVEAL_UU=0.85 게이트는 폐기됐다 — 지붕이 위에서 내려앉게 되면서 스크레이프 자체가
//    사라졌고, 그 게이트가 지붕 낙하 비트를 프레임 밖으로 밀어내던 원인이었다. PART_DROP 주석 참조.)
const IMPACT = 0.5;

// ── 두부 물리: 모멘텀 연속 정착(2026-07-26 사용자 지시 3차) ─────────────────────────────
// 이력과 사용자 판정을 그대로 남긴다(다음 사람이 코드에서 옛 규칙을 재유도하지 않게).
//   ① 최초: 접촉 후 cos 1.6사이클 감쇠 진동을 **별도 단계**로 붙였다 → "다 지어진 다음에 그
//      이후 영역만 한번 덜렁거리고 만다"고 기각. 원인은 진폭이 아니라 **구조**였다: 상승이
//      easeOutCubic 이라 IMPACT 에서 속도가 정확히 0 → 그 뒤 어떤 탄성도 물려받을 운동량이
//      없으니 임의 진폭의 독립 흔들림밖에 될 수 없었다.
//   ② #126: 반동 단계를 아예 삭제(오버슈트 0, 단조). "띠용"은 사라졌지만 정착의 질감도 사라졌다.
//   ③ 현행(사용자 재지시): 탄성 자체는 원한다. 원하는 건 **"바닥에서 올라오는 그 가속도 그대로
//      푸딩 같은 느낌"** — 하나의 연속 운동. 그래서 상승이 **0 이 아닌 속도로 접촉**하고
//      (VEND), 정착은 그 접촉 속도를 초기속도로 갖는 감쇠 스프링이다. 스쿼시 진폭은 상수로
//      적는 게 아니라 **접촉 속도에서 유도**되므로, 무거운 부재(지붕)는 접근 속도·drop 이 커서
//      자연히 더 묵직하게 읽힌다.
// 계약:
//   · 접근(u<IMPACT): 정규 속도가 0 이 되지 않는다(모멘텀 보존). 방향에 따라 형상이 **시간 역전**된다:
//     아래에서 밀어 올리는 부재는 1 → VEND 로 감속(던져 올린 것), 위에서 내려앉는 부재는 VEND → 1 로
//     가속(중력에 놓인 것). 같은 상수·같은 적분값의 한 프로파일을 뒤집을 뿐이라 방언이 늘지 않는다.
//   · 정착(u≥IMPACT): 위치는 접촉 속도를 초기속도로 갖는 감쇠 스프링(작은 오버슈트→복귀),
//     변형은 그 수직 속도에 비례(올라갈 때 stretch sy>1, 되돌아올 때 squash sy<1·sxz>1).
//   · u=1 에서 위치·스케일이 **정확히** 원상 — 포락 (1-w²) 이 w=1 에서 0 이므로 잔여 오프셋 0.
//   · 접촉에서 값·도함수 모두 연속(C1) → "이제부터 흔들림" 하는 단절이 없다.
//
// 하강 프로파일 뒤집기(2026-07-30): 종전에는 두 방향이 같은 감속 프로파일을 썼다. 감속은 위로
//   던져 올린 부재에는 맞지만(중력이 감속시킨다), **위에서 내려오는 지붕에는 물리적으로 반대**다 —
//   낙하체는 가속한다. 그래서 지붕은 등속 엘리베이터처럼 떠내려오는 인상이었고, "위에서 뚝 떨어진다"는
//   판정의 절반이 여기서 왔다(나머지 절반은 호버 높이 — PART_DROP 참조). 뒤집으면 (a) 물리적으로 맞고,
//   (b) 시작이 느려 상량 인양처럼 잠깐 걸려 있다가 내려오고, (c) 접촉 속도가 1/VEND=1.67배로 올라
//   같은 무게감을 더 짧은 거리로 살 수 있다. 적분 ∫₀¹v dk 는 두 형상이 동일(k² 와 (1-k)² 가 같은 1/3)
//   하므로 RISE_N 은 그대로다 — 정규화 상수를 방향별로 갈라야 한다면 그건 다른 프로파일이라는 뜻이다.
const VEND = 0.6;                                  // 접촉 순간 남는 정규 상승 속도(0=구 무반동 모델)
const RISE_N = VEND + (1 - VEND) / 3;              // 접근 속도 프로파일의 적분(위치 정규화 상수, 방향 공통)
const SETTLE_W = 2 * Math.PI * 1.25;               // 정착 스프링 각속도(정착창 1.25 사이클)
const SETTLE_Z = 2.2;                              // 정착 감쇠(클수록 한 번에 잦아든다)
const CONTACT_V = VEND / (RISE_N * IMPACT);        // 상승 접촉 속도 [drop/u]
const CONTACT_V_DOWN = 1 / (RISE_N * IMPACT);      // 하강 접촉 속도 [drop/u] — 가속 프로파일의 v(1)=1

// 정착 좌대: 스프링 강성·감쇠. 진폭은 여전히 **접촉 속도에서** 나오고(∝ v0/w) 좌대는 그 운동량을
//   어떻게 흡수하는지만 정한다 — 그래서 부재별로 좌대를 갈아도 "무게=접근 속도" 계약이 유지되고,
//   초기속도가 v0 그대로이므로 접촉 C1 도 (w, z) 와 무관하게 정확히 성립한다.
//   · SETTLE_SEAT       — 부재 기본. 두부처럼 한 번 크게 출렁이고 잦아든다.
//   · SETTLE_SEAT_RIGID — 강체 지붕. 무거운 부재가 굵은 평방·창방 위에 앉는 좌대는 훨씬 단단하고
//     소산이 크다. 기본 좌대로는 접촉 속도 3.8m/s 가 36cm 짜리 3연속 호핑이 되어(2026-07-30 수치)
//     5톤 지붕이 공처럼 튄다. 강성을 2배(2.5 사이클), 감쇠를 6.0 으로 올리면 같은 모멘텀이 16cm
//     한 번의 짧은 안착으로 흡수된다 — 스쿼시가 없는 강체에서 무게를 읽히게 하는 유일한 채널이다.
const SETTLE_SEAT = { w: SETTLE_W, z: SETTLE_Z };
const SETTLE_SEAT_RIGID = { w: 2 * Math.PI * 2.5, z: 6.0 };
// 아래에서 올라오는 부재의 기본 물리(방향·좌대) — export 된 이징의 기본 인자와 동일한 조합.
const SHARED_PHYS = { descending: false, seat: SETTLE_SEAT };

// 정규 접근 속도(k=u/IMPACT). 상승: 1 → VEND(감속). 하강: VEND → 1(중력 가속).
//   이 형상의 적분이 접근 위치를 만들고, 이 값 자체가 스쿼시&스트레치를 구동한다(속도 결합 — 단일 출처).
const riseVel = (k) => VEND + (1 - VEND) * (1 - k) * (1 - k);
const riseVelDown = (k) => VEND + (1 - VEND) * k * k;
// 정착 포락: w=1 에서 정확히 0(잔여 오프셋 0), w=0 에서 값 1·도함수 0(접촉 C1 보존).
const settleEnv = (w) => 1 - w * w;

// TOFU_STRETCH: 속도→변형 결합 게인(1=또렷한 스쿼시&스트레치, 0=변형·정착 없이 순수 상승 A/B).
//   window.__tofuStretch(런타임 튜닝)·window.__tofuLegacy(①의 구 반동 A/B) 오버라이드.
//   하위호환: setTofuBounce/getTofuBounce 는 이 게인의 별칭으로 유지(외부 API 시그니처 불변).
let TOFU_STRETCH = 0.7;
export function setTofuBounce(k) { TOFU_STRETCH = Math.max(0, Math.min(1, k)); }
export function getTofuBounce() { return TOFU_STRETCH; }
function stretchK() {
  if (typeof window !== 'undefined' && typeof window.__tofuStretch === 'number') return window.__tofuStretch;
  if (typeof window !== 'undefined' && typeof window.__tofuBounce === 'number') return window.__tofuBounce; // 구 훅 호환
  return TOFU_STRETCH;
}
function tofuLegacy() { return typeof window !== 'undefined' && !!window.__tofuLegacy; }

// 접근 오프셋 계수(1→0, drop 배수). caller: position.y = y0 - tofuRise(u) * drop + tofuBob(...) * drop.
//   IMPACT 에서 0 이지만 **속도는 CONTACT_V(하강은 CONTACT_V_DOWN)** — 그 운동량이 곧 정착의 초기조건이다.
//   opts.descending: 위에서 내려앉는 부재(drop<0). 같은 프로파일의 시간 역전 — 위 주석 참조.
export function tofuRise(u, { descending = false } = {}) {
  if (u <= 0) return 1;
  if (u >= IMPACT) return 0;
  const k = u / IMPACT;
  if (tofuLegacy()) return 1 - easeOutCubic(k);
  const area = descending
    ? VEND * k + (1 - VEND) * (k ** 3) / 3
    : VEND * k + (1 - VEND) * (1 - (1 - k) ** 3) / 3;
  return 1 - area / RISE_N;
}

// 정착 오버슈트 계수(drop 배수, 0 → 작은 양수 → 작은 음수 → 정확히 0).
//   접촉 속도를 초기속도로 갖는 감쇠 스프링. 진폭은 상수가 아니라 모멘텀에서 나온다(기본 좌대 ≈drop 의 7%,
//   강체 좌대 ≈5%). 초기속도가 v0 라는 성질은 좌대 (w,z) 와 무관하므로 접촉 C1 은 어떤 좌대에서도 성립한다.
//   stretchK()==0 이면 탄성 없음(순수 상승 A/B). amp 는 legacy 경로 호환용으로만 쓰인다.
export function tofuBob(u, amp = 0.2, { descending = false, seat = SETTLE_SEAT } = {}) {
  if (u < IMPACT || u >= 1) return 0;
  const w = (u - IMPACT) / (1 - IMPACT);
  if (tofuLegacy()) return amp * Math.exp(-w * 4.5) * Math.sin(w * Math.PI * 2 * 1.6) * 0.6;
  if (stretchK() <= 0) return 0;
  const v0 = (descending ? CONTACT_V_DOWN : CONTACT_V) * (1 - IMPACT);
  return (v0 / seat.w) * Math.exp(-seat.z * w) * Math.sin(seat.w * w) * settleEnv(w);
}

// 정착 오버슈트 최대값(drop 배수) — 좌대·방향 조합의 성질이므로 검증용으로 수치화해 둔다.
//   해석해가 지저분하므로(감쇠·포락·정류가 겹친다) 정착창을 촘촘히 훑는다. 게이트 전용 경로다.
function settlePeak(phys = SHARED_PHYS) {
  let peak = 0;
  for (let i = 1; i < 2000; i++) {
    const u = IMPACT + (1 - IMPACT) * (i / 2000);
    peak = Math.max(peak, Math.abs(tofuBob(u, 0.2, phys)));
  }
  return peak;
}

// 정규 변형량(발사 시 1 기준). 상승 구간은 상승 속도 그대로(빠를수록 늘어난다).
//   정착 구간은 **접촉 순간의 변형 VEND 에서 풀려나는 자유 감쇠 응답** — 상승이 늘려 둔 두부가
//   접촉으로 밑동이 멈추면서 저장된 변형을 놓아주는 형태다. 초기 도함수가 0 이라 상승 구간과
//   값·도함수 모두 연속(C1)이고, 진폭은 authored 상수가 아니라 접촉 속도 VEND 에서 나온다.
//   포락이 w=1 에서 0 이므로 잔여 변형 없이 정확히 항등으로 수렴한다.
//   하강 변형(descending)은 접근 중 **가속하며 늘어나고**(낙하하는 두부), 접촉 변형은 그 최대값
//   riseVelDown(1)=1 에서 풀려난다. 값은 연속이지만 도함수는 접촉에서 꺾인다(가속 프로파일의 기울기를
//   초기속도 항으로 물려받지 않으므로) — 현재 이 채널의 소비자는 없다(강체 지붕은 allowScale=false).
//   하강 부재에 스쿼시를 켜는 소비자가 생기면 여기 초기속도 항을 넣어 C1 을 복원할 것.
function tofuDeform(u, descending = false, seat = SETTLE_SEAT) {
  if (u <= 0 || u >= 1) return 0;
  const vel = descending ? riseVelDown : riseVel;
  if (u < IMPACT) return vel(u / IMPACT);
  const w = (u - IMPACT) / (1 - IMPACT);
  const osc = Math.cos(seat.w * w) + (seat.z / seat.w) * Math.sin(seat.w * w);
  return vel(1) * Math.exp(-seat.z * w) * osc * settleEnv(w);
}

// 두부 스쿼시&스트레치 배율. u(자식 진행 0..1), amp(진폭) → { sy, sxz }. 부피보존 1차 근사.
//   상승 중엔 진행방향(수직)으로 늘어나고(sy>1, sxz<1), 정착에서 되돌아오는 동안 눌린다
//   (sy<1, sxz>1) — 하나의 속도 함수가 양쪽을 다 만들므로 "이제부터 흔들림" 단절이 없다.
export function tofuScale(u, amp = 0.2, { descending = false, seat = SETTLE_SEAT } = {}) {
  if (u <= 0 || u >= 1) return { sy: 1, sxz: 1 };
  if (tofuLegacy()) {
    if (u < IMPACT) {
      const k = u / IMPACT;
      const s = amp * 0.30 * Math.sin(k * Math.PI * 0.5);
      return { sy: 1 + s, sxz: 1 - s * 0.5 };
    }
    const w = (u - IMPACT) / (1 - IMPACT);
    const decay = Math.exp(-w * 4.2);
    const osc = Math.cos(w * Math.PI * 2 * 1.6);
    return { sy: 1 - amp * decay * osc, sxz: 1 + amp * 0.55 * decay * osc };
  }
  const s = amp * stretchK() * tofuDeform(u, descending, seat);
  return { sy: 1 + s, sxz: 1 - s * 0.5 };
}

// 하위호환 별칭(구 로컬 이름). 신규 호출자는 tofuRise 를 쓴다.
const fallOffset = tofuRise;

// ── 부재 순서(ORDER) — 기하에서 유도하는 결정론 정렬 ────────────────────────────────────
// 규칙 하나로 세 가지 고증 순서를 동시에 만족한다:
//   ① 아래 켜부터 위 켜로  — 기단 장대석 켜(지대석→몸통→갑석), 횡부재 켜(기둥→중인방→창방),
//      지붕 기와(처마→용마루). 실제 시공은 늘 아래에서 위로 쌓인다.
//   ② 같은 켜 안에서는 긴 축을 따라 한 방향 훑기 — 칸(bay) 단위로 골조를 세워 나가는 순서.
//      앞·뒤 기둥은 같은 x(=같은 칸)라 한 랭크로 묶여 짝으로 선다.
// 좌표는 그룹 로컬(원 rest 포즈)에서 읽고 rng 를 쓰지 않으므로 worker/sync 해시에 영향 없다.
const QY = 0.12;     // 켜 양자화(m) — 장대석 한 켜·기와 한 켜 규모
const QS = 0.9;      // 훑기 양자화(m) — 칸(≈2.5m)은 나누고 앞뒤 짝은 묶는 폭

// 자식 서브트리의 로컬 중심(회전·스케일은 이 트리에서 항등이라 무시). THREE import 없이 순수 계산.
function accumCenter(obj, ox, oy, oz, acc) {
  const px = ox + (obj.position?.x ?? 0);
  const py = oy + (obj.position?.y ?? 0);
  const pz = oz + (obj.position?.z ?? 0);
  const geo = obj.geometry;
  if (geo) {
    if (!geo.boundingSphere) { try { geo.computeBoundingSphere(); } catch { /* 비정상 지오는 건너뜀 */ } }
    const c = geo.boundingSphere?.center;
    if (c) { acc.x += px + c.x; acc.y += py + c.y; acc.z += pz + c.z; acc.n++; }
  }
  const kids = obj.children;
  if (kids) for (const k of kids) accumCenter(k, px, py, pz, acc);
}
function localCenter(obj) {
  const acc = { x: 0, y: 0, z: 0, n: 0 };
  accumCenter(obj, 0, 0, 0, acc);
  if (!acc.n) return { x: obj.position?.x ?? 0, y: obj.position?.y ?? 0, z: obj.position?.z ?? 0 };
  return { x: acc.x / acc.n, y: acc.y / acc.n, z: acc.z / acc.n };
}
// 결정론 미세 지터용 정수 해시(FNV-1a + 확산). rng 미사용 → 시드 스트림 불침해.
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// 정렬 후 (켜, 훑기) 동일 좌표를 한 랭크로 묶어 rank 인덱스를 부여한다.
function rankOrdered(entries, sweepAxis) {
  for (const e of entries) {
    e.cy = Math.round(e.center.y / QY);
    e.cs = Math.round((sweepAxis === 'x' ? e.center.x : e.center.z) / QS);
  }
  entries.sort((a, b) => a.cy - b.cy || a.cs - b.cs || a.first - b.first);
  let rank = -1, py = null, ps = null;
  for (const e of entries) {
    if (e.cy !== py || e.cs !== ps) { rank++; py = e.cy; ps = e.cs; }
    e.rank = rank;
  }
  return rank + 1;   // 랭크 개수
}
// 긴 축 판정(같은 켜 안 훑기 방향).
function sweepAxisOf(entries) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const e of entries) {
    if (e.center.x < minX) minX = e.center.x; if (e.center.x > maxX) maxX = e.center.x;
    if (e.center.z < minZ) minZ = e.center.z; if (e.center.z > maxZ) maxZ = e.center.z;
  }
  return (maxX - minX) >= (maxZ - minZ) ? 'x' : 'z';
}

// 이웃 부재 간 최소 시간차(초). 60fps 에서 4~5 프레임 — "아주 약간의 시간차"이면서 눈에 보이는 하한.
//   종전은 이 하한이 없어 (창폭*0.4)/(부재수-1) 이 ~26ms(1.5 프레임)로 떨어져 리플이 비가시였다.
const MIN_RIPPLE_SEC = 0.075;
const SPREAD_SHARE = 0.45;   // 파트 창에서 유닛 스태거에 쓰는 비율(나머지는 유닛 애니 길이)
const JITTER_SHARE = 0.28;   // 이웃 간격 대비 결정론 지터 폭(±) — 메트로놈처럼 안 들리게
const INTRA_SHARE = 0.30;    // 청크 내부(처마→용마루) 켜 흐름이 쓰는 유닛 애니 길이 비율

export function playAssembly(building, { duration = 5, onDone, amp = 1 } = {}) {
  const L = building.userData?.layout;
  const totalH = L?.totalH ?? 12;
  // 낙하 기준 거리: 건물 높이에 비례하되 절제된 범위로 클램프.
  const dropBase = Math.min(2.2, Math.max(1.2, totalH * 0.13));

  // 애니메이션 대상 수집: 각 파트 그룹을 조립 유닛 목록으로 분해.
  //   - 지붕(name==='roof'): 그룹 자체 1유닛 강체 모션 + 자식 visible 청크/켜 스태거.
  //   - 일반 그룹: (켜, 칸) 랭크 하나 = 유닛 하나 — 같은 칸의 앞뒤 기둥처럼 한 랭크에 든 부재는
  //     동시에 서고, 랭크 간에 리플 스태거가 걸린다(순서는 ORDER 규칙, 배열 인덱스 아님).
  const groups = [];
  for (const name of PART_ORDER) {
    const grp = building.getObjectByName(name);
    if (!grp || grp.children.length === 0) continue;
    const [ws0, we] = PART_WINDOWS[name];
    let ws = ws0;
    let drop = dropBase * (PART_DROP[name] ?? 1);
    const tofu = (PART_TOFU[name] ?? 0.16) * amp;
    const rigid = name === 'roof';
    // 내려앉는 강체: 여행거리를 지붕 덩어리 높이에 비례하도록 깎고(ROOF_LIFT_OF_MASS), 깎인 비율만큼
    //   접근 시간도 줄인다. 창 **끝**은 고정이라 정착 시점(=클라이맥스)은 그대로고, 줄어드는 것은
    //   공중 구간뿐이다. 비율이 같으므로 접촉 속도는 상한 적용 전과 정확히 동일하다.
    let massY = 0;
    if (rigid && drop < 0) {
      massY = localCenter(grp).y;
      const cap = ROOF_LIFT_OF_MASS * massY;
      if (massY > 0 && Math.abs(drop) > cap) {
        const k = cap / Math.abs(drop);
        drop = -cap;
        ws = we - (we - ws0) * k;
      }
    }

    const mkItem = (child, i) => ({
      child,
      first: i,
      center: localCenter(child),
      lag: 0,
      y0: child.position.y,
      sx0: child.scale.x, sy0: child.scale.y, sz0: child.scale.z,
      // 강체 지붕만 회전(롤 정렬)을 쓰지만, 원상복구 계약은 건드릴 수 있는 모든 채널을 저장한다.
      rx0: child.rotation.x, ry0: child.rotation.y, rz0: child.rotation.z,
      vis0: child.visible,
    });
    const entries = grp.children.map(mkItem);
    const axis = sweepAxisOf(entries);

    let units, nR, visUnits = null;
    if (rigid) {
      // Roof moves as one rigid body (group transform). Child-local Y/scale stay at rest
      // so outer tile / underside / rafters keep their authored depth stack.
      units = [{
        rank: 0,
        first: 0,
        items: [mkItem(grp, 0)],
      }];
      nR = 1;
      // Visibility-only stagger: semantic chunks (rafters→body→finial) + course flow.
      if (grp.userData?.asmChunked) {
        const byKey = new Map();
        entries.forEach((it) => {
          const key = it.child.userData?.asmGroup || DEFAULT_CHUNK;
          let c = byKey.get(key);
          if (!c) {
            c = {
              key,
              seq: ROOF_SEQ[key] ?? ROOF_SEQ[DEFAULT_CHUNK],
              first: it.first,
              items: [],
            };
            byKey.set(key, c);
          }
          c.items.push(it);
        });
        visUnits = [...byKey.values()].sort((a, b) => a.seq - b.seq || a.first - b.first);
        for (const u of visUnits) {
          const nI = rankOrdered(u.items, axis);
          for (const it of u.items) it.lag = nI > 1 ? it.rank / (nI - 1) : 0;
          // Under-eave critical pieces must not course-lag independently:
          // eave→ridge lag on gaepan alone opens sky holes, and rafter lag
          // scrapes plate/창방 while the rigid roof is still rising.
          // Ornaments (마루·잡상·수키와) keep the eave→ridge flow.
          for (const it of u.items) {
            if (isUnderEaveCritical(it.child)) it.lag = 0;
          }
          u.first = u.items[0].first;
        }
        visUnits.forEach((u, i) => { u.rank = i; });
      } else {
        visUnits = [{ rank: 0, first: 0, items: entries, lag: 0 }];
        for (const it of entries) it.lag = 0;
      }
    } else {
      // 일반 그룹: 켜·칸 랭크 하나 = 유닛 하나. 같은 랭크 부재(앞뒤 기둥 짝 등)는 동시에 선다.
      nR = rankOrdered(entries, axis);
      const byRank = new Map();
      for (const it of entries) {
        let u = byRank.get(it.rank);
        if (!u) { u = { rank: it.rank, first: it.first, items: [] }; byRank.set(it.rank, u); }
        u.items.push(it);
      }
      units = [...byRank.values()].sort((a, b) => a.rank - b.rank);
    }

    // ── 리플 타이밍 ──
    //   기본 이웃 간격 = 창폭*SPREAD_SHARE/(랭크-1), 유닛 애니 길이 = 창폭 − 총 스프레드
    //   (→ 마지막 부재가 정확히 `we` 에 정착하므로 파트 순서가 다음 파트로 새지 않는다).
    //   그 간격이 지각 하한(MIN_RIPPLE_SEC)보다 좁으면 — 부재가 아주 많은 경우(마을 giwa 기둥 34본
    //   → 24 랭크) — **창을 넓히지 않고 랭크를 슬롯으로 병합**한다. 인접 칸이 두세 개씩 함께 서지만
    //   이웃 간격은 눈에 보이고, 기단→기둥→벽→지붕 순서의 가독성은 그대로다.
    //   지붕 강체: 모션 유닛은 1개. visible 청크 스태거는 별도 visUnits 창에서 깐다.
    const winDur = we - ws;
    const minItem = winDur * 0.35;
    const maxSpread = winDur - minItem;
    const minOffset = duration > 0 ? MIN_RIPPLE_SEC / duration : 0;
    let slots = nR;
    let offset = nR > 1 ? (winDur * SPREAD_SHARE) / (nR - 1) : 0;
    if (nR > 1 && offset < minOffset) {
      const maxSlots = Math.max(2, 1 + Math.floor(maxSpread / Math.max(minOffset, 1e-9)));
      slots = Math.min(nR, maxSlots);
      offset = slots > 1 ? Math.min(minOffset, maxSpread / (slots - 1)) : 0;
    }
    let itemDur = Math.max(minItem, winDur - offset * (slots - 1));
    if (ws + offset * (slots - 1) + itemDur > 1) {       // t=1 안전(원상복구 계약)
      itemDur = Math.max(winDur * 0.3, 1 - (ws + offset * (slots - 1)));
      if (slots > 1 && ws + offset * (slots - 1) + itemDur > 1) {
        offset = Math.max(0, (1 - ws - itemDur) / (slots - 1));
      }
    }
    for (const u of units) {
      u.slot = (nR > 1 && slots < nR) ? Math.round((u.rank * (slots - 1)) / (nR - 1)) : u.rank;
      const j = offset > 0 ? (hash01(`${name}:${u.slot}`) * 2 - 1) * JITTER_SHARE * offset : 0;
      u.start = Math.max(0, ws + u.slot * offset + j);
    }

    // Roof visibility stagger: spread chunk reveals across the same part window.
    let visItemDur = itemDur;
    let visOffset = 0;
    let visSlots = 1;
    let visHasLag = false;
    if (rigid && visUnits) {
      const vN = visUnits.length;
      visSlots = vN;
      visOffset = vN > 1 ? (winDur * SPREAD_SHARE) / (vN - 1) : 0;
      if (vN > 1 && visOffset < minOffset) {
        const maxSlots = Math.max(2, 1 + Math.floor(maxSpread / Math.max(minOffset, 1e-9)));
        visSlots = Math.min(vN, maxSlots);
        visOffset = visSlots > 1 ? Math.min(minOffset, maxSpread / (visSlots - 1)) : 0;
      }
      visItemDur = Math.max(minItem, winDur - visOffset * (visSlots - 1));
      if (ws + visOffset * (visSlots - 1) + visItemDur > 1) {
        visItemDur = Math.max(winDur * 0.3, 1 - (ws + visOffset * (visSlots - 1)));
        if (visSlots > 1 && ws + visOffset * (visSlots - 1) + visItemDur > 1) {
          visOffset = Math.max(0, (1 - ws - visItemDur) / (visSlots - 1));
        }
      }
      for (const u of visUnits) {
        u.slot = (vN > 1 && visSlots < vN)
          ? Math.round((u.rank * (visSlots - 1)) / (vN - 1))
          : u.rank;
        const j = visOffset > 0
          ? (hash01(`${name}:vis:${u.slot}`) * 2 - 1) * JITTER_SHARE * visOffset
          : 0;
        u.start = Math.max(0, ws + u.slot * visOffset + j);
      }
      visHasLag = visUnits.some((u) => u.items.some((it) => it.lag > 0));
    }

    const hasLag = rigid
      ? visHasLag
      : units.some((u) => u.items.some((it) => it.lag > 0));
    // 하강 부재(지붕)는 중력형 가속 프로파일 + 강체 좌대를 쓴다. 롤 축은 용마루 축(=지배축)이고
    //   기울어지는 쪽은 결정론 해시로 정한다(rng 미사용 → 시드 스트림·worker 해시 불침해).
    const descending = drop < 0;
    const phys = descending || rigid
      ? { descending, seat: rigid ? SETTLE_SEAT_RIGID : SETTLE_SEAT }
      : SHARED_PHYS;
    const rollAxis = rigid && descending ? axis : null;
    const rollSign = hash01(`${name}:roll:${entries.length}`) < 0.5 ? -1 : 1;
    groups.push({
      name, ws, we, drop, tofu, units, itemDur, offset, hasLag,
      phys, rollAxis, rollSign, massY,
      slots: rigid ? visSlots : slots,
      rigid,
      visUnits,
      visItemDur,
      visOffset,
      rawVisRanks: visUnits ? visUnits.length : units.length,
    });
  }

  let elapsed = 0;
  let done = false;

  // 한 부재에 진행도 uu 를 적용(공중 낙하 → 두부 출렁 복원). 원 transform 기준 상대.
  // allowScale=false: 지붕 강체는 스케일 항등(비등방 스쿼시가 깊이 스택을 찌그러뜨림).
  // setVisible=false: 강체 지붕 그룹은 항상 보이되, 자식 visible 은 별도 스태거가 소유.
  function applyItem(it, uu, drop, tofu, allowScale = true, setVisible = true, phys = SHARED_PHYS) {
    if (uu <= 0) {
      // 아직 순서 전 → 숨김(공중에 어색하게 떠 있지 않게).
      if (setVisible) it.child.visible = false;
      it.child.position.y = it.y0 - drop;
      it.child.scale.set(it.sx0, it.sy0, it.sz0);
    } else if (uu >= 1) {
      if (setVisible) it.child.visible = it.vis0;
      it.child.position.y = it.y0;
      it.child.scale.set(it.sx0, it.sy0, it.sz0);
    } else {
      if (setVisible) it.child.visible = it.vis0;
      // 정착 반동은 **접촉면에서 멀어지는 방향**이므로 접근 방향과 무관하게 항상 위다. drop 의 부호는
      //   접근 방향(양수=아래에서, 음수=위에서)만 결정하고, 반동 진폭은 그 크기만 쓴다.
      //   내려앉는 부재(지붕)에는 강체 좌대 제약이 하나 더 붙는다: 좌대(평방·창방 띠) **아래로는 갈 수
      //   없다**. 부호 있는 스프링의 두 번째 로브는 여행거리의 ≈2% 만큼 rest 아래로 내려가는데, 그건
      //   개판이 창방을 파고드는 프레임이고 옛 스크레이프의 축소판이다. 그래서 정류(|·|)한다 — 결과는
      //   좌대에 두 번 닿는 감쇠 바운스이고, 모멘텀에서 유도되는 성질(진폭이 접근 속도에서 나온다)은
      //   그대로다. 아래에서 올라오는 부재는 좌대가 없으므로 부호 있는 스프링을 유지한다(계약 불변).
      const bob = tofuBob(uu, tofu, phys);
      it.child.position.y = it.y0 - fallOffset(uu, phys) * drop
        + (drop < 0 ? Math.abs(bob) : bob) * Math.abs(drop);
      if (allowScale) {
        const s = tofuScale(uu, tofu, phys);
        it.child.scale.set(it.sx0 * s.sxz, it.sy0 * s.sy, it.sz0 * s.sxz);
      } else {
        it.child.scale.set(it.sx0, it.sy0, it.sz0);
      }
    }
  }

  // 인양 롤 정렬: 내려앉는 강체가 살짝 기울어 접근해 **접촉에서 정확히 수평**이 된다.
  //   포락을 tofuRise 로 쓰므로 (a) 접근 구간에만 존재하고, (b) 낙하와 같은 가속 프로파일로 펴지며,
  //   (c) u≥IMPACT 에서 정확히 0 이라 정착 이후 회전 잔여·후행 흔들림이 원리적으로 없다.
  //   회전축은 용마루 축이라 용마루 선은 수평을 유지한다(한쪽 처마만 내려간 채 접근).
  function applyRoll(g, it, uu) {
    if (!g.rollAxis) return;
    const k = uu <= 0 || uu >= 1 ? 0 : fallOffset(uu, g.phys);
    const rad = k * g.rollSign * rollDeg() * Math.PI / 180;
    if (g.rollAxis === 'x') it.child.rotation.x = it.rx0 + rad;
    else it.child.rotation.z = it.rz0 + rad;
  }

  // 진행도 t(0..1) 상태를 계산·적용. 유닛 간은 리플 스태거(u.start), 유닛 내부는 켜 흐름(it.lag).
  function applyAt(t) {
    for (const g of groups) {
      if (g.rigid) {
        // One shared rise/bob on the roof group; children keep rest local transforms.
        const u0 = g.units[0];
        const uu = clamp01((t - u0.start) / g.itemDur);
        applyItem(u0.items[0], uu, g.drop, g.tofu, /*allowScale*/ false, /*setVisible*/ false, g.phys);
        u0.items[0].child.visible = true;
        applyRoll(g, u0.items[0], uu);
        // 상량: 지붕은 위에서 내려앉으므로(PART_DROP.roof < 0) 통과할 구조가 없다. 서까래·개판·기와
        //   외피는 강체와 **함께 공중에 보이고**, 마감 부재(잡상·용마루·수키와, asmGroup='finial')는
        //   그 하강 구간에 처마→용마루 순으로 얹혀 접촉 전에 모두 자리를 잡는다. 구 모델은 상승 중
        //   스크레이프를 피하려 지붕 전체를 uu<0.85 동안 숨겼고, 그것이 "지붕이 애니메이션 없이
        //   팝인"의 원인이었다.
        //   마감 부재를 **착지 후**로 미뤘던 중간 버전도 기각됐다: 기와 외피는 tile field 라
        //   uRimTileMul=0 으로 림을 받지 않으므로(env/rim.js), 웜 림을 그리는 것은 용마루·추녀 같은
        //   마감 부재뿐이다. 그것들이 착지 후에 켜지면 클립의 히어로 순간인 **공중 지붕이 평면 검정
        //   실루엣**이 되고 플래그십 룩이 착지 뒤에 도착한다(2026-07-30 측정: 용마루 웜 최대값이
        //   공중 103 → 착지 197). 그래서 켜 흐름을 하강 구간으로 옮긴다 — 흐름도 남고 림도 남는다.
        const riseK = clamp01(uu / IMPACT);
        // Child reveal only (no per-child Y/scale).
        const postIntra = g.hasLag ? INTRA_SHARE : 0;
        const postBody = Math.max(1e-9, 1 - postIntra);
        for (const u of g.visUnits) {
          const finish = u.key === 'finial';
          for (const it of u.items) {
            let show;
            if (uu >= 1) show = true;              // rest pose — every member on
            else if (uu <= 0) show = false;        // 착공 전 — 완성본 1프레임 노출 0
            else if (!finish) show = true;         // rigid body in flight
            else show = (riseK - it.lag * postIntra) / postBody > 0;
            it.child.visible = show ? it.vis0 : false;
            it.child.position.y = it.y0;
            it.child.scale.set(it.sx0, it.sy0, it.sz0);
          }
        }
        // Tile outer + gaepan are one physical shell. Course-flow lag by height can
        // desync them for a few frames and flash coplanar depth; lock visibility.
        lockRoofShellVisibility(u0.items[0].child);
        continue;
      }
      const intra = g.hasLag ? g.itemDur * INTRA_SHARE : 0;
      const body = g.itemDur - intra;   // 켜 흐름을 뺀 실제 부재 애니 길이
      for (const u of g.units) {
        for (const it of u.items) {
          const uu = clamp01((t - u.start - it.lag * intra) / body);
          applyItem(it, uu, g.drop, g.tofu, true, true, g.phys);
        }
      }
    }
  }

  function restore() {
    const put = (it) => {
      it.child.position.y = it.y0;
      it.child.scale.set(it.sx0, it.sy0, it.sz0);
      it.child.rotation.set(it.rx0, it.ry0, it.rz0);
      it.child.visible = it.vis0;
    };
    for (const g of groups) {
      for (const u of g.units) for (const it of u.items) put(it);
      if (g.visUnits) for (const u of g.visUnits) for (const it of u.items) put(it);
    }
  }

  // 시작 상태(빈 터) 즉시 적용 — 첫 프레임부터 조립 전 상태.
  applyAt(0);

  return {
    update(dt) {
      if (done) return true;
      elapsed += dt;
      const t = elapsed / duration;
      if (t >= 1) { restore(); done = true; onDone?.(); return true; }
      applyAt(t);
      return false;
    },
    // 정지 프레임(스크린샷/검증용) — 진행도 t 를 그대로 적용, 자동 진행 안 함.
    seek(t01) { applyAt(clamp01(t01)); },
    skip() {
      if (done) return;
      restore();
      done = true;
      onDone?.();
    },
    isDone() { return done; },
    // 검증용 타이밍 계획(초 단위). 리플 이웃 간격·랭크 수·켜 흐름을 게이트가 수치로 단언한다.
    plan() {
      return groups.map((g) => {
        const motionUnits = g.units;
        const reveal = g.visUnits || g.units;
        const off = g.rigid ? g.visOffset : g.offset;
        const iDur = g.rigid ? g.visItemDur : g.itemDur;
        return {
          part: g.name,
          window: [g.ws, g.we],
          ranks: g.slots,                     // 실제 리플/등장 단계 수(랭크 병합 후)
          rawRanks: g.rigid ? g.rawVisRanks : motionUnits.length,
          members: g.rigid
            ? reveal.reduce((n, u) => n + u.items.length, 0)
            : motionUnits.reduce((n, u) => n + u.items.length, 0),
          rippleSec: +(off * duration).toFixed(4),
          itemSec: +(iDur * duration).toFixed(4),
          endSec: +((g.ws + off * (g.slots - 1) + iDur) * duration).toFixed(4),
          courseFlow: g.hasLag,
          rigid: !!g.rigid,
          // 접근 물리(게이트용). travelM 은 저작 여행 거리, contactMps 는 접촉 순간의 실제 속도이고
          //   settleM 은 모멘텀에서 유도된 정착 오버슈트 최대값 — "무게=진폭 아님, 접근 속도" 계약을
          //   순수 노드에서 수치로 단정할 수 있게 셋을 함께 낸다.
          descending: !!g.phys.descending,
          travelM: +Math.abs(g.drop).toFixed(4),
          // 지붕 덩어리가 앉는 높이(그룹 localCenter.y). 여행거리 상한·하한의 기준이자, 게이트가
          //   "공중 처마선이 자기 용마루를 넘지 않는다"를 실제 기하로 판정할 때 쓰는 참조값이다.
          massY: +g.massY.toFixed(4),
          liftOfMass: g.massY > 0 ? +(Math.abs(g.drop) / g.massY).toFixed(4) : 0,
          airborneSec: +(g.itemDur * IMPACT * duration).toFixed(4),
          contactMps: +((g.phys.descending ? CONTACT_V_DOWN : CONTACT_V)
            * Math.abs(g.drop) / (g.itemDur * duration)).toFixed(4),
          settleM: +(settlePeak(g.phys) * Math.abs(g.drop)).toFixed(4),
          rollDeg: g.rollAxis ? +rollDeg().toFixed(3) : 0,
          rollAxis: g.rollAxis,
          starts: [...new Set(reveal.map((u) => +(u.start * duration).toFixed(4)))].sort((a, b) => a - b),
        };
      });
    },
  };
}
