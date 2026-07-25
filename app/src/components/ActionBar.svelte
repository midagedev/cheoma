<script>
  // 우하 "공유" 독(#158 B안) — 장면을 밖으로 내보내는 모든 창구를 단독으로 소유한다:
  //   사진(PNG) · 링크(장면 URL) · 모델(.glb) · 소리, 그리고 감상 진입(드론·거닐기).
  //   구 ActionBar 의 승계자이므로 셀렉터(.actions, [data-action], .seal)는 그대로 유지한다.
  //   P9: 공유·내보내기가 패널·레거시 패널과 3중 구현이던 것을 여기 하나로 모았고,
  //   편집 중 독을 숨기던 hideActions 규칙은 폐기됐다(패널이 독과 겹치지 않는 슬롯을 쓴다).
  import { t } from '../lib/i18n.svelte.js';
  // raised: 세로 모바일 부감에서 하단 peek 시트 위로 올려 겹침 방지.
  // onReroll: 레거시 단일건물 씬에서만 전달(새 씨앗). 마을 씬은 만들기 패널이 소유.
  // onExport: 컨텍스트에 맞는 대상(부감=마을 / 근접=그 건물)을 App 이 골라 전달. null 이면 미노출.
  // lifted: 세로 모바일에서 만들기 시트가 펼쳐진 동안(편집·전환) 시트 위 씬 영역으로 올린다 —
  //   구현상 시트 상한(58vh)과 같은 상수를 쓰므로 독이 시트를 덮거나 시트에 덮이지 않는다.
  let {
    onReroll = null, onPostcard = null, onShare = null, onExport = null, onToggleAudio = null,
    audioOn = false, busy = false, raised = false, lifted = false, exporting = false,
    onDrone = null, onWalk = null,
  } = $props();
</script>

<div class="actions" class:raised class:lifted role="group" aria-label={t('axis_share')}>
  {#if onDrone || onWalk}
    <div class="watchgroup">
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
    </div>
  {/if}
  {#if onReroll}
    <button class="seal primary" onclick={onReroll} disabled={busy} title={t('act_rebuild_tip')}>
      <span class="face">{t('act_rebuild')}</span>
    </button>
  {/if}
  {#if onPostcard}
    <button class="seal" data-action="postcard" onclick={onPostcard} title={t('act_postcard_tip')}>
      <span class="face">{t('act_postcard')}</span>
    </button>
  {/if}
  {#if onShare}
    <button class="seal" data-action="share" onclick={onShare} title={t('act_share_tip')}>
      <span class="face">{t('act_share')}</span>
    </button>
  {/if}
  {#if onExport}
    <button
      class="seal"
      data-action="export"
      onclick={onExport}
      disabled={exporting || busy}
      title={t('glb_house_tip')}
    >
      <span class="face">{exporting ? t('glb_exporting') : t('act_glb')}</span>
    </button>
  {/if}
  {#if onToggleAudio}
    <button
      class="seal round"
      class:active={audioOn}
      onclick={onToggleAudio}
      title={audioOn ? t('act_sound_on_tip') : t('act_sound_off_tip')}
      aria-pressed={audioOn}
    >
      <span class="face note">♪</span>
    </button>
  {/if}
</div>

<style>
  .actions {
    position: fixed;
    right: clamp(14px, 2.4vw, 30px);
    bottom: clamp(16px, 3vh, 34px);
    z-index: 34;              /* 만들기 패널(32) 위 — 편집 중에도 공유가 살아 있다 */
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    /* 좁은 폭에서는 화면 밖으로 넘치지 않고 위로 한 줄 접힌다(하단 고정이라 위로 자란다). */
    flex-wrap: wrap;
    max-width: calc(100vw - 2 * clamp(14px, 2.4vw, 30px));
    gap: 10px;
    transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* 감상 진입(드론·거닐기)은 시각적으로 한 묶음 — 출력 액션과 위계를 구분한다. */
  .watchgroup {
    display: flex; align-items: flex-end; gap: 8px;
    padding-right: 10px; margin-right: 2px;
    border-right: 1px solid rgba(244, 239, 228, 0.34);
  }
  /* 모바일: safe-area(노치·홈 인디케이터) 존중 + 엄지 도달. */
  @media (pointer: coarse) {
    .actions {
      right: max(14px, env(safe-area-inset-right));
      bottom: max(16px, calc(env(safe-area-inset-bottom) + 12px));
      z-index: 47;   /* 만들기 시트(46) 위 — 편집 중에도 공유 독이 보인다 */
    }
  }
  /* 세로 모바일 부감 peek 시트(손잡이 ≈80px) 위로 올림. */
  @media (max-width: 768px) and (orientation: portrait) {
    .actions.raised { bottom: max(96px, calc(env(safe-area-inset-bottom) + 90px)); }
    /* 펼쳐진 시트(58vh 상한) 위 — 편집 중에도 독이 시트와 겹치지 않고 씬 위에 남는다. */
    .actions.lifted { bottom: calc(58vh + 14px); }
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

  /* 다시 짓기 = 전각 도장(주묵) 강조 — 레거시 단일건물 씬 전용 */
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

  /* 좁은 폭: 독이 화면을 넘지 않게 줄바꿈 대신 축소(사진·링크·모델 라벨은 유지). */
  @media (max-width: 430px) {
    .actions { gap: 7px; left: auto; max-width: calc(100vw - 20px); }
    .seal { min-width: 50px; height: 52px; padding: 0 9px; }
    .seal .face { font-size: 13px; }
    .seal.round { width: 46px; min-width: 46px; height: 46px; }
    .watchgroup { gap: 6px; padding-right: 7px; }
  }
</style>
