import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  composeArgs,
  imageInspectArgs,
  isProjectName,
  LEGACY_PROJECT_NAME,
  legacyContainersArgs,
  networkInspectArgs,
  networkListArgs,
  parseComposePs,
  parseImages,
  PROJECT_NAME,
  projectNetworksArgs,
  type ComposeCommand,
  type ServiceState,
  type StackPaths,
} from './compose.js';
import {
  detectDocker,
  dockerEnv,
  startRuntimeCommand,
  type DockerDetectDeps,
  type DockerApp,
  type DockerStatus,
} from './docker.js';
import {
  FIRST_PORT,
  findFreePort,
  nodePortFree,
  PORT_SEARCH_LIMIT,
  type PortCheck,
} from './port.js';
import { RELEASE_IMAGES, type ReleaseImage } from '../images/release-archive.js';
import { envValue, setEnvValue } from './env.js';
import { isNetworkClash, NETWORK_CLASH } from './error-parts.js';
import {
  chooseSandbox,
  containersOnNetwork,
  DEFAULT_SANDBOX,
  envNetwork,
  parseNetworks,
  withSandbox,
  type DockerNetwork,
  type SandboxChoice,
} from './network.js';
import {
  lineSplitter,
  nodeExec,
  nodeSpawn,
  type Exec,
  type ExecResult,
  type Spawn,
} from './process.js';

// The local stack manager (plan 14.4, 18.8): detects Docker Desktop or
// OrbStack, starts and stops the bundled compose stack, and tails its logs from
// a child process. Main-process only; the renderer reaches it through the
// preload bridge in ./bridge.ts.

export interface StackStatus {
  docker: DockerStatus;
  /** Empty when Docker is not ready or the stack has never been started. */
  services: ServiceState[];
  /** The app is a newer release than the one the stack runs; the next start moves to it. */
  upgrade: StackUpgrade | null;
  /** The stack's web port from `.env`; null before the first start writes one. */
  port: StackPort | null;
}

export interface StackPort {
  port: number;
  /** Another app listens on it while this stack's server does not run: a start would fail. */
  taken: boolean;
  /** While taken: the free port "Use port N" moves the stack to, or null when none is free. */
  free: number | null;
}

/** Development only: the image prefix and tag a start writes into `.env`. */
export interface ImageOverrides {
  prefix?: string;
  version?: string;
}

/**
 * Loads the app's release images from the GitHub Release (src/images): the
 * fallback when the registry refuses them. Resolves once every image in
 * `images` is in Docker as `<imagePrefix>/<image>:<version>`; rejects with
 * the reason it could not.
 */
export type ReleaseImageLoader = (request: {
  version: string;
  imagePrefix: string;
  images: ReleaseImage[];
  /** The docker CLI and the environment to run it with. */
  docker: string;
  env: NodeJS.ProcessEnv;
  onProgress: (progress: {
    image: ReleaseImage;
    phase: 'downloading' | 'loading';
    receivedBytes: number;
    totalBytes: number | null;
  }) => void;
}) => Promise<void>;

/** The release in the stack's `.env` (`from`) and the app's own (`to`). */
export interface StackUpgrade {
  from: string;
  to: string;
}

export interface StackFiles {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export interface StackManagerOptions {
  paths: StackPaths;
  /** A separate namespace for side-by-side previews; existing .env projects stay authoritative. */
  projectName?: string;
  /**
   * The app's release: the image tag written to OPENBOTS_VERSION in a new
   * `.env`, and the one an older `.env` moves to. The template's when omitted
   * (development), and then an existing `.env` is never upgraded.
   */
  serverVersion?: string;
  /**
   * Development only (an unpackaged app has no release of its own): the
   * images to run, e.g. ones built locally. Written into `.env` on every start.
   */
  images?: ImageOverrides;
  /**
   * Packaged builds only: when the registry denies the release's images or
   * does not have them, load them from the GitHub Release instead. Never used
   * without `serverVersion` or with development `images`.
   */
  releaseImages?: ReleaseImageLoader;
  /**
   * The relay a `.env` without one gets as OPENBOTS_RELAY_URL on its next
   * start: the project's shared relay (main/pairing.ts). The owner changes it
   * with `setRelay`.
   */
  defaultRelayUrl?: string;
  /** Shared relays that no longer serve; a `.env` naming one gets `defaultRelayUrl`. */
  retiredRelayUrls?: readonly string[];
  exec?: Exec;
  spawn?: Spawn;
  files?: StackFiles;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** For tests: the Docker check, defaults to `detectDocker`. */
  detect?: (deps: DockerDetectDeps) => Promise<DockerStatus>;
  /** For tests: whether nothing listens on a port, defaults to `nodePortFree`. */
  portFree?: PortCheck;
}

export class StackError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'StackError';
  }
}

/** What a start or update is doing, for the start page's progress line. */
export type StackPhase = 'pulling' | 'starting';

/**
 * More about a `pulling` step, sent with it while the images come from the
 * GitHub Release instead of the registry.
 */
export interface StackProgress {
  source: 'release';
  image: ReleaseImage;
  /** 1-based position of `image` among the images being loaded, and how many there are. */
  index: number;
  count: number;
  step: 'downloading' | 'loading';
  /** Of this image's download; null when the size is unknown or while loading. */
  percent: number | null;
}

export type StackProgressListener = (phase: StackPhase, progress?: StackProgress) => void;

export interface LogTail {
  stop(): void;
}

export interface StackManager {
  status(): Promise<StackStatus>;
  /**
   * Creates `.env` on first start (on a free port), moves it to the app's
   * release when the app is newer, pulls the images unless every one is
   * already on this Mac, then `compose up --wait`. Refuses while another app
   * holds the stack's port. `onPhase` hears each step as it begins.
   */
  start(onPhase?: StackProgressListener): Promise<StackStatus>;
  stop(): Promise<StackStatus>;
  /**
   * For a stack that is already running when the app opens: brings `.env` up
   * to date as a start would (a local token, the loopback port, and so on)
   * and, only when that changed it, runs `compose up` so the services take
   * the new settings. True when it did. A stopped stack is left to `start`.
   */
  refresh(): Promise<boolean>;
  /**
   * Like `start`, but always pulls first: the images of the app's release, or
   * newer ones for a moving tag such as `latest`.
   */
  upgrade(onPhase?: StackProgressListener): Promise<StackStatus>;
  /** Reads only `.env`, so it needs no Docker. */
  pendingUpgrade(): Promise<StackUpgrade | null>;
  /**
   * OPENBOTS_LOCAL_TOKEN from `.env`, which the main process signs the owner
   * in with (main/local-session.ts); null before a start wrote one. Main
   * process only: it never crosses the preload bridge.
   */
  localToken(): Promise<string | null>;
  /** OPENBOTS_RELAY_URL from `.env`; null when it is empty or there is no `.env`. */
  relayUrl(): Promise<string | null>;
  /**
   * Writes OPENBOTS_RELAY_URL into `.env` and, when the stack runs and the
   * value changed, runs `compose up` so the server takes it. The caller
   * checks the URL (main/pairing.ts parseRelayUrl).
   */
  setRelay(url: string): Promise<StackStatus>;
  /**
   * Moves a stack that is not running to the first free port (and its
   * localhost OPENBOTS_PUBLIC_URL with it), for when another app took its port.
   */
  changePort(): Promise<StackStatus>;
  /**
   * Moves a stack that is not running to a sandbox network of its own: a new
   * name and the first free subnet (network.ts), for when another OpenBots
   * stack on this Mac holds its network. The next start makes it.
   */
  useOwnNetwork(): Promise<StackStatus>;
  /** Opens a stopped Docker Desktop or OrbStack. */
  startRuntime(runtime?: DockerApp): Promise<void>;
  /** Follows `compose logs`; `onExit` fires when the child process ends. */
  tailLogs(
    options: { tail: number },
    onLine: (line: string) => void,
    onExit?: (code: number | null) => void,
  ): Promise<LogTail>;
}

const nodeFiles: StackFiles = {
  readFile: (path) => fs.readFile(path, 'utf8'),
  // .env holds the master key: owner-only.
  writeFile: (path, data) => fs.writeFile(path, data, { mode: 0o600 }),
  exists: (path) =>
    fs.access(path).then(
      () => true,
      () => false,
    ),
  mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => undefined),
};

export { envValue, setEnvValue };

const TEMPLATE_DATABASE_URL = 'DATABASE_URL=postgres://openbots:change-me@postgres:5432/openbots';
const DATABASE_URL_PASSWORD =
  /^DATABASE_URL=postgres:\/\/openbots:([^@]*)@postgres:5432\/openbots$/;

/**
 * The compose Postgres password (threat model S-3), exactly as install.sh sets
 * it: an existing POSTGRES_PASSWORD is kept; otherwise the password already in
 * DATABASE_URL (an older database was created with it), or a new one from
 * `generate`, goes into POSTGRES_PASSWORD and in place of the template's
 * `change-me` in DATABASE_URL. Postgres refuses to start without one.
 */
export function withDatabasePassword(env: string, generate: () => string): string {
  if (/^POSTGRES_PASSWORD=.+/m.test(env)) return env;
  let current: string | undefined;
  for (const line of env.split(/\r?\n/)) {
    const match = DATABASE_URL_PASSWORD.exec(line);
    if (match) current = match[1];
  }
  const password = current && current !== 'change-me' ? current : generate();
  const lines = env
    .split('\n')
    .map((line) =>
      line.replace(/\r$/, '') === TEMPLATE_DATABASE_URL
        ? `DATABASE_URL=postgres://openbots:${password}@postgres:5432/openbots`
        : line,
    );
  return setEnvValue(lines.join('\n'), 'POSTGRES_PASSWORD', password);
}

/**
 * The Mac app's local owner token (OPENBOTS_LOCAL_TOKEN): with it the main
 * process signs the owner in, so This Mac has no sign-in (main/local-session.ts).
 * An existing one is kept; a `.env` without one, new or from before, gets one.
 */
export function withLocalToken(env: string, generate: () => string): string {
  if (envValue(env, 'OPENBOTS_LOCAL_TOKEN')?.trim()) return env;
  return setEnvValue(env, 'OPENBOTS_LOCAL_TOKEN', generate());
}

/**
 * The password of openbots_app, the database role the server works as under
 * row-level security (OPENBOTS_DB_APP_PASSWORD). An existing one is kept; a
 * `.env` without one, new or from before, gets one.
 */
export function withAppDbPassword(env: string, generate: () => string): string {
  if (envValue(env, 'OPENBOTS_DB_APP_PASSWORD')?.trim()) return env;
  return setEnvValue(env, 'OPENBOTS_DB_APP_PASSWORD', generate());
}

/**
 * The address the stack's web port is published on (OPENBOTS_HTTP_BIND in
 * docker/docker-compose.yml): this Mac's loopback, so other machines on the
 * network cannot reach a server that signs its owner in without a password.
 */
export const LOOPBACK_BIND = '127.0.0.1:';

/** Publishes the web port on loopback only, unless the owner set an address themselves. */
export function withLoopbackPort(env: string): string {
  if (envValue(env, 'OPENBOTS_HTTP_BIND') != null) return env;
  return setEnvValue(env, 'OPENBOTS_HTTP_BIND', LOOPBACK_BIND);
}

/** 32 random bytes, base64url: nothing to quote in `.env`. */
export function generateLocalToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 24 random bytes in hex, like install.sh: nothing to escape in DATABASE_URL. */
export function generateDatabasePassword(): string {
  return randomBytes(24).toString('hex');
}

/**
 * The default relay (OPENBOTS_RELAY_URL) for a `.env` that has none, so the
 * phone can reach This Mac away from home without a setting, or that names a
 * `retired` one. One the owner set stays.
 */
export function withRelay(
  env: string,
  url: string | undefined,
  retired: readonly string[] = [],
): string {
  if (!url) return env;
  const current = envValue(env, 'OPENBOTS_RELAY_URL')?.trim();
  if (current && !retired.includes(current)) return env;
  return setEnvValue(env, 'OPENBOTS_RELAY_URL', url);
}

/** The stack's web port: OPENBOTS_HTTP_PORT, or Compose's default of 3000. */
export function envPort(env: string): number {
  const port = Number(
    envValue(env, 'OPENBOTS_HTTP_PORT')
      ?.trim()
      .replace(/^["']|["']$/g, ''),
  );
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : FIRST_PORT;
}

/**
 * Publishes the stack on `port`: OPENBOTS_HTTP_PORT, and OPENBOTS_PUBLIC_URL
 * when it is the localhost address of the old port (or missing). A public URL
 * the owner pointed at a tunnel or a domain stays.
 */
export function withPort(env: string, port: number): string {
  const before = envPort(env);
  const url = envValue(env, 'OPENBOTS_PUBLIC_URL')?.trim();
  const local = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${before}/?$`);
  let next = setEnvValue(env, 'OPENBOTS_HTTP_PORT', String(port));
  if (!url || local.test(url)) {
    next = setEnvValue(next, 'OPENBOTS_PUBLIC_URL', `http://localhost:${port}`);
  }
  return next;
}

/** Writes the development image overrides, if any, into `.env`. */
export function withImages(env: string, images: ImageOverrides | undefined): string {
  let next = env;
  if (images?.prefix) next = setEnvValue(next, 'OPENBOTS_IMAGE_PREFIX', images.prefix);
  if (images?.version) next = setEnvValue(next, 'OPENBOTS_VERSION', images.version);
  return next;
}

const IMAGE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * OPENBOTS_IMAGE_PREFIX and OPENBOTS_VERSION from the environment `pnpm dev`
 * runs in, for testing the local stack against images built from source
 * (`openbots-local` and `dev`). A packaged app ignores them: it runs its own
 * release. A value that is not an image prefix or tag is ignored.
 */
export function devImageOverrides(env: NodeJS.ProcessEnv, packaged: boolean): ImageOverrides {
  if (packaged) return {};
  const prefix = env.OPENBOTS_IMAGE_PREFIX?.trim();
  const version = env.OPENBOTS_VERSION?.trim();
  return {
    ...(prefix && IMAGE_PREFIX.test(prefix) ? { prefix } : {}),
    ...(version && IMAGE_TAG.test(version) ? { version } : {}),
  };
}

/** A new `.env` from the template: a fresh master key and database password, and the image tag. */
export function renderEnv(
  template: string,
  values: {
    masterKey: string;
    databasePassword: string;
    /** OPENBOTS_LOCAL_TOKEN; left as the template has it when omitted. */
    localToken?: string;
    /** OPENBOTS_DB_APP_PASSWORD; left as the template has it when omitted. */
    appDbPassword?: string;
    serverVersion?: string;
    /** The free port the stack publishes, with the matching OPENBOTS_PUBLIC_URL. */
    port?: number;
    /** The Compose project, recorded so a later start keeps it. */
    project?: string;
    /** The stack's own sandbox network and subnet. */
    sandbox?: SandboxChoice;
    images?: ImageOverrides;
  },
): string {
  let env = setEnvValue(template, 'OPENBOTS_MASTER_KEY', values.masterKey);
  env = withDatabasePassword(env, () => values.databasePassword);
  if (values.appDbPassword != null) env = withAppDbPassword(env, () => values.appDbPassword!);
  if (values.localToken != null) {
    env = withLocalToken(env, () => values.localToken!);
    env = withLoopbackPort(env);
  }
  if (values.serverVersion != null)
    env = setEnvValue(env, 'OPENBOTS_VERSION', values.serverVersion);
  if (values.port != null) {
    env = setEnvValue(env, 'OPENBOTS_HTTP_PORT', String(values.port));
    env = setEnvValue(env, 'OPENBOTS_PUBLIC_URL', `http://localhost:${values.port}`);
  }
  if (values.project != null) env = setEnvValue(env, 'COMPOSE_PROJECT_NAME', values.project);
  if (values.sandbox != null) env = withSandbox(env, values.sandbox);
  return withImages(env, values.images);
}

/**
 * The environment `docker compose` runs with: the stack's settings come from
 * its `.env` alone, so OPENBOTS_* values and Compose's project, file and
 * profile choices in the app's own environment do not reach it (a shell
 * variable would win over `.env`).
 */
export function composeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ignored = new Set([
    'COMPOSE_PROJECT_NAME',
    'COMPOSE_FILE',
    'COMPOSE_PROFILES',
    'COMPOSE_ENV_FILES',
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('OPENBOTS_') && !ignored.has(name)),
  );
}

export const IMAGES_UNAVAILABLE =
  'The OpenBots images for this version are not published yet. Connect to a self-hosted server instead.';

export function portTakenMessage(port: number): string {
  return `Port ${port} is in use by another app. Move OpenBots to a free port, or quit that app.`;
}

const NO_FREE_SUBNET =
  'Every network OpenBots can use is taken. Remove a Docker network you no longer use.';

const NO_FREE_PORT = `No port from ${FIRST_PORT} to ${FIRST_PORT + PORT_SEARCH_LIMIT - 1} is free on this Mac. Quit an app that uses one, then try again.`;

/** What a registry says when an image is missing or private. */
const PULL_UNAVAILABLE = /\b(denied|not found|manifest unknown|unauthorized)\b/i;
/** The same in `compose up` output, where only pull errors count. */
const UP_UNAVAILABLE =
  /pull access denied|error from registry|manifest unknown|manifest for \S+ not found|unauthorized/i;
const UP_PORT_TAKEN = /port is already allocated|address already in use/i;

/** True when a pull failed because the images are not published or not public. */
export function imagesUnavailable(output: string): boolean {
  return PULL_UNAVAILABLE.test(output);
}

/** The sentence for a failed pull; the output stays in the error's detail. */
export function pullFailureMessage(output: string, upgrade: StackUpgrade | null): string {
  if (imagesUnavailable(output)) {
    return upgrade
      ? `OpenBots ${upgrade.to} is not published yet, or its images are not public. This Mac keeps running ${upgrade.from}.`
      : IMAGES_UNAVAILABLE;
  }
  return upgrade
    ? `Could not download OpenBots ${upgrade.to}.`
    : 'Pulling the OpenBots images failed.';
}

/** The prefix compose pulls the release's server image from (`<prefix>/server:<version>`). */
export function releaseImagePrefix(images: string[], version: string): string | null {
  for (const image of images) {
    const match = /^(.+)\/server:(.+)$/.exec(image);
    if (match && match[2] === version) return match[1]!;
  }
  return null;
}

/**
 * The sentence for a failed `compose up`, which pulls a missing image itself.
 * The sandbox network's "Address already in use" is another stack's address,
 * not the web port, so it is told apart before the port.
 */
export function upFailureMessage(output: string, port: number): string {
  if (UP_UNAVAILABLE.test(output)) return IMAGES_UNAVAILABLE;
  if (isNetworkClash(output, { stronglyOnly: true })) return NETWORK_CLASH;
  if (UP_PORT_TAKEN.test(output)) return portTakenMessage(port);
  if (isNetworkClash(output)) return NETWORK_CLASH;
  return 'The OpenBots stack did not start.';
}

const output = (result: ExecResult) => [result.stdout, result.stderr].join('\n').trim();

/** Any of the stack's containers is up: too soon to change its network. */
function anyRunning(services: ServiceState[]): boolean {
  return services.some((s) => ['running', 'restarting', 'paused'].includes(s.state));
}

/** The stack's server has its container up, so the port is this stack's own. */
function holdsPort(services: ServiceState[]): boolean {
  return services.some(
    (s) => s.service === 'openbots' && ['running', 'restarting', 'paused'].includes(s.state),
  );
}

const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Orders two release versions (semver precedence), or null when either is not one. */
export function compareReleases(a: string, b: string): number | null {
  const x = RELEASE.exec(a);
  const y = RELEASE.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  // A prerelease comes before its release.
  if (x[4] == null || y[4] == null) return x[4] == null ? (y[4] == null ? 0 : 1) : -1;
  const xs = x[4].split('.');
  const ys = y[4].split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const [p, q] = [xs[i], ys[i]];
    if (p == null || q == null) return p == null ? -1 : 1;
    if (p === q) continue;
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
    if (numeric) return Math.sign(Number(p) - Number(q));
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The stack should move to the app's release: `.env` pins an older release.
 * A tag that is not a release (`latest`, a line such as `1.2`, a custom
 * build) was chosen by the owner and is left alone, as is a newer one.
 */
export function pendingUpgrade(env: string, appVersion: string | undefined): StackUpgrade | null {
  const from = envValue(env, 'OPENBOTS_VERSION')?.trim();
  if (appVersion == null || !from) return null;
  return compareReleases(appVersion, from) === 1 ? { from, to: appVersion } : null;
}

export function createStackManager(options: StackManagerOptions): StackManager {
  const { paths } = options;
  const exec = options.exec ?? nodeExec;
  const spawn = options.spawn ?? nodeSpawn;
  const files = options.files ?? nodeFiles;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const detect = options.detect ?? detectDocker;
  const portFree = options.portFree ?? nodePortFree;

  const detectHere = () => detect({ exec, exists: files.exists, env, home });
  const runEnv = (cli: string) => composeEnv(dockerEnv(env, cli, home));

  async function requireReady(): Promise<Extract<DockerStatus, { state: 'ready' }>> {
    const docker = await detectHere();
    switch (docker.state) {
      case 'ready':
        return docker;
      case 'missing':
        throw new StackError('Docker is not installed. Install OrbStack or Docker Desktop.', '');
      case 'stopped':
        throw new StackError(
          'Docker is not running. Open OrbStack or Docker Desktop.',
          docker.error,
        );
      case 'no-compose':
        throw new StackError('Docker Compose v2 is not available.', '');
    }
  }

  async function compose(cli: string, project: string, command: ComposeCommand) {
    return exec(cli, composeArgs(paths, command, project), {
      env: runEnv(cli),
      cwd: paths.projectDir,
    });
  }

  /**
   * The install predates the app's own project name: containers of the
   * `openbots` project have the app's stack directory as their working
   * directory. A source checkout's `openbots` stack (any other directory) is
   * never taken over.
   */
  async function hasLegacyContainers(cli: string): Promise<boolean> {
    const listed = await exec(cli, legacyContainersArgs(), { env: runEnv(cli) });
    if (listed.code !== 0) {
      throw new StackError('Could not list the Docker containers.', output(listed));
    }
    const own = resolve(paths.projectDir);
    return listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((dir) => dir !== '' && resolve(dir) === own);
  }

  /**
   * The Compose project of this install: the one `.env` records, else
   * `openbots` for an install from before the app had its own name (see
   * hasLegacyContainers), else PROJECT_NAME. A start records it in `.env`.
   */
  async function project(cli: string): Promise<string> {
    if (!(await files.exists(paths.envFile))) return options.projectName ?? PROJECT_NAME;
    const recorded = envValue(await files.readFile(paths.envFile), 'COMPOSE_PROJECT_NAME')?.trim();
    if (recorded && isProjectName(recorded)) return recorded;
    return (await hasLegacyContainers(cli))
      ? LEGACY_PROJECT_NAME
      : (options.projectName ?? PROJECT_NAME);
  }

  async function services(cli: string, name: string): Promise<ServiceState[]> {
    if (!(await files.exists(paths.envFile))) return [];
    const ps = await compose(cli, name, { kind: 'ps' });
    if (ps.code !== 0) return [];
    try {
      return parseComposePs(ps.stdout);
    } catch {
      return [];
    }
  }

  /** Every image the stack's services run is on this Mac already, so a start needs no pull. */
  async function imagesPresent(cli: string, name: string): Promise<boolean> {
    const listed = await compose(cli, name, { kind: 'images' });
    const images = listed.code === 0 ? parseImages(listed.stdout) : [];
    if (images.length === 0) return false;
    const inspected = await exec(cli, imageInspectArgs(images), { env: runEnv(cli) });
    return inspected.code === 0;
  }

  /** Every Docker network's name and subnets, read with `network ls` and `network inspect`. */
  async function dockerNetworks(cli: string): Promise<DockerNetwork[]> {
    const fail = (result: ExecResult) =>
      new StackError('Could not list the Docker networks.', output(result));
    const listed = await exec(cli, networkListArgs(), { env: runEnv(cli) });
    if (listed.code !== 0) throw fail(listed);
    const ids = listed.stdout.split(/\s+/).filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await exec(cli, networkInspectArgs(ids), { env: runEnv(cli) });
    if (inspected.code !== 0) throw fail(inspected);
    return parseNetworks(inspected.stdout);
  }

  /** The app's own network on the first free subnet, never one in `avoid`. */
  async function freeSandbox(cli: string, avoid: string[] = []): Promise<SandboxChoice> {
    const choice = chooseSandbox(await dockerNetworks(cli), avoid);
    if (choice == null) throw new StackError(NO_FREE_SUBNET, '');
    return choice;
  }

  /**
   * A container of this install (`name`, in the app's stack directory) is on
   * `network`: the stack already runs there, so it stays.
   */
  async function usesNetwork(cli: string, name: string, network: string): Promise<boolean> {
    const listed = await exec(cli, projectNetworksArgs(name), { env: runEnv(cli) });
    if (listed.code !== 0) {
      throw new StackError('Could not list the Docker containers.', output(listed));
    }
    const own = resolve(paths.projectDir);
    return containersOnNetwork(listed.stdout, network, (dir) => resolve(dir) === own);
  }

  /**
   * The sandbox network of an existing `.env` that names none, from before
   * the app gave its stack one of its own: compose's default when this
   * install's containers are already on it (like the project name, it keeps
   * what it runs on), otherwise a network of its own on a free subnet. A
   * subnet the owner set in `.env` stays.
   */
  async function sandboxFor(cli: string, name: string, env: string): Promise<string> {
    if (envNetwork(env) != null) return env;
    if (await usesNetwork(cli, name, DEFAULT_SANDBOX.network)) {
      return setEnvValue(env, 'OPENBOTS_SANDBOX_NETWORK', DEFAULT_SANDBOX.network);
    }
    const subnet = envValue(env, 'OPENBOTS_SANDBOX_SUBNET')?.trim();
    if (subnet && subnet !== DEFAULT_SANDBOX.subnet) {
      // The owner's own subnet: only the names move.
      let next = setEnvValue(env, 'OPENBOTS_SANDBOX_NETWORK', 'openbots-app-sandbox');
      next = setEnvValue(next, 'OPENBOTS_SANDBOX_BRIDGE', 'openbots-a-sbx');
      return next;
    }
    return withSandbox(env, await freeSandbox(cli));
  }

  async function freePort(except: number[] = []): Promise<number> {
    const port = await findFreePort(portFree, except);
    if (port == null) throw new StackError(NO_FREE_PORT, '');
    return port;
  }

  /**
   * A new `.env` on first start, on a free port and a sandbox network of its
   * own. An existing one is kept, except that one written before the app
   * generated the database password gets it now (with it missing, Postgres
   * never started, so there is no database to mismatch), one from before the
   * app named its sandbox network gets one (sandboxFor), one from before the
   * app signed its owner in gets a local token (withLocalToken) and a web
   * port on loopback only (withLoopbackPort), and the
   * project and any development images are recorded in it.
   */
  async function ensureEnv(cli: string, name: string): Promise<string> {
    if (await files.exists(paths.envFile)) {
      const current = await files.readFile(paths.envFile);
      let fixed = withDatabasePassword(current, generateDatabasePassword);
      fixed = withLocalToken(fixed, generateLocalToken);
      fixed = withAppDbPassword(fixed, generateDatabasePassword);
      fixed = withLoopbackPort(fixed);
      if (envValue(fixed, 'COMPOSE_PROJECT_NAME')?.trim() !== name) {
        fixed = setEnvValue(fixed, 'COMPOSE_PROJECT_NAME', name);
      }
      fixed = await sandboxFor(cli, name, fixed);
      fixed = withImages(fixed, options.images);
      fixed = withRelay(fixed, options.defaultRelayUrl, options.retiredRelayUrls);
      if (fixed !== current) await files.writeFile(paths.envFile, fixed);
      return fixed;
    }
    await files.mkdir(paths.projectDir);
    const template = await files.readFile(paths.envTemplate);
    const created = renderEnv(template, {
      masterKey: randomBytes(32).toString('base64'),
      databasePassword: generateDatabasePassword(),
      appDbPassword: generateDatabasePassword(),
      localToken: generateLocalToken(),
      serverVersion: options.serverVersion,
      port: await freePort(),
      project: name,
      sandbox: await freeSandbox(cli),
      images: options.images,
    });
    const withDefaultRelay = withRelay(created, options.defaultRelayUrl, options.retiredRelayUrls);
    await files.writeFile(paths.envFile, withDefaultRelay);
    return withDefaultRelay;
  }

  async function pendingUpgradeHere(): Promise<StackUpgrade | null> {
    if (!(await files.exists(paths.envFile))) return null;
    return pendingUpgrade(await files.readFile(paths.envFile), options.serverVersion);
  }

  /** The port `.env` publishes, and whether another app took it while the stack is down. */
  async function portHere(running: ServiceState[]): Promise<StackPort | null> {
    if (!(await files.exists(paths.envFile))) return null;
    const port = envPort(await files.readFile(paths.envFile));
    const taken = !holdsPort(running) && !(await portFree(port));
    return { port, taken, free: taken ? await findFreePort(portFree, [port]) : null };
  }

  async function statusOf(docker: DockerStatus, name?: string): Promise<StackStatus> {
    let running: ServiceState[] = [];
    if (docker.state === 'ready') {
      // A failed container listing only hides the services from this status.
      const resolved = name ?? (await project(docker.cli).catch(() => null));
      if (resolved != null) running = await services(docker.cli, resolved);
    }
    return {
      docker,
      services: running,
      upgrade: await pendingUpgradeHere(),
      port: await portHere(running),
    };
  }

  const status = async () => statusOf(await detectHere());

  /**
   * After a pull the registry refused: loads the release's images that are
   * not on this Mac from the GitHub Release. Returns false when that does not
   * apply (a development build, a stack pinned to another version, or a
   * failure that is not the registry's refusal); throws a StackError with the
   * pull's sentence, and both reasons in its detail, when the download fails too.
   */
  async function loadFromRelease(
    cli: string,
    name: string,
    pullOutput: string,
    upgrade: StackUpgrade | null,
    onPhase?: StackProgressListener,
  ): Promise<boolean> {
    const version = options.serverVersion;
    const loader = options.releaseImages;
    if (!loader || !version || options.images?.prefix || options.images?.version) return false;
    if (!imagesUnavailable(pullOutput)) return false;
    const current = await files.readFile(paths.envFile);
    if (envValue(current, 'OPENBOTS_VERSION')?.trim() !== version) return false;
    const listed = await compose(cli, name, { kind: 'images' });
    const prefix = releaseImagePrefix(listed.code === 0 ? parseImages(listed.stdout) : [], version);
    if (prefix == null) return false;
    // The computer image is not a compose service, but the server pulls it
    // from the same registry, which would refuse it the same way.
    const wanted = RELEASE_IMAGES.filter(
      (image) => image !== 'computer' || !envValue(current, 'OPENBOTS_SANDBOX_IMAGE')?.trim(),
    );
    const missing: ReleaseImage[] = [];
    for (const image of wanted) {
      const inspected = await exec(cli, imageInspectArgs([`${prefix}/${image}:${version}`]), {
        env: runEnv(cli),
      });
      if (inspected.code !== 0) missing.push(image);
    }
    if (missing.length === 0) return false;

    let last = '';
    try {
      await loader({
        version,
        imagePrefix: prefix,
        images: missing,
        docker: cli,
        env: dockerEnv(env, cli, home),
        onProgress: ({ image, phase, receivedBytes, totalBytes }) => {
          const percent =
            phase === 'downloading' && totalBytes
              ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100))
              : null;
          const progress: StackProgress = {
            source: 'release',
            image,
            index: missing.indexOf(image) + 1,
            count: missing.length,
            step: phase,
            percent,
          };
          // One message per percent, not per chunk.
          const key = JSON.stringify(progress);
          if (key === last) return;
          last = key;
          onPhase?.('pulling', progress);
        },
      });
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new StackError(
        pullFailureMessage(pullOutput, upgrade),
        `${pullOutput}\n\nThe images could not be downloaded from the GitHub Release either: ${reason}`,
      );
    }
  }

  /**
   * Moves `.env` to the app's release when it pins an older one, pulls when
   * asked to, or when an image is not on this Mac, then brings the stack up.
   * A failed pull puts the old release back, so the stack keeps running what
   * it has.
   */
  async function up(pull: boolean, onPhase?: StackProgressListener): Promise<StackStatus> {
    const docker = await requireReady();
    const name = await project(docker.cli);
    const current = await ensureEnv(docker.cli, name);
    const port = envPort(current);
    if (!holdsPort(await services(docker.cli, name)) && !(await portFree(port))) {
      throw new StackError(portTakenMessage(port), '');
    }
    const upgrade = pendingUpgrade(current, options.serverVersion);
    if (upgrade) {
      await files.writeFile(paths.envFile, setEnvValue(current, 'OPENBOTS_VERSION', upgrade.to));
    }
    if (pull || !(await imagesPresent(docker.cli, name))) {
      onPhase?.('pulling');
      const pulled = await compose(docker.cli, name, { kind: 'pull' });
      if (pulled.code !== 0) {
        // A failed pull, and a failed fallback, put the old release back.
        const restore = async () => {
          if (upgrade) await files.writeFile(paths.envFile, current);
        };
        let loaded: boolean;
        try {
          loaded = await loadFromRelease(docker.cli, name, output(pulled), upgrade, onPhase);
        } catch (error) {
          await restore();
          throw error;
        }
        if (!loaded) {
          await restore();
          throw new StackError(pullFailureMessage(output(pulled), upgrade), output(pulled));
        }
      }
    }
    onPhase?.('starting');
    const result = await compose(docker.cli, name, { kind: 'up' });
    if (result.code !== 0) {
      throw new StackError(upFailureMessage(output(result), port), output(result));
    }
    return statusOf(docker, name);
  }

  return {
    status,

    start: (onPhase) => up(false, onPhase),

    upgrade: (onPhase) => up(true, onPhase),

    pendingUpgrade: pendingUpgradeHere,

    async localToken() {
      if (!(await files.exists(paths.envFile))) return null;
      return envValue(await files.readFile(paths.envFile), 'OPENBOTS_LOCAL_TOKEN')?.trim() || null;
    },

    async relayUrl() {
      if (!(await files.exists(paths.envFile))) return null;
      return envValue(await files.readFile(paths.envFile), 'OPENBOTS_RELAY_URL')?.trim() || null;
    },

    async setRelay(url) {
      const docker = await requireReady();
      if (!(await files.exists(paths.envFile))) {
        throw new StackError('Start OpenBots on this Mac before you choose its relay.', '');
      }
      const name = await project(docker.cli);
      const current = await files.readFile(paths.envFile);
      const next = setEnvValue(current, 'OPENBOTS_RELAY_URL', url);
      if (next === current) return statusOf(docker, name);
      await files.writeFile(paths.envFile, next);
      if (!anyRunning(await services(docker.cli, name))) return statusOf(docker, name);
      return up(false);
    },

    async changePort() {
      const docker = await requireReady();
      if (!(await files.exists(paths.envFile))) return statusOf(docker);
      const name = await project(docker.cli);
      const current = await files.readFile(paths.envFile);
      const port = envPort(current);
      if (holdsPort(await services(docker.cli, name))) {
        throw new StackError(
          `OpenBots is running on port ${port}. Stop it before moving it to another port.`,
          '',
        );
      }
      await files.writeFile(paths.envFile, withPort(current, await freePort([port])));
      return statusOf(docker, name);
    },

    async useOwnNetwork() {
      const docker = await requireReady();
      if (!(await files.exists(paths.envFile))) return statusOf(docker);
      const name = await project(docker.cli);
      if (anyRunning(await services(docker.cli, name))) {
        throw new StackError(
          'OpenBots is running on this Mac. Stop it before it moves to a network of its own.',
          '',
        );
      }
      const current = await files.readFile(paths.envFile);
      // A new subnet, never the one it is leaving.
      const leaving =
        envValue(current, 'OPENBOTS_SANDBOX_SUBNET')?.trim() || DEFAULT_SANDBOX.subnet;
      const choice = await freeSandbox(docker.cli, [leaving]);
      await files.writeFile(paths.envFile, withSandbox(current, choice));
      return statusOf(docker, name);
    },

    async refresh() {
      const docker = await detectHere();
      if (docker.state !== 'ready' || !(await files.exists(paths.envFile))) return false;
      const name = await project(docker.cli);
      if (!anyRunning(await services(docker.cli, name))) return false;
      const before = await files.readFile(paths.envFile);
      if ((await ensureEnv(docker.cli, name)) === before) return false;
      await up(false);
      return true;
    },

    async stop() {
      const docker = await requireReady();
      if (!(await files.exists(paths.envFile))) return statusOf(docker);
      const name = await project(docker.cli);
      const down = await compose(docker.cli, name, { kind: 'down' });
      if (down.code !== 0) throw new StackError('The OpenBots stack did not stop.', output(down));
      return statusOf(docker, name);
    },

    async startRuntime(runtime) {
      const docker = await detectHere();
      if (docker.state === 'ready' || docker.state === 'no-compose') return;
      const choice = runtime ?? docker.installed[0];
      if (choice == null) {
        throw new StackError('Neither OrbStack nor Docker Desktop is installed.', '');
      }
      const command = startRuntimeCommand(choice);
      const result = await exec(command.file, command.args, { env });
      if (result.code !== 0) throw new StackError(`Could not open ${choice}.`, result.stderr);
    },

    async tailLogs({ tail }, onLine, onExit) {
      const docker = await requireReady();
      const name = await project(docker.cli);
      const child = spawn(
        docker.cli,
        composeArgs(paths, { kind: 'logs', tail, follow: true }, name),
        { env: runEnv(docker.cli), cwd: paths.projectDir },
      );
      const out = lineSplitter(onLine);
      const err = lineSplitter(onLine);
      child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
      let stopped = false;
      child.on('error', (error) => onLine(`[stack] ${error.message}`));
      child.on('exit', (code) => {
        out.flush();
        err.flush();
        if (!stopped) onExit?.(code);
      });
      return {
        stop() {
          if (stopped) return;
          stopped = true;
          child.kill('SIGTERM');
        },
      };
    },
  };
}
