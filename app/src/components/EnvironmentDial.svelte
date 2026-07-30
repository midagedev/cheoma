<script>
  // Viewport "View" card — environment rings + flow chips.
  // Anchored to the top-right of the *scene* (left of the inspector dock via
  // --inspector-w), not the window corner, so the CAD column never covers it.
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n.svelte.js';
  import {
    SEASON_IDS,
    SUNSET_LOOK_IDS,
    WEATHER_IDS,
    pickEnvironmentScene,
  } from '../../../src/api/environment.js';
  // compact: 세로 폰에서 만들기 시트가 펼쳐진 동안. 그 프레임에서는 시트 + 보기 카드 + 올라온
  //   공유 독이 동시에 상주할 수 없다 — 390×844 실측으로 "넓은 건축물이 들어가는 밴드"와
  //   "가시 스크롤 ≥200px" 가 함께 성립하지 않는다(ui-consolidation §6.10). 결정 (A)(§6.13):
  //   **편집 중 보기 축은 44px 칩 하나로 접히고**, 칩은 현재 환경을 계속 표시한다. 펼침은
  //   편집 시트를 건드리지 않는 오버레이라 detent 는 그대로다.
  let { time = 'day', sunsetLook = 'gold', season = 'summer', weather = 'clear',
        compact = false,
        flowing = false, onTime, onSunsetLook, onSeason, onWeather, onFlowToggle } = $props();

  // 접힘은 compact 구간에서만 존재한다. 부감으로 돌아오거나 데스크톱/가로 폰 셸이면 카드가
  // 그대로 상주하므로 상태를 남겨두지 않는다(다음 편집 진입도 접힌 상태에서 시작).
  let expanded = $state(false);
  const collapsed = $derived(compact && !expanded);
  $effect(() => { if (!compact) expanded = false; });

  // 접힌 칩의 상태 표시(§6.13 조건 1) — 접기가 정보 상실이 되면 안 된다. 앱이 이미 쓰는
  // 한자 글리프 어휘를 그대로 이어 시간·계절을 한 자씩, 날씨는 기본값을 벗어날 때만 옅은
  // 부기호로 붙인다. 전체 문구는 aria-label·title 이 읽어준다.
  const TIME_GLYPH = { dawn: '曉', day: '晝', sunset: '暮', night: '夜' };
  const SEASON_GLYPH = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
  const WEATHER_GLYPH = { clear: '', rain: '雨', snow: '雪' };
  const marks = $derived([
    WEATHER_GLYPH[weather] || '',
  ].filter(Boolean));
  const stateText = $derived([
    t('time_' + time),
    t('season_' + season),
    t('weather_' + weather),
  ].join(' · '));

  function keydown(e) {
    if (e.key === 'Escape' && expanded) { expanded = false; }
  }

  const RINGS = [
    { key: 'time', lp: 'time_', r: 82, band: 26, get: () => time, set: (v) => onTime?.(v),
      opts: ['dawn', 'day', 'sunset', 'night'] },
    { key: 'season', lp: 'season_', r: 54, band: 24, get: () => season, set: (v) => onSeason?.(v),
      opts: SEASON_IDS },
    { key: 'weather', lp: 'weather_', r: 28, band: 22, get: () => weather, set: (v) => onWeather?.(v),
      opts: WEATHER_IDS },
  ];
  const label = (ring, v) => t(ring.lp + v);

  const C = 100; // svg center
  const angleOf = (i, n) => -90 + i * (360 / n);           // 도(top 기준 시계방향)
  const rad = (d) => (d * Math.PI) / 180;
  const px = (r, deg) => C + r * Math.cos(rad(deg));
  const py = (r, deg) => C + r * Math.sin(rad(deg));

  function selectedAngle(ring) {
    const i = ring.opts.indexOf(ring.get());
    return angleOf(i < 0 ? 0 : i, ring.opts.length);
  }

  // 드래그: 링 밴드에서 포인터 각도 → 최근접 세그먼트로 스냅(라이브).
  let svgEl;
  function ringFromPointer(ring, e) {
    const rect = svgEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    let deg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
    const n = ring.opts.length;
    let best = 0, bestD = 1e9;
    for (let i = 0; i < n; i++) {
      let d = Math.abs(((angleOf(i, n) - deg + 540) % 360) - 180);
      if (d < bestD) { bestD = d; best = i; }
    }
    return ring.opts[best];
  }
  let dragging = null;
  function down(ring, e) {
    dragging = ring;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    ring.set(ringFromPointer(ring, e));
  }
  function move(ring, e) {
    if (dragging !== ring) return;
    ring.set(ringFromPointer(ring, e));
  }
  function up() { dragging = null; }

  // 키보드: 화살표로 세그먼트 순회.
  function key(ring, e) {
    const n = ring.opts.length;
    let i = ring.opts.indexOf(ring.get());
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { i = (i + 1) % n; }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { i = (i - 1 + n) % n; }
    else return;
    e.preventDefault();
    ring.set(ring.opts[i]);
  }
  const valueText = (ring) => label(ring, ring.get());

  // 순수 코어의 큐레이션 풀을 공유해 시드·UI·검증이 같은 환경 조합을 사용한다.
  function pickEnvReroll(cur) {
    return pickEnvironmentScene(Math.random, cur);
  }
  onMount(() => {
    if (typeof window === 'undefined') return undefined;
    const hook = pickEnvReroll;
    window.__envRerollPick = hook; // playwright 검증 훅
    return () => {
      if (window.__envRerollPick === hook) delete window.__envRerollPick;
    };
  });

  let spins = $state(0);
  function rollEnv() {
    const c = pickEnvReroll({ ti: time, su: sunsetLook, se: season, we: weather });
    // 변경된 축만 호출(불필요한 재적용 방지) — 각 setter가 상태·URL·다이얼 표시를 동기.
    if (c.su && c.su !== sunsetLook) onSunsetLook?.(c.su);
    if (c.ti !== time) onTime?.(c.ti);
    if (c.se !== season) onSeason?.(c.se);
    if (c.we !== weather) onWeather?.(c.we);
    spins += 1; // 아이콘 360° 굴림 — 연타 시 회전이 누적돼 자연스러운 연속 스핀.
  }

  function cycleSunsetLook() {
    const index = SUNSET_LOOK_IDS.indexOf(sunsetLook);
    onSunsetLook?.(SUNSET_LOOK_IDS[(index + 1) % SUNSET_LOOK_IDS.length]);
  }
</script>

<svelte:window onkeydown={keydown} />

{#if collapsed}
  <!-- 접힌 보기 축(§6.13 A) — 카드가 있던 우상 슬롯에 44px 칩 하나. 칩 자체가 현재 환경이고,
       한 번 누르면 같은 자리에서 카드가 펼쳐진다(편집 시트는 건드리지 않는다). -->
  <button
    class="dial viewchip"
    data-view-chip
    type="button"
    aria-expanded="false"
    aria-label={t('view_expand') + ': ' + stateText}
    title={t('view_expand') + ' — ' + stateText}
    onclick={() => { expanded = true; }}
  >
    <span class="chipglyphs" aria-hidden="true">
      <span class="g">{TIME_GLYPH[time] || ''}</span><span class="g">{SEASON_GLYPH[season] || ''}</span>
    </span>
    {#if marks.length}
      <span class="chipmarks" aria-hidden="true">{marks.join('')}</span>
    {/if}
  </button>
{:else}
<div class="dial viewcard" class:compact role="group" aria-label={t('axis_view')}>
  {#if compact}
    <!-- 펼친 동안의 머리 행이 곧 접기 창구다 — 축 이름 옆 갈고리 한 개, 44px 타깃. -->
    <button
      class="collapse"
      data-view-collapse
      type="button"
      aria-expanded="true"
      aria-label={t('view_collapse')}
      title={t('view_collapse')}
      onclick={() => { expanded = false; }}
    >
      <span class="headlabel">{t('axis_view')}</span>
      <span class="fold" aria-hidden="true">▴</span>
    </button>
  {/if}
  <!-- Axis label omitted on the card — the rings are self-explanatory and the
       extra caption made the view tool look like a second header stack. -->
  <svg bind:this={svgEl} viewBox="0 0 200 200" width="164" height="164">
    <!-- 링 트랙 + 밴드 히트영역 -->
    {#each RINGS as ring}
      <circle class="track" cx={C} cy={C} r={ring.r} />
      <circle
        class="band"
        cx={C} cy={C} r={ring.r}
        stroke-width={ring.band}
        role="slider"
        tabindex="0"
        aria-label={t('dial_' + ring.key)}
        aria-valuetext={valueText(ring)}
        aria-valuenow={ring.opts.indexOf(ring.get())}
        aria-valuemin="0"
        aria-valuemax={ring.opts.length - 1}
        onpointerdown={(e) => down(ring, e)}
        onpointermove={(e) => move(ring, e)}
        onpointerup={up}
        onpointercancel={up}
        onkeydown={(e) => key(ring, e)}
      />
    {/each}

    <!-- 바늘(선택 각도로 스냅 회전) -->
    {#each RINGS as ring}
      {@const a = selectedAngle(ring)}
      <g class="needle">
        <circle class="knob" cx={px(ring.r, a)} cy={py(ring.r, a)} r="4.4" />
      </g>
    {/each}

    <!-- 세그먼트 라벨 -->
    {#each RINGS as ring}
      {#each ring.opts as opt, i}
        {@const a = angleOf(i, ring.opts.length)}
        <text
          class="lab"
          class:on={ring.get() === opt}
          x={px(ring.r, a)} y={py(ring.r, a)}
        >{label(ring, opt)}</text>
      {/each}
    {/each}

    <circle class="hub" cx={C} cy={C} r="7" />
  </svg>


  <!-- Spectrum action row — sunset tone orb stays custom (product color language). -->
  <div class="dial-actions">
    <sp-action-button
      class="dial-btn env-roll"
      quiet
      onclick={rollEnv}
      title={t('env_reroll_tip')}
      aria-label={t('env_reroll')}
    >
      <span class="rk-glyph" style="transform: rotate({spins * 360}deg)">⟳</span>
    </sp-action-button>
    {#if time === 'sunset'}
      <sp-action-button
        class="dial-btn sunset-tone {sunsetLook}"
        quiet
        onclick={cycleSunsetLook}
        title={t('sunset_look_tip') + ' — ' + t('sunset_look_' + sunsetLook)}
        aria-label={t('sunset_look_tip') + ': ' + t('sunset_look_' + sunsetLook)}
      >
        <span class="tone-orb" aria-hidden="true"></span>
      </sp-action-button>
    {/if}
    <sp-action-button
      class="dial-btn env-flow"
      quiet
      selected={flowing || undefined}
      onclick={() => onFlowToggle?.()}
      title={t(flowing ? 'env_flow_on_tip' : 'env_flow_tip')}
      aria-label={t('env_flow')}
      aria-pressed={flowing}
    >
      <span class="flow-orb" aria-hidden="true"></span>
    </sp-action-button>
  </div>
</div>
{/if}

<style>
  /* View card — top-right of the viewport (clears the right inspector via --inspector-w).
     Kept compact so the CAD column owns density and the dial stays a scene tool. */
  .dial {
    position: fixed;
    right: calc(var(--inspector-w, 0px) + clamp(10px, 1.6vw, 22px));
    top: clamp(10px, 1.6vh, 22px);
    z-index: 40;
    display: flex; flex-direction: column; align-items: center; gap: 5px;
    padding: 6px 8px 8px;
    border-radius: 10px;
    background-color: var(--glass);
    border: 1px solid var(--glass-border);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
    backdrop-filter: blur(12px) saturate(1.1);
    -webkit-backdrop-filter: blur(12px) saturate(1.1);
    user-select: none;
    touch-action: none;
    transition: right 0.32s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .dial svg { width: 132px; height: 132px; }
  .axislabel {
    display: none;
  }

  /* ── 접힌 보기 축(§6.13 A) ──────────────────────────────────────────────
     카드와 같은 먹빛 글라스·같은 코너 슬롯을 쓰는 44px 칩. 낙관 옆 방서처럼 글리프만
     세로 한 줄로 읽히고, 기본을 벗어난 축(비·눈)만 옅은 부기호로 덧붙는다. */
  .dial.viewchip {
    -webkit-appearance: none; appearance: none;
    flex-direction: row; align-items: center; justify-content: center; gap: 5px;
    min-width: 46px; min-height: 46px;
    padding: 0 10px;
    cursor: pointer;
    color: rgba(247, 242, 232, 0.94);
    /* 펼침/접힘은 미세 스케일로만 — 나타날 때 한 번 옅게 스미고 끝난다. */
    animation: viewfold 0.22s ease-out;
  }
  .dial.viewchip:hover { border-color: rgba(244, 239, 228, 0.34); }
  .dial.viewchip:active { transform: scale(0.97); }
  .dial.viewchip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .chipglyphs {
    display: inline-flex; gap: 3px;
    font-family: var(--ui); font-size: 14px; line-height: 1; font-weight: 650;
  }
  .chipmarks {
    display: inline-flex;
    padding-left: 5px;
    border-left: 1px solid var(--glass-border);
    font-family: var(--ui); font-size: 11px; line-height: 1.36;
    color: var(--glass-muted);
  }

  /* 펼친 동안의 머리 행 = 접기 창구. 카드 폭 전체를 먹고 44px 타깃을 유지한다. */
  .collapse {
    -webkit-appearance: none; appearance: none; border: 0;
    align-self: stretch;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    min-height: 44px; padding: 0 4px 0 2px;
    background: transparent; cursor: pointer;
    border-bottom: 1px solid rgba(244, 239, 228, 0.18);
  }
  .headlabel {
    font-family: var(--ui); font-size: 9.5px; font-weight: 650;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--glass-muted);
  }
  .collapse .fold {
    font-size: 13px; line-height: 1;
    color: var(--glass-text);
  }
  .collapse:hover .fold { color: #fff; }
  .collapse:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dial.viewcard.compact { animation: viewfold 0.22s ease-out; }
  @keyframes viewfold {
    from { opacity: 0.5; transform: translateY(-3px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dial.viewchip, .dial.viewcard.compact { animation: none; }
  }
  svg { display: block; overflow: visible; }
  .track { fill: none; stroke: rgba(244, 239, 228, 0.5); stroke-width: 1.2; }
  /* stroke:transparent 라도 stroke 영역을 히트 대상으로(기본 visiblePainted 는 투명 stroke 제외). */
  .band { fill: none; stroke: transparent; pointer-events: stroke; cursor: grab; touch-action: none; }
  .band:active { cursor: grabbing; }
  .knob {
    fill: var(--accent);
    stroke: rgba(255, 255, 255, 0.85);
    stroke-width: 1.4;
    pointer-events: none; /* 밴드 드래그를 가로채지 않도록(현재 세그먼트 위에서 시작해도 동작) */
    transition: cx 0.5s cubic-bezier(0.22, 1, 0.36, 1), cy 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .lab {
    fill: rgba(245, 247, 250, 0.7);
    font-family: var(--ui);
    font-size: 9.5px;
    font-weight: 550;
    text-anchor: middle;
    dominant-baseline: middle;
    pointer-events: none;
    paint-order: stroke;
    stroke: rgba(10, 12, 16, 0.72);
    stroke-width: 2.6px;
    transition: fill 0.3s ease, font-weight 0.2s ease;
  }
  .band:focus-visible { outline: none; stroke: var(--accent); }
  .dial:focus-within .hub { stroke: var(--accent); }
  .lab.on {
    fill: #ffffff;
    font-weight: 650;
    stroke: rgba(10, 12, 16, 0.65);
    stroke-width: 2.6px;
  }
  .hub { fill: rgba(245, 247, 250, 0.9); stroke: rgba(255, 255, 255, 0.2); stroke-width: 1; }


  .dial-actions {
    display: flex;
    gap: 2px;
    width: 100%;
  }
  .dial-actions :global(sp-action-button.dial-btn) {
    flex: 1;
    min-width: 0;
    min-height: 34px;
  }
  .rk-glyph {
    display: block;
    font-size: 16px;
    line-height: 1;
    font-weight: 650;
    transition: transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .tone-orb {
    display: block;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid rgba(255, 244, 229, 0.85);
    box-shadow: 0 0 8px color-mix(in srgb, var(--tone) 65%, transparent);
    background: radial-gradient(circle at 34% 32%, #fff1d7 0 8%, var(--tone) 35%, var(--tone-deep) 100%);
  }
  .dial-actions :global(sp-action-button.sunset-tone.gold) { --tone: #e8a074; --tone-deep: #6f628e; }
  .dial-actions :global(sp-action-button.sunset-tone.crimson) { --tone: #d96862; --tone-deep: #704c7d; }
  .dial-actions :global(sp-action-button.sunset-tone.violet) { --tone: #c37c99; --tone-deep: #4e5485; }

  .flow-orb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: linear-gradient(90deg, #ffe0a8 0 50%, #2a1d16 50% 100%);
    box-shadow: inset 0 0 0 1px rgba(255, 236, 214, 0.62), inset -3px 0 5px rgba(0, 0, 0, 0.32);
  }
  :global(.dial-actions sp-action-button.env-flow[selected] .flow-orb) {
    animation: orbcycle 22s linear infinite;
  }
  @keyframes orbcycle { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    :global(.dial-actions sp-action-button.env-flow[selected] .flow-orb) { animation: none; }
  }

  @media (pointer: coarse) {
    .dial-actions :global(sp-action-button.dial-btn) {
      min-height: 44px;
      min-width: 44px;
    }
  }

  /* Portrait phone: top-right of viewport (sheet has no --inspector-w). */
  @media (max-width: 768px) and (orientation: portrait) {
    .dial {
      right: max(8px, env(safe-area-inset-right));
      top: max(8px, env(safe-area-inset-top));
      padding: 5px 7px 7px;
      gap: 4px;
    }
    .dial svg { width: clamp(112px, 32vw, 128px); height: clamp(112px, 32vw, 128px); }
    .lab { font-size: 10px; }
    .dial.compact { gap: 4px; padding: 4px 7px 6px; }
    .dial.compact .axislabel { display: none; }
    .dial.compact svg { width: clamp(88px, 24vw, 104px); height: clamp(88px, 24vw, 104px); }
  }
  /* Landscape phone: clear the right rail via --inspector-w; shrink rings only. */
  @media (max-height: 520px) and (orientation: landscape) {
    .dial {
      right: calc(var(--inspector-w, 0px) + max(8px, env(safe-area-inset-right)));
      top: max(8px, env(safe-area-inset-top));
      padding: 4px 8px 6px;
      gap: 5px;
    }
    .dial .axislabel { display: none; }
    .dial svg { width: 108px; height: 108px; }
    .lab { font-size: 11.5px; }
  }
</style>
