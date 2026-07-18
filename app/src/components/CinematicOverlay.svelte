<script>
  // 시네마틱 데모 중 오버레이(#112) — 크롬을 최소화(chroma 페이드·패널 숨김)한 대신 종료 창구와
  //   현재 상태(드론 패스·1인칭)를 담백하게 알린다. 탭/클릭·ESC 로도 종료되지만 명시 버튼을 둔다.
  import { t } from '../lib/i18n.svelte.js';

  let { active = false, mode = null, pass = null, onExit } = $props();

  // 드론 패스명 → 사람이 읽는 라벨(dronepath.js name 규약).
  const PASS_LABEL = {
    'crane-in': 'cine_pass_crane',
    'landmark-orbit': 'cine_pass_orbit',
    'street-flythrough': 'cine_pass_fly',
    'pullback-reveal': 'cine_pass_pull',
  };
  const label = $derived(
    mode === 'walk' ? t('cine_walk_label') : (pass && PASS_LABEL[pass] ? t(PASS_LABEL[pass]) : '')
  );
</script>

{#if active}
  <!-- 상단 중앙: 현재 장면 라벨(담백). 하단 중앙: 종료 힌트. 우상단: 종료 버튼. -->
  <div class="cine-overlay" role="status" aria-live="polite">
    {#if label}<div class="scene-label"><span class="dot" aria-hidden="true"></span>{label}</div>{/if}
    <button class="exit" onclick={() => onExit?.()} title={t('cine_exit_tip')} aria-label={t('cine_exit_tip')}>
      <span class="x" aria-hidden="true">✕</span><span class="lbl">{t('cine_exit')}</span>
    </button>
    <div class="hint">{t('cine_hint')}</div>
  </div>
{/if}

<style>
  .cine-overlay { position: fixed; inset: 0; z-index: 60; pointer-events: none; }
  /* 장면 라벨 — 상단 중앙, 반투명 먹빛 캡슐. */
  .scene-label {
    position: absolute; top: max(18px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px;
    padding: 7px 15px; border-radius: 20px;
    background: rgba(24, 20, 16, 0.42); color: rgba(244, 239, 228, 0.94);
    font-family: var(--serif); font-size: 13px; font-weight: 700; letter-spacing: 0.06em;
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    animation: fadein 0.6s ease both;
  }
  .scene-label .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--seal); box-shadow: 0 0 6px rgba(187, 62, 49, 0.8); animation: pulse 1.8s ease-in-out infinite; }
  /* 종료 버튼 — 우상단, 포인터 이벤트 활성. */
  .exit {
    position: absolute; top: max(16px, env(safe-area-inset-top)); right: max(16px, env(safe-area-inset-right));
    pointer-events: auto; display: flex; align-items: center; gap: 7px;
    padding: 9px 14px; border-radius: 22px; border: 1px solid rgba(244, 239, 228, 0.28);
    background: rgba(24, 20, 16, 0.42); color: rgba(244, 239, 228, 0.94);
    font-family: var(--serif); font-size: 13px; font-weight: 700; cursor: pointer;
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    transition: background 0.15s ease, transform 0.12s ease;
  }
  .exit .x { font-size: 13px; line-height: 1; }
  .exit:hover { background: rgba(40, 32, 24, 0.6); transform: translateY(-1px); }
  .exit:focus-visible { outline: 2px solid var(--seal); outline-offset: 2px; }
  /* 종료 힌트 — 하단 중앙, 은은하게 페이드(감상 방해 최소화). */
  .hint {
    position: absolute; bottom: max(24px, calc(env(safe-area-inset-bottom) + 18px)); left: 50%; transform: translateX(-50%);
    color: rgba(244, 239, 228, 0.72); font-family: var(--serif); font-size: 12px; letter-spacing: 0.05em;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    animation: fadehint 5s ease forwards;
  }
  @keyframes fadein { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes fadehint { 0% { opacity: 0; } 12% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0.25; } }
  @media (pointer: coarse) {
    .exit { padding: 12px 16px; font-size: 14px; }
    .scene-label { font-size: 14px; padding: 9px 17px; }
  }
</style>
