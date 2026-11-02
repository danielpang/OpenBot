import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

// A fake OpenAI-compatible endpoint for tests: `GET /models` and streamed
// `POST /chat/completions`, with a tool call whenever tools are offered and
// no tool result has come back yet. Exported as `@openbots/models/testing`.

export interface FakeOpenAIOptions {
  /** Entries for `GET /models`. */
  models?: Record<string, unknown>[];
  /** When false, the model ignores tools and answers in text. */
  toolCalls?: boolean;
  /** When set, chat completions answer with this status and an error body. */
  chatStatus?: number;
  /** Path prefix, `/v1` by default. */
  prefix?: string;
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

export interface FakeOpenAI {
  baseUrl: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

export async function startFakeOpenAI(options: FakeOpenAIOptions = {}): Promise<FakeOpenAI> {
  const prefix = options.prefix ?? '/v1';
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });

      if (req.method === 'GET' && path === `${prefix}/models`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: options.models ?? [] }));
        return;
      }
      if (req.method === 'POST' && path === `${prefix}/chat/completions`) {
        if (options.chatStatus) {
          res.writeHead(options.chatStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'fake failure', type: 'server_error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const messages = (body?.messages ?? []) as { role: string }[];
        const wantsTool =
          options.toolCalls !== false &&
          Array.isArray(body?.tools) &&
          !messages.some((m) => m.role === 'tool');
        if (wantsTool) {
          const tools = body!.tools as { function: { name: string } }[];
          res.write(
            chunk({
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: tools[0]!.function.name, arguments: '{"a":2,"b":3}' },
                },
              ],
            }),
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: 'ok' }));
          res.write(chunk({}, 'stop'));
        }
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake',
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
