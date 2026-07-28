// Browser-free catalog contract for docs/credits.md:
// every ### N. entry under categories ①–⑥ must carry unique id + non-empty
// topic + non-empty scope, and the pure parser must surface them for the UI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCreditsMarkdown,
  creditEntries,
  creditTopics,
} from '../app/src/lib/credits-parse.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREDITS_PATH = resolve(ROOT, 'docs/credits.md');
const ID_RE = /^cred-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOPIC_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const md = readFileSync(CREDITS_PATH, 'utf8');
const parsed = parseCreditsMarkdown(md);
const entries = creditEntries(parsed);
const topics = creditTopics(parsed);
const errors = [];

assert.ok(parsed.categories.length === 6, `expected 6 categories, got ${parsed.categories.length}`);
assert.ok(entries.length >= 40, `expected a full catalog, got ${entries.length} entries`);

const ids = new Set();
const requiredTopics = new Set(['drainage', 'mja-hanok', 'moon-optics']);

for (const entry of entries) {
  const label = entry.title.slice(0, 64);
  if (!entry.id) errors.push(`missing id: ${label}`);
  else if (!ID_RE.test(entry.id)) errors.push(`bad id "${entry.id}": ${label}`);
  else if (ids.has(entry.id)) errors.push(`duplicate id "${entry.id}"`);
  else ids.add(entry.id);

  if (!entry.topic) errors.push(`missing topic: ${label}`);
  else if (!TOPIC_RE.test(entry.topic)) errors.push(`bad topic "${entry.topic}": ${label}`);

  if (!entry.scope || !entry.scope.trim()) errors.push(`missing scope: ${label}`);
  else if (entry.scope.trim().length < 8) errors.push(`scope too short: ${label}`);
}

// Preserve product anchors used by browser harnesses (data-reference-topic=…).
for (const topic of requiredTopics) {
  if (!topics.includes(topic)) errors.push(`missing required topic slug: ${topic}`);
  const hit = entries.find((e) => e.topic === topic);
  if (!hit) errors.push(`no entry carries topic "${topic}"`);
}

// Raw markdown headers must not leave orphan catalog rows outside ①–⑥.
// Allow lettered sub-ids (### 17b.) so ceiling/follow-on entries stay catalog items.
const headerCount = [...md.matchAll(/^###\s+\d+[a-z]?\.\s+/gim)].length;
if (headerCount !== entries.length) {
  errors.push(
    `header/parser mismatch: ${headerCount} ### N. headers vs ${entries.length} parsed category items`
    + ' (every catalog entry must live under ## ①–⑥, not the production note)',
  );
}

// Topic chips come only from data — UI must not hardcode a closed list of three.
const modalPath = resolve(ROOT, 'app/src/components/ReferenceModal.svelte');
const modalSrc = readFileSync(modalPath, 'utf8');
if (modalSrc.includes('REFERENCE_TOPICS')) {
  errors.push('ReferenceModal still hardcodes REFERENCE_TOPICS — use CREDIT_TOPICS from the parser');
}
if (!modalSrc.includes('CREDIT_TOPICS')) {
  errors.push('ReferenceModal must consume CREDIT_TOPICS for dynamic topic chips');
}
if (!modalSrc.includes('data-reference-topic={it.topic')) {
  errors.push('ReferenceModal must bind data-reference-topic from parsed item.topic');
}

if (errors.length) {
  console.error(`CREDITS-CATALOG: FAIL (${errors.length})`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `CREDITS-CATALOG: PASS (${entries.length} entries, ${topics.length} topics, ${ids.size} unique ids)`,
);
