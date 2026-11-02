import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_ICONS,
  CatalogEntrySchema,
  DEFAULT_CATALOG_INSTALL_DIR,
  catalogEntry,
  catalogLaunch,
  catalogPackage,
  loadCatalog,
  substitute,
} from './catalog.js';

describe('catalog.json', () => {
  it('ships the plan entries and the five built-in placeholders', () => {
    const ids = loadCatalog().entries.map((e) => e.id);
    expect(ids).toEqual([
      'github',
      'gmail',
      'google_docs',
      'slack',
      'cloudflare',
      'vercel',
      'supabase',
      'neon',
      'railway',
      'firecrawl',
      'filesystem',
      'postgres',
      'web_search',
      'web_fetch',
      'http_request',
      'email',
      'github_builtin',
    ]);
    const builtins = loadCatalog().entries.filter((e) => e.kind === 'builtin');
    expect(builtins.map((e) => e.builtin)).toEqual([
      'web_search',
      'web_fetch',
      'http_request',
      'email',
      'github',
    ]);
  });

  it("uses each vendor's official remote server over Streamable HTTP", () => {
    const remote = Object.fromEntries(
      loadCatalog()
        .entries.filter((e) => e.http)
        .map((e) => [e.id, [e.http!.url, e.http!.auth.join(' ')]]),
    );
    expect(remote).toEqual({
      github: ['https://api.githubcopilot.com/mcp/', 'bearer oauth'],
      gmail: ['https://gmailmcp.googleapis.com/mcp/v1', 'oauth'],
      google_docs: ['https://docsmcp.googleapis.com/mcp/v1', 'oauth'],
      slack: ['https://mcp.slack.com/mcp', 'oauth'],
      cloudflare: ['https://mcp.cloudflare.com/mcp', 'oauth bearer'],
      vercel: ['https://mcp.vercel.com', 'oauth'],
      supabase: ['https://mcp.supabase.com/mcp', 'oauth bearer'],
      neon: ['https://mcp.neon.tech/mcp', 'oauth bearer'],
      railway: ['https://mcp.railway.com', 'oauth'],
      firecrawl: ['https://mcp.firecrawl.dev/v2/mcp', 'bearer'],
    });
    for (const entry of loadCatalog().entries.filter((e) => e.http)) {
      expect(entry.version, entry.id).toBeNull();
      expect(entry.homepage, entry.id).toMatch(/^https:\/\//);
      // A token, when offered, is optional beside OAuth and required on its own.
      for (const secret of entry.secrets) {
        expect(secret.required, entry.id).toBe(!entry.http!.auth.includes('oauth'));
      }
    }
  });

  it('registers clients where the vendor allows it and asks Google for a refresh token', () => {
    const dynamic = loadCatalog()
      .entries.filter((e) => e.oauth?.dynamic_registration)
      .map((e) => e.id);
    expect(dynamic).toEqual(['cloudflare', 'vercel', 'supabase', 'neon', 'railway']);
    for (const id of ['gmail', 'google_docs']) {
      expect(catalogEntry(id)!.oauth).toMatchObject({
        dynamic_registration: false,
        client_setup_url: 'https://console.cloud.google.com/apis/credentials',
        authorization_params: { access_type: 'offline', prompt: 'consent' },
      });
    }
  });

  it('gives every entry an icon the web app ships, and refuses any other', () => {
    for (const entry of loadCatalog().entries)
      expect(CATALOG_ICONS, entry.id).toContain(entry.icon);
    const entry = { ...catalogEntry('neon')!, icon: 'https://neon.com/favicon.ico' };
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(false);
    // Firecrawl is not in Simple Icons and Slack had its mark removed: both use the lettermark.
    expect(catalogEntry('firecrawl')!.icon).toBe('lettermark');
    expect(catalogEntry('slack')!.icon).toBe('lettermark');
  });

  it('pins an exact version in every stdio command', () => {
    for (const entry of loadCatalog().entries.filter((e) => e.stdio)) {
      expect(entry.stdio!.args.join(' '), entry.id).toContain(entry.version!);
    }
    expect(catalogEntry('filesystem')!.stdio!.args).toContain(
      '@modelcontextprotocol/server-filesystem@2026.8.31',
    );
  });

  it('leaves out the fetch server, which would make unguarded requests from the server (S-3)', () => {
    expect(catalogEntry('fetch')).toBeUndefined();
  });

  it('confines the filesystem root to the owner directory and refuses private Postgres hosts (S-3)', () => {
    expect(catalogEntry('filesystem')!.params).toEqual([
      expect.objectContaining({ name: 'root', user_dir: true, required: false }),
    ]);
    expect(catalogEntry('postgres')!.secrets).toEqual([
      expect.objectContaining({ name: 'POSTGRES_URL', public_host: true }),
    ]);
  });

  it('keeps the Postgres password out of argv and in the environment (S-9)', () => {
    const entry = catalogEntry('postgres')!;
    const values = { POSTGRES_URL: 'postgresql://ro:p%40ss%2Fword@db.example.com:5432/app' };
    const args = entry.stdio!.args.map((a) => substitute(a, values));
    expect(args.join(' ')).not.toContain('p%40ss');
    expect(args).toContain('postgresql://ro@db.example.com:5432/app');
    expect(substitute(entry.stdio!.env!.PGPASSWORD!, values)).toBe('p@ss/word');
  });

  it('substitutes names and never passes an unparsable value with a password through', () => {
    expect(substitute('{{A}}-{{B}}-{{C}}', { A: 'a', B: 'b' })).toBe('a-b-');
    expect(substitute('{{U|without_password}}', { U: 'user:pw@host' })).toBe('');
    expect(substitute('{{U|password}}', { U: 'not a url' })).toBe('');
  });

  it('rejects an oauth entry without metadata', () => {
    const bad = {
      id: 'x',
      name: 'X',
      description: '',
      kind: 'mcp_http',
      icon: 'x',
      version: null,
      http: { url: 'https://x.example/mcp', auth: ['oauth'] },
      secrets: [],
    };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });
});

describe('catalogLaunch (S-20)', () => {
  const filesystem = () => catalogEntry('filesystem')!;
  const bin = '/opt/openbots/mcp/node_modules/.bin/mcp-server-filesystem';
  const install = { dir: DEFAULT_CATALOG_INSTALL_DIR, allowNpx: false };

  it('runs the pre-installed binary without the npx prefix', () => {
    const exists = (path: string) => path === bin;
    expect(catalogLaunch(filesystem(), install, exists)).toEqual({
      command: bin,
      args: ['{{root}}'],
    });
    // The binary wins even when the dev fallback is on.
    expect(catalogLaunch(filesystem(), { ...install, allowNpx: true }, exists).command).toBe(bin);
    expect(
      catalogLaunch(filesystem(), { dir: '/src/mcp', allowNpx: false }, () => true).command,
    ).toBe('/src/mcp/node_modules/.bin/mcp-server-filesystem');
  });

  it('fails with a clear error when the binary is missing', () => {
    expect(() => catalogLaunch(filesystem(), install, () => false)).toThrow(
      `Filesystem is not installed: ${bin} is missing.`,
    );
    expect(() => catalogLaunch(filesystem(), install, () => false)).toThrow(
      /OPENBOTS_MCP_NPX_FALLBACK=true/,
    );
  });

  it('falls back to npx only when the dev setting allows it', () => {
    expect(catalogLaunch(filesystem(), { ...install, allowNpx: true }, () => false)).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', '{{root}}'],
    });
  });

  it('refuses entries that are not stdio servers', () => {
    expect(() => catalogLaunch(catalogEntry('github')!, install)).toThrow(/not a stdio/);
  });
});

describe('docker/mcp-catalog', () => {
  const read = (path: string) =>
    readFileSync(new URL(`../../../docker/${path}`, import.meta.url), 'utf8');
  const stdioEntries = () => loadCatalog().entries.filter((e) => e.stdio);

  it('pins exactly the catalog stdio packages, in package.json and the lockfile', () => {
    const manifest = JSON.parse(read('mcp-catalog/package.json')) as {
      dependencies: Record<string, string>;
    };
    const lock = JSON.parse(read('mcp-catalog/package-lock.json')) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    const wanted = Object.fromEntries(
      stdioEntries().map((e) => [catalogPackage(e).replace(/@[^@]+$/, ''), e.version!]),
    );
    expect(manifest.dependencies).toEqual(wanted);
    expect(lock.packages['']!.dependencies).toEqual(wanted);
    for (const [name, version] of Object.entries(wanted)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });

  // The server image runs them on the host; the computer image in each
  // owner's computer (OPENBOTS_STDIO_RUNNER=computer), at the same path.
  it.each(['server.Dockerfile', 'computer.Dockerfile'])(
    'is installed into %s from the lockfile',
    (name) => {
      const dockerfile = read(name);
      expect(dockerfile).toContain(
        'COPY docker/mcp-catalog/package.json docker/mcp-catalog/package-lock.json ./',
      );
      expect(dockerfile).toMatch(/RUN npm ci --omit=dev --ignore-scripts/);
      expect(dockerfile).toContain(`WORKDIR ${DEFAULT_CATALOG_INSTALL_DIR}`);
      expect(dockerfile).toContain(
        `COPY --from=mcp-catalog ${DEFAULT_CATALOG_INSTALL_DIR} ${DEFAULT_CATALOG_INSTALL_DIR}`,
      );
    },
  );
});
