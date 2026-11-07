import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { DEFAULT_SANDBOX_IMAGE } from '@openbots/computer';
import { describe, expect, it } from 'vitest';
import { CONFIG_ENV_VARS, loadConfig } from './config.js';
import { generateMasterKey } from './secrets.js';

const EXAMPLE = new URL('../../../.env.example', import.meta.url);

/** Read by Docker Compose (docker/*.yml), not by the server. */
const COMPOSE_VARS = [
  'OPENBOTS_IMAGE_PREFIX',
  'OPENBOTS_VERSION',
  'OPENBOTS_HTTP_PORT',
  'OPENBOTS_SANDBOX_SUBNET',
  'OPENBOTS_SANDBOX_SERVER_IP',
  'OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY',
  'OPENBOTS_SANDBOX_EGRESS_PROXY_IP',
  'OPENBOTS_SANDBOX_EGRESS_ALLOWLIST',
  'NGROK_AUTHTOKEN',
  'NGROK_URL',
  'CLOUDFLARE_TUNNEL_TOKEN',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'POSTGRES_PASSWORD',
];

/** Read by the managed build (ee/server), not by the core server. */
const MANAGED_VARS = ['RESEND_API_KEY', 'OPENBOTS_EMAIL_FROM', 'OPENBOTS_DEV_LOG_EMAIL_LINKS'];

describe('.env.example', () => {
  const example = parseEnv(readFileSync(EXAMPLE, 'utf8'));

  it('lists every variable the server reads', () => {
    const missing = CONFIG_ENV_VARS.filter((name) => !(name in example));
    expect(missing).toEqual([]);
  });

  it('lists nothing that neither the server nor compose reads', () => {
    const known = new Set([...CONFIG_ENV_VARS, ...COMPOSE_VARS, ...MANAGED_VARS]);
    expect(Object.keys(example).filter((name) => !known.has(name))).toEqual([]);
  });

  it('leaves the database password for install.sh to generate (S-3)', () => {
    expect(example.POSTGRES_PASSWORD).toBe('');
    expect(example.DATABASE_URL).toContain(':change-me@');
    const install = readFileSync(new URL('../../../install.sh', import.meta.url), 'utf8');
    expect(install).toContain('POSTGRES_PASSWORD');
    expect(install).toContain('openbots:change-me@postgres:5432');
  });

  it('is set up by the self-hosting reference the way install.sh sets it up (D1)', () => {
    const install = readFileSync(new URL('../../../install.sh', import.meta.url), 'utf8');
    const reference = readFileSync(
      new URL('../../../docs/SELF_HOSTING.md', import.meta.url),
      'utf8',
    );
    const steps = /By hand, the same steps:\n\n```sh\n([\s\S]*?)```\n\n([\s\S]*?)```sh\n/.exec(
      reference,
    );
    expect(steps).not.toBeNull();
    const [, commands, prose] = steps!;
    // The same clone, into the directory install.sh uses.
    const repo =
      /REPO_URL="\$\{OPENBOTS_REPO:-https:\/\/github.com\/\$GITHUB_OWNER\/(\w+)\.git\}"/.exec(
        install,
      )![1];
    const dir = /DIR="\$\{OPENBOTS_DIR:-(\w+)\}"/.exec(install)![1];
    expect(commands).toContain(
      `git clone https://github.com/danielpang/${repo}.git ${dir}\ncd ${dir}\n`,
    );
    expect(commands).toContain('(umask 077 && cp .env.example .env)');
    // The same generators for the master key and the database password.
    expect(install).toContain('openssl rand -base64 32');
    expect(commands).toContain('openssl rand -base64 32');
    expect(install).toContain('openssl rand -hex 24');
    expect(commands).toContain('openssl rand -hex 24');
    expect(install).toContain('OPENBOTS_DB_APP_PASSWORD');
    for (const name of [
      'OPENBOTS_MASTER_KEY',
      'POSTGRES_PASSWORD',
      'DATABASE_URL',
      'change-me',
      'OPENBOTS_DB_APP_PASSWORD',
    ]) {
      expect(prose).toContain(name);
    }
  });

  it('pulls images from one prefix, the release workflow namespace by default', () => {
    const prefix = example.OPENBOTS_IMAGE_PREFIX!;
    expect(prefix).toBe('ghcr.io/danielpang/openbots');
    expect(DEFAULT_SANDBOX_IMAGE).toBe(`${prefix}/computer:latest`);
    const compose = readFileSync(
      new URL('../../../docker/docker-compose.yml', import.meta.url),
      'utf8',
    );
    const images = [...compose.matchAll(/\$\{OPENBOTS_IMAGE_PREFIX:-([^}]+)\}\/([\w-]+)/g)];
    expect(images.map(([, fallback, name]) => `${fallback}/${name}`).sort()).toEqual([
      `${prefix}/computer`,
      `${prefix}/computer`,
      `${prefix}/sandbox-firewall`,
      `${prefix}/server`,
      `${prefix}/server`,
    ]);
    expect(compose).not.toMatch(/ghcr\.io\/openbots\//);
  });

  it('parses once a master key is filled in', () => {
    const config = loadConfig({ ...example, OPENBOTS_MASTER_KEY: generateMasterKey() });
    expect(config).toMatchObject({
      publicUrl: 'http://localhost:3000',
      databaseUrl: 'postgres://openbots:change-me@postgres:5432/openbots',
      redisUrl: 'redis://redis:6379',
      dockerHost: 'tcp://docker-guard:2375',
      filesDir: '/data/files',
      mcpCatalog: { dir: '/opt/openbots/mcp', allowNpx: false },
      role: 'all',
    });
  });
});
