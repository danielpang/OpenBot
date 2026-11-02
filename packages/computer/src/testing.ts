import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpStdioSession } from '@openbots/computer-agent/mcp-stdio';
import {
  BROWSER_ACTIONS,
  BrowserActionSchemas,
  CookieSyncRequestSchema,
  ExecRequestSchema,
  InputActionSchema,
  StartScreenSchema,
  type BrowserActionName,
  type ExecRequest,
  type FsEntry,
  type InputAction,
  type McpStdioStart,
  type ScreenInfo,
} from '@openbots/computer-agent/protocol';
import type Docker from 'dockerode';
import { WebSocketServer } from 'ws';
import { GUARD_NAME, GUARD_PATH, type DockerApi } from './docker.js';

// Test doubles: an in-process control agent speaking
// `@openbots/computer-agent/protocol` (requests are validated with the agent's
// own schemas, so a client that drifts from the agent fails here), with a
// memory filesystem under the home, scripted exec, screens, a 1x1 PNG
// screenshot, echoing pty and vnc sockets, and the agent's own `/mcp/stdio`
// running real processes on this machine; and a dockerode stand-in that
// records every call. Server and agent tests use these; no daemon needed.

/** A 1x1 transparent PNG. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
);

export interface FakeAgentCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeAgent {
  url: string;
  /** The token it accepts; tests may set it to the one the server generated. */
  token: string;
  /** Files by path relative to the home (`notes/a.md`). */
  files: Map<string, Uint8Array>;
  screens: Map<number, ScreenInfo>;
  inputs: { n: number; action: InputAction }[];
  browser: { n: number; action: { action: BrowserActionName } & Record<string, unknown> }[];
  /** Each `POST /cookies/sync`: its screen, null for every screen. */
  cookieSyncs: (number | null)[];
  calls: FakeAgentCall[];
  /** Replace to script `/exec`; the default echoes the command. */
  exec: (request: ExecRequest) => { stdout?: string; stderr?: string; exitCode?: number };
  /** Answers `/healthz` with 503 while false. */
  healthy: boolean;
  /** Each `/mcp/stdio` start, as the agent received it (secrets included: tests only). */
  mcpStdio: McpStdioStart[];
  /**
   * What a start runs instead; as received by default. Tests point catalog
   * binaries, which live only in the computer image, at a local server.
   */
  mcpLaunch: (start: McpStdioStart) => McpStdioStart;
  /** A real temporary directory standing in for the home, for `/mcp/stdio` (`dirs`, `cwd`). */
  home: string;
  close(): Promise<void>;
}

export async function startFakeAgent({ token = 'agent-token' } = {}): Promise<FakeAgent> {
  const agent: FakeAgent = {
    url: '',
    token,
    files: new Map(),
    screens: new Map(),
    inputs: [],
    browser: [],
    cookieSyncs: [],
    calls: [],
    exec: (request) => ({ stdout: `ran: ${request.command}\n`, exitCode: 0 }),
    healthy: true,
    mcpStdio: [],
    mcpLaunch: (start) => start,
    home: mkdtempSync(join(tmpdir(), 'openbots-fake-home-')),
    close: async () => {},
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const status = (error as { status?: number }).status ?? (isZod(error) ? 400 : 500);
      problem(res, status, error instanceof Error ? error.message : String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.authorization !== `Bearer ${agent.token}`) {
      return problem(res, 401, 'Send the agent token', 'UNAUTHORIZED');
    }
    const url = new URL(req.url ?? '/', 'http://agent');
    const method = req.method ?? 'GET';
    const raw = await readBody(req);
    const isJson = req.headers['content-type']?.includes('application/json');
    const body: unknown = isJson
      ? raw.length
        ? JSON.parse(Buffer.from(raw).toString())
        : {}
      : undefined;
    agent.calls.push({ method, path: url.pathname, ...(body !== undefined ? { body } : {}) });

    if (url.pathname === '/healthz') {
      return agent.healthy
        ? send(res, 200, { status: 'ok', version: 'fake', screens: [...agent.screens.values()] })
        : problem(res, 503, 'starting');
    }
    if (url.pathname === '/exec' && method === 'POST') {
      const result = agent.exec(ExecRequestSchema.parse(body));
      const line = (event: unknown) => `${JSON.stringify(event)}\n`;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(line({ type: 'start', pid: 1 }));
      if (result.stdout) res.write(line({ type: 'stdout', data: result.stdout }));
      if (result.stderr) res.write(line({ type: 'stderr', data: result.stderr }));
      const exit = { exitCode: result.exitCode ?? 0, signal: null, timedOut: false, durationMs: 1 };
      return res.end(line({ type: 'exit', ...exit }));
    }
    if (url.pathname === '/fs' || url.pathname.startsWith('/fs/')) {
      const rel = decodeURIComponent(url.pathname.slice(4)).replace(/^\/+|\/+$/g, '');
      if (rel.split('/').includes('..')) {
        return problem(res, 403, 'The path leaves the home directory', 'PATH_OUTSIDE_HOME');
      }
      if (method === 'GET') {
        const file = agent.files.get(rel);
        if (file) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end(Buffer.from(file));
        }
        const entries = listDir(agent.files, rel);
        if (!entries) return problem(res, 404, `No such path: /${rel}`, 'NOT_FOUND');
        return send(res, 200, { path: rel, entries });
      }
      if (method === 'PUT') {
        agent.files.set(rel, raw);
        return send(res, 201, fileEntry(rel, raw));
      }
      if (method === 'DELETE') {
        for (const path of [...agent.files.keys()]) {
          if (path === rel || path.startsWith(`${rel}/`)) agent.files.delete(path);
        }
        res.writeHead(204);
        return res.end();
      }
    }
    if (url.pathname === '/screens' && method === 'POST') {
      const { n, width = 1280, height = 800 } = StartScreenSchema.parse(body);
      const created = !agent.screens.has(n);
      const info: ScreenInfo = {
        n,
        display: `:${10 + n}`,
        width,
        height,
        vncPort: 5910 + n,
        cdpPort: 9222 + n,
      };
      agent.screens.set(n, info);
      return send(res, created ? 201 : 200, info);
    }
    const screen = /^\/screens\/(\d+)(\/.*)?$/.exec(url.pathname);
    if (screen) {
      const n = Number(screen[1]);
      const rest = screen[2] ?? '';
      const notRunning = () =>
        problem(res, 404, `Screen ${n} is not running`, 'SCREEN_NOT_RUNNING');
      if (rest === '' && method === 'DELETE') {
        if (!agent.screens.delete(n)) return notRunning();
        res.writeHead(204);
        return res.end();
      }
      if (!agent.screens.has(n)) return notRunning();
      if (rest === '/screenshot' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from(TINY_PNG));
      }
      if (rest === '/input' && method === 'POST') {
        InputActionSchema.parse(body);
        agent.inputs.push({ n, action: body as InputAction });
        return send(res, 200, { ok: true });
      }
      const browser = /^\/browser\/(\w+)$/.exec(rest);
      if (browser && method === 'POST') {
        const name = browser[1] as BrowserActionName;
        if (!(BROWSER_ACTIONS as readonly string[]).includes(name)) {
          return problem(res, 404, `No browser action "${name}"`, 'UNKNOWN_BROWSER_ACTION');
        }
        const input = BrowserActionSchemas[name].parse(body) as Record<string, unknown>;
        agent.browser.push({ n, action: { action: name, ...input } });
        if (name === 'navigate') {
          return send(res, 200, { url: input.url, title: `Title of ${String(input.url)}` });
        }
        if (name === 'snapshot') {
          return send(res, 200, {
            url: 'https://example.com/',
            title: 'Example',
            snapshot: '- heading "Example" [ref=e1]\n- link "More" [ref=e2]',
          });
        }
        return send(res, 200, { url: 'https://example.com/', title: 'Example' });
      }
    }
    if (url.pathname === '/cookies/sync' && method === 'POST') {
      const { screen } = CookieSyncRequestSchema.parse(body);
      if (screen !== undefined && !agent.screens.has(screen)) {
        return problem(res, 404, `Screen ${screen} is not running`, 'SCREEN_NOT_RUNNING');
      }
      agent.cookieSyncs.push(screen ?? null);
      const screens = screen === undefined ? [...agent.screens.keys()] : [screen];
      return send(res, 200, { screens, cookies: 0 });
    }
    if (url.pathname === '/wallpaper' && method === 'POST') {
      const hour = (body as { hour?: number }).hour ?? 12;
      return send(res, 200, { hour, screens: [...agent.screens.keys()] });
    }
    return problem(res, 404, 'No such endpoint', 'NOT_FOUND');
  }

  // `/pty` and `/vnc/:n` echo what they receive, prefixed, so proxies can be tested.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://agent').pathname;
    const vnc = /^\/vnc\/(\d+)$/.exec(path);
    const known =
      path === '/pty' || path === '/mcp/stdio' || (vnc && agent.screens.has(Number(vnc[1])));
    if (req.headers.authorization !== `Bearer ${agent.token}` || !known) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    if (path === '/mcp/stdio') {
      wss.handleUpgrade(req, socket, head, (ws) =>
        mcpStdioSession(ws, {
          home: agent.home,
          graceMs: 200,
          prepare: (start) => {
            agent.mcpStdio.push(start);
            return agent.mcpLaunch(start);
          },
        }),
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => {
        ws.send(isBinary ? data : `${path}:${data.toString()}`, { binary: isBinary });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  agent.close = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(agent.home, { recursive: true, force: true });
  };
  return agent;
}

function fileEntry(rel: string, data: Uint8Array): FsEntry {
  return {
    name: rel.split('/').at(-1) ?? rel,
    path: rel,
    type: 'file',
    size: data.byteLength,
    modifiedAt: new Date(0).toISOString(),
  };
}

/** Directories exist where files are under them; the home always exists. */
function listDir(files: Map<string, Uint8Array>, dir: string): FsEntry[] | null {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, FsEntry>();
  for (const [path, data] of files) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split('/');
    if (!name) continue;
    const at = `${prefix}${name}`;
    entries.set(
      name,
      rest.length
        ? { name, path: at, type: 'dir', size: 0, modifiedAt: new Date(0).toISOString() }
        : fileEntry(at, data),
    );
  }
  if (!entries.size && dir !== '') return null;
  return [...entries.values()].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
}

function isZod(error: unknown) {
  return (error as { name?: string } | null)?.name === 'ZodError';
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function problem(res: ServerResponse, status: number, detail: string, code = 'ERROR') {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: 'about:blank', title: 'Error', status, code, detail }));
}

export interface MockDocker extends DockerApi {
  calls: { op: string; args: unknown[] }[];
  images: Set<string>;
  /** Image ids by name, `sha256:<name>` unless set: change one to stand for a moved tag. */
  imageIds: Map<string, string>;
  networks: Set<string>;
  volumes: Set<string>;
  containers: Map<
    string,
    {
      spec: Docker.ContainerCreateOptions;
      running: boolean;
      /** The id of the image it was made from. */
      image: string;
      /** The last archive put into it, by the path it went to. */
      archives?: Map<string, Buffer>;
    }
  >;
  /** Whether it answers as the docker guard; set false to stand for an unfiltered daemon. */
  guarded: boolean;
}

/** A dockerode stand-in; containers get ids `c-<name>`. Errors carry `statusCode` like dockerode's. */
export function mockDocker(): MockDocker {
  const notFound = () => Object.assign(new Error('no such object'), { statusCode: 404 });
  const imageIdOf = (name: string) => docker.imageIds.get(name) ?? `sha256:${name}`;
  const docker: MockDocker = {
    calls: [],
    images: new Set(),
    imageIds: new Map(),
    networks: new Set(),
    volumes: new Set(),
    containers: new Map(),
    guarded: true,
    getImage: (name) => ({
      inspect: async () => {
        if (!docker.images.has(name)) throw notFound();
        return { Id: imageIdOf(name) };
      },
    }),
    pull: async (image) => {
      docker.calls.push({ op: 'pull', args: [image] });
      docker.images.add(image);
      const { Readable } = await import('node:stream');
      return Readable.from([]);
    },
    modem: {
      followProgress: (_stream, done) => done(null),
      dial: (options, done) => {
        if (docker.guarded && options.path === GUARD_PATH) done(null, { guard: GUARD_NAME });
        else done(Object.assign(new Error('(HTTP code 404) unexpected'), { statusCode: 404 }));
      },
    },
    getNetwork: (name) => ({
      inspect: async () => {
        if (!docker.networks.has(name)) throw notFound();
        return {};
      },
    }),
    createNetwork: async (options) => {
      docker.calls.push({ op: 'createNetwork', args: [options] });
      docker.networks.add(options.Name);
      return {};
    },
    getVolume: (name) => ({
      inspect: async () => {
        if (!docker.volumes.has(name)) throw notFound();
        return {};
      },
    }),
    createVolume: async (options) => {
      docker.calls.push({ op: 'createVolume', args: [options] });
      docker.volumes.add(String(options.Name));
      return {};
    },
    createContainer: async (spec) => {
      docker.calls.push({ op: 'createContainer', args: [spec] });
      const id = `c-${spec.name}`;
      docker.containers.set(id, { spec, running: false, image: imageIdOf(String(spec.Image)) });
      return { id };
    },
    getContainer: (id) => {
      const find = () => docker.containers.get(id) ?? docker.containers.get(`c-${id}`);
      return {
        start: async () => {
          docker.calls.push({ op: 'start', args: [id] });
          const c = find();
          if (!c) throw notFound();
          if (c.running) throw Object.assign(new Error('already started'), { statusCode: 304 });
          c.running = true;
          return {};
        },
        putArchive: async (file, options) => {
          docker.calls.push({ op: 'putArchive', args: [id, options] });
          const c = find();
          if (!c) throw notFound();
          (c.archives ??= new Map()).set(options.path, file);
          return {};
        },
        stop: async () => {
          docker.calls.push({ op: 'stop', args: [id] });
          const c = find();
          if (!c) throw notFound();
          if (!c.running) throw Object.assign(new Error('already stopped'), { statusCode: 304 });
          c.running = false;
          return {};
        },
        remove: async (options) => {
          docker.calls.push({ op: 'remove', args: [id, options] });
          const c = find();
          if (!c) throw notFound();
          docker.containers.delete(`c-${String(c.spec.name)}`);
          return {};
        },
        inspect: async () => {
          const c = find();
          if (!c) throw notFound();
          return { State: { Running: c.running }, Image: c.image };
        },
      };
    },
  };
  return docker;
}
