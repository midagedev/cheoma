// 신뢰도(레퍼런스) 페이지 데이터 — docs/credits.md 를 빌드 시 raw 로 읽어 구조화한다.
// credits.md 는 큐레이션 담당이 관리하는 단일 출처(single source of truth). 여기서는 파싱만 하며,
// 문구·항목은 그 파일에서만 고친다. 파서가 의존하는 포맷 규약:
//   면책      : 최상단 blockquote 안 '> **(ko)** …' / '> **(en)** …' 두 줄.
//   카테고리  : '## ① 제목 (English title)' — ①..⑥ 원문자 + 끝 괄호에 영문.
//   항목      : '### N. 제목' 뒤 불릿 —
//                 · 첫 불릿(들)      = 출처/설명(meta)
//                 · '**활용 / Use:** ko / en'  (첫 ' / ' 가 ko|en 경계)
//                 · 'URL: …'         (http(s) 링크 다수는 ' · ' 구분, `백틱` 은 내부참조)
//                 · '라이선스: …'
//   카테고리 주석 : 카테고리 아래 blockquote 한 줄(예: ⑥ 사진 면책).
//   제작 노트 : '## 제작 노트 (Production note)' 뒤 불릿.
import raw from '../../../docs/credits.md?raw';

const stripBold = (s) => s.replace(/\*\*/g, '');

function parse(md) {
  const lines = md.split('\n');
  const disclaimer = { ko: '', en: '' };
  const categories = [];
  const production = [];
  let intro = '';
  let cur = null; // 현재 카테고리
  let item = null; // 현재 항목
  let mode = ''; // '' | 'production'

  const flush = () => { if (cur && item) cur.items.push(item); item = null; };

  for (const line of lines) {
    const t = line.trim();

    // 면책 (blockquote 안 (ko)/(en)) — segs() 로 볼드 렌더하므로 마크업 보존(raw).
    let m = t.match(/^>\s*\*\*\(ko\)\*\*\s*(.+)$/);
    if (m) { disclaimer.ko = m[1]; continue; }
    m = t.match(/^>\s*\*\*\(en\)\*\*\s*(.+)$/);
    if (m) { disclaimer.en = m[1]; continue; }

    // 제작 노트 헤더
    if (/^##\s+제작\s*노트/.test(t)) { flush(); cur = null; mode = 'production'; continue; }

    // 카테고리 헤더
    m = t.match(/^##\s+([①②③④⑤⑥])\s+(.+)$/);
    if (m) {
      flush();
      const rest = m[2];
      const pm = rest.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
      cur = { num: m[1], title: { ko: pm ? pm[1].trim() : rest, en: pm ? pm[2].trim() : '' }, note: '', items: [] };
      categories.push(cur);
      mode = '';
      continue;
    }

    // 항목 헤더
    m = t.match(/^###\s+\d+\.\s+(.+)$/);
    if (m) { flush(); item = { title: stripBold(m[1]), meta: [], use: null, links: [], refs: [], license: '' }; continue; }

    // 블록쿼트(카테고리 주석) — 면책·제목은 위에서 처리됨.
    if (t.startsWith('>')) {
      const b = t.replace(/^>\s?/, '').trim();
      if (b && cur && !b.startsWith('**면책')) cur.note = (cur.note ? cur.note + ' ' : '') + stripBold(b);
      continue;
    }

    // 불릿
    if (t.startsWith('- ')) {
      const body = t.slice(2).trim();
      if (mode === 'production') { production.push(body); continue; }   // raw — segs() 렌더
      if (!item) continue;

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
      if (/^라이선스:/.test(body)) { item.license = body.replace(/^라이선스:\s*/, '').trim(); continue; }  // raw — segs() 렌더

      item.meta.push(stripBold(body));
      continue;
    }

    // 인트로 문단 (카테고리 이전의 첫 일반 문장 — 헤더 '#' 는 제외)
    if (t && t !== '---' && !t.startsWith('#') && !cur && mode !== 'production' && !intro) intro = stripBold(t);
  }
  flush();
  return { disclaimer, intro, categories, production };
}

export const CREDITS = parse(raw);
