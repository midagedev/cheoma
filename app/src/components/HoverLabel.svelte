<script>
  // 마을 호버 미니 라벨(낙관풍) — 커서 옆에 유형·칸수. spec: {kind, hero, params:{frontBays,sideBays}}.
  import { t } from '../lib/i18n.svelte.js';
  let { info = null } = $props();

  // ContextPanel houseLabel 과 동일 우선순위: 궁궐 → 종가/관아 → 기와/초가 (giwa 이분법이 궁·히어로를 초가로 오표기하던 버그)
  const typeLabel = $derived.by(() => {
    if (!info) return '';
    if (info.interaction === 'door') return t(info.open ? 'hint_close_door' : 'hint_open_door');
    const spec = info.spec;
    if (spec.family === 'palace-compound') return t('crumb_palace_compound');
    if (spec.family === 'temple') return t('crumb_temple');   // #147 산사
    if (spec.hero) return t(spec.heroStyle === 'hanok' ? 'crumb_hanok' : 'crumb_palace');
    return t('type_' + (spec.kind === 'giwa' ? 'giwa' : 'choga') + '_l');
  });
  const bays = $derived(info?.spec?.params?.frontBays
    ? `${info.spec.params.frontBays}×${info.spec.params.sideBays ?? 2}${t('hint_bays')}` : '');
  // 커서 우하단으로 살짝 띄우되 화면 밖으로 넘치지 않게 클램프.
  const pos = $derived(info ? {
    left: Math.min(info.x + 16, (typeof window !== 'undefined' ? innerWidth : 1360) - 150),
    top: Math.min(info.y + 16, (typeof window !== 'undefined' ? innerHeight : 850) - 60),
  } : { left: 0, top: 0 });
</script>

{#if info}
  <div class="hlabel" style="left:{pos.left}px; top:{pos.top}px;">
    {#if info.spec?.hero}<span class="seal" aria-hidden="true">印</span>{/if}
    <span class="type">{typeLabel}</span>
    <span class="bays">{bays}</span>
  </div>
{/if}

<style>
  .hlabel {
    position: fixed;
    z-index: 45;
    display: inline-flex; align-items: center; gap: 7px;
    padding: 5px 10px;
    border-radius: 6px;
    background-color: var(--glass-strong);
    border: 1px solid var(--glass-border);
    color: var(--glass-text);
    font-family: var(--ui);
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  }
  .hlabel .seal {
    display: grid; place-items: center; width: 16px; height: 16px; border-radius: 3px;
    background: var(--accent-soft); color: var(--accent);
    border: 1px solid rgba(90, 168, 224, 0.35);
    font-family: var(--mono); font-size: 10px; font-weight: 650;
  }
  .hlabel .type { font-size: 12.5px; font-weight: 650; letter-spacing: 0.01em; }
  .hlabel .bays {
    font-family: var(--mono); font-size: 11px; color: var(--glass-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
