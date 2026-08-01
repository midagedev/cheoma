<script>
  // 시네마틱 데모 중 오버레이(#112) — 크롬을 최소화(chroma 페이드·패널 숨김)한 대신 종료 창구와
  //   현재 상태(드론 패스·1인칭)를 담백하게 알린다. 탭/클릭·ESC 로도 종료되지만 명시 버튼을 둔다.
  import { t } from '../lib/i18n.svelte.js';
  import { device } from '../lib/device.svelte.js';

  let { active = false, mode = null, pass = null, onExit, onMove } = $props();

  const walking = $derived(active && mode === 'walk');

  // ── 구간 라벨 폐지(2026-08-01, 사용자 판정) ──
  // 드론 감상은 **하나의 연속 비행**이다. 구간(crane-in / landmark-orbit / street-flythrough /
  //   pullback-reveal)은 dronepath.js 가 하나의 닫힌 곡선을 잘라 놓은 **내부 저작·검증 단위**일 뿐이고,
  //   경계에서 위치·속도·시선·화각이 모두 연속이라 화면에는 이음매가 없다. 그런데 라벨이 "진입 →
  //   선회 → 골목 비행 → 전경"으로 바뀌며 뜨면 없는 분절을 만들어 보여 준다("모드를 별도로 두지 말라").
  //   그래서 드론에서는 라벨을 내지 않는다. 워킹뷰는 사용자가 조작하는 **다른 모드**라 그대로 남긴다.
  //   `pass` prop 은 계속 받는다 — 소비면(engine emit·verify-cinewire·shoot-cine)의 계약이고, 이 파일이
  //   그것을 화면에 그리지 않을 뿐이다.
  const label = $derived(mode === 'walk' ? t('cine_walk_label') : '');

  // 감상 크롬 자동 후퇴 — 클립은 OS 화면녹화로 뜨므로(인앱 녹화는 만들지 않는다) 패스 라벨·하단
  //   안내·종료 버튼이 프레임에 구워지면 안 된다. 마지막 실입력 후 IDLE_MS 에 opacity 만 0 으로
  //   물러난다: DOM 과 pointer-events 는 그대로라 종료 버튼은 투명해도 탭 가능하고(check-ui-shell 의
  //   exitPresent 계약), ESC 종료는 App.onKey 소유라 여기와 무관하게 항상 동작한다.
  //   App 의 .chroma 감상 페이드(wake/idleTimer 3s)와 겹치지 않는다 — .chroma 는 cine.active 만으로
  //   이미 전부 물러나 있고 그 타이머의 보류 조건(선택·편집·레퍼런스 모달)은 감상 중엔 의미가 없다.
  //   이 오버레이는 active 동안만 마운트되므로 타이머·리스너 수명을 여기서 소유하는 편이 정확하다.
  const IDLE_MS = 2500;
  let dimmed = $state(false);

  $effect(() => {
    if (!active) { dimmed = false; return; }
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; dimmed = true; }, IDLE_MS);
    };
    const onInput = (e) => {
      // 모바일: 숨은 크롬을 부르는 첫 탭은 '재등장' 만 의미해야 한다. 드론 데모는 캔버스 탭 = 종료라서
      //   (engine.js onCanvasPointerDown) 같은 탭에 두 뜻이 겹치면 크롬을 보려던 탭이 감상을 끝낸다.
      //   window capture 가 캔버스 capture 보다 먼저이므로 그 한 번만 삼킨다. hover 가 있는 마우스는
      //   pointermove 로 이미 깨어나므로 제외 — 데스크톱의 클릭=종료 의미는 그대로 남는다.
      //   오버레이 자신을 겨눈 포인터는 통과시켜 종료 버튼 탭이 항상 살아 있게 한다.
      if (e.type === 'pointerdown' && dimmed && e.pointerType !== 'mouse'
          && !e.target?.closest?.('.cine-overlay')) {
        e.stopPropagation();
      }
      dimmed = false;
      arm();
    };
    const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
    for (const ev of EVENTS) addEventListener(ev, onInput, { capture: true, passive: true });
    arm();
    return () => {
      for (const ev of EVENTS) removeEventListener(ev, onInput, { capture: true });
      if (timer) clearTimeout(timer);
      dimmed = false;
    };
  });

  // ── 가상 조이스틱(#33) ── 워킹뷰가 수동 탐험이 된 이상 키보드가 없는 기기에도 이동 수단이 있어야
  //   한다. 시선은 화면 드래그가 담당하므로(App.onWalkPointerDown) 여기서는 이동 벡터만 낸다.
  //   조이스틱은 크롬이 아니라 컨트롤이라 .chrome 자동 후퇴에 함께 사라지지 않는다.
  const JOY_R = 44;              // 베이스 반경(px) — 노브 최대 변위 = 입력 크기 1
  const JOY_DEAD = 5;            // 데드존(px): 손가락 미세 떨림이 0.11 짜리 이동으로 새지 않게
  let joyPid = $state(null);
  let joyKnob = $state({ x: 0, y: 0 });
  let joyEl = $state(null);

  function joyVector(dx, dy) {
    const len = Math.hypot(dx, dy);
    if (len < JOY_DEAD) return { x: 0, y: 0, fwd: 0, strafe: 0 };
    const k = len > JOY_R ? JOY_R / len : 1;
    const kx = dx * k, ky = dy * k;
    return { x: kx, y: ky, fwd: -ky / JOY_R, strafe: kx / JOY_R };
  }
  function joyUpdate(e) {
    const rect = joyEl?.getBoundingClientRect();
    if (!rect) return;
    const v = joyVector(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
    joyKnob = { x: v.x, y: v.y };
    onMove?.({ fwd: v.fwd, strafe: v.strafe });
  }
  function joyDown(e) {
    if (joyPid !== null) return;
    joyPid = e.pointerId;
    joyEl?.setPointerCapture?.(e.pointerId);
    joyUpdate(e);
  }
  function joyMove(e) { if (e.pointerId === joyPid) joyUpdate(e); }
  function joyUp(e) {
    if (e.pointerId !== joyPid) return;
    joyPid = null;
    joyKnob = { x: 0, y: 0 };
    onMove?.({ fwd: 0, strafe: 0 });
  }

  // 모드를 벗어나면 눌린 채 남은 이동 의도를 반드시 놓아 준다(종료 후 무한 전진 방지).
  $effect(() => {
    if (walking) return;
    joyPid = null;
    joyKnob = { x: 0, y: 0 };
    onMove?.({ fwd: 0, strafe: 0 });
  });
</script>

{#if active}
  <!-- 상단 중앙: 현재 장면 라벨(담백). 하단 중앙: 종료 힌트. 우상단: 종료 버튼. -->
  <div class="cine-overlay" role="status" aria-live="polite">
    <div class="chrome" class:dimmed data-cine-chrome>
      {#if label}<div class="scene-label"><span class="dot" aria-hidden="true"></span>{label}</div>{/if}
      <button
        class="exit"
        data-cine-exit
        onclick={() => onExit?.()}
        title={t('cine_exit_tip')}
        aria-label={t('cine_exit_tip')}
      >
        <span class="x" aria-hidden="true">✕</span><span class="lbl">{t('cine_exit')}</span>
      </button>
      <div class="hint">
        {walking ? t(device.touch ? 'cine_walk_hint_touch' : 'cine_walk_hint') : t('cine_hint')}
      </div>
    </div>
    {#if walking && device.touch}
      <!-- 좌하단 가상 조이스틱: 이동만. 시선은 화면 어디든 드래그(App 이 소유). -->
      <div
        class="joy"
        bind:this={joyEl}
        data-cine-joystick
        role="application"
        aria-label={t('cine_walk_move')}
        onpointerdown={joyDown}
        onpointermove={joyMove}
        onpointerup={joyUp}
        onpointercancel={joyUp}
      >
        <div class="joy-knob" class:held={joyPid !== null} style="translate: {joyKnob.x}px {joyKnob.y}px"></div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .cine-overlay { position: fixed; inset: 0; z-index: 60; pointer-events: none; }
  /* 자동 후퇴는 opacity 만 — 레이아웃·히트테스트는 유지되므로 투명한 종료 버튼도 계속 눌린다.
     자식이 absolute 로 자리를 잡으므로 이 래퍼도 같은 사각형의 containing block 이어야 한다. */
  .chrome { position: absolute; inset: 0; pointer-events: none; transition: opacity 0.55s ease; }
  .chrome.dimmed { opacity: 0; }
  /* 키보드로 종료 버튼에 들어와 있으면 후퇴시키지 않는다(보이지 않는 포커스 금지). */
  .chrome.dimmed:focus-within { opacity: 1; }
  .scene-label {
    position: absolute;
    top: max(18px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 15px;
    border-radius: 999px;
    background: var(--glass-strong);
    border: 1px solid var(--glass-border);
    color: var(--glass-text);
    font-size: var(--spectrum-font-size-100, 14px);
    font-weight: 650;
    letter-spacing: 0.04em;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    animation: fadein 0.6s ease both;
  }
  .scene-label .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 55%, transparent);
    animation: pulse 1.8s ease-in-out infinite;
  }
  .exit {
    position: absolute;
    top: max(16px, env(safe-area-inset-top));
    right: max(16px, env(safe-area-inset-right));
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 40px;
    padding: 9px 14px;
    border-radius: 999px;
    border: 1px solid var(--glass-border);
    background: var(--glass-strong);
    color: var(--glass-text);
    font-size: var(--spectrum-font-size-100, 14px);
    font-weight: 650;
    cursor: pointer;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    transition: background 0.15s ease;
  }
  .exit .x { font-size: 13px; line-height: 1; }
  .exit:hover { background: rgba(255, 255, 255, 0.1); }
  .exit:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .hint {
    position: absolute;
    bottom: max(24px, calc(env(safe-area-inset-bottom) + 18px));
    left: 50%;
    transform: translateX(-50%);
    color: var(--glass-muted);
    font-size: var(--spectrum-font-size-75, 12px);
    letter-spacing: 0.04em;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    animation: fadehint 5s ease forwards;
  }
  @keyframes fadein { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes fadehint { 0% { opacity: 0; } 12% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0.25; } }
  /* 조이스틱은 .chrome 밖이라 감상 크롬이 물러나도 남는다 — 컨트롤이지 라벨이 아니다.
     JOY_R(44px) = 베이스 반지름이므로 지름 88px + 링 두께. 터치 타깃 최소 44px 를 넉넉히 넘는다. */
  .joy {
    position: absolute;
    left: max(22px, calc(env(safe-area-inset-left) + 14px));
    bottom: max(30px, calc(env(safe-area-inset-bottom) + 22px));
    width: 96px;
    height: 96px;
    border-radius: 50%;
    pointer-events: auto;
    touch-action: none;
    background: var(--glass-strong);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: grid;
    place-items: center;
    opacity: 0.62;
    transition: opacity 0.2s ease;
  }
  .joy:has(.held) { opacity: 0.9; }
  .joy-knob {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--glass-text) 62%, transparent);
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
    transition: translate 0.09s ease-out, background 0.15s ease;
  }
  .joy-knob.held { background: var(--accent); transition: background 0.15s ease; }
  @media (pointer: coarse) {
    .exit { min-height: 44px; padding: 12px 16px; font-size: 14px; }
    .scene-label { font-size: 14px; padding: 9px 17px; }
  }
</style>
