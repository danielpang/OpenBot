import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runSubscription,
  subscriptionFailure,
  type SubscriptionRequest,
} from './subscription-model.js';
import { SUBSCRIPTION_AUTH_LOCK, withSubscriptionAuthLock } from './subscription-auth-lock.js';
import { signOutSubscription } from './subscription-sign-out.js';

type Json = Record<string, unknown>;
const modules = fileURLToPath(new URL('../node_modules', import.meta.url));
const ACCESS = 'review-secret-access';
const REFRESH = 'review-secret-refresh';
const jwt = (exp: number) =>
  `header.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.signature`;
const sse = (events: Json[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
function answer(provider: string): Response {
  if (provider === 'anthropic')
    return sse([
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]);
  const item = {
    type: 'message',
    id: 'msg_test',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
    status: 'completed',
  };
  return sse([
    { type: 'response.created', response: { id: 'resp_test', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    {
      type: 'response.content_part.added',
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: 'Hello',
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_test',
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Actual 1.5.0 modules, credential backend, auth resolution and provider HTTP encoders.
// Only vendor HTTP is replaced. No live accounts or Docker required.
describe('pinned subscription runtime', () => {
  let dir: string;
  let requests: { url: string; headers: Headers; body: Json }[];
  let events: Json[];
  let respond: (request: { url: string; body: Json }) => Response | Promise<Response>;
  let request: SubscriptionRequest;
  const entrypoints = new Set<() => Promise<void>>();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'subscription-runtime-'));
    requests = [];
    events = [];
    request = {
      agent: 'codex',
      provider: 'openai-codex',
      modelId: 'gpt-5.1-codex',
      context: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], timestamp: 0 }],
        tools: [],
      },
    };
    respond = () => answer(request.provider);
    vi.stubGlobal('fetch', async (input: string | Request | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const raw = Buffer.from(await req.arrayBuffer());
      const text = (
        req.headers.get('content-encoding') === 'zstd'
          ? zstdDecompressSync(raw)
          : req.headers.get('content-encoding') === 'gzip'
            ? gunzipSync(raw)
            : raw
      ).toString();
      const body = req.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(text))
        : (JSON.parse(text) as Json);
      const record = { url: req.url, headers: req.headers, body };
      requests.push(record);
      return respond(record);
    });
  });
  afterEach(async () => {
    await Promise.all([...entrypoints].map((stop) => stop()));
    entrypoints.clear();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });
  const execute = (signal?: AbortSignal) =>
    runSubscription(structuredClone(request), {
      modules,
      authDir: dir,
      signal,
      emit: (e) => {
        events.push(e);
      },
    });
  async function credentials(expired = false) {
    const access =
      request.agent === 'codex'
        ? jwt(expired ? 1 : 4102444800)
        : request.agent === 'claude'
          ? `sk-ant-oat-${ACCESS}`
          : ACCESS;
    const data =
      request.agent === 'codex'
        ? { tokens: { access_token: access, refresh_token: REFRESH, account_id: 'test-account' } }
        : request.agent === 'claude'
          ? {
              claudeAiOauth: {
                accessToken: access,
                refreshToken: REFRESH,
                expiresAt: expired ? 1 : 4102444800000,
              },
            }
          : {
              xai: {
                type: 'oauth',
                access,
                refresh: REFRESH,
                expires: expired ? 1 : 4102444800000,
              },
            };
    await writeFile(
      join(dir, request.agent === 'claude' ? '.credentials.json' : 'auth.json'),
      JSON.stringify(data),
    );
    return access;
  }
  it.each([
    ['claude', 'anthropic', 'claude-sonnet-4-5'],
    ['codex', 'openai-codex', 'gpt-5.1-codex'],
    ['pi', 'xai', 'grok-4'],
  ] as const)(
    'streams %s with local credentials and no secret in emitted events',
    async (agent, provider, modelId) => {
      request = { ...request, agent, provider, modelId };
      const access = await credentials();
      await execute();
      expect(events.map((e) => e.type)).toEqual(['text-start', 'text-delta', 'text-end', 'finish']);
      expect(events[1]?.delta).toBe('Hello');
      expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${access}`);
      expect(JSON.stringify(events)).not.toContain(access);
      expect(JSON.stringify(events)).not.toContain(REFRESH);
    },
  );
  it.each(['anthropic', 'openai-codex', 'xai'])(
    'sanitizes %s vendor errors containing credentials',
    async (provider) => {
      request = {
        ...request,
        provider,
        agent: provider === 'anthropic' ? 'claude' : provider === 'xai' ? 'pi' : 'codex',
      };
      const access = await credentials();
      respond = () =>
        new Response(
          JSON.stringify({
            error: { type: 'authentication_error', message: `401 ${access} ${REFRESH}` },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      const failure = await execute().then(() => {
        throw new Error('Expected rejection');
      }, subscriptionFailure);
      expect(failure.code).toBe('subscription_auth');
      expect(JSON.stringify(failure)).not.toContain(access);
      expect(JSON.stringify(failure)).not.toContain(REFRESH);
    },
  );
  it('never uses an ambient API key when the subscription credential is missing', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'do-not-charge');
    try {
      await expect(execute()).rejects.toThrow('not signed in');
      expect(requests).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('replays Codex tool calls without item IDs paired with discarded reasoning state', async () => {
    await credentials();
    const messages = request.context.messages as Json[];
    messages.push(
      {
        role: 'assistant',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
        model: request.modelId,
        content: [
          {
            type: 'toolCall',
            id: 'call_test|fc_paired_with_discarded_rs',
            name: 'lookup',
            arguments: {},
          },
        ],
        stopReason: 'toolUse',
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: 'toolResult',
        toolCallId: 'call_test|fc_paired_with_discarded_rs',
        toolName: 'lookup',
        content: [{ type: 'text', text: 'Found it' }],
        isError: false,
        timestamp: 0,
      },
    );
    request.context.tools = [
      { name: 'lookup', description: 'Find it', parameters: { type: 'object', properties: {} } },
    ];
    await execute();
    const input = requests[0]!.body.input as Json[];
    expect(input.find((i) => i.type === 'function_call')).toMatchObject({
      call_id: 'call_test',
      name: 'lookup',
    });
    expect(input.find((i) => i.type === 'function_call')).not.toHaveProperty('id');
    expect(input.find((i) => i.type === 'function_call_output')).toMatchObject({
      call_id: 'call_test',
    });
  });
  it('serializes concurrent refreshes and persists the new native credentials', async () => {
    await credentials(true);
    let refreshes = 0;
    respond = ({ url }) => {
      if (url.includes('/oauth/token')) {
        refreshes++;
        return Response.json({
          access_token: jwt(4102444800),
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        });
      }
      return answer(request.provider);
    };
    await Promise.all([execute(), execute()]);
    expect(refreshes).toBe(1);
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).tokens.refresh_token).toBe(
      'rotated-refresh',
    );
  });
  it('finishes a rotated token commit even if its caller cancels mid-refresh', async () => {
    await credentials(true);
    const started = deferred<void>();
    const response = deferred<Response>();
    respond = ({ url }) => {
      if (url.includes('/oauth/token')) {
        started.resolve();
        return response.promise;
      }
      return answer(request.provider);
    };
    const controller = new AbortController();
    let settled = false;
    const running = execute(controller.signal)
      .catch(subscriptionFailure)
      .finally(() => {
        settled = true;
      });
    await started.promise;
    controller.abort(new Error('Stopped'));
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false);
    response.resolve(
      Response.json({
        access_token: jwt(4102444800),
        refresh_token: 'rotated-after-cancel',
        expires_in: 3600,
      }),
    );
    await running;
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).tokens.refresh_token).toBe(
      'rotated-after-cancel',
    );
  });
  it('can cancel a refresh waiting for a native CLI lock without touching credentials', async () => {
    await credentials(true);
    const held = deferred<void>();
    const release = deferred<void>();
    const native = withSubscriptionAuthLock(
      join(dir, SUBSCRIPTION_AUTH_LOCK),
      undefined,
      async () => {
        held.resolve();
        await release.promise;
      },
    );
    await held.promise;
    try {
      const controller = new AbortController();
      const running = execute(controller.signal).catch(subscriptionFailure);
      controller.abort(new Error('Stopped'));
      await running;
      expect(requests).toHaveLength(0);
      expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).tokens.refresh_token).toBe(
        REFRESH,
      );
    } finally {
      release.resolve();
      await native;
    }
  });
  async function entrypoint(hook: string) {
    // Exercise production stdin/stdout and OS signals, with only the fixed vendor
    // module location redirected to the exact dev pin used in the image.
    const root = await realpath(dir);
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const name of ['subscription-model', 'subscription-auth-lock']) {
      const source = (await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8')).replace(
        '/opt/openbots/coders/node_modules',
        modules,
      );
      await writeFile(
        join(root, `${name}.js`),
        ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      );
    }
    await writeFile(join(root, 'http.mjs'), hook);
    const child = spawn(
      process.execPath,
      ['--import', join(root, 'http.mjs'), join(root, 'subscription-model.js')],
      {
        env: { ...process.env, CODEX_HOME: root },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (s: Buffer) => {
      stdout += s.toString();
    });
    child.stderr.on('data', (s: Buffer) => {
      stderr += s.toString();
    });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal }));
      },
    );
    entrypoints.add(async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
      await done.catch(() => {});
    });
    const waitForStderr = (text: string) =>
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.stderr.off('data', observe);
          child.off('close', exited);
        };
        const observe = () => {
          if (stderr.includes(text)) {
            cleanup();
            resolve();
          }
        };
        const exited = () => {
          cleanup();
          reject(new Error(`Bridge exited before ${text}: ${stdout} ${stderr}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${text}: ${stdout} ${stderr}`));
        }, 10_000);
        child.stderr.on('data', observe);
        child.once('close', exited);
        if (stderr.includes(text)) observe();
        else if (child.exitCode !== null || child.signalCode !== null) exited();
      });
    child.stdin.end(JSON.stringify(request) + '\n');
    return { child, done, waitForStderr, output: () => ({ stdout, stderr }) };
  }
  it('keeps credentials out of the actual entrypoint stdout and stderr on vendor refusal', async () => {
    const access = await credentials();
    const running = await entrypoint(
      `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({ error: { type: 'authentication_error', message: `401 ${access} ${REFRESH}` } }))}, { status: 401, headers: { 'content-type': 'application/json' } });`,
    );
    expect(await running.done).toEqual({ code: 1, signal: null });
    const output = running.output();
    expect(JSON.parse(output.stdout)).toMatchObject({ type: 'error', code: 'subscription_auth' });
    expect(output.stderr).toBe('');
    expect(output.stdout).not.toContain(access);
    expect(output.stdout).not.toContain(REFRESH);
  });
  it('survives a process-group SIGTERM until a rotated credential is persisted', async () => {
    await credentials(true);
    const running = await entrypoint(
      // Keep the vendor refresh pending until SIGTERM, not for an arbitrary sleep.
      // The parent waits for readiness before signalling, even on a busy CI runner.
      `globalThis.fetch = async () => { const cancelled = new Promise(r => process.once('SIGTERM', r)); process.stderr.write('refresh-started\\n'); await cancelled; return Response.json({access_token:${JSON.stringify(jwt(4102444800))},refresh_token:'committed-after-sigterm',expires_in:3600}); };`,
    );
    await running.waitForStderr('refresh-started');
    process.kill(-running.child.pid!, 'SIGTERM');
    expect(await running.done).toEqual({ code: 1, signal: null });
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).tokens.refresh_token).toBe(
      'committed-after-sigterm',
    );
    expect(running.output().stdout).not.toContain('committed-after-sigterm');
    expect(running.output().stderr).toBe('refresh-started\n');
  }, 15_000);

  it('waits for a pending rotation before disconnecting, so refresh cannot restore the sign-in', async () => {
    await credentials(true);
    const started = deferred<void>();
    const release = deferred<Response>();
    respond = ({ url }) => {
      if (url.includes('/oauth/token')) {
        started.resolve();
        return release.promise;
      }
      return answer(request.provider);
    };
    const running = execute();
    await started.promise;
    const disconnect = signOutSubscription('codex', dir, modules);
    release.resolve(
      Response.json({
        access_token: jwt(4102444800),
        refresh_token: 'rotated-then-disconnected',
        expires_in: 3600,
      }),
    );
    await Promise.all([running, disconnect]);
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual({});
    await expect(execute()).rejects.toThrow('not signed in');
  });

  it('disconnects under the refresh lock and never resurrects a removed credential', async () => {
    await credentials();
    await writeFile(join(dir, 'settings.json'), '{}');
    await signOutSubscription('codex', dir, modules);
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual({});
    await expect(readFile(join(dir, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(execute()).rejects.toThrow('not signed in');
    expect(requests).toHaveLength(0);
  });
});
