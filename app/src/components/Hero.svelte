<script>
  // 진입 히어로 오버레이 — 한지 바탕 + 로고타입 cheoma + 낙관 악센트. 클릭/키보드로 입장.
  // 브랜딩 다이어트(#72): 세로 '처마'·태그라인 제거, 로고타입 cheoma 만 담백하게. 안내만 로케일화.
  import { t } from '../lib/i18n.svelte.js';
  // entering: 눌린 뒤 실제 진입까지의 준비 구간(#16). 이 상태는 **누른 프레임에** 화면에 나와야
  //   하므로 App 이 무거운 작업보다 먼저 세우고 페인트를 한 번 양보한다. 여기서는 표시만 한다.
  let { onEnter, leaving = false, entering = false } = $props();
</script>

<button
  type="button"
  class="hero"
  class:leaving
  class:entering
  onclick={onEnter}
  aria-label={t('hero_enter')}
  aria-busy={entering ? 'true' : undefined}
  disabled={entering}
>
  <div class="title">
    <span class="latin">cheoma</span>
    <span class="seal" aria-hidden="true"></span>
  </div>
  {#if entering}
    <!-- 진행 표시는 한지 위 먹선 한 획 — 스피너가 로딩 구간의 주인공이 되지 않게 미세 스케일로. -->
    <div class="enter" data-entry-progress role="status" aria-live="polite">
      <span class="stroke" aria-hidden="true"><i></i></span>
      {t('hero_entering')}
    </div>
  {:else}
    <div class="enter">{t('hero_enter')}</div>
  {/if}
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
  .hero:focus-visible {
    outline: 3px solid var(--seal);
    outline-offset: -7px;
  }

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

  /* 준비 구간(#16): 누름은 즉시 확인되고, 대기는 먹선 한 획으로만 표시한다. */
  /* 누름 피드백은 **브라우저의 :active** 가 준다 — JS·Svelte 업데이트를 기다리지 않는다.
     실측(2026-08-06, scratch/entry-feel): 클릭 직후 롱태스크 273ms + 1260ms 가 메인 스레드를
     채워, `entering` 클래스는 11ms 에 붙는데 그 **첫 페인트는 248ms** 뒤였다 — 사용자가 "반응이
     느리다"고 한 구간이 정확히 그것이다. transform/opacity 만 바꾸면 컴포지터가 단독으로 그리므로
     메인 스레드가 막혀 있어도 누른 프레임에 반응이 보인다. width·색·filter 로 바꾸면 안 된다. */
  .hero:active .title { transform: scale(0.985); }
  .hero:active .enter { opacity: 1; }
  .hero .title { transition: transform 0.12s cubic-bezier(0.22, 1, 0.36, 1); }
  .hero.entering { cursor: progress; }
  .hero.entering .title { opacity: 0.72; transition: opacity 0.4s ease, transform 0.12s ease; }
  .enter[data-entry-progress] {
    display: inline-flex; flex-direction: column; align-items: center; gap: 7px;
    color: var(--ink-soft);
    animation: none;                      /* 대기 중엔 문구를 깜박이지 않는다 */
  }
  /* 붓이 한 획 지나가는 느낌 — 폭 2.6rem, 먹빛에서 주묵으로 옅게 흘렀다 돌아온다.
     이 구간은 사전생성 청킹이 메인 스레드를 채우는 시간이라 프레임이 희소하다(6초에 2~4프레임
     실측). 그래서 획은 **컴포지터가 단독으로 돌릴 수 있는 속성만** 쓴다 — 홈은 정지한 채
     내부 붓만 transform: translateX 로 지나간다. background-position 처럼 페인트가 필요한
     속성으로 되돌리면 대기 중에 획이 그대로 멈춘다(그게 원래 증상이었다). */
  .enter[data-entry-progress] .stroke {
    position: relative;
    width: 2.6rem; height: 2px; border-radius: 1px;
    overflow: hidden;
    background: rgba(44, 38, 32, 0.1);
  }
  .enter[data-entry-progress] .stroke i {
    position: absolute; inset: 0;
    background: linear-gradient(90deg,
      rgba(44, 38, 32, 0) 0%,
      rgba(44, 38, 32, 0.34) 38%,
      var(--seal) 62%,
      rgba(44, 38, 32, 0) 100%);
    will-change: transform;
    animation: brush 1.9s ease-in-out infinite;
  }
  @keyframes brush {
    0% { transform: translateX(-100%); opacity: 0.5; }
    50% { opacity: 0.95; }
    100% { transform: translateX(100%); opacity: 0.5; }
  }
  @media (prefers-reduced-motion: reduce) {
    .enter[data-entry-progress] .stroke i { animation-duration: 3.6s; }
  }

  /* 가로 폰(짧은 높이): 타이틀·간격을 줄여 한 화면에. */
  @media (max-height: 520px) and (orientation: landscape) {
    .hero { gap: 0.5rem; padding: 4vh 8vw; }
    .title { font-size: clamp(32px, 9vh, 58px); }
    .enter { margin-top: 0.3rem; }
  }
</style>
