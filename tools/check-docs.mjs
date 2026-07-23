import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync(
  'git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n').filter(Boolean);
const errors = [];
const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

for (const path of tracked) {
  const absolute = join(ROOT, path);
  const source = readFileSync(absolute, 'utf8');
  for (const match of source.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split('#')[0].split('?')[0];
    if (!target || /^(?:https?:|mailto:|data:|#)/.test(target)) continue;
    const resolved = normalize(resolve(dirname(absolute), decodeURIComponent(target)));
    const relativeTarget = relative(ROOT, resolved);
    if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === '..') {
      errors.push(`${path}: link escapes repository: ${match[1]}`);
    } else if (!existsSync(resolved)) {
      errors.push(`${path}: missing local link target: ${match[1]}`);
    }
  }
}

const map = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8');
for (const path of tracked.filter((value) => value.startsWith('docs/') && value !== 'docs/README.md')) {
  const name = path.slice('docs/'.length);
  if (!map.includes(`(${name})`)) errors.push(`docs/README.md: missing document map entry for ${path}`);
}

if (errors.length) {
  console.error(`DOCS: FAIL (${errors.length})`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`DOCS: PASS (${tracked.length} tracked Markdown files, local links and document map)`);
