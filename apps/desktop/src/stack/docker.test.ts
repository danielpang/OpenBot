import { describe, expect, it, vi } from 'vitest';
import {
  detectDocker,
  dockerCliCandidates,
  dockerEnv,
  runtimeFromOperatingSystem,
  startRuntimeCommand,
} from './docker.js';
import type { Exec, ExecResult } from './process.js';

const HOME = '/Users/ada';
// What a Finder-launched app gets.
const FINDER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

function existsIn(paths: string[]) {
  const set = new Set(paths);
  return async (path: string) => set.has(path);
}

function execReplying(replies: Record<string, ExecResult>): Exec & ReturnType<typeof vi.fn> {
  return vi.fn(async (_file: string, args: string[]) => {
    const key = args.slice(0, 2).join(' ');
    return replies[key] ?? { code: 1, stdout: '', stderr: `unexpected ${key}` };
  });
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

describe('detectDocker', () => {
  it('reports missing with no CLI, listing runtime apps that are installed', async () => {
    const exec = execReplying({});
    const status = await detectDocker({
      exec,
      env: FINDER_ENV,
      home: HOME,
      exists: existsIn(['/Users/ada/Applications/Docker.app']),
    });
    expect(status).toEqual({ state: 'missing', installed: ['docker-desktop'] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('finds the OrbStack CLI outside a Finder PATH and reports a ready OrbStack', async () => {
    const cli = '/Users/ada/.orbstack/bin/docker';
    const exec = execReplying({
      'info --format': ok('27.3.1|OrbStack\n'),
      'compose version': ok('2.29.7\n'),
    });
    const status = await detectDocker({
      exec,
      env: FINDER_ENV,
      home: HOME,
      exists: existsIn([cli]),
    });
    expect(status).toEqual({
      state: 'ready',
      cli,
      runtime: 'orbstack',
      serverVersion: '27.3.1',
      composeVersion: '2.29.7',
    });
    expect(exec).toHaveBeenCalledWith(
      cli,
      ['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}'],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: expect.stringContaining('/Users/ada/.orbstack/bin') }),
      }),
    );
  });

  it('recognises Docker Desktop', async () => {
    const cli = '/usr/local/bin/docker';
    const exec = execReplying({
      'info --format': ok('28.0.1|Docker Desktop'),
      'compose version': ok('v2.33.1'),
    });
    const status = await detectDocker({
      exec,
      env: FINDER_ENV,
      home: HOME,
      exists: existsIn([cli]),
    });
    expect(status).toMatchObject({ state: 'ready', runtime: 'docker-desktop', cli });
  });

  it('prefers a docker on PATH over the known locations', async () => {
    const exec = execReplying({
      'info --format': ok('27.0.0|Ubuntu 24.04'),
      'compose version': ok('2.30.0'),
    });
    const status = await detectDocker({
      exec,
      env: { PATH: '/custom/bin' },
      home: HOME,
      exists: existsIn(['/custom/bin/docker', '/usr/local/bin/docker']),
    });
    expect(status).toMatchObject({ state: 'ready', cli: '/custom/bin/docker', runtime: 'other' });
  });

  it('reports stopped when the daemon does not answer', async () => {
    const cli = '/usr/local/bin/docker';
    const exec = execReplying({
      'info --format': {
        code: 1,
        stdout: '|\n',
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n',
      },
    });
    const status = await detectDocker({
      exec,
      env: FINDER_ENV,
      home: HOME,
      exists: existsIn([cli, '/Applications/OrbStack.app', '/Applications/Docker.app']),
    });
    expect(status).toEqual({
      state: 'stopped',
      cli,
      installed: ['orbstack', 'docker-desktop'],
      error: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
    });
  });

  it('reports no-compose when the compose plugin is missing', async () => {
    const cli = '/opt/homebrew/bin/docker';
    const exec = execReplying({
      'info --format': ok('27.3.1|OrbStack'),
      'compose version': {
        code: 1,
        stdout: '',
        stderr: "docker: 'compose' is not a docker command.",
      },
    });
    const status = await detectDocker({
      exec,
      env: FINDER_ENV,
      home: HOME,
      exists: existsIn([cli]),
    });
    expect(status).toEqual({
      state: 'no-compose',
      cli,
      runtime: 'orbstack',
      serverVersion: '27.3.1',
    });
  });
});

describe('docker helpers', () => {
  it('lists PATH candidates first, then the known install locations, once each', () => {
    const candidates = dockerCliCandidates({ PATH: '/usr/local/bin:/usr/bin' }, HOME);
    expect(candidates.slice(0, 2)).toEqual(['/usr/local/bin/docker', '/usr/bin/docker']);
    expect(candidates).toContain('/Users/ada/.orbstack/bin/docker');
    expect(candidates).toContain('/Applications/Docker.app/Contents/Resources/bin/docker');
    expect(candidates.filter((c) => c === '/usr/local/bin/docker')).toHaveLength(1);
  });

  it('puts the CLI directory first on PATH and keeps the rest of the environment', () => {
    const env = dockerEnv(
      { PATH: '/usr/bin', HOME },
      '/Applications/Docker.app/Contents/Resources/bin/docker',
      HOME,
    );
    const path = env.PATH!.split(':');
    expect(path[0]).toBe('/Applications/Docker.app/Contents/Resources/bin');
    expect(path).toContain('/usr/bin');
    expect(path).toContain('/opt/homebrew/bin');
    expect(env.HOME).toBe(HOME);
  });

  it('maps OperatingSystem to a runtime', () => {
    expect(runtimeFromOperatingSystem('OrbStack')).toBe('orbstack');
    expect(runtimeFromOperatingSystem('Docker Desktop')).toBe('docker-desktop');
    expect(runtimeFromOperatingSystem('Ubuntu 24.04.1 LTS')).toBe('other');
  });

  it('opens the runtime app by name', () => {
    expect(startRuntimeCommand('orbstack')).toEqual({
      file: '/usr/bin/open',
      args: ['-a', 'OrbStack'],
    });
    expect(startRuntimeCommand('docker-desktop')).toEqual({
      file: '/usr/bin/open',
      args: ['-a', 'Docker'],
    });
  });
});
