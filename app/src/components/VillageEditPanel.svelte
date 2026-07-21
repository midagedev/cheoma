<script>
  // focus-in 상세 편집 패널(#48) — 스키마(edit-schema.js) 주도 렌더. 코어가 지원하는 편집 축을
  //   유형별로 전수 노출한다: 정규 필지(기와/초가)는 유형탭+지붕·외피·평면·비례·마당,
  //   특수 필지(종가 hanok / 관아 palace)는 예외 없이 편집(지붕·공포·기단·월대난간 등).
  //   기본 섹션은 항상, 고급 섹션은 접기로 과밀 제어. 슬라이더는 라이브(#69): 드래그 중 onLive,
  //   놓을 때 onCommit — 라이브 전략(정규=드래그 즉시 변형, 특수=놓을 때 정착)은 App 이 결정.
  import { t } from '../lib/i18n.svelte.js';
  import { schemaFor } from '../lib/edit-schema.js';
  import BottomSheet from './BottomSheet.svelte';

  let { open = false, spec = null, params = {}, onType, onLive, onCommit, onClose } = $props();

  const editable = $derived(!!spec && spec.editable === true);
  const schema = $derived(schemaFor(spec));
  const basic = $derived(schema.sections.filter((s) => !s.adv));
  const adv = $derived(schema.sections.filter((s) => s.adv));
  let showAdv = $state(false);

  // 정규 필지 유형 탭(기와/초가). 특수(hero)는 탭 없이 매무새만.
  const TYPES = [
    { key: 'giwa', l: 'type_giwa_l', s: 'type_giwa_s' },
    { key: 'choga', l: 'type_choga_l', s: 'type_choga_s' },
  ];

  // 슬라이더 표시값 — params 에 없으면 필드 min(편집 전 안전 시작점). 표시만, 페이로드는 App 이 undefined 스킵.
  const showVal = (f) => (typeof params[f.key] === 'number' ? params[f.key] : f.min);

  function range(f, value) {
    params[f.key] = value;      // 라벨 즉시 반영
    onLive?.(f.key, value);
  }
  function rangeCommit(f, value) {
    params[f.key] = value;
    onCommit?.(f.key, value);
  }
  function stepField(f, dir) {
    const cur = typeof params[f.key] === 'number' ? params[f.key] : f.min;
    const v = Math.max(f.min, Math.min(f.max, (cur | 0) + dir));
    params[f.key] = v;
    onCommit?.(f.key, v);
  }
  function pick(f, value) { params[f.key] = value; onCommit?.(f.key, value); }
  function toggleField(f) { const v = !params[f.key]; params[f.key] = v; onCommit?.(f.key, v); }

  // segment 옵션 라벨: wallType→wall_*, doorPattern→door_*.
  const optLabel = (key, o) => t((key === 'wallType' ? 'wall_'
    : key === 'doorPattern' ? 'door_'
    : key === 'variant' ? 'temple_variant_'
    : key === 'pagoda' ? 'temple_pagoda_'
    : '') + o);
</script>

<BottomSheet {open} {onClose} variant="right" ariaLabel="edit house panel">
  <div class="head">
    <span class="ko">{t('vil_edit_title')}</span>
    <span class="en">{t('vil_edit_sub')}</span>
  </div>

  {#if editable}
    {#if schema.family === 'temple'}
      <p class="ctx">{t('vil_temple_compound_note')}</p>
    {:else if schema.family === 'palace-compound'}
      <p class="ctx">{t('vil_palace_compound_note')}</p>
    {:else if schema.family === 'hero'}
      <p class="ctx">{t(schema.heroStyle === 'hanok' ? 'vil_hero_edit_note' : 'vil_palace_edit_note')}</p>
    {:else}
      <section>
        <h4>{t('sec_type')}</h4>
        <div class="tabs">
          {#each TYPES as ty}
            <button class="tab" class:on={params.kind === ty.key} onclick={() => onType?.(ty.key)}>
              <span class="tl">{t(ty.l)}</span>
              <span class="ts">{t(ty.s)}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#each basic as sec (sec.id)}
      {@render section(sec)}
    {/each}

    {#if adv.length}
      <button class="advtoggle" class:open={showAdv} onclick={() => (showAdv = !showAdv)} aria-expanded={showAdv}>
        <span class="chev" aria-hidden="true">{showAdv ? '−' : '+'}</span>{t('edit_advanced')}
      </button>
      {#if showAdv}
        {#each adv as sec (sec.id)}
          {@render section(sec)}
        {/each}
      {/if}
    {/if}
  {:else}
    <div class="hero-note">
      <span class="mark" aria-hidden="true">印</span>
      <p>{t('vil_hero_note')}</p>
    </div>
  {/if}
</BottomSheet>

{#snippet section(sec)}
  <section>
    <h4>{t(sec.titleKey)}</h4>
    {#each sec.fields as f (f.key)}
      {#if f.ctrl === 'range'}
        <label class="row">
          <span class="rl">{t('s_' + f.key)}</span>
          <input
            type="range" data-key={f.key} min={f.min} max={f.max} step={f.step}
            value={showVal(f)}
            oninput={(e) => range(f, parseFloat(e.currentTarget.value))}
            onchange={(e) => rangeCommit(f, parseFloat(e.currentTarget.value))}
          />
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
          <button class="tgl" class:on={!!params[f.key]} onclick={() => toggleField(f)} role="switch" aria-checked={!!params[f.key]}>
            <span class="knob" aria-hidden="true"></span>
          </button>
          <span class="rv"></span>
        </div>
      {/if}
    {/each}
  </section>
{/snippet}

<style>
  .head { display: flex; align-items: baseline; gap: 10px; border-bottom: 1px solid var(--ink-line); padding-bottom: 10px; }
  .head .ko { font-family: var(--brush); font-size: 30px; color: var(--ink); }
  .head .en { font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--ink-faint); }

  section { display: flex; flex-direction: column; gap: 9px; }
  h4 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.22em; color: var(--ink-faint); text-transform: uppercase; }

  .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .tab {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 9px 2px; border-radius: 4px;
    background: transparent; border: 1px solid var(--ink-hair); color: var(--ink-soft);
    transition: all 0.16s ease;
  }
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
  .stepper button {
    width: 26px; height: 26px; border-radius: 50%;
    border: 1px solid var(--ink-hair); background: transparent; color: var(--ink);
    font-size: 16px; line-height: 1; display: grid; place-items: center;
    transition: all 0.14s ease;
  }
  .stepper button:hover:not(:disabled) { background: rgba(44, 38, 32, 0.06); }
  .stepper button:disabled { opacity: 0.3; cursor: default; }
  .stepper .num { min-width: 18px; text-align: center; font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }

  /* segment(택1) — 담장 어휘·창살 패턴 등. */
  .segs { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .segbtn {
    padding: 5px 9px; border-radius: 4px; font-size: 11.5px; font-weight: 700;
    background: transparent; border: 1px solid var(--ink-hair); color: var(--ink-soft);
    transition: all 0.14s ease; white-space: nowrap;
  }
  .segbtn:hover { background: rgba(44, 38, 32, 0.05); }
  .segbtn.on { background: var(--ink); border-color: var(--ink); color: var(--paper); }

  /* toggle(불) — 부속채·월대난간. */
  .tgl {
    justify-self: start; width: 42px; height: 24px; border-radius: 13px; padding: 0;
    border: 1px solid var(--ink-hair); background: rgba(44, 38, 32, 0.06);
    position: relative; transition: all 0.16s ease;
  }
  .tgl .knob {
    position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--paper); box-shadow: 0 1px 2px rgba(60, 30, 20, 0.35); transition: transform 0.16s ease;
  }
  .tgl.on { background: var(--seal); border-color: var(--seal-deep); }
  .tgl.on .knob { transform: translateX(18px); }

  .advtoggle {
    display: flex; align-items: center; gap: 8px; align-self: flex-start;
    padding: 6px 2px; background: transparent; border: none; color: var(--ink-faint);
    font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
    cursor: pointer;
  }
  .advtoggle:hover { color: var(--ink); }
  .advtoggle .chev {
    display: grid; place-items: center; width: 17px; height: 17px; border-radius: 3px;
    border: 1px solid var(--ink-hair); font-size: 13px; line-height: 1;
  }

  .ctx { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-soft); font-style: italic; }

  .hero-note {
    display: flex; gap: 12px; align-items: flex-start;
    padding: 14px; border-radius: 6px;
    background: rgba(177, 54, 43, 0.06); border: 1px dashed var(--seal);
  }
  .hero-note .mark {
    flex: none; display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: 3px;
    background: var(--seal); color: var(--paper); font-size: 15px; font-weight: 700;
  }
  .hero-note p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink); }

  input[type='range'] {
    -webkit-appearance: none; appearance: none;
    height: 3px; border-radius: 2px; background: var(--ink-line); outline: none;
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 15px; height: 15px; border-radius: 50%;
    background: var(--seal); border: 1.5px solid var(--paper);
    box-shadow: 0 1px 3px rgba(60, 30, 20, 0.4); cursor: pointer;
  }
  input[type='range']::-moz-range-thumb {
    width: 15px; height: 15px; border-radius: 50%;
    background: var(--seal); border: 1.5px solid var(--paper); cursor: pointer;
  }

  /* 터치: 타깃 확대. */
  @media (pointer: coarse) {
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
