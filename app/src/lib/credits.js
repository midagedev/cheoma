// 신뢰도(레퍼런스) 페이지 데이터 — docs/credits.md 를 빌드 시 raw 로 읽어 구조화한다.
// credits.md 는 큐레이션 담당이 관리하는 단일 출처(single source of truth). 여기서는 파싱만 하며,
// 문구·항목은 그 파일에서만 고친다. 포맷 규약은 credits-parse.js 헤더 주석.
import raw from '../../../docs/credits.md?raw';
import {
  parseCreditsMarkdown,
  creditEntries,
  creditTopics,
} from './credits-parse.js';

export {
  parseCreditsMarkdown,
  creditEntries,
  creditTopics,
} from './credits-parse.js';

export const CREDITS = parseCreditsMarkdown(raw);
export const CREDIT_TOPICS = creditTopics(CREDITS);
export const CREDIT_ENTRIES = creditEntries(CREDITS);
