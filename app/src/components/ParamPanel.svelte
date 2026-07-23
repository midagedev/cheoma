<script>
  import { onDestroy } from 'svelte';
  import { TYPES } from '../lib/seed.js';
  import { t } from '../lib/i18n.svelte.js';
  import { STANDALONE_PARAM_SPECS } from '../lib/standalone-param-spec.js';
  import BottomSheet from './BottomSheet.svelte';

  // 우측 한지 파라미터 패널 — 집 선택 시 슬라이드 인. 라벨은 로케일화(t).
  let {
    open = false, preset = 'korea', expansion = 1, maxExpansion = 3, canMerge = false,
    params = {}, paramCommitEpoch = 0,
    onType, onExpansion, onMerge, onParam, onShare = null, onClose,
  } = $props();

  // 코어가 즉시 지원하는 슬라이더만 노출(params 에 존재하는 수치 키에 한함). 라벨키 s_<key>.
  const sliders = $derived(STANDALONE_PARAM_SPECS.filter((d) => typeof params[d.key] === 'number'));

  // 큰 글리프 一/ㄱ/ㄷ 는 평면 상형 → 로케일 불변, 캡션만 로케일화.
  const STEPS = [ { n: 1, g: '一', k: 'step_single' }, { n: 2, g: 'ㄱ', k: 'step_l' }, { n: 3, g: 'ㄷ', k: 'step_u' } ];
  const steps = $derived(STEPS.filter((s) => s.n <= maxExpansion));

  // 슬라이더 디바운스 재생성.
  let timers = {};
  function clearTimers() {
    for (const timer of Object.values(timers)) clearTimeout(timer);
    timers = {};
  }
  function slide(key, value) {
    params[key] = value; // 라벨 즉시 반영
    const epoch = paramCommitEpoch;
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => onParam?.(key, value, epoch), 110);
  }
  // A type change can replace P while a slider's 110ms commit is pending.
  // Cancel that old-generation callback rather than leaking (for example)
  // roofPitch into a giwa spec that does not own it.
  $effect(() => {
    const generation = `${preset}:${paramCommitEpoch}`;
    return () => {
      void generation;
      clearTimers();
    };
  });
  onDestroy(clearTimers);
</script>

<BottomSheet {open} {onClose} variant="right" ariaLabel="build panel">
  <div class="head" class:shareable={!!onShare}>
    <div class="title">
      <span class="ko">{t('panel_title')}</span>
      <span class="en">plan &amp; profile</span>
    </div>
    {#if onShare}
      <button
        class="share"
        data-action="share"
        onclick={() => onShare?.()}
        title={t('act_share_tip')}
        aria-label={t('act_share')}
      >
        <svg class="share-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 15.5V4m0 0L7.5 8.5M12 4l4.5 4.5M5.5 13v6.5h13V13"></path>
        </svg>
        {t('act_share')}
      </button>
    {/if}
  </div>

  <!-- 유형 탭 -->
  <section>
    <h4>{t('sec_type')}</h4>
    <div class="tabs">
      {#each TYPES as ty}
        <button class="tab" class:on={preset === ty.key} onclick={() => onType?.(ty.key)}>
          <span class="tl">{t('type_' + ty.key + '_l')}</span>
          <span class="ts">{t('type_' + ty.key + '_s')}</span>
        </button>
      {/each}
    </div>
  </section>

  <!-- 칸 들이기(확장) -->
  <section>
    <h4>{t('sec_expand')}</h4>
    {#if maxExpansion > 1}
      <div class="stepper">
        {#each steps as s}
          <button class="step" class:on={expansion === s.n} onclick={() => onExpansion?.(s.n)}>
            <span class="glyph">{s.g}</span>
            <span class="st">{s.n}R · {t(s.k)}</span>
          </button>
        {/each}
      </div>
      {#if canMerge}
        <button class="merge" onclick={onMerge}>
          <span class="mseal" aria-hidden="true">合</span>
          {t('merge')}
        </button>
      {/if}
    {:else}
      <p class="note">{t('giwa_note')}</p>
    {/if}
  </section>

  <!-- 파라미터 슬라이더 -->
  <section>
    <h4>{t('sec_finish')}</h4>
    {#each sliders as d}
      <label class="row">
        <span class="rl">{t('s_' + d.key)}</span>
        <input
          data-param={d.key}
          type="range" min={d.min} max={d.max} step={d.step}
          value={params[d.key]}
          oninput={(e) => slide(d.key, parseFloat(e.currentTarget.value))}
        />
        <span class="rv">{Number(params[d.key]).toFixed(2)}</span>
      </label>
    {/each}
  </section>
</BottomSheet>

<style>
  .head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    border-bottom: 1px solid var(--ink-line); padding-bottom: 10px;
  }
  .head.shareable { padding-top: 8px; }
  .title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .head .ko { font-family: var(--brush); font-size: 30px; color: var(--ink); }
  .head .en { font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--ink-faint); }
  .share {
    flex: none; min-width: 76px; min-height: 44px;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    padding: 9px 11px; border-radius: 5px;
    background: transparent; border: 1px solid var(--ink-hair); color: var(--ink);
    font-family: var(--serif); font-size: 13px; font-weight: 700;
    transition: transform 0.12s ease, background 0.15s ease;
  }
  .share:hover { background: rgba(44, 38, 32, 0.06); transform: translateY(-1px); }
  .share:focus-visible { outline: 2px solid var(--seal); outline-offset: 2px; }
  .share-glyph {
    width: 18px; height: 18px; fill: none; stroke: var(--seal-deep);
    stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
  }

  section { display: flex; flex-direction: column; gap: 9px; }
  h4 {
    margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.22em;
    color: var(--ink-faint); text-transform: uppercase;
  }

  .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .tab {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 8px 2px; border-radius: 4px;
    background: transparent; border: 1px solid var(--ink-hair); color: var(--ink-soft);
    transition: all 0.16s ease;
  }
  .tab .tl { font-size: 14px; font-weight: 700; }
  .tab .ts { font-size: 9px; color: var(--ink-faint); letter-spacing: 0.08em; }
  .tab:hover { background: rgba(44, 38, 32, 0.05); }
  .tab.on { background: var(--seal); border-color: var(--seal-deep); color: var(--paper); }
  .tab.on .ts { color: rgba(244, 239, 228, 0.8); }

  .stepper { display: flex; gap: 8px; }
  .step {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 10px 2px; border-radius: 5px;
    background: transparent; border: 1px solid var(--ink-hair); color: var(--ink-soft);
    transition: all 0.16s ease;
  }
  .step .glyph { font-family: var(--serif); font-size: 22px; font-weight: 700; line-height: 1; }
  .step .st { font-size: 9.5px; letter-spacing: 0.06em; color: var(--ink-faint); }
  .step:hover { background: rgba(44, 38, 32, 0.05); }
  .step.on { background: var(--ink); border-color: var(--ink); color: var(--paper); }
  .step.on .st { color: rgba(244, 239, 228, 0.78); }

  .row { display: grid; grid-template-columns: 74px 1fr 38px; align-items: center; gap: 8px; }
  .rl { font-size: 12.5px; color: var(--ink); }
  .rv { font-size: 11px; color: var(--ink-faint); text-align: right; font-variant-numeric: tabular-nums; }

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
  .note { margin: 0; font-size: 12px; color: var(--ink-faint); font-style: italic; }

  .merge {
    margin-top: 4px;
    display: flex; align-items: center; gap: 9px;
    padding: 9px 12px; border-radius: 5px;
    background: transparent; border: 1px dashed var(--seal); color: var(--seal-deep);
    font-size: 13px; font-weight: 700; letter-spacing: 0.03em;
    transition: all 0.16s ease;
  }
  .merge .mseal {
    display: grid; place-items: center; width: 22px; height: 22px; border-radius: 3px;
    background: var(--seal); color: var(--paper); font-size: 13px; font-weight: 700;
  }
  .merge:hover { background: rgba(177, 54, 43, 0.08); border-style: solid; }
  .merge:active { transform: scale(0.98); }

  /* 터치: 타깃 확대 — 탭·스테퍼·병합·슬라이더 thumb 를 손가락에 맞게. */
  @media (pointer: coarse) {
    .share { min-height: 48px; padding: 11px; font-size: 14px; }
    .tab { padding: 12px 2px; }
    .tab .tl { font-size: 15px; }
    .step { padding: 13px 2px; }
    .merge { padding: 13px 12px; font-size: 14px; }
    .row { grid-template-columns: 84px 1fr 40px; }
    input[type='range'] { height: 5px; }
    input[type='range']::-webkit-slider-thumb { width: 24px; height: 24px; }
    input[type='range']::-moz-range-thumb { width: 24px; height: 24px; }
    /* 슬라이더 행 세로 여백을 늘려 손가락 조작 여유. */
    .row { min-height: 40px; }
  }
</style>
