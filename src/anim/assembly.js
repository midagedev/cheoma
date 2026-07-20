// 조립(시공) 애니메이션 — 프레임워크 무관 ES 모듈.
//   playAssembly(building, { duration=5, onDone, amp=1 }) →
//     { update(dt) → done:boolean, skip(), seek(t01), isDone() }
//
// 파라메트릭 모델이 "지어지는" 순간을 보여준다. 시공 순서대로 파트가 스태거되며,
// 각 파트는 제자리 아래에서 떠올라 안착한다. 안착 순간 **두부 물리**(스쿼시&스트레치 +
// 탄성 오버슛)로 눌렸다 튀어오르며 1~2회 출렁 복원한다 — 수묵 산수(정적) 위에 통통한
// 두부 물리의 대비가 이 앱의 시그니처 감성. 이 이징 언어는 조립·칸 확장·머지가 공유한다
// (아래 tofuScale/tofuBob export 를 확장/머지 모듈이 그대로 재사용).
//
// 시맨틱 조립 그룹: 지붕처럼 소부속(초가 집줄 그물·용마름, 기와 마루·잡상 등)이 많은
// 파트는 부재를 개별로 띄우면 "혼자 둥실" 떠 애매하다. 빌더가 지붕 그룹에
// userData.asmChunked=true 를 달면, 이 모듈은 그 그룹의 자식을 userData.asmGroup 태그로
// 묶어 **덩어리(청크) 단위**로 재생한다(청크 내부는 동시 등장, 청크 간 짧은 스태거).
// 태그 없는 자식은 'body' 청크로 합류 → 지붕 통덩어리. 지붕 청크 순서: 서까래→통덩어리→
// 잡상 미니팝(ROOF_SEQ). asmChunked 가 없는 그룹(정자·돌다리 등 조연)은 현행 부재별
// 스태거 그대로 — 하위호환.
//
// 원상복구 보장: position.y·scale·visible 만 건드리고, 종료·중단·seek 시 원값으로 정확히
// 복원한다. 시작 시 각 자식의 원 transform 을 저장하므로 regenerate 와 경합해도 skip()으로
// 안전히 되돌린다. (기존 ?assemble=1 데모 셸 seek/skip 경로 호환 유지.)

const PART_ORDER = ['podium', 'columns', 'walls', 'brackets', 'roof'];

// 파트별 타임라인 윈도(전체 duration 대비 비율). 시공 순서 스태거, 살짝 겹쳐 흐름을 만든다.
const PART_WINDOWS = {
  podium:   [0.00, 0.26],
  columns:  [0.18, 0.48],
  walls:    [0.42, 0.64],
  brackets: [0.58, 0.82],
  roof:     [0.74, 1.00],
};

// 파트별 낙하 거리 배수(묵직함 차등 — 기단은 작게, 지붕은 크게 떠오른다).
const PART_DROP = { podium: 0.7, columns: 1.0, walls: 0.9, brackets: 0.85, roof: 1.15 };

// 파트별 두부 탄성 진폭(스쿼시&스트레치 강도). 기둥은 스프링처럼 튀고, 지붕은 크게 출렁.
const PART_TOFU = { podium: 0.13, columns: 0.28, walls: 0.17, brackets: 0.20, roof: 0.32 };

// 지붕 시맨틱 청크 순서(작을수록 먼저). 태그 없는 부재의 기본 청크는 'body'.
//  rafters(서까래) → body(기와/이엉 통덩어리) → finial(잡상 등 미니팝).
const ROOF_SEQ = { rafters: 0, body: 1, finial: 2 };
const DEFAULT_CHUNK = 'body';

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// 착지 시점(자식 로컬 진행도 u 기준). u<IMPACT 는 공중 낙하, 이후는 두부 출렁 복원.
const IMPACT = 0.5;

// 상승 속도 → 스케일 연속 결합(#126 사용자 피드백 2차). 최초의 "띠용"은 착지 후 **별도 반동 단계**
//   (구: cos 1.6사이클 감쇠 진동 / 1차 수정: 단일 팔로스루)에서 왔다. 사용자 지시: 반동 단계 자체를
//   없애고, 부재가 떠오르는 **속도를 그대로 스케일에 연속으로 실어** 이징한다 — 빠를수록 진행방향으로
//   늘어나고, 감속해 멈추는 순간 정확히 원상(1)으로 수렴한다. 오버슈트·2차 재도약 0(단조).
//   상승은 easeOutCubic 이라 IMPACT 에서 속도 0 으로 안착하므로(assembly·wave·engine compound 3경로
//   공유), 그 속도의 정규화 형상 v=(1-u/IMPACT)² 이 스트레치를 구동한다(u≥IMPACT → v=0 → 스케일=1,
//   position 도 동시 정지 → C1 연속). TOFU_STRETCH: 속도→스케일 결합 게인(1=또렷한 스쿼시&스트레치,
//   0=변형 없이 순수 상승). window.__tofuStretch(런타임 튜닝)·window.__tofuLegacy(구 반동 A/B) 오버라이드.
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

// 두부 스쿼시&스트레치 배율. u(자식 진행 0..1), amp(진폭) → { sy, sxz }.
//   신 모델(속도 결합): 상승 중(u<IMPACT)만 상승 속도 v=(1-u/IMPACT)² 에 비례해 진행방향(수직)으로
//   늘어나고(sy>1, 부피보존 sxz<1), IMPACT 에서 v→0 이라 스케일이 1 로 연속 수렴. u≥IMPACT 는 정확히 1
//   (정착 완료 — 반동/재도약 없음). 구 모델(legacy): 착지 후 cos 1.6사이클 감쇠 진동(A/B 비교용).
export function tofuScale(u, amp = 0.2) {
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
  if (u >= IMPACT) return { sy: 1, sxz: 1 };     // 상승 종료·안착 — 스케일 정확히 원상(무반동)
  const v = (1 - u / IMPACT) ** 2;               // 상승 속도 정규화(1→0): easeOutCubic 위치의 도함수 형상
  const s = amp * stretchK() * v;                // 속도 결합 스트레치(빠를수록↑, 멈추며 0 으로 연속 수렴)
  return { sy: 1 + s, sxz: 1 - s * 0.5 };
}

// 위치 보정 계수(caller 가 position.y 에 가산). 신 모델은 상승 자체가 연속 이징이라 별도 수직 반동을
//   두지 않는다 → 0(무까딱, 재도약 없음). legacy 만 구 다중 sin 까딱 유지(A/B 비교용).
export function tofuBob(u, amp = 0.2) {
  if (u < IMPACT || u >= 1) return 0;
  if (tofuLegacy()) { const w = (u - IMPACT) / (1 - IMPACT); return amp * Math.exp(-w * 4.5) * Math.sin(w * Math.PI * 2 * 1.6); }
  return 0;
}

// 낙하 오프셋 계수(1→0): 착지(IMPACT)까지 감속하며 내려앉고, 이후 0.
function fallOffset(u) {
  if (u >= IMPACT) return 0;
  return 1 - easeOutCubic(u / IMPACT);
}

export function playAssembly(building, { duration = 5, onDone, amp = 1 } = {}) {
  const L = building.userData?.layout;
  const totalH = L?.totalH ?? 12;
  // 낙하 기준 거리: 건물 높이에 비례하되 절제된 범위로 클램프.
  const dropBase = Math.min(2.2, Math.max(1.2, totalH * 0.13));

  // 애니메이션 대상 수집: 각 파트 그룹을 조립 유닛(청크) 목록으로 분해.
  //   - asmChunked 그룹(지붕): 자식을 asmGroup 태그로 묶어 청크 단위 유닛. 태그 없으면 'body'.
  //   - 일반 그룹: 자식 하나 = 유닛 하나(현행 부재별 스태거 그대로).
  // 각 유닛은 여러 부재를 동시(같은 u)로 재생하고, 유닛 간에 짧게 스태거된다.
  const groups = [];
  for (const name of PART_ORDER) {
    const grp = building.getObjectByName(name);
    if (!grp || grp.children.length === 0) continue;
    const [ws, we] = PART_WINDOWS[name];
    const drop = dropBase * (PART_DROP[name] ?? 1);
    const tofu = (PART_TOFU[name] ?? 0.16) * amp;

    const mkItem = (child) => ({
      child,
      y0: child.position.y,
      sx0: child.scale.x, sy0: child.scale.y, sz0: child.scale.z,
      vis0: child.visible,
    });

    let units;
    if (grp.userData?.asmChunked) {
      // 태그 기준 청크 클러스터링. 등장 순서는 ROOF_SEQ, 동순위는 첫 등장 순.
      const byKey = new Map();
      grp.children.forEach((child, i) => {
        const key = child.userData?.asmGroup || DEFAULT_CHUNK;
        let c = byKey.get(key);
        if (!c) { c = { key, seq: ROOF_SEQ[key] ?? ROOF_SEQ[DEFAULT_CHUNK], first: i, items: [] }; byKey.set(key, c); }
        c.items.push(mkItem(child));
      });
      units = [...byKey.values()].sort((a, b) => a.seq - b.seq || a.first - b.first);
    } else {
      units = grp.children.map((child) => ({ items: [mkItem(child)] }));
    }

    const nU = units.length;
    units.forEach((u, i) => { u.subStart = nU > 1 ? i / (nU - 1) : 0; });
    groups.push({ ws, we, drop, tofu, units });
  }

  let elapsed = 0;
  let done = false;

  // 한 부재에 진행도 uu 를 적용(공중 낙하 → 두부 출렁 복원). 원 transform 기준 상대.
  function applyItem(it, uu, drop, tofu) {
    if (uu <= 0) {
      // 아직 순서 전 → 숨김(공중에 어색하게 떠 있지 않게).
      it.child.visible = false;
      it.child.position.y = it.y0 - drop;
      it.child.scale.set(it.sx0, it.sy0, it.sz0);
    } else if (uu >= 1) {
      it.child.visible = it.vis0;
      it.child.position.y = it.y0;
      it.child.scale.set(it.sx0, it.sy0, it.sz0);
    } else {
      it.child.visible = it.vis0;
      it.child.position.y = it.y0 - fallOffset(uu) * drop + tofuBob(uu, tofu) * drop * 0.6;
      const s = tofuScale(uu, tofu);
      it.child.scale.set(it.sx0 * s.sxz, it.sy0 * s.sy, it.sz0 * s.sxz);
    }
  }

  // 진행도 t(0..1) 상태를 계산·적용. 유닛 내부 부재는 같은 uu(동시), 유닛 간 스태거.
  function applyAt(t) {
    for (const g of groups) {
      const winDur = g.we - g.ws;
      const itemDur = winDur * 0.6;    // 각 유닛 애니 길이
      const spread = winDur - itemDur; // 시작시각 분포 폭(유닛 스태거)
      for (const u of g.units) {
        const start = g.ws + u.subStart * spread;
        const uu = clamp01((t - start) / itemDur);
        for (const it of u.items) applyItem(it, uu, g.drop, g.tofu);
      }
    }
  }

  function restore() {
    for (const g of groups) for (const u of g.units) for (const it of u.items) {
      it.child.position.y = it.y0;
      it.child.scale.set(it.sx0, it.sy0, it.sz0);
      it.child.visible = it.vis0;
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
  };
}
