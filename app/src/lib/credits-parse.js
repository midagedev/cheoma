// Pure credits.md parser — no Vite, no DOM. Shared by the product import façade
// (credits.js) and the browser-free catalog gate (tools/check-credits-catalog.mjs).
//
// Format contract for each `### N. Title` entry (bullets, order free after title):
//   - id: cred-kebab-slug     (stable, unique)
//   - topic: short-slug       (filter/group key; no hardcoded topic list in UI)
//   - scope: one-line note    (what this source is used for; not a new historical claim)
//   · first free bullets     = meta (institution / summary)
//   · '**활용 / Use:** ko / en'
//   · 'URL: …'
//   · '라이선스: …'
// Category headers: '## ① Title (English)'. Production note: '## 제작 노트 …'.

const stripBold = (s) => s.replace(/\*\*/g, '');

const ID_RE = /^id:\s*(cred-[a-z0-9]+(?:-[a-z0-9]+)*)$/i;
const TOPIC_RE = /^topic:\s*([a-z0-9]+(?:-[a-z0-9]+)*)$/i;
const SCOPE_RE = /^scope:\s*(.+)$/i;

/**
 * @param {string} md
 * @returns {{
 *   disclaimer: { ko: string, en: string },
 *   intro: string,
 *   categories: Array<{
 *     num: string,
 *     title: { ko: string, en: string },
 *     note: string,
 *     items: Array<{
 *       title: string,
 *       id: string,
 *       topic: string,
 *       scope: string,
 *       meta: string[],
 *       use: { ko: string, en: string } | null,
 *       links: string[],
 *       refs: string[],
 *       license: string,
 *     }>,
 *   }>,
 *   production: string[],
 * }}
 */
export function parseCreditsMarkdown(md) {
  const lines = md.split('\n');
  const disclaimer = { ko: '', en: '' };
  const categories = [];
  const production = [];
  let intro = '';
  let cur = null;
  let item = null;
  let mode = '';

  const flush = () => {
    if (cur && item) cur.items.push(item);
    item = null;
  };

  for (const line of lines) {
    const t = line.trim();

    let m = t.match(/^>\s*\*\*\(ko\)\*\*\s*(.+)$/);
    if (m) { disclaimer.ko = m[1]; continue; }
    m = t.match(/^>\s*\*\*\(en\)\*\*\s*(.+)$/);
    if (m) { disclaimer.en = m[1]; continue; }

    if (/^##\s+제작\s*노트/.test(t)) {
      flush();
      cur = null;
      mode = 'production';
      continue;
    }

    m = t.match(/^##\s+([①②③④⑤⑥])\s+(.+)$/);
    if (m) {
      flush();
      const rest = m[2];
      const pm = rest.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
      cur = {
        num: m[1],
        title: { ko: pm ? pm[1].trim() : rest, en: pm ? pm[2].trim() : '' },
        note: '',
        items: [],
      };
      categories.push(cur);
      mode = '';
      continue;
    }

    m = t.match(/^###\s+\d+\.\s+(.+)$/);
    if (m) {
      flush();
      item = {
        title: stripBold(m[1]),
        id: '',
        topic: '',
        scope: '',
        meta: [],
        use: null,
        links: [],
        refs: [],
        license: '',
      };
      continue;
    }

    if (t.startsWith('>')) {
      const b = t.replace(/^>\s?/, '').trim();
      if (b && cur && !b.startsWith('**면책')) {
        cur.note = (cur.note ? `${cur.note} ` : '') + stripBold(b);
      }
      continue;
    }

    if (t.startsWith('- ')) {
      const body = t.slice(2).trim();
      if (mode === 'production') {
        production.push(body);
        continue;
      }
      if (!item) continue;

      const idm = body.match(ID_RE);
      if (idm) { item.id = idm[1].toLowerCase(); continue; }
      const topm = body.match(TOPIC_RE);
      if (topm) { item.topic = topm[1].toLowerCase(); continue; }
      const scpm = body.match(SCOPE_RE);
      if (scpm) { item.scope = scpm[1].trim(); continue; }

      const um = body.match(/^\*\*활용\s*\/\s*Use:\*\*\s*(.+)$/);
      if (um) {
        const txt = um[1];
        const idx = txt.indexOf(' / ');
        item.use = idx >= 0
          ? { ko: stripBold(txt.slice(0, idx)).trim(), en: stripBold(txt.slice(idx + 3)).trim() }
          : { ko: stripBold(txt).trim(), en: '' };
        continue;
      }
      if (/^URL:/.test(body)) {
        const after = body.replace(/^URL:\s*/, '');
        item.links = after.match(/https?:\/\/[^\s·)]+/g) || [];
        item.refs = (after.match(/`[^`]+`/g) || []).map((r) => r.replace(/`/g, ''));
        continue;
      }
      if (/^라이선스:/.test(body)) {
        item.license = body.replace(/^라이선스:\s*/, '').trim();
        continue;
      }

      item.meta.push(stripBold(body));
      continue;
    }

    if (t && t !== '---' && !t.startsWith('#') && !cur && mode !== 'production' && !intro) {
      intro = stripBold(t);
    }
  }
  flush();
  return { disclaimer, intro, categories, production };
}

/** Flat list of every catalog entry under categories ①–⑥. */
export function creditEntries(parsed) {
  return parsed.categories.flatMap((cat) => cat.items);
}

/** Sorted unique topic slugs from parsed catalog entries. */
export function creditTopics(parsed) {
  const set = new Set();
  for (const entry of creditEntries(parsed)) {
    if (entry.topic) set.add(entry.topic);
  }
  return [...set].sort();
}
