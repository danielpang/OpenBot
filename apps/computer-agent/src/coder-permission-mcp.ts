import { realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  coderApprovalTtlMs,
  DEFAULT_CODER_APPROVAL_TTL_MS,
  CODER_PUBLISH_TOOL,
  CODER_PUBLISH_OPERATION,
  CODER_PUBLISH_PARAMETERS,
  CODER_PUBLISH_DESCRIPTION,
  CoderPublishInputSchema,
  CoderPublishResultSchema,
  type CoderPublishResult,
} from '@openbots/shared';
import {
  CODER_SOCKET_ENV,
  type PermissionRelayReply,
  type PermissionRelayRequest,
} from './coder-paths.js';

// The permission MCP server for Claude Code (I11), at CODER_PERMISSION_MCP
// (/app/apps/computer-agent/dist/coder-permission-mcp.js) in the image. The
// server's start for a Claude Code session passes
//
//   --mcp-config '{"mcpServers":{"openbots":{"command":"node",
//     "args":["/app/apps/computer-agent/dist/coder-permission-mcp.js"]}}}'
//   --permission-prompt-tool mcp__openbots__permission_prompt
//
// (or the same config as a file under `{{session_dir}}`), so Claude Code
// starts this server inside the session, as the coder user, and calls its
// permission tool whenever a tool use needs the owner's say. Codex also uses
// this server's publishing tool. Each call goes to the
// control agent over the session's own unix socket, `$OPENBOTS_CODER_SOCKET`
// (coder.ts): one JSON line `{request_id, tool_name, input}` there, one JSON
// line `{decision, message?}` back, which the agent relays from the server's
// `answer` frame. The text it returns is the JSON Claude Code expects of a
// permission prompt tool: `{"behavior":"allow","updatedInput":...}` or
// `{"behavior":"deny","message":...}`. Anything that goes wrong denies.
//
// The MCP stdio transport is newline-delimited JSON-RPC 2.0 on stdin and
// stdout; this speaks just enough of it, with no dependencies beyond
// @openbots/shared, since it runs with the runtime's node from the agent's
// dist/.

/** An approval waits this long for the owner when the launch does not say, then denies. */
export const PERMISSION_TIMEOUT_MS = DEFAULT_CODER_APPROVAL_TTL_MS;

/**
 * How long an approval waits for the owner: `OPENBOTS_APPROVAL_TTL_MS` from
 * the session's environment, which the server's launch sets to mirror
 * OPENBOTS_APPROVAL_TTL_MINUTES so a prompt expires with the server's
 * approval, else PERMISSION_TIMEOUT_MS (24 hours).
 */
export function permissionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return coderApprovalTtlMs(env);
}

export const TOOL_NAME = 'permission_prompt';

const TOOL = {
  name: TOOL_NAME,
  description: "Asks the Bot's owner in OpenBots whether a tool use may go ahead.",
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool that wants to run.' },
      input: { type: 'object', description: "The tool's input." },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

type Id = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

/** Asks over the socket at `file` and resolves with the answer; denies on any failure. */
export function askOwner(
  file: string | undefined,
  request: PermissionRelayRequest,
  timeoutMs = permissionTimeoutMs(),
): Promise<PermissionRelayReply> {
  return new Promise((resolve) => {
    if (!file) return resolve({ decision: 'deny', message: 'OpenBots cannot ask the owner here' });
    let buffer = '';
    let done = false;
    const settle = (answer: PermissionRelayReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(answer);
    };
    const timer = setTimeout(
      () => settle({ decision: 'deny', message: 'Nobody answered the approval in time' }),
      timeoutMs,
    );
    const conn = connect(file, () => conn.write(`${JSON.stringify(request)}\n`));
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try {
        const answer = JSON.parse(buffer.slice(0, nl)) as PermissionRelayReply;
        settle(
          answer.decision === 'allow'
            ? {
                decision: 'allow',
                ...(typeof answer.message === 'string' ? { message: answer.message } : {}),
              }
            : {
                decision: 'deny',
                message: typeof answer.message === 'string' ? answer.message : 'The owner said no',
              },
        );
      } catch {
        settle({ decision: 'deny', message: 'OpenBots gave no answer' });
      }
    });
    conn.on('error', () =>
      settle({ decision: 'deny', message: 'OpenBots could not ask the owner' }),
    );
    conn.on('close', () => settle({ decision: 'deny', message: 'OpenBots gave no answer' }));
  });
}

/** The native pi tool and the stdio MCP tool share this fail-closed client. */
export async function publishPullRequest(
  socket: string | undefined,
  input: unknown,
  timeoutMs?: number,
): Promise<CoderPublishResult> {
  const args = CoderPublishInputSchema.parse(input);
  const answer = await askOwner(
    socket,
    { tool_name: CODER_PUBLISH_OPERATION, input: args },
    timeoutMs,
  );
  if (answer.decision !== 'allow') throw new Error(answer.message ?? 'Publishing failed');
  if (!answer.message) throw new Error('Publishing failed: no result from OpenBots');
  return CoderPublishResultSchema.parse(JSON.parse(answer.message));
}

export interface PermissionServerOptions {
  socket?: string;
  timeoutMs?: number;
  /** One JSON-RPC message out, as a line. */
  write: (line: string) => void;
}

/** Handles one JSON-RPC message; resolves once any reply is written. */
export async function handleMessage(
  message: JsonRpcRequest,
  { socket, timeoutMs, write }: PermissionServerOptions,
): Promise<void> {
  const respond = (id: Id, result: unknown) =>
    write(JSON.stringify({ jsonrpc: '2.0', id, result }));
  const error = (id: Id, code: number, text: string) =>
    write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: text } }));
  const { id, method, params } = message;
  // A notification (no id) gets no reply, whatever it is.
  const isRequest = id !== undefined;
  switch (method) {
    case 'initialize':
      if (!isRequest) return;
      return respond(id, {
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'openbots-permission', version: '1.0.0' },
      });
    case 'ping':
      if (isRequest) respond(id, {});
      return;
    case 'tools/list':
      if (isRequest)
        respond(id, {
          tools: [
            TOOL,
            {
              name: CODER_PUBLISH_TOOL,
              description: CODER_PUBLISH_DESCRIPTION,
              inputSchema: CODER_PUBLISH_PARAMETERS,
            },
          ],
        });
      return;
    case 'tools/call': {
      if (!isRequest) return;
      if (params?.name === CODER_PUBLISH_TOOL) {
        const parsed = CoderPublishInputSchema.safeParse(params.arguments);
        if (!parsed.success)
          return error(
            id,
            -32602,
            'publish_pull_request needs title, body and optional draft; no repository or branch overrides',
          );
        try {
          const result = await publishPullRequest(socket, parsed.data, timeoutMs);
          return respond(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : 'Publishing failed';
          return respond(id, { isError: true, content: [{ type: 'text', text: message }] });
        }
      }
      if (params?.name !== TOOL_NAME) return error(id, -32602, `No tool ${String(params?.name)}`);
      const args = (params.arguments ?? {}) as {
        tool_name?: unknown;
        input?: unknown;
        tool_use_id?: unknown;
      };
      if (typeof args.tool_name !== 'string') {
        return error(id, -32602, 'permission_prompt needs tool_name');
      }
      const input = args.input ?? {};
      const answer = await askOwner(
        socket,
        {
          ...(typeof args.tool_use_id === 'string' ? { request_id: args.tool_use_id } : {}),
          tool_name: args.tool_name,
          input,
        },
        timeoutMs,
      );
      const decision =
        answer.decision === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: answer.message ?? 'The owner said no' };
      return respond(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
    }
    default:
      if (isRequest && method !== undefined && !method.startsWith('notifications/')) {
        error(id, -32601, `No method ${method}`);
      }
  }
}

/** Serves MCP on `input` and `output` until `input` ends. */
export function serve(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  options: Omit<PermissionServerOptions, 'write'> = { socket: process.env[CODER_SOCKET_ENV] },
): Promise<void> {
  const write = (line: string) => void output.write(`${line}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const inflight = new Set<Promise<void>>();
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      );
      return;
    }
    // Calls run side by side: one prompt waiting on the owner holds up no other.
    const task = handleMessage(message, { ...options, write }).catch(() => {});
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  });
  // Once stdin ends, the answers still owed are written before it returns.
  return new Promise((resolve) =>
    lines.once('close', () => void Promise.all(inflight).then(() => resolve())),
  );
}

const invoked = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (invoked) {
  void serve().then(() => process.exit(0));
}
