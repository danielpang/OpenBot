import { Hono } from 'hono';
import { bearer, tokenMatches } from './auth.js';
import type { BrowserPool } from './browser.js';
import type { CookieSync } from './cookies.js';
import { AgentError } from './errors.js';
import { problemResponse } from './errors.js';
import { runCommand } from './exec.js';
import { deletePath, readPath, writePath } from './fs.js';
import { sendInput } from './input.js';
import type { Run } from './proc.js';
import {
  BROWSER_ACTIONS,
  CookieSyncRequestSchema,
  ExecRequestSchema,
  ScreenNumberSchema,
  StartScreenSchema,
  WallpaperRequestSchema,
  type BrowserActionName,
  type CookieSyncResult,
  type ExecEvent,
  type WallpaperResult,
} from './protocol.js';
import type { ScreenManager } from './screens.js';
import type { Users } from './users.js';
import type { Wallpaper } from './wallpaper.js';

// The control agent's HTTP endpoints (plan 9.3). The WebSocket endpoints
// (`/pty`, `/vnc/:n`) are in ws.ts. Every request needs the token.

export interface AppDeps {
  token: string;
  home: string;
  run: Run;
  screens: ScreenManager;
  browsers: BrowserPool;
  wallpaper: Wallpaper;
  /** The shared browser logins (K1); screens keep their own cookies when unset. */
  cookies?: CookieSync;
  /** Who commands run as; the agent itself when unset. */
  users?: Users;
  version?: string;
}

const FS_PREFIX = '/fs';

/** The path after `/fs`, still URL-encoded. */
const fsPath = (url: string) => new URL(url).pathname.slice(FS_PREFIX.length);

const flag = (value: string | undefined) =>
  value !== undefined && value !== '0' && value !== 'false';

async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError(400, 'INVALID_JSON', 'The request body is not JSON');
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => problemResponse(c, err));
  app.notFound((c) => problemResponse(c, new AgentError(404, 'NOT_FOUND', 'No such endpoint')));

  app.use('*', async (c, next) => {
    if (!tokenMatches(deps.token, bearer(c.req.header('authorization')))) {
      return problemResponse(c, new AgentError(401, 'UNAUTHORIZED', 'Send the agent token'));
    }
    await next();
  });

  app.get('/healthz', (c) =>
    c.json({ status: 'ok', version: deps.version ?? '0.0.0', screens: deps.screens.list() }),
  );

  // --- exec ------------------------------------------------------------------

  app.post('/exec', async (c) => {
    const req = ExecRequestSchema.parse(await jsonBody(c.req.raw));
    const abort = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: ExecEvent) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          } catch {
            // The client went away.
          }
        };
        void runCommand(req, {
          home: deps.home,
          emit,
          signal: abort.signal,
          ...(deps.users ? { users: deps.users } : {}),
          xEnv: (n) => deps.screens.xEnv(n),
        }).finally(() => {
          try {
            controller.close();
          } catch {
            // Already cancelled.
          }
        });
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
    });
  });

  // --- fs --------------------------------------------------------------------

  app.get(`${FS_PREFIX}/*`, (c) => readPath(deps.home, fsPath(c.req.url)));
  app.put(`${FS_PREFIX}/*`, async (c) => {
    const entry = await writePath(deps.home, fsPath(c.req.url), c.req.raw.body, {
      dir: flag(c.req.query('dir')),
    });
    return c.json(entry, 201);
  });
  app.delete(`${FS_PREFIX}/*`, async (c) => {
    await deletePath(deps.home, fsPath(c.req.url), { recursive: flag(c.req.query('recursive')) });
    return c.body(null, 204);
  });

  // --- screens ---------------------------------------------------------------

  const screenParam = (value: string) => {
    const n = ScreenNumberSchema.safeParse(value);
    if (!n.success) throw new AgentError(404, 'SCREEN_NOT_RUNNING', `No screen "${value}"`);
    return n.data;
  };

  app.post('/screens', async (c) => {
    const req = StartScreenSchema.parse(await jsonBody(c.req.raw));
    const { info, created } = await deps.screens.start(req);
    return c.json(info, created ? 201 : 200);
  });

  // A screen's cookie changes reach the store after each action, without
  // holding up the answer; failures are the sync's to report.
  const afterAction = (n: number) => void deps.cookies?.afterAction(n);

  app.delete('/screens/:n', async (c) => {
    const n = screenParam(c.req.param('n'));
    // Its last cookie changes, while its Chromium still runs.
    await deps.cookies?.close(n);
    await deps.browsers.disconnect(n);
    if (!(await deps.screens.stop(n))) {
      throw new AgentError(404, 'SCREEN_NOT_RUNNING', `Screen ${n} is not running`);
    }
    return c.body(null, 204);
  });

  app.get('/screens/:n/screenshot', async (c) => {
    const info = deps.screens.require(screenParam(c.req.param('n')));
    const { stdout } = await deps.run(
      'import',
      ['-silent', '-window', 'root', 'png:-'],
      deps.screens.x(info.n),
    );
    return c.body(new Uint8Array(stdout), 200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
    });
  });

  app.post('/screens/:n/input', async (c) => {
    const info = deps.screens.require(screenParam(c.req.param('n')));
    const body = (await jsonBody(c.req.raw)) as Parameters<typeof sendInput>[2];
    const result = await sendInput(deps.run, deps.screens.x(info.n), body);
    afterAction(info.n);
    return c.json(result);
  });

  app.post('/screens/:n/browser/:action', async (c) => {
    const n = screenParam(c.req.param('n'));
    const action = c.req.param('action');
    if (!(BROWSER_ACTIONS as readonly string[]).includes(action)) {
      throw new AgentError(404, 'UNKNOWN_BROWSER_ACTION', `No browser action "${action}"`);
    }
    const info = await deps.screens.ensureBrowser(n);
    const body = await jsonBody(c.req.raw);
    try {
      return c.json(await deps.browsers.run(info, action as BrowserActionName, body));
    } finally {
      // A failed action may still have changed cookies, a half-done login say.
      afterAction(n);
    }
  });

  // --- cookies (K1) ------------------------------------------------------------

  app.post('/cookies/sync', async (c) => {
    const req = CookieSyncRequestSchema.parse(await jsonBody(c.req.raw));
    if (!deps.cookies) throw new AgentError(404, 'NO_COOKIE_SYNC', 'This agent shares no cookies');
    if (req.screen !== undefined) deps.screens.require(req.screen);
    const screens = await deps.cookies.sync(req.screen);
    const result: CookieSyncResult = { screens, cookies: deps.cookies.cookies().length };
    return c.json(result);
  });

  // --- wallpaper -------------------------------------------------------------

  app.post('/wallpaper', async (c) => {
    const req = WallpaperRequestSchema.parse(await jsonBody(c.req.raw));
    const screens = deps.screens.list();
    const hour = await deps.wallpaper.apply(req.hour, screens);
    const result: WallpaperResult = { hour, screens: screens.map((s) => s.n) };
    return c.json(result);
  });

  return app;
}
