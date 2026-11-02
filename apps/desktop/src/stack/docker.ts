import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Exec } from './process.js';

// Docker detection for the local stack (plan 14.4). A Mac app launched from
// Finder inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the docker
// CLI is looked for in the places Docker Desktop, OrbStack and Homebrew install
// it as well as on PATH.

export type DockerRuntime = 'docker-desktop' | 'orbstack' | 'other';
/** A runtime with a Mac app the stack manager can open. */
export type DockerApp = Exclude<DockerRuntime, 'other'>;

export type DockerStatus =
  /** No docker CLI anywhere. `installed` lists runtime apps found on disk. */
  | { state: 'missing'; installed: DockerApp[] }
  /** The CLI exists but the daemon does not answer: the runtime is not running. */
  | { state: 'stopped'; cli: string; installed: DockerApp[]; error: string }
  /** The daemon answers but `docker compose` (v2) is unavailable. */
  | { state: 'no-compose'; cli: string; runtime: DockerRuntime; serverVersion: string }
  | {
      state: 'ready';
      cli: string;
      runtime: DockerRuntime;
      serverVersion: string;
      composeVersion: string;
    };

export interface DockerDetectDeps {
  exec: Exec;
  exists?: (path: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const RUNTIME_APPS: Record<DockerApp, string> = {
  orbstack: 'OrbStack.app',
  'docker-desktop': 'Docker.app',
};

/** Directories the docker CLI and its plugins and credential helpers live in. */
export function knownDockerBinDirs(home: string): string[] {
  return [
    join(home, '.orbstack', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Applications/Docker.app/Contents/Resources/bin',
    '/Applications/OrbStack.app/Contents/MacOS/xbin',
    join(home, '.docker', 'bin'),
  ];
}

/** Candidate docker CLI paths, PATH first, without duplicates. */
export function dockerCliCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const fromPath = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const dirs = [...new Set([...fromPath, ...knownDockerBinDirs(home)])];
  return dirs.map((dir) => join(dir, 'docker'));
}

/**
 * The environment to run the docker CLI with: PATH extended with the CLI's own
 * directory and the known bin directories, so `docker compose` finds its plugin
 * and `docker pull` finds `docker-credential-desktop` or `-osxkeychain`.
 */
export function dockerEnv(env: NodeJS.ProcessEnv, cli: string, home: string): NodeJS.ProcessEnv {
  const path = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const dirs = [...new Set([dirname(cli), ...path, ...knownDockerBinDirs(home)])];
  return { ...env, PATH: dirs.join(delimiter) };
}

/** Which runtime a daemon is, from `docker info`'s OperatingSystem field. */
export function runtimeFromOperatingSystem(operatingSystem: string): DockerRuntime {
  if (/orbstack/i.test(operatingSystem)) return 'orbstack';
  if (/docker desktop/i.test(operatingSystem)) return 'docker-desktop';
  return 'other';
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Runtime apps installed in /Applications or ~/Applications, OrbStack first. */
export async function installedRuntimes(
  exists: (path: string) => Promise<boolean>,
  home: string,
): Promise<DockerApp[]> {
  const found: DockerApp[] = [];
  for (const [runtime, app] of Object.entries(RUNTIME_APPS) as [DockerApp, string][]) {
    const paths = [join('/Applications', app), join(home, 'Applications', app)];
    for (const path of paths) {
      if (await exists(path)) {
        found.push(runtime);
        break;
      }
    }
  }
  return found;
}

export async function detectDocker(deps: DockerDetectDeps): Promise<DockerStatus> {
  const exists = deps.exists ?? fileExists;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();

  let cli: string | undefined;
  for (const candidate of dockerCliCandidates(env, home)) {
    if (await exists(candidate)) {
      cli = candidate;
      break;
    }
  }
  if (cli == null) return { state: 'missing', installed: await installedRuntimes(exists, home) };

  const runEnv = dockerEnv(env, cli, home);
  const info = await deps.exec(
    cli,
    ['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}'],
    { env: runEnv },
  );
  const [serverVersion = '', operatingSystem = ''] = info.stdout.trim().split('|');
  if (info.code !== 0 || serverVersion === '') {
    return {
      state: 'stopped',
      cli,
      installed: await installedRuntimes(exists, home),
      error: info.stderr.trim(),
    };
  }
  const runtime = runtimeFromOperatingSystem(operatingSystem);

  const compose = await deps.exec(cli, ['compose', 'version', '--short'], { env: runEnv });
  if (compose.code !== 0) return { state: 'no-compose', cli, runtime, serverVersion };
  return { state: 'ready', cli, runtime, serverVersion, composeVersion: compose.stdout.trim() };
}

/** The command that launches a stopped runtime (`open -a OrbStack`). */
export function startRuntimeCommand(runtime: DockerApp): {
  file: string;
  args: string[];
} {
  return { file: '/usr/bin/open', args: ['-a', RUNTIME_APPS[runtime].replace(/\.app$/, '')] };
}
