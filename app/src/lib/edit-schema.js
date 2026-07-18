// focus-in 편집 스키마 (#48) — 코어가 지원하는 편집 축을 유형별로 선언한다. 패널(VillageEditPanel)이
// 이 배열을 그대로 렌더하고, App 이 buildRebuildPayload 로 편집값을 어댑터 rebuildParcel 계약에 맞춰
// 라우팅한다. params.js 는 읽기 전용(코어 소유)이라, UI 메타데이터(범위·스텝·라우팅)는 여기 앱 층에 둔다.
//
// 필드 route — 편집값이 rebuildParcel(newParams) 안 어디로 가는지:
//   'building'  → newParams.building[key]         (정규 기와/초가: buildBuilding 프리셋 오버라이드)
//   'top'       → newParams[key]                  (footprintScale·wallType·roofTone·thatchAge·aux)
//   'preset'    → newParams.presetOverrides[key]  (특수 관아/객사: buildBuilding 프리셋 오버라이드)
//   'roofOpts'  → newParams.roofOpts[key]         (종가 hanok: buildHanok roofOpts)
//   'wallH'     → newParams.wallH                 (종가 hanok: 벽 높이)
//
// ctrl: 'range'(슬라이더·라이브) | 'stepper'(정수 ±) | 'segment'(택1) | 'toggle'(불).
// adv 섹션은 "고급" 접기로 숨긴다(과밀 제어). 라벨키는 i18n s_<key>/sec_<id>.

// ── 정규 필지: 초가(민가) ─────────────────────────────────────────────────
const CHOGA_SECTIONS = [
  { id: 'roof', titleKey: 'sec_roof', fields: [
    { key: 'roofPitch', ctrl: 'range', min: 0.5, max: 0.78, step: 0.01, route: 'building' },
    { key: 'eaveOverhang', ctrl: 'range', min: 0.8, max: 1.8, step: 0.05, route: 'building' },
    { key: 'profileCurve', ctrl: 'range', min: 0, max: 0.6, step: 0.01, route: 'building' },
  ] },
  { id: 'skin', titleKey: 'sec_skin', fields: [
    { key: 'thatchAge', ctrl: 'range', min: 0, max: 1, step: 0.02, route: 'top' },
    { key: 'wallType', ctrl: 'segment', route: 'top',
      options: ['stone', 'mud', 'brush', 'hedge', 'open'] },
  ] },
  { id: 'plan', titleKey: 'sec_plan', adv: true, fields: [
    { key: 'frontBays', ctrl: 'stepper', min: 3, max: 5, route: 'building' },
    { key: 'sideBays', ctrl: 'stepper', min: 2, max: 3, route: 'building' },
    { key: 'centerBayW', ctrl: 'range', min: 2.2, max: 3.8, step: 0.05, route: 'building' },
    { key: 'endBayW', ctrl: 'range', min: 2.0, max: 3.0, step: 0.05, route: 'building' },
  ] },
  { id: 'proportion', titleKey: 'sec_proportion', adv: true, fields: [
    { key: 'columnHeight', ctrl: 'range', min: 1.8, max: 2.7, step: 0.02, route: 'building' },
    { key: 'podiumTierH', ctrl: 'range', min: 0.16, max: 0.5, step: 0.02, route: 'building' },
    { key: 'ridgeH', ctrl: 'range', min: 0.24, max: 0.4, step: 0.01, route: 'building' },
    { key: 'footprintScale', ctrl: 'range', min: 0.7, max: 1.4, step: 0.02, route: 'top' },
  ] },
  { id: 'yard', titleKey: 'sec_yard', adv: true, fields: [
    { key: 'winBack', ctrl: 'stepper', min: 0, max: 2, route: 'building' },
    { key: 'roofTone', ctrl: 'stepper', min: 0, max: 4, route: 'top' },
    { key: 'aux', ctrl: 'toggle', route: 'top' },
  ] },
];

// ── 정규 필지: 기와집(반가, ㄱ자) ─────────────────────────────────────────
const GIWA_SECTIONS = [
  { id: 'roof', titleKey: 'sec_roof', fields: [
    { key: 'riseScale', ctrl: 'range', min: 0.6, max: 1.2, step: 0.02, route: 'building' },
    { key: 'eaveOverhang', ctrl: 'range', min: 1.0, max: 2.0, step: 0.05, route: 'building' },
    { key: 'profileCurve', ctrl: 'range', min: 0, max: 0.8, step: 0.01, route: 'building' },
  ] },
  { id: 'skin', titleKey: 'sec_skin', fields: [
    { key: 'doorPattern', ctrl: 'segment', route: 'building', options: ['ttisal', 'jeongja'] },
    { key: 'wallType', ctrl: 'segment', route: 'top', options: ['tile', 'stone', 'mud', 'brush'] },
  ] },
  { id: 'plan', titleKey: 'sec_plan', adv: true, fields: [
    { key: 'mainHalfW', ctrl: 'range', min: 2.8, max: 5.2, step: 0.1, route: 'building' },
    { key: 'mainHalfD', ctrl: 'range', min: 1.8, max: 2.8, step: 0.1, route: 'building' },
    { key: 'wingLen', ctrl: 'range', min: 2.8, max: 4.6, step: 0.1, route: 'building' },
    { key: 'wingW', ctrl: 'range', min: 1.8, max: 3.0, step: 0.1, route: 'building' },
  ] },
  { id: 'proportion', titleKey: 'sec_proportion', adv: true, fields: [
    { key: 'columnHeight', ctrl: 'range', min: 2.4, max: 3.6, step: 0.02, route: 'building' },
    { key: 'podiumTierH', ctrl: 'range', min: 0.3, max: 0.9, step: 0.02, route: 'building' },
    { key: 'ridgeH', ctrl: 'range', min: 0.3, max: 0.6, step: 0.01, route: 'building' },
    { key: 'footprintScale', ctrl: 'range', min: 0.7, max: 1.4, step: 0.02, route: 'top' },
  ] },
  { id: 'yard', titleKey: 'sec_yard', adv: true, fields: [
    { key: 'cornerLift', ctrl: 'range', min: 0, max: 0.9, step: 0.02, route: 'building' },
    { key: 'roofTone', ctrl: 'stepper', min: 0, max: 4, route: 'top' },
    { key: 'aux', ctrl: 'toggle', route: 'top' },
  ] },
];

// ── 특수: 종가(hanok 컴파운드) — buildHanok roofOpts + 벽 높이 ────────────
const HANOK_SECTIONS = [
  { id: 'roof', titleKey: 'sec_roof', fields: [
    { key: 'riseScale', ctrl: 'range', min: 0.9, max: 1.8, step: 0.02, route: 'roofOpts' },
    { key: 'eaveOverhang', ctrl: 'range', min: 0.8, max: 1.8, step: 0.05, route: 'roofOpts' },
    { key: 'profileCurve', ctrl: 'range', min: 0, max: 0.8, step: 0.01, route: 'roofOpts' },
  ] },
  { id: 'structure', titleKey: 'sec_structure', fields: [
    { key: 'wallH', ctrl: 'range', min: 2.2, max: 3.4, step: 0.05, route: 'wallH' },
  ] },
  { id: 'roofadv', titleKey: 'sec_roof', adv: true, fields: [
    { key: 'cornerLift', ctrl: 'range', min: 0, max: 0.9, step: 0.02, route: 'roofOpts' },
    { key: 'ridgeH', ctrl: 'range', min: 0.3, max: 0.6, step: 0.01, route: 'roofOpts' },
  ] },
];

// ── 특수: 관아·객사(palace 프리셋, 다포 전각) — presetOverrides ────────────
const PALACE_SECTIONS = [
  { id: 'roof', titleKey: 'sec_roof', fields: [
    { key: 'roofPitch', ctrl: 'range', min: 0.6, max: 1.0, step: 0.02, route: 'preset' },
    { key: 'eaveOverhang', ctrl: 'range', min: 1.2, max: 2.2, step: 0.05, route: 'preset' },
    { key: 'profileCurve', ctrl: 'range', min: 0, max: 0.9, step: 0.01, route: 'preset' },
  ] },
  { id: 'bracket', titleKey: 'sec_bracket', fields: [
    { key: 'bracketTiers', ctrl: 'stepper', min: 1, max: 3, route: 'preset' },
    { key: 'bracketScale', ctrl: 'range', min: 0.8, max: 1.4, step: 0.02, route: 'preset' },
  ] },
  { id: 'plan', titleKey: 'sec_plan', adv: true, fields: [
    { key: 'frontBays', ctrl: 'stepper', min: 3, max: 7, route: 'preset' },
    { key: 'sideBays', ctrl: 'stepper', min: 2, max: 4, route: 'preset' },
    { key: 'columnHeight', ctrl: 'range', min: 3.4, max: 4.6, step: 0.05, route: 'preset' },
  ] },
  { id: 'podium', titleKey: 'sec_podium', adv: true, fields: [
    { key: 'podiumTiers', ctrl: 'stepper', min: 1, max: 3, route: 'preset' },
    { key: 'podiumTierH', ctrl: 'range', min: 0.5, max: 1.2, step: 0.02, route: 'preset' },
    { key: 'podiumRailing', ctrl: 'toggle', route: 'preset' },
  ] },
  { id: 'roofadv', titleKey: 'sec_roof', adv: true, fields: [
    { key: 'cornerLift', ctrl: 'range', min: 0.2, max: 1.2, step: 0.02, route: 'preset' },
    { key: 'ridgeH', ctrl: 'range', min: 0.4, max: 0.8, step: 0.02, route: 'preset' },
    { key: 'interBrackets', ctrl: 'stepper', min: 0, max: 3, route: 'preset' },
  ] },
];

// ── 특수: 궁궐 다일곽 컴파운드(#93, features.palace) — presetOverrides 로 전 전각 일괄 적용 ──────
//   #88 다일곽 궁을 focus·편집 승격. 축은 전 전각에 일관 적용해도 문법이 안 깨지는 것만(공포·지붕·처마).
//   칸수·월대단수 등 일곽 구조 종속 축은 배제(정전 2중월대 등 역할별 규약을 평탄화하면 고증 붕괴).
//   route 'preset' → buildRebuildPayload 가 presetOverrides 로 묶어 adapter.rebuildParcel('palace', ...) 로.
const PALACE_COMPOUND_SECTIONS = [
  { id: 'roof', titleKey: 'sec_roof', fields: [
    { key: 'roofPitch', ctrl: 'range', min: 0.6, max: 1.0, step: 0.02, route: 'preset' },
    { key: 'eaveOverhang', ctrl: 'range', min: 1.2, max: 2.2, step: 0.05, route: 'preset' },
    { key: 'profileCurve', ctrl: 'range', min: 0, max: 0.9, step: 0.01, route: 'preset' },
  ] },
  { id: 'bracket', titleKey: 'sec_bracket', fields: [
    { key: 'bracketTiers', ctrl: 'stepper', min: 1, max: 3, route: 'preset' },
    { key: 'bracketScale', ctrl: 'range', min: 0.8, max: 1.4, step: 0.02, route: 'preset' },
  ] },
  { id: 'roofadv', titleKey: 'sec_roof', adv: true, fields: [
    { key: 'cornerLift', ctrl: 'range', min: 0.2, max: 1.2, step: 0.02, route: 'preset' },
    { key: 'interBrackets', ctrl: 'stepper', min: 0, max: 3, route: 'preset' },
  ] },
];

// spec → { family, tabs, sections }. family 로 라이브 전략(정규=드래그 라이브, 특수=놓을 때 정착)이 갈린다.
export function schemaFor(spec) {
  if (!spec) return { family: 'regular', tabs: false, sections: [] };
  if (spec.family === 'palace-compound') return { family: 'palace-compound', tabs: false, sections: PALACE_COMPOUND_SECTIONS };
  if (spec.hero) {
    const hs = spec.heroStyle === 'hanok' ? 'hanok' : 'palace';
    return { family: 'hero', heroStyle: hs, tabs: false, sections: hs === 'hanok' ? HANOK_SECTIONS : PALACE_SECTIONS };
  }
  const kind = spec.kind === 'giwa' ? 'giwa' : 'choga';
  return { family: 'regular', kind, tabs: true, sections: kind === 'giwa' ? GIWA_SECTIONS : CHOGA_SECTIONS };
}

// 모든 필드를 평탄화(스키마 순회 없이 라우팅에 필요). 유효값만(정의됨) 담아 undefined 오염을 막는다.
function allFields(schema) {
  const out = [];
  for (const s of schema.sections) for (const f of s.fields) out.push(f);
  return out;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 편집값(params) → 어댑터 rebuildParcel(newParams) 페이로드. route 별로 분배하고 undefined 는 건너뛴다
//   (유형 전환 등으로 비어 있는 축은 코어 프리셋 기본값을 쓰게). 정규만 kind 포함.
export function buildRebuildPayload(spec, params) {
  const schema = schemaFor(spec);
  const payload = {};
  const building = {}, top = {}, preset = {}, roofOpts = {};
  let wallH;
  for (const f of allFields(schema)) {
    const v = params[f.key];
    if (f.ctrl === 'range' || f.ctrl === 'stepper') { if (!isNum(v)) continue; }
    else if (v == null) continue;                       // segment/toggle
    switch (f.route) {
      case 'building': building[f.key] = v; break;
      case 'top': top[f.key] = v; break;
      case 'preset': preset[f.key] = v; break;
      case 'roofOpts': roofOpts[f.key] = v; break;
      case 'wallH': wallH = v; break;
    }
  }
  if (schema.family === 'regular') {
    payload.kind = params.kind;
    payload.building = building;
    Object.assign(payload, top);
  } else if (schema.heroStyle === 'hanok') {
    payload.roofOpts = roofOpts;
    if (wallH != null) payload.wallH = wallH;
  } else {
    payload.presetOverrides = preset;
  }
  return payload;
}
