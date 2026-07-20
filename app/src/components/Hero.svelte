<script>
  // 진입 히어로 오버레이 — 한지 바탕 + 로고타입 cheoma + 낙관 악센트. 클릭/키보드로 입장.
  // 브랜딩 다이어트(#72): 세로 '처마'·태그라인 제거, 로고타입 cheoma 만 담백하게. 안내만 로케일화.
  import { t } from '../lib/i18n.svelte.js';
  let { onEnter, leaving = false } = $props();
</script>

<button type="button" class="hero" class:leaving onclick={onEnter} aria-label={t('hero_enter')}>
  <div class="title">
    <span class="latin">cheoma</span>
    <span class="seal" aria-hidden="true"></span>
  </div>
  <div class="enter">{t('hero_enter')}</div>
</button>

<style>
  .hero {
    position: fixed; inset: 0; z-index: 9999; cursor: pointer;
    width: 100%; border: 0; font: inherit;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 0.9rem; text-align: center; padding: 6vh 8vw;
    background: radial-gradient(120% 100% at 50% 38%, #f7f2e8 0%, #efe8da 58%, #e6dccb 100%);
    background-image:
      var(--hanji),
      radial-gradient(120% 100% at 50% 38%, #f7f2e8 0%, #efe8da 58%, #e6dccb 100%);
    color: var(--ink);
    transition: opacity 0.85s ease;
  }
  .hero.leaving { opacity: 0; pointer-events: none; }
  .hero:focus-visible { outline: none; }

  .title {
    display: inline-flex; align-items: center; gap: 0.32em;
    font-size: clamp(38px, 8vw, 82px); font-weight: 400; letter-spacing: 0.04em;
  }
  .title .latin { font-family: var(--serif); }
  .title .seal {
    width: 0.34em; height: 0.34em; background: var(--seal); border-radius: 3px;
    transform: translateY(-0.1em);
    box-shadow: 0 0 0 1px rgba(120, 40, 30, 0.24);
  }
  .enter {
    margin-top: 0.6rem; font-family: var(--serif);
    font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--ink-faint);
    animation: pulse 2.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.92; } }

  /* 가로 폰(짧은 높이): 타이틀·간격을 줄여 한 화면에. */
  @media (max-height: 520px) and (orientation: landscape) {
    .hero { gap: 0.5rem; padding: 4vh 8vw; }
    .title { font-size: clamp(32px, 9vh, 58px); }
    .enter { margin-top: 0.3rem; }
  }
</style>
