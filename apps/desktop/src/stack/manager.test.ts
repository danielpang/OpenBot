import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { bundledStackPaths } from './compose.js';
import type { DockerStatus } from './docker.js';
import { localServerUrl } from '../main/profiles.js';
import {
  compareReleases,
  composeEnv,
  createStackManager,
  devImageOverrides,
  envPort,
  envValue,
  IMAGES_UNAVAILABLE,
  imagesUnavailable,
  pendingUpgrade,
  portTakenMessage,
  pullFailureMessage,
  releaseImagePrefix,
  generateLocalToken,
  renderEnv,
  setEnvValue,
  StackError,
  upFailureMessage,
  withDatabasePassword,
  withAppDbPassword,
  withLocalToken,
  withLoopbackPort,
  withPort,
  type StackFiles,
  type StackManagerOptions,
  type StackProgress,
  type ReleaseImageLoader,
} from './manager.js';
import { NETWORK_CLASH } from './error-parts.js';
import { appSandbox, withSandbox } from './network.js';
import type { ChildLike, Exec, ExecResult } from './process.js';

const paths = bundledStackPaths('/App/Resources', '/Data');
const CLI = '/usr/local/bin/docker';
const READY: DockerStatus = {
  state: 'ready',
  cli: CLI,
  runtime: 'orbstack',
  serverVersion: '27.3.1',
  composeVersion: '2.29.7',
};
// The lines of .env.example the manager fills in.
const TEMPLATE = [
  'OPENBOTS_PUBLIC_URL=http://localhost:3000',
  'OPENBOTS_MASTER_KEY=',
  'POSTGRES_PASSWORD=',
  'DATABASE_URL=postgres://openbots:change-me@postgres:5432/openbots',
  'OPENBOTS_VERSION=latest',
  '',
].join('\n');

function memoryFiles(
  initial: Record<string, string> = {},
): StackFiles & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    readFile: async (path) => {
      const value = data.get(path);
      if (value == null) throw new Error(`ENOENT ${path}`);
      return value;
    },
    writeFile: async (path, value) => void data.set(path, value),
    exists: async (path) => data.has(path),
    mkdir: async () => undefined,
  };
}

/**
 * A docker call's verb: the compose subcommand (after the 11 base arguments),
 * `container networks` for the listing of a project's networks, or the first
 * two arguments (`container ls`, `network ls`, `network inspect`).
 */
function verbOf(args: string[]): string {
  if (args[0] === 'compose') return args[11]!;
  if (args[0] === 'container' && args.at(-1)!.includes('{{.Networks}}')) {
    return 'container networks';
  }
  return args.slice(0, 2).join(' ');
}

function composeExec(
  replies: Partial<Record<string, ExecResult>> = {},
): Exec & ReturnType<typeof vi.fn> {
  return vi.fn(
    async (_file: string, args: string[]) =>
      replies[verbOf(args)] ?? { code: 0, stdout: '', stderr: '' },
  );
}

const verbs = (exec: ReturnType<typeof composeExec>) =>
  exec.mock.calls.map(([, args]) => verbOf(args as string[]));

/** The --project-name of each compose call. */
const projects = (exec: ReturnType<typeof composeExec>) =>
  exec.mock.calls
    .map(([, args]) => args as string[])
    .filter((args) => args[0] === 'compose')
    .map((args) => args[2]);

const allFree = async () => true;

/** The project, the sandbox network, the local token, the app's database password and the loopback port this version of the app records in `.env`. */
const RECORDED =
  'COMPOSE_PROJECT_NAME=openbots-app\nOPENBOTS_SANDBOX_NETWORK=openbots-app-sandbox-254\nOPENBOTS_LOCAL_TOKEN=held\nOPENBOTS_DB_APP_PASSWORD=held\nOPENBOTS_HTTP_BIND=127.0.0.1:\n';
/** The project alone, as an install from before the app named its network has it. */
const PROJECT_ONLY = 'COMPOSE_PROJECT_NAME=openbots-app\n';
/** `compose config --images` and `image inspect` replies for images this Mac has. */
const IMAGES_HERE = {
  config: { code: 0, stdout: 'ghcr.io/x/server:1\npostgres:16\n', stderr: '' },
  'image inspect': { code: 0, stdout: 'sha256:a\nsha256:b\n', stderr: '' },
};

/** A manager over memory files and a fake docker, every port free unless told otherwise. */
function makeManager(options: Partial<StackManagerOptions> = {}) {
  const files = options.files ?? memoryFiles({ [paths.envTemplate]: TEMPLATE });
  const exec = (options.exec ?? composeExec()) as ReturnType<typeof composeExec>;
  const manager = createStackManager({
    paths,
    detect: async () => READY,
    portFree: allFree,
    ...options,
    files,
    exec,
  });
  return { manager, files: files as ReturnType<typeof memoryFiles>, exec };
}

function fakeChild() {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      emitter.emit('exit', null);
      return true;
    }),
  });
  return child as typeof child & ChildLike;
}

describe('the local owner token (OPENBOTS_LOCAL_TOKEN)', () => {
  it('is 32 random bytes in base64url, a new one each time', () => {
    const token = generateLocalToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateLocalToken()).not.toBe(token);
  });

  it('fills in a missing or empty token and keeps one that is there', () => {
    expect(withLocalToken('A=1\n', () => 'new')).toBe('A=1\nOPENBOTS_LOCAL_TOKEN=new\n');
    expect(withLocalToken('OPENBOTS_LOCAL_TOKEN=\nA=1\n', () => 'new')).toBe(
      'OPENBOTS_LOCAL_TOKEN=new\nA=1\n',
    );
    const kept = 'OPENBOTS_LOCAL_TOKEN=old\nA=1\n';
    expect(withLocalToken(kept, () => 'new')).toBe(kept);
  });

  it("fills in openbots_app's database password and keeps one that is there", () => {
    expect(withAppDbPassword('A=1\n', () => 'new')).toBe('A=1\nOPENBOTS_DB_APP_PASSWORD=new\n');
    const kept = 'OPENBOTS_DB_APP_PASSWORD=old\nA=1\n';
    expect(withAppDbPassword(kept, () => 'new')).toBe(kept);
    const env = renderEnv(TEMPLATE, {
      masterKey: 'KEY',
      databasePassword: 'p',
      appDbPassword: 'q',
    });
    expect(envValue(env, 'OPENBOTS_DB_APP_PASSWORD')).toBe('q');
  });

  it('goes into a new .env, with the web port on loopback only', () => {
    const env = renderEnv(TEMPLATE, { masterKey: 'KEY', databasePassword: 'p', localToken: 'tok' });
    expect(envValue(env, 'OPENBOTS_LOCAL_TOKEN')).toBe('tok');
    expect(envValue(env, 'OPENBOTS_HTTP_BIND')).toBe('127.0.0.1:');
  });

  it('publishes the web port on loopback unless the owner chose an address', () => {
    expect(withLoopbackPort('A=1\n')).toBe('A=1\nOPENBOTS_HTTP_BIND=127.0.0.1:\n');
    const chosen = 'OPENBOTS_HTTP_BIND=192.168.1.5:\n';
    expect(withLoopbackPort(chosen)).toBe(chosen);
  });

  it('is published by compose on the address OPENBOTS_HTTP_BIND names, every interface without it', () => {
    const compose = readFileSync(
      new URL('../../../../docker/docker-compose.yml', import.meta.url),
      'utf8',
    );
    const server = (parse(compose) as { services: { openbots: { ports: string[] } } }).services
      .openbots;
    expect(server.ports).toEqual(['${OPENBOTS_HTTP_BIND:-}${OPENBOTS_HTTP_PORT:-3000}:3000']);
    // Compose's `${NAME:-default}`, as `docker compose` resolves it.
    const resolve = (text: string, env: Record<string, string>) =>
      text.replace(/\$\{(\w+):-([^}]*)\}/g, (_, name: string, fallback: string) =>
        env[name] ? env[name]! : fallback,
      );
    const port = server.ports[0]!;
    expect(resolve(port, {})).toBe('3000:3000');
    expect(resolve(port, { OPENBOTS_HTTP_PORT: '3001' })).toBe('3001:3000');
    const local = renderEnv(TEMPLATE, {
      masterKey: 'KEY',
      databasePassword: 'p',
      localToken: 'tok',
      port: 3002,
    });
    const env = {
      OPENBOTS_HTTP_BIND: envValue(local, 'OPENBOTS_HTTP_BIND')!,
      OPENBOTS_HTTP_PORT: envValue(local, 'OPENBOTS_HTTP_PORT')!,
    };
    expect(resolve(port, env)).toBe('127.0.0.1:3002:3000');
  });

  it('is generated on first start, kept after, and read back only by localToken()', async () => {
    const { manager, files } = makeManager();
    expect(await manager.localToken()).toBeNull();
    await manager.start();
    const first = envValue(files.data.get(paths.envFile)!, 'OPENBOTS_LOCAL_TOKEN')!;
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await manager.localToken()).toBe(first);
    await manager.start();
    await manager.upgrade();
    expect(envValue(files.data.get(paths.envFile)!, 'OPENBOTS_LOCAL_TOKEN')).toBe(first);
    // Status crosses the preload bridge to the start page: never the token.
    expect(JSON.stringify(await manager.status())).not.toContain(first);
  });

  it('gives an install from before it a token on its next start, keeping everything else', async () => {
    const existing = `OPENBOTS_MASTER_KEY=keep\nPOSTGRES_PASSWORD=pw\n# mine\nX=1\nCOMPOSE_PROJECT_NAME=openbots-app\nOPENBOTS_SANDBOX_NETWORK=openbots-app-sandbox-254\n`;
    const { manager, files } = makeManager({
      files: memoryFiles({ [paths.envTemplate]: TEMPLATE, [paths.envFile]: existing }),
    });
    expect(await manager.localToken()).toBeNull();
    await manager.start();
    const env = files.data.get(paths.envFile)!;
    const token = envValue(env, 'OPENBOTS_LOCAL_TOKEN')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const appPassword = envValue(env, 'OPENBOTS_DB_APP_PASSWORD')!;
    expect(appPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(env).toBe(
      `${existing}OPENBOTS_LOCAL_TOKEN=${token}\nOPENBOTS_DB_APP_PASSWORD=${appPassword}\nOPENBOTS_HTTP_BIND=127.0.0.1:\n`,
    );
    expect(await manager.localToken()).toBe(token);
  });
});

describe('renderEnv', () => {
  it('fills the master key and the database password, and pins the image tag', () => {
    expect(
      renderEnv(TEMPLATE, { masterKey: 'KEY=', databasePassword: 'f00d', serverVersion: '1.2.3' }),
    ).toBe(
      [
        'OPENBOTS_PUBLIC_URL=http://localhost:3000',
        'OPENBOTS_MASTER_KEY=KEY=',
        'POSTGRES_PASSWORD=f00d',
        'DATABASE_URL=postgres://openbots:f00d@postgres:5432/openbots',
        'OPENBOTS_VERSION=1.2.3',
        '',
      ].join('\n'),
    );
    expect(renderEnv(TEMPLATE, { masterKey: 'KEY', databasePassword: 'p' })).toContain(
      'OPENBOTS_VERSION=latest',
    );
  });

  it('appends missing keys', () => {
    expect(
      renderEnv('A=1\n', { masterKey: 'KEY', databasePassword: 'p', serverVersion: '2.0.0' }),
    ).toBe('A=1\nOPENBOTS_MASTER_KEY=KEY\nPOSTGRES_PASSWORD=p\nOPENBOTS_VERSION=2.0.0\n');
  });

  it('fills every line of .env.example that would otherwise stop Postgres from starting', () => {
    const example = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
    const env = renderEnv(example, { masterKey: 'KEY', databasePassword: 'abc123' });
    expect(envValue(env, 'OPENBOTS_MASTER_KEY')).toBe('KEY');
    expect(envValue(env, 'POSTGRES_PASSWORD')).toBe('abc123');
    expect(envValue(env, 'DATABASE_URL')).toBe('postgres://openbots:abc123@postgres:5432/openbots');
    expect(env).not.toMatch(/^DATABASE_URL=.*change-me/m);
  });
});

describe('withDatabasePassword', () => {
  const generate = () => 'generated';

  it('keeps a password that is already set', () => {
    const env =
      'POSTGRES_PASSWORD=mine\nDATABASE_URL=postgres://openbots:mine@postgres:5432/openbots\n';
    expect(withDatabasePassword(env, generate)).toBe(env);
  });

  it('takes the password an older DATABASE_URL already has, as install.sh does', () => {
    const env = 'POSTGRES_PASSWORD=\nDATABASE_URL=postgres://openbots:old@postgres:5432/openbots\n';
    expect(withDatabasePassword(env, generate)).toBe(
      'POSTGRES_PASSWORD=old\nDATABASE_URL=postgres://openbots:old@postgres:5432/openbots\n',
    );
  });

  it('generates one in place of change-me, and leaves another database alone', () => {
    expect(withDatabasePassword(TEMPLATE, generate)).toContain(
      'POSTGRES_PASSWORD=generated\nDATABASE_URL=postgres://openbots:generated@postgres:5432/openbots',
    );
    const external = 'DATABASE_URL=postgres://me:secret@db.example.com:5432/openbots\n';
    expect(withDatabasePassword(external, generate)).toBe(
      `${external}POSTGRES_PASSWORD=generated\n`,
    );
  });
});

describe('setEnvValue', () => {
  it('replaces the line and keeps every other one, comments included', () => {
    const env = '# keep\nA=1\nOPENBOTS_VERSION=0.1.0\nB=2';
    expect(setEnvValue(env, 'OPENBOTS_VERSION', '0.2.0')).toBe(
      '# keep\nA=1\nOPENBOTS_VERSION=0.2.0\nB=2',
    );
    expect(setEnvValue('A=1', 'C', '3')).toBe('A=1\nC=3\n');
  });
});

describe('pendingUpgrade', () => {
  it('moves an older pinned release to the app version, and nothing else', () => {
    const env = (v: string) => `A=1\nOPENBOTS_VERSION=${v}\n`;
    expect(pendingUpgrade(env('0.3.0'), '0.4.0')).toEqual({ from: '0.3.0', to: '0.4.0' });
    expect(pendingUpgrade(env('0.4.0-rc.1'), '0.4.0')).toEqual({ from: '0.4.0-rc.1', to: '0.4.0' });
    expect(pendingUpgrade(env('0.4.0'), '0.4.0')).toBeNull();
    // Never down, and never off a tag the owner chose.
    expect(pendingUpgrade(env('0.5.0'), '0.4.0')).toBeNull();
    expect(pendingUpgrade(env('latest'), '0.4.0')).toBeNull();
    expect(pendingUpgrade(env('0.3'), '0.4.0')).toBeNull();
    // A development build has no release of its own.
    expect(pendingUpgrade(env('0.3.0'), undefined)).toBeNull();
    expect(pendingUpgrade('A=1\n', '0.4.0')).toBeNull();
  });

  it('orders releases by semver precedence', () => {
    expect(compareReleases('1.10.0', '1.9.9')).toBe(1);
    expect(compareReleases('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareReleases('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareReleases('1.0.0', '1.0.0')).toBe(0);
    expect(compareReleases('latest', '1.0.0')).toBeNull();
  });
});

describe('createStackManager', () => {
  it('creates .env with a 32-byte master key on first start, then runs compose up', async () => {
    const files = memoryFiles({ [paths.envTemplate]: TEMPLATE });
    const exec = composeExec({
      ps: {
        code: 0,
        stdout: '{"Service":"openbots","State":"running","Health":"healthy"}',
        stderr: '',
      },
    });
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files,
      exec,
      detect: async () => READY,
      serverVersion: '0.4.0',
    });

    const status = await manager.start();

    const env = files.data.get(paths.envFile)!;
    const key = /^OPENBOTS_MASTER_KEY=(.+)$/m.exec(env)?.[1];
    expect(Buffer.from(key!, 'base64')).toHaveLength(32);
    // The database password, in both places, as install.sh writes it.
    const password = envValue(env, 'POSTGRES_PASSWORD');
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(envValue(env, 'DATABASE_URL')).toBe(
      `postgres://openbots:${password}@postgres:5432/openbots`,
    );
    expect(env).toContain('OPENBOTS_VERSION=0.4.0');
    // Its own project, recorded, and the first free port with the URL to match.
    expect(envValue(env, 'COMPOSE_PROJECT_NAME')).toBe('openbots-app');
    expect(envValue(env, 'OPENBOTS_HTTP_PORT')).toBe('3000');
    expect(envValue(env, 'OPENBOTS_PUBLIC_URL')).toBe('http://localhost:3000');
    expect(projects(exec).every((name) => name === 'openbots-app')).toBe(true);
    const [file, args, opts] = exec.mock.calls.find(([, a]) => (a as string[]).includes('up'))!;
    expect(file).toBe(CLI);
    expect(args).toContain('--no-build');
    expect(opts).toMatchObject({ cwd: paths.projectDir });
    expect(status.services).toEqual([{ service: 'openbots', state: 'running', health: 'healthy' }]);
  });

  it('never rewrites an existing .env', async () => {
    const existing = `OPENBOTS_MASTER_KEY=keep\nPOSTGRES_PASSWORD=pw\n${RECORDED}`;
    const files = memoryFiles({ [paths.envTemplate]: TEMPLATE, [paths.envFile]: existing });
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files,
      exec: composeExec(),
      detect: async () => READY,
    });
    await manager.start();
    expect(files.data.get(paths.envFile)).toBe(existing);
  });

  it('gives an .env from an older app the database password it lacks', async () => {
    const older = TEMPLATE.replace('OPENBOTS_MASTER_KEY=', 'OPENBOTS_MASTER_KEY=keep');
    const files = memoryFiles({ [paths.envTemplate]: TEMPLATE, [paths.envFile]: older });
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files,
      exec: composeExec(),
      detect: async () => READY,
    });
    await manager.start();
    const env = files.data.get(paths.envFile)!;
    expect(envValue(env, 'OPENBOTS_MASTER_KEY')).toBe('keep');
    const password = envValue(env, 'POSTGRES_PASSWORD');
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(env).toContain(`postgres://openbots:${password}@postgres`);
  });

  it('moves an older stack to the app release on start, pulling it first and keeping other edits', async () => {
    const older = `OPENBOTS_MASTER_KEY=keep\nPOSTGRES_PASSWORD=pw\n# mine\nOPENBOTS_VERSION=0.3.0\nX=1\n${RECORDED}`;
    const files = memoryFiles({ [paths.envFile]: older });
    const exec = composeExec();
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files,
      exec,
      detect: async () => READY,
      serverVersion: '0.4.0',
    });
    expect(await manager.pendingUpgrade()).toEqual({ from: '0.3.0', to: '0.4.0' });

    const status = await manager.start();

    expect(files.data.get(paths.envFile)).toBe(older.replace('0.3.0', '0.4.0'));
    // ps: whose the port is; config: which images it needs (none here yet).
    expect(verbs(exec)).toEqual(['ps', 'config', 'pull', 'up', 'ps']);
    expect(status.upgrade).toBeNull();
    expect(await manager.pendingUpgrade()).toBeNull();
  });

  it('keeps the old release when the new one cannot be pulled', async () => {
    const older = `POSTGRES_PASSWORD=pw\nOPENBOTS_VERSION=0.3.0\n${RECORDED}`;
    const files = memoryFiles({ [paths.envFile]: older });
    const exec = composeExec({ pull: { code: 1, stdout: '', stderr: 'connection reset by peer' } });
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files,
      exec,
      detect: async () => READY,
      serverVersion: '0.4.0',
    });
    await expect(manager.start()).rejects.toMatchObject({
      message: 'Could not download OpenBots 0.4.0.',
      detail: 'connection reset by peer',
    });
    expect(files.data.get(paths.envFile)).toBe(older);
    expect(exec.mock.calls.some(([, args]) => (args as string[]).includes('up'))).toBe(false);
  });

  it('starts without pulling when the release is current, and Update always pulls', async () => {
    const files = memoryFiles({
      [paths.envFile]: `POSTGRES_PASSWORD=pw\nOPENBOTS_VERSION=0.4.0\n${RECORDED}`,
    });
    const exec = composeExec(IMAGES_HERE);
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files,
      exec,
      detect: async () => READY,
      serverVersion: '0.4.0',
    });
    const phases: string[] = [];
    await manager.start((phase) => phases.push(phase));
    expect(exec.mock.calls.some(([, args]) => (args as string[]).includes('pull'))).toBe(false);
    expect(phases).toEqual(['starting']);
    exec.mockClear();
    phases.length = 0;
    await manager.upgrade((phase) => phases.push(phase));
    expect(verbs(exec)).toEqual(['ps', 'pull', 'up', 'ps']);
    // The start page shows each step as it begins.
    expect(phases).toEqual(['pulling', 'starting']);
  });

  it('refuses to start when Docker is not running, with the daemon error', async () => {
    const exec = composeExec();
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files: memoryFiles(),
      exec,
      detect: async () => ({
        state: 'stopped',
        cli: CLI,
        installed: ['orbstack'],
        error: 'Cannot connect',
      }),
    });
    const error = await manager.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StackError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/not running/),
      detail: 'Cannot connect',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('surfaces compose up failures with stderr', async () => {
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files: memoryFiles({ [paths.envTemplate]: TEMPLATE }),
      exec: composeExec({
        ...IMAGES_HERE,
        up: { code: 1, stdout: '', stderr: 'pull access denied' },
      }),
      detect: async () => READY,
    });
    await expect(manager.start()).rejects.toMatchObject({
      message: IMAGES_UNAVAILABLE,
      detail: 'pull access denied',
    });
  });

  it('stops with compose down, and does nothing if the stack was never set up', async () => {
    const exec = composeExec();
    const fresh = createStackManager({
      portFree: allFree,
      paths,
      files: memoryFiles(),
      exec,
      detect: async () => READY,
    });
    await fresh.stop();
    expect(exec).not.toHaveBeenCalled();

    const files = memoryFiles({ [paths.envFile]: `OPENBOTS_MASTER_KEY=k\n${RECORDED}` });
    const manager = createStackManager({ paths, files, exec, detect: async () => READY });
    await manager.stop();
    expect(exec.mock.calls[0]![1]).toContain('down');
  });

  it('reports status without services when Docker is not ready', async () => {
    const exec = composeExec();
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files: memoryFiles(),
      exec,
      detect: async () => ({ state: 'missing', installed: [] }),
    });
    expect(await manager.status()).toEqual({
      docker: { state: 'missing', installed: [] },
      services: [],
      upgrade: null,
      port: null,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('opens the installed runtime when Docker is stopped', async () => {
    const exec = composeExec();
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files: memoryFiles(),
      exec,
      detect: async () => ({
        state: 'stopped',
        cli: CLI,
        installed: ['docker-desktop'],
        error: '',
      }),
    });
    await manager.startRuntime();
    expect(exec).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Docker'], expect.anything());
  });

  it('refuses to open a runtime that is not installed', async () => {
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files: memoryFiles(),
      exec: composeExec(),
      detect: async () => ({ state: 'missing', installed: [] }),
    });
    await expect(manager.startRuntime()).rejects.toBeInstanceOf(StackError);
  });

  it('tails logs from a child process line by line and kills it on stop', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files: memoryFiles(),
      spawn,
      detect: async () => READY,
    });
    const lines: string[] = [];
    const onExit = vi.fn();

    const tail = await manager.tailLogs({ tail: 100 }, (line) => lines.push(line), onExit);
    const [file, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe(CLI);
    expect(args.slice(-5)).toEqual(['logs', '--no-color', '--tail', '100', '--follow']);

    child.stdout.write('openbots-1  | listening on 3000\nopenbots-1  | ready');
    child.stdout.write('\npostgres-1 | accepting connections\n');
    child.stderr.write('redis-1    | warning\n');
    await new Promise((r) => setImmediate(r));
    expect(lines).toEqual([
      'openbots-1  | listening on 3000',
      'openbots-1  | ready',
      'postgres-1 | accepting connections',
      'redis-1    | warning',
    ]);

    tail.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // A deliberate stop is not reported as the stream ending.
    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports the log process ending on its own', async () => {
    const child = fakeChild();
    const manager = createStackManager({
      portFree: allFree,
      paths,
      files: memoryFiles(),
      spawn: () => child,
      detect: async () => READY,
    });
    const onExit = vi.fn();
    const lines: string[] = [];
    await manager.tailLogs({ tail: 10 }, (line) => lines.push(line), onExit);
    child.stdout.write('partial');
    await new Promise((r) => setImmediate(r));
    child.emit('exit', 1);
    expect(lines).toEqual(['partial']);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});

describe('the Compose project', () => {
  const legacy = (stdout: string) => ({ 'container ls': { code: 0, stdout, stderr: '' } });
  const older =
    'OPENBOTS_MASTER_KEY=keep\nPOSTGRES_PASSWORD=pw\nOPENBOTS_LOCAL_TOKEN=held\nOPENBOTS_DB_APP_PASSWORD=held\nOPENBOTS_HTTP_BIND=127.0.0.1:\n';

  it('runs a new install as openbots-app, never the openbots of a source checkout', async () => {
    // The owner's checkout runs project openbots from another directory.
    const exec = composeExec(legacy('/Users/ada/src/OpenBots\n'));
    const { manager, files } = makeManager({ exec });
    await manager.start();
    expect(projects(exec).length).toBeGreaterThan(0);
    expect(new Set(projects(exec))).toEqual(new Set(['openbots-app']));
    // With no .env there is no older install to look for.
    expect(verbs(exec)).not.toContain('container ls');
    expect(envValue(files.data.get(paths.envFile)!, 'COMPOSE_PROJECT_NAME')).toBe('openbots-app');
  });

  it('keeps openbots for an older install whose containers run from the app stack directory', async () => {
    const exec = composeExec({
      ...legacy(`/Users/ada/src/OpenBots\n${paths.projectDir}/\n`),
      // Its containers, on the default sandbox network.
      'container networks': {
        code: 0,
        stdout: `${paths.projectDir}/\topenbots_default,openbots-sbx\n`,
        stderr: '',
      },
    });
    const { manager, files } = makeManager({
      exec,
      files: memoryFiles({ [paths.envFile]: older }),
    });
    await manager.start();
    const ls = exec.mock.calls.find(([, args]) => verbOf(args as string[]) === 'container ls')!;
    expect(ls[1]).toEqual([
      'container',
      'ls',
      '--all',
      '--filter',
      'label=com.docker.compose.project=openbots',
      '--format',
      '{{.Label "com.docker.compose.project.working_dir"}}',
    ]);
    expect(new Set(projects(exec))).toEqual(new Set(['openbots']));
    // Recorded, so a Stop (which removes the containers) does not lose it,
    // and the sandbox network its containers are on with it.
    expect(files.data.get(paths.envFile)).toBe(
      `${older}COMPOSE_PROJECT_NAME=openbots\nOPENBOTS_SANDBOX_NETWORK=openbots-sbx\n`,
    );
    exec.mockClear();
    await manager.stop();
    await manager.start();
    expect(verbs(exec)).not.toContain('container ls');
    expect(verbs(exec)).not.toContain('container networks');
    expect(new Set(projects(exec))).toEqual(new Set(['openbots']));
  });

  it("never adopts an openbots project from another directory, even with the app's .env", async () => {
    const exec = composeExec(legacy('/Users/ada/src/OpenBots\n/Users/ada/Library/stack-old\n'));
    const { manager, files } = makeManager({
      exec,
      files: memoryFiles({ [paths.envFile]: older }),
    });
    await manager.start();
    expect(new Set(projects(exec))).toEqual(new Set(['openbots-app']));
    // No containers of its own anywhere: a network of its own too.
    expect(files.data.get(paths.envFile)).toBe(
      withSandbox(`${older}${PROJECT_ONLY}`, appSandbox(254)),
    );
  });

  it('starts nothing when it cannot tell whether an older install exists', async () => {
    const exec = composeExec({ 'container ls': { code: 1, stdout: '', stderr: 'daemon gone' } });
    const { manager, files } = makeManager({
      exec,
      files: memoryFiles({ [paths.envFile]: older }),
    });
    await expect(manager.start()).rejects.toMatchObject({ detail: 'daemon gone' });
    expect(verbs(exec)).toEqual(['container ls']);
    expect(files.data.get(paths.envFile)).toBe(older);
    // Status still answers, without services.
    expect((await manager.status()).services).toEqual([]);
  });
});

describe('the stack port', () => {
  const freeFrom = (taken: number[]) => async (port: number) => !taken.includes(port);

  it('gives a new stack the first free port, with the URL to match, and the app opens it there', async () => {
    const { manager, files } = makeManager({ portFree: freeFrom([3000, 3001]) });
    await manager.start();
    const env = files.data.get(paths.envFile)!;
    expect(envValue(env, 'OPENBOTS_HTTP_PORT')).toBe('3002');
    expect(envValue(env, 'OPENBOTS_PUBLIC_URL')).toBe('http://localhost:3002');
    // The local profile reads the port back from .env.
    expect(localServerUrl(env)).toBe('http://localhost:3002');
  });

  it('writes no .env when no port is free', async () => {
    const { manager, files, exec } = makeManager({ portFree: async () => false });
    await expect(manager.start()).rejects.toMatchObject({
      message: expect.stringMatching(/^No port from 3000 to 3099 is free/),
    });
    expect(files.data.has(paths.envFile)).toBe(false);
    expect(verbs(exec)).not.toContain('up');
  });

  it('refuses to start, naming the port, when another app took it, and never moves it itself', async () => {
    const env = `POSTGRES_PASSWORD=pw\nOPENBOTS_HTTP_PORT=3000\nOPENBOTS_PUBLIC_URL=http://localhost:3000\n${RECORDED}`;
    const { manager, files, exec } = makeManager({
      files: memoryFiles({ [paths.envFile]: env }),
      portFree: freeFrom([3000]),
    });
    const error = await manager.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StackError);
    expect(error).toMatchObject({ message: portTakenMessage(3000) });
    expect(portTakenMessage(3000)).toMatch(/Port 3000/);
    expect(verbs(exec)).not.toContain('pull');
    expect(verbs(exec)).not.toContain('up');
    expect(files.data.get(paths.envFile)).toBe(env);
    expect((await manager.status()).port).toEqual({ port: 3000, taken: true, free: 3001 });
  });

  it('is not taken while it is this stack that holds it', async () => {
    const running = {
      code: 0,
      stdout: '{"Service":"openbots","State":"running","Health":"healthy"}',
      stderr: '',
    };
    const { manager, exec } = makeManager({
      files: memoryFiles({ [paths.envFile]: `POSTGRES_PASSWORD=pw\n${RECORDED}` }),
      exec: composeExec({ ...IMAGES_HERE, ps: running }),
      portFree: async () => false,
    });
    expect((await manager.status()).port).toEqual({ port: 3000, taken: false, free: null });
    await manager.start();
    expect(verbs(exec)).toContain('up');
  });

  it('applies new settings to a stack an older app left running, and leaves a current one alone', async () => {
    const running = {
      code: 0,
      stdout: '{"Service":"openbots","State":"running","Health":"healthy"}',
      stderr: '',
    };
    // Recorded by an app from before the local token and the loopback port.
    const old = `POSTGRES_PASSWORD=pw\n${PROJECT_ONLY}OPENBOTS_SANDBOX_NETWORK=openbots-app-sandbox-254\n`;
    const { manager, files, exec } = makeManager({
      files: memoryFiles({ [paths.envFile]: old }),
      exec: composeExec({ ...IMAGES_HERE, ps: running }),
    });
    expect(await manager.refresh()).toBe(true);
    const env = files.data.get(paths.envFile)!;
    expect(envValue(env, 'OPENBOTS_LOCAL_TOKEN')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(envValue(env, 'OPENBOTS_HTTP_BIND')).toBe('127.0.0.1:');
    expect(verbs(exec).filter((v) => v === 'up')).toHaveLength(1);
    // Now current: nothing to do.
    expect(await manager.refresh()).toBe(false);
    expect(verbs(exec).filter((v) => v === 'up')).toHaveLength(1);
  });

  it('leaves a stopped stack to start', async () => {
    const old = `POSTGRES_PASSWORD=pw\n${RECORDED}`;
    const { manager, files, exec } = makeManager({ files: memoryFiles({ [paths.envFile]: old }) });
    expect(await manager.refresh()).toBe(false);
    expect(files.data.get(paths.envFile)).toBe(old);
    expect(verbs(exec)).not.toContain('up');
  });

  it('moves a stopped stack to a free port on request, with its localhost URL', async () => {
    const env = `OPENBOTS_HTTP_PORT=3000\nOPENBOTS_PUBLIC_URL=http://localhost:3000\n${RECORDED}`;
    const { manager, files } = makeManager({
      files: memoryFiles({ [paths.envFile]: env }),
      portFree: freeFrom([3000, 3001]),
    });
    const status = await manager.changePort();
    const moved = files.data.get(paths.envFile)!;
    expect(envValue(moved, 'OPENBOTS_HTTP_PORT')).toBe('3002');
    expect(envValue(moved, 'OPENBOTS_PUBLIC_URL')).toBe('http://localhost:3002');
    expect(status.port).toEqual({ port: 3002, taken: false, free: null });
  });

  it('refuses to move a running stack', async () => {
    const env = `OPENBOTS_HTTP_PORT=3000\n${RECORDED}`;
    const { manager, files } = makeManager({
      files: memoryFiles({ [paths.envFile]: env }),
      exec: composeExec({
        ps: { code: 0, stdout: '{"Service":"openbots","State":"running"}', stderr: '' },
      }),
    });
    await expect(manager.changePort()).rejects.toMatchObject({
      message: expect.stringMatching(/running on port 3000/),
    });
    expect(files.data.get(paths.envFile)).toBe(env);
  });

  it('reads the port as Compose does, and keeps a public URL the owner pointed elsewhere', () => {
    expect(envPort('OPENBOTS_HTTP_PORT=3000\nOPENBOTS_HTTP_PORT="3100"\n')).toBe(3100);
    expect(envPort('A=1\n')).toBe(3000);
    expect(envPort('OPENBOTS_HTTP_PORT=0\n')).toBe(3000);
    expect(
      withPort('OPENBOTS_HTTP_PORT=3000\nOPENBOTS_PUBLIC_URL=https://bots.example.com\n', 3001),
    ).toBe('OPENBOTS_HTTP_PORT=3001\nOPENBOTS_PUBLIC_URL=https://bots.example.com\n');
    expect(withPort('OPENBOTS_PUBLIC_URL=http://127.0.0.1:3000/\n', 3005)).toBe(
      'OPENBOTS_PUBLIC_URL=http://localhost:3005\nOPENBOTS_HTTP_PORT=3005\n',
    );
  });
});

describe('pulling the images', () => {
  const env = `POSTGRES_PASSWORD=pw\nOPENBOTS_VERSION=latest\n${RECORDED}`;

  it.each([
    'Error response from daemon: error from registry: denied',
    'manifest unknown',
    'Error: ghcr.io/x/server:latest not found',
    'unauthorized: authentication required',
  ])('says plainly that the images are not published for %j, keeping the output', async (out) => {
    const { manager, exec } = makeManager({
      files: memoryFiles({ [paths.envFile]: env }),
      exec: composeExec({ pull: { code: 1, stdout: 'Pulling openbots', stderr: out } }),
    });
    await expect(manager.start()).rejects.toMatchObject({
      message: IMAGES_UNAVAILABLE,
      detail: `Pulling openbots\n${out}`,
    });
    expect(verbs(exec)).not.toContain('up');
  });

  it('keeps other pull failures as they were, and the copy has no dashes', () => {
    expect(imagesUnavailable('dial tcp: i/o timeout')).toBe(false);
    expect(pullFailureMessage('dial tcp: i/o timeout', null)).toBe(
      'Pulling the OpenBots images failed.',
    );
    expect(pullFailureMessage('denied', { from: '0.3.0', to: '0.4.0' })).toBe(
      'OpenBots 0.4.0 is not published yet, or its images are not public. This Mac keeps running 0.3.0.',
    );
    expect(upFailureMessage('Bind for 0.0.0.0:3000 failed: port is already allocated', 3000)).toBe(
      portTakenMessage(3000),
    );
    expect(upFailureMessage('network sandbox not found', 3000)).toBe(
      'The OpenBots stack did not start.',
    );
    for (const text of [IMAGES_UNAVAILABLE, portTakenMessage(3000)]) {
      expect(text).not.toMatch(/[–—]| - /);
    }
  });

  it('starts with the images this Mac already has, without pulling', async () => {
    const exec = composeExec(IMAGES_HERE);
    const { manager } = makeManager({ files: memoryFiles({ [paths.envFile]: env }), exec });
    const phases: string[] = [];
    await manager.start((phase) => phases.push(phase));
    expect(verbs(exec)).toEqual(['ps', 'config', 'image inspect', 'up', 'ps']);
    const inspect = exec.mock.calls.find(([, a]) => verbOf(a as string[]) === 'image inspect')!;
    expect(inspect[1]).toEqual([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      'ghcr.io/x/server:1',
      'postgres:16',
    ]);
    expect(phases).toEqual(['starting']);
  });

  it('pulls when any image is missing here', async () => {
    const exec = composeExec({
      ...IMAGES_HERE,
      'image inspect': { code: 1, stdout: '', stderr: 'No such image: ghcr.io/x/server:1' },
    });
    const { manager } = makeManager({ files: memoryFiles({ [paths.envFile]: env }), exec });
    await manager.start();
    expect(verbs(exec)).toEqual(['ps', 'config', 'image inspect', 'pull', 'up', 'ps']);
  });
});

describe('development images', () => {
  it('reads the prefix and tag from the environment of an unpackaged app only', () => {
    const env = { OPENBOTS_IMAGE_PREFIX: 'openbots-local', OPENBOTS_VERSION: 'dev' };
    expect(devImageOverrides(env, false)).toEqual({ prefix: 'openbots-local', version: 'dev' });
    expect(devImageOverrides(env, true)).toEqual({});
    expect(devImageOverrides({}, false)).toEqual({});
    // Nothing that could break a line of .env.
    expect(
      devImageOverrides({ OPENBOTS_IMAGE_PREFIX: 'a\nB=1', OPENBOTS_VERSION: 'x y' }, false),
    ).toEqual({});
    expect(
      devImageOverrides({ OPENBOTS_IMAGE_PREFIX: 'localhost:5000/me/openbots' }, false),
    ).toEqual({ prefix: 'localhost:5000/me/openbots' });
  });

  it('writes them into a new and an existing .env, and compose reads .env alone', async () => {
    const images = { prefix: 'openbots-local', version: 'dev' };
    const exec = composeExec();
    const { manager, files } = makeManager({
      exec,
      images,
      env: { PATH: '/usr/bin', OPENBOTS_VERSION: 'latest', COMPOSE_PROFILES: 's3', HOME: '/h' },
    });
    await manager.start();
    let env = files.data.get(paths.envFile)!;
    expect(envValue(env, 'OPENBOTS_IMAGE_PREFIX')).toBe('openbots-local');
    expect(envValue(env, 'OPENBOTS_VERSION')).toBe('dev');
    const runEnv = (exec.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
    expect(runEnv.OPENBOTS_VERSION).toBeUndefined();
    expect(runEnv.COMPOSE_PROFILES).toBeUndefined();
    expect(runEnv.HOME).toBe('/h');

    files.data.set(
      paths.envFile,
      setEnvValue(setEnvValue(env, 'OPENBOTS_VERSION', '0.1.0'), 'OPENBOTS_IMAGE_PREFIX', 'x'),
    );
    await manager.start();
    env = files.data.get(paths.envFile)!;
    expect(envValue(env, 'OPENBOTS_IMAGE_PREFIX')).toBe('openbots-local');
    expect(envValue(env, 'OPENBOTS_VERSION')).toBe('dev');
  });

  it('leaves the environment alone apart from the stack settings', () => {
    expect(
      composeEnv({
        PATH: '/bin',
        DOCKER_HOST: 'unix:///x',
        OPENBOTS_HTTP_PORT: '1',
        COMPOSE_FILE: 'a',
      }),
    ).toEqual({ PATH: '/bin', DOCKER_HOST: 'unix:///x' });
  });
});

describe('the GitHub Release fallback', () => {
  const PREFIX = 'ghcr.io/danielpang/openbots';
  const DENIED =
    'Error response from daemon: Head "https://ghcr.io/v2/danielpang/openbots/server/manifests/0.4.0": denied';
  const pinned = `POSTGRES_PASSWORD=pw\nOPENBOTS_VERSION=0.4.0\n${RECORDED}`;

  /** Docker with nothing of the release here: the registry denies the pull. */
  function deniedDocker(present: string[] = []) {
    const loaded = new Set(present);
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      const verb = verbOf(args);
      if (verb === 'pull') return { code: 1, stdout: 'Pulling openbots', stderr: DENIED };
      if (verb === 'config') {
        return {
          code: 0,
          stdout: `${PREFIX}/server:0.4.0\n${PREFIX}/sandbox-firewall:0.4.0\npostgres:16\n`,
          stderr: '',
        };
      }
      if (verb === 'image inspect') {
        const refs = args.slice(4);
        const here = refs.every((ref) => loaded.has(ref));
        return { code: here ? 0 : 1, stdout: '', stderr: here ? '' : 'No such image' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    return { exec: exec as unknown as ReturnType<typeof composeExec>, loaded };
  }

  it('loads the images the registry denied from the release, then starts as after a pull', async () => {
    const { exec, loaded } = deniedDocker([`${PREFIX}/sandbox-firewall:0.4.0`]);
    const releaseImages = vi.fn<ReleaseImageLoader>(async (request) => {
      request.onProgress({
        image: 'server',
        phase: 'downloading',
        receivedBytes: 0,
        totalBytes: 200,
      });
      request.onProgress({
        image: 'server',
        phase: 'downloading',
        receivedBytes: 1,
        totalBytes: 200,
      });
      request.onProgress({
        image: 'server',
        phase: 'downloading',
        receivedBytes: 100,
        totalBytes: 200,
      });
      request.onProgress({ image: 'server', phase: 'loading', receivedBytes: 0, totalBytes: null });
      request.onProgress({
        image: 'computer',
        phase: 'downloading',
        receivedBytes: 5,
        totalBytes: null,
      });
      for (const image of request.images) loaded.add(`${request.imagePrefix}/${image}:0.4.0`);
    });
    const { manager } = makeManager({
      files: memoryFiles({ [paths.envFile]: pinned }),
      exec,
      serverVersion: '0.4.0',
      releaseImages,
    });
    const steps: [string, StackProgress | undefined][] = [];

    await manager.start((phase, progress) => steps.push([phase, progress]));

    expect(releaseImages).toHaveBeenCalledTimes(1);
    expect(releaseImages.mock.calls[0]![0]).toMatchObject({
      version: '0.4.0',
      imagePrefix: PREFIX,
      // The firewall is here already; the computer is not a compose service but is denied too.
      images: ['server', 'computer'],
      docker: CLI,
    });
    expect(verbs(exec).slice(-2)).toEqual(['up', 'ps']);
    const release = { source: 'release', count: 2 } as const;
    expect(steps).toEqual([
      ['pulling', undefined],
      ['pulling', { ...release, image: 'server', index: 1, step: 'downloading', percent: 0 }],
      // 1 of 200 bytes is still 0%: one message per percent.
      ['pulling', { ...release, image: 'server', index: 1, step: 'downloading', percent: 50 }],
      ['pulling', { ...release, image: 'server', index: 1, step: 'loading', percent: null }],
      ['pulling', { ...release, image: 'computer', index: 2, step: 'downloading', percent: null }],
      ['starting', undefined],
    ]);
  });

  it('never tries it in development, or for a stack pinned to another release', async () => {
    const releaseImages = vi.fn<ReleaseImageLoader>(async () => undefined);
    for (const options of [
      // Unpackaged: no release of its own.
      { files: memoryFiles({ [paths.envFile]: pinned }) },
      // OPENBOTS_IMAGE_PREFIX and OPENBOTS_VERSION overrides from `pnpm dev`.
      {
        files: memoryFiles({ [paths.envFile]: pinned }),
        serverVersion: '0.4.0',
        images: { prefix: 'openbots-local', version: 'dev' },
      },
      // The owner pinned `latest`: the release's archives are not that.
      {
        files: memoryFiles({ [paths.envFile]: pinned.replace('0.4.0', 'latest') }),
        serverVersion: '0.4.0',
      },
    ] satisfies Partial<StackManagerOptions>[]) {
      const { exec } = deniedDocker();
      const { manager } = makeManager({ ...options, exec, releaseImages });
      await expect(manager.start()).rejects.toMatchObject({ message: IMAGES_UNAVAILABLE });
      expect(verbs(exec)).not.toContain('up');
    }
    expect(releaseImages).not.toHaveBeenCalled();
  });

  it('is not used for a pull that failed for another reason', async () => {
    const releaseImages = vi.fn<ReleaseImageLoader>(async () => undefined);
    const { manager } = makeManager({
      files: memoryFiles({ [paths.envFile]: pinned }),
      exec: composeExec({ pull: { code: 1, stdout: '', stderr: 'dial tcp: i/o timeout' } }),
      serverVersion: '0.4.0',
      releaseImages,
    });
    await expect(manager.start()).rejects.toMatchObject({
      message: 'Pulling the OpenBots images failed.',
    });
    expect(releaseImages).not.toHaveBeenCalled();
  });

  it("shows the registry's error with the release download's reason, keeping the old release", async () => {
    const older = `POSTGRES_PASSWORD=pw\nOPENBOTS_VERSION=0.3.0\n${RECORDED}`;
    const files = memoryFiles({ [paths.envFile]: older });
    const { exec } = deniedDocker();
    const { manager } = makeManager({
      files,
      exec,
      serverVersion: '0.4.0',
      releaseImages: async () => {
        throw new Error('There is no OpenBots 0.4.0 release with image archives.');
      },
    });
    const error = await manager.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StackError);
    expect(error).toMatchObject({
      message:
        'OpenBots 0.4.0 is not published yet, or its images are not public. This Mac keeps running 0.3.0.',
    });
    expect((error as StackError).detail).toBe(
      `Pulling openbots\n${DENIED}\n\nThe images could not be downloaded from the GitHub Release either: There is no OpenBots 0.4.0 release with image archives.`,
    );
    expect(files.data.get(paths.envFile)).toBe(older);
    expect(verbs(exec)).not.toContain('up');
  });

  it('finds the prefix compose pulls the release from', () => {
    expect(releaseImagePrefix([`postgres:16`, `${PREFIX}/server:0.4.0`], '0.4.0')).toBe(PREFIX);
    expect(releaseImagePrefix([`${PREFIX}/server:latest`], '0.4.0')).toBeNull();
  });
});

describe('the sandbox network', () => {
  /** `network ls` and `network inspect` replies for these networks. */
  const networks = (list: [string, ...string[]][]) => ({
    'network ls': { code: 0, stdout: list.map((_, i) => `id${i}`).join('\n'), stderr: '' },
    'network inspect': {
      code: 0,
      stdout: list.map((n) => n.join(' ')).join('\n'),
      stderr: '',
    },
  });
  // The owner's Mac: a source checkout's stack on the default network.
  const CHECKOUT: [string, ...string[]][] = [
    ['bridge', '192.168.215.0/24'],
    ['host'],
    ['openbots_default', '192.168.156.0/24'],
    ['openbots-sbx', '172.30.255.0/24'],
  ];
  const older =
    'OPENBOTS_MASTER_KEY=keep\nPOSTGRES_PASSWORD=pw\nOPENBOTS_LOCAL_TOKEN=held\nOPENBOTS_DB_APP_PASSWORD=held\nOPENBOTS_HTTP_BIND=127.0.0.1:\n';
  const sandboxOf = (env: string) =>
    Object.fromEntries(
      [
        'OPENBOTS_SANDBOX_NETWORK',
        'OPENBOTS_SANDBOX_BRIDGE',
        'OPENBOTS_SANDBOX_SUBNET',
        'OPENBOTS_SANDBOX_SERVER_IP',
        'OPENBOTS_SANDBOX_EGRESS_PROXY_IP',
      ].map((key) => [key, envValue(env, key)]),
    );

  it('gives a new stack its own network on the first free subnet, read with read-only calls', async () => {
    const exec = composeExec(networks([...CHECKOUT, ['other', '172.30.254.0/25']]));
    const { manager, files } = makeManager({ exec });
    await manager.start();
    expect(sandboxOf(files.data.get(paths.envFile)!)).toEqual({
      OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox-253',
      OPENBOTS_SANDBOX_BRIDGE: 'openbots-a-253',
      OPENBOTS_SANDBOX_SUBNET: '172.30.253.0/24',
      OPENBOTS_SANDBOX_SERVER_IP: '172.30.253.2',
      OPENBOTS_SANDBOX_EGRESS_PROXY_IP: '172.30.253.3',
    });
    const calls = exec.mock.calls.map(([, args]) => args as string[]);
    expect(calls.find((a) => a[0] === 'network' && a[1] === 'ls')).toEqual([
      'network',
      'ls',
      '--quiet',
    ]);
    expect(calls.find((a) => a[0] === 'network' && a[1] === 'inspect')).toEqual([
      'network',
      'inspect',
      '--format',
      '{{.Name}}{{range .IPAM.Config}} {{.Subnet}}{{end}}',
      'id0',
      'id1',
      'id2',
      'id3',
      'id4',
    ]);
    // Nothing that creates, removes or changes a network.
    expect(calls.filter((a) => a[0] === 'network').map((a) => a[1])).toEqual(['ls', 'inspect']);
  });

  it('takes 172.30.254.0/24 on a Mac with no other networks', async () => {
    const { manager, files } = makeManager();
    await manager.start();
    expect(envValue(files.data.get(paths.envFile)!, 'OPENBOTS_SANDBOX_SUBNET')).toBe(
      '172.30.254.0/24',
    );
  });

  it('writes no .env when every subnet it may use is taken', async () => {
    const exec = composeExec(networks([['wide', '172.30.0.0/16']]));
    const { manager, files } = makeManager({ exec });
    await expect(manager.start()).rejects.toMatchObject({
      message: expect.stringContaining('Every network OpenBots can use is taken'),
    });
    expect(files.data.has(paths.envFile)).toBe(false);
  });

  it('keeps the network an existing .env names, without asking Docker', async () => {
    const existing = `${older}${RECORDED}OPENBOTS_SANDBOX_SUBNET=172.30.254.0/24\n`;
    const exec = composeExec(networks(CHECKOUT));
    const { manager, files } = makeManager({
      exec,
      files: memoryFiles({ [paths.envFile]: existing }),
    });
    await manager.start();
    expect(files.data.get(paths.envFile)).toBe(existing);
    expect(verbs(exec)).not.toContain('network ls');
    expect(verbs(exec)).not.toContain('container networks');
  });

  it("keeps today's default for an older .env whose containers already use it", async () => {
    // An install from before the app named its network: the template's subnet, no name.
    const existing = `${older}${PROJECT_ONLY}OPENBOTS_SANDBOX_SUBNET=172.30.255.0/24\nOPENBOTS_SANDBOX_SERVER_IP=172.30.255.2\n`;
    const exec = composeExec({
      ...networks(CHECKOUT),
      'container networks': {
        code: 0,
        stdout: `/Users/ada/src/OpenBots\topenbots-sbx\n${paths.projectDir}\topenbots-app_default,openbots-sbx\n`,
        stderr: '',
      },
    });
    const { manager, files } = makeManager({
      exec,
      files: memoryFiles({ [paths.envFile]: existing }),
    });
    await manager.start();
    expect(files.data.get(paths.envFile)).toBe(
      `${existing}OPENBOTS_SANDBOX_NETWORK=openbots-sbx\n`,
    );
    const ls = exec.mock.calls.find(([, a]) => verbOf(a as string[]) === 'container networks')!;
    expect(ls[1]).toEqual([
      'container',
      'ls',
      '--all',
      '--filter',
      'label=com.docker.compose.project=openbots-app',
      '--format',
      '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Networks}}',
    ]);
    expect(verbs(exec)).not.toContain('network ls');
  });

  it('moves an older .env with no containers on the default network to a network of its own', async () => {
    const existing = `${older}${PROJECT_ONLY}OPENBOTS_SANDBOX_SUBNET=172.30.255.0/24\nOPENBOTS_SANDBOX_SERVER_IP=172.30.255.2\n`;
    const exec = composeExec({
      ...networks(CHECKOUT),
      // Only the checkout's containers are on it.
      'container networks': {
        code: 0,
        stdout: `/Users/ada/src/OpenBots\topenbots-sbx\n`,
        stderr: '',
      },
    });
    const { manager, files } = makeManager({
      exec,
      files: memoryFiles({ [paths.envFile]: existing }),
    });
    await manager.start();
    expect(sandboxOf(files.data.get(paths.envFile)!)).toMatchObject({
      OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox-254',
      OPENBOTS_SANDBOX_SUBNET: '172.30.254.0/24',
      OPENBOTS_SANDBOX_SERVER_IP: '172.30.254.2',
    });
  });

  it('keeps a subnet the owner set, giving only the names', async () => {
    const existing = `${older}${PROJECT_ONLY}OPENBOTS_SANDBOX_SUBNET=10.99.0.0/24\nOPENBOTS_SANDBOX_SERVER_IP=10.99.0.2\n`;
    const exec = composeExec(networks(CHECKOUT));
    const { manager, files } = makeManager({
      exec,
      files: memoryFiles({ [paths.envFile]: existing }),
    });
    await manager.start();
    expect(sandboxOf(files.data.get(paths.envFile)!)).toEqual({
      OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox',
      OPENBOTS_SANDBOX_BRIDGE: 'openbots-a-sbx',
      OPENBOTS_SANDBOX_SUBNET: '10.99.0.0/24',
      OPENBOTS_SANDBOX_SERVER_IP: '10.99.0.2',
      OPENBOTS_SANDBOX_EGRESS_PROXY_IP: undefined,
    });
  });

  it("says another stack holds the network when the server's address is taken", async () => {
    // What the owner's Mac printed.
    const output = [
      'level=warning msg="a network with name openbots-sbx exists but was not created for project \\"openbots-app\\". Set `external: true` to use an existing network"',
      'Container openbots-app-openbots-1  Error response from daemon: failed to set up container networking: Address already in use',
    ].join('\n');
    const exec = composeExec({ up: { code: 1, stdout: '', stderr: output } });
    const { manager } = makeManager({
      exec,
      files: memoryFiles({ [paths.envFile]: `${older}${RECORDED}` }),
    });
    await expect(manager.start()).rejects.toMatchObject({ message: NETWORK_CLASH, detail: output });
  });

  it('tells a clash from the web port, and from images it cannot pull', () => {
    const warning =
      'a network with name openbots-sbx exists but was not created for project "openbots-app"';
    const bind =
      'failed to set up container networking: driver failed programming external connectivity on endpoint x: listen tcp4 0.0.0.0:3000: bind: address already in use';
    expect(upFailureMessage(`${warning}\n${bind}`, 3000)).toBe(portTakenMessage(3000));
    expect(upFailureMessage(bind, 3000)).toBe(portTakenMessage(3000));
    expect(upFailureMessage(`${warning}\npull access denied for x`, 3000)).toBe(IMAGES_UNAVAILABLE);
    expect(upFailureMessage(warning, 3000)).toBe(NETWORK_CLASH);
    expect(
      upFailureMessage(
        'invalid pool request: Pool overlaps with other one on this address space',
        3000,
      ),
    ).toBe(NETWORK_CLASH);
  });

  describe('moving to a network of its own', () => {
    const current = `${older}${PROJECT_ONLY}OPENBOTS_SANDBOX_SUBNET=172.30.255.0/24\nOPENBOTS_SANDBOX_SERVER_IP=172.30.255.2\nOPENBOTS_SANDBOX_EGRESS_PROXY_IP=172.30.255.3\nOPENBOTS_SANDBOX_EGRESS_PROXY=http://172.30.255.3:8888\n`;

    it('refuses while any of its containers runs', async () => {
      const exec = composeExec({
        ...networks(CHECKOUT),
        ps: {
          code: 0,
          stdout: '{"Service":"postgres","State":"running","Health":"healthy"}',
          stderr: '',
        },
      });
      const { manager, files } = makeManager({
        exec,
        files: memoryFiles({ [paths.envFile]: current }),
      });
      await expect(manager.useOwnNetwork()).rejects.toMatchObject({
        message:
          'OpenBots is running on this Mac. Stop it before it moves to a network of its own.',
      });
      expect(files.data.get(paths.envFile)).toBe(current);
      expect(verbs(exec)).not.toContain('network ls');
    });

    it('rewrites a stopped stack onto a fresh name and free subnet, the proxy with it', async () => {
      const exec = composeExec(networks(CHECKOUT));
      const { manager, files } = makeManager({
        exec,
        files: memoryFiles({ [paths.envFile]: current }),
      });
      await manager.useOwnNetwork();
      const env = files.data.get(paths.envFile)!;
      expect(sandboxOf(env)).toEqual({
        OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox-254',
        OPENBOTS_SANDBOX_BRIDGE: 'openbots-a-254',
        OPENBOTS_SANDBOX_SUBNET: '172.30.254.0/24',
        OPENBOTS_SANDBOX_SERVER_IP: '172.30.254.2',
        OPENBOTS_SANDBOX_EGRESS_PROXY_IP: '172.30.254.3',
      });
      expect(envValue(env, 'OPENBOTS_SANDBOX_EGRESS_PROXY')).toBe('http://172.30.254.3:8888');
      expect(envValue(env, 'OPENBOTS_MASTER_KEY')).toBe('keep');
      // Writing .env is all it does: nothing is started, stopped or removed.
      expect(
        verbs(exec).filter((v) => !['ps', 'network ls', 'network inspect'].includes(v)),
      ).toEqual([]);
    });

    it('never picks the subnet it is leaving, even when Docker no longer lists it', async () => {
      const leaving = withSandbox(`${older}${PROJECT_ONLY}`, appSandbox(254));
      const exec = composeExec(networks(CHECKOUT));
      const { manager, files } = makeManager({
        exec,
        files: memoryFiles({ [paths.envFile]: leaving }),
      });
      await manager.useOwnNetwork();
      expect(envValue(files.data.get(paths.envFile)!, 'OPENBOTS_SANDBOX_NETWORK')).toBe(
        'openbots-app-sandbox-253',
      );
    });
  });
});
