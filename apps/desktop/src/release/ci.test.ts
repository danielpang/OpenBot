import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(root, 'scripts/ci-scope.mjs');
type Job = 'check' | 'mobile' | 'postgres' | 'images' | 'standalone' | 'browser';
const { ciScope } = (await import(pathToFileURL(script).href)) as {
  ciScope(paths: string[]): Record<Job, boolean>;
};
const selected = (paths: string[]) =>
  Object.entries(ciScope(paths))
    .filter(([, enabled]) => enabled)
    .map(([job]) => job)
    .sort();
const all = ['browser', 'check', 'images', 'mobile', 'postgres', 'standalone'];

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, { needs?: string | string[]; if?: string; steps: Step[] }>;
}
const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as Workflow;
const scratch: string[] = [];
afterEach(() => {
  scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('affected CI selection', () => {
  it('skips compilation/integration runners for documentation-only changes', () => {
    expect(selected(['README.md', 'docs/CONTRIBUTING.md', 'apps/mobile/README.md'])).toEqual([]);
  });

  it('runs only the mobile job for mobile-only changes', () => {
    expect(selected(['apps/mobile/src/screens/bots.tsx', 'apps/mobile/eas.json'])).toEqual([
      'mobile',
    ]);
  });

  it('keeps desktop changes out of server and container integration jobs', () => {
    expect(selected(['apps/desktop/src/main/index.ts'])).toEqual(['check']);
  });

  it('runs real database, browser and image checks for server changes', () => {
    for (const path of ['apps/server/src/db/schema.ts', 'ee/server/src/main.ts']) {
      expect(selected([path])).toEqual(['browser', 'check', 'images', 'postgres', 'standalone']);
    }
  });

  it('does not rerun server database tests for frontend-only changes', () => {
    expect(selected(['apps/web/src/main.tsx', 'ee/web/src/main.tsx'])).toEqual([
      'browser',
      'check',
      'images',
      'standalone',
    ]);
  });

  it('runs only core and image checks for relay changes', () => {
    expect(selected(['apps/relay/src/main.ts'])).toEqual(['check', 'images']);
  });

  it('checks container lifecycle when packaging or backup changes', () => {
    for (const path of [
      'docker/server.Dockerfile',
      'compose.yaml',
      'scripts/backup.sh',
      'scripts/restore.sh',
    ]) {
      expect(selected([path])).toEqual(['check', 'images', 'standalone']);
    }
  });

  it('does not trigger release builds or browser tests for release-script edits', () => {
    expect(selected(['scripts/release-version.mjs', '.github/workflows/release.yml'])).toEqual([
      'check',
    ]);
  });

  it('unions jobs for changes across apps', () => {
    expect(selected(['apps/mobile/app.config.ts', 'apps/desktop/package.json'])).toEqual([
      'check',
      'mobile',
    ]);
  });

  it.each([
    'packages/shared/src/index.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    '.nvmrc',
    'tsconfig.base.json',
    'vitest.shared.ts',
    '.github/workflows/ci.yml',
    'scripts/ci-scope.mjs',
    'new-app/index.ts',
  ])('fails safe to all jobs for shared infrastructure or unknown code: %s', (path) => {
    expect(selected([path])).toEqual(all);
  });

  it('uses the PR merge-base and includes both sides of renames', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openbots-ci-scope-'));
    scratch.push(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const commit = () => {
      git('add', '.');
      git('-c', 'user.name=CI', '-c', 'user.email=ci@example.test', 'commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    mkdirSync(join(cwd, 'apps/mobile'), { recursive: true });
    writeFileSync(join(cwd, 'apps/mobile/code.ts'), 'export const value = 1;');
    const fork = commit();
    git('checkout', '-qb', 'base');
    // Base-only shared changes must not make an unrelated PR select all jobs.
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'base-only change');
    const base = commit();
    git('checkout', '-qb', 'pr', fork);
    mkdirSync(join(cwd, 'apps/desktop'), { recursive: true });
    git('mv', 'apps/mobile/code.ts', 'apps/desktop/code.ts');
    const head = commit();
    const output = execFileSync(process.execPath, [script, base, head], { cwd, encoding: 'utf8' });
    expect(output).toContain('check=true');
    expect(output).toContain('mobile=true');
    expect(output).toContain('browser=false');
    expect(output).toContain('images=false');
  });

  it('runs every job when a push has no before SHA', () => {
    const output = execFileSync(process.execPath, [script, '0'.repeat(40)], { encoding: 'utf8' });
    expect(output.trim().split('\n')).toHaveLength(6);
    expect(output).not.toContain('=false');
  });
});

describe('CI workflow deduplication', () => {
  it('has no scheduled or release build triggers', () => {
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push']);
    expect(ci.on.push).toEqual({ branches: ['main'] });
  });

  it('gates every expensive job on its affected scope', () => {
    for (const [job, scope] of Object.entries({
      mobile: 'mobile',
      check: 'check',
      'server-postgres': 'postgres',
      'server-image': 'images',
      'standalone-image': 'standalone',
      e2e: 'browser',
    })) {
      expect(ci.jobs[job]!.needs).toEqual(job === 'e2e' ? ['scope', 'check'] : 'scope');
      expect(ci.jobs[job]!.if).toBe(`needs.scope.outputs.${scope} == 'true'`);
    }
    const scope = ci.jobs.scope!.steps.find(
      (step) => step.name === 'Select jobs from changed paths',
    )!;
    expect(scope.env!.BASE_SHA).toContain('github.event.pull_request.base.sha');
    expect(scope.env!.HEAD_SHA).toContain('github.event.pull_request.head.sha');
  });

  it('does not repeat mobile lint, types, tests or bundle in general checks', () => {
    const commands = ci.jobs.check!.steps.map((step) => step.run ?? '').join('\n');
    for (const task of ['lint', 'typecheck', 'test', 'build']) {
      expect(commands).toContain(`turbo run ${task} --filter='!@openbots/mobile'`);
    }
    expect(commands).not.toMatch(/^pnpm (lint|typecheck|test|build)$/m);
  });

  it('reuses a single build artifact across browser-test jobs', () => {
    const upload = ci.jobs.check!.steps.find(
      (step) => step.name === 'Share the browser-test build',
    )!;
    const download = ci.jobs.e2e!.steps.find(
      (step) => step.name === 'Reuse the tested workspace build',
    )!;
    expect(upload.if).toBe("needs.scope.outputs.browser == 'true'");
    expect(upload.with!.name).toBe('browser-test-build');
    expect(upload.with!.path).toContain('apps/*/dist');
    expect(upload.with!.path).toContain('packages/*/dist');
    expect(upload.with!.path).toContain('ee/*/dist');
    expect(upload.with!['retention-days']).toBe(1);
    expect(download.with).toEqual({ name: 'browser-test-build', path: '.' });
    expect(
      ci.jobs.e2e!.steps.some((step) => /(?:pnpm build|turbo run build)/.test(step.run ?? '')),
    ).toBe(false);
  });

  it('keeps an always-running result gate that fails on failed or cancelled selected jobs', () => {
    expect(ci.jobs.result!.if).toBe('always()');
    expect(ci.jobs.result!.needs).toEqual([
      'scope',
      'mobile',
      'check',
      'server-postgres',
      'server-image',
      'standalone-image',
      'e2e',
    ]);
    const gate = ci.jobs.result!.steps[0]!;
    for (const result of ['success', 'skipped', 'failure', 'cancelled']) {
      const env = {
        ...process.env,
        RESULTS: JSON.stringify({ scope: { result: 'success' }, check: { result } }),
      };
      const command = gate.run!;
      if (result === 'success' || result === 'skipped') {
        expect(() =>
          execFileSync('bash', ['-e', '-c', command], { env, stdio: 'pipe' }),
        ).not.toThrow();
      } else {
        expect(() => execFileSync('bash', ['-e', '-c', command], { env, stdio: 'pipe' })).toThrow();
      }
    }
  });
});
