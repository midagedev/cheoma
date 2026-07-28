<script>
  // Schema field → Spectrum-aligned control material (docs/design-system.md).
  // Continuous ranges stay native range inputs (live-edit + browser gates).
  // Discrete controls use Spectrum Web Components.
  let {
    field,
    label = '',
    value = undefined,
    display = '',
    disabled = false,
    bounds = '',
    dataAttr = 'data-key',
    options = [],
    optionLabel = (o) => String(o),
    onInput = null,
    onCommit = null,
    onPick = null,
    onToggle = null,
  } = $props();

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  const intVal = $derived(Math.trunc(num(value)));
  const keyProps = $derived(dataAttr === 'data-vkey' ? { 'data-vkey': field.key } : { 'data-key': field.key });
</script>

{#if field.ctrl === 'range'}
  <label class="row" class:disabled {...keyProps}>
    <span class="rl">
      {label}
      {#if bounds}<small class="bounds">{bounds}</small>{/if}
    </span>
    <input
      type="range"
      {...keyProps}
      min={field.min}
      max={field.max}
      step={field.step ?? 0.01}
      value={num(value)}
      disabled={disabled || undefined}
      aria-label={label}
      aria-valuetext={display || String(num(value))}
      oninput={(e) => onInput?.(num(e.currentTarget.value))}
      onchange={(e) => onCommit?.(num(e.currentTarget.value))}
    />
    <span class="rv">{display || num(value).toFixed(2)}</span>
  </label>
{:else if field.ctrl === 'stepper'}
  <!-- Native buttons: parcel-rebuild gate clicks .row[data-key] button -->
  <div class="row bays" class:disabled {...keyProps}>
    <span class="rl">
      {label}
      {#if bounds}<small class="bounds">{bounds}</small>{/if}
    </span>
    <div class="stepper">
      <button
        type="button"
        disabled={disabled || intVal <= field.min}
        aria-label={`${label} −`}
        onclick={() => {
          const v = Math.max(field.min, intVal - 1);
          onInput?.(v);
          onCommit?.(v);
        }}
      >−</button>
      <span class="num" aria-live="polite">{display || String(intVal)}</span>
      <button
        type="button"
        disabled={disabled || intVal >= field.max}
        aria-label={`${label} +`}
        onclick={() => {
          const v = Math.min(field.max, intVal + 1);
          onInput?.(v);
          onCommit?.(v);
        }}
      >+</button>
    </div>
  </div>
{:else if field.ctrl === 'segment'}
  <div class="row seg" class:disabled {...keyProps}>
    <span class="rl">{label}</span>
    <sp-action-group selects="single" quiet compact>
      {#each (field.options || options) as o (o)}
        <sp-action-button
          value={String(o)}
          selected={(value ?? field.def) === o || undefined}
          disabled={disabled || undefined}
          onclick={() => onPick?.(o)}
        >{optionLabel(o)}</sp-action-button>
      {/each}
    </sp-action-group>
  </div>
{:else if field.ctrl === 'toggle'}
  <div class="row" class:disabled>
    <span class="rl">{label}</span>
    <sp-switch
      class="tgl"
      emphasized
      checked={!!value || undefined}
      disabled={disabled || undefined}
      aria-label={label}
      aria-checked={value ? 'true' : 'false'}
      {...keyProps}
      onchange={(e) => onToggle?.(!!e.currentTarget.checked)}
    ></sp-switch>
    <span class="rv"></span>
  </div>
{:else}
  <div class="row" {...keyProps}>
    <span class="rl">{label}</span>
    <span class="rv">{display}</span>
  </div>
{/if}

<style>
  /* Layout only — colors/type come from Spectrum theme tokens */
  .row {
    display: grid;
    grid-template-columns: minmax(56px, 70px) minmax(0, 1fr) 36px;
    align-items: center;
    gap: 4px;
    min-height: 26px;
  }
  .row.bays, .row.seg { grid-template-columns: minmax(64px, 76px) minmax(0, 1fr); }
  .row.disabled { opacity: 0.45; pointer-events: none; }
  .rl {
    font-size: var(--spectrum-font-size-75, 12px);
    color: var(--panel-text);
    font-weight: 500;
    min-width: 0;
    line-height: 1.25;
  }
  .bounds {
    display: block;
    margin-top: 1px;
    color: var(--panel-faint);
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 500;
  }
  .rv {
    font-family: var(--mono);
    font-size: var(--spectrum-font-size-75, 12px);
    color: var(--panel-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* Spectrum-like range: track + circular thumb from accent token */
  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    min-width: 0;
    height: 4px;
    border-radius: 2px;
    background: var(--spectrum-gray-300, rgba(255, 255, 255, 0.14));
    outline: none;
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid var(--spectrum-gray-50, #fff);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    cursor: pointer;
  }
  input[type='range']::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid var(--spectrum-gray-50, #fff);
    cursor: pointer;
  }

  .stepper {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }
  .stepper button {
    width: 28px;
    height: 28px;
    border-radius: var(--spectrum-corner-radius-100, 4px);
    border: 1px solid var(--panel-border);
    background: var(--panel-elevated);
    color: var(--panel-text);
    font-size: 15px;
    line-height: 1;
    display: grid;
    place-items: center;
  }
  .stepper button:hover:not(:disabled) {
    background: var(--panel-hover);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .stepper button:disabled { opacity: 0.28; cursor: default; }
  .stepper .num {
    min-width: 28px;
    text-align: center;
    font-family: var(--mono);
    font-size: var(--spectrum-font-size-100, 14px);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--panel-text);
  }

  .row.seg :global(sp-action-group) {
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .row :global(sp-switch.tgl) { justify-self: start; }

  @media (max-width: 600px), (pointer: coarse) {
    .row {
      min-height: 36px;
      gap: 5px;
      grid-template-columns: 68px minmax(0, 1fr) 36px;
    }
    .row.bays, .row.seg { grid-template-columns: 70px minmax(0, 1fr); }
    .stepper button { width: 40px; height: 40px; font-size: 16px; }
    input[type='range']::-webkit-slider-thumb { width: 20px; height: 20px; }
    input[type='range']::-moz-range-thumb { width: 20px; height: 20px; }
  }
</style>
