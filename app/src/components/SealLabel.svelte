<script>
  // 좌하 낙관(도장) + 씨앗번호 + en/ko 미니 토글. 브랜딩 다이어트(#72): 세로 붓글씨 '처마'는
  // 제거하고 낙관 하나만 브랜드 마크로 남긴다('처마' 노출은 이 낙관 1회뿐). 낙관은 로케일 불변.
  import { i18n, setLang } from '../lib/i18n.svelte.js';
  let { seed = 0, onInfo } = $props();
  const seedStr = $derived('#' + String(seed >>> 0).slice(-4).padStart(4, '0'));
  const infoLabel = $derived(i18n.lang === 'ko' ? '참고 자료' : 'References & credits');
</script>

<div class="seal-label">
  <button class="brand" onclick={onInfo} aria-label={infoLabel} title={infoLabel}>
    <span class="stamp" aria-hidden="true">처마</span>
  </button>
  <div class="meta">
    <span class="seed" title={'seed ' + (seed >>> 0)}>{seedStr}</span>
    <button class="info" onclick={onInfo} aria-label={infoLabel} title={infoLabel}>ⓘ</button>
  </div>
  <div class="lang">
    <button class:on={i18n.lang === 'en'} onclick={() => setLang('en')}>EN</button>
    <span class="sep">·</span>
    <button class:on={i18n.lang === 'ko'} onclick={() => setLang('ko')}>한</button>
  </div>
</div>

<style>
  .seal-label {
    position: fixed;
    left: clamp(14px, 2.4vw, 30px);
    bottom: clamp(16px, 3vh, 34px);
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.55rem;
    user-select: none;
    pointer-events: none;
  }
  /* 낙관(브랜드 마크)을 클릭 → 참고 자료 모달. 컨테이너는 none 이라 여기만 auto 복구. */
  .brand {
    pointer-events: auto; cursor: pointer;
    -webkit-appearance: none; appearance: none; border: none; background: none; padding: 0;
    display: flex; align-items: center;
  }
  .brand:focus-visible { outline: none; }
  .brand:focus-visible .stamp { box-shadow: 0 0 0 2px var(--paper), 0 0 0 3px var(--seal); }
  /* seed·ⓘ 를 한 줄로 묶어 밀도를 낮춘다(#72). */
  .meta { display: flex; align-items: center; gap: 6px; }
  /* ⓘ — 작은 참고 자료 트리거. */
  .info {
    pointer-events: auto; cursor: pointer;
    -webkit-appearance: none; appearance: none; border: none; background: none; padding: 2px 3px;
    font-family: var(--serif); font-size: 13px; line-height: 1; color: var(--ink-faint);
    text-shadow: 0 1px 8px rgba(244, 239, 228, 0.7);
    transition: color 0.2s ease;
  }
  .info:hover, .info:focus-visible { color: var(--seal); outline: none; }
  .stamp {
    writing-mode: vertical-rl;
    font-family: var(--serif);
    font-weight: 700;
    font-size: 12px;
    line-height: 1.05;
    letter-spacing: 0.12em;
    color: var(--paper);
    background: var(--seal);
    padding: 6px 3px;
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgba(120, 40, 30, 0.28), 0 2px 6px rgba(60, 30, 20, 0.28);
    transform-origin: center;
    animation: stamp 0.52s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  /* 낙관 "쾅" — 크게 내려찍혀 살짝 눌렸다 자리잡는 두부 탄성. */
  @keyframes stamp {
    0% { transform: scale(1.55) rotate(-7deg); opacity: 0; }
    55% { transform: scale(0.9) rotate(1.5deg); opacity: 1; }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
  }
  .seed {
    font-family: var(--serif);
    font-size: 13px;
    letter-spacing: 0.14em;
    color: var(--ink-soft);
    text-shadow: 0 1px 8px rgba(244, 239, 228, 0.7);
  }
  .lang {
    pointer-events: auto; /* seal-label 은 none 이라 토글만 복구 */
    display: flex; align-items: center; gap: 5px;
    font-family: var(--serif); font-size: 11px; letter-spacing: 0.08em;
    text-shadow: 0 1px 8px rgba(244, 239, 228, 0.7);
  }
  .lang button {
    -webkit-appearance: none; appearance: none; border: none; background: none;
    padding: 2px 3px; font: inherit; color: var(--ink-faint); cursor: pointer;
    transition: color 0.2s ease;
  }
  .lang button:hover { color: var(--ink-soft); }
  .lang button.on { color: var(--seal); font-weight: 700; }
  .lang .sep { color: var(--ink-faint); opacity: 0.6; }

  /* 모바일: safe-area 존중 + 축소(브랜드 낙관은 유지하되 작게). 언어 토글 탭 타깃 확대. */
  @media (pointer: coarse) {
    .seal-label {
      left: max(12px, calc(env(safe-area-inset-left) + 4px));
      bottom: max(14px, calc(env(safe-area-inset-bottom) + 8px));
      gap: 0.4rem;
    }
    .stamp { font-size: 11px; }
    .info { font-size: 17px; padding: 6px 8px; }
    .lang { font-size: 13px; gap: 8px; }
    .lang button { padding: 4px 6px; }
  }
</style>
