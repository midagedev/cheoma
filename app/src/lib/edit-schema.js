// focus-in 편집 스키마 (#48) — 코어가 지원하는 편집 축을 유형별로 선언한다. 통합 ContextPanel이
// 이 배열을 그대로 렌더하고, App 이 buildRebuildPayload 로 편집값을 어댑터 rebuildParcel 계약에 맞춰
// 라우팅한다. params.js 는 읽기 전용(코어 소유)이라, UI 메타데이터(범위·스텝·라우팅)는 여기 앱 층에 둔다.
//
// 필드 route — 편집값이 rebuildParcel(newParams) 안 어디로 가는지:
//   'building'  → newParams.building[key]         (정규 기와/초가: buildBuilding 프리셋 오버라이드)
//   'top'       → newParams[key]                  (footprintScale·wallType·roofTone·thatchAge·aux)
//   'preset'    → newParams.presetOverrides[key]  (특수 관아/객사: buildBuilding 프리셋 오버라이드)
//   'roofOpts'  → newParams.roofOpts[key]         (종가 hanok: buildHanok roofOpts + 평면형/칸수 #146)
//   'wallH'     → newParams.wallH                 (종가 hanok: 벽 높이)
//
// ctrl: 'range'(슬라이더·라이브) | 'stepper'(정수 ±) | 'segment'(택1) | 'toggle'(불).
// adv 섹션은 "고급" 접기로 숨긴다(과밀 제어). 라벨키는 i18n s_<key>/sec_<id>.

import { residentialOpeningCapabilities } from '../../../src/api/residential-openings.js';

function openingSection(kind, spec) {
  const capabilities = residentialOpeningCapabilities(kind, spec?.params || {});
  return {
    id: 'openings',
    titleKey: 'sec_openings',
    fields: [
      { key: 'doorCount', ctrl: 'stepper', ...capabilities.doorCount, def: capabilities.doorCount.default,
        route: 'building', unitKey: 'unit_count', showBounds: true },
      { key: 'windowCount', ctrl: 'stepper', ...capabilities.windowCount, def: capabilities.windowCount.default,
        route: 'building', unitKey: 'unit_count', showBounds: true },
      { key: 'doorWidthK', ctrl: 'range', ...capabilities.doorWidthK, def: capabilities.doorWidthK.default,
        route: 'building', format: 'percent', showBounds: true },
      { key: 'windowWidthK', ctrl: 'range', ...capabilities.windowWidthK, def: capabilities.windowWidthK.default,
        route: 'building', format: 'percent', showBounds: true },
      { key: 'doorPattern', ctrl: 'segment', route: 'building', options: ['ttisal', 'jeongja'] },
    ],
  };
}

// ── 정규 필지: 초가(민가) ─────────────────────────────────────────────────
const CHOGA_SECTIONS = [
  // 칸수(#146 복원) — 초가는 一자 격자라 정면·측면 칸수가 곧 규모("몇 칸짜리"). 구 단일건물 패널의 헤드라인
  //   축이었으므로 맨 위·기본 노출(구 스키마는 고급 접기에 묻혀 있었다). 코어 buildBuilding bayPositions 지원.
  { id: 'plan', titleKey: 'sec_plan', fields: [
    { key: 'frontBays', ctrl: 'stepper', min: 3, max: 5, route: 'building' },
    { key: 'sideBays', ctrl: 'stepper', min: 2, max: 3, route: 'building' },
  ] },
  { id: 'openings', titleKey: 'sec_openings', fields: [] },
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
  { id: 'plandims', titleKey: 'sec_plandims', adv: true, fields: [
    { key: 'centerBayW', ctrl: 'range', min: 2.2, max: 3.8, step: 0.05, route: 'building' },
    { key: 'endBayW', ctrl: 'range', min: 2.0, max: 3.0, step: 0.05, route: 'building' },
  ] },
  { id: 'proportion', titleKey: 'sec_proportion', adv: true, fields: [
    { key: 'columnHeight', ctrl: 'range', min: 1.8, max: 2.7, step: 0.01, route: 'building' },
    { key: 'podiumTierH', ctrl: 'range', min: 0.16, max: 0.5, step: 0.02, route: 'building' },
    { key: 'ridgeH', ctrl: 'range', min: 0.24, max: 0.4, step: 0.01, route: 'building' },
    { key: 'footprintScale', ctrl: 'range', min: 0.7, max: 1.4, step: 0.02, route: 'top' },
  ] },
  // 마당 소품(#96): 장독대·텃밭·낟가리·빨래줄 넣을지/규모. 코어 parcel.jangdok/vegBed/yardStack/clothesline
  //   (variants.assignVariation) → walls.buildVillageWall(makeYardProps). route 'top' 로 rebuildParcel
  //   newParams 최상위에 실려 필지 원본값을 오버라이드한다(미조정 축은 원본 유지 — undefined 스킵).
  { id: 'props', titleKey: 'sec_props', fields: [
    { key: 'jangdok', ctrl: 'stepper', min: 0, max: 3, route: 'top' },
    { key: 'vegBed', ctrl: 'toggle', route: 'top' },
    { key: 'yardStack', ctrl: 'toggle', route: 'top' },
    { key: 'clothesline', ctrl: 'toggle', route: 'top' },
  ] },
  { id: 'yard', titleKey: 'sec_yard', adv: true, fields: [
    { key: 'roofTone', ctrl: 'stepper', min: 0, max: 4, route: 'top' },
    { key: 'aux', ctrl: 'toggle', route: 'top' },
  ] },
];

// ── 정규 필지: 기와집(반가, 생성 시 ㅡ/ㄱ/ㄷ) ──────────────────────────────
const GIWA_SECTIONS = [
  // 규모/칸(#146) — 생성된 planShape/bays는 코어 명세에 남지만 이 이슈에서는 새 선택 UI를 열지 않는다.
  // 본채 폭·날개 길이의 기존 편집 경로만 유지하고, noteKey는 현재 마을 생성 어휘를 정확히 설명한다.
  { id: 'plan', titleKey: 'sec_plan', noteKey: 'giwa_note', fields: [
    { key: 'mainHalfW', ctrl: 'range', min: 2.8, max: 5.2, step: 0.1, route: 'building' },
    { key: 'wingLen', ctrl: 'range', min: 2.8, max: 4.6, step: 0.1, route: 'building' },
  ] },
  { id: 'openings', titleKey: 'sec_openings', fields: [] },
  { id: 'roof', titleKey: 'sec_roof', fields: [
    { key: 'riseScale', ctrl: 'range', min: 0.6, max: 1.2, step: 0.02, route: 'building' },
    { key: 'eaveOverhang', ctrl: 'range', min: 1.0, max: 2.0, step: 0.05, route: 'building' },
    { key: 'profileCurve', ctrl: 'range', min: 0, max: 0.8, step: 0.01, route: 'building' },
  ] },
  { id: 'skin', titleKey: 'sec_skin', fields: [
    { key: 'wallType', ctrl: 'segment', route: 'top', options: ['tile', 'stone', 'mud', 'brush'] },
  ] },
  { id: 'plandims', titleKey: 'sec_plandims', adv: true, fields: [
    { key: 'mainHalfD', ctrl: 'range', min: 1.8, max: 2.8, step: 0.1, route: 'building' },
    { key: 'wingW', ctrl: 'range', min: 1.8, max: 3.0, step: 0.1, route: 'building' },
  ] },
  { id: 'proportion', titleKey: 'sec_proportion', adv: true, fields: [
    { key: 'columnHeight', ctrl: 'range', min: 2.4, max: 3.6, step: 0.01, route: 'building' },
    { key: 'podiumTierH', ctrl: 'range', min: 0.3, max: 0.9, step: 0.02, route: 'building' },
    { key: 'ridgeH', ctrl: 'range', min: 0.3, max: 0.6, step: 0.01, route: 'building' },
    { key: 'footprintScale', ctrl: 'range', min: 0.7, max: 1.4, step: 0.02, route: 'top' },
  ] },
  // 마당 소품(#96): 반가(기와)는 장독대·빨래줄만(텃밭·낟가리는 민가 어휘라 제외, 정원은 마을병합 flora).
  { id: 'props', titleKey: 'sec_props', fields: [
    { key: 'jangdok', ctrl: 'stepper', min: 0, max: 3, route: 'top' },
    { key: 'clothesline', ctrl: 'toggle', route: 'top' },
  ] },
  { id: 'yard', titleKey: 'sec_yard', adv: true, fields: [
    { key: 'cornerLift', ctrl: 'range', min: 0, max: 0.9, step: 0.02, route: 'building' },
    { key: 'roofTone', ctrl: 'stepper', min: 0, max: 4, route: 'top' },
    { key: 'aux', ctrl: 'toggle', route: 'top' },
  ] },
];

// 생성된 평면에 실제로 영향을 주는 축만 보여 준다. giwa-footprint의 칸 폭 하한과 같은
// minHalfW를 쓰므로 3칸/4칸 집에서 슬라이더 초반이 움직이지 않는 dead range가 없다.
function giwaSections(spec) {
  const shape = spec?.params?.planShape || 'l';
  const requestedBays = Number.isFinite(spec?.params?.bays) ? Math.round(spec.params.bays) : 3;
  const bays = Math.max(shape === 'u' ? 4 : 3, Math.min(5, requestedBays));
  const bay = Math.max(1.8, Number.isFinite(spec?.params?.bay) ? spec.params.bay : 2.2);
  const minHalfW = Math.max(2.8, bays * bay * 0.5);
  return GIWA_SECTIONS.map((section) => {
    const source = section.id === 'openings' ? openingSection('giwa', spec) : section;
    return {
      ...source,
      fields: source.fields
        .filter((field) => shape !== 'single' || (field.key !== 'wingLen' && field.key !== 'wingW'))
        .map((field) => field.key === 'mainHalfW'
          ? { ...field, min: minHalfW, max: Math.max(field.max, minHalfW) }
          : { ...field }),
    };
  });
}

function chogaSections(spec) {
  return CHOGA_SECTIONS.map((section) => (
    section.id === 'openings' ? openingSection('choga', spec) : section
  ));
}

// ── 특수: 종가(hanok 컴파운드) — 평면형·칸수 + buildHanok roofOpts + 벽 높이 ────────────
//   평면형(#146 복원): 종가 안채는 buildHanok(임의 폴리곤 풋프린트 + straight-skeleton 지붕 + reflex
//   안뜰 개구)이라 ㅡ/ㄱ/ㄷ 평면을 코어가 온전히 지원한다. planShape·bays 를 route 'roofOpts' 로 보내면
//   adapter heroEditOpts 가 np.roofOpts 를 통째로 포워딩 → buildParcel 이 풋프린트를 그 형태·칸수로
//   생성한다(adapter/engine 무수정). def 로 기본 ㄱ자·3칸을 표시하되, 미편집 페이로드엔 실리지 않아
//   랜딩 종가 픽셀 불변. 평면형 옵션 라벨은 구 패널 어휘(홑채/ㄱ자/ㄷ자, step_*) 재사용.
const HANOK_SECTIONS = [
  { id: 'plan', titleKey: 'sec_plan', fields: [
    { key: 'planShape', ctrl: 'segment', route: 'roofOpts', def: 'l', options: ['single', 'l', 'u'] },
    { key: 'bays', ctrl: 'stepper', min: 2, max: 4, route: 'roofOpts', def: 3 },
  ] },
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

const palaceDancheongSection = {
  id: 'dancheong', titleKey: 'sec_dancheong', fields: [
    { key: 'dancheongClarity', ctrl: 'range', min: 0, max: 1, step: 0.02, route: 'preset' },
    { key: 'dancheongSplendor', ctrl: 'range', min: 0, max: 1, step: 0.02, route: 'preset' },
  ],
};

// ── 특수: 관아·객사(palace 프리셋, 다포 전각) — presetOverrides ────────────
const PALACE_SECTIONS = [
  palaceDancheongSection,
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
  palaceDancheongSection,
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

// ── 사찰 복합 가람(#12) ────────────────────────────────────────────────────
// Geometry is never mutated from Svelte. These fields become TemplePlan options
// and the runtime swaps one full compound overlay inside the reserved site.
function templeSections(spec) {
  const variant = spec?.params?.variant || 'compact';
  const propFields = [
    ...(variant === 'compact' ? [] : [
      { key: 'pagoda', ctrl: 'segment', route: 'temple', options: ['auto', 'none', 'single', 'pair'] },
    ]),
    { key: 'stoneLanterns', ctrl: 'stepper', min: 0, max: 2, route: 'temple' },
    ...(variant === 'compact' ? [] : [
      { key: 'includeBellPavilion', ctrl: 'toggle', route: 'temple' },
      { key: 'includeDanggan', ctrl: 'toggle', route: 'temple' },
    ]),
    ...(variant === 'extended'
      ? [{ key: 'includeBudo', ctrl: 'toggle', route: 'temple' }]
      : []),
  ];
  return [
    { id: 'dancheong', titleKey: 'sec_dancheong', fields: [
      { key: 'dancheongClarity', ctrl: 'range', min: 0, max: 1, step: 0.02, route: 'temple' },
      { key: 'dancheongSplendor', ctrl: 'range', min: 0, max: 1, step: 0.02, route: 'temple' },
    ] },
    { id: 'temple-plan', titleKey: 'sec_temple_plan', fields: [
      { key: 'variant', ctrl: 'segment', route: 'temple',
        options: spec?.variantOptions?.length ? spec.variantOptions : ['compact'] },
      { key: 'hallCount', ctrl: 'stepper', min: spec?.hallRange?.min || 1,
        max: spec?.hallRange?.max || 2, route: 'temple' },
      { key: 'courtScale', ctrl: 'range', min: 0.82, max: 1.18, step: 0.02, route: 'temple' },
      { key: 'axisBend', ctrl: 'range', min: -1, max: 1, step: 0.05, route: 'temple' },
    ] },
    { id: 'temple-props', titleKey: 'sec_temple_props', fields: propFields },
  ];
}

const TEMPLE_OPTION_KEYS = [
  'variant', 'hallCount', 'courtScale', 'axisBend', 'pagoda', 'stoneLanterns',
  'includeBellPavilion', 'includeDanggan', 'includeBudo',
  'dancheongClarity', 'dancheongSplendor',
];

// ── 마을 패널 파라미터(#91) ── 부감 컨텍스트 패널의 "마을 상세" 축. 코어(plan.normTuning + site.makeSite +
//   populate + variants)가 이미 소비하는 옵션을 지형/구성/어휘 그룹으로 표면화한다. 값은 App villageOpts 로
//   모여 engine.village.setOpts → 재생성(시드 유지). 무옵션(전부 기본 K=1·stream=true·auto·char01=auto)은
//   현행 정확 재현이 코어 계약 — 그래서 각 field.def 는 코어 기본과 동치(범위·클램프도 plan.js 실측 일치).
//   ctrl:
//     'range'  — 배율/비율 슬라이더. def=기본(코어 no-op 값), 커밋 시 그 숫자 그대로 setOpts.
//     'toggle' — 불. plain(stream: def true) | tri(cityWall·sijeon: 'auto'|true|false, 패널이 강제 ON/OFF).
//   tierGate/tierHint: 해당 tier 미만에서 비활성 + 비활성 사유 i18n 키.
const VILLAGE_SECTIONS = [
  { id: 'terrain', titleKey: 'vsec_terrain', fields: [
    { key: 'undAmpK', ctrl: 'range', min: 0, max: 2.2, step: 0.05, def: 1 },        // 기복(언듈레이션) 진폭
    { key: 'ridgeHK', ctrl: 'range', min: 0.5, max: 1.6, step: 0.02, def: 1 },      // 배산 능선·봉우리 높이
    { key: 'streamMeanderK', ctrl: 'range', min: 0, max: 2.5, step: 0.05, def: 1 }, // 개울 사행(굽이)
    { key: 'stream', ctrl: 'toggle', def: true },                                    // 개울 유무(off=마른 마을)
    { key: 'river', ctrl: 'toggle', def: false, tierGate: 'capital', tierHint: 'vil_river_hint' }, // 큰 물길
  ] },
  { id: 'composition', titleKey: 'vsec_composition', fields: [
    { key: 'paddyDensityK', ctrl: 'range', min: 0, max: 2, step: 0.05, def: 1 },    // 논 비율
    { key: 'treeDensityK', ctrl: 'range', min: 0, max: 2, step: 0.05, def: 1 },     // 나무 밀도
    { key: 'cityWall', ctrl: 'toggle', tri: true, def: 'auto', tierGate: 'hamlet', tierHint: 'vil_citywall_hint' }, // 성곽(auto=hanyang, 초락부터 강제 가능)
    { key: 'sijeon', ctrl: 'toggle', tri: true, def: 'auto', tierGate: 'capital', tierHint: 'vil_sijeon_hint' },    // 시전(대로 필요→capital+)
  ] },
  { id: 'vocab', titleKey: 'vsec_vocab', fields: [
    { key: 'char01', ctrl: 'range', min: 0, max: 1, step: 0.02, def: 0.5, auto: true }, // 초가↔기와 비율(미조정=규모파생)
    { key: 'diversityK', ctrl: 'range', min: 0, max: 2, step: 0.05, def: 1 },       // 집 변주 강도
  ] },
];

// 마을 스키마(부감 패널이 렌더). spec 무관 — 마을 컨텍스트 전용.
export function villageSchema() { return VILLAGE_SECTIONS; }

// App villageOpts 초기값(#91). 전부 코어 no-op 기본 → 무변경 시 현행 픽셀 불변(결정론). char01 은
//   null(=규모 파생 auto), tri-state 는 'auto'. setOpts 에 이 값들이 그대로 실려도 코어가 기본으로 해석.
export function villageDefaults() {
  return {
    undAmpK: 1, ridgeHK: 1, streamMeanderK: 1, stream: true, river: false,
    paddyDensityK: 1, treeDensityK: 1, cityWall: 'auto', sijeon: 'auto',
    char01: null, diversityK: 1,
  };
}

// spec → { family, tabs, sections }. family 로 라이브 전략(정규=드래그 라이브, 특수=놓을 때 정착)이 갈린다.
export function schemaFor(spec) {
  if (!spec) return { family: 'regular', tabs: false, sections: [] };
  if (spec.family === 'palace-compound') return { family: 'palace-compound', tabs: false, sections: PALACE_COMPOUND_SECTIONS };
  if (spec.family === 'temple') return { family: 'temple', tabs: false, sections: templeSections(spec) };
  if (spec.hero) {
    const hs = spec.heroStyle === 'hanok' ? 'hanok' : 'palace';
    return { family: 'hero', heroStyle: hs, tabs: false, sections: hs === 'hanok' ? HANOK_SECTIONS : PALACE_SECTIONS };
  }
  const kind = spec.kind === 'giwa' ? 'giwa' : 'choga';
  return { family: 'regular', kind, tabs: true, sections: kind === 'giwa' ? giwaSections(spec) : chogaSections(spec) };
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
  if (schema.family === 'temple') {
    return {
      templeOptions: Object.fromEntries(
        TEMPLE_OPTION_KEYS
          .filter((key) => params[key] !== undefined)
          .map((key) => [key, params[key]]),
      ),
    };
  }
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
