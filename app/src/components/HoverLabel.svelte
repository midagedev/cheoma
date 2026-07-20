<script>
  // 마을 호버 미니 라벨(낙관풍) — 커서 옆에 유형·칸수. spec: {kind, hero, params:{frontBays,sideBays}}.
  import { t } from '../lib/i18n.svelte.js';
  let { info = null } = $props();

  // ContextPanel houseLabel 과 동일 우선순위: 궁궐 → 종가/관아 → 기와/초가 (giwa 이분법이 궁·히어로를 초가로 오표기하던 버그)
  const typeLabel = $derived.by(() => {
    if (!info) return '';
    const spec = info.spec;
    if (spec.family === 'palace-compound') return t('crumb_palace_compound');
    if (spec.family === 'temple') return t('crumb_temple');   // #147 산사
    if (spec.hero) return t(spec.heroStyle === 'hanok' ? 'crumb_hanok' : 'crumb_palace');
    return t('type_' + (spec.kind === 'giwa' ? 'giwa' : 'choga') + '_l');
  });
  const bays = $derived(info && info.spec.params && info.spec.params.frontBays
    ? `${info.spec.params.frontBays}×${info.spec.params.sideBays ?? 2}${t('hint_bays')}` : '');
  // 커서 우하단으로 살짝 띄우되 화면 밖으로 넘치지 않게 클램프.
  const pos = $derived(info ? {
    left: Math.min(info.x + 16, (typeof window !== 'undefined' ? innerWidth : 1360) - 150),
    top: Math.min(info.y + 16, (typeof window !== 'undefined' ? innerHeight : 850) - 60),
  } : { left: 0, top: 0 });
</script>

{#if info}
  <div class="hlabel" style="left:{pos.left}px; top:{pos.top}px;">
    {#if info.spec.hero}<span class="seal" aria-hidden="true">印</span>{/if}
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
    border-radius: 5px;
    background-color: rgba(30, 22, 14, 0.82);
    border: 1px solid rgba(244, 239, 228, 0.22);
    color: var(--paper);
    font-family: var(--serif);
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
  }
  .hlabel .seal {
    display: grid; place-items: center; width: 17px; height: 17px; border-radius: 2px;
    background: var(--seal); color: var(--paper); font-size: 11px; font-weight: 700;
  }
  .hlabel .type { font-size: 13px; font-weight: 700; letter-spacing: 0.03em; }
  .hlabel .bays { font-size: 11px; color: rgba(244, 239, 228, 0.66); font-variant-numeric: tabular-nums; }
</style>
