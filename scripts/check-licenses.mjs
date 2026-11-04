#!/usr/bin/env node
// The license pass of the 1.0 gate (plan 18.9, docs/SECURITY.md): every
// core workspace package (apps/, packages/) is BUSL-1.1 like the LICENSE
// file, every ee/ package is private and under ee/LICENSE ("SEE LICENSE IN
// LICENSE", with a copy of it beside its package.json), every production
// dependency carries a permissive license we can ship, and the core never
// imports the proprietary ee/ directory (plan 21.5).
//
//   node scripts/check-licenses.mjs
//
// MPL-2.0 is file-level copyleft: fine for unmodified dependencies (noVNC,
// resvg-js). Python-2.0 (the PSF license, argparse via js-yaml) and
// BlueOak-1.0.0 (sax via builder-util-runtime), both reached from the desktop
// app's electron-updater, are permissive licenses the ASF lists as Category A,
// so we may ship them. Anything not listed here fails until
// someone reviews it.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ALLOWED = new Set([
  'Apache-2.0',
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'MPL-2.0',
  'Python-2.0',
  'BlueOak-1.0.0',
  // qrcode-terminal's package.json spells Apache-2.0 this way.
  'Apache 2.0',
  '(MIT OR EUPL-1.1+)',
  '(AFL-2.1 OR BSD-3-Clause)',
]);

const root = join(import.meta.dirname, '..');
const problems = [];

const manifests = ['package.json'];
for (const dir of ['apps', 'packages']) {
  for (const name of readdirSync(join(root, dir))) manifests.push(join(dir, name, 'package.json'));
}
for (const path of manifests) {
  const pkg = JSON.parse(readFileSync(join(root, path), 'utf8'));
  if (pkg.license !== 'BUSL-1.1') problems.push(`${path}: license is ${pkg.license ?? 'missing'}`);
}

const EE_LICENSE = 'SEE LICENSE IN LICENSE';
const eeLicense = readFileSync(join(root, 'ee', 'LICENSE'), 'utf8');
const eeManifests = readdirSync(join(root, 'ee'), { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join(root, 'ee', entry.name, 'package.json')),
  )
  .map((entry) => join('ee', entry.name, 'package.json'));
for (const path of eeManifests) {
  const pkg = JSON.parse(readFileSync(join(root, path), 'utf8'));
  if (pkg.license !== EE_LICENSE) {
    problems.push(`${path}: license is ${pkg.license ?? 'missing'}, not "${EE_LICENSE}"`);
  }
  if (pkg.private !== true) problems.push(`${path}: must be private`);
  const copy = join(root, dirname(path), 'LICENSE');
  if (!existsSync(copy) || readFileSync(copy, 'utf8') !== eeLicense) {
    problems.push(`${dirname(path)}/LICENSE: must be a copy of ee/LICENSE`);
  }
}
manifests.push(...eeManifests);

const listed = JSON.parse(
  execFileSync('pnpm', ['-r', 'licenses', 'list', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);
let count = 0;
for (const [license, packages] of Object.entries(listed)) {
  count += packages.length;
  if (ALLOWED.has(license)) continue;
  for (const p of packages) problems.push(`${p.name}@${p.versions.join(',')}: ${license}`);
}

// Self-hosted OpenBots builds without ee/ (ee/README.md).
const sources = execFileSync('git', ['ls-files', 'apps', 'packages'], {
  cwd: root,
  encoding: 'utf8',
}).split('\n');
for (const path of sources) {
  if (!/\.(c|m)?(t|j)sx?$/.test(path)) continue;
  const text = readFileSync(join(root, path), 'utf8');
  if (
    /from\s+['"][^'"]*(\.\.\/)+ee\/|import\(\s*['"][^'"]*(\.\.\/)+ee\/|['"]@openbots\/ee/.test(text)
  ) {
    problems.push(`${path}: imports ee/`);
  }
}

if (problems.length) {
  console.error(`License check failed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `Licenses ok: ${manifests.length} workspace packages, ${count} production dependencies.`,
);
