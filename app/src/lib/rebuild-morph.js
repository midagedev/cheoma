// 고쳐짓기(#26) — 같은 집을 파라미터 공간에서 라이브 몰핑하는 순수 계획/평가기.
// Three/DOM 무의존: 입력은 edit-schema(schemaFor) 스키마와 라이브 editParams 스냅샷,
// 출력은 JSON-safe 필드 창 목록이다. App 이 rAF 로 advanceRebuildMorph 를 평가해
// 기존 live-edit 스케줄러(프리뷰 → 커밋 1회) 경로에 값만 흘린다. 마을·필지 시드는
// 여기서 절대 다루지 않는다(rerollParcel 미호출 — focus-hop-reroll-split 계약 무접촉).
//
// 선정 규칙: 연속축(range) 4–7개 + 이산축(stepper/segment/toggle) 0–2개를 시드
// 결정 rng 로 뽑는다. 전부 바꾸면 산만하고 1–2개는 심심하다는 창. 지붕 그룹 축이
// 하나도 안 뽑히면 하나를 보장해 "고쳐짓기"가 실루엣부터 읽히게 한다.
// 창 구성: 지붕 형상 → 비례/평면 → 스킨·마감 순으로 그룹 창이 겹치며 열리고
// (smoothstep 이징), 이산축은 자기 창 시작에서 1회 플립한다(t=0 플립 금지 —
// 출발값 연속성 보장). 취소/재시작은 호출측이 현재 보간값을 새 current 로 다시
// plan 하면 값이 이어진다(t=0 은 from 을 그대로, 절대 양자화하지 않는다).

const GROUP_ROOF = new Set(['roof', 'roofadv']);
const GROUP_FORM = new Set(['plan', 'plandims', 'proportion', 'structure', 'podium', 'bracket', 'temple-plan']);

// 그룹별 창: [시작 비율, …] — 창 길이 0.45, 그룹 간 겹침이 몰핑을 한 호흡으로 묶는다.
const GROUP_START = [0, 0.28, 0.52];
const WINDOW_SPAN = 0.45;
const FIELD_STAGGER = 0.06;
// 이산 플립은 t=0 에 두지 않는다(경계 계약: t=0 값 == from).
const DISCRETE_MIN_START = 0.1;

// 표준 mulberry32 — 시드 결정 plan 재현(같은 시드 → 같은 plan).
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function groupOf(sectionId) {
  if (GROUP_ROOF.has(sectionId)) return 0;
  if (GROUP_FORM.has(sectionId)) return 1;
  return 2;
}

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 연속축 목표: 현재값에서 범위의 25–75% 만큼, 여유가 큰 쪽(양쪽 다 넉넉하면 rng)으로.
// step 격자에 정렬해 커밋 후 패널 표기가 어긋나지 않게 한다. from 은 건드리지 않는다.
function sampleRangeTarget(field, from, rng) {
  const { min, max } = field;
  const range = max - min;
  const at = clamp(isNum(from) ? from : (min + max) / 2, min, max);
  const roomUp = max - at;
  const roomDown = at - min;
  const need = 0.25 * range;
  let dir;
  if (roomUp >= need && roomDown >= need) dir = rng() < 0.5 ? -1 : 1;
  else dir = roomUp >= roomDown ? 1 : -1;
  const mag = (0.25 + 0.5 * rng()) * range;
  let to = clamp(at + dir * mag, min, max);
  const step = isNum(field.step) && field.step > 0 ? field.step : 0;
  if (step) to = clamp(min + Math.round((to - min) / step) * step, min, max);
  return to;
}

function sampleDiscreteTarget(field, from, rng) {
  if (field.ctrl === 'toggle') return !from;
  if (field.ctrl === 'segment') {
    const others = field.options.filter((option) => option !== from);
    return others[Math.floor(rng() * others.length)];
  }
  // stepper: 정수 격자에서 현재값이 아닌 값 하나.
  const lo = Math.ceil(field.min);
  const hi = Math.floor(field.max);
  const at = clamp(Math.round(isNum(from) ? from : lo), lo, hi);
  const others = [];
  for (let v = lo; v <= hi; v++) if (v !== at) others.push(v);
  if (!others.length) return null;
  return others[Math.floor(rng() * others.length)];
}

/**
 * @param {object} args
 * @param {{ sections: Array<{ id: string, fields: Array<object> }> }} args.schema  schemaFor(spec) 결과
 * @param {object} args.current  라이브 editParams 스냅샷 (getState().spec 은 기본값이라 함정 — 반드시 라이브 값)
 * @param {number} args.seed     plan 고정 시드 (호출측이 1회 뽑아 고정)
 * @param {number} [args.duration=2800]  ms
 * @param {string[]} [args.excludeKeys]  커밋 전용 의미축(예: temple variant) 제외
 * @returns {{ duration: number, seed: number, fields: Array<{ key, kind, from, to, t0, t1 }> }}
 */
export function planRebuildMorph({ schema, current = {}, seed = 1, duration = 2800, excludeKeys = [] } = {}) {
  const excluded = new Set(excludeKeys);
  const rng = mulberry32(seed);
  const dur = isNum(duration) && duration > 0 ? duration : 2800;

  const rangePool = [];
  const discretePool = [];
  for (const section of schema?.sections || []) {
    for (const field of section.fields || []) {
      if (!field?.key || excluded.has(field.key)) continue;
      const entry = { field, group: groupOf(section.id) };
      if (field.ctrl === 'range') {
        if (isNum(field.min) && isNum(field.max) && field.max > field.min) rangePool.push(entry);
      } else if (field.ctrl === 'stepper') {
        if (isNum(field.min) && isNum(field.max) && Math.floor(field.max) > Math.ceil(field.min)) discretePool.push(entry);
      } else if (field.ctrl === 'segment') {
        if (Array.isArray(field.options) && field.options.length > 1) discretePool.push(entry);
      } else if (field.ctrl === 'toggle') {
        // 토글은 현재값을 모르면(미편집 undefined = 코어 원본 유지) 뒤집기가 의미
        // 불명이라 라이브 불리언일 때만 후보다.
        if (typeof current[field.key] === 'boolean') discretePool.push(entry);
      }
    }
  }

  // 연속 4–7 + 이산 0–2 (후보 수로 클램프).
  const contCount = Math.min(rangePool.length, 4 + Math.floor(rng() * 4));
  const discCount = Math.min(discretePool.length, Math.floor(rng() * 3));
  let picked = shuffle(rangePool, rng).slice(0, contCount);
  // 지붕 축 보장: 실루엣이 안 바뀌는 "고쳐짓기"는 읽히지 않는다.
  if (contCount > 0 && !picked.some((e) => e.group === 0)) {
    const roof = rangePool.filter((e) => e.group === 0);
    if (roof.length) picked[picked.length - 1] = roof[Math.floor(rng() * roof.length)];
  }
  const pickedDiscrete = shuffle(discretePool, rng).slice(0, discCount);

  const fields = [];
  const groupIndex = [0, 0, 0];
  const place = (entry, kind, from, to) => {
    const g = entry.group;
    let t0f = GROUP_START[g] + groupIndex[g] * FIELD_STAGGER;
    groupIndex[g] += 1;
    if (kind === 'discrete') t0f = Math.max(t0f, DISCRETE_MIN_START);
    t0f = Math.min(t0f, 1 - WINDOW_SPAN);
    const t1f = Math.min(1, t0f + WINDOW_SPAN);
    fields.push({
      key: entry.field.key,
      kind,
      from,
      to,
      t0: t0f * dur,
      t1: t1f * dur,
    });
  };

  for (const entry of picked) {
    const { field } = entry;
    const from = isNum(current[field.key])
      ? current[field.key]
      : (isNum(field.def) ? field.def : (field.min + field.max) / 2);
    const to = sampleRangeTarget(field, from, rng);
    if (to === from) continue;
    place(entry, 'range', from, to);
  }
  for (const entry of pickedDiscrete) {
    const { field } = entry;
    let from = current[field.key];
    if (field.ctrl === 'stepper') from = isNum(from) ? from : (isNum(field.def) ? field.def : Math.ceil(field.min));
    else if (field.ctrl === 'segment') {
      if (!field.options.includes(from)) from = field.options.includes(field.def) ? field.def : field.options[0];
    }
    const to = sampleDiscreteTarget(field, from, rng);
    if (to == null || to === from) continue;
    place(entry, 'discrete', from, to);
  }

  fields.sort((a, b) => a.t0 - b.t0 || (a.key < b.key ? -1 : 1));
  return { duration: dur, seed, fields };
}

/**
 * 순수 평가기 — t(ms, plan 시작 기준)에서의 값과 완료 여부.
 * t=0 은 from 을 그대로(양자화·클램프 없음 — 재시작 연속성), t>=duration 은 to 를 그대로.
 */
export function advanceRebuildMorph(plan, t) {
  const time = isNum(t) ? t : 0;
  const values = {};
  for (const f of plan.fields) {
    if (f.kind === 'discrete') {
      values[f.key] = time >= f.t0 ? f.to : f.from;
      continue;
    }
    const x = clamp((time - f.t0) / (f.t1 - f.t0), 0, 1);
    // 경계는 정확값으로 — a+(b-a)*1 은 FP 에서 b 와 다를 수 있다(커밋 값 어긋남 방지).
    if (x <= 0) { values[f.key] = f.from; continue; }
    if (x >= 1) { values[f.key] = f.to; continue; }
    const s = x * x * (3 - 2 * x);            // smoothstep — 단조, 무반동
    values[f.key] = f.from + (f.to - f.from) * s;
  }
  return { values, done: time >= plan.duration };
}
