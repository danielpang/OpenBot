#!/usr/bin/env node
// The license pass of the 1.0 gate (plan 18.9): core
// packages use Apache-2.0. Enterprise and mobile packages are private and
// use "SEE LICENSE IN LICENSE", with their own license beside package.json.
// Production dependencies must carry reviewed licenses, and apps/packages
// must never import the proprietary ee/ directory (plan 21.5).
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
import { existsSync, readFileSync } from 'node:fs';
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
  // Expo/RN dependencies: preserve acknowledgements in the mobile app's
  // licenses screen. Dual licenses use their permissive MIT/BSD option;
  // caniuse's data requires attribution, and Beerware retains its notice.
  'MIT AND Apache-2.0',
  '(MIT OR Apache-2.0)',
  '(MIT OR CC0-1.0)',
  '(BSD-3-Clause OR GPL-2.0)',
  'CC-BY-4.0',
  'CC0-1.0',
  'Apache 2.0',
  'Beerware',
]);

const root = join(import.meta.dirname, '..');
const problems = [];

const manifests = execFileSync('git', ['ls-files', '--', 'package.json', '**/package.json'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n');
for (const path of manifests) {
  const pkg = JSON.parse(readFileSync(join(root, path), 'utf8'));
  const proprietary = path.startsWith('ee/') || path.startsWith('apps/mobile/');
  const expected = proprietary ? 'SEE LICENSE IN LICENSE' : 'Apache-2.0';
  if (pkg.license !== expected) {
    problems.push(`${path}: license is ${pkg.license ?? 'missing'}, not "${expected}"`);
  }
  if (!proprietary) continue;
  if (pkg.private !== true) problems.push(`${path}: must be private`);
  const licensePath = path.startsWith('ee/') ? 'ee/LICENSE' : 'apps/mobile/LICENSE';
  const copy = join(root, dirname(path), 'LICENSE');
  if (
    !existsSync(copy) ||
    readFileSync(copy, 'utf8') !== readFileSync(join(root, licensePath), 'utf8')
  ) {
    problems.push(`${dirname(path)}/LICENSE: must be a copy of ${licensePath}`);
  }
}

// Report manifest failures even when dependency tooling is unavailable.
if (problems.length) {
  console.error(`License check failed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}

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
