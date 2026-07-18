<script>
  // 마을 옵션 카드(좌상, 배율 토글 아래) — 규모·궁·절. 부감(집 미포커스)일 때만.
  //   규모는 슬라이더 단일 컨트롤(사용자 지시 2026-07-18): 값을 5앵커(hamlet~hanyang)로 스냅해
  //   기존 createVillage 경로에 넘긴다. 코어 규모 연속화(#89) 완료 시 snapAnchor 만 제거하면 되는 구조.
  //   character(민촌/여염/반촌) 축은 폐지 결정 — 패널 미노출(내부 기본값 yeoyeom 유지, 코어 폐지는 #89).
  import { t } from '../lib/i18n.svelte.js';
  import BottomSheet from './BottomSheet.svelte';
  let {
    open = false, scale = 'village', includePalace = false, includeTemple = false, houses = 0,
    onScale, onPalace, onTemple,
  } = $props();

  const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
  const idx = $derived(Math.max(0, SCALES.indexOf(scale)));
  // 드래그 중엔 dragVal(연속) 로 라벨만 라이브 갱신, 놓으면 최근접 앵커로 스냅해 재생성(무거운 마을 리빌드).
  let dragVal = $state(null);
  const shownVal = $derived(dragVal != null ? dragVal : idx);
  const shownAnchor = $derived(SCALES[Math.round(shownVal)]);
  // 궁 토글은 도성 규모(capital·hanyang)에서만 유효 — 현재 앵커 기준.
  const palaceScale = $derived(shownAnchor === 'capital' || shownAnchor === 'hanyang');

  function slideInput(v) { dragVal = v; }
  function slideCommit(v) {
    dragVal = null;
    const anchor = SCALES[Math.round(v)];          // ← 코어 연속화(#89) 시 이 스냅만 제거
    if (anchor !== scale) onScale?.(anchor);
  }
</script>

<BottomSheet {open} variant="leftCard" closable={false} gap={13} ariaLabel="village options">
  <div class="head">
    <span class="ko">{t('vil_title')}</span>
    <span class="en">{t('vil_sub')}</span>
    {#if houses > 0}<span class="count">{houses}{t('vil_houses')}</span>{/if}
  </div>

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
    <div class="ends"><span>{t('scale_hamlet')}</span><span>{t('scale_hanyang')}</span></div>
  </section>

  <section>
    <div class="toggles">
      <button
        class="toggle" class:on={includePalace} disabled={!palaceScale}
        onclick={() => onPalace?.()} title={!palaceScale ? t('vil_palace_hint') : ''}
      >
        <span class="dot" aria-hidden="true"></span>{t('vil_palace')}
      </button>
      <button class="toggle" class:on={includeTemple} onclick={() => onTemple?.()}>
        <span class="dot" aria-hidden="true"></span>{t('vil_temple')}
      </button>
    </div>
  </section>
</BottomSheet>

<style>
  .head { display: flex; align-items: baseline; gap: 8px; border-bottom: 1px solid var(--ink-line); padding-bottom: 8px; }
  .head .ko { font-family: var(--brush); font-size: 25px; color: var(--ink); line-height: 1; }
  .head .en { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--ink-faint); }
  .head .count { margin-left: auto; font-size: 11px; color: var(--seal); font-weight: 700; font-variant-numeric: tabular-nums; }

  section { display: flex; flex-direction: column; gap: 7px; }
  h4 { margin: 0; font-size: 10px; font-weight: 700; letter-spacing: 0.2em; color: var(--ink-faint); text-transform: uppercase; }

  .scalehead { display: flex; align-items: baseline; justify-content: space-between; }
  .scaleval { font-size: 14px; font-weight: 700; color: var(--ink); font-family: var(--serif); }
  .ends { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--ink-faint); letter-spacing: 0.04em; }

  input[type='range'].scale {
    -webkit-appearance: none; appearance: none; width: 100%;
    height: 3px; border-radius: 2px; background: var(--ink-line); outline: none;
  }
  input[type='range'].scale::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--ink); border: 1.5px solid var(--paper);
    box-shadow: 0 1px 3px rgba(30, 22, 14, 0.4); cursor: pointer;
  }
  input[type='range'].scale::-moz-range-thumb {
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--ink); border: 1.5px solid var(--paper); cursor: pointer;
  }

  .toggles { display: flex; gap: 6px; }
  .toggle {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 4px; border-radius: 4px; font-size: 12.5px; font-weight: 700;
    background: transparent; border: 1px solid var(--ink-hair); color: var(--ink-soft);
    transition: all 0.15s ease;
  }
  .toggle .dot { width: 8px; height: 8px; border-radius: 2px; border: 1px solid var(--ink-faint); background: transparent; transition: all 0.15s ease; }
  .toggle:hover:not(:disabled) { background: rgba(44, 38, 32, 0.05); }
  .toggle.on { border-color: var(--seal-deep); color: var(--seal-deep); }
  .toggle.on .dot { background: var(--seal); border-color: var(--seal-deep); }
  .toggle:disabled { opacity: 0.4; cursor: default; }

  /* 시트(모바일): 타깃 확대. */
  @media (pointer: coarse) {
    .head .ko { font-size: 28px; }
    .scaleval { font-size: 16px; }
    .toggle { padding: 13px 6px; font-size: 14px; }
    section { gap: 9px; }
    input[type='range'].scale { height: 5px; }
    input[type='range'].scale::-webkit-slider-thumb { width: 26px; height: 26px; }
    input[type='range'].scale::-moz-range-thumb { width: 26px; height: 26px; }
  }
</style>
