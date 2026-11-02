import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_ENV_VARS } from './config.js';
import { SECRET_ENV_VARS, resolveSecretFiles, secretFromEnv } from './env-files.js';

const ENTRYPOINT = new URL('../../../docker/entrypoint.sh', import.meta.url);

describe('secret files (S-1)', () => {
  it('covers only variables the server reads', () => {
    expect(SECRET_ENV_VARS.filter((name) => !CONFIG_ENV_VARS.includes(name))).toEqual([]);
  });

  it('matches the list docker/entrypoint.sh moves into files', () => {
    const script = readFileSync(ENTRYPOINT, 'utf8');
    const line = /^SECRET_VARS="([^"]*)"$/m.exec(script)?.[1];
    expect(line?.split(/\s+/).filter(Boolean)).toEqual([...SECRET_ENV_VARS]);
  });

  it('reads one secret from NAME or NAME_FILE, ignoring the others', () => {
    expect(secretFromEnv('DATABASE_URL', { DATABASE_URL: 'postgres://a' })).toBe('postgres://a');
    expect(
      secretFromEnv('DATABASE_URL', {
        DATABASE_URL_FILE: new URL(import.meta.url).pathname,
        OPENBOTS_MASTER_KEY_FILE: '/nonexistent',
      }),
    ).toContain("describe('secret files (S-1)'");
    expect(secretFromEnv('DATABASE_URL', {})).toBeUndefined();
  });
});

// Runs docker/entrypoint.sh `start` as this (non-root) user against a fake
// `node` that records the environment it was started with.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'docker/entrypoint.sh secrets (S-1)',
  () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    function start(env: Record<string, string>, { secretsDir = true } = {}) {
      dir = mkdtempSync(path.join(tmpdir(), 'openbots-entrypoint-'));
      const bin = path.join(dir, 'bin');
      const secrets = path.join(dir, 'secrets');
      mkdirSync(bin);
      mkdirSync(path.join(dir, 'server'));
      if (secretsDir) mkdirSync(secrets, { mode: 0o755 });
      writeFileSync(
        path.join(bin, 'node'),
        '#!/bin/sh\nenv > "$OPENBOTS_TEST_OUT/$(basename "$1").env"\n',
        { mode: 0o755 },
      );
      const res = spawnSync('/bin/sh', [fileURLToPath(ENTRYPOINT), 'start'], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          OPENBOTS_SERVER_DIR: path.join(dir, 'server'),
          OPENBOTS_SECRETS_DIR: secrets,
          OPENBOTS_TEST_OUT: dir,
          ...env,
        },
      });
      expect(res.status, res.stderr).toBe(0);
      const envOf = (script: string) =>
        Object.fromEntries(
          readFileSync(path.join(dir!, `${script}.env`), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
        ) as Record<string, string>;
      return { secrets, migrate: envOf('migrate-cli.js'), main: envOf('main.js') };
    }

    it('moves each secret into a private file and hands node only its path', () => {
      const { secrets, migrate, main } = start({
        OPENBOTS_MASTER_KEY: 'the-master-key',
        DATABASE_URL: 'postgres://openbots:pw@postgres/openbots',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY_FILE: '/run/secrets/openai',
        OPENBOTS_PUBLIC_URL: 'https://bots.example.com',
      });
      for (const env of [migrate, main]) {
        expect(env.OPENBOTS_MASTER_KEY).toBeUndefined();
        expect(env.DATABASE_URL).toBeUndefined();
        expect(env.OPENBOTS_MASTER_KEY_FILE).toBe(path.join(secrets, 'OPENBOTS_MASTER_KEY'));
        expect(env.DATABASE_URL_FILE).toBe(path.join(secrets, 'DATABASE_URL'));
        // A file given already, an empty value and other settings stay as they are.
        expect(env.OPENAI_API_KEY_FILE).toBe('/run/secrets/openai');
        expect(env.ANTHROPIC_API_KEY_FILE).toBeUndefined();
        expect(env.OPENBOTS_PUBLIC_URL).toBe('https://bots.example.com');
      }
      expect(readFileSync(path.join(secrets, 'OPENBOTS_MASTER_KEY'), 'utf8')).toBe(
        'the-master-key',
      );
      expect(statSync(path.join(secrets, 'DATABASE_URL')).mode & 0o777).toBe(0o600);
      expect(statSync(secrets).mode & 0o777).toBe(0o700);
      expect(secretFromEnv('OPENBOTS_MASTER_KEY', main)).toBe('the-master-key');
    });

    it('leaves the environment alone without a secrets directory', () => {
      const { main } = start({ OPENBOTS_MASTER_KEY: 'the-master-key' }, { secretsDir: false });
      expect(main.OPENBOTS_MASTER_KEY).toBe('the-master-key');
      expect(main.OPENBOTS_MASTER_KEY_FILE).toBeUndefined();
    });

    it('leaves a secret set both ways for the server to refuse', () => {
      const { main } = start({
        DATABASE_URL: 'postgres://a',
        DATABASE_URL_FILE: '/run/secrets/db',
      });
      expect(main.DATABASE_URL).toBe('postgres://a');
      expect(main.DATABASE_URL_FILE).toBe('/run/secrets/db');
      expect(() => resolveSecretFiles(main)).toThrow(
        /set either DATABASE_URL or DATABASE_URL_FILE/,
      );
    });
  },
);
