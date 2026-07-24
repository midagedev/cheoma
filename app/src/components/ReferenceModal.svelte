<script>
  // 신뢰도(참고 자료) 모달 — 씬 위 한지 오버레이. 별도 라우트 없이 열림/닫힘.
  // 콘텐츠는 docs/credits.md(단일 출처) → lib/credits.js 파싱본. 로케일(i18n)에 따라 ko/en 표시.
  // 데스크톱은 중앙 다이얼로그, 모바일(device.sheet)은 safe-area 존중 풀스크린 바텀 시트.
  import { tick } from 'svelte';
  import { i18n } from '../lib/i18n.svelte.js';
  import { device } from '../lib/device.svelte.js';
  import { CREDITS } from '../lib/credits.js';

  let { open = false, onClose, returnFocus = null, fallbackFocus = null } = $props();
  let dialog = $state();
  let title = $state();
  const lang = $derived(i18n.lang);
  const isKo = $derived(lang === 'ko');
  const titleId = 'reference-modal-title';
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // 정적 라벨(브랜드 요소가 아닌 UI 문구 — 여기서만 로케일화).
  const L = {
    ko: { title: '참고 자료', sub: 'References & Credits', disclaimer: '면책', use: '활용', license: '라이선스', note: '제작 노트', close: '닫기' },
    en: { title: 'References & Credits', sub: '참고 자료', disclaimer: 'Disclaimer', use: 'Applied to', license: 'License', note: 'Production note', close: 'Close' },
  };
  const lab = $derived(L[lang] || L.en);
  // 인트로는 원문(ko)만 존재 → en 등가 문장을 병기.
  const INTRO_EN = 'Each entry maps to what it shaped in the app, not the source alone. Licenses are as of the survey date (2026-07); re-verify before redistribution or commercial use.';
  const intro = $derived(isKo ? CREDITS.intro : INTRO_EN);
  const disclaimer = $derived(isKo ? CREDITS.disclaimer.ko : (CREDITS.disclaimer.en || CREDITS.disclaimer.ko));
  const REFERENCE_TOPICS = new Map([
    ['국사편찬위원회·서울역사박물관·국가유산청 — 조선 길가 배수와 제한적 마을 수로 / Roadside drainage and exceptional village waterways', 'drainage'],
  ]);

  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const localizedUse = (item) => (
    isKo ? item.use.ko : (item.use.en || item.use.ko)
  );
  const referenceTopic = (item) => REFERENCE_TOPICS.get(item.title);

  // **볼드** 세그먼트 분해 — <strong> 로 렌더(먹 강조 유지). 일반 구간의 홑별표(*이탤릭*)는 제거.
  function segs(text) {
    const out = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0, m;
    const plain = (s) => s.replace(/[*`]/g, '');
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: plain(text.slice(last, m.index)), b: false });
      out.push({ t: m[1], b: true });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ t: plain(text.slice(last)), b: false });
    return out;
  }

  function focusableElements() {
    if (!dialog) return [];
    return [...dialog.querySelectorAll(FOCUSABLE)].filter((element) => (
      !element.closest('[inert]')
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden'
    ));
  }

  function requestClose() {
    onClose?.();
  }

  function onKey(e) {
    // `inert` removes the background DOM from interaction, but window-level
    // shortcuts (for example first-person walk) still see bubbled key events.
    // The dialog owns its whole keyboard boundary; browser defaults such as
    // arrow-key scrolling remain intact unless the focus trap handles the key.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusable = focusableElements();
    if (!focusable.length) {
      e.preventDefault();
      title?.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    const escaped = !dialog?.contains(active);
    const atEntry = active === title || active === dialog || escaped;
    if (e.shiftKey && (active === first || atEntry)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || atEntry)) {
      e.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (!open) return;
    const opener = returnFocus;
    const stableFallback = fallbackFocus;
    let active = true;
    const recoverFocus = (event) => {
      if (active && dialog && !dialog.contains(event.target)) {
        title?.focus({ preventScroll: true });
      }
    };

    document.addEventListener('focusin', recoverFocus);
    tick().then(() => {
      if (active) title?.focus({ preventScroll: true });
    });

    return () => {
      active = false;
      document.removeEventListener('focusin', recoverFocus);
      tick().then(() => {
        if (open) return;
        const triggerKind = opener?.dataset?.referenceTrigger;
        const fallback = triggerKind === 'brand' || triggerKind === 'info'
          ? document.querySelector(`[data-reference-trigger="${triggerKind}"]`)
          : null;
        const target = [opener, fallback, stableFallback].find((candidate) => (
          candidate?.isConnected
          && !candidate.disabled
          && !candidate.closest?.('[inert]')
        ));
        target?.focus({ preventScroll: true });
      });
    };
  });
</script>

{#if open}
  <div class="scrim" onclick={requestClose} aria-hidden="true"></div>
  <div
    bind:this={dialog}
    class="modal hanji-surface"
    class:sheet={device.sheet}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    onkeydown={onKey}
  >
    <header class="head">
      <span class="seal" aria-hidden="true">처마</span>
      <div class="titles">
        <h2 bind:this={title} id={titleId} tabindex="-1">{lab.title}</h2>
        <span class="sub">{lab.sub}</span>
      </div>
      <button class="x" onclick={requestClose} aria-label={lab.close}>×</button>
    </header>

    <div class="scroll">
      <!-- 면책 -->
      <section class="disclaimer">
        <div class="tag">{lab.disclaimer}</div>
        <p>{#each segs(disclaimer) as s}{#if s.b}<strong>{s.t}</strong>{:else}{s.t}{/if}{/each}</p>
      </section>

      {#if intro}<p class="intro">{intro}</p>{/if}

      <!-- 카테고리 -->
      {#each CREDITS.categories as cat}
        <section class="cat">
          <h3><span class="num">{cat.num}</span> {isKo ? cat.title.ko : (cat.title.en || cat.title.ko)}</h3>
          {#if cat.note}<p class="catnote">{cat.note}</p>{/if}
          <ul>
            {#each cat.items as it}
              <li data-reference-item={it.title} data-reference-topic={referenceTopic(it)}>
                <div class="it-title" data-reference-field="title">{it.title}</div>
                {#each it.meta as m}<div class="it-meta" data-reference-field="scope">{m}</div>{/each}
                {#if it.use}
                  <div class="it-use" data-reference-field="application"><span class="k">{lab.use}</span>{#each segs(localizedUse(it)) as s}{#if s.b}<strong>{s.t}</strong>{:else}{s.t}{/if}{/each}</div>
                {/if}
                {#if it.links.length}
                  <div class="it-links" data-reference-field="sources">
                    {#each it.links as u}<a href={u} target="_blank" rel="noopener noreferrer">{host(u)}</a>{/each}
                  </div>
                {/if}
                {#if it.refs.length}<div class="it-refs">{it.refs.join(' · ')}</div>{/if}
                {#if it.license}<div class="it-lic it-license" data-reference-field="license"><span class="k">{lab.license}</span>{#each segs(it.license) as s}{#if s.b}<strong>{s.t}</strong>{:else}{s.t}{/if}{/each}</div>{/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed; inset: 0; z-index: 120;
    background: rgba(24, 18, 12, 0.42);
    backdrop-filter: blur(2px);
    animation: fade 0.28s ease both;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

  .modal {
    position: fixed; z-index: 121;
    left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(660px, 92vw);
    max-height: 84vh;
    border-radius: 10px;
    display: flex; flex-direction: column;
    overflow: hidden;
    animation: pop 0.34s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes pop {
    from { opacity: 0; transform: translate(-50%, -46%) scale(0.97); }
    to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }

  /* 모바일 세로: safe-area 존중 풀스크린 시트(하단에서 슬라이드 업). */
  .modal.sheet {
    left: 0; right: 0; bottom: 0; top: auto; transform: none;
    width: 100%;
    max-height: calc(100vh - max(24px, env(safe-area-inset-top)));
    border-radius: 18px 18px 0 0;
    animation: slideup 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes slideup { from { transform: translateY(100%); } to { transform: translateY(0); } }

  .head {
    flex: none;
    display: flex; align-items: center; gap: 12px;
    padding: 16px clamp(16px, 3vw, 26px) 13px;
    border-bottom: 1px solid var(--ink-hair);
  }
  .head .seal {
    flex: none;
    writing-mode: vertical-rl;
    font-family: var(--serif); font-weight: 700;
    font-size: 11px; letter-spacing: 0.1em; line-height: 1.05;
    color: var(--paper); background: var(--seal);
    padding: 6px 3px; border-radius: 2px;
    box-shadow: 0 0 0 1px rgba(120, 40, 30, 0.28), 0 1px 4px rgba(60, 30, 20, 0.28);
  }
  .titles { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
  .head h2 { margin: 0; font-family: var(--serif); font-weight: 700; font-size: clamp(17px, 2.4vw, 20px); color: var(--ink); letter-spacing: 0.02em; }
  .head .sub { font-family: var(--serif); font-size: 11.5px; color: var(--ink-faint); letter-spacing: 0.06em; }
  .head .x {
    flex: none; width: 34px; height: 34px; border-radius: 50%;
    border: 1px solid var(--ink-hair); background: transparent;
    font-size: 21px; line-height: 1; color: var(--ink-soft);
    display: grid; place-items: center;
  }
  .head .x:hover { background: rgba(44, 38, 32, 0.06); }

  .scroll {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 18px clamp(16px, 3vw, 26px) calc(26px + env(safe-area-inset-bottom));
    word-break: keep-all;
    overflow-wrap: anywhere;
  }

  .disclaimer {
    border-left: 3px solid var(--seal);
    padding: 2px 0 2px 14px;
    margin-bottom: 14px;
  }
  .disclaimer .tag {
    font-family: var(--serif); font-weight: 700; font-size: 11px;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--seal);
    margin-bottom: 5px;
  }
  .disclaimer p { margin: 0; font-family: var(--serif); font-size: 13.5px; line-height: 1.7; color: var(--ink-soft); }
  .disclaimer strong { color: var(--ink); font-weight: 700; }

  .intro { margin: 0 0 20px; font-family: var(--serif); font-size: 12px; line-height: 1.65; color: var(--ink-faint); }

  .cat { margin-bottom: 22px; }
  .cat h3 {
    margin: 0 0 10px;
    font-family: var(--serif); font-weight: 700; font-size: 15px; color: var(--ink);
    padding-bottom: 7px; border-bottom: 1px solid var(--ink-hair);
    display: flex; align-items: baseline; gap: 8px;
  }
  .cat h3 .num { color: var(--seal); font-size: 16px; }
  .catnote { margin: -4px 0 12px; font-family: var(--serif); font-size: 11.5px; line-height: 1.6; color: var(--ink-faint); font-style: italic; }

  .cat ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 15px; }
  .cat li { display: flex; flex-direction: column; gap: 3px; }

  .it-title { font-family: var(--serif); font-weight: 700; font-size: 13.5px; color: var(--ink); line-height: 1.4; }
  .it-meta { font-family: var(--serif); font-size: 12px; color: var(--ink-faint); line-height: 1.5; }
  .it-use { font-family: var(--serif); font-size: 12.5px; color: var(--ink-soft); line-height: 1.6; margin-top: 2px; }
  .it-use .k, .it-lic .k {
    display: inline-block; margin-right: 7px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--seal); vertical-align: 1px;
  }
  .it-links { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 2px; }
  .it-links a {
    font-family: var(--serif); font-size: 11.5px; color: var(--seal);
    text-decoration: none; border-bottom: 1px solid rgba(177, 54, 43, 0.35);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .it-links a:hover { border-bottom-color: var(--seal); }
  .it-refs { font-family: var(--serif); font-size: 11px; color: var(--ink-faint); }
  .it-lic { font-family: var(--serif); font-size: 11px; color: var(--ink-faint); line-height: 1.55; margin-top: 1px; }
  .it-lic strong { color: var(--ink-soft); font-weight: 700; }

  @media (prefers-reduced-motion: reduce) {
    .scrim, .modal { animation: none; }
  }
</style>
