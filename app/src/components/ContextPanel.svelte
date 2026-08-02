<script>
  // CAD properties column (right dock / mobile sheet).
  //
  // Structure, top to bottom: selection header → context tabs → tool row →
  // building picker | scrolled properties (environment, scale, schema groups) |
  // status bar + one primary action. Every row shares the 4px grid in
  // ui/tokens.css; the accent is reserved for state (selection, focus, value
  // fill, default-departure) so the column stays an achromatic tool stage
  // against the golden-hour frame. docs/design-system.md.
  import { tick } from 'svelte';
  import { device } from '../lib/device.svelte.js';
  import { t } from '../lib/i18n.svelte.js';
  import {
    buildingNavigationStatus,
    groupBuildingNavigationTargets,
    normalizeBuildingNavigationTargets,
    resolveBuildingNavigationTarget,
  } from '../lib/building-navigation.js';
  import { schemaFor, villageSchema } from '../lib/edit-schema.js';
  import {
    SEASON_IDS,
    SUNSET_LOOK_IDS,
    WEATHER_IDS,
    pickEnvironmentScene,
  } from '../../../src/api/environment.js';
  import BottomSheet from './BottomSheet.svelte';
  import PropertyField from '../ui/PropertyField.svelte';
  import { REPO_LABEL, REPO_URL } from '../lib/links.js';

  let {
    open = false, morph = 0, detent = null,
    // 컨텍스트 탭 — onTab('village'|'house') 이 카메라 전환을 실행한다(모프와 한 클록).
    onTab = null, tabBusy = false,
    // 마을 섹션(부감)
    scale = 'village', includePalace = false, includeTemple = false,
    onScale, onPalace, onTemple, onReroll, waving = false,
    villageParams = {}, onVillageOpt = null,
    // 집 섹션(근접)
    spec = null, params = {}, onType, onLive, onCommit, onRerollHouse, houseBusy = false,
    // Bumps only when App reseeds editParams for a different parcel — the one
    // moment this panel may re-snapshot its default-departure baseline.
    editEpoch = 0,
    // 선택 헤더 / 상태 바 — 선택의 이름·좌표를 이 컬럼 안에서도 읽게 한다(결함 1).
    selectionLabel = '', houses = 0, seed = 0,
    // 키보드 건물 탐색(#114·#158 P8): 랜드마크/집 그룹 + 상한 20(선택 대상은 항상 포함).
    navigationTargets = [], navigationSelectedId = null, navigationBusy = false,
    onNavigateTarget = null,
    // Secondary tools — sticky under tabs (not the floating dock / not peek-only grip).
    onPostcard = null, onShare = null, onExport = null,
    exporting = false, busy = false,
    // Environment (was floating dial — now dense CAD rows in this column)
    time = 'day', sunsetLook = 'gold', season = 'summer', weather = 'clear',
    flowing = false,
    onTime = null, onSunsetLook = null, onSeason = null, onWeather = null,
    onFlowToggle = null,
    // Colophon — opens the References dialog owned by App (receives the trigger
    // element so focus returns here on close).
    onReferences = null,
  } = $props();

  const TIMES = ['dawn', 'day', 'sunset', 'night'];
  let envSpins = $state(0);
  function rollEnv() {
    const c = pickEnvironmentScene(Math.random, { ti: time, su: sunsetLook, se: season, we: weather });
    if (c.su && c.su !== sunsetLook) onSunsetLook?.(c.su);
    if (c.ti !== time) onTime?.(c.ti);
    if (c.se !== season) onSeason?.(c.se);
    if (c.we !== weather) onWeather?.(c.we);
    envSpins += 1;
  }
  function cycleSunsetLook() {
    const i = SUNSET_LOOK_IDS.indexOf(sunsetLook);
    onSunsetLook?.(SUNSET_LOOK_IDS[(i + 1) % SUNSET_LOOK_IDS.length]);
  }

  // ── 모프 크로스페이드(원칙 2) — 마을은 먼저 빠지고 집은 뒤이어 든다. ──
  const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const villageOpacity = $derived(1 - smoothstep(0.28, 0.72, morph));
  const houseOpacity = $derived(smoothstep(0.28, 0.72, morph));
  const houseActive = $derived(morph >= 0.5);   // 포인터·손잡이 컨텍스트
  const hasShareTools = $derived(!!(onPostcard || onShare || onExport));
  const exportLabel = $derived(exporting
    ? t('glb_exporting')
    : (houseActive ? t('act_glb') : t('glb_village')));
  const exportTip = $derived(houseActive ? t('glb_house_tip') : t('glb_village_tip'));

  // 크로스페이드 중에도 키보드·접근성 소유자는 하나다. inert 적용 전 포커스가 퇴장하는 본문/푸터 안에
  // 있을 때만 다음 컨텍스트의 브레드크럼(좌상, 이 컴포넌트 밖)으로 옮긴다. 캔버스·환경 UI·References 에
  // 있던 포커스는 건드리지 않는다.
  //
  // 포커스가 **브레드크럼 자체**에 있던 경우는 `Breadcrumb.svelte` 가 소유한다 — 그 컴포넌트가
  // 나가는 요소를 언마운트하므로, 여기서 읽을 때는 이미 activeElement 가 body 인 순서 경쟁이 있었다.
  // 아래 `outgoingHeader` 절은 이 effect 가 먼저 도는 경우를 위한 이중 안전망이고(같은 목적지),
  // 본문·푸터 케이스는 여전히 이쪽 단독 책임이다.
  let stackRoot = $state(null);
  let footerRoot = $state(null);
  let previousHouseActive = null;
  $effect.pre(() => {
    const nextHouseActive = houseActive;
    if (previousHouseActive == null) {
      previousHouseActive = nextHouseActive;
      return;
    }
    if (previousHouseActive === nextHouseActive) return;

    const active = typeof document === 'undefined' ? null : document.activeElement;
    const outgoingOwner = previousHouseActive ? 'house' : 'village';
    const outgoing = [
      stackRoot?.querySelector(`[data-context-owner="${outgoingOwner}"]`),
      footerRoot?.querySelector(`[data-context-owner="${outgoingOwner}"]`),
    ];
    const outgoingHeader = typeof document === 'undefined'
      ? null
      : document.querySelector(`[data-context-focus="${outgoingOwner}"]`);
    const moveFocus = !!active
      && (active === outgoingHeader || outgoing.some((root) => root?.contains(active)));
    previousHouseActive = nextHouseActive;
    if (!moveFocus) return;

    void tick().then(() => {
      const nextOwner = nextHouseActive ? 'house' : 'village';
      const destination = document.querySelector(`[data-context-focus="${nextOwner}"]`);
      if (destination?.isConnected && !destination.closest('[inert]')) {
        destination.focus({ preventScroll: true });
      }
    });
  });

  // ── 지속적인 의미 기반 건물 선택기(#114) ──
  const NAVIGATION_LABEL_KEYS = {
    'head-house': 'crumb_hanok',
    government: 'crumb_palace',
    palace: 'crumb_palace_compound',
    temple: 'crumb_temple',
    giwa: 'type_giwa_l',
    choga: 'type_choga_l',
  };
  const normalizedNavigationTargets = $derived(normalizeBuildingNavigationTargets(navigationTargets));
  const navigationGroups = $derived(groupBuildingNavigationTargets(normalizedNavigationTargets, {
    selectedId: navigationSelectedId,
  }));
  // 옵션은 그룹으로 상한이 걸리므로 draft 유효성은 "보이는 후보" 기준으로 판정한다.
  const visibleNavigationTargets = $derived(navigationGroups.flatMap((group) => group.targets));
  let navigationDraftId = $state('');
  let observedNavigationSelectedId = $state(undefined);
  $effect(() => {
    const selected = resolveBuildingNavigationTarget(
      visibleNavigationTargets,
      navigationSelectedId,
    );
    const selectedId = selected?.id ?? null;
    if (observedNavigationSelectedId !== selectedId) {
      observedNavigationSelectedId = selectedId;
      navigationDraftId = selectedId || visibleNavigationTargets[0]?.id || '';
      return;
    }
    if (!resolveBuildingNavigationTarget(visibleNavigationTargets, navigationDraftId)) {
      navigationDraftId = selectedId || visibleNavigationTargets[0]?.id || '';
    }
  });
  const navigationDraft = $derived(resolveBuildingNavigationTarget(
    visibleNavigationTargets,
    navigationDraftId,
  ));
  const navigationState = $derived(buildingNavigationStatus(
    normalizedNavigationTargets,
    navigationSelectedId,
  ));
  const navigationCurrent = $derived(navigationState.selected);
  const navigationActionUnavailable = $derived(
    navigationBusy
      || !navigationDraft
      || navigationDraft.id === navigationCurrent?.id
      || typeof onNavigateTarget !== 'function',
  );
  const navigationLabelKey = (target) => NAVIGATION_LABEL_KEYS[target?.type] || 'vil_title';
  const navigationTargetLabel = (target) => {
    const label = t(navigationLabelKey(target));
    return target?.type === 'giwa' || target?.type === 'choga'
      ? `${label} ${target.ordinal}`
      : label;
  };
  const navigationGroupLabel = (group) => (group.targets.length < group.total
    ? `${t(group.labelKey)} · ${group.targets.length} / ${group.total}`
    : t(group.labelKey));
  const navigationStatusText = $derived.by(() => {
    if (navigationState.kind === 'focus') {
      return `${navigationTargetLabel(navigationState.selected)} · ${t('nav_current_status')}`;
    }
    if (navigationState.kind === 'explore') {
      return `${navigationState.total}${t('nav_count_suffix')} · ${t('nav_explore_status')}`;
    }
    return t('nav_empty_status');
  });
  const navigationActionLabel = $derived(
    navigationBusy
      ? t('nav_moving')
      : navigationDraft?.id === navigationCurrent?.id
        ? t('nav_current')
        : t(houseActive ? 'nav_move' : 'nav_view'),
  );
  const navigationActionAccessibleLabel = $derived(
    navigationDraft
      ? `${navigationActionLabel}: ${navigationTargetLabel(navigationDraft)}`
      : navigationActionLabel,
  );
  function activateNavigationTarget() {
    if (navigationActionUnavailable) return;
    onNavigateTarget?.(navigationDraft.id);
  }

  // ── 마을 규모(그룹 밖 상주 — 규모는 이 패널의 헤드라인 축) ──
  const SCALES = ['solo', 'hamlet', 'village', 'town', 'capital', 'hanyang'];
  const idx = $derived(Math.max(0, SCALES.indexOf(scale)));
  let dragVal = $state(null);
  const shownVal = $derived(dragVal != null ? dragVal : idx);
  const shownAnchor = $derived(SCALES[Math.round(shownVal)]);
  const palaceScale = $derived(shownAnchor === 'capital' || shownAnchor === 'hanyang');
  function slideInput(v) { dragVal = v; }
  function slideCommit(v) { dragVal = null; const a = SCALES[Math.round(v)]; if (a !== scale) onScale?.(a); }

  // CAD density: every group body stays open by default so the full lever set is
  // scannable (the standing product decision). The chevron is a per-user fold for
  // long columns; Alt-click isolates one group. State is local to the browser.
  const FOLD_KEY = 'cheoma.inspector.folds';
  let folds = $state(new Set());
  $effect(() => {
    try {
      const raw = localStorage.getItem(FOLD_KEY);
      if (raw) folds = new Set(JSON.parse(raw));
    } catch { /* private mode / quota — folds simply do not persist */ }
  });
  function persistFolds(next) {
    folds = next;
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
  }
  const foldId = (owner, sec) => `${owner}:${sec.id}`;
  const isOpen = (owner, sec) => !folds.has(foldId(owner, sec));
  function toggleFold(owner, sec, event) {
    const id = foldId(owner, sec);
    if (event?.altKey) {
      const all = (owner === 'house' ? schema.sections : vSections).map((s) => foldId(owner, s));
      const solo = new Set(folds);
      for (const other of all) if (other !== id) solo.add(other);
      solo.delete(id);
      persistFolds(solo);
      return;
    }
    const next = new Set(folds);
    if (next.has(id)) next.delete(id); else next.add(id);
    persistFolds(next);
  }

  const vSections = villageSchema();
  const schema = $derived(schemaFor(spec));
  const editable = $derived(!!spec && spec.editable === true);

  const TYPES = [
    { key: 'giwa', l: 'type_giwa_l', s: 'type_giwa_s' },
    { key: 'choga', l: 'type_choga_l', s: 'type_choga_s' },
  ];

  // ── 파라미터 검색(결함 4) — 라벨/키 부분일치. 빈 질의는 아무것도 숨기지 않는다. ──
  let query = $state('');
  const q = $derived(query.trim().toLowerCase());
  const fieldMatches = (f) => !q
    || t('s_' + f.key).toLowerCase().includes(q)
    || f.key.toLowerCase().includes(q);
  const sectionMatches = (sec) => !q
    || t(sec.titleKey).toLowerCase().includes(q)
    || sec.fields.some(fieldMatches);
  const sectionFields = (sec) => (!q || t(sec.titleKey).toLowerCase().includes(q)
    ? sec.fields
    : sec.fields.filter(fieldMatches));

  // 단위는 UI 표시 메타데이터다 — edit-schema 필드셋은 코어 계약이라 건드리지 않는다.
  //   'm' 실측 길이 · '×' 배율(1.00 = 코어 기본). 0–1 비율·각도 축은 무단위로 남긴다.
  const UNIT_BY_KEY = {
    eaveOverhang: 'm', mainHalfW: 'm', mainHalfD: 'm', wingLen: 'm', wingW: 'm',
    columnHeight: 'm', podiumTierH: 'm', ridgeH: 'm', wallH: 'm',
    centerBayW: 'm', endBayW: 'm',
    riseScale: '×', footprintScale: '×', bracketScale: '×', courtScale: '×',
    undAmpK: '×', ridgeHK: '×', streamMeanderK: '×',
    paddyDensityK: '×', treeDensityK: '×', diversityK: '×',
  };
  const unitOf = (f) => UNIT_BY_KEY[f.key] || '';

  // ── 마을 상세 파라미터 표시 규약(#91 계승) ──
  const scaleIdx = $derived(Math.max(0, SCALES.indexOf(scale)));
  const vShow = (f) => (typeof villageParams[f.key] === 'number' ? villageParams[f.key] : (f.def ?? f.min));
  const vIsAuto = (f) => f.auto === true && typeof villageParams[f.key] !== 'number';
  const vTriOn = (f) => { const v = villageParams[f.key]; return v === true || ((v == null || v === 'auto') && scale === 'hanyang'); };
  const vPlainOn = (f) => {
    const value = villageParams[f.key];
    if (f.onValue !== undefined) {
      return typeof f.isOn === 'function' ? f.isOn(value) : value === f.onValue;
    }
    return value == null ? f.def !== false : value === true;
  };
  const vDisabled = (f) => {
    if (Array.isArray(f.scales) && !f.scales.includes(scale)) return true;
    const gateIdx = SCALES.indexOf(f.tierGate);
    return gateIdx >= 0 && scaleIdx < gateIdx;
  };
  // The value cell is 52px wide, so the auto state prints short and spells itself
  // out in the row tooltip instead.
  const vFormat = (f, value) => `${Number(value).toFixed(2)}${unitOf(f)}`;
  const vDisplay = (f) => (vIsAuto(f) ? t('vil_char_auto_short') : vFormat(f, vShow(f)));
  // 기본값 이탈 = 코어 no-op 기본과 다른 값. 마을 축은 스키마 기본이 곧 코어 기본이라 정확하다.
  const vChanged = (f) => {
    if (f.ctrl === 'range') {
      return typeof villageParams[f.key] === 'number'
        && Math.abs(villageParams[f.key] - (f.def ?? f.min)) > 1e-9;
    }
    if (f.tri) return villageParams[f.key] === true || villageParams[f.key] === false;
    return vPlainOn(f) !== (f.def !== false && f.def !== null && f.def !== undefined);
  };
  const vChangedCount = (sec) => sec.fields.filter(vChanged).length;
  function vRange(f, value) { onVillageOpt?.(f.key, value); }
  function vToggleTri(f) { onVillageOpt?.(f.key, vTriOn(f) ? false : true); }
  function vTogglePlain(f) {
    if (vDisabled(f)) return;
    if (f.onValue !== undefined) {
      onVillageOpt?.(f.key, vPlainOn(f) ? (f.offValue ?? null) : f.onValue);
      return;
    }
    onVillageOpt?.(f.key, !vPlainOn(f));
  }

  // ── 집 편집 표시 규약(#48 계승) ──
  const showVal = (f) => (typeof params[f.key] === 'number' ? params[f.key] : (f.def ?? f.min));
  const displayValue = (f, value = showVal(f)) => (f.format === 'percent'
    ? `${Math.round(Number(value) * 100)}%`
    : f.unitKey
      ? `${Number(value) | 0}${t(f.unitKey)}`
      // A count field prints as a count: `1`, not `1.00`.
      : f.ctrl === 'stepper'
        ? String(Math.round(Number(value)))
        : `${Number(value).toFixed(2)}${unitOf(f)}`);
  const parseValue = (f, text) => {
    const n = parseFloat(String(text).replace(/[^\d.+-]/g, ''));
    if (!Number.isFinite(n)) return NaN;
    return f.format === 'percent' ? n / 100 : n;
  };
  const fieldLabel = (f) => t('s_' + f.key);
  const boundsOf = (f) => (f.showBounds && f.ctrl !== 'segment' && f.ctrl !== 'toggle'
    ? `${displayValue(f, f.min)}–${displayValue(f, f.max)}`
    : '');
  // Row tooltip carries the range and the tier requirement so the label line can
  // stay one ellipsised row instead of wrapping into the next control.
  const rowTip = (f, label, extra = '') => [
    label,
    Number.isFinite(f.min) && Number.isFinite(f.max) && f.ctrl !== 'toggle' && f.ctrl !== 'segment'
      ? `${displayValue(f, f.min)} – ${displayValue(f, f.max)}`
      : '',
    extra,
  ].filter(Boolean).join(' · ');
  // 집 축의 "기본값"은 생성 직후의 값이다. 필지마다 굴러서 스키마 def 로는 못 잡고, 커밋마다
  //   spec.params 가 갱신되므로 그것도 못 쓴다. App 이 재시드할 때만 스냅샷을 새로 뜬다.
  let baseline = $state({});
  let seenEpoch = -1;
  $effect(() => {
    if (editEpoch === seenEpoch) return;
    seenEpoch = editEpoch;
    baseline = { ...params };
  });
  const hBase = (f) => (baseline[f.key] !== undefined ? baseline[f.key] : f.def);
  const hChanged = (f) => {
    const base = hBase(f);
    if (base === undefined || base === null) return false;
    const v = params[f.key];
    if (v === undefined) return false;
    return typeof base === 'number' ? Math.abs(Number(v) - base) > 1e-9 : v !== base;
  };
  const hChangedCount = (sec) => sec.fields.filter(hChanged).length;
  // Geometry-backed ranges stream through onLive (scheduler → live preview).
  // Discrete controls fire live+commit so the house never waits for pointer-up
  // of a non-drag control. Pointer release is flora/pick/clamp reconciliation.
  function range(f, value) { params[f.key] = value; onLive?.(f.key, value); }
  function rangeCommit(f, value) { params[f.key] = value; onCommit?.(f.key, value); }
  function pick(f, value) { params[f.key] = value; onLive?.(f.key, value); onCommit?.(f.key, value); }
  function toggleField(f) {
    const v = !params[f.key];
    params[f.key] = v;
    onLive?.(f.key, v);
    onCommit?.(f.key, v);
  }
  function resetField(f) {
    const base = hBase(f);
    if (base === undefined || base === null) return;
    params[f.key] = base;
    onLive?.(f.key, base);
    onCommit?.(f.key, base);
  }
  const optLabel = (key, o) => t((key === 'wallType' ? 'wall_'
    : key === 'doorPattern' ? 'door_'
    : key === 'planShape' ? 'step_'
    : key === 'variant' ? 'temple_variant_'
    : key === 'pagoda' ? 'temple_pagoda_'
    : '') + o);

  // ── 선택 헤더 / 상태 바 ──
  const houseBadge = $derived(!spec
    ? ''
    : schema.family === 'palace-compound' ? t('crumb_palace_compound')
      : schema.family === 'temple' ? t('crumb_temple')
        : schema.family === 'hero' ? (schema.heroStyle === 'hanok' ? t('crumb_hanok') : t('crumb_palace'))
          : t((params.kind || spec.kind) === 'choga' ? 'type_choga_l' : 'type_giwa_l'));
  // Badge = category, name = identity — the pair must not repeat one word twice.
  const selectionBadge = $derived(t(houseActive ? 'sel_kind_building' : 'sel_kind_village'));
  const selectionName = $derived(houseActive
    ? (navigationCurrent ? navigationTargetLabel(navigationCurrent) : (selectionLabel || houseBadge))
    : `#${seed}`);
  const selectionPath = $derived(houseActive
    ? `${t('vil_title')} › ${selectionName}`
    : t('sel_none_village'));
  const statusText = $derived([
    `#${seed}`,
    t('scale_' + scale),
    houses > 0 ? `${houses}${t('vil_houses')}` : '',
    houseActive ? selectionName : '',
  ].filter(Boolean).join('  ·  '));
  // The sheet's docking bar already shows the identity, so its readout keeps only
  // the facts the identity does not carry.
  const statusCompact = $derived([
    `#${seed}`,
    houses > 0 ? `${houses}${t('vil_houses')}` : '',
  ].filter(Boolean).join(' · '));
</script>

<BottomSheet
  {open}
  gap={4}
  {detent}
  ariaLabel="make panel"
  {header}
  {footer}
  status={statusCompact}
  identityBadge={selectionBadge}
  identityName={selectionName}
>
  <!-- Building picker leads the scrolled column: it is the keyboard route into a
       selection, and the sheet layout needs its height inside the scroll window
       (check:ui-shell measures visible scroll, not the header block). -->
  {#if navigationGroups.length}
    <div class="buildingnav" data-building-navigation>
      <label class="cad-sr" for="building-navigation">{t('nav_building')}</label>
      <div class="navcontrols">
        <!-- Native select: app-smoke / keyboard nav contract (#114, #158 P8). -->
        <select
          id="building-navigation"
          bind:value={navigationDraftId}
          aria-label={t('nav_building')}
          aria-describedby="building-navigation-status"
          title={t('nav_building')}
        >
          {#each navigationGroups as group (group.id)}
            <optgroup label={navigationGroupLabel(group)}>
              {#each group.targets as target (target.id)}
                <option value={target.id}>{navigationTargetLabel(target)}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        <button
          type="button"
          class="navaction cad-btn"
          class:unavailable={navigationActionUnavailable}
          aria-disabled={navigationActionUnavailable ? 'true' : 'false'}
          aria-label={navigationActionAccessibleLabel}
          title={navigationActionAccessibleLabel}
          onclick={(e) => {
            // Keep the control focusable when unavailable (disabled would steal
            // focus after activation). Keyboard/app-smoke still read aria-disabled.
            if (navigationActionUnavailable) {
              e.preventDefault();
              return;
            }
            activateNavigationTarget();
          }}
        >{navigationActionLabel}</button>
      </div>
      <p id="building-navigation-status" class="navstatus" role="status" aria-live="polite">{navigationStatusText}</p>
    </div>
  {/if}

  <!-- Parameter filter. Empty query hides nothing, so the CAD column still opens
       with the full lever set (check:ui-shell counts every group body). -->
  <div class="psearchrow">
    <input
      class="psearch"
      type="search"
      bind:value={query}
      placeholder={t('param_search')}
      aria-label={t('param_search')}
    />
  </div>

  <!-- Environment — dense CAD rows in the inspector (class .dial keeps gate hooks). -->
  <section class="dial envblock" aria-label={t('axis_view')}>
    <div class="advtoggle group static envhead">
      <span class="gname">{t('axis_view')}</span>
      <!-- Mono line icons on the same stroke as the tool row. These used to be a
           colour orb and a half-disc, which made the environment header the most
           saturated block in the panel outside the CTA. The tone / flow identity
           lives in the tooltip and in the pressed border, not in hue. -->
      <div class="envactions">
        <button type="button" class="cad-btn dial-btn env-roll" title={t('env_reroll_tip')} aria-label={t('env_reroll')} onclick={rollEnv}>
          <span class="rk-glyph" style="transform: rotate({envSpins * 360}deg)" aria-hidden="true">
            <svg viewBox="0 0 16 16"><path d="M13.2 6.4A5.4 5.4 0 1 0 13.6 10"/><path d="M13.6 2.9v3.6h-3.6"/></svg>
          </span>
        </button>
        {#if time === 'sunset'}
          <button
            type="button"
            class="cad-btn dial-btn sunset-tone {sunsetLook}"
            title={t('sunset_look_tip') + ' — ' + t('sunset_look_' + sunsetLook)}
            aria-label={t('sunset_look_tip') + ': ' + t('sunset_look_' + sunsetLook)}
            onclick={cycleSunsetLook}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 11.4a3.4 3.4 0 0 1 6.8 0"/><path d="M1.6 11.4h12.8"/><path d="M8 3.1v1.7M3.4 5 4.6 6.2M12.6 5 11.4 6.2"/></svg>
          </button>
        {/if}
        <button
          type="button"
          class="cad-btn dial-btn env-flow"
          class:on={flowing}
          title={t(flowing ? 'env_flow_on_tip' : 'env_flow_tip')}
          aria-label={t('env_flow')}
          aria-pressed={flowing}
          onclick={() => onFlowToggle?.()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4"/><path d="M8 4.8V8l2.4 1.6"/></svg>
        </button>
      </div>
    </div>
    <div class="envbody">
      <div class="row envrow">
        <span class="rl cad-label">{t('dial_time')}</span>
        <div class="cad-seg" role="group" aria-label={t('dial_time')}>
          {#each TIMES as id}
            <button type="button" class:on={time === id} aria-pressed={time === id} title={t('time_' + id)} onclick={() => onTime?.(id)}>{t('time_' + id)}</button>
          {/each}
        </div>
      </div>
      <div class="row envrow">
        <span class="rl cad-label">{t('dial_season')}</span>
        <div class="cad-seg" role="group" aria-label={t('dial_season')}>
          {#each SEASON_IDS as id}
            <button type="button" class:on={season === id} aria-pressed={season === id} title={t('season_' + id)} onclick={() => onSeason?.(id)}>{t('season_' + id)}</button>
          {/each}
        </div>
      </div>
      <div class="row envrow">
        <span class="rl cad-label">{t('dial_weather')}</span>
        <div class="cad-seg" role="group" aria-label={t('dial_weather')}>
          {#each WEATHER_IDS as id}
            <button type="button" class:on={weather === id} aria-pressed={weather === id} title={t('weather_' + id)} onclick={() => onWeather?.(id)}>{t('weather_' + id)}</button>
          {/each}
        </div>
      </div>
    </div>
  </section>

  <div bind:this={stackRoot} class="stack">
    <div
      class="ctx village"
      style="opacity:{villageOpacity}; transform: translateY({-8 * morph}px);"
      style:pointer-events={houseActive ? 'none' : 'auto'}
      aria-hidden={houseActive}
      inert={houseActive}
      role="tabpanel"
      aria-labelledby="make-tab-village"
      data-context-owner="village"
    >
      <!-- Wrapped like every other group: a sticky header whose containing block is
           the whole `.ctx` would stay pinned over the sections below it. -->
      <div class="gwrap">
      <div class="advtoggle group static">
        <span class="gname">{t('vil_scale')}</span>
        <span class="gval">{t('scale_' + shownAnchor)}</span>
      </div>
      <section class="pinned">
        <div class="scalewrap">
          <input
            class="scale" type="range" min="0" max={SCALES.length - 1} step="0.01"
            value={shownVal}
            style="--fill: {(shownVal / (SCALES.length - 1)) * 100}%"
            oninput={(e) => slideInput(parseFloat(e.currentTarget.value))}
            onchange={(e) => slideCommit(parseFloat(e.currentTarget.value))}
            aria-label={t('vil_scale')}
            aria-valuetext={t('scale_' + shownAnchor)}
          />
          <!-- Tier ticks: the six named anchors this continuum snaps to. -->
          <div class="ticks" aria-hidden="true">
            {#each SCALES as id, i}
              <span class="tick" class:on={i === Math.round(shownVal)} style="left: {(i / (SCALES.length - 1)) * 100}%"></span>
            {/each}
          </div>
        </div>
        <div class="ends"><span>{t('scale_solo')}</span><span>{t('scale_hanyang')}</span></div>
        <div class="toggles">
          <label
            class="row vtoggle"
            class:disabled={!palaceScale}
            title={!palaceScale ? `${t('vil_palace')} · ${t('vil_palace_hint')}` : t('vil_palace')}
          >
            <span class="rl cad-label">{t('vil_palace')}</span>
            <span class="ctl"></span>
            <span class="vcell">
              <input
                class="cad-check"
                type="checkbox"
                checked={includePalace}
                disabled={!palaceScale || undefined}
                aria-label={t('vil_palace')}
                aria-checked={includePalace ? 'true' : 'false'}
                onchange={() => onPalace?.()}
              />
            </span>
          </label>
          <label class="row vtoggle" title={t('vil_temple')}>
            <span class="rl cad-label">{t('vil_temple')}</span>
            <span class="ctl"></span>
            <span class="vcell">
              <input
                class="cad-check"
                type="checkbox"
                checked={includeTemple}
                aria-label={t('vil_temple')}
                aria-checked={includeTemple ? 'true' : 'false'}
                onchange={() => onTemple?.()}
              />
            </span>
          </label>
          {#if shownAnchor === 'solo' && onVillageOpt}
            <label class="row vtoggle" title={t('vil_nohouse')}>
              <span class="rl cad-label">{t('vil_nohouse')}</span>
              <span class="ctl"></span>
              <span class="vcell">
                <input
                  class="cad-check"
                  type="checkbox"
                  checked={villageParams.houses === 0}
                  aria-label={t('vil_nohouse')}
                  aria-checked={villageParams.houses === 0 ? 'true' : 'false'}
                  onchange={() => onVillageOpt('houses', villageParams.houses === 0 ? null : 0)}
                />
              </span>
            </label>
          {/if}
        </div>
      </section>
      </div>

      {#if onVillageOpt}
        {#each vSections as vsec (vsec.id)}
          <!-- One wrapper per group so each sticky header releases at its own
               section end instead of piling up at the top of the scrollport. -->
          <div class="gwrap" class:filtered={!sectionMatches(vsec)}>
            {@render groupHeader('village', vsec, vChangedCount(vsec))}
            {@render villageSection(vsec)}
          </div>
        {/each}
      {/if}
    </div>

    <div
      class="ctx house"
      style="opacity:{houseOpacity}; transform: translateY({12 * (1 - morph)}px);"
      style:pointer-events={houseActive ? 'auto' : 'none'}
      aria-hidden={!houseActive}
      inert={!houseActive}
      role="tabpanel"
      aria-labelledby="make-tab-house"
      data-context-owner="house"
    >
      {#if editable}
        {#if schema.family === 'palace-compound'}
          <p class="note">{t('vil_palace_compound_note')}</p>
        {:else if schema.family === 'temple'}
          <p class="note">{t('vil_temple_compound_note')}</p>
        {:else if schema.family === 'hero'}
          <p class="note">{t(schema.heroStyle === 'hanok' ? 'vil_hero_edit_note' : 'vil_palace_edit_note')}</p>
        {:else}
          <div class="gwrap">
          <div class="advtoggle group static">
            <span class="gname">{t('sec_type')}</span>
          </div>
          <section class="pinned">
            <!-- Class `tabs` kept for app-smoke (`.tabs .tab` type switch). -->
            <div class="tabs typetabs cad-seg" role="group" aria-label={t('sec_type')}>
              {#each TYPES as ty}
                <button
                  type="button"
                  class="tab"
                  class:on={(params.kind || spec?.kind) === ty.key}
                  aria-pressed={(params.kind || spec?.kind) === ty.key}
                  title={`${t(ty.l)} · ${t(ty.s)}`}
                  onclick={() => onType?.(ty.key)}
                >
                  <span class="tl">{t(ty.l)}</span>
                  <span class="ts">{t(ty.s)}</span>
                </button>
              {/each}
            </div>
          </section>
          </div>
        {/if}

        {#each schema.sections as sec (sec.id)}
          <div class="gwrap" class:filtered={!sectionMatches(sec)}>
            {@render groupHeader('house', sec, hChangedCount(sec))}
            {@render editSection(sec)}
          </div>
        {/each}
      {:else if spec}
        <div class="hero-note">
          <span class="mark" aria-hidden="true">i</span>
          <p>{t('vil_hero_note')}</p>
        </div>
      {/if}
    </div>
  </div>

  <!-- Colophon closing the property column. Portrait sheets hide the bottom-left
       seal chip (its corner belongs to the sheet), so this is the only route to
       References and the source repo on a phone in village mode. -->
  <div class="colophon" data-colophon>
    {#if onReferences}
      <button
        type="button"
        class="colink"
        data-reference-trigger="colophon"
        onclick={(e) => onReferences(e.currentTarget)}
      >{t('about_references')}</button>
    {/if}
    <a
      class="colink"
      data-source-link
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={t('act_source_tip')}
    >{t('about_open_source')} · {REPO_LABEL}</a>
  </div>
</BottomSheet>

{#snippet header()}
  <div class="makehead">
    {#if !device.sheet}
      <!-- Selection header: what these properties belong to. Text only — the tab
           order contract (check-app-smoke) puts the context tabs first. -->
      <div class="selhead" data-selection-header>
        <span class="selbadge">{selectionBadge}</span>
        <span class="selname">{selectionName}</span>
        <span class="selpath" title={selectionPath}>{selectionPath}</span>
      </div>
    {/if}
    <div class="axistabs cad-seg" role="group" aria-label={t('axis_make')}>
      <button
        type="button"
        id="make-tab-village"
        class="axistab"
        class:on={!houseActive}
        aria-pressed={!houseActive}
        aria-busy={tabBusy || undefined}
        title={t('mode_to_village')}
        onclick={() => onTab?.('village')}
      >{t('mode_village')}</button>
      <button
        type="button"
        id="make-tab-house"
        class="axistab"
        class:on={houseActive}
        aria-pressed={houseActive}
        aria-busy={tabBusy || undefined}
        title={t('mode_to_house')}
        onclick={() => onTab?.('house')}
      >{t('mode_house')}</button>
    </div>
    {#if hasShareTools}
      <!-- Native buttons: app-smoke uses focus+Enter and transient activation for share().
           Icons + sr-only labels — the labels stay in the DOM for the gates. -->
      <div class="toolrow" role="group" aria-label={t('axis_share')}>
        {#if onPostcard}
          <button
            type="button"
            class="tbtn"
            data-action="postcard"
            disabled={busy}
            title={`${t('act_postcard')} — ${t('act_postcard_tip')}`}
            onclick={() => onPostcard?.()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="10" rx="1.5"/><circle cx="8" cy="8.5" r="2.6"/><path d="M5.5 3.5 6.6 1.8h2.8l1.1 1.7"/></svg>
            <span class="cad-sr">{t('act_postcard')}</span>
          </button>
        {/if}
        {#if onShare}
          <button
            type="button"
            class="tbtn"
            data-action="share"
            disabled={busy}
            title={`${t('act_share')} — ${t('act_share_tip')}`}
            onclick={() => onShare?.()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 11V2.6"/><path d="M4.8 5.6 8 2.4l3.2 3.2"/><path d="M3 9.6v3.9h10V9.6"/></svg>
            <span class="cad-sr">{t('act_share')}</span>
          </button>
        {/if}
        {#if onExport}
          <button
            type="button"
            class="tbtn"
            class:working={exporting}
            data-action="export"
            disabled={exporting || busy}
            title={`${exportLabel} — ${exportTip}`}
            onclick={() => onExport?.()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6V11"/><path d="M4.8 7.8 8 11l3.2-3.2"/><path d="M3 13.4h10"/></svg>
            <span class="cad-sr">{exportLabel}</span>
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet footer()}
  {#if !device.sheet}
    <p class="statusbar" data-status-bar>{statusText}</p>
  {/if}
  <div bind:this={footerRoot} class="footstack">
    <div
      class="foot village"
      style="opacity:{villageOpacity}"
      style:pointer-events={houseActive ? 'none' : 'auto'}
      aria-hidden={houseActive}
      inert={houseActive}
      data-context-owner="village"
    >
      <button
        type="button"
        class="rebuild cad-primary"
        disabled={waving || undefined}
        title={t('vil_reroll_tip')}
        onclick={() => onReroll?.()}
      >{t('vil_reroll')}</button>
    </div>
    <div
      class="foot house"
      style="opacity:{houseOpacity}"
      style:pointer-events={houseActive ? 'auto' : 'none'}
      aria-hidden={!houseActive}
      inert={!houseActive}
      data-context-owner="house"
    >
      {#if spec}
        <div class="house-actions">
          <button
            type="button"
            class="hbtn reroll wide cad-primary"
            disabled={houseBusy || undefined}
            title={t('vil_reroll_house_tip')}
            onclick={() => onRerollHouse?.()}
          >{t('vil_reroll_house')}</button>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet groupHeader(owner, sec, changedCount)}
  <!-- Sticky CAD section title. Default open (standing product decision); the
       chevron folds one group for this browser, Alt-click isolates it. -->
  <button
    type="button"
    class="advtoggle group"
    class:open={isOpen(owner, sec)}
    class:filtered={!sectionMatches(sec)}
    data-group={sec.id}
    aria-expanded={isOpen(owner, sec) ? 'true' : 'false'}
    title={`${t(sec.titleKey)} — ${t('cost_' + sec.cost + '_tip')}`}
    onclick={(e) => toggleFold(owner, sec, e)}
  >
    <span class="chev" aria-hidden="true"></span>
    <span class="gname">{t(sec.titleKey)}</span>
    {#if changedCount > 0}
      <span class="gchanged" title={t('changed_tip')}>{changedCount}</span>
    {/if}
    <span
      class="costbadge {sec.cost}"
      data-cost={sec.cost}
      title={t('cost_' + sec.cost + '_tip')}
    >{t('cost_' + sec.cost)}</span>
  </button>
{/snippet}

{#snippet villageSection(vsec)}
  <section
    class="vdetail groupbody"
    class:folded={!isOpen('village', vsec)}
    class:filtered={!sectionMatches(vsec)}
    data-group-body={vsec.id}
  >
    {#each sectionFields(vsec) as f (f.key)}
      {#if f.ctrl === 'range'}
        <PropertyField
          field={f}
          label={t('s_' + f.key)}
          value={vShow(f)}
          display={vDisplay(f)}
          format={(v) => (vIsAuto(f) ? t('vil_char_auto_short') : vFormat(f, v))}
          parse={(text) => parseFloat(String(text).replace(/[^\d.+-]/g, ''))}
          tip={rowTip(f, t('s_' + f.key), vIsAuto(f) ? t('vil_char_auto') : '')}
          changed={vChanged(f)}
          dataAttr="data-vkey"
          onCommit={(v) => vRange(f, v)}
          onReset={() => vRange(f, f.def ?? f.min)}
        />
      {:else if f.ctrl === 'toggle'}
        {@const on = f.tri ? vTriOn(f) : vPlainOn(f)}
        <label
          class="row"
          class:disabled={vDisabled(f)}
          class:changed={vChanged(f)}
          title={rowTip(f, t('s_' + f.key), vDisabled(f) && f.tierHint ? t(f.tierHint) : '')}
        >
          <span class="rl cad-label">{t('s_' + f.key)}</span>
          <span class="ctl">
            {#if vDisabled(f) && f.tierHint}<span class="tierhint">{t(f.tierHint)}</span>{/if}
          </span>
          <span class="vcell">
            <input
              class="cad-check tgl"
              type="checkbox"
              data-vkey={f.key}
              aria-label={t('s_' + f.key)}
              aria-checked={on ? 'true' : 'false'}
              checked={on}
              disabled={vDisabled(f) || undefined}
              onchange={() => f.tri ? vToggleTri(f) : vTogglePlain(f)}
            />
          </span>
        </label>
      {/if}
    {/each}
  </section>
{/snippet}

{#snippet editSection(sec)}
  <section
    class="groupbody"
    class:folded={!isOpen('house', sec)}
    class:filtered={!sectionMatches(sec)}
    data-group-body={sec.id}
  >
    {#if sec.noteKey}<p class="editnote">{t(sec.noteKey)}</p>{/if}
    {#each sectionFields(sec) as f (f.key)}
      {#if f.ctrl === 'range'}
        <PropertyField
          field={f}
          label={fieldLabel(f)}
          value={showVal(f)}
          display={displayValue(f)}
          format={(v) => displayValue(f, v)}
          parse={(text) => parseValue(f, text)}
          bounds={boundsOf(f)}
          tip={rowTip(f, fieldLabel(f))}
          changed={hChanged(f)}
          onInput={(v) => range(f, v)}
          onCommit={(v) => rangeCommit(f, v)}
          onReset={hBase(f) != null ? () => resetField(f) : null}
        />
      {:else if f.ctrl === 'stepper'}
        <PropertyField
          field={f}
          label={fieldLabel(f)}
          value={showVal(f)}
          display={displayValue(f)}
          format={(v) => displayValue(f, v)}
          parse={(text) => parseValue(f, text)}
          bounds={boundsOf(f)}
          tip={rowTip(f, fieldLabel(f))}
          changed={hChanged(f)}
          onInput={(v) => { params[f.key] = v; onLive?.(f.key, v); }}
          onCommit={(v) => {
            params[f.key] = v;
            onLive?.(f.key, v);
            rangeCommit(f, v);
          }}
          onReset={hBase(f) != null ? () => resetField(f) : null}
        />
      {:else if f.ctrl === 'segment'}
        <PropertyField
          field={f}
          label={t('s_' + f.key)}
          value={params[f.key] ?? f.def}
          optionLabel={(o) => optLabel(f.key, o)}
          tip={rowTip(f, t('s_' + f.key))}
          changed={hChanged(f)}
          onPick={(o) => pick(f, o)}
        />
      {:else if f.ctrl === 'toggle'}
        <PropertyField
          field={f}
          label={t('s_' + f.key)}
          value={!!params[f.key]}
          tip={rowTip(f, t('s_' + f.key))}
          onToggle={() => toggleField(f)}
        />
      {/if}
    {/each}
  </section>
{/snippet}

<style>
  /* Layout + product structure only. Control chrome comes from ui/tokens.css. */
  .makehead {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 8px;
  }

  /* ── selection header (28px) ── */
  .selhead {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    column-gap: 6px;
    min-height: 28px;
  }
  .selbadge {
    grid-row: 1;
    padding: 2px 5px;
    border: 1px solid var(--panel-border);
    border-radius: 2px;
    background: var(--panel-inset);
    color: var(--panel-muted);
    font-size: 9px;
    font-weight: 650;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }
  .selname {
    grid-row: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 650;
    color: var(--panel-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .selpath {
    grid-column: 1 / -1;
    grid-row: 2;
    font-size: 10px;
    color: var(--panel-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Context tabs get the 2px rail (the strongest state signal in the column);
     property segments keep 1px so a tab always outranks a value. */
  .axistabs { width: 100%; --cad-seg-rail: 2px; }
  .axistabs :global(.axistab) { height: 28px; min-height: 28px; font-size: 12px; }

  /* Tool row — quiet 28px icon buttons, one hairline rule under the block. */
  .toolrow {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .toolrow .tbtn {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--cad-r);
    background: transparent;
    color: var(--panel-muted);
    cursor: pointer;
  }
  .toolrow .tbtn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .toolrow .tbtn:hover:not(:disabled) {
    color: var(--panel-text);
    background: var(--panel-hover);
    border-color: var(--panel-border);
  }
  .toolrow .tbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .toolrow .tbtn:disabled { opacity: 0.34; cursor: default; }
  .toolrow .tbtn.working { color: var(--accent); }

  /* Selector block closes the "what am I working on" chrome; the hairline is the
     boundary between chrome and properties. */
  .buildingnav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 8px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--panel-line);
  }
  .navcontrols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px;
    align-items: center;
  }
  .navcontrols select {
    min-width: 0;
    width: 100%;
    height: 24px;
    min-height: 24px;
    padding: 0 6px;
    border-radius: var(--cad-r);
    border: 1px solid var(--panel-border);
    background: var(--panel-elevated);
    color: var(--panel-text);
    font-family: var(--ui);
    font-size: 12px;
  }
  .navcontrols select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .navcontrols .navaction { min-width: 44px; height: 24px; min-height: 24px; }
  .navcontrols .navaction.unavailable,
  .navcontrols .navaction[aria-disabled='true'] { opacity: 0.4; cursor: default; }
  .navstatus {
    min-height: 1.2em;
    margin: 0;
    font-size: 10px;
    line-height: 1.2;
    color: var(--panel-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── parameter filter ── */
  .psearchrow { padding: 0 0 4px; }
  .psearch {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--panel-border);
    border-radius: var(--cad-r);
    background: var(--panel-inset);
    color: var(--panel-text);
    font-family: var(--ui);
    font-size: 11px;
  }
  .psearch::placeholder { color: var(--panel-faint); }
  .psearch:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  /* ── environment block (in-panel; never fixed — this is not the old tray) ── */
  .envblock.dial {
    position: static;
    z-index: auto;
    transform: none;
    width: auto;
    max-width: none;
    inset: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    margin: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    box-shadow: none;
    backdrop-filter: none;
  }
  .envbody { display: flex; flex-direction: column; gap: 2px; padding-bottom: 4px; }
  .envhead .envactions { display: flex; gap: 2px; margin-left: auto; }
  .dial-btn {
    width: 22px;
    min-width: 22px;
    height: 20px;
    min-height: 20px;
    padding: 0;
    color: var(--panel-muted);
  }
  .dial-btn:hover { color: var(--panel-text); }
  .dial-btn :global(svg) {
    width: 14px;
    height: 14px;
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .rk-glyph {
    display: block;
    line-height: 0;
    transition: transform 0.55s cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* Flow "on" is a border + a slow rotation of the clock, not a coloured disc. */
  .env-flow.on { border-color: var(--accent); color: var(--panel-text); }
  .env-flow.on :global(svg) { animation: orbcycle 22s linear infinite; }
  @keyframes orbcycle { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .env-flow.on :global(svg) { animation: none; }
  }
  /* Environment rows hold the widest segment labels in the column — EN
     Summer/Autumn were being ellipsised at the shared 38% label width — so this
     block trades label width for cell width. Property rows keep the 38% grid. */
  .envblock { --cad-label: 30%; }
  .row.envrow { grid-template-columns: minmax(0, var(--cad-label)) minmax(0, 1fr); }
  .row.envrow .cad-seg { justify-self: stretch; }

  .stack { display: grid; }
  .stack > .ctx {
    grid-column: 1;
    grid-row: 1;
    display: flex;
    flex-direction: column;
    gap: 0;
    transition: opacity 0.12s linear;
  }

  section { display: flex; flex-direction: column; gap: 2px; }
  section.pinned { padding: 4px 0 8px; }

  .scalewrap { position: relative; }
  /* Tier ticks read as the anchors the continuum snaps to, so they sit tight
     under the track and the current one is the only accent mark. */
  .ticks { position: relative; height: 5px; margin: -2px 0 0; }
  .tick {
    position: absolute;
    top: 0;
    width: 1px;
    height: 4px;
    margin-left: -0.5px;
    background: var(--panel-faint);
  }
  .tick.on { background: var(--accent); height: 5px; width: 1px; }
  .ends {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--panel-faint);
    padding-bottom: 2px;
  }
  input[type='range'].scale {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 14px;
    margin: 0;
    background: linear-gradient(
      to right,
      var(--accent-fill) 0 var(--fill, 0%),
      var(--track-off) var(--fill, 0%) 100%
    );
    background-size: 100% 4px;
    background-position: 0 50%;
    background-repeat: no-repeat;
    outline: none;
    cursor: ew-resize;
  }
  input[type='range'].scale::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 9px;
    height: 13px;
    border-radius: 2px;
    background: #c9c9c9;
    border: 1px solid #0e0e0e;
    cursor: ew-resize;
  }
  input[type='range'].scale::-moz-range-thumb {
    width: 9px;
    height: 13px;
    border-radius: 2px;
    background: #c9c9c9;
    border: 1px solid #0e0e0e;
    cursor: ew-resize;
  }
  input[type='range'].scale:focus-visible::-webkit-slider-thumb { border-color: var(--accent); background: #fff; }
  input[type='range'].scale:focus-visible::-moz-range-thumb { border-color: var(--accent); background: #fff; }

  .toggles { display: flex; flex-direction: column; gap: 2px; }

  /* ── group header: sticky, neutral, one row of the 4px grid ── */
  .advtoggle {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 6px;
    width: calc(100% + var(--cad-scroll-pad, 10px) * 2);
    margin: 0 calc(var(--cad-scroll-pad, 10px) * -1) 2px;
    padding: 0 var(--cad-scroll-pad, 10px);
    min-height: 20px;
    /* A sticky header must be a band, not a transparent line: on the raised #202020
       surface with a hard 1px rule, rows passing under it read as scrolled away
       instead of as half-cut rows. */
    background: var(--panel-2);
    border: none;
    border-bottom: 1px solid var(--panel-border);
    color: var(--panel-text);
    font-family: var(--ui);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
  }
  .gwrap { display: flex; flex-direction: column; margin-top: var(--cad-group-gap); }
  .gwrap.filtered { display: none; }
  .advtoggle.static { cursor: default; }
  .advtoggle.group:not(.static):hover { background: var(--panel-selected); }
  .advtoggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .advtoggle .chev {
    flex: none;
    width: 6px;
    height: 6px;
    border-right: 1px solid var(--panel-muted);
    border-bottom: 1px solid var(--panel-muted);
    transform: rotate(45deg) translate(-1px, -1px);
    transition: transform 0.14s ease;
  }
  .advtoggle:not(.open) .chev { transform: rotate(-45deg) translate(-1px, 1px); }
  .advtoggle.static .chev { display: none; }
  .advtoggle .gname { flex: 1 1 auto; min-width: 0; color: var(--panel-text); }
  .advtoggle .gval {
    flex: none;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    color: var(--panel-muted);
    font-variant-numeric: tabular-nums;
  }
  .advtoggle .gchanged {
    flex: none;
    min-width: 13px;
    height: 13px;
    padding: 0 3px;
    border-radius: 2px;
    background: var(--accent-soft);
    color: var(--accent);
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 700;
    line-height: 13px;
    text-align: center;
  }
  /* Commit cost stays honest but visually quiet: it is a note, not a button. */
  .costbadge {
    flex: none;
    padding: 1px 5px;
    border: 1px solid var(--panel-border);
    border-radius: 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 13px;
    color: #c9c9c9;
    white-space: nowrap;
  }
  .costbadge.live {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .groupbody { padding-bottom: 2px; }
  .groupbody.folded { display: none; }
  .advtoggle.filtered, .groupbody.filtered { display: none; }

  /* Type picker keeps `.tabs .tab` for app-smoke; two stacked-label segments. */
  .typetabs :global(.tab) {
    flex-direction: column;
    gap: 0;
    height: auto;
    min-height: 34px;
    padding: 4px 2px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tl { font-size: 12px; font-weight: 650; display: block; line-height: 1.3; }
  .ts { font-size: 9px; opacity: 0.62; letter-spacing: 0.04em; display: block; line-height: 1.3; }

  /* Rows owned by this component (env / village toggles) reuse the same grid. */
  .row {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, var(--cad-label)) minmax(0, 1fr) var(--cad-value);
    align-items: center;
    column-gap: var(--cad-gap);
    min-height: var(--cad-row);
  }
  /* Unavailable rows keep full opacity so the locked control stays visible and the
     row tooltip (which states the tier requirement) is still hoverable. */
  .row.disabled .rl, .row.disabled .tierhint { color: var(--panel-faint); }
  .row.changed::before {
    content: '';
    position: absolute;
    left: -6px;
    top: 4px;
    bottom: 4px;
    width: 1px;
    background: var(--accent);
  }
  .row .ctl { display: flex; align-items: center; min-width: 0; }
  .row .vcell { display: flex; align-items: center; justify-content: flex-end; padding-right: 1px; }
  .rl { min-width: 0; }
  .tierhint {
    font-size: 9px;
    color: var(--panel-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note { margin: 2px 0 6px; font-size: 11px; line-height: 1.45; color: var(--panel-faint); }
  .editnote { margin: 0 0 4px; font-size: 11px; line-height: 1.4; color: var(--panel-faint); }
  .vdetail { display: flex; flex-direction: column; gap: 2px; }
  section[data-group-body] { gap: 2px; display: flex; flex-direction: column; }
  .hero-note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px;
    border-radius: var(--cad-r-card);
    background: var(--panel-2);
    border: 1px solid var(--panel-border);
  }
  .hero-note .mark {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 2px;
    background: var(--panel-inset);
    color: var(--panel-muted);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
  }
  .hero-note p { margin: 0; font-size: 11px; line-height: 1.5; color: var(--panel-muted); }

  /* ── footer: status line + one primary ── */
  .statusbar {
    margin: 0 0 6px;
    min-height: 14px;
    font-family: var(--mono);
    font-size: 10px;
    line-height: 14px;
    color: var(--panel-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .footstack { display: grid; }
  .footstack > .foot {
    grid-column: 1;
    grid-row: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: opacity 0.12s linear;
  }
  .house-actions { display: flex; flex-direction: row; gap: 6px; width: 100%; }
  .house-actions :global(.cad-primary) { flex: 1; }

  /* ── colophon: the quietest row in the column ── */
  .colophon {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    margin-top: var(--cad-group-gap);
    padding: 8px 0 2px;
    border-top: 1px solid var(--panel-border);
  }
  .colink {
    -webkit-appearance: none;
    appearance: none;
    border: none;
    background: transparent;
    padding: 2px 0;
    font: inherit;
    font-size: 10.5px;
    line-height: 1.4;
    letter-spacing: 0.01em;
    color: var(--panel-faint);
    text-decoration: none;
    cursor: pointer;
    text-align: left;
  }
  .colink:hover, .colink:focus-visible { color: var(--accent); }
  .colink:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* A 390px-tall landscape rail cannot afford the selection header or the status
     line and still keep §4's 180px scroll window: the floating breadcrumb already
     names the selection there, so both drop out rather than squeezing the levers. */
  @media (max-height: 520px) and (orientation: landscape) {
    .selhead, .statusbar { display: none; }
  }

  @media (max-width: 600px), (pointer: coarse) {
    .makehead { gap: 4px; padding-bottom: 4px; }
    .axistabs :global(.axistab) { height: 44px; min-height: 44px; font-size: 13px; }
    .toolrow { gap: 4px; }
    .toolrow .tbtn { width: 44px; height: 44px; }
    .toolrow .tbtn svg { width: 18px; height: 18px; }
    .navcontrols select,
    .navcontrols .navaction { height: 44px; min-height: 44px; font-size: 13px; }
    .navcontrols .navaction { min-width: 72px; }
    .dial-btn { width: 44px; min-width: 44px; height: 44px; min-height: 44px; }
    .dial-btn :global(svg) { width: 18px; height: 18px; }
    .advtoggle { min-height: 32px; font-size: 13px; }
    .psearch { height: 36px; font-size: 13px; }
    .typetabs :global(.tab) { min-height: 48px; }
    .tl { font-size: 14px; }
    .ts { font-size: 10px; }
    .cad-primary { min-height: 44px; font-size: 14px; }
    /* Secondary text links: tappable without becoming a second CTA. */
    .colophon { gap: 4px 14px; padding-top: 10px; }
    .colink { min-height: 36px; display: flex; align-items: center; font-size: 12px; }
  }
</style>
