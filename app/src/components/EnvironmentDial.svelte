<script module>
  // ── 환경 리롤 큐레이션 풀(#58) ────────────────────────────────────────
  // 시간·계절·날씨의 "그림이 되는" 조합. 완전 균등 랜덤이 아니라 포토제닉 조합(골든아워·단풍·
  // 달밤·봄비·첫눈)에 가중을 실어 리롤 결과가 늘 찍을 만한 씬이 되게 한다(밋밋한 낮+맑음은 최소).
  // ti=시간, se=계절, we=날씨, k=가중치. 계절 축엔 겨울이 없어 '눈'은 늦가을 첫눈으로만 배치.
  // 리롤(인스턴스 pickEnvReroll)과 오토로테이션(App #64)의 유효 조합 판정이 공유하는 단일 출처.
  export const ENV_POOL = [
    { ti: 'sunset', se: 'autumn', we: 'clear', k: 10 }, // 골든아워+단풍 (플래그십 메인 룩)
    { ti: 'sunset', se: 'summer', we: 'clear', k: 7 },  // 여름 노을
    { ti: 'sunset', se: 'spring', we: 'clear', k: 7 },  // 봄 노을
    { ti: 'sunset', se: 'autumn', we: 'rain',  k: 4 },  // 비 갠 저녁놀
    { ti: 'night',  se: 'autumn', we: 'clear', k: 6 },  // 달빛 단풍
    { ti: 'night',  se: 'spring', we: 'clear', k: 5 },  // 봄밤 달
    { ti: 'night',  se: 'summer', we: 'clear', k: 4 },  // 여름 달밤
    { ti: 'night',  se: 'autumn', we: 'snow',  k: 5 },  // 눈 내리는 밤(첫눈)
    { ti: 'dawn',   se: 'autumn', we: 'clear', k: 5 },  // 안개 걷히는 가을 아침
    { ti: 'dawn',   se: 'spring', we: 'clear', k: 5 },  // 봄 새벽
    { ti: 'dawn',   se: 'autumn', we: 'rain',  k: 3 },  // 가을 새벽비
    { ti: 'day',    se: 'autumn', we: 'clear', k: 5 },  // 청명한 단풍
    { ti: 'day',    se: 'autumn', we: 'snow',  k: 5 },  // 단풍 위 첫눈
    { ti: 'day',    se: 'spring', we: 'rain',  k: 6 },  // 봄비(벚꽃비)
    { ti: 'day',    se: 'spring', we: 'clear', k: 4 },  // 화창한 봄
    { ti: 'day',    se: 'summer', we: 'rain',  k: 4 },  // 장마 신록
    { ti: 'day',    se: 'summer', we: 'clear', k: 2 },  // 평범한 여름낮 — 최소 가중
  ];
  export const envKey = (c) => `${c.ti}|${c.se}|${c.we}`;

  // 오토로테이션(#64) 계절 전진 시 유효 날씨 판정: 풀에 (계절, 날씨) 조합이 실재하면 유효로 본다.
  // 눈은 풀상 가을(늦가을 첫눈)에만 등장 → 봄·여름으로 넘어가면 눈은 맑음으로 정리된다(비는 전 계절 유효).
  export function weatherOkForSeason(weather, season) {
    if (weather === 'clear') return true; // 맑음은 언제나 유효
    return ENV_POOL.some((c) => c.se === season && c.we === weather);
  }
</script>

<script>
  // 우상 3링 환경 다이얼 — 시간(외)·계절(중)·날씨(내).
  // 세그먼트 클릭 또는 링 드래그로 조작, 바늘이 스냅 회전(관성감). 라벨은 로케일화.
  import { t } from '../lib/i18n.svelte.js';
  let { time = 'day', season = 'summer', weather = 'clear', shifted = false,
        flowing = false, onTime, onSeason, onWeather, onFlowToggle } = $props();

  const RINGS = [
    { key: 'time', lp: 'time_', r: 82, band: 26, get: () => time, set: (v) => onTime?.(v),
      opts: ['dawn', 'day', 'sunset', 'night'] },
    { key: 'season', lp: 'season_', r: 54, band: 24, get: () => season, set: (v) => onSeason?.(v),
      opts: ['spring', 'summer', 'autumn'] },
    { key: 'weather', lp: 'weather_', r: 28, band: 22, get: () => weather, set: (v) => onWeather?.(v),
      opts: ['clear', 'rain', 'snow'] },
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

  // ── 환경 리롤(하늘 굴리기) — 큐레이션 풀(ENV_POOL)·유효 판정은 module 스크립트에 정의(단일 출처).
  function pickEnvReroll(cur) {
    const curKey = cur ? `${cur.ti}|${cur.se}|${cur.we}` : '';
    // 현재와 동일 조합 제외 → 최소 1축 변경 보장(동일 재추첨).
    const pool = ENV_POOL.filter((c) => envKey(c) !== curKey);
    const total = pool.reduce((a, c) => a + c.k, 0);
    let r = Math.random() * total;
    for (const c of pool) { r -= c.k; if (r <= 0) return c; }
    return pool[pool.length - 1];
  }
  if (typeof window !== 'undefined') window.__envRerollPick = pickEnvReroll; // playwright 검증 훅

  let spins = $state(0);
  function rollEnv() {
    const c = pickEnvReroll({ ti: time, se: season, we: weather });
    // 변경된 축만 호출(불필요한 재적용 방지) — 각 setter가 상태·URL·다이얼 표시를 동기.
    if (c.ti !== time) onTime?.(c.ti);
    if (c.se !== season) onSeason?.(c.se);
    if (c.we !== weather) onWeather?.(c.we);
    spins += 1; // 아이콘 360° 굴림 — 연타 시 회전이 누적돼 자연스러운 연속 스핀.
  }
</script>

<div class="dial" class:shifted role="group" aria-label="environment dial">
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

  <!-- 다이얼 하단 도킹 액션 — 하늘 굴리기(리롤)와 시간 흐르기(오토로테이션)를 나란히 두어
       다이얼과 한 덩어리로 읽히게 한다. 둘 다 주묵 낙관형 원형 버튼. -->
  <div class="dial-actions">
    <button
      class="dial-btn env-roll"
      type="button"
      onclick={rollEnv}
      title={t('env_reroll_tip')}
      aria-label={t('env_reroll')}
    >
      <span class="rk-glyph" style="transform: rotate({spins * 360}deg)">⟳</span>
    </button>
    <button
      class="dial-btn env-flow"
      class:on={flowing}
      type="button"
      onclick={() => onFlowToggle?.()}
      title={t(flowing ? 'env_flow_on_tip' : 'env_flow_tip')}
      aria-label={t('env_flow')}
      aria-pressed={flowing}
    >
      <span class="flow-orb" aria-hidden="true"></span>
    </button>
  </div>
</div>

<style>
  .dial {
    position: fixed;
    right: clamp(10px, 1.6vw, 22px);
    top: clamp(10px, 1.6vh, 22px);
    z-index: 40; /* 패널(30) 위 — 이동해도 조작 가능 */
    filter: drop-shadow(0 2px 8px rgba(30, 22, 14, 0.28));
    user-select: none;
    touch-action: none;
    transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* 한지 패널(width min(320px,84vw))이 열리면 다이얼을 패널 왼쪽으로 밀어 가려지지 않게 한다. */
  .dial.shifted { transform: translateX(calc(-1 * min(320px, 84vw) - 14px)); }
  svg { display: block; overflow: visible; }
  .track { fill: none; stroke: rgba(244, 239, 228, 0.5); stroke-width: 1.2; }
  /* stroke:transparent 라도 stroke 영역을 히트 대상으로(기본 visiblePainted 는 투명 stroke 제외). */
  .band { fill: none; stroke: transparent; pointer-events: stroke; cursor: grab; touch-action: none; }
  .band:active { cursor: grabbing; }
  .knob {
    fill: var(--seal);
    stroke: rgba(244, 239, 228, 0.85);
    stroke-width: 1.4;
    pointer-events: none; /* 밴드 드래그를 가로채지 않도록(현재 세그먼트 위에서 시작해도 동작) */
    transition: cx 0.5s cubic-bezier(0.22, 1, 0.36, 1), cy 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .lab {
    fill: rgba(244, 239, 228, 0.72);
    font-family: var(--serif);
    font-size: 10.5px;
    font-weight: 400;
    text-anchor: middle;
    dominant-baseline: middle;
    pointer-events: none;
    paint-order: stroke;
    stroke: rgba(30, 22, 14, 0.55);
    stroke-width: 2.4px;
    transition: fill 0.3s ease, font-weight 0.2s ease;
  }
  .band:focus-visible { outline: none; }
  .band:focus-visible + .band, .dial:focus-within .hub { stroke: var(--seal); }
  .lab.on {
    fill: #fff2e2;
    font-weight: 700;
    stroke: rgba(120, 40, 30, 0.7);
    stroke-width: 3px;
  }
  .hub { fill: rgba(244, 239, 228, 0.85); stroke: var(--ink-line); stroke-width: 1; }

  /* 다이얼 하단 도킹 액션 행 — 다이얼 컨테이너(shrink-to-fit)의 중앙 기준으로 두 버튼을 나란히.
     .dial 이 fixed 이자 transition 대상이라 .shifted 슬라이드·반응형 축소를 함께 상속한다. */
  .dial-actions {
    position: absolute;
    left: 50%;
    top: calc(100% + 4px);
    transform: translateX(-50%);
    display: flex;
    gap: 10px;
  }
  .dial-btn {
    -webkit-appearance: none;
    appearance: none;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    cursor: pointer;
    background-color: var(--seal);
    background-image: var(--hanji), linear-gradient(160deg, #bb3e31 0%, #a5322a 60%, #8f2a23 100%);
    border: 1px solid var(--seal-deep);
    box-shadow: 0 3px 12px rgba(120, 40, 30, 0.32), inset 0 0 0 1px rgba(255, 220, 210, 0.22);
    color: #fff2e2;
    transition: transform 0.14s ease, box-shadow 0.14s ease, filter 0.2s ease;
  }
  .rk-glyph {
    display: block;
    font-size: 21px;
    line-height: 1;
    font-weight: 700;
    transition: transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .dial-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(120, 40, 30, 0.42); }
  .dial-btn:active { transform: scale(0.94); }
  .dial-btn:focus-visible { outline: 2px solid var(--seal); outline-offset: 3px; }

  /* 시간 흐르기 토글 — 해↔달 오브(주간 금빛 / 야간 먹). 활성 시 아주 느리게(22s) 회전해
     "때가 흐른다"를 미세한 움직임으로 드러낸다(앱의 "모든 움직임은 미세하게"). 활성 상태는
     금빛 링으로도 또렷이 읽힌다. reduced-motion 에서는 회전을 멈추고 링만으로 표시. */
  .flow-orb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: linear-gradient(90deg, #ffe0a8 0 50%, #2a1d16 50% 100%);
    box-shadow: inset 0 0 0 1px rgba(255, 236, 214, 0.62), inset -3px 0 5px rgba(0, 0, 0, 0.32);
  }
  .env-flow.on {
    box-shadow: 0 3px 12px rgba(120, 40, 30, 0.32), inset 0 0 0 1px rgba(255, 220, 210, 0.22),
      0 0 0 2px rgba(255, 206, 138, 0.92), 0 0 15px rgba(255, 196, 120, 0.55);
  }
  .env-flow.on .flow-orb { animation: orbcycle 22s linear infinite; }
  @keyframes orbcycle { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .env-flow.on .flow-orb { animation: none; } }

  /* 터치: 타깃 ≥44px. */
  @media (pointer: coarse) {
    .dial-btn { width: 46px; height: 46px; }
    .rk-glyph { font-size: 23px; }
    .flow-orb { width: 22px; height: 22px; }
  }

  /* 모바일 세로(시트 레이아웃): 우상 코너에 safe-area 존중, 살짝 축소.
     패널이 바텀 시트라 우측으로 안 밀리므로 .shifted 이동을 무효화(좌측 이탈 방지). */
  @media (max-width: 768px) and (orientation: portrait) {
    .dial {
      right: max(10px, env(safe-area-inset-right));
      top: max(10px, env(safe-area-inset-top));
    }
    .dial svg { width: clamp(134px, 42vw, 158px); height: clamp(134px, 42vw, 158px); }
    .dial.shifted { transform: none; }
    .lab { font-size: 11.5px; }
  }
  /* 가로 폰: 세로 여유가 없어 더 축소. */
  @media (max-height: 520px) and (orientation: landscape) {
    .dial {
      right: max(8px, env(safe-area-inset-right));
      top: max(8px, env(safe-area-inset-top));
    }
    .dial svg { width: 126px; height: 126px; }
    .lab { font-size: 12px; }
  }
</style>
