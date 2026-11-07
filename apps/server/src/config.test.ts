import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, DEFAULT_PROCESS_LIMITS } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { generateMasterKey } from './secrets.js';

const base = {
  OPENBOTS_MASTER_KEY: generateMasterKey(),
  DATABASE_URL: 'postgres://openbots:openbots@localhost:5432/openbots',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      publicUrl: 'http://localhost:3000',
      databaseUrl: base.DATABASE_URL,
      sandboxImage: 'ghcr.io/danielpang/openbots/computer:latest',
      deployment: 'self_hosted',
      githubConnectorClientId: 'Iv23liyL74CRKUWIUXhq',
      githubConnectorAppSlug: 'openbots-github',
      signupMode: 'first_user_admin',
      filesDir: '/data/files',
      mcpCatalog: { dir: '/opt/openbots/mcp', allowNpx: false },
      role: 'all',
      limits: DEFAULT_LIMITS,
      processLimits: DEFAULT_PROCESS_LIMITS,
    });
    expect(config.redisUrl).toBeUndefined();
    expect(config.dockerHost).toBeUndefined();
    expect(config.sandboxProxy).toBeUndefined();
    expect(config.timezone).toBe('UTC');
    expect(config.sandboxNetwork).toEqual({ name: 'openbots-sbx', bridge: 'openbots-sbx' });
  });

  it('takes the Mac app local token on a self-hosted install only', () => {
    const token = 'k'.repeat(43);
    expect(loadConfig(base).localToken).toBeUndefined();
    expect(loadConfig({ ...base, OPENBOTS_LOCAL_TOKEN: '' }).localToken).toBeUndefined();
    expect(loadConfig({ ...base, OPENBOTS_LOCAL_TOKEN: token }).localToken).toBe(token);
    expect(() =>
      loadConfig({ ...base, OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_LOCAL_TOKEN: token }),
    ).toThrow(/OPENBOTS_LOCAL_TOKEN: only a self-hosted install/);
    expect(() => loadConfig({ ...base, OPENBOTS_LOCAL_TOKEN: 'short' })).toThrow(
      /OPENBOTS_LOCAL_TOKEN: must be 32 characters or more/,
    );
  });

  it('takes a ws or wss relay URL, and none when empty', () => {
    expect(loadConfig(base).relayUrl).toBeUndefined();
    expect(loadConfig({ ...base, OPENBOTS_RELAY_URL: '' }).relayUrl).toBeUndefined();
    expect(loadConfig({ ...base, OPENBOTS_RELAY_URL: 'wss://relay.example.com/' }).relayUrl).toBe(
      'wss://relay.example.com',
    );
    expect(loadConfig({ ...base, OPENBOTS_RELAY_URL: 'ws://127.0.0.1:8787' }).relayUrl).toBe(
      'ws://127.0.0.1:8787',
    );
    expect(() => loadConfig({ ...base, OPENBOTS_RELAY_URL: 'https://relay.example.com' })).toThrow(
      /OPENBOTS_RELAY_URL/,
    );
  });

  it('runs stdio connectors on the host when self-hosted and in the computer on managed', () => {
    const managed = { ...base, OPENBOTS_DEPLOYMENT: 'managed' };
    expect(loadConfig(base).stdioRunner).toBe('host');
    expect(loadConfig({ ...base, OPENBOTS_STDIO_RUNNER: '' }).stdioRunner).toBe('host');
    expect(loadConfig({ ...base, OPENBOTS_STDIO_RUNNER: 'computer' }).stdioRunner).toBe('computer');
    expect(loadConfig(managed).stdioRunner).toBe('computer');
    expect(loadConfig({ ...managed, OPENBOTS_STDIO_RUNNER: 'computer' }).stdioRunner).toBe(
      'computer',
    );
    expect(() => loadConfig({ ...base, OPENBOTS_STDIO_RUNNER: 'container' })).toThrow(
      /OPENBOTS_STDIO_RUNNER/,
    );
  });

  it('refuses the managed service in the standalone image (V6)', () => {
    const standalone = { ...base, OPENBOTS_STANDALONE: '1' };
    expect(() => loadConfig({ ...standalone, OPENBOTS_DEPLOYMENT: 'managed' })).toThrow(
      /OPENBOTS_DEPLOYMENT: the standalone image is a single-person install/,
    );
    expect(loadConfig(standalone).deployment).toBe('self_hosted');
    expect(loadConfig({ ...standalone, OPENBOTS_DEPLOYMENT: 'self_hosted' }).deployment).toBe(
      'self_hosted',
    );
    expect(
      loadConfig({ ...base, OPENBOTS_STANDALONE: '', OPENBOTS_DEPLOYMENT: 'managed' }).deployment,
    ).toBe('managed');
  });

  it('refuses host stdio on managed unless the operator opts in', () => {
    const managed = { ...base, OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_STDIO_RUNNER: 'host' };
    expect(() => loadConfig(managed)).toThrow(
      /OPENBOTS_STDIO_RUNNER: host would run every organization's stdio connectors on this one server/,
    );
    expect(() => loadConfig({ ...managed, OPENBOTS_ALLOW_HOST_STDIO: 'false' })).toThrow(
      /OPENBOTS_ALLOW_HOST_STDIO=1/,
    );
    expect(loadConfig({ ...managed, OPENBOTS_ALLOW_HOST_STDIO: '1' }).stdioRunner).toBe('host');
    expect(loadConfig({ ...managed, OPENBOTS_ALLOW_HOST_STDIO: 'true' }).stdioRunner).toBe('host');
    // Self-hosted needs no opt-in: it is one owner's server.
    expect(loadConfig({ ...base, OPENBOTS_STDIO_RUNNER: 'host' }).stdioRunner).toBe('host');
  });

  it('reads the sandbox network and its bridge, the bridge named like the network by default', () => {
    expect(
      loadConfig({ ...base, OPENBOTS_SANDBOX_NETWORK: 'openbots-dev' }).sandboxNetwork,
    ).toEqual({
      name: 'openbots-dev',
      bridge: 'openbots-dev',
    });
    expect(
      loadConfig({
        ...base,
        OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox-254',
        OPENBOTS_SANDBOX_BRIDGE: 'openbots-a-254',
      }).sandboxNetwork,
    ).toEqual({ name: 'openbots-app-sandbox-254', bridge: 'openbots-a-254' });
    expect(
      loadConfig({ ...base, OPENBOTS_SANDBOX_NETWORK: '', OPENBOTS_SANDBOX_BRIDGE: '' })
        .sandboxNetwork,
    ).toEqual({ name: 'openbots-sbx', bridge: 'openbots-sbx' });
  });

  it('refuses a sandbox network the bridge or the firewall cannot take', () => {
    // Longer than a Linux interface name, with no bridge name of its own.
    expect(() => loadConfig({ ...base, OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox' })).toThrow(
      /invalid configuration:\n {2}OPENBOTS_SANDBOX_BRIDGE: needed/,
    );
    for (const bridge of ['openbots-sandbox-2', 'Openbots', 'openbots+']) {
      expect(() => loadConfig({ ...base, OPENBOTS_SANDBOX_BRIDGE: bridge })).toThrow(
        /OPENBOTS_SANDBOX_BRIDGE/,
      );
    }
    expect(() => loadConfig({ ...base, OPENBOTS_SANDBOX_NETWORK: 'no spaces' })).toThrow(
      /OPENBOTS_SANDBOX_NETWORK/,
    );
  });

  it('treats empty values as unset', () => {
    const config = loadConfig({
      ...base,
      REDIS_URL: '',
      ANTHROPIC_API_KEY: '',
      OPENBOTS_ROLE: '',
      OLLAMA_BASE_URL: '',
    });
    expect(config.redisUrl).toBeUndefined();
    expect(config.providerKeys.anthropic).toBeUndefined();
    expect(config.role).toBe('all');
  });

  it('reads every documented variable', () => {
    const config = loadConfig({
      ...base,
      OPENBOTS_PUBLIC_URL: 'https://bots.example.com',
      REDIS_URL: 'redis://redis:6379',
      DOCKER_HOST: 'tcp://docker-socket-proxy:2375',
      OPENBOTS_SANDBOX_IMAGE: 'computer:dev',
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'invite',
      OPENBOTS_FILES_DIR: '/tmp/files',
      OPENBOTS_MCP_DIR: '/src/docker/mcp-catalog',
      OPENBOTS_MCP_NPX_FALLBACK: 'true',
      OPENBOTS_ROLE: 'worker',
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'o',
      XAI_API_KEY: 'x',
      GOOGLE_GENERATIVE_AI_API_KEY: 'g',
      OLLAMA_BASE_URL: 'http://ollama:11434',
      OPENBOTS_LIMITS_BOTS_PER_ACCOUNT: '10',
      OPENBOTS_LIMITS_BOTS_PER_GROUP: '4',
      OPENBOTS_LIMITS_WEBHOOK_IP_RATE_PER_MIN: '1200',
      OPENBOTS_LIMITS_WEBHOOK_FAILED_AUTH_PER_MIN: '5',
      OPENBOTS_LIMITS_WEBHOOK_ENDPOINT_RATE_PER_MIN: '120',
      OPENBOTS_APPROVAL_TTL_MINUTES: '120',
      OPENBOTS_MCP_IDLE_STOP_MINUTES: '30',
      OPENBOTS_WEB_FETCH_MAX_CHARS: '8000',
      OPENBOTS_WEB_FETCH_TIMEOUT_SECONDS: '10',
    });
    expect(config).toMatchObject({
      publicUrl: 'https://bots.example.com',
      redisUrl: 'redis://redis:6379',
      dockerHost: 'tcp://docker-socket-proxy:2375',
      sandboxImage: 'computer:dev',
      deployment: 'managed',
      signupMode: 'invite',
      filesDir: '/tmp/files',
      mcpCatalog: { dir: '/src/docker/mcp-catalog', allowNpx: true },
      role: 'worker',
      providerKeys: {
        anthropic: 'a',
        openai: 'o',
        xai: 'x',
        google: 'g',
        ollamaBaseUrl: 'http://ollama:11434',
      },
    });
    expect(config.limits).toEqual({
      ...DEFAULT_LIMITS,
      botsPerAccount: 10,
      botsPerGroup: 4,
      webhookIpRatePerMin: 1200,
      webhookFailedAuthPerMin: 5,
      webhookEndpointRatePerMin: 120,
    });
    expect(config.processLimits).toEqual({
      approvalTtlMinutes: 120,
      mcpIdleStopMinutes: 30,
      webFetchMaxChars: 8000,
      webFetchTimeoutSeconds: 10,
    });
  });

  it('configures the GitHub App with public identifiers, independently of sign-in', () => {
    const config = loadConfig({
      ...base,
      OPENBOTS_GITHUB_CLIENT_ID: 'shared-public-id',
      OPENBOTS_GITHUB_APP_SLUG: 'openbots-test',
    });
    expect(config.githubConnectorClientId).toBe('shared-public-id');
    expect(config.githubConnectorAppSlug).toBe('openbots-test');
    expect(() => loadConfig({ ...base, OPENBOTS_GITHUB_APP_SLUG: '../bad-app' })).toThrow(
      /OPENBOTS_GITHUB_APP_SLUG/,
    );
    expect(config.oauth.github).toBeUndefined();
  });

  it('uses the shared GitHub App in Mac local mode and does not inherit its slug for a custom client', () => {
    const local = loadConfig({ ...base, OPENBOTS_LOCAL_TOKEN: 'k'.repeat(43) });
    expect(local.githubConnectorClientId).toBe('Iv23liyL74CRKUWIUXhq');
    expect(local.githubConnectorAppSlug).toBe('openbots-github');
    const custom = loadConfig({ ...base, OPENBOTS_GITHUB_CLIENT_ID: 'own-app-id' });
    expect(custom.githubConnectorClientId).toBe('own-app-id');
    expect(custom.githubConnectorAppSlug).toBeUndefined();
  });

  it('enables an OAuth provider only when both its id and secret are set', () => {
    const config = loadConfig({
      ...base,
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: '',
    });
    expect(config.oauth.github).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
    expect(config.oauth.google).toBeUndefined();
  });

  describe("the managed service's shared GitHub App (I17)", () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA',
      '-----END RSA PRIVATE KEY-----',
    ];
    const app = {
      GITHUB_APP_ID: '123456',
      GITHUB_APP_SLUG: 'openbots',
      // As it sits on one line in .env.
      GITHUB_APP_PRIVATE_KEY: pem.join('\\n'),
      GITHUB_APP_WEBHOOK_SECRET: 'whsec-0123456789abcdef',
    };

    it('is unset by default, and when every variable is empty', () => {
      expect(loadConfig(base).githubApp).toBeUndefined();
      const empty = Object.fromEntries(Object.keys(app).map((name) => [name, '']));
      expect(loadConfig({ ...base, ...empty }).githubApp).toBeUndefined();
    });

    it('reads the App, turning the escaped line breaks back into a PEM', () => {
      expect(loadConfig({ ...base, ...app }).githubApp).toEqual({
        appId: '123456',
        slug: 'openbots',
        privateKey: pem.join('\n'),
        webhookSecret: 'whsec-0123456789abcdef',
      });
      const withOAuth = loadConfig({
        ...base,
        ...app,
        GITHUB_APP_PRIVATE_KEY: `${pem.join('\n')}\n`,
        GITHUB_APP_CLIENT_ID: 'Iv1.abc',
        GITHUB_APP_CLIENT_SECRET: 'app-secret',
      });
      expect(withOAuth.githubApp).toMatchObject({
        privateKey: pem.join('\n'),
        clientId: 'Iv1.abc',
        clientSecret: 'app-secret',
      });
    });

    it('refuses half an App, or half its OAuth client', () => {
      expect(() => loadConfig({ ...base, GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'x' })).toThrow(
        /GITHUB_APP_PRIVATE_KEY: needed[\s\S]*GITHUB_APP_WEBHOOK_SECRET: needed/,
      );
      expect(() => loadConfig({ ...base, ...app, GITHUB_APP_CLIENT_ID: 'Iv1.abc' })).toThrow(
        /GITHUB_APP_CLIENT_SECRET: set both/,
      );
      expect(() => loadConfig({ ...base, GITHUB_APP_CLIENT_SECRET: 's' })).toThrow(
        /GITHUB_APP_CLIENT_ID: set only with/,
      );
      expect(() => loadConfig({ ...base, ...app, GITHUB_APP_PRIVATE_KEY: 'not a key' })).toThrow(
        /GITHUB_APP_PRIVATE_KEY: must be the PEM private key/,
      );
      expect(() => loadConfig({ ...base, ...app, GITHUB_APP_ID: 'openbots' })).toThrow(
        /GITHUB_APP_ID: must be the App ID/,
      );
    });

    it('reads its secrets from NAME_FILE, and warns of those in the plain environment (S-1)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'openbots-config-'));
      const keyFile = join(dir, 'github_app_key');
      writeFileSync(keyFile, `${pem.join('\n')}\n`, { mode: 0o600 });
      const config = loadConfig({
        ...base,
        ...app,
        GITHUB_APP_PRIVATE_KEY: undefined,
        GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
      });
      expect(config.githubApp?.privateKey).toBe(pem.join('\n'));
      expect(config.secretsFromEnvironment).toContain('GITHUB_APP_WEBHOOK_SECRET');
      expect(config.secretsFromEnvironment).not.toContain('GITHUB_APP_PRIVATE_KEY');
    });
  });

  it('rejects missing or invalid values with every problem listed', () => {
    expect(() => loadConfig({})).toThrow(
      /OPENBOTS_MASTER_KEY[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*OPENBOTS_MASTER_KEY/,
    );
    expect(() => loadConfig({ ...base, OPENBOTS_MASTER_KEY: 'short' })).toThrow(/keygen/);
    expect(() => loadConfig({ ...base, OPENBOTS_ROLE: 'scheduler' })).toThrow(/OPENBOTS_ROLE/);
    expect(() => loadConfig({ ...base, OPENBOTS_DEPLOYMENT: 'cloud' })).toThrow(
      /OPENBOTS_DEPLOYMENT/,
    );
    expect(() => loadConfig({ ...base, OPENBOTS_SIGNUP_MODE: 'anyone' })).toThrow(
      /OPENBOTS_SIGNUP_MODE/,
    );
    expect(() => loadConfig({ ...base, OPENBOTS_LIMITS_BOTS_PER_GROUP: '0' })).toThrow(
      /OPENBOTS_LIMITS_BOTS_PER_GROUP/,
    );
    for (const [name, value] of [
      ['OPENBOTS_APPROVAL_TTL_MINUTES', '0'],
      ['OPENBOTS_MCP_IDLE_STOP_MINUTES', '-1'],
      ['OPENBOTS_WEB_FETCH_MAX_CHARS', '1.5'],
      ['OPENBOTS_WEB_FETCH_TIMEOUT_SECONDS', 'soon'],
    ]) {
      expect(() => loadConfig({ ...base, [name!]: value })).toThrow(new RegExp(name!));
    }
    expect(() => loadConfig({ ...base, OPENBOTS_PUBLIC_URL: 'not a url' })).toThrow(
      /OPENBOTS_PUBLIC_URL/,
    );
    for (const value of ['proxy', '10.0.0.0/33', '10.0.0.0/8/1', 'fd00::/129']) {
      expect(() => loadConfig({ ...base, TRUSTED_PROXIES: value })).toThrow(/TRUSTED_PROXIES/);
    }
  });

  it("reads the computers' egress proxy, which needs its port for the sandbox firewall (plan 9.5)", () => {
    expect(
      loadConfig({ ...base, OPENBOTS_SANDBOX_EGRESS_PROXY: 'http://172.30.255.3:8888' })
        .sandboxProxy,
    ).toEqual({ url: 'http://172.30.255.3:8888', noProxy: undefined });
    expect(
      loadConfig({
        ...base,
        OPENBOTS_SANDBOX_EGRESS_PROXY: 'https://bot:secret@proxy.example.com:3128/',
        OPENBOTS_SANDBOX_NO_PROXY: 'localhost,.example.com',
      }).sandboxProxy,
    ).toEqual({
      url: 'https://bot:secret@proxy.example.com:3128/',
      noProxy: 'localhost,.example.com',
    });
    // NO_PROXY alone sets no proxy.
    expect(loadConfig({ ...base, OPENBOTS_SANDBOX_NO_PROXY: 'localhost' }).sandboxProxy).toBe(
      undefined,
    );
    for (const value of [
      'http://172.30.255.3',
      'socks5://172.30.255.3:1080',
      'http://172.30.255.3:8888/path',
      '172.30.255.3:8888',
    ]) {
      expect(() => loadConfig({ ...base, OPENBOTS_SANDBOX_EGRESS_PROXY: value })).toThrow(
        /OPENBOTS_SANDBOX_EGRESS_PROXY/,
      );
    }
  });

  it("reads the computers' timezone as an IANA name", () => {
    expect(loadConfig({ ...base, OPENBOTS_TIMEZONE: 'Europe/London' }).timezone).toBe(
      'Europe/London',
    );
    expect(loadConfig({ ...base, OPENBOTS_TIMEZONE: '' }).timezone).toBe('UTC');
    for (const value of ['Mars/Olympus_Mons', 'GMT+25', 'not a zone']) {
      expect(() => loadConfig({ ...base, OPENBOTS_TIMEZONE: value })).toThrow(/OPENBOTS_TIMEZONE/);
    }
  });

  it('reads TRUSTED_PROXIES as a list of addresses and ranges, empty by default', () => {
    expect(loadConfig(base).trustedProxies).toEqual([]);
    expect(
      loadConfig({ ...base, TRUSTED_PROXIES: ' 172.16.0.0/12, 127.0.0.1,fd00::/8 ' })
        .trustedProxies,
    ).toEqual(['172.16.0.0/12', '127.0.0.1', 'fd00::/8']);
  });

  it('reads OPENBOTS_MASTER_KEY_PREVIOUS as a list of keys being rotated out (plan 4.9)', () => {
    expect(loadConfig(base).previousMasterKeys).toEqual([]);
    const [a, b] = [generateMasterKey(), generateMasterKey()];
    expect(
      loadConfig({ ...base, OPENBOTS_MASTER_KEY_PREVIOUS: ` ${a}, ${b} ` }).previousMasterKeys,
    ).toEqual([a, b]);
    expect(() => loadConfig({ ...base, OPENBOTS_MASTER_KEY_PREVIOUS: `${a},short` })).toThrow(
      /OPENBOTS_MASTER_KEY_PREVIOUS: must be comma-separated master keys/,
    );
    expect(() =>
      loadConfig({ ...base, OPENBOTS_MASTER_KEY_PREVIOUS: `${a},${base.OPENBOTS_MASTER_KEY}` }),
    ).toThrow(/OPENBOTS_MASTER_KEY_PREVIOUS: holds OPENBOTS_MASTER_KEY itself/);
  });

  it('reads secrets from NAME_FILE, and lists those given in the plain environment (S-1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openbots-config-'));
    const file = (name: string, value: string) => {
      writeFileSync(join(dir, name), value, { mode: 0o600 });
      return join(dir, name);
    };
    const key = generateMasterKey();
    const previous = generateMasterKey();
    const config = loadConfig({
      OPENBOTS_MASTER_KEY_FILE: file('master_key', `${key}\n`),
      OPENBOTS_MASTER_KEY_PREVIOUS_FILE: file('previous', previous),
      DATABASE_URL_FILE: file('database_url', 'postgres://openbots:pw@postgres:5432/openbots\n'),
      ANTHROPIC_API_KEY_FILE: file('anthropic', 'sk-ant\n'),
      OPENAI_API_KEY: 'sk-openai',
    });
    expect(config).toMatchObject({
      masterKey: key,
      previousMasterKeys: [previous],
      databaseUrl: 'postgres://openbots:pw@postgres:5432/openbots',
      providerKeys: { anthropic: 'sk-ant', openai: 'sk-openai' },
      secretsFromEnvironment: ['OPENAI_API_KEY'],
    });
    expect(loadConfig(base).secretsFromEnvironment).toEqual([
      'OPENBOTS_MASTER_KEY',
      'DATABASE_URL',
    ]);

    expect(() =>
      loadConfig({ ...base, OPENBOTS_MASTER_KEY_FILE: file('again', generateMasterKey()) }),
    ).toThrow(/OPENBOTS_MASTER_KEY: set either OPENBOTS_MASTER_KEY or OPENBOTS_MASTER_KEY_FILE/);
    expect(() =>
      loadConfig({
        ...base,
        OPENBOTS_MASTER_KEY: '',
        OPENBOTS_MASTER_KEY_FILE: join(dir, 'missing'),
      }),
    ).toThrow(/OPENBOTS_MASTER_KEY_FILE: cannot read .*missing \(ENOENT\)/);
  });
});
