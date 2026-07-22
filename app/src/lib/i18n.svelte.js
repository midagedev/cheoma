// 경량 i18n — 브라우저 로케일 기반 en/ko 자동 전환. 무거운 라이브러리 없이 딕셔너리 +
// Svelte 5 $state. 판정 우선순위: ?lang= > localStorage > navigator.language(ko* → ko, 그 외 en).
// 브랜드 요소(cheoma 로고타입, 한글 '처마' 낙관)는 로케일 불변 → 딕셔너리에 없음.
//
// 건축 용어는 영어에서 로마자(이탤릭) + 짧은 영문 병기(반가→giwa "tiled" 등).

const DICT = {
  ko: {
    hero_enter: '눌러 들어가기',
    act_rebuild: '다시 짓기', act_rebuild_tip: '다시 짓기 (새 씨앗)',
    act_replay: '다시 보기', act_replay_tip: '종가 다시 짓는 장면 보기',
    act_postcard: '사진 찍기', act_postcard_tip: '낙관을 더해 사진으로 저장·공유',
    act_sound_on_tip: '소리 끄기', act_sound_off_tip: '소리 켜기',
    // 시네마틱 데모 모드(#112)
    act_drone: '드론', act_drone_tip: '드론 시네마틱 — 자동 항공 투어',
    act_walk: '거닐기', act_walk_tip: '1인칭 골목 산책',
    cine_exit: '종료', cine_exit_tip: '시네마틱 종료 (ESC)',
    cine_hint: '탭 또는 ESC로 종료',
    cine_pass_crane: '진입', cine_pass_orbit: '선회', cine_pass_fly: '골목 비행', cine_pass_pull: '전경',
    cine_walk_label: '골목 산책',
    // glb 내보내기(#112)
    act_glb: '내보내기', glb_house_tip: '이 건물을 3D 모델로 내보내기 (.glb)',
    glb_village: '마을 내보내기', glb_village_tip: '마을 전체를 3D 모델로 내보내기 (.glb)',
    glb_exporting: '내보내는 중…',
    glb_done: '3D 모델을 저장했습니다',
    glb_toobig: '마을이 너무 큽니다 — 규모를 줄이거나 한 채만 내보내세요.',
    glb_error: '내보내기에 실패했습니다.',
    panel_title: '집 짓기',
    sec_type: '유형', sec_expand: '칸 들이기', sec_finish: '매무새',
    type_korea_l: '궁', type_korea_s: '전각',
    type_temple_l: '절', type_temple_s: '불전',
    type_giwa_l: '기와집', type_giwa_s: '반가',
    type_choga_l: '초가', type_choga_s: '민가',
    step_single: '홑채', step_l: 'ㄱ자', step_u: 'ㄷ자',
    merge: '이웃과 합치기',
    giwa_note: '기와집(반가)은 ㄱ자 기본형입니다.',
    s_roofPitch: '지붕 물매', s_riseScale: '지붕 물매', s_eaveOverhang: '처마 깊이',
    s_cornerLift: '추녀 들림', s_profileCurve: '지붕 곡률', s_roofCurve: '지붕 곡률',
    // #48 편집 축 확장
    s_columnHeight: '기둥 높이', s_podiumTierH: '기단 높이', s_ridgeH: '용마루 높이',
    s_footprintScale: '집 크기', s_wallType: '담장', s_roofTone: '지붕 색조', s_thatchAge: '이엉 상태',
    s_doorPattern: '창살', s_winBack: '뒷창 수', s_aux: '부속채',
    s_mainHalfW: '본채 폭', s_mainHalfD: '본채 깊이', s_wingLen: '날개 길이', s_wingW: '날개 폭',
    s_centerBayW: '어칸 폭', s_endBayW: '퇴칸 폭',
    s_planShape: '형태', s_bays: '칸수',   // #146 종가 평면형·칸수
    s_bracketTiers: '공포 단수', s_bracketScale: '공포 크기', s_interBrackets: '주간포 수',
    s_dancheongClarity: '단청 선명도', s_dancheongSplendor: '단청 화려함',
    s_podiumTiers: '기단 켜', s_podiumRailing: '월대 난간', s_wallH: '벽 높이',
    // #96 마당 소품 + 창호/개구
    s_jangdok: '장독대', s_vegBed: '텃밭', s_yardStack: '낟가리', s_clothesline: '빨래줄',
    s_winSide: '측면 창',
    sec_props: '마당 소품', sec_openings: '창호',
    sec_plan: '평면', sec_plandims: '칸 치수', sec_roof: '지붕', sec_skin: '외피', sec_proportion: '비례',
    sec_bracket: '공포', sec_podium: '기단', sec_yard: '마당', sec_structure: '구조', sec_dancheong: '단청',
    wall_tile: '기와담', wall_stone: '돌담', wall_mud: '토담', wall_brush: '싸리울', wall_hedge: '생울', wall_open: '열림',
    door_ttisal: '띠살', door_jeongja: '정자살',
    edit_advanced: '고급',
    vil_palace_edit_note: '관아 — 고을의 중심. 단청·공포·월대·지붕 격식을 손봅니다.',
    vil_hero_edit_note: '종가 — 마을의 중심. 지붕·처마 매무새를 손봅니다.',
    vil_palace_compound_note: '궁궐 — 다일곽 궁역. 모로단청을 바탕으로 전각의 단청·공포·지붕 격식을 손봅니다.',
    vil_temple_compound_note: '사찰 — 중심 불전의 금단청 위계를 지키며 전각·마당·석조물 구성을 손봅니다.',
    sec_temple_plan: '가람 구성', sec_temple_props: '전각과 석조물',
    s_variant: '가람 규모', s_hallCount: '전각 수', s_courtScale: '마당 여백', s_axisBend: '축 굴절',
    s_pagoda: '석탑', s_stoneLanterns: '석등 수', s_includeBellPavilion: '종루',
    s_includeDanggan: '당간지주', s_includeBudo: '부도',
    temple_variant_compact: '암자형', temple_variant_courtyard: '일곽형', temple_variant_extended: '복합형',
    temple_pagoda_auto: '어울림', temple_pagoda_none: '없음', temple_pagoda_single: '한 기', temple_pagoda_pair: '쌍탑',
    dial_time: '시간', dial_season: '계절', dial_weather: '날씨',
    env_reroll: '하늘 굴리기', env_reroll_tip: '하늘 굴리기 — 시간·노을빛·계절·날씨',
    sunset_look_tip: '노을빛 바꾸기', sunset_look_gold: '금빛 노을',
    sunset_look_crimson: '붉은 노을', sunset_look_violet: '보랏빛 노을',
    env_flow: '시간 흐르기',
    env_flow_tip: '시간 흐르기 — 때·계절이 저절로 흐른다',
    env_flow_on_tip: '시간 흐름 멈추기',
    time_dawn: '아침', time_day: '낮', time_sunset: '석양', time_night: '밤',
    season_spring: '봄', season_summer: '여름', season_autumn: '가을', season_winter: '겨울',
    weather_clear: '맑음', weather_rain: '비', weather_snow: '눈',
    render_style: '그림 방식', render_pbr: '풍경', render_ink: '수묵',
    render_pbr_tip: '빛과 색으로 보기', render_ink_tip: '진경산수 수묵으로 보기',
    // ── 마을 모드 ──
    mode_house: '집 보기', mode_village: '둘러보기',
    mode_to_village: '마을 둘러보기 — 확대·축소는 보기를 바꾸지 않습니다',
    mode_to_house: '종가 보기 — 다른 집은 화면에서 선택하세요',
    vil_title: '마을', vil_sub: 'village',
    vil_scale: '규모', vil_character: '성격',
    scale_solo: '외딴집', scale_hamlet: '초락', scale_village: '마을', scale_town: '읍치', scale_capital: '도성', scale_hanyang: '한양',
    char_minchon: '민촌', char_yeoyeom: '여염', char_banchon: '반촌',
    vil_palace: '궁', vil_temple: '절', vil_nohouse: '집 없이',
    vil_palace_hint: '도성에서만',
    // #91 마을 상세 파라미터(지형·구성·어휘)
    vil_detail: '마을 상세', vil_detail_sub: 'settlement detail',
    vsec_terrain: '지형', vsec_composition: '구성', vsec_vocab: '어휘',
    s_undAmpK: '기복', s_ridgeHK: '능선 높이', s_streamMeanderK: '물길 사행', s_stream: '물길', s_river: '큰 강 (한강급)',
    s_paddyDensityK: '논 비율', s_treeDensityK: '나무 밀도', s_cityWall: '성곽', s_sijeon: '시전',
    s_char01: '기와 비율', s_diversityK: '다양성',
    vil_citywall_hint: '초락부터', vil_sijeon_hint: '도성부터', vil_river_hint: '도성부터', vil_char_auto: '규모 자동',
    vil_reroll: '마을 다시 짓기', vil_reroll_tip: '마을을 통째로 다시 짓기 (해체→재생성→조립)',
    vil_reroll_house: '이 집 다시 짓기', vil_reroll_house_tip: '필지·집·마당·수목을 새로 구성합니다',
    crumb_hanok: '종가', crumb_palace: '관아', crumb_palace_compound: '궁궐', crumb_temple: '사찰',
    vil_houses: '호',
    vil_edit_title: '집 고치기', vil_edit_sub: 'edit house',
    vil_bays: '칸수', s_frontBays: '정면 칸', s_sideBays: '측면 칸',
    vil_hero_note: '이 랜드마크는 감상할 수 있지만 고쳐 지을 수 없습니다.',
    hint_bays: '칸',
    // 모바일 바텀시트 접기/펼치기(#154)
    sheet_expand: '편집 열기', sheet_collapse: '접기',
  },
  en: {
    hero_enter: 'Click to enter',
    act_rebuild: 'Rebuild', act_rebuild_tip: 'Rebuild (new seed)',
    act_replay: 'Replay', act_replay_tip: 'Watch the head house rise again',
    act_postcard: 'Take photo', act_postcard_tip: 'Save & share a photo with the cheoma seal',
    act_sound_on_tip: 'Mute', act_sound_off_tip: 'Sound on',
    // Cinematic demo mode (#112)
    act_drone: 'Drone', act_drone_tip: 'Drone cinematic — automatic aerial tour',
    act_walk: 'Walk', act_walk_tip: 'First-person stroll through the lanes',
    cine_exit: 'Exit', cine_exit_tip: 'Exit cinematic (Esc)',
    cine_hint: 'Tap or Esc to exit',
    cine_pass_crane: 'Approach', cine_pass_orbit: 'Orbit', cine_pass_fly: 'Fly-through', cine_pass_pull: 'Reveal',
    cine_walk_label: 'Lane stroll',
    // glTF export (#112)
    act_glb: 'Export', glb_house_tip: 'Export this building as a 3D model (.glb)',
    glb_village: 'Export village', glb_village_tip: 'Export the whole village as a 3D model (.glb)',
    glb_exporting: 'Exporting…',
    glb_done: '3D model saved',
    glb_toobig: 'Village too large — reduce the scale or export a single house.',
    glb_error: 'Export failed.',
    panel_title: 'Build',
    sec_type: 'Type', sec_expand: 'Add a bay', sec_finish: 'Details',
    type_korea_l: 'Palace', type_korea_s: 'jeongak',
    type_temple_l: 'Temple', type_temple_s: 'buljeon',
    type_giwa_l: 'Giwa', type_giwa_s: 'tiled',
    type_choga_l: 'Choga', type_choga_s: 'thatched',
    step_single: 'single', step_l: 'L-plan', step_u: 'U-plan',
    merge: 'Merge with neighbor',
    giwa_note: 'The giwa (tiled yangban house) is inherently L-shaped.',
    s_roofPitch: 'Roof pitch', s_riseScale: 'Roof pitch', s_eaveOverhang: 'Eave depth',
    s_cornerLift: 'Corner lift', s_profileCurve: 'Roof curve', s_roofCurve: 'Roof curve',
    // #48 edit axes
    s_columnHeight: 'Column height', s_podiumTierH: 'Podium height', s_ridgeH: 'Ridge height',
    s_footprintScale: 'House size', s_wallType: 'Wall', s_roofTone: 'Roof tone', s_thatchAge: 'Thatch age',
    s_doorPattern: 'Lattice', s_winBack: 'Rear windows', s_aux: 'Outbuilding',
    s_mainHalfW: 'Main width', s_mainHalfD: 'Main depth', s_wingLen: 'Wing length', s_wingW: 'Wing width',
    s_centerBayW: 'Center bay', s_endBayW: 'End bay',
    s_planShape: 'Shape', s_bays: 'Bays',   // #146 hanok plan shape & bays
    s_bracketTiers: 'Bracket tiers', s_bracketScale: 'Bracket size', s_interBrackets: 'Inter-brackets',
    s_dancheongClarity: 'Dancheong clarity', s_dancheongSplendor: 'Dancheong splendor',
    s_podiumTiers: 'Podium tiers', s_podiumRailing: 'Woldae railing', s_wallH: 'Wall height',
    // #96 yard props + openings
    s_jangdok: 'Jar terrace', s_vegBed: 'Kitchen garden', s_yardStack: 'Straw stack', s_clothesline: 'Clothesline',
    s_winSide: 'Side window',
    sec_props: 'Yard props', sec_openings: 'Openings',
    sec_plan: 'Plan', sec_plandims: 'Bay sizes', sec_roof: 'Roof', sec_skin: 'Skin', sec_proportion: 'Proportion',
    sec_bracket: 'Brackets', sec_podium: 'Podium', sec_yard: 'Yard', sec_structure: 'Structure', sec_dancheong: 'Dancheong',
    wall_tile: 'Tiled', wall_stone: 'Stone', wall_mud: 'Mud', wall_brush: 'Brush', wall_hedge: 'Hedge', wall_open: 'Open',
    door_ttisal: 'Ttisal', door_jeongja: 'Jeongja',
    edit_advanced: 'Advanced',
    vil_palace_edit_note: 'The magistracy — heart of the town. Tune its dancheong, brackets, terrace and roof.',
    vil_hero_edit_note: 'The head house — heart of the village. Tune its roof and eaves.',
    vil_palace_compound_note: 'The palace — start from restrained moro dancheong, then tune hall colour, brackets, roof and eaves.',
    vil_temple_compound_note: 'Temple — keep the central worship hall highest in dancheong rank while tuning halls, courts and stone monuments.',
    sec_temple_plan: 'Compound', sec_temple_props: 'Halls & stonework',
    s_variant: 'Scale', s_hallCount: 'Halls', s_courtScale: 'Court space', s_axisBend: 'Axis bend',
    s_pagoda: 'Pagoda', s_stoneLanterns: 'Lanterns', s_includeBellPavilion: 'Bell pavilion',
    s_includeDanggan: 'Danggan pillars', s_includeBudo: 'Budo stupa',
    temple_variant_compact: 'Hermitage', temple_variant_courtyard: 'Courtyard', temple_variant_extended: 'Extended',
    temple_pagoda_auto: 'Fitted', temple_pagoda_none: 'None', temple_pagoda_single: 'Single', temple_pagoda_pair: 'Twin',
    dial_time: 'Time', dial_season: 'Season', dial_weather: 'Weather',
    env_reroll: 'Reroll sky', env_reroll_tip: 'Reroll the sky — time · sunset hue · season · weather',
    sunset_look_tip: 'Change sunset hue', sunset_look_gold: 'Golden sunset',
    sunset_look_crimson: 'Crimson sunset', sunset_look_violet: 'Violet sunset',
    env_flow: 'Let time flow',
    env_flow_tip: 'Let time flow — hours and seasons drift on',
    env_flow_on_tip: 'Stop the flow of time',
    time_dawn: 'Dawn', time_day: 'Day', time_sunset: 'Sunset', time_night: 'Night',
    season_spring: 'Spring', season_summer: 'Summer', season_autumn: 'Autumn', season_winter: 'Winter',
    weather_clear: 'Clear', weather_rain: 'Rain', weather_snow: 'Snow',
    render_style: 'Rendering style', render_pbr: 'Scenery', render_ink: 'Ink',
    render_pbr_tip: 'View with light and color', render_ink_tip: 'View as a true-view ink landscape',
    // ── Village mode ──
    mode_house: 'House', mode_village: 'Explore',
    mode_to_village: 'Explore freely — zoom does not change views',
    mode_to_house: 'View the head house — select any other house in the scene',
    vil_title: 'Village', vil_sub: 'settlement',
    vil_scale: 'Scale', vil_character: 'Character',
    scale_solo: 'Lone house', scale_hamlet: 'Hamlet', scale_village: 'Village', scale_town: 'Town', scale_capital: 'Capital', scale_hanyang: 'Hanyang',
    char_minchon: 'Thatched hamlet', char_yeoyeom: 'Village', char_banchon: 'Gentry village',
    vil_palace: 'Palace', vil_temple: 'Temple', vil_nohouse: 'No houses',
    vil_palace_hint: 'capital only',
    // #91 village detail parameters (terrain · composition · character)
    vil_detail: 'Village detail', vil_detail_sub: 'terrain & make-up',
    vsec_terrain: 'Terrain', vsec_composition: 'Composition', vsec_vocab: 'Character',
    s_undAmpK: 'Undulation', s_ridgeHK: 'Ridge height', s_streamMeanderK: 'Watercourse meander', s_stream: 'Watercourse', s_river: 'Han-scale river',
    s_paddyDensityK: 'Paddy ratio', s_treeDensityK: 'Tree density', s_cityWall: 'City wall', s_sijeon: 'Market row',
    s_char01: 'Tile ratio', s_diversityK: 'Diversity',
    vil_citywall_hint: 'hamlet+', vil_sijeon_hint: 'capital+', vil_river_hint: 'capital+', vil_char_auto: 'auto by scale',
    vil_reroll: 'Rebuild village',
    vil_reroll_house: 'Rebuild this house', vil_reroll_house_tip: 'Recompose its lot, house, yard and trees',
    crumb_hanok: 'Head house', crumb_palace: 'Magistracy', crumb_palace_compound: 'Palace', crumb_temple: 'Temple',
    vil_houses: ' houses',   // 선행 공백 — 카운트 조합 시 "28 houses" (ko '호'는 붙여 "28호")
    vil_edit_title: 'Edit house', vil_edit_sub: 'plan & profile',
    vil_bays: 'Bays', s_frontBays: 'Front bays', s_sideBays: 'Side bays',
    vil_hero_note: 'This landmark can be viewed but is not editable.',
    hint_bays: 'bays',
    // Mobile bottom-sheet collapse/expand (#154)
    sheet_expand: 'Edit', sheet_collapse: 'Collapse',
  },
};

function detect() {
  try {
    const url = new URLSearchParams(location.search).get('lang');
    if (url === 'ko' || url === 'en') return url;
    const ls = localStorage.getItem('cheoma-lang');
    if (ls === 'ko' || ls === 'en') return ls;
  } catch {}
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('ko') ? 'ko' : 'en'; // 글로벌 기본 = 영어
}

export const i18n = $state({ lang: detect() });

export function setLang(l) {
  if (l !== 'ko' && l !== 'en') return;
  i18n.lang = l;
  try {
    localStorage.setItem('cheoma-lang', l);
    const u = new URL(location.href);
    u.searchParams.set('lang', l);
    history.replaceState(null, '', u);
  } catch {}
}

// t(key): 현재 로케일 문자열. i18n.lang 을 읽으므로 템플릿에서 호출하면 전환 시 자동 갱신.
export function t(key) {
  const l = i18n.lang;
  return (DICT[l] && DICT[l][key]) ?? DICT.en[key] ?? key;
}
