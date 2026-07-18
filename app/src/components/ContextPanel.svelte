<script>
  // 단일 컨텍스트 패널(#92, mode-integration §5.5 원칙 2) — VillagePanel + VillageEditPanel 을 하나로.
  //   헤더 브레드크럼(마을 → 필지 유형), 부감=마을 섹션(규모·궁·절·다시 짓기), 근접=집 섹션(스키마 주도)이
  //   같은 패널 안에서 crossfade 모프한다. 모프 진행 morph(0=마을·1=집)는 App 이 카메라 focus 트윈 진행에서
  //   흘려받아(engine onProgress) 카메라·DoF·링과 한 클록으로 그린다(원칙 3). 패널은 마을 씬에서 상주
  //   (히어로 랜딩 중엔 App 이 open=false 로 숨김).
  import { t } from '../lib/i18n.svelte.js';
  import { schemaFor, villageSchema } from '../lib/edit-schema.js';
  import BottomSheet from './BottomSheet.svelte';

  let {
    open = false, morph = 0, detent = null,
    // 마을 섹션(부감)
    scale = 'village', includePalace = false, includeTemple = false, houses = 0,
    onScale, onPalace, onTemple, onReroll, waving = false,
    // 마을 상세 파라미터(#91) — 지형·구성·어휘. villageParams 는 App villageOpts 서브셋, onVillageOpt(key,value) 커밋.
    villageParams = {}, onVillageOpt = null,
    // 집 섹션(근접)
    spec = null, params = {}, onType, onLive, onCommit, onReplay, onRerollHouse, houseBusy = false,
    // glb 내보내기(#112) — onExportVillage(부감 전체)·onExportHouse(focus 건물)·exporting(스피너·중복 방지)
    onExportVillage = null, onExportHouse = null, exporting = false,
    // 공통
    onBack,
  } = $props();

  // ── 모프 크로스페이드(원칙 2) — 마을은 먼저 빠지고 집은 뒤이어 든다(0.4~0.6 겹침). ──
  const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // 겹침 넓게(0.28~0.72) — 중간 진행에서 두 섹션이 함께 비쳐 crossfade 로 읽히게(빈 골짜기 방지).
  const villageOpacity = $derived(1 - smoothstep(0.28, 0.72, morph));
  const houseOpacity = $derived(smoothstep(0.28, 0.72, morph));
  const houseActive = $derived(morph >= 0.5);   // 포인터·손잡이 컨텍스트

  // ── 브레드크럼 ──
  const houseLabel = $derived.by(() => {
    if (!spec) return '';
    if (spec.family === 'palace-compound') return t('crumb_palace_compound');   // 궁궐(#93)
    if (spec.hero) return t(spec.heroStyle === 'hanok' ? 'crumb_hanok' : 'crumb_palace');
    const k = params.kind || spec.kind;
    return t(k === 'giwa' ? 'type_giwa_l' : 'type_choga_l');
  });

  // ── 마을 규모 슬라이더(기존 VillagePanel 계약 그대로) ──
  //   'solo'(#114) = 외딴집(집 한 채, siteR30). 절 토글과 조합하면 "산사 하나만" 구성.
  const SCALES = ['solo', 'hamlet', 'village', 'town', 'capital', 'hanyang'];
  const idx = $derived(Math.max(0, SCALES.indexOf(scale)));
  let dragVal = $state(null);
  const shownVal = $derived(dragVal != null ? dragVal : idx);
  const shownAnchor = $derived(SCALES[Math.round(shownVal)]);
  const palaceScale = $derived(shownAnchor === 'capital' || shownAnchor === 'hanyang');
  function slideInput(v) { dragVal = v; }
  function slideCommit(v) { dragVal = null; const a = SCALES[Math.round(v)]; if (a !== scale) onScale?.(a); }

  // ── 마을 상세 파라미터(#91) — 지형·구성·어휘 스키마 렌더 + 커밋(라이브 없음 = 재생성 파라미터) ──
  const vSections = villageSchema();
  let showVDetail = $state(true);   // 기본 펼침(사용자 지시 2026-07-19: 고급설정 숨기지 말 것)
  const scaleIdx = $derived(Math.max(0, SCALES.indexOf(scale)));
  // range 표시값: 코어 no-op 기본(def) 을 fallback. char01(auto) 은 값이 null 이면 def 로 표시하되 미전송.
  const vShow = (f) => (typeof villageParams[f.key] === 'number' ? villageParams[f.key] : (f.def ?? f.min));
  const vIsAuto = (f) => f.auto === true && typeof villageParams[f.key] !== 'number';
  // tri-state(cityWall·sijeon) 켜짐 판정 — true 강제 or ('auto' 이고 hanyang tier). 표시·클릭 방향에 사용.
  const vTriOn = (f) => { const v = villageParams[f.key]; return v === true || ((v == null || v === 'auto') && scale === 'hanyang'); };
  const vPlainOn = (f) => villageParams[f.key] !== false;   // stream: 기본 true
  const vDisabled = (f) => f.tierGate === 'capital' && scaleIdx < SCALES.indexOf('capital');
  function vRange(f, value) { onVillageOpt?.(f.key, value); }
  function vToggleTri(f) { onVillageOpt?.(f.key, vTriOn(f) ? false : true); }   // 강제 ON/OFF(‘auto’ 이탈)
  function vTogglePlain(f) { onVillageOpt?.(f.key, !vPlainOn(f)); }

  // ── 집 편집 스키마(기존 VillageEditPanel 계약 그대로) ──
  const editable = $derived(!!spec && spec.editable === true);
  const schema = $derived(schemaFor(spec));
  const basic = $derived(schema.sections.filter((s) => !s.adv));
  const adv = $derived(schema.sections.filter((s) => s.adv));
  let showAdv = $state(true);   // 기본 펼침(사용자 지시 2026-07-19)
  const TYPES = [
    { key: 'giwa', l: 'type_giwa_l', s: 'type_giwa_s' },
    { key: 'choga', l: 'type_choga_l', s: 'type_choga_s' },
  ];
  const showVal = (f) => (typeof params[f.key] === 'number' ? params[f.key] : f.min);
  function range(f, value) { params[f.key] = value; onLive?.(f.key, value); }
  function rangeCommit(f, value) { params[f.key] = value; onCommit?.(f.key, value); }
  function stepField(f, dir) {
    const cur = typeof params[f.key] === 'number' ? params[f.key] : f.min;
    const v = Math.max(f.min, Math.min(f.max, (cur | 0) + dir));
    params[f.key] = v; onCommit?.(f.key, v);
  }
  function pick(f, value) { params[f.key] = value; onCommit?.(f.key, value); }
  function toggleField(f) { const v = !params[f.key]; params[f.key] = v; onCommit?.(f.key, v); }
  const optLabel = (key, o) => t((key === 'wallType' ? 'wall_' : key === 'doorPattern' ? 'door_' : '') + o);
</script>

<BottomSheet {open} variant="context" closable={false} gap={13} {detent} ariaLabel="context panel">
  <!-- 브레드크럼: 마을 → 필지. 집 컨텍스트에서 '마을'을 누르면 focus-out. -->
  <div class="crumbs">
    <button
      class="crumb root" class:link={houseActive}
      onclick={() => { if (houseActive) onBack?.(); }}
      aria-label={t('vil_title')}
    >{t('vil_title')}</button>
    <span class="sep" style="opacity:{houseOpacity}" aria-hidden="true">›</span>
    <span class="crumb leaf" style="opacity:{houseOpacity}">{houseLabel}</span>
    {#if !houseActive && houses > 0}<span class="count">{houses}{t('vil_houses')}</span>{/if}
  </div>

  <!-- 모프 스택: 마을·집 섹션이 같은 그리드 셀에 겹쳐 crossfade. -->
  <div class="stack">
    <!-- 마을 섹션(부감) -->
    <div
      class="ctx village"
      style="opacity:{villageOpacity}; transform: translateY({-8 * morph}px);"
      style:pointer-events={houseActive ? 'none' : 'auto'}
      aria-hidden={houseActive}
    >
      <section>
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
        />
        <div class="ends"><span>{t('scale_solo')}</span><span>{t('scale_hanyang')}</span></div>
      </section>

      <section>
        <div class="toggles">
          <button class="toggle" class:on={includePalace} disabled={!palaceScale}
            onclick={() => onPalace?.()} title={!palaceScale ? t('vil_palace_hint') : ''}>
            <span class="dot" aria-hidden="true"></span>{t('vil_palace')}
          </button>
          <button class="toggle" class:on={includeTemple} onclick={() => onTemple?.()}>
            <span class="dot" aria-hidden="true"></span>{t('vil_temple')}
          </button>
          <!-- 외딴집(#114)에서만: 집 없이 = 빈 산세/절 하나만(절 토글과 조합) -->
          {#if shownAnchor === 'solo' && onVillageOpt}
            <button class="toggle" class:on={villageParams.houses === 0}
              onclick={() => onVillageOpt('houses', villageParams.houses === 0 ? null : 0)}>
              <span class="dot" aria-hidden="true"></span>{t('vil_nohouse')}
            </button>
          {/if}
        </div>
      </section>

      <!-- 마을 상세(#91): 지형·구성·어휘 파라미터. 과밀 제어로 접기(기본 닫힘). 변경 시 재생성(시드 유지). -->
      {#if onVillageOpt}
        <button class="advtoggle" class:open={showVDetail} onclick={() => (showVDetail = !showVDetail)} aria-expanded={showVDetail}>
          <span class="chev" aria-hidden="true">{showVDetail ? '−' : '+'}</span>{t('vil_detail')}
        </button>
        {#if showVDetail}
          {#each vSections as vsec (vsec.id)}{@render villageSection(vsec)}{/each}
        {/if}
      {/if}

      <section>
        <button class="rebuild" onclick={() => onReroll?.()} disabled={waving} title={t('vil_reroll_tip')}>
          <span class="rk" aria-hidden="true">再</span>{t('vil_reroll')}
        </button>
        {#if onExportVillage}
          <button class="glb" onclick={() => onExportVillage?.()} disabled={waving || exporting} title={t('glb_village_tip')}>
            <span class="gk" aria-hidden="true">⬗</span>{exporting ? t('glb_exporting') : t('glb_village')}
          </button>
        {/if}
      </section>
    </div>

    <!-- 집 섹션(근접) -->
    <div
      class="ctx house"
      style="opacity:{houseOpacity}; transform: translateY({12 * (1 - morph)}px);"
      style:pointer-events={houseActive ? 'auto' : 'none'}
      aria-hidden={!houseActive}
    >
      {#if editable}
        {#if schema.family === 'palace-compound'}
          <p class="note">{t('vil_palace_compound_note')}</p>
        {:else if schema.family === 'hero'}
          <p class="note">{t(schema.heroStyle === 'hanok' ? 'vil_hero_edit_note' : 'vil_palace_edit_note')}</p>
        {:else}
          <section>
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

        {#each basic as sec (sec.id)}{@render editSection(sec)}{/each}

        {#if adv.length}
          <button class="advtoggle" class:open={showAdv} onclick={() => (showAdv = !showAdv)} aria-expanded={showAdv}>
            <span class="chev" aria-hidden="true">{showAdv ? '−' : '+'}</span>{t('edit_advanced')}
          </button>
          {#if showAdv}{#each adv as sec (sec.id)}{@render editSection(sec)}{/each}{/if}
        {/if}
      {:else if spec}
        <div class="hero-note">
          <span class="mark" aria-hidden="true">印</span>
          <p>{t('vil_hero_note')}</p>
        </div>
      {/if}

      <!-- 집 액션(#100): 다시 보기(같은 집 재조립·시각 불변) vs 이 집 다시 짓기(새 씨앗·이 집만).
           마을 다시 짓기(웨이브)는 마을 섹션 전용 — 집 컨텍스트에서 마을 리롤 진입 경로 없음. -->
      {#if spec}
        <section class="house-actions">
          <button class="hbtn ghost" onclick={() => onReplay?.()} disabled={houseBusy} title={t('vil_replay_tip')}>
            <span class="hk" aria-hidden="true">再</span>{t('vil_replay')}
          </button>
          <button class="hbtn reroll" onclick={() => onRerollHouse?.()} disabled={houseBusy} title={t('vil_reroll_house_tip')}>
            <span class="hk" aria-hidden="true">⚄</span>{t('vil_reroll_house')}
          </button>
        </section>
        {#if onExportHouse}
          <button class="hbtn glb wide" onclick={() => onExportHouse?.()} disabled={houseBusy || exporting} title={t('glb_house_tip')}>
            <span class="hk" aria-hidden="true">⬗</span>{exporting ? t('glb_exporting') : t('act_glb')}
          </button>
        {/if}
      {/if}
    </div>
  </div>
</BottomSheet>

{#snippet villageSection(vsec)}
  <section class="vdetail">
    <h4>{t(vsec.titleKey)}</h4>
    {#each vsec.fields as f (f.key)}
      {#if f.ctrl === 'range'}
        <label class="row">
          <span class="rl">{t('s_' + f.key)}</span>
          <input type="range" data-vkey={f.key} min={f.min} max={f.max} step={f.step}
            value={vShow(f)}
            onchange={(e) => vRange(f, parseFloat(e.currentTarget.value))} />
          <span class="rv">{vIsAuto(f) ? t('vil_char_auto') : Number(vShow(f)).toFixed(2)}</span>
        </label>
      {:else if f.ctrl === 'toggle'}
        <div class="row">
          <span class="rl">{t('s_' + f.key)}{#if vDisabled(f)}<span class="tierhint"> · {t('vil_sijeon_hint')}</span>{/if}</span>
          {#if f.tri}
            <button class="tgl" data-vkey={f.key} class:on={vTriOn(f)} disabled={vDisabled(f)}
              onclick={() => vToggleTri(f)} role="switch" aria-checked={vTriOn(f)}>
              <span class="knob" aria-hidden="true"></span>
            </button>
          {:else}
            <button class="tgl" data-vkey={f.key} class:on={vPlainOn(f)}
              onclick={() => vTogglePlain(f)} role="switch" aria-checked={vPlainOn(f)}>
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
  <section>
    <h4>{t(sec.titleKey)}</h4>
    {#each sec.fields as f (f.key)}
      {#if f.ctrl === 'range'}
        <label class="row">
          <span class="rl">{t('s_' + f.key)}</span>
          <input type="range" data-key={f.key} min={f.min} max={f.max} step={f.step}
            value={showVal(f)}
            oninput={(e) => range(f, parseFloat(e.currentTarget.value))}
            onchange={(e) => rangeCommit(f, parseFloat(e.currentTarget.value))} />
          <span class="rv">{Number(showVal(f)).toFixed(2)}</span>
        </label>
      {:else if f.ctrl === 'stepper'}
        <div class="row bays">
          <span class="rl">{t('s_' + f.key)}</span>
          <div class="stepper">
            <button onclick={() => stepField(f, -1)} disabled={(showVal(f) | 0) <= f.min} aria-label="less">−</button>
            <span class="num">{showVal(f) | 0}</span>
            <button onclick={() => stepField(f, 1)} disabled={(showVal(f) | 0) >= f.max} aria-label="more">+</button>
          </div>
        </div>
      {:else if f.ctrl === 'segment'}
        <div class="row seg">
          <span class="rl">{t('s_' + f.key)}</span>
          <div class="segs">
            {#each f.options as o}
              <button class="segbtn" class:on={params[f.key] === o} onclick={() => pick(f, o)}>{optLabel(f.key, o)}</button>
            {/each}
          </div>
        </div>
      {:else if f.ctrl === 'toggle'}
        <div class="row">
          <span class="rl">{t('s_' + f.key)}</span>
          <button class="tgl" data-key={f.key} class:on={!!params[f.key]} onclick={() => toggleField(f)} role="switch" aria-checked={!!params[f.key]}>
            <span class="knob" aria-hidden="true"></span>
          </button>
          <span class="rv"></span>
        </div>
      {/if}
    {/each}
  </section>
{/snippet}

<style>
  /* ── 브레드크럼 ── */
  .crumbs {
    display: flex; align-items: baseline; gap: 7px;
    border-bottom: 1px solid var(--ink-line); padding-bottom: 9px;
  }
  .crumb { background: none; border: none; padding: 0; font-family: var(--brush); color: var(--ink); }
  .crumb.root { font-size: 26px; line-height: 1; cursor: default; }
  .crumb.root.link { cursor: pointer; color: var(--ink-soft); }
  .crumb.root.link:hover { color: var(--seal-deep); }
  .sep { font-size: 20px; color: var(--ink-faint); transition: opacity 0.2s ease; }
  .crumb.leaf { font-size: 26px; line-height: 1; color: var(--seal-deep); transition: opacity 0.2s ease; }
  .count { margin-left: auto; font-size: 11px; color: var(--seal); font-weight: 700; font-variant-numeric: tabular-nums; }

  /* ── 모프 스택 ── */
  .stack { display: grid; }
  .stack > .ctx { grid-column: 1; grid-row: 1; display: flex; flex-direction: column; gap: 13px; transition: opacity 0.12s linear; }

  section { display: flex; flex-direction: column; gap: 8px; }
  h4 { margin: 0; font-size: 10px; font-weight: 700; letter-spacing: 0.2em; color: var(--ink-faint); text-transform: uppercase; }

  /* ── 마을 섹션 ── */
  .scalehead { display: flex; align-items: baseline; justify-content: space-between; }
  .scaleval { font-size: 14px; font-weight: 700; color: var(--ink); font-family: var(--serif); }
  .ends { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--ink-faint); letter-spacing: 0.04em; }
  input[type='range'].scale {
    -webkit-appearance: none; appearance: none; width: 100%;
    height: 3px; border-radius: 2px; background: var(--ink-line); outline: none;
  }
  input[type='range'].scale::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%;
    background: var(--ink); border: 1.5px solid var(--paper); box-shadow: 0 1px 3px rgba(30, 22, 14, 0.4); cursor: pointer;
  }
  input[type='range'].scale::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--ink); border: 1.5px solid var(--paper); cursor: pointer; }
  .toggles { display: flex; gap: 6px; }
  .toggle {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 4px; border-radius: 4px; font-size: 12.5px; font-weight: 700;
    background: transparent; border: 1px solid var(--ink-hair); color: var(--ink-soft); transition: all 0.15s ease;
  }
  .toggle .dot { width: 8px; height: 8px; border-radius: 2px; border: 1px solid var(--ink-faint); background: transparent; transition: all 0.15s ease; }
  .toggle:hover:not(:disabled) { background: rgba(44, 38, 32, 0.05); }
  .toggle.on { border-color: var(--seal-deep); color: var(--seal-deep); }
  .toggle.on .dot { background: var(--seal); border-color: var(--seal-deep); }
  .toggle:disabled { opacity: 0.4; cursor: default; }
  /* 다시 짓기(리롤 웨이브) — 주묵 전각 액션. */
  .rebuild {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 10px; border-radius: 5px; font-size: 13px; font-weight: 700;
    background: var(--seal); border: 1px solid var(--seal-deep); color: var(--paper);
    background-image: var(--hanji), linear-gradient(160deg, #bb3e31 0%, #a5322a 60%, #8f2a23 100%);
    box-shadow: 0 2px 8px rgba(120, 40, 30, 0.28); transition: transform 0.12s ease, filter 0.2s ease;
  }
  .rebuild .rk { font-size: 15px; }
  .rebuild:hover:not(:disabled) { transform: translateY(-1px); }
  .rebuild:disabled { filter: saturate(0.6) opacity(0.6); cursor: default; }
  /* glb 내보내기 — 먹빛 보조 액션(주묵 다시 짓기와 위계 구분). */
  .glb {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 9px; border-radius: 5px; font-size: 12.5px; font-weight: 700;
    background: transparent; border: 1px solid var(--ink-hair); color: var(--ink);
    transition: transform 0.12s ease, background 0.15s ease, filter 0.2s ease;
  }
  .glb .gk { font-size: 14px; color: var(--ink-soft); }
  .glb:hover:not(:disabled) { background: rgba(44, 38, 32, 0.06); transform: translateY(-1px); }
  .glb:disabled { filter: saturate(0.6) opacity(0.55); cursor: default; }
  .hbtn.glb.wide { flex: none; width: 100%; margin-top: 8px; }

  /* ── 집 섹션(VillageEditPanel 룩 계승) ── */
  .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .tab { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 9px 2px; border-radius: 4px; background: transparent; border: 1px solid var(--ink-hair); color: var(--ink-soft); transition: all 0.16s ease; }
  .tab .tl { font-size: 14px; font-weight: 700; }
  .tab .ts { font-size: 9px; color: var(--ink-faint); letter-spacing: 0.08em; }
  .tab:hover { background: rgba(44, 38, 32, 0.05); }
  .tab.on { background: var(--seal); border-color: var(--seal-deep); color: var(--paper); }
  .tab.on .ts { color: rgba(244, 239, 228, 0.8); }
  .row { display: grid; grid-template-columns: 78px 1fr 38px; align-items: center; gap: 8px; }
  .row.bays, .row.seg { grid-template-columns: 78px 1fr; }
  .rl { font-size: 12.5px; color: var(--ink); }
  .rv { font-size: 11px; color: var(--ink-faint); text-align: right; font-variant-numeric: tabular-nums; }
  .stepper { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
  .stepper button { width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--ink-hair); background: transparent; color: var(--ink); font-size: 16px; line-height: 1; display: grid; place-items: center; transition: all 0.14s ease; }
  .stepper button:hover:not(:disabled) { background: rgba(44, 38, 32, 0.06); }
  .stepper button:disabled { opacity: 0.3; cursor: default; }
  .stepper .num { min-width: 18px; text-align: center; font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .segs { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .segbtn { padding: 5px 9px; border-radius: 4px; font-size: 11.5px; font-weight: 700; background: transparent; border: 1px solid var(--ink-hair); color: var(--ink-soft); transition: all 0.14s ease; white-space: nowrap; }
  .segbtn:hover { background: rgba(44, 38, 32, 0.05); }
  .segbtn.on { background: var(--ink); border-color: var(--ink); color: var(--paper); }
  .tgl { justify-self: start; width: 42px; height: 24px; border-radius: 13px; padding: 0; border: 1px solid var(--ink-hair); background: rgba(44, 38, 32, 0.06); position: relative; transition: all 0.16s ease; }
  .tgl .knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--paper); box-shadow: 0 1px 2px rgba(60, 30, 20, 0.35); transition: transform 0.16s ease; }
  .tgl.on { background: var(--seal); border-color: var(--seal-deep); }
  .tgl.on .knob { transform: translateX(18px); }
  .advtoggle { display: flex; align-items: center; gap: 8px; align-self: flex-start; padding: 6px 2px; background: transparent; border: none; color: var(--ink-faint); font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; cursor: pointer; }
  .advtoggle:hover { color: var(--ink); }
  .advtoggle .chev { display: grid; place-items: center; width: 17px; height: 17px; border-radius: 3px; border: 1px solid var(--ink-hair); font-size: 13px; line-height: 1; }
  .note { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-soft); font-style: italic; }
  /* 마을 상세(#91) — 편집 섹션과 동일 룩 계승. tierhint = 하위 tier 비활성 사유(예: 시전=도성부터). */
  .vdetail { gap: 7px; }
  .tierhint { font-size: 9.5px; color: var(--ink-faint); font-weight: 600; letter-spacing: 0.02em; }
  .hero-note { display: flex; gap: 12px; align-items: flex-start; padding: 14px; border-radius: 6px; background: rgba(177, 54, 43, 0.06); border: 1px dashed var(--seal); }
  .hero-note .mark { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 3px; background: var(--seal); color: var(--paper); font-size: 15px; font-weight: 700; }
  .hero-note p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink); }
  input[type='range'] { -webkit-appearance: none; appearance: none; height: 3px; border-radius: 2px; background: var(--ink-line); outline: none; }
  input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%; background: var(--seal); border: 1.5px solid var(--paper); box-shadow: 0 1px 3px rgba(60, 30, 20, 0.4); cursor: pointer; }
  input[type='range']::-moz-range-thumb { width: 15px; height: 15px; border-radius: 50%; background: var(--seal); border: 1.5px solid var(--paper); cursor: pointer; }

  /* 집 액션(#100): 다시 보기(먹빛 고스트) + 이 집 다시 짓기(주묵 전각) — 재/리롤 구분 명확. */
  .house-actions { flex-direction: row; gap: 8px; margin-top: 3px; padding-top: 11px; border-top: 1px solid var(--ink-line); }
  .hbtn {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px;
    padding: 10px; border-radius: 5px; font-size: 12.5px; font-weight: 700;
    transition: transform 0.12s ease, filter 0.2s ease, background 0.15s ease;
  }
  .hbtn .hk { font-size: 15px; }
  .hbtn.ghost { background: transparent; border: 1px solid var(--ink-hair); color: var(--ink); }
  .hbtn.ghost .hk { color: var(--ink-soft); }
  .hbtn.ghost:hover:not(:disabled) { background: rgba(44, 38, 32, 0.06); transform: translateY(-1px); }
  .hbtn.reroll {
    background: var(--seal); border: 1px solid var(--seal-deep); color: var(--paper);
    background-image: var(--hanji), linear-gradient(160deg, #bb3e31 0%, #a5322a 60%, #8f2a23 100%);
    box-shadow: 0 2px 8px rgba(120, 40, 30, 0.28);
  }
  .hbtn.reroll:hover:not(:disabled) { transform: translateY(-1px); }
  .hbtn:disabled { filter: saturate(0.6) opacity(0.55); cursor: default; }

  /* 터치: 타깃 확대. */
  @media (pointer: coarse) {
    .crumb.root, .crumb.leaf { font-size: 28px; }
    .scaleval { font-size: 16px; }
    .toggle { padding: 13px 6px; font-size: 14px; }
    .rebuild { padding: 14px; font-size: 15px; }
    .hbtn { padding: 14px 8px; font-size: 14px; }
    input[type='range'].scale { height: 5px; }
    input[type='range'].scale::-webkit-slider-thumb { width: 26px; height: 26px; }
    input[type='range'].scale::-moz-range-thumb { width: 26px; height: 26px; }
    .tab { padding: 13px 2px; }
    .tab .tl { font-size: 15px; }
    .stepper { gap: 16px; }
    .stepper button { width: 40px; height: 40px; font-size: 20px; }
    .stepper .num { min-width: 24px; font-size: 17px; }
    .row { min-height: 40px; }
    .segbtn { padding: 9px 11px; font-size: 13px; }
    .tgl { width: 52px; height: 30px; border-radius: 16px; }
    .tgl .knob { width: 24px; height: 24px; }
    .tgl.on .knob { transform: translateX(22px); }
    input[type='range'] { height: 5px; }
    input[type='range']::-webkit-slider-thumb { width: 24px; height: 24px; }
    input[type='range']::-moz-range-thumb { width: 24px; height: 24px; }
  }
</style>
