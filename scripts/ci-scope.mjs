#!/usr/bin/env node
// Select jobs, not entire workflows, so skipped work remains visible in PRs.
// Shared dependencies and unknown code changes deliberately run the full suite.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const JOBS = ['check', 'mobile', 'postgres', 'images', 'standalone', 'browser'];
const full = () => Object.fromEntries(JOBS.map((job) => [job, true]));

export function ciScope(paths) {
  const scope = Object.fromEntries(JOBS.map((job) => [job, false]));
  const enable = (...jobs) =>
    jobs.forEach((job) => {
      scope[job] = true;
    });
  for (const path of paths) {
    // Documentation alone does not require compilation or integration runners.
    if (path.endsWith('.md') || path.startsWith('docs/')) continue;
    if (
      path.startsWith('packages/') ||
      path.startsWith('patches/') ||
      [
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        '.npmrc',
        '.nvmrc',
        'turbo.json',
        'tsconfig.base.json',
        'vitest.config.ts',
        'vitest.shared.ts',
        '.github/workflows/ci.yml',
        'scripts/ci-scope.mjs',
      ].includes(path)
    )
      return full();
    if (path.startsWith('apps/mobile/')) {
      enable('mobile');
    } else if (path.startsWith('apps/server/') || path.startsWith('ee/server/')) {
      enable('check', 'postgres', 'images', 'standalone', 'browser');
    } else if (path.startsWith('apps/web/') || path.startsWith('ee/web/')) {
      enable('check', 'images', 'standalone', 'browser');
    } else if (path.startsWith('apps/computer-agent/')) {
      enable('check', 'images', 'standalone', 'browser');
    } else if (path.startsWith('apps/relay/')) {
      enable('check', 'images');
    } else if (path.startsWith('apps/desktop/')) {
      enable('check');
    } else if (
      path.startsWith('docker/') ||
      ['compose.yaml', '.env.example', '.hadolint.yaml', 'install.sh'].includes(path)
    ) {
      enable('check', 'images', 'standalone');
    } else if (path.startsWith('scripts/')) {
      enable('check');
      if (/(backup|restore|keygen)/.test(path)) enable('images', 'standalone');
    } else if (
      path.startsWith('.github/') ||
      path.startsWith('deploy/') ||
      /^\.(gitignore|prettierignore|prettierrc\.json|editorconfig)$/.test(path) ||
      path === 'eslint.config.js'
    ) {
      enable('check');
    } else if (path === 'LICENSE') {
      enable('check');
    } else if (path.startsWith('.claude/')) {
      continue;
    } else {
      return full();
    }
  }
  return scope;
}

export function changedScope(base, head) {
  // A new branch has no before SHA. Do not silently skip checks in that case.
  if (!base || /^0+$/.test(base)) return full();
  const mergeBase = execFileSync('git', ['merge-base', base, head], { encoding: 'utf8' }).trim();
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', mergeBase, head],
    { encoding: 'utf8' },
  );
  return ciScope(changed.split('\0').filter(Boolean));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = changedScope(process.argv[2], process.argv[3] ?? 'HEAD');
  for (const [job, enabled] of Object.entries(scope)) console.log(`${job}=${enabled}`);
}
