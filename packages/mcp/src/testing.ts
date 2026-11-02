import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// Test doubles: the path of the in-repo stdio MCP server, and an in-process
// Streamable HTTP MCP server with optional bearer auth. Not for production use.

/** `node <this>` runs the stdio test server. */
export const TEST_STDIO_SERVER = fileURLToPath(
  new URL('../test-server/stdio-server.mjs', import.meta.url),
);

export interface TestHttpServer {
  url: string;
  /** Requests seen, with the Authorization header each carried. */
  requests: { method: string; authorization: string | undefined }[];
  /** Registers another tool on every open session, which sends tools/list_changed. */
  addTool(name: string): void;
  close(): Promise<void>;
}

function buildServer(extraTools: string[]): McpServer {
  const server = new McpServer({ name: 'openbots-test-http', version: '1.0.0' });
  server.registerTool(
    'add',
    {
      title: 'Add',
      description: 'Adds two numbers',
      inputSchema: { a: z.number(), b: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  server.registerTool(
    'delete_everything',
    { description: 'Pretends to be dangerous', annotations: { destructiveHint: true } },
    async () => ({ content: [{ type: 'text', text: 'deleted' }] }),
  );
  for (const name of extraTools) registerExtra(server, name);
  return server;
}

function registerExtra(server: McpServer, name: string) {
  server.registerTool(name, { description: `Extra tool ${name}` }, async () => ({
    content: [{ type: 'text', text: name }],
  }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export interface TestHttpServerOptions {
  /** Accepts a request by its Authorization header; every request is accepted when absent. */
  authorize?: (authorization: string | undefined) => boolean;
  /** Serves RFC 9728 metadata naming this authorization server. */
  authorizationServer?: string;
}

export async function startTestHttpServer(
  options: TestHttpServerOptions = {},
): Promise<TestHttpServer> {
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();
  const extraTools: string[] = [];
  const requests: TestHttpServer['requests'] = [];

  const http: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        if (!options.authorizationServer) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            resource: `http://${req.headers.host}/mcp`,
            authorization_servers: [options.authorizationServer],
          }),
        );
        return;
      }
      requests.push({ method: req.method ?? '', authorization: req.headers.authorization });
      if (options.authorize && !options.authorize(req.headers.authorization)) {
        res.writeHead(401, {
          'www-authenticate': options.authorizationServer
            ? `Bearer resource_metadata="http://${req.headers.host}/.well-known/oauth-protected-resource/mcp"`
            : 'Bearer',
        });
        res.end();
        return;
      }
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const sessionId = req.headers['mcp-session-id'];
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!session) {
        const server = buildServer(extraTools);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        session = { server, transport };
      }
      await session.transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    addTool(name) {
      extraTools.push(name);
      for (const { server } of sessions.values()) registerExtra(server, name);
    },
    async close() {
      for (const { transport } of sessions.values()) await transport.close().catch(() => {});
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export interface MockAuthServer {
  url: string;
  /** The query of the last `/authorize` request. */
  lastAuthorize: URLSearchParams | null;
  /** Token endpoint requests, form-decoded. */
  tokenRequests: URLSearchParams[];
  registrations: number;
  /** Whether `authorization` carries a token this server issued and has not superseded. */
  validates(authorization: string | undefined): boolean;
  /** Follows an authorization URL as a consenting user would; returns the redirect target. */
  consent(authorizationUrl: string): Promise<URL>;
  close(): Promise<void>;
}

/**
 * An OAuth 2.1 authorization server double: RFC 8414 metadata, RFC 7591
 * registration (optional), `/authorize` that consents at once, and `/token`
 * that checks the PKCE S256 verifier and the redirect URI before issuing.
 */
export async function startMockAuthServer(
  options: { dynamicRegistration?: boolean; expiresIn?: number } = {},
): Promise<MockAuthServer> {
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const state: Pick<MockAuthServer, 'lastAuthorize' | 'tokenRequests' | 'registrations'> = {
    lastAuthorize: null,
    tokenRequests: [],
    registrations: 0,
  };
  let base = '';
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const issue = () => {
    const access = `at_${randomUUID()}`;
    const refresh = `rt_${randomUUID()}`;
    accessTokens.clear();
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return {
      access_token: access,
      token_type: 'Bearer',
      refresh_token: refresh,
      expires_in: options.expiresIn ?? 3600,
    };
  };

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(options.dynamicRegistration === false
            ? {}
            : { registration_endpoint: `${base}/register` }),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        });
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        state.registrations++;
        return json(res, 201, { ...body, client_id: `client_${state.registrations}` });
      }
      if (url.pathname === '/authorize') {
        state.lastAuthorize = url.searchParams;
        const p = url.searchParams;
        if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
          return json(res, 400, { error: 'invalid_request' });
        }
        const code = `code_${randomUUID()}`;
        codes.set(code, {
          challenge: p.get('code_challenge')!,
          redirectUri: p.get('redirect_uri')!,
          clientId: p.get('client_id')!,
        });
        const target = new URL(p.get('redirect_uri')!);
        target.searchParams.set('code', code);
        if (p.get('state')) target.searchParams.set('state', p.get('state')!);
        res.writeHead(302, { location: target.toString() }).end();
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        state.tokenRequests.push(form);
        if (form.get('grant_type') === 'authorization_code') {
          const entry = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (
            !entry ||
            entry.challenge !== challenge ||
            entry.redirectUri !== form.get('redirect_uri') ||
            entry.clientId !== form.get('client_id')
          ) {
            return json(res, 400, { error: 'invalid_grant' });
          }
          return json(res, 200, issue());
        }
        if (form.get('grant_type') === 'refresh_token') {
          const token = form.get('refresh_token') ?? '';
          if (!refreshTokens.delete(token)) return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, issue());
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  return {
    url: base,
    get lastAuthorize() {
      return state.lastAuthorize;
    },
    get tokenRequests() {
      return state.tokenRequests;
    },
    get registrations() {
      return state.registrations;
    },
    validates(authorization) {
      const match = /^Bearer (.+)$/.exec(authorization ?? '');
      return Boolean(match && accessTokens.has(match[1]!));
    },
    async consent(authorizationUrl) {
      const res = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status !== 302 || !location) throw new Error(`authorize answered ${res.status}`);
      return new URL(location);
    },
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
