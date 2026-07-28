<script>
  // Inspector — Spectrum tool column (right dock / mobile sheet).
  //   docs/design-system.md: Explore/Focus tabs, PropertyField rows, cost accordion,
  //   sticky rebuild. Morph crossfade + gate hooks preserved.
  import { tick } from 'svelte';
  import { t } from '../lib/i18n.svelte.js';
  import {
    buildingNavigationStatus,
    groupBuildingNavigationTargets,
    normalizeBuildingNavigationTargets,
    resolveBuildingNavigationTarget,
  } from '../lib/building-navigation.js';
  import { schemaFor, villageSchema } from '../lib/edit-schema.js';
  import BottomSheet from './BottomSheet.svelte';
  import PropertyField from '../ui/PropertyField.svelte';

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
    // 키보드 건물 탐색(#114·#158 P8): 랜드마크/집 그룹 + 상한 20(선택 대상은 항상 포함).
    navigationTargets = [], navigationSelectedId = null, navigationBusy = false,
    onNavigateTarget = null,
    // Secondary tools — sticky under tabs (not the floating dock / not peek-only grip).
    onPostcard = null, onShare = null, onExport = null,
    exporting = false, busy = false,
  } = $props();

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

  // ── 그룹 아코디언(동시 1개 펼침) ──
  const vSections = villageSchema();
  const schema = $derived(schemaFor(spec));
  const editable = $derived(!!spec && spec.editable === true);
  // 기본 펼침 = 각 컨텍스트의 첫 그룹. 사용자 지시("고급설정 숨기지 말 것")는 *전 축 노출* 요구이므로
  // 축은 모두 남아 있고, 한 번에 한 그룹만 펼쳐 폴드 초과만 없앤다.
  let openVillageGroup = $state(vSections[0]?.id || null);
  let openHouseGroup = $state(null);
  // 스키마 정체성(유형·컴파운드 가족)이 바뀌면 첫 그룹으로 되돌린다 — 사라진 그룹이 열린 채로 남지 않게.
  let observedSchemaKey = null;
  $effect(() => {
    const key = `${schema.family}:${schema.kind || schema.heroStyle || ''}:${schema.sections.map((s) => s.id).join(',')}`;
    if (observedSchemaKey === key) return;
    observedSchemaKey = key;
    openHouseGroup = schema.sections[0]?.id || null;
  });
  const toggleVillageGroup = (id) => { openVillageGroup = openVillageGroup === id ? null : id; };
  const toggleHouseGroup = (id) => { openHouseGroup = openHouseGroup === id ? null : id; };

  const TYPES = [
    { key: 'giwa', l: 'type_giwa_l', s: 'type_giwa_s' },
    { key: 'choga', l: 'type_choga_l', s: 'type_choga_s' },
  ];

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
  const vDisplay = (f) => (vIsAuto(f) ? t('vil_char_auto') : Number(vShow(f)).toFixed(2));
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
  const displayValue = (f, value = showVal(f)) => f.format === 'percent'
    ? `${Math.round(Number(value) * 100)}%`
    : f.unitKey
      ? `${Number(value) | 0}${t(f.unitKey)}`
      : Number(value).toFixed(2);
  const fieldLabel = (f) => t('s_' + f.key);
  // Geometry-backed ranges stream through onLive (scheduler → live preview).
  // Discrete controls fire live+commit so the house never waits for pointer-up
  // of a non-drag control. Pointer release is flora/pick/clamp reconciliation.
  function range(f, value) { params[f.key] = value; onLive?.(f.key, value); }
  function rangeCommit(f, value) { params[f.key] = value; onCommit?.(f.key, value); }
  function stepField(f, dir) {
    const cur = typeof params[f.key] === 'number' ? params[f.key] : (f.def ?? f.min);
    const v = Math.max(f.min, Math.min(f.max, (cur | 0) + dir));
    params[f.key] = v;
    onLive?.(f.key, v);
    onCommit?.(f.key, v);
  }
  function pick(f, value) { params[f.key] = value; onLive?.(f.key, value); onCommit?.(f.key, value); }
  function toggleField(f) {
    const v = !params[f.key];
    params[f.key] = v;
    onLive?.(f.key, v);
    onCommit?.(f.key, v);
  }
  const optLabel = (key, o) => t((key === 'wallType' ? 'wall_'
    : key === 'doorPattern' ? 'door_'
    : key === 'planShape' ? 'step_'
    : key === 'variant' ? 'temple_variant_'
    : key === 'pagoda' ? 'temple_pagoda_'
    : '') + o);
</script>

<BottomSheet {open} gap={7} {detent} ariaLabel="make panel" {header} {footer}>
  {#if navigationGroups.length}
    <div class="buildingnav" data-building-navigation>
      <sp-field-label class="navlabel" for="building-navigation" size="s">{t('nav_building')}</sp-field-label>
      <div class="navcontrols">
        <sp-picker
          id="building-navigation"
          value={navigationDraftId}
          label={t('nav_building')}
          quiet
          size="m"
          onchange={(e) => { navigationDraftId = e.currentTarget.value; }}
        >
          {#each navigationGroups as group (group.id)}
            <sp-menu-group label={navigationGroupLabel(group)}>
              {#each group.targets as target (target.id)}
                <sp-menu-item value={target.id}>{navigationTargetLabel(target)}</sp-menu-item>
              {/each}
            </sp-menu-group>
          {/each}
        </sp-picker>
        <sp-button
          class="navaction"
          variant={navigationActionUnavailable ? 'secondary' : 'accent'}
          treatment={navigationActionUnavailable ? 'outline' : 'fill'}
          size="m"
          disabled={navigationActionUnavailable || undefined}
          aria-label={navigationActionAccessibleLabel}
          onclick={activateNavigationTarget}
        >{navigationActionLabel}</sp-button>
      </div>
      <sp-help-text id="building-navigation-status" size="s">{navigationStatusText}</sp-help-text>
    </div>
  {/if}

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
      <section class="pinned">
        <div class="scalehead">
          <h4>{t('vil_scale')}</h4>
          <span class="scaleval">{t('scale_' + shownAnchor)}</span>
        </div>
        <input
          class="scale" type="range" min="0" max={SCALES.length - 1} step="0.01"
          value={shownVal}
          oninput={(e) => slideInput(parseFloat(e.currentTarget.value))}
          onchange={(e) => slideCommit(parseFloat(e.currentTarget.value))}
          aria-label={t('vil_scale')}
          aria-valuetext={t('scale_' + shownAnchor)}
        />
        <div class="ends"><span>{t('scale_solo')}</span><span>{t('scale_hanyang')}</span></div>
        <div class="toggles">
          <button class="toggle" class:on={includePalace} disabled={!palaceScale}
            onclick={() => onPalace?.()} title={!palaceScale ? t('vil_palace_hint') : ''}
            aria-pressed={includePalace}>
            <span class="dot" aria-hidden="true"></span>{t('vil_palace')}
          </button>
          <button class="toggle" class:on={includeTemple} onclick={() => onTemple?.()}
            aria-pressed={includeTemple}>
            <span class="dot" aria-hidden="true"></span>{t('vil_temple')}
          </button>
          {#if shownAnchor === 'solo' && onVillageOpt}
            <button class="toggle" class:on={villageParams.houses === 0}
              aria-pressed={villageParams.houses === 0}
              onclick={() => onVillageOpt('houses', villageParams.houses === 0 ? null : 0)}>
              <span class="dot" aria-hidden="true"></span>{t('vil_nohouse')}
            </button>
          {/if}
        </div>
      </section>

      {#if onVillageOpt}
        {#each vSections as vsec (vsec.id)}
          {@render groupHeader(vsec, openVillageGroup === vsec.id, () => toggleVillageGroup(vsec.id))}
          {#if openVillageGroup === vsec.id}{@render villageSection(vsec)}{/if}
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
          <section class="pinned">
            <h4>{t('sec_type')}</h4>
            <sp-action-group class="typetabs" selects="single" compact>
              {#each TYPES as ty}
                <sp-action-button
                  class="tab"
                  value={ty.key}
                  selected={(params.kind || spec?.kind) === ty.key || undefined}
                  onclick={() => onType?.(ty.key)}
                >
                  <span class="tl">{t(ty.l)}</span>
                  <span class="ts">{t(ty.s)}</span>
                </sp-action-button>
              {/each}
            </sp-action-group>
          </section>
        {/if}

        {#each schema.sections as sec (sec.id)}
          {@render groupHeader(sec, openHouseGroup === sec.id, () => toggleHouseGroup(sec.id))}
          {#if openHouseGroup === sec.id}{@render editSection(sec)}{/if}
        {/each}
      {:else if spec}
        <div class="hero-note">
          <span class="mark" aria-hidden="true">i</span>
          <p>{t('vil_hero_note')}</p>
        </div>
      {/if}
    </div>
  </div>
</BottomSheet>

{#snippet header()}
  <div class="makehead">
    <div class="axistabs" role="tablist" aria-label={t('axis_make')}>
      <button
        id="make-tab-village"
        class="axistab" class:on={!houseActive}
        type="button"
        role="tab"
        aria-selected={!houseActive}
        aria-busy={tabBusy || undefined}
        title={t('mode_to_village')}
        onclick={() => onTab?.('village')}
      >
        <span class="lab">{t('mode_village')}</span>
      </button>
      <button
        id="make-tab-house"
        class="axistab" class:on={houseActive}
        type="button"
        role="tab"
        aria-selected={houseActive}
        aria-busy={tabBusy || undefined}
        title={t('mode_to_house')}
        onclick={() => onTab?.('house')}
      >
        <span class="lab">{t('mode_house')}</span>
      </button>
    </div>
    {#if hasShareTools}
      <div class="toolrow" role="group" aria-label={t('axis_share')}>
        {#if onPostcard}
          <sp-action-button
            class="tbtn"
            quiet
            data-action="postcard"
            disabled={busy || undefined}
            title={t('act_postcard_tip')}
            onclick={() => onPostcard?.()}
          >{t('act_postcard')}</sp-action-button>
        {/if}
        {#if onShare}
          <sp-action-button
            class="tbtn"
            quiet
            data-action="share"
            disabled={busy || undefined}
            title={t('act_share_tip')}
            onclick={() => onShare?.()}
          >{t('act_share')}</sp-action-button>
        {/if}
        {#if onExport}
          <sp-action-button
            class="tbtn"
            quiet
            data-action="export"
            disabled={exporting || busy || undefined}
            title={exportTip}
            onclick={() => onExport?.()}
          >{exportLabel}</sp-action-button>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet footer()}
  <div bind:this={footerRoot} class="footstack">
    <div
      class="foot village"
      style="opacity:{villageOpacity}"
      style:pointer-events={houseActive ? 'none' : 'auto'}
      aria-hidden={houseActive}
      inert={houseActive}
      data-context-owner="village"
    >
      <sp-button class="rebuild" variant="accent" treatment="fill" size="l" disabled={waving || undefined} onclick={() => onReroll?.()}>
        {t('vil_reroll')}
      </sp-button>
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
          <sp-button class="hbtn reroll wide" variant="accent" treatment="fill" size="l" disabled={houseBusy || undefined} onclick={() => onRerollHouse?.()}>
            {t('vil_reroll_house')}
          </sp-button>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet groupHeader(sec, isOpen, toggle)}
  <button
    class="advtoggle group"
    class:open={isOpen}
    type="button"
    data-group={sec.id}
    aria-expanded={isOpen}
    onclick={toggle}
  >
    <span class="chev" aria-hidden="true">{isOpen ? '−' : '+'}</span>
    <span class="gname">{t(sec.titleKey)}</span>
    <span class="costbadge {sec.cost}" data-cost={sec.cost} title={t('cost_' + sec.cost + '_tip')}>{t('cost_' + sec.cost)}</span>
  </button>
{/snippet}

{#snippet villageSection(vsec)}
  <section class="vdetail" data-group-body={vsec.id}>
    {#each vsec.fields as f (f.key)}
      {#if f.ctrl === 'range'}
        <PropertyField
          field={f}
          label={t('s_' + f.key)}
          value={vShow(f)}
          display={vDisplay(f)}
          dataAttr="data-vkey"
          onCommit={(v) => vRange(f, v)}
        />
      {:else if f.ctrl === 'toggle'}
        <div class="row" class:disabled={vDisabled(f)} data-vkey={f.key}>
          <span class="rl">{t('s_' + f.key)}{#if vDisabled(f) && f.tierHint}<span class="tierhint"> · {t(f.tierHint)}</span>{/if}</span>
          <sp-switch
            class="tgl"
            emphasized
            data-vkey={f.key}
            checked={(f.tri ? vTriOn(f) : vPlainOn(f)) || undefined}
            disabled={vDisabled(f) || undefined}
            onchange={() => f.tri ? vToggleTri(f) : vTogglePlain(f)}
          ></sp-switch>
          <span class="rv"></span>
        </div>
      {/if}
    {/each}
  </section>
{/snippet}

{#snippet editSection(sec)}
  <section data-group-body={sec.id}>
    {#if sec.noteKey}<p class="editnote">{t(sec.noteKey)}</p>{/if}
    {#each sec.fields as f (f.key)}
      {#if f.ctrl === 'range'}
        <PropertyField
          field={f}
          label={fieldLabel(f)}
          value={showVal(f)}
          display={displayValue(f)}
          bounds={f.showBounds ? `${displayValue(f, f.min)}–${displayValue(f, f.max)}` : ''}
          onInput={(v) => range(f, v)}
          onCommit={(v) => rangeCommit(f, v)}
        />
      {:else if f.ctrl === 'stepper'}
        <PropertyField
          field={f}
          label={fieldLabel(f)}
          value={showVal(f)}
          display={displayValue(f)}
          bounds={f.showBounds ? `${displayValue(f, f.min)}–${displayValue(f, f.max)}` : ''}
          onInput={(v) => { params[f.key] = v; onLive?.(f.key, v); }}
          onCommit={(v) => {
            params[f.key] = v;
            onLive?.(f.key, v);
            rangeCommit(f, v);
          }}
        />
      {:else if f.ctrl === 'segment'}
        <PropertyField
          field={f}
          label={t('s_' + f.key)}
          value={params[f.key] ?? f.def}
          optionLabel={(o) => optLabel(f.key, o)}
          onPick={(o) => pick(f, o)}
        />
      {:else if f.ctrl === 'toggle'}
        <PropertyField
          field={f}
          label={t('s_' + f.key)}
          value={!!params[f.key]}
          onToggle={() => toggleField(f)}
        />
      {/if}
    {/each}
  </section>
{/snippet}

<style>
  .makehead { display: flex; flex-direction: column; gap: 6px; padding-bottom: 6px; }
  .axistabs {
    display: grid; grid-template-columns: 1fr 1fr; gap: 2px;
    padding: 2px; border-radius: 7px;
    background: rgba(0, 0, 0, 0.28); border: 1px solid var(--panel-border);
  }
  .axistab {
    display: flex; align-items: center; justify-content: center;
    min-height: 34px; padding: 6px; border: none; border-radius: 5px;
    background: transparent; color: var(--panel-muted);
    font-family: var(--ui); letter-spacing: 0.01em;
    transition: background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
  }
  .axistab .lab { font-size: 12px; font-weight: 650; }
  .axistab:hover { background: var(--panel-hover); color: var(--panel-text); }
  .axistab.on {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
    color: #fff;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 48%, transparent);
  }
  .axistab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .buildingnav {
    display: flex; flex-direction: column; gap: 4px;
    padding-bottom: 8px; margin-bottom: 2px;
    border-bottom: 1px solid var(--panel-line);
  }
  .navlabel {
    font-size: 9.5px; font-weight: 650; letter-spacing: 0.12em;
    color: var(--panel-faint); text-transform: uppercase;
  }
  .navcontrols {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; align-items: center;
  }
  .navcontrols :global(sp-picker) { min-width: 0; width: 100%; }
  .navcontrols :global(sp-button.navaction) { min-width: 58px; min-height: 36px; }
  .navstatus, .buildingnav :global(sp-help-text) {
    min-height: 1.2em; margin: 0; font-size: 11px; line-height: 1.25;
    color: var(--panel-faint); font-variant-numeric: tabular-nums;
  }

  .stack { display: grid; }
  .stack > .ctx {
    grid-column: 1; grid-row: 1;
    display: flex; flex-direction: column; gap: 8px;
    transition: opacity 0.12s linear;
  }

  section { display: flex; flex-direction: column; gap: 6px; }
  section.pinned {
    padding: 8px 9px 10px; border-radius: 7px;
    background: var(--panel-2); border: 1px solid var(--panel-line);
  }
  h4 {
    margin: 0; font-size: 9.5px; font-weight: 650; letter-spacing: 0.12em;
    color: var(--panel-faint); text-transform: uppercase;
  }

  .scalehead { display: flex; align-items: baseline; justify-content: space-between; }
  .scaleval {
    font-size: 13px; font-weight: 650; color: var(--panel-text);
    font-variant-numeric: tabular-nums;
  }
  .ends {
    display: flex; justify-content: space-between;
    font-size: 10px; color: var(--panel-faint); letter-spacing: 0.02em;
  }
  input[type='range'].scale {
    -webkit-appearance: none; appearance: none; width: 100%;
    height: 3px; border-radius: 1px; background: rgba(255, 255, 255, 0.12); outline: none;
  }
  input[type='range'].scale::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 12px; height: 16px; border-radius: 2px;
    background: var(--accent); border: none;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.35);
    cursor: pointer;
  }
  input[type='range'].scale::-moz-range-thumb {
    width: 12px; height: 16px; border-radius: 2px;
    background: var(--accent); border: none; cursor: pointer;
  }
  .toggles { display: flex; gap: 4px; flex-wrap: wrap; }
  .toggle {
    flex: 1; min-width: 0;
    display: flex; align-items: center; justify-content: center; gap: 5px;
    padding: 7px 5px; border-radius: 5px; font-size: 11.5px; font-weight: 600;
    background: transparent; border: 1px solid var(--panel-border); color: var(--panel-muted);
  }
  .toggle .dot {
    width: 7px; height: 7px; border-radius: 1px;
    border: 1px solid var(--panel-faint); background: transparent;
  }
  .toggle:hover:not(:disabled) { background: var(--panel-hover); color: var(--panel-text); }
  .toggle.on {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--panel-text); background: var(--accent-soft);
  }
  .toggle.on .dot { background: var(--accent); border-color: var(--accent); }
  .toggle:disabled { opacity: 0.38; cursor: default; }

  .advtoggle {
    position: relative;
    display: flex; align-items: center; gap: 7px; width: 100%;
    padding: 7px 2px; background: transparent; border: none;
    border-top: 1px solid var(--panel-line);
    color: var(--panel-text); font-size: 10.5px; font-weight: 650; letter-spacing: 0.07em;
    text-transform: uppercase; cursor: pointer; text-align: left;
  }
  .advtoggle:hover { color: var(--accent); }
  .advtoggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .advtoggle .chev {
    flex: none; display: grid; place-items: center;
    width: 16px; height: 16px; border-radius: 3px;
    border: 1px solid var(--panel-border); font-size: 12px; line-height: 1;
    color: var(--panel-muted); background: var(--panel-elevated);
  }
  .advtoggle .gname { flex: 1 1 auto; min-width: 0; }
  .advtoggle.open .gname { color: var(--accent); }
  .costbadge {
    flex: none; padding: 2px 6px; border-radius: 3px;
    font-family: var(--mono); font-size: 9px; font-weight: 600;
    letter-spacing: 0.04em; text-transform: none;
    border: 1px solid var(--panel-border); color: var(--panel-faint);
    background: rgba(255, 255, 255, 0.03);
  }
  .costbadge.wave {
    color: #e0a090;
    border-color: rgba(224, 160, 144, 0.28);
    background: rgba(224, 140, 120, 0.08);
  }
  .costbadge.live {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  .costbadge.settle {
    color: var(--settle);
    border-color: rgba(212, 176, 106, 0.3);
    background: rgba(212, 176, 106, 0.08);
    border-style: dashed;
  }

  :global(.typetabs) { width: 100%; display: grid !important; grid-template-columns: 1fr 1fr; gap: 6px; }
  :global(.typetabs sp-action-button.tab) {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    min-height: 44px; height: auto; padding: 9px 4px;
  }
  .tl { font-size: 13px; font-weight: 650; display: block; }
  .ts { font-size: 9.5px; opacity: 0.7; letter-spacing: 0.04em; display: block; }

  .row {
    display: grid; grid-template-columns: 72px minmax(0, 1fr) 40px;
    align-items: center; gap: 7px; min-height: 26px;
  }
  .row.disabled { opacity: 0.45; pointer-events: none; }
  .rl { font-size: 11.5px; color: var(--panel-text); font-weight: 500; }
  .rv {
    font-family: var(--mono); font-size: 11px; color: var(--panel-muted);
    text-align: right; font-variant-numeric: tabular-nums;
  }
  .note { margin: 0; font-size: 11px; line-height: 1.45; color: var(--panel-faint); }
  .editnote { margin: -2px 0 4px; font-size: 11px; line-height: 1.4; color: var(--panel-faint); }
  .vdetail { gap: 7px; display: flex; flex-direction: column; }
  .tierhint { font-size: 9.5px; color: var(--panel-faint); font-weight: 500; }
  .hero-note {
    display: flex; gap: 10px; align-items: flex-start; padding: 12px;
    border-radius: 8px; background: var(--panel-2); border: 1px solid var(--panel-border);
  }
  .hero-note .mark {
    flex: none; display: grid; place-items: center;
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--accent-soft); color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    font-family: var(--mono); font-size: 12px; font-weight: 700;
  }
  .hero-note p { margin: 0; font-size: 12px; line-height: 1.5; color: var(--panel-muted); }

  .toolrow {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: 0;
    border-bottom: 1px solid var(--panel-line);
    margin: 0 0 2px;
  }
  .toolrow :global(sp-action-button.tbtn) {
    min-height: 32px; width: 100%; border-radius: 0;
    border-right: 1px solid var(--panel-line);
    --mod-actionbutton-border-radius: 0;
  }
  .toolrow :global(sp-action-button.tbtn:last-child) { border-right: none; }

  .footstack { display: grid; }
  .footstack > .foot {
    grid-column: 1; grid-row: 1;
    display: flex; flex-direction: column; gap: 8px;
    transition: opacity 0.12s linear;
  }
  .foot :global(sp-button.rebuild),
  .foot :global(sp-button.hbtn) {
    width: 100%; min-height: 44px;
  }
  .house-actions { display: flex; flex-direction: row; gap: 8px; width: 100%; }
  .house-actions :global(sp-button) { flex: 1; }

  @media (max-width: 600px), (pointer: coarse) {
    .axistab { min-height: 44px; }
    .axistab .lab { font-size: 13px; }
    .navcontrols :global(sp-picker),
    .navcontrols :global(sp-button.navaction) { min-height: 44px; }
    .navcontrols :global(sp-button.navaction) { min-width: 72px; }
    .toggle { padding: 9px 5px; font-size: 12px; min-height: 40px; }
    .toolrow :global(sp-action-button.tbtn) { min-height: 44px; }
    .advtoggle { min-height: 40px; font-size: 11.5px; }
    .makehead { padding-bottom: 4px; gap: 6px; }
    .buildingnav { padding-bottom: 4px; gap: 3px; margin-bottom: 0; }
    .stack > .ctx { gap: 4px; }
    section { gap: 4px; }
    section.pinned { padding: 7px 8px 8px; }
    .vdetail { gap: 3px; }
    input[type='range'].scale::-webkit-slider-thumb { width: 20px; height: 20px; border-radius: 3px; }
    input[type='range'].scale::-moz-range-thumb { width: 20px; height: 20px; border-radius: 3px; }
    .row { min-height: 34px; grid-template-columns: 70px minmax(0, 1fr) 38px; }
    .editnote, .note { font-size: 10px; }
  }
  @media (max-height: 520px) and (orientation: landscape) {
    .makehead { padding-bottom: 6px; }
    section.pinned { padding: 8px; }
  }
</style>
