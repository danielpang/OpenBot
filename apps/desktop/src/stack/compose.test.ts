import { describe, expect, it } from 'vitest';
import {
  bundledStackPaths,
  composeArgs,
  imageInspectArgs,
  isProjectName,
  LEGACY_PROJECT_NAME,
  parseComposePs,
  parseImages,
  PROJECT_NAME,
  type StackPaths,
} from './compose.js';

const paths: StackPaths = bundledStackPaths(
  '/Applications/OpenBots.app/Contents/Resources',
  '/Users/ada/Library/Application Support/OpenBots',
);

const BASE = [
  'compose',
  '--project-name',
  'openbots-app',
  '--project-directory',
  '/Users/ada/Library/Application Support/OpenBots/stack',
  '--env-file',
  '/Users/ada/Library/Application Support/OpenBots/stack/.env',
  '--file',
  '/Applications/OpenBots.app/Contents/Resources/stack/docker-compose.yml',
  '--file',
  '/Applications/OpenBots.app/Contents/Resources/stack/docker-compose.tunnels.yml',
];

describe('bundledStackPaths', () => {
  it('reads compose files from the bundle and keeps state in userData', () => {
    expect(paths).toEqual({
      composeFiles: [
        '/Applications/OpenBots.app/Contents/Resources/stack/docker-compose.yml',
        '/Applications/OpenBots.app/Contents/Resources/stack/docker-compose.tunnels.yml',
      ],
      projectDir: '/Users/ada/Library/Application Support/OpenBots/stack',
      envFile: '/Users/ada/Library/Application Support/OpenBots/stack/.env',
      envTemplate: '/Applications/OpenBots.app/Contents/Resources/stack/env.example',
    });
  });
});

describe('composeArgs', () => {
  it('starts detached, waits for health, never builds', () => {
    expect(composeArgs(paths, { kind: 'up' })).toEqual([
      ...BASE,
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '300',
      '--no-build',
      '--remove-orphans',
    ]);
  });

  it('stops without removing volumes', () => {
    const args = composeArgs(paths, { kind: 'down' });
    expect(args).toEqual([...BASE, 'down']);
    expect(args).not.toContain('--volumes');
    expect(args).not.toContain('-v');
  });

  it('lists services as JSON and pulls images', () => {
    expect(composeArgs(paths, { kind: 'ps' })).toEqual([
      ...BASE,
      'ps',
      '--all',
      '--format',
      'json',
    ]);
    expect(composeArgs(paths, { kind: 'pull' })).toEqual([...BASE, 'pull']);
  });

  it('follows logs with a tail and optional services', () => {
    expect(
      composeArgs(paths, { kind: 'logs', tail: 50, follow: true, services: ['openbots'] }),
    ).toEqual([...BASE, 'logs', '--no-color', '--tail', '50', '--follow', 'openbots']);
    expect(composeArgs(paths, { kind: 'logs', tail: -3, follow: false })).toEqual([
      ...BASE,
      'logs',
      '--no-color',
      '--tail',
      '200',
    ]);
  });

  it('passes paths with spaces as single arguments', () => {
    const args = composeArgs(paths, { kind: 'up' });
    expect(args[4]).toBe('/Users/ada/Library/Application Support/OpenBots/stack');
  });
});

describe('the project name', () => {
  it("is the app's own, apart from a source checkout's openbots, unless an older install keeps it", () => {
    expect(PROJECT_NAME).toBe('openbots-app');
    expect(LEGACY_PROJECT_NAME).toBe('openbots');
    expect(composeArgs(paths, { kind: 'ps' }, 'openbots').slice(0, 3)).toEqual([
      'compose',
      '--project-name',
      'openbots',
    ]);
    expect(isProjectName('openbots-app')).toBe(true);
    expect(isProjectName('Bad Name')).toBe(false);
    expect(isProjectName('')).toBe(false);
  });

  it('lists the images the stack runs, and inspects them in one call', () => {
    expect(composeArgs(paths, { kind: 'images' })).toEqual([...BASE, 'config', '--images']);
    expect(parseImages('a:1\nb:2\n\na:1\n')).toEqual(['a:1', 'b:2']);
    expect(imageInspectArgs(['a:1'])).toEqual(['image', 'inspect', '--format', '{{.Id}}', 'a:1']);
  });
});

describe('parseComposePs', () => {
  it('reads one JSON object per line (Compose 2.21+)', () => {
    const stdout = [
      JSON.stringify({ Service: 'openbots', State: 'running', Health: 'healthy' }),
      JSON.stringify({ Service: 'postgres', State: 'running', Health: '' }),
    ].join('\n');
    expect(parseComposePs(stdout)).toEqual([
      { service: 'openbots', state: 'running', health: 'healthy' },
      { service: 'postgres', state: 'running', health: '' },
    ]);
  });

  it('reads a JSON array (older Compose) and empty output', () => {
    expect(parseComposePs('[{"Service":"redis","State":"exited","Health":""}]')).toEqual([
      { service: 'redis', state: 'exited', health: '' },
    ]);
    expect(parseComposePs('\n')).toEqual([]);
  });
});
