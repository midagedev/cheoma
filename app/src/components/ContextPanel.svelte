<script>
  // Inspector panel — professional CAD properties column (right dock / mobile sheet).
  //   ① Two tabs [Explore / Focus] sync camera (tab = focus-in/out). Morph crossfade kept.
  //   ② Group accordion (one body open) — every axis remains listed; only one expands.
  //   ③ Cost badges (live / settle / wave) state rebuild cost honestly.
  //   Share/export live in ActionBar; footer owns regenerate only.
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
  } = $props();

  // ── 모프 크로스페이드(원칙 2) — 마을은 먼저 빠지고 집은 뒤이어 든다. ──
  const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const villageOpacity = $derived(1 - smoothstep(0.28, 0.72, morph));
  const houseOpacity = $derived(smoothstep(0.28, 0.72, morph));
  const houseActive = $derived(morph >= 0.5);   // 포인터·손잡이 컨텍스트

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

<BottomSheet {open} gap={11} {detent} ariaLabel="make panel" {header} {footer}>
  <!-- 건물 선택기는 sticky 헤더가 아니라 스크롤 본문 최상단에 둔다(#158 P8·P1): 헤더에서 44~90px 를
       상시 점유해 가로 폰의 스크롤 창을 절반으로 깎던 원인이었다. 모프 owner 밖(컨텍스트 공통)에 남는다. -->
  {#if navigationGroups.length}
    <div class="buildingnav" data-building-navigation>
      <label class="navlabel" for="building-navigation">{t('nav_building')}</label>
      <div class="navcontrols">
        <select
          id="building-navigation"
          value={navigationDraftId}
          aria-describedby="building-navigation-status"
          onchange={(event) => (navigationDraftId = event.currentTarget.value)}
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
          class="navaction"
          type="button"
          aria-disabled={navigationActionUnavailable}
          aria-busy={navigationBusy || undefined}
          aria-label={navigationActionAccessibleLabel}
          onclick={activateNavigationTarget}
        >{navigationActionLabel}</button>
      </div>
      <p
        id="building-navigation-status"
        class="navstatus"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >{navigationStatusText}</p>
    </div>
  {/if}

  <!-- 모프 스택: 마을·집 섹션이 같은 그리드 셀에 겹쳐 crossfade. -->
  <div bind:this={stackRoot} class="stack">
    <!-- 마을 컨텍스트(부감) -->
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

    <!-- 집 컨텍스트(근접) -->
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
            <div class="tabs">
              {#each TYPES as ty}
                <button class="tab" class:on={(params.kind || spec?.kind) === ty.key} onclick={() => onType?.(ty.key)}>
                  <span class="tl">{t(ty.l)}</span>
                  <span class="ts">{t(ty.s)}</span>
                </button>
              {/each}
            </div>
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

<!-- Sticky header: context tabs only — dual "만들기/INSPECTOR" labels were chrome noise. -->
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
  </div>
{/snippet}

<!-- Footer: regenerate only (share/export owned by ActionBar) -->
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
      <button class="rebuild" onclick={() => onReroll?.()} disabled={waving} title={t('vil_reroll_tip')}>
        <span class="rk" aria-hidden="true">↻</span>{t('vil_reroll')}
      </button>
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
          <button class="hbtn reroll wide" onclick={() => onRerollHouse?.()} disabled={houseBusy} title={t('vil_reroll_house_tip')}>
            <span class="hk" aria-hidden="true">↻</span>{t('vil_reroll_house')}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

<!-- 그룹 헤더(아코디언 + 커밋 대가 배지). 동시에 하나만 펼쳐진다. -->
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
        <label class="row">
          <span class="rl">{t('s_' + f.key)}</span>
          <input type="range" data-vkey={f.key} min={f.min} max={f.max} step={f.step}
            value={vShow(f)}
            aria-label={t('s_' + f.key)} aria-valuetext={vDisplay(f)}
            onchange={(e) => vRange(f, parseFloat(e.currentTarget.value))} />
          <span class="rv">{vDisplay(f)}</span>
        </label>
      {:else if f.ctrl === 'toggle'}
        <div class="row">
          <span class="rl">{t('s_' + f.key)}{#if vDisabled(f) && f.tierHint}<span class="tierhint"> · {t(f.tierHint)}</span>{/if}</span>
          {#if f.tri}
            <button class="tgl" data-vkey={f.key} class:on={vTriOn(f)} disabled={vDisabled(f)}
              onclick={() => vToggleTri(f)} role="switch" aria-checked={vTriOn(f)} aria-label={t('s_' + f.key)}>
              <span class="knob" aria-hidden="true"></span>
            </button>
          {:else}
            <button class="tgl" data-vkey={f.key} class:on={vPlainOn(f)} disabled={vDisabled(f)}
              onclick={() => vTogglePlain(f)} role="switch" aria-checked={vPlainOn(f)} aria-label={t('s_' + f.key)}>
              <span class="knob" aria-hidden="true"></span>
            </button>
          {/if}
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
        <label class="row">
          <span class="rl">{fieldLabel(f)}{#if f.showBounds}<small class="bounds">{displayValue(f, f.min)}–{displayValue(f, f.max)}</small>{/if}</span>
          <input type="range" data-key={f.key} min={f.min} max={f.max} step={f.step}
            value={showVal(f)}
            aria-label={fieldLabel(f)} aria-valuetext={displayValue(f)}
            oninput={(e) => range(f, parseFloat(e.currentTarget.value))}
            onchange={(e) => rangeCommit(f, parseFloat(e.currentTarget.value))} />
          <span class="rv">{displayValue(f)}</span>
        </label>
      {:else if f.ctrl === 'stepper'}
        <div class="row bays" data-key={f.key}>
          <span class="rl">{fieldLabel(f)}{#if f.showBounds}<small class="bounds">{displayValue(f, f.min)}–{displayValue(f, f.max)}</small>{/if}</span>
          <div class="stepper">
            <button onclick={() => stepField(f, -1)} disabled={(showVal(f) | 0) <= f.min} aria-label={`${fieldLabel(f)} ${t('edit_less')}`}>−</button>
            <span class="num" aria-live="polite">{displayValue(f)}</span>
            <button onclick={() => stepField(f, 1)} disabled={(showVal(f) | 0) >= f.max} aria-label={`${fieldLabel(f)} ${t('edit_more')}`}>+</button>
          </div>
        </div>
      {:else if f.ctrl === 'segment'}
        <div class="row seg">
          <span class="rl">{t('s_' + f.key)}</span>
          <div class="segs">
            {#each f.options as o}
              <button class="segbtn" class:on={(params[f.key] ?? f.def) === o} onclick={() => pick(f, o)}>{optLabel(f.key, o)}</button>
            {/each}
          </div>
        </div>
      {:else if f.ctrl === 'toggle'}
        <div class="row">
          <span class="rl">{t('s_' + f.key)}</span>
          <button class="tgl" data-key={f.key} class:on={!!params[f.key]} onclick={() => toggleField(f)} role="switch" aria-checked={!!params[f.key]} aria-label={t('s_' + f.key)}>
            <span class="knob" aria-hidden="true"></span>
          </button>
          <span class="rv"></span>
        </div>
      {/if}
    {/each}
  </section>
{/snippet}

<style>
  /* ── Inspector header ── */
  .makehead { display: flex; flex-direction: column; gap: 0; padding-bottom: 10px; }
  .axistabs {
    display: grid; grid-template-columns: 1fr 1fr; gap: 3px;
    padding: 3px; border-radius: 8px;
    background: var(--panel-elevated); border: 1px solid var(--panel-border);
  }
  .axistab {
    display: flex; align-items: center; justify-content: center;
    min-height: 36px; padding: 7px 8px; border: none; border-radius: 6px;
    background: transparent; color: var(--panel-muted);
    font-family: var(--ui); letter-spacing: 0.01em;
    transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
  }
  .axistab .lab { font-size: 12.5px; font-weight: 600; }
  .axistab:hover { background: var(--panel-hover); color: var(--panel-text); }
  .axistab.on {
    background: rgba(90, 168, 224, 0.22);
    color: #fff;
    box-shadow: inset 0 0 0 1px rgba(90, 168, 224, 0.5);
  }
  .axistab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ── Building navigator ── */
  .buildingnav {
    display: flex; flex-direction: column; gap: 5px;
    padding-bottom: 10px; margin-bottom: 2px;
    border-bottom: 1px solid var(--panel-line);
  }
  .navlabel {
    font-size: 10px; font-weight: 650; letter-spacing: 0.14em;
    color: var(--panel-faint); text-transform: uppercase;
  }
  .navcontrols { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
  .navcontrols select, .navaction {
    min-height: 40px; border-radius: 6px; border: 1px solid var(--panel-border);
    background: var(--panel-elevated); color: var(--panel-text);
    font: 600 12px/1.2 var(--ui);
  }
  .navcontrols select { min-width: 0; width: 100%; padding: 7px 26px 7px 10px; color-scheme: dark; }
  .navaction {
    min-width: 64px; padding: 7px 12px;
    background: var(--accent-strong); border-color: transparent; color: #fff;
  }
  .navaction:hover[aria-disabled='false'] { filter: brightness(1.08); }
  .navaction[aria-disabled='true'] { opacity: 0.42; cursor: default; }
  .navcontrols select:focus-visible, .navaction:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .navstatus {
    min-height: 1.2em; margin: 0; font-size: 11px; line-height: 1.25;
    color: var(--panel-faint); font-variant-numeric: tabular-nums;
  }

  /* ── Morph stack ── */
  .stack { display: grid; }
  .stack > .ctx {
    grid-column: 1; grid-row: 1;
    display: flex; flex-direction: column; gap: 8px;
    transition: opacity 0.12s linear;
  }

  section { display: flex; flex-direction: column; gap: 8px; }
  section.pinned {
    padding: 10px 10px 12px;
    border-radius: 8px;
    background: var(--panel-2);
    border: 1px solid var(--panel-line);
  }
  h4 {
    margin: 0; font-size: 10px; font-weight: 650; letter-spacing: 0.14em;
    color: var(--panel-faint); text-transform: uppercase;
  }

  /* ── Village scale ── */
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
    width: 14px; height: 14px; border-radius: 2px;
    background: var(--accent); border: none;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 1px 4px rgba(0, 0, 0, 0.4);
    cursor: pointer;
  }
  input[type='range'].scale::-moz-range-thumb {
    width: 14px; height: 14px; border-radius: 2px;
    background: var(--accent); border: none; cursor: pointer;
  }
  .toggles { display: flex; gap: 6px; flex-wrap: wrap; }
  .toggle {
    flex: 1; min-width: 0;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 6px; border-radius: 6px; font-size: 12px; font-weight: 600;
    background: transparent; border: 1px solid var(--panel-border); color: var(--panel-muted);
    transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
  }
  .toggle .dot {
    width: 7px; height: 7px; border-radius: 1px;
    border: 1px solid var(--panel-faint); background: transparent;
    transition: all 0.14s ease;
  }
  .toggle:hover:not(:disabled) { background: var(--panel-hover); color: var(--panel-text); }
  .toggle.on {
    border-color: rgba(90, 168, 224, 0.45); color: var(--panel-text);
    background: var(--accent-soft);
  }
  .toggle.on .dot { background: var(--accent); border-color: var(--accent); }
  .toggle:disabled { opacity: 0.38; cursor: default; }

  /* ── Group accordion + cost badges ── */
  .advtoggle {
    position: relative;
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 8px 2px; background: transparent; border: none;
    border-top: 1px solid var(--panel-line);
    color: var(--panel-text); font-size: 11px; font-weight: 650; letter-spacing: 0.08em;
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
  /* Cost: only non-live rebuild cost is stamped. Live is the default for house
     groups — painting every row green was noisy and un-CAD. Gate still reads .costbadge. */
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
    /* Keep in DOM for contracts; visually silent so the inspector reads as defaults. */
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  .costbadge.settle {
    color: var(--settle);
    border-color: rgba(212, 176, 106, 0.3);
    background: rgba(212, 176, 106, 0.08);
    border-style: dashed;
  }

  /* ── Property rows ── */
  .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .tab {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 9px 4px; border-radius: 6px;
    background: transparent; border: 1px solid var(--panel-border); color: var(--panel-muted);
    transition: all 0.14s ease;
  }
  .tab .tl { font-size: 13px; font-weight: 650; }
  .tab .ts { font-size: 9.5px; color: var(--panel-faint); letter-spacing: 0.04em; }
  .tab:hover { background: var(--panel-hover); color: var(--panel-text); }
  .tab.on {
    background: rgba(90, 168, 224, 0.18);
    border-color: rgba(90, 168, 224, 0.55);
    color: #fff;
  }
  .tab.on .ts { color: rgba(255, 255, 255, 0.72); }
  .row {
    display: grid; grid-template-columns: 76px minmax(0, 1fr) 42px;
    align-items: center; gap: 8px; min-height: 28px;
  }
  .row.bays, .row.seg { grid-template-columns: 76px minmax(0, 1fr); }
  .rl { font-size: 12px; color: var(--panel-text); font-weight: 500; }
  .bounds {
    display: block; margin-top: 1px; color: var(--panel-faint);
    font-family: var(--mono); font-size: 9px; font-weight: 500;
  }
  .rv {
    font-family: var(--mono); font-size: 11px; color: var(--panel-muted);
    text-align: right; font-variant-numeric: tabular-nums;
  }
  .stepper { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .stepper button {
    width: 28px; height: 28px; border-radius: 5px;
    border: 1px solid var(--panel-border); background: var(--panel-elevated);
    color: var(--panel-text); font-size: 15px; line-height: 1;
    display: grid; place-items: center; transition: background 0.12s ease;
  }
  .stepper button:hover:not(:disabled) { background: var(--panel-hover); border-color: rgba(90, 168, 224, 0.35); }
  .stepper button:disabled { opacity: 0.28; cursor: default; }
  .stepper .num {
    min-width: 22px; text-align: center;
    font-family: var(--mono); font-size: 14px; font-weight: 600;
    font-variant-numeric: tabular-nums; color: var(--panel-text);
  }
  .segs { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .segbtn {
    padding: 5px 9px; border-radius: 5px; font-size: 11px; font-weight: 600;
    background: transparent; border: 1px solid var(--panel-border); color: var(--panel-muted);
    transition: all 0.12s ease; white-space: nowrap;
  }
  .segbtn:hover { background: var(--panel-hover); color: var(--panel-text); }
  .segbtn.on {
    background: var(--accent-soft); border-color: rgba(90, 168, 224, 0.4); color: var(--panel-text);
  }
  .tgl {
    justify-self: start; width: 40px; height: 22px; border-radius: 11px; padding: 0;
    border: 1px solid var(--panel-border); background: rgba(255, 255, 255, 0.06);
    position: relative; transition: all 0.14s ease;
  }
  .tgl .knob {
    position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
    background: var(--panel-text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    transition: transform 0.14s ease;
  }
  .tgl.on { background: var(--accent); border-color: var(--accent-strong); }
  .tgl.on .knob { transform: translateX(18px); background: #fff; }
  .note { margin: 0; font-size: 11px; line-height: 1.45; color: var(--panel-faint); }
  .editnote { margin: -2px 0 4px; font-size: 11px; line-height: 1.4; color: var(--panel-faint); }
  .vdetail { gap: 7px; }
  .tierhint { font-size: 9.5px; color: var(--panel-faint); font-weight: 500; }
  .hero-note {
    display: flex; gap: 10px; align-items: flex-start; padding: 12px;
    border-radius: 8px; background: var(--panel-2); border: 1px solid var(--panel-border);
  }
  .hero-note .mark {
    flex: none; display: grid; place-items: center;
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--accent-soft); color: var(--accent);
    border: 1px solid rgba(90, 168, 224, 0.35);
    font-family: var(--mono); font-size: 12px; font-weight: 700;
  }
  .hero-note p { margin: 0; font-size: 12px; line-height: 1.5; color: var(--panel-muted); }

  input[type='range'] {
    -webkit-appearance: none; appearance: none;
    height: 3px; border-radius: 1px; background: rgba(255, 255, 255, 0.12); outline: none;
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 13px; height: 13px; border-radius: 2px;
    background: var(--accent); border: none;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.35);
    cursor: pointer;
  }
  input[type='range']::-moz-range-thumb {
    width: 13px; height: 13px; border-radius: 2px;
    background: var(--accent); border: none; cursor: pointer;
  }

  /* ── Footer actions ── */
  .footstack { display: grid; }
  .footstack > .foot {
    grid-column: 1; grid-row: 1;
    display: flex; flex-direction: column; gap: 8px;
    transition: opacity 0.12s linear;
  }
  .rebuild, .hbtn.reroll {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 44px;
    padding: 11px; border-radius: 7px; font-size: 12.5px; font-weight: 650;
    background: linear-gradient(180deg, rgba(90, 168, 224, 0.28) 0%, rgba(61, 135, 196, 0.22) 100%);
    border: 1px solid rgba(90, 168, 224, 0.45);
    color: var(--panel-text);
    transition: background 0.12s ease, border-color 0.12s ease, filter 0.2s ease, box-shadow 0.12s ease;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }
  .rebuild:hover:not(:disabled), .hbtn.reroll:hover:not(:disabled) {
    background: linear-gradient(180deg, rgba(90, 168, 224, 0.4) 0%, rgba(61, 135, 196, 0.32) 100%);
    border-color: rgba(90, 168, 224, 0.65);
    box-shadow: 0 0 0 1px rgba(90, 168, 224, 0.15);
  }
  .rebuild:disabled, .hbtn:disabled { opacity: 0.45; cursor: default; filter: none; box-shadow: none; }
  .rebuild .rk, .hbtn .hk {
    font-family: var(--mono); font-size: 14px; color: #9fd0f0;
  }
  .house-actions { display: flex; flex-direction: row; gap: 8px; }
  .hbtn {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px;
    min-height: 44px;
    padding: 11px; border-radius: 7px; font-size: 12.5px; font-weight: 650;
  }
  .hbtn:focus-visible, .rebuild:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }

  @media (max-width: 600px), (pointer: coarse) {
    .axistab { min-height: 44px; }
    .axistab .lab { font-size: 14px; }
    .navcontrols select, .navaction { min-height: 44px; font-size: 14px; }
    .navaction { min-width: 74px; }
    .scaleval { font-size: 15px; }
    .toggle { padding: 12px 6px; font-size: 13.5px; }
    .rebuild, .hbtn { min-height: 44px; padding: 12px; font-size: 14px; }
    .advtoggle { min-height: 44px; font-size: 12px; }
    .makehead { padding-bottom: 6px; }
    .buildingnav { padding-bottom: 6px; gap: 4px; }
    input[type='range'].scale { height: 4px; }
    input[type='range'].scale::-webkit-slider-thumb { width: 22px; height: 22px; border-radius: 3px; }
    input[type='range'].scale::-moz-range-thumb { width: 22px; height: 22px; border-radius: 3px; }
    .tab { padding: 12px 2px; }
    .tab .tl { font-size: 14px; }
    .stepper { gap: 14px; }
    .stepper button { width: 40px; height: 40px; font-size: 18px; border-radius: 8px; }
    .stepper .num { min-width: 24px; font-size: 16px; }
    .row { min-height: 40px; }
    .segbtn { padding: 9px 11px; font-size: 12.5px; }
    .tgl { width: 52px; height: 30px; border-radius: 15px; }
    .tgl .knob { width: 24px; height: 24px; }
    .tgl.on .knob { transform: translateX(22px); }
    input[type='range'] { height: 4px; }
    input[type='range']::-webkit-slider-thumb { width: 22px; height: 22px; border-radius: 3px; }
    input[type='range']::-moz-range-thumb { width: 22px; height: 22px; border-radius: 3px; }
  }
  @media (max-height: 520px) and (orientation: landscape) {
    .navlabel { font-size: 9px; }
    .row { min-height: 34px; }
    section.pinned { padding: 8px; }
    .makehead { padding-bottom: 6px; }
  }
</style>
