import { join } from 'node:path';

// `docker compose` command construction for the stack bundled with the Mac app
// (plan 14.4, 16.1). The compose files ship read-only inside the signed app
// bundle; the project directory is writable app data holding `.env`, so the
// relative paths in docker/docker-compose.yml (`.env`) resolve there.

/**
 * The app's Compose project. Not `openbots`, the project a `docker compose up`
 * in a source checkout gets: the two stacks' containers, networks and volumes
 * stay apart.
 */
export const PROJECT_NAME = 'openbots-app';
/**
 * The project the app used before it had its own name. An install whose
 * containers still carry it, with the app's stack directory as their working
 * directory, keeps it (and its volumes).
 */
export const LEGACY_PROJECT_NAME = 'openbots';

/** How long `up --wait` waits for every service to be healthy. */
export const UP_WAIT_TIMEOUT_SECONDS = 300;

export interface StackPaths {
  /** The compose files, in order. */
  composeFiles: string[];
  /** Writable project directory: holds `.env` and is the base for relative paths. */
  projectDir: string;
  /** The stack's `.env`, inside `projectDir`. */
  envFile: string;
  /** The `.env.example` copied into `envFile` on first start. */
  envTemplate: string;
}

/**
 * Where the stack lives for a packaged app: compose files under
 * `Contents/Resources/stack` (electron-builder `extraResources`), state under
 * the app's userData directory.
 */
export function bundledStackPaths(resourcesPath: string, userDataPath: string): StackPaths {
  const resources = join(resourcesPath, 'stack');
  const projectDir = join(userDataPath, 'stack');
  return {
    composeFiles: [
      join(resources, 'docker-compose.yml'),
      join(resources, 'docker-compose.tunnels.yml'),
    ],
    projectDir,
    envFile: join(projectDir, '.env'),
    envTemplate: join(resources, 'env.example'),
  };
}

export type ComposeCommand =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'ps' }
  | { kind: 'pull' }
  /** The images of the stack's services, one per line. */
  | { kind: 'images' }
  | { kind: 'logs'; tail: number; follow: boolean; services?: string[] };

export function composeBaseArgs(paths: StackPaths, project = PROJECT_NAME): string[] {
  return [
    'compose',
    '--project-name',
    project,
    '--project-directory',
    paths.projectDir,
    '--env-file',
    paths.envFile,
    ...paths.composeFiles.flatMap((file) => ['--file', file]),
  ];
}

/** Full argument list for the docker CLI. */
export function composeArgs(
  paths: StackPaths,
  command: ComposeCommand,
  project = PROJECT_NAME,
): string[] {
  const base = composeBaseArgs(paths, project);
  switch (command.kind) {
    case 'up':
      // --no-build: the bundle has no build context, only published images.
      return [
        ...base,
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        String(UP_WAIT_TIMEOUT_SECONDS),
        '--no-build',
        '--remove-orphans',
      ];
    case 'down':
      // Never --volumes: that would delete the database.
      return [...base, 'down'];
    case 'ps':
      return [...base, 'ps', '--all', '--format', 'json'];
    case 'pull':
      return [...base, 'pull'];
    case 'images':
      return [...base, 'config', '--images'];
    case 'logs': {
      const tail = Number.isInteger(command.tail) && command.tail >= 0 ? command.tail : 200;
      return [
        ...base,
        'logs',
        '--no-color',
        '--tail',
        String(tail),
        ...(command.follow ? ['--follow'] : []),
        ...(command.services ?? []),
      ];
    }
  }
}

/** A Compose project name: lower case letters, digits, dashes and underscores. */
export function isProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

/**
 * `docker container ls` for the containers of the legacy project, printing
 * each one's project directory (the working_dir label Compose sets).
 */
export function legacyContainersArgs(): string[] {
  return [
    'container',
    'ls',
    '--all',
    '--filter',
    `label=com.docker.compose.project=${LEGACY_PROJECT_NAME}`,
    '--format',
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ];
}

/** `docker network ls` for every network's id (read-only). */
export function networkListArgs(): string[] {
  return ['network', 'ls', '--quiet'];
}

/** Each network's name, then its subnets, on one line (see parseNetworks). */
export const NETWORK_FORMAT = '{{.Name}}{{range .IPAM.Config}} {{.Subnet}}{{end}}';

/** `docker network inspect` for the networks' names and subnets (read-only). */
export function networkInspectArgs(ids: string[]): string[] {
  return ['network', 'inspect', '--format', NETWORK_FORMAT, ...ids];
}

/**
 * `docker container ls` for the containers of a project, printing each one's
 * project directory and its networks, tab separated (see containersOnNetwork).
 */
export function projectNetworksArgs(project: string): string[] {
  return [
    'container',
    'ls',
    '--all',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Networks}}',
  ];
}

/** `docker image inspect` for the images: exits non-zero when any is missing locally. */
export function imageInspectArgs(images: string[]): string[] {
  return ['image', 'inspect', '--format', '{{.Id}}', ...images];
}

/** The images `compose config --images` lists, without duplicates. */
export function parseImages(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export interface ServiceState {
  service: string;
  state: string;
  health: string;
}

/**
 * Parses `compose ps --format json`: one object per line on Compose 2.21 and
 * later, a single JSON array before that.
 */
export function parseComposePs(stdout: string): ServiceState[] {
  const text = stdout.trim();
  if (text === '') return [];
  const rows: unknown[] = text.startsWith('[')
    ? (JSON.parse(text) as unknown[])
    : text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      service: String(r.Service ?? r.Name ?? ''),
      state: String(r.State ?? ''),
      health: String(r.Health ?? ''),
    };
  });
}
