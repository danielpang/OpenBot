import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A scripted OpenAI-compatible model for end-to-end runs (the agent test
// double on the wire): it streams its reply word by word so the transcript
// visibly fills in. "ask me" in the latest owner message makes it call
// `ask_user` with two options; "delete everything" makes it call a connector's
// `delete_everything` (the destructive tool of `@openbots/mcp/testing`'s HTTP
// server); "write a document" makes it call `create_artifact` with a short
// Markdown document; "slow" makes it stream for several seconds so Stop can
// be tried; after a tool result it acknowledges the answer.
//
// In a group (plan 18 Phase 5): a Bot whose handle starts with "chief" answers
// "route the launch" by handing the work to every other Bot in the chat by
// @handle; a Bot asked to "take your part" says it is on it and mentions
// nobody; a Bot whose handle starts with "paddle" answers "serve" by serving
// to the other paddle, which serves back until the loop guard stops them.
// Calls that do not stream (the router's `shouldReply` and other small-model
// calls) get `{"reply": false}`, so only mentioned Bots answer.

export interface FakeModel {
  baseUrl: string;
  close(): Promise<void>;
}

type ChatMessage = { role: string; content?: unknown };

/** The Bot a request is for and the other Bots in its chat, from the instructions. */
function whoIsAsking(system: string): { self?: string; others: string[] } {
  const self = /^You are .+? \(@([\w-]+)\), a Bot in OpenBots\./m.exec(system)?.[1];
  const others = [...system.matchAll(/^- @([\w-]+) \([^;\n]*; bot\)/gm)].map((m) => m[1]!);
  return { self, others: others.filter((h) => h !== self) };
}

/** The scripted group replies, or null outside them. */
export function groupReply(system: string, lastUser: string): string | null {
  const { self, others } = whoIsAsking(system);
  if (!self) return null;
  if (self.startsWith('chief') && /route the launch/i.test(lastUser)) {
    const team = others.filter((h) => !h.startsWith('chief') && !h.startsWith('paddle'));
    return `Routing the launch. ${team.map((h) => `@${h}`).join(' ')} please take your part.`;
  }
  if (/take your part/i.test(lastUser) && lastUser.includes(`@${self}`)) {
    return `On it: @${self} has its part of the launch.`;
  }
  if (self.startsWith('paddle') && /serve/i.test(lastUser)) {
    const other = others.find((h) => h.startsWith('paddle'));
    return other ? `@${other} your serve.` : null;
  }
  return null;
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'e2e',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeModel({ wordDelayMs = 60 } = {}): Promise<FakeModel> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-model' }] }));
        return;
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as {
        messages: ChatMessage[];
        stream?: boolean;
        tools?: { function: { name: string } }[];
      };
      const text = (m: ChatMessage | undefined) =>
        typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
      // The newest thing someone said: the run's context message (memories and
      // the like, packages/agent context/assemble.ts) follows the transcript.
      const lastUser = text(
        body.messages
          .filter((m) => m.role === 'user' && !text(m).includes('[system] Context for this run'))
          .at(-1),
      );
      const toolResult = body.messages.at(-1)?.role === 'tool' ? text(body.messages.at(-1)) : null;
      const askUser = body.tools?.find((t) => t.function.name.includes('ask_user'));
      const destroy = body.tools?.find((t) => t.function.name.endsWith('delete_everything'));
      const createArtifact = body.tools?.find((t) => t.function.name === 'create_artifact');
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion',
            created: 1,
            model: 'e2e',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"reply":false,"reason":"e2e"}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
        return;
      }
      const system = body.messages
        .filter((m) => m.role === 'system')
        .map(text)
        .join('\n');
      const scripted = toolResult ? null : groupReply(system, lastUser);
      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (!toolResult && createArtifact && /write a document/i.test(lastUser)) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_artifact',
                type: 'function',
                function: {
                  name: createArtifact.function.name,
                  arguments: JSON.stringify({
                    title: 'Launch plan',
                    kind: 'document',
                    content: '# Launch plan\n\nShip on Monday.\n',
                  }),
                },
              },
            ],
          }),
        );
        res.write(chunk({}, 'tool_calls'));
      } else if (!toolResult && destroy && /delete everything/i.test(lastUser)) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_delete',
                type: 'function',
                function: { name: destroy.function.name, arguments: '{}' },
              },
            ],
          }),
        );
        res.write(chunk({}, 'tool_calls'));
      } else if (!toolResult && askUser && /ask me/i.test(lastUser)) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_ask',
                type: 'function',
                function: {
                  name: askUser.function.name,
                  arguments: JSON.stringify({
                    question: 'Which colour?',
                    options: [
                      { id: 'red', label: 'Red' },
                      { id: 'blue', label: 'Blue' },
                    ],
                  }),
                },
              },
            ],
          }),
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        const reply = toolResult
          ? `Got it: ${toolResult}`
          : scripted
            ? scripted
            : /slow/i.test(lastUser)
              ? Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
              : 'Hello from the **test double**. Here is some code:\n\n```ts\nconst answer = 42;\n```\n';
        const delay = /slow/i.test(lastUser) ? 150 : wordDelayMs;
        res.write(chunk({ role: 'assistant', content: '' }));
        for (const word of reply.split(/(?<= )/)) {
          if (res.destroyed) return;
          res.write(chunk({ content: word }));
          await sleep(delay);
        }
        res.write(chunk({}, 'stop'));
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'e2e',
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Points a Bot at the fake model through the public API: an
 * openai-compatible provider (admin only; the first user is admin) and the
 * Bot's model config.
 */
export async function useFakeModel(
  request: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>,
  botId: string,
  baseUrl: string,
) {
  const provider = (await request('/api/v1/providers', {
    method: 'POST',
    body: {
      name: `E2E ${Date.now()}`,
      protocol: 'openai_compatible',
      baseUrl,
      // The fake listens on 127.0.0.1, which the server refuses unless the
      // endpoint is marked local (S-12); the e2e user is the admin who may.
      local: true,
      models: [{ modelId: 'e2e-model', capabilities: { tools: true } }],
    },
  })) as { id: string };
  await request(`/api/v1/bots/${botId}`, {
    method: 'PATCH',
    body: { modelConfig: { provider_id: provider.id, model_id: 'e2e-model' } },
  });
}
