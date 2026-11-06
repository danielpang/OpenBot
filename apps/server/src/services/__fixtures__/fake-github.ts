import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A fake GitHub REST API for tests (I17): the manifest conversion,
// installation tokens (the App's JWT is verified against the key pair made
// here), installations, repository listings in pages, `GET /user` and
// pull requests. It records every request, with the body it was sent.

export interface FakeRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  pushed_at: string | null;
}

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface MintedToken {
  token: string;
  installationId: string;
  repositories?: string[];
  permissions: Record<string, string>;
}

export interface FakeGithub {
  url: string;
  appId: string;
  privateKey: string;
  publicKey: string;
  requests: FakeRequest[];
  minted: MintedToken[];
  installations: Map<string, { login: string; type: 'User' | 'Organization'; repos: FakeRepo[] }>;
  /** Pasted tokens GitHub knows, with their user and repositories. */
  users: Map<string, { login: string; repos: FakeRepo[] }>;
  /** Manifest codes and the App each converts to. */
  manifests: Map<string, Record<string, unknown>>;
  /** OAuth codes (the install's user authorization) and the user token each exchanges for. */
  codes: Map<string, string>;
  /** User tokens and the installation ids `GET /user/installations` lists for each. */
  userInstallations: Map<string, string[]>;
  /**
   * `${userToken}:${installationId}` and what `GET /user/installations/{id}/repositories`
   * lists for it; without an entry, every repository of the installation, with push.
   */
  userRepos: Map<string, { full_name: string; push: boolean; admin?: boolean }[]>;
  /** User tokens revoked through `DELETE /applications/{client_id}/token`. */
  revoked: string[];
  close(): Promise<void>;
}

export const fakeRepo = (fullName: string, id: number, over: Partial<FakeRepo> = {}): FakeRepo => ({
  id,
  full_name: fullName,
  private: true,
  default_branch: 'main',
  description: null,
  pushed_at: '2026-10-01T12:00:00Z',
  ...over,
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Checks an App JWT: RS256 under the fake's key, for its App id, not expired. */
export function jwtValid(jwt: string, publicKey: string, appId: string): boolean {
  const [head, body, signature] = jwt.split('.');
  if (!head || !body || !signature) return false;
  const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: string };
  if (header.alg !== 'RS256') return false;
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${head}.${body}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
    iss?: string;
    exp?: number;
  };
  return ok && claims.iss === appId && (claims.exp ?? 0) > Math.floor(Date.now() / 1000);
}

export async function startFakeGithub(appId = '4242'): Promise<FakeGithub> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const requests: FakeRequest[] = [];
  const minted: MintedToken[] = [];
  const installations: FakeGithub['installations'] = new Map();
  const users: FakeGithub['users'] = new Map();
  const manifests: FakeGithub['manifests'] = new Map();
  const codes: FakeGithub['codes'] = new Map();
  const userInstallations: FakeGithub['userInstallations'] = new Map();
  const userRepos: FakeGithub['userRepos'] = new Map();
  const revoked: string[] = [];
  let serial = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const body = await readBody(req);
      const authorization = req.headers.authorization;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, authorization, body });
      const bearer = authorization?.replace(/^Bearer /, '') ?? '';
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const page = <T>(items: T[]) => {
        const per = Number(url.searchParams.get('per_page') ?? 30);
        const n = Number(url.searchParams.get('page') ?? 1);
        return items.slice((n - 1) * per, n * per);
      };
      const tokenOf = (token: string) => minted.find((m) => m.token === token);
      let m: RegExpMatchArray | null;

      if (
        req.method === 'POST' &&
        (m = url.pathname.match(/^\/app-manifests\/([^/]+)\/conversions$/))
      ) {
        const made = manifests.get(decodeURIComponent(m[1]!));
        return made ? send(201, made) : send(404, { message: 'Not Found' });
      }
      if ((m = url.pathname.match(/^\/app\/installations\/(\d+)(\/access_tokens)?$/))) {
        if (!jwtValid(bearer, publicKey, appId)) return send(401, { message: 'Bad JWT' });
        const installation = installations.get(m[1]!);
        if (!installation) return send(404, { message: 'Not Found' });
        if (!m[2] && req.method === 'GET') {
          return send(200, {
            id: Number(m[1]),
            account: { login: installation.login, type: installation.type },
          });
        }
        if (m[2] && req.method === 'POST') {
          const ask = (body ?? {}) as {
            repositories?: string[];
            permissions?: Record<string, string>;
          };
          const token: MintedToken = {
            token: `ghs_fake_${++serial}`,
            installationId: m[1]!,
            ...(ask.repositories ? { repositories: ask.repositories } : {}),
            permissions: ask.permissions ?? {},
          };
          minted.push(token);
          return send(201, {
            token: token.token,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { ...token.permissions, metadata: 'read' },
            ...(ask.repositories
              ? {
                  repositories: ask.repositories.map((name) => ({
                    full_name: `${installation.login}/${name}`,
                  })),
                }
              : {}),
          });
        }
      }
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const ask = (body ?? {}) as { client_id?: string; client_secret?: string; code?: string };
        const token = ask.code ? codes.get(ask.code) : undefined;
        if (!ask.client_id || !ask.client_secret || !token) {
          return send(200, { error: 'bad_verification_code' });
        }
        return send(200, { access_token: token, token_type: 'bearer' });
      }
      if (req.method === 'GET' && url.pathname === '/user/installations') {
        const ids = userInstallations.get(bearer);
        if (!ids) return send(401, { message: 'Bad credentials' });
        return send(200, {
          total_count: ids.length,
          installations: page(ids.map((id) => ({ id: Number(id) }))),
        });
      }
      if (
        req.method === 'GET' &&
        (m = url.pathname.match(/^\/user\/installations\/(\d+)\/repositories$/))
      ) {
        const ids = userInstallations.get(bearer);
        if (!ids) return send(401, { message: 'Bad credentials' });
        const installation = installations.get(m[1]!);
        if (!ids.includes(m[1]!) || !installation) return send(404, { message: 'Not Found' });
        const listed =
          userRepos.get(`${bearer}:${m[1]}`) ??
          installation.repos.map((r) => ({ full_name: r.full_name, push: true, admin: false }));
        return send(200, {
          total_count: listed.length,
          repositories: page(
            listed.map((r) => ({
              full_name: r.full_name,
              permissions: { pull: true, push: r.push, admin: r.admin ?? false },
            })),
          ),
        });
      }
      if (req.method === 'DELETE' && url.pathname.match(/^\/applications\/[^/]+\/token$/)) {
        if (!authorization?.startsWith('Basic ')) return send(401, { message: 'Bad credentials' });
        const token = (body as { access_token?: string } | undefined)?.access_token;
        if (token) revoked.push(token);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/installation/repositories') {
        const token = tokenOf(bearer);
        const installation = token && installations.get(token.installationId);
        if (!installation) return send(401, { message: 'Bad credentials' });
        return send(200, {
          total_count: installation.repos.length,
          repositories: page(installation.repos),
        });
      }
      if (req.method === 'GET' && url.pathname === '/user') {
        const user = users.get(bearer);
        return user
          ? send(200, { login: user.login, type: 'User' })
          : send(401, {
              message: 'Bad credentials',
            });
      }
      if (req.method === 'GET' && url.pathname === '/user/repos') {
        const user = users.get(bearer);
        return user ? send(200, page(user.repos)) : send(401, { message: 'Bad credentials' });
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
        return send(201, { html_url: `https://github.com/${m[1]}/${m[2]}/pull/1` });
      }
      send(404, { message: 'Not Found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    appId,
    privateKey,
    publicKey,
    requests,
    minted,
    installations,
    users,
    manifests,
    codes,
    userInstallations,
    userRepos,
    revoked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
