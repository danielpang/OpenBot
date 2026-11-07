import { randomUUID } from 'node:crypto';
import { CODER_MODE_ENV } from '@openbots/shared';
import { CODER_SOCKET_ENV, type PermissionRelayReply } from './coder-paths.js';
import { askOwner, permissionTimeoutMs } from './coder-permission-mcp.js';

// The OpenBots extension for pi (I11), at CODER_PI_EXTENSION
// (/app/apps/computer-agent/dist/coder-pi-extension.js) in the image. The
// server's start for a pi session passes `--no-extensions -e <this file>`,
// so pi loads only this one (pi loads extensions through jiti, which takes
// the plain ESM tsc emits here as well as TypeScript). pi has no approval
// mode of its own: its one gate is the `tool_call` hook, which runs before
// every tool call and may block it. Each call goes to the control agent over
// the session's unix socket, `$OPENBOTS_CODER_SOCKET`, exactly as the Claude
// Code permission MCP server does (coder-permission-mcp.ts): one JSON line
// `{request_id, tool_name, input}`, one JSON line `{decision, message?}` back.
// A deny blocks the call with the owner's message as the reason the model
// reads; anything that goes wrong denies. A handler that throws also blocks
// in pi (fail-safe).
//
// In plan mode (`OPENBOTS_CODER_MODE=plan`, set by the server's launch) only
// the read tools may run; the rest are blocked here without asking anyone,
// on top of the `--tools` allowlist the launch passes.
//
// No dependencies beyond node's built-ins and @openbots/shared: it runs from
// the agent's dist/ inside pi's process, as the coder user. Each call waits
// for the owner as long as the Claude Code relay does (`permissionTimeoutMs`,
// OPENBOTS_APPROVAL_TTL_MS from the session's environment).

export { CODER_MODE_ENV };

/** pi's built in tools that only read; the only ones a plan session may use. */
export const PI_READ_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'find', 'ls']);

/** The part of pi's `tool_call` event this reads. */
export interface PiToolCallEvent {
  toolName: string;
  toolCallId?: string;
  input: unknown;
}

/** What a `tool_call` handler returns to block the call; nothing lets it run. */
export interface PiBlock {
  block: true;
  reason: string;
}

/** The part of pi's `ExtensionAPI` this uses. */
export interface PiExtensionApi {
  on(
    event: 'tool_call',
    handler: (event: PiToolCallEvent, ctx: unknown) => Promise<PiBlock | undefined>,
  ): void;
}

export interface PiGateOptions {
  socket?: string;
  mode?: string;
  timeoutMs?: number;
}

/** Decides one tool call: blocked in plan mode unless it reads, else the owner's answer. */
export async function gateToolCall(
  event: PiToolCallEvent,
  { socket, mode, timeoutMs = permissionTimeoutMs() }: PiGateOptions,
): Promise<PiBlock | undefined> {
  if (mode === 'plan' && !PI_READ_TOOLS.has(event.toolName)) {
    return {
      block: true,
      reason: 'This session only plans: it may read the code but not change it or run commands.',
    };
  }
  const answer: PermissionRelayReply = await askOwner(
    socket,
    { request_id: randomUUID(), tool_name: event.toolName, input: event.input ?? {} },
    timeoutMs,
  );
  if (answer.decision === 'allow') return undefined;
  return { block: true, reason: answer.message ?? 'The owner said no' };
}

/** An extension that gates every tool call with `options`. */
export function piExtension(options: PiGateOptions): (pi: PiExtensionApi) => void {
  return (pi) => pi.on('tool_call', (event) => gateToolCall(event, options));
}

/**
 * The extension pi loads with `-e`: a default factory that receives pi's
 * API. The socket and the mode come from the session's environment, read
 * when pi loads it.
 */
export default function openbotsExtension(pi: PiExtensionApi): void {
  piExtension({ socket: process.env[CODER_SOCKET_ENV], mode: process.env[CODER_MODE_ENV] })(pi);
}
