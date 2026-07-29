<script>
  // Schema field → CAD property row (docs/design-system.md).
  //
  // One geometry for every row: label (38%) · control · value (52px, right).
  // Controls are native and token-styled — a Spectrum switch / pill segment reads
  // as a consumer form, which is exactly what this column must not look like.
  //
  // The value cell is a real numeric field: horizontal drag scrubs (Shift = 0.1×),
  // a click without drag opens text entry, and a row whose value left its default
  // shows a 1px marker plus a ↺ reset. `.rv` / `.num` keep their text content and
  // `.bounds` keeps its en-dash range for the browser gates; the range itself is
  // presented as end ticks plus the row tooltip instead of a second label line.
  let {
    field,
    label = '',
    value = undefined,
    display = '',
    disabled = false,
    bounds = '',
    tip = '',
    changed = false,
    dataAttr = 'data-key',
    options = [],
    optionLabel = (o) => String(o),
    format = null,
    parse = null,
    onInput = null,
    onCommit = null,
    onPick = null,
    onToggle = null,
    onReset = null,
  } = $props();

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  const step = $derived(Number(field.step) > 0 ? Number(field.step) : 1);
  const min = $derived(Number.isFinite(field.min) ? Number(field.min) : 0);
  const max = $derived(Number.isFinite(field.max) ? Number(field.max) : 1);
  const decimals = $derived(step >= 1 ? 0 : String(step).split('.')[1]?.length || 2);

  // Scrub keeps its own value so a village row (commit-only) still tracks the
  // pointer; committed value wins the moment the drag ends.
  let scrub = $state(null);
  const live = $derived(scrub != null ? scrub : num(value));
  const intVal = $derived(Math.trunc(live));
  const pct = $derived(max > min ? ((live - min) / (max - min)) * 100 : 0);
  const shownText = $derived(format ? format(live) : (display || live.toFixed(decimals)));
  const keyProps = $derived(dataAttr === 'data-vkey' ? { 'data-vkey': field.key } : { 'data-key': field.key });
  const rowTip = $derived(tip || label);

  const quantize = (v) => {
    const snapped = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(decimals + 2))));
  };

  // ── numeric cell: drag-scrub, click-to-type ──
  let editing = $state(false);
  let draft = $state('');
  let dragging = false;
  let startX = 0;
  let startV = 0;
  let moved = 0;

  function down(e) {
    if (disabled || editing || (e.button != null && e.button !== 0)) return;
    dragging = true;
    moved = 0;
    startX = e.clientX;
    startV = num(value);
    scrub = startV;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function move(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    if (moved < 3) return;
    const v = quantize(startV + dx * step * (e.shiftKey ? 0.1 : 1));
    scrub = v;
    onInput?.(v);
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    if (moved < 3) { scrub = null; openEditor(); return; }
    const v = quantize(live);
    scrub = null;
    onInput?.(v);
    onCommit?.(v);
  }
  function openEditor() {
    if (disabled) return;
    draft = String(Number(num(value).toFixed(decimals)));
    editing = true;
  }
  function commitEditor() {
    if (!editing) return;
    editing = false;
    const raw = parse ? parse(draft) : parseFloat(draft);
    if (!Number.isFinite(raw)) return;
    const v = quantize(raw);
    onInput?.(v);
    onCommit?.(v);
  }
  function editorKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitEditor(); }
    else if (e.key === 'Escape') { e.preventDefault(); editing = false; }
  }
  function cellKey(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') { e.preventDefault(); openEditor(); }
  }
  // Stable reference: an inline attachment would re-run on every keystroke and
  // re-select the text under the caret.
  const focusEditor = (node) => { node.focus(); node.select(); };
</script>

{#snippet valueCell(cls)}
  {#if editing}
    <input
      class="rvedit {cls}"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      bind:value={draft}
      aria-label={label}
      onkeydown={editorKey}
      onblur={commitEditor}
      {@attach focusEditor}
    />
  {:else}
    <span
      class={cls}
      role="button"
      tabindex={disabled ? -1 : 0}
      title={rowTip}
      aria-label={`${label} ${shownText}`}
      aria-live={cls === 'num' ? 'polite' : undefined}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      onkeydown={cellKey}
    >{shownText}</span>
  {/if}
  {#if changed && onReset}
    <span
      class="rreset"
      role="button"
      tabindex="0"
      title={`${label} — 기본값으로`}
      aria-label={`${label} 기본값으로`}
      onclick={(e) => { e.preventDefault(); e.stopPropagation(); onReset?.(); }}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReset?.(); } }}
    >↺</span>
  {/if}
{/snippet}

{#if field.ctrl === 'range'}
  <label class="row" class:disabled class:changed {...keyProps} title={rowTip}>
    <span class="rl cad-label"
      >{label}{#if bounds}<small class="bounds cad-sr">{bounds}</small>{/if}</span
    >
    <span class="ctl">
      <input
        type="range"
        {...keyProps}
        min={field.min}
        max={field.max}
        step={field.step ?? 0.01}
        value={live}
        style="--fill: {pct}%"
        disabled={disabled || undefined}
        aria-label={label}
        aria-valuetext={shownText}
        oninput={(e) => { scrub = null; onInput?.(num(e.currentTarget.value)); }}
        onchange={(e) => { scrub = null; onCommit?.(num(e.currentTarget.value)); }}
      />
    </span>
    <span class="vcell">{@render valueCell('rv')}</span>
  </label>
{:else if field.ctrl === 'stepper'}
  <!-- Native buttons: parcel-rebuild gate clicks .row[data-key] button (− then +). -->
  <div class="row bays" class:disabled class:changed {...keyProps} title={rowTip}>
    <span class="rl cad-label"
      >{label}{#if bounds}<small class="bounds cad-sr">{bounds}</small>{/if}</span
    >
    <span class="stepper">
      <button
        type="button"
        class="cad-btn sbtn"
        disabled={disabled || intVal <= field.min}
        aria-label={`${label} −`}
        onclick={() => {
          const v = Math.max(field.min, intVal - 1);
          onInput?.(v);
          onCommit?.(v);
        }}
      >−</button>
      {@render valueCell('num')}
      <button
        type="button"
        class="cad-btn sbtn"
        disabled={disabled || intVal >= field.max}
        aria-label={`${label} +`}
        onclick={() => {
          const v = Math.min(field.max, intVal + 1);
          onInput?.(v);
          onCommit?.(v);
        }}
      >+</button>
    </span>
  </div>
{:else if field.ctrl === 'segment'}
  <div class="row seg" class:disabled class:changed {...keyProps} title={rowTip}>
    <span class="rl cad-label">{label}</span>
    <span class="cad-seg" role="group" aria-label={label}>
      {#each (field.options || options) as o (o)}
        <button
          type="button"
          aria-pressed={(value ?? field.def) === o}
          disabled={disabled || undefined}
          title={optionLabel(o)}
          onclick={() => onPick?.(o)}
        >{optionLabel(o)}</button>
      {/each}
    </span>
  </div>
{:else if field.ctrl === 'toggle'}
  <label class="row" class:disabled class:changed title={rowTip}>
    <span class="rl cad-label">{label}</span>
    <span class="ctl"></span>
    <span class="vcell bool">
      <input
        class="cad-check tgl"
        type="checkbox"
        checked={!!value}
        disabled={disabled || undefined}
        aria-label={label}
        aria-checked={value ? 'true' : 'false'}
        {...keyProps}
        onchange={(e) => onToggle?.(!!e.currentTarget.checked)}
      />
    </span>
  </label>
{:else}
  <div class="row" {...keyProps} title={rowTip}>
    <span class="rl cad-label">{label}</span>
    <span class="ctl"></span>
    <span class="vcell"><span class="rv">{display}</span></span>
  </div>
{/if}

<style>
  /* 4px module — every row shares one pitch and one three-column grid. */
  .row {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, var(--cad-label)) minmax(0, 1fr) var(--cad-value);
    align-items: center;
    column-gap: var(--cad-gap);
    min-height: var(--cad-row);
  }
  /* Unavailable is expressed on the text and the control, never as row opacity:
     the native `disabled` attribute already blocks input, and dimming the whole
     row also kills the hover that carries the "why" tooltip. */
  .row.disabled .rl { color: var(--panel-faint); }
  .row.disabled .rv, .row.disabled .num { color: var(--panel-faint); cursor: default; }
  .row.disabled .rreset { display: none; }
  input[type='range']:disabled {
    background-image: linear-gradient(
      to right,
      #3a3a3a 0 var(--fill, 0%),
      var(--track-off) var(--fill, 0%) 100%
    );
    cursor: default;
  }
  input[type='range']:disabled::-webkit-slider-thumb { background: #5c5c5c; border-color: #141414; }
  input[type='range']:disabled::-moz-range-thumb { background: #5c5c5c; border-color: #141414; }
  /* Default-departure marker: a 1px rail in the gutter, not a coloured row. */
  .row.changed::before {
    content: '';
    position: absolute;
    left: -6px;
    top: 4px;
    bottom: 4px;
    width: 1px;
    background: var(--accent);
  }
  .row:hover { background: var(--panel-hover); }

  .ctl {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
    height: 100%;
  }
  /* No end ticks: a single 1px mark at the track end read as an artifact rather
     than a scale. The min/max live in `.bounds` and the row tooltip; only the
     규모 continuum, which really does snap to named anchors, draws ticks. */

  /* Slider: 3px well, left fill, 9×13 rounded-rect thumb (Blender number-slider). */
  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    min-width: 0;
    height: 14px;
    margin: 0;
    background: linear-gradient(
      to right,
      var(--accent-fill) 0 var(--fill, 0%),
      var(--track-off) var(--fill, 0%) 100%
    );
    background-size: 100% 4px;
    background-position: 0 50%;
    background-repeat: no-repeat;
    border-radius: 0;
    outline: none;
    cursor: ew-resize;
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 9px;
    height: 13px;
    border-radius: 2px;
    background: #c9c9c9;
    border: 1px solid #0e0e0e;
    box-shadow: none;
    cursor: ew-resize;
  }
  input[type='range']::-moz-range-thumb {
    width: 9px;
    height: 13px;
    border-radius: 2px;
    background: #c9c9c9;
    border: 1px solid #0e0e0e;
    cursor: ew-resize;
  }
  input[type='range']:hover::-webkit-slider-thumb { background: #e8e8e8; }
  input[type='range']:hover::-moz-range-thumb { background: #e8e8e8; }
  input[type='range']:focus-visible::-webkit-slider-thumb { border-color: var(--accent); background: #fff; }
  input[type='range']:focus-visible::-moz-range-thumb { border-color: var(--accent); background: #fff; }

  /* Value cell — a field, not a caption. */
  .vcell {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    min-width: 0;
  }
  .vcell.bool { padding-right: 1px; }
  .rv, .num, .rvedit {
    box-sizing: border-box;
    width: 100%;
    height: 20px;
    padding: 0 4px;
    border: 1px solid var(--panel-border);
    border-radius: var(--cad-r);
    background: var(--panel-inset);
    color: var(--panel-text);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    line-height: 18px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    cursor: ew-resize;
    -webkit-user-select: none;
    user-select: none;
  }
  .rv:hover, .num:hover { border-color: var(--panel-faint); }
  .rv:focus-visible, .num:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .rvedit {
    font-family: var(--mono);
    cursor: text;
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    user-select: text;
    -webkit-user-select: text;
  }
  .row.changed .rv, .row.changed .num { color: #fff; }

  .rreset {
    position: absolute;
    right: calc(100% + 3px);
    top: 50%;
    width: 14px;
    height: 14px;
    margin-top: -7px;
    display: none;
    place-items: center;
    border-radius: 2px;
    background: var(--panel-elevated);
    color: var(--panel-muted);
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
  }
  .row:hover .rreset, .rreset:focus-visible { display: grid; }
  .rreset:hover { color: #fff; background: var(--panel-selected); }
  .rreset:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  /* Stepper occupies control + value columns as one number field. */
  .row.bays { grid-template-columns: minmax(0, var(--cad-label)) minmax(0, 1fr); }
  .stepper {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) 20px;
    align-items: center;
    justify-content: end;
    gap: 3px;
    justify-self: end;
    width: calc(var(--cad-value) + 46px);
    max-width: 100%;
  }
  .stepper .sbtn {
    width: 20px;
    height: 20px;
    min-height: 20px;
    padding: 0;
    font-size: 12px;
    font-weight: 500;
  }
  .stepper .num { text-align: center; }

  .row.seg { grid-template-columns: minmax(0, var(--cad-label)) minmax(0, 1fr); }
  .row.seg .cad-seg { justify-self: stretch; }

  @media (max-width: 600px), (pointer: coarse) {
    /* Opening steppers are a 40px hit contract (check-parcel-rebuild-browser). */
    .stepper { grid-template-columns: 40px minmax(0, 1fr) 40px; gap: 4px; width: calc(var(--cad-value) + 88px); }
    .stepper .sbtn { width: 40px; height: 40px; min-height: 40px; font-size: 16px; }
    .rv, .num, .rvedit { height: 28px; line-height: 26px; font-size: 12px; }
    .cad-check.tgl { width: 20px; height: 20px; }
    .cad-check.tgl::after { left: 5px; top: 2px; width: 7px; height: 12px; border-width: 0 2px 2px 0; }
    input[type='range'] { height: 28px; }
    input[type='range']::-webkit-slider-thumb { width: 14px; height: 20px; }
    input[type='range']::-moz-range-thumb { width: 14px; height: 20px; }
    .rreset { display: grid; width: 20px; height: 20px; margin-top: -10px; }
  }
</style>
