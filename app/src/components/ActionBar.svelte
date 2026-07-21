<script>
  // 우하: 주요 액션(도장 모양 버튼) — (다시 짓기) / 사진 찍기 / 사운드.
  import { t } from '../lib/i18n.svelte.js';
  // raised: 마을 부감에서 하단 peek 옵션 시트 위로 액션바를 올려 겹침 방지(모바일).
  // onReroll: 단일건물 씬(레거시)에서만 전달 — 마을 씬은 리롤/리플레이를 컨텍스트 패널이 소유(#100)하므로
  //   null 이면 도장 미노출. shifted: 우측 편집 패널이 열리면(데스크톱) 패널 왼쪽으로 밀어 가려지지 않게.
  // onDrone/onWalk: 마을 부감에서만 전달(시네마틱 데모 진입). null 이면 미노출.
  let { onReroll = null, onPostcard, onToggleAudio, audioOn = false, busy = false, raised = false, shifted = false,
    onDrone = null, onWalk = null } = $props();
</script>

<div class="actions" class:raised class:shifted>
  {#if onReroll}
    <button class="seal primary" onclick={onReroll} disabled={busy} title={t('act_rebuild_tip')}>
      <span class="face">{t('act_rebuild')}</span>
    </button>
  {/if}
  {#if onDrone}
    <button class="seal round" onclick={onDrone} disabled={busy} title={t('act_drone_tip')} aria-label={t('act_drone_tip')}>
      <span class="face glyph">▷</span>
    </button>
  {/if}
  {#if onWalk}
    <button class="seal round" onclick={onWalk} disabled={busy} title={t('act_walk_tip')} aria-label={t('act_walk_tip')}>
      <span class="face glyph">步</span>
    </button>
  {/if}
  <button class="seal" onclick={onPostcard} title={t('act_postcard_tip')}>
    <span class="face">{t('act_postcard')}</span>
  </button>
  <button
    class="seal round"
    class:active={audioOn}
    onclick={onToggleAudio}
    title={audioOn ? t('act_sound_on_tip') : t('act_sound_off_tip')}
    aria-pressed={audioOn}
  >
    <span class="face note">♪</span>
  </button>
</div>

<style>
  .actions {
    position: fixed;
    right: clamp(14px, 2.4vw, 30px);
    bottom: clamp(16px, 3vh, 34px);
    z-index: 20;
    display: flex;
    align-items: flex-end;
    gap: 10px;
    transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* 우측 한지 패널(width min(320px,84vw))이 열리면 액션바를 패널 왼쪽으로 밀어 가려지지 않게 한다. */
  .actions.shifted { transform: translateX(calc(-1 * min(320px, 84vw) - 14px)); }
  /* 모바일: safe-area(노치·홈 인디케이터) 존중 + 엄지 도달. */
  @media (pointer: coarse) {
    .actions {
      right: max(14px, env(safe-area-inset-right));
      bottom: max(16px, calc(env(safe-area-inset-bottom) + 12px));
      z-index: 42;   /* peek 옵션 시트(46)보다 아래지만 스크림 위 */
    }
  }
  /* 마을 부감 peek 옵션 시트(손잡이+제목 ≈80px) 위로 올림. */
  @media (max-width: 768px) and (orientation: portrait) {
    .actions.raised { bottom: max(96px, calc(env(safe-area-inset-bottom) + 90px)); }
  }
  .seal {
    -webkit-appearance: none;
    appearance: none;
    border: none;
    min-width: 58px;
    width: auto;
    height: 58px;
    padding: 0 14px;
    border-radius: 6px;
    display: grid;
    place-items: center;
    font-family: var(--serif);
    background-color: var(--paper);
    background-image:
      var(--hanji),
      linear-gradient(160deg, var(--paper) 0%, var(--paper-2) 60%, var(--paper-3) 100%);
    border: 1px solid var(--ink-hair);
    box-shadow: 0 2px 10px rgba(30, 22, 14, 0.18), inset 0 0 0 1px rgba(255, 255, 255, 0.4);
    color: var(--ink);
    transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.2s ease;
  }
  .seal .face {
    font-size: 15px;
    line-height: 1.06;
    letter-spacing: 0.04em;
    font-weight: 700;
    text-align: center;
    white-space: nowrap;
  }
  .seal.round { border-radius: 50%; width: 52px; min-width: 52px; height: 52px; padding: 0; }
  .seal .note { font-size: 20px; color: var(--ink-faint); }
  /* 시네마틱 진입(드론 ▷ / 거닐기 步) — 먹빛 전각 글리프. */
  .seal .glyph { font-size: 20px; font-weight: 700; color: var(--ink); line-height: 1; }
  .seal.round.active { background: var(--seal); border-color: var(--seal-deep); }
  .seal.round.active .note { color: var(--paper); }

  /* 다시 짓기 = 전각 도장(주묵) 강조 */
  .seal.primary {
    min-width: 64px;
    height: 64px;
    background: var(--seal);
    background-image: var(--hanji), linear-gradient(160deg, #bb3e31 0%, #a5322a 60%, #8f2a23 100%);
    border-color: var(--seal-deep);
    box-shadow: 0 3px 14px rgba(120, 40, 30, 0.34), inset 0 0 0 1px rgba(255, 220, 210, 0.22);
  }
  .seal.primary .face { color: var(--paper); }

  .seal:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(30, 22, 14, 0.26); }
  .seal:active { transform: translateY(0) scale(0.96); }
  .seal:disabled { filter: saturate(0.6) opacity(0.6); cursor: default; }
  .seal:focus-visible { outline: 2px solid var(--seal); outline-offset: 3px; }
</style>
