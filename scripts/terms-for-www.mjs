#!/usr/bin/env node
// The website's copy of the Terms (OpenBots-www/TERMS.md, served at /terms/).
// docs/TERMS.md is the source; the website keeps a copy whose relative links
// point at this repository on GitHub instead. The terms-www workflow writes it
// and opens a pull request on OpenBots-www whenever a pull request here
// changes docs/TERMS.md.
//
//   node scripts/terms-for-www.mjs [source] > OpenBots-www/TERMS.md
//
// `source` defaults to docs/TERMS.md.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/danielpang/OpenBots';

const NOTICE =
  '<!-- Copy of docs/TERMS.md in https://github.com/danielpang/OpenBots. Edit that file; a workflow there opens a pull request with the new copy. -->';

/** Rewrites a link target relative to docs/ into an absolute GitHub URL. */
function absolute(target) {
  if (/^[a-z]+:/i.test(target) || target.startsWith('#')) return target;
  const path = resolve('/docs', target).slice(1);
  return path === 'README.md' ? `${REPO_URL}#readme` : `${REPO_URL}/blob/main/${path}`;
}

export function termsForWww(markdown) {
  const linked = markdown.replace(/\]\(([^)\s]+)\)/g, (_, target) => `](${absolute(target)})`);
  const [title, ...rest] = linked.split('\n');
  if (!title.startsWith('# ')) throw new Error('docs/TERMS.md must start with a "# " title');
  return [title, '', NOTICE, ...rest].join('\n');
}

const source = resolve(process.argv[2] ?? `${REPO_DIR}/docs/TERMS.md`);
process.stdout.write(termsForWww(readFileSync(source, 'utf8')));
