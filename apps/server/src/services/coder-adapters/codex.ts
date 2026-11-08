import type { CoderEvent } from '@openbots/shared';
import { CLASS_RANK, classifyCommandLine, classifyPathAccess, strictest } from './classify.js';
import {
  gitIdentityEnv,
  ignoredId,
  isObject,
  num,
  oneLine,
  preamble as basePreamble,
  str,
  stripAnsi,
  type Json,
} from './common.js';
import { parseShell } from './shell-words.js';
import {
  isVendorSessionId,
  type CoderAdapter,
  type CoderLaunchPlan,
  type CoderLoginParse,
  type CoderOutputParser,
  type CoderParserOptions,
  type CoderSession,
  type CoderSessionIo,
  type CoderSessionSpec,
  type CoderSignInCheck,
} from './types.js';

// The Codex CLI (docs/TECHNICAL_PLAN.md 22.13; I10). A session runs
// `codex app-server`: JSON-RPC over stdio, one JSON object per line, with no
// `jsonrpc` member on what the server writes. The runner keeps stdin open
// (`transport: 'jsonrpc'`) and this adapter speaks the protocol:
//
//   -> initialize {clientInfo, capabilities}      <- {userAgent, codexHome, ...}
//   -> initialized (a notification)
//   -> thread/start {cwd, approvalPolicy, sandbox} <- {thread: {id}, ...}
//      or thread/resume {threadId, ...} for a vendor session id
//   -> turn/start {threadId, input: [{type: "text", text}]}
//   <- item/started, item/completed, thread/tokenUsage/updated, error, ...
//   <- item/commandExecution/requestApproval, item/fileChange/requestApproval
//   -> {id, result: {decision: "accept" | "decline"}}
//   <- turn/completed {turn: {status, error}}
//
// After `turn/completed` the session emits its result and the runner closes
// stdin, on which app-server exits 0. The thread id (a UUIDv7) is the vendor
// session id. The facts were checked against the pinned 0.166.0
// (docs/CODING_AGENT_VENDORS.md).
//
// Approvals: the policy is `on-request`. Codex runs commands and edits
// inside its sandbox (`workspace-write`, or `read-only` to plan, the
// network off) without asking, and asks before it steps outside it: a
// command it wants run unsandboxed or with the network, a write outside the
// writable roots. Each request comes to OpenBots, is classified
// (classify.ts) and is decided like any agent's prompt. (`untrusted`, which
// asked for every command but known safe reads, is refused by 0.166.0 in
// config: "no longer supported".)
//
// `app-server` has no `--ignore-user-config`, so a `config.toml` in
// CODEX_HOME (which the coder user can write) is read. What decides the
// posture is set over it, as `-c` overrides (the highest config layer) and
// again in the thread and turn parameters: the approval policy, who reviews
// approvals, the sandbox, its network, its writable roots and the model
// provider.

type Sandbox = 'read-only' | 'workspace-write';

const sandboxFor = (spec: CoderSessionSpec): Sandbox =>
  spec.mode === 'plan' || spec.acceptEdits === false ? 'read-only' : 'workspace-write';

/** Codex asks before it leaves its sandbox. */
const APPROVAL_POLICY = 'on-request';
/** Approvals go to the client (OpenBots), never Codex's own reviewer agent. */
const APPROVALS_REVIEWER = 'user';
/** The provider an `api_key` session names in its config, reading the key from the environment. */
const KEY_PROVIDER = 'openbots';

export const preamble = (spec: CoderSessionSpec): string =>
  basePreamble(spec, {
    notes: [
      'The sandbox has no network, so installing packages fails: if a missing dependency blocks you, say so and ask the owner to install dependencies.',
    ],
    plan: 'This session only plans: change nothing, edit no files and make no commits. Read the code and write a plan.',
  });

/** The worktree's git dir is under `<repo>/.git`, outside the sandbox's workspace: a commit needs it writable. */
const gitDirOf = (spec: CoderSessionSpec): string | undefined =>
  sandboxFor(spec) === 'workspace-write' && spec.repoPath
    ? `${spec.repoPath.replace(/\/+$/, '')}/.git`
    : undefined;

/** A JSON string is a TOML basic string, for the `-c` values. */
const toml = (value: string) => JSON.stringify(value);

function launch(spec: CoderSessionSpec): CoderLaunchPlan {
  const sandbox = sandboxFor(spec);
  const gitDir = gitDirOf(spec);
  // A plan sign-in uses the built-in provider and the sign-in in CODEX_HOME.
  // An API key comes in the environment (OPENAI_API_KEY), which app-server's
  // built-in provider does not read, so the session names a provider that
  // does, at the account's base URL when it has one.
  const provider = spec.apiKeyProvider
    ? [
        '-c',
        `model_providers.${KEY_PROVIDER}={name="OpenAI",env_key="OPENAI_API_KEY",wire_api="responses"${
          spec.apiKeyBaseUrl ? `,base_url=${toml(spec.apiKeyBaseUrl)}` : ''
        }}`,
        '-c',
        `model_provider="${KEY_PROVIDER}"`,
      ]
    : ['-c', 'model_provider="openai"'];
  const args = [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    `approval_policy="${APPROVAL_POLICY}"`,
    '-c',
    `approvals_reviewer="${APPROVALS_REVIEWER}"`,
    '-c',
    `sandbox_mode="${sandbox}"`,
    '-c',
    'sandbox_workspace_write.network_access=false',
    ...(gitDir ? ['-c', `sandbox_workspace_write.writable_roots=[${toml(gitDir)}]`] : []),
    ...provider,
  ];
  // CODEX_HOME (the sign-in) is set by the computer agent; the prompt goes over stdin.
  return { command: 'codex', args, env: gitIdentityEnv(spec) };
}

// Reading the protocol

type Billed = Extract<CoderEvent, { type: 'usage' }>['billed'];

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/** `/bin/bash -lc 'npm test'`, as Codex wraps every command, shown as `npm test`. */
export function unwrapShell(command: string): string {
  const parsed = parseShell(command);
  const words = parsed.commands[0]?.words;
  if (parsed.unbalanced || parsed.commands.length !== 1 || words?.length !== 3) return command;
  const shell = words[0]!.text.split('/').pop() ?? '';
  if (!SHELLS.has(shell) || !/^-[a-z]*c$/.test(words[1]!.text)) return command;
  return words[2]!.text;
}

/** Codex's change kinds (`{type: "add"}`) in OpenBots's terms. */
const CHANGE_KIND: Record<string, 'create' | 'edit' | 'delete'> = {
  add: 'create',
  update: 'edit',
  delete: 'delete',
};

/** Error codes (`codexErrorInfo`) the runner reads: a sign-in, a rate limit. */
const NAMED_ERRORS = new Set(['unauthorized', 'rateLimitExceeded', 'usageLimitExceeded']);

/**
 * How a Codex login is billed, from `codex login status`: a ChatGPT login
 * counts against the plan, any other sign-in against API credits.
 */
export function codexBilling(status: string): Billed {
  const text = stripAnsi(status);
  if (/not logged in/i.test(text)) return 'unknown';
  if (/Logged in using ChatGPT/i.test(text)) return 'subscription';
  if (/Logged in/i.test(text)) return 'api';
  return 'unknown';
}

/**
 * Reads `codex login status` through `codexBilling`: a ChatGPT login is a
 * plan sign-in, any other `Logged in` line (an API key, an access token)
 * `api_key`. The line itself is never kept: it can hold a masked key.
 */
export function codexStatus(output: string): CoderSignInCheck {
  switch (codexBilling(output)) {
    case 'subscription':
      return { signedIn: true, authKind: 'subscription', label: 'ChatGPT' };
    case 'api':
      return { signedIn: true, authKind: 'api_key', label: 'API key through Codex' };
    default:
      return { signedIn: false };
  }
}

/** Notifications a session never reads: streaming deltas, which the completed item repeats. */
const OPTED_OUT = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'command/exec/outputDelta',
];

/** The `initialize` request's params: OpenBots as the client. */
export const CODEX_CLIENT_INFO = { name: 'openbots', title: 'OpenBots', version: '1.0.0' };

/** A request OpenBots does not serve: JSON-RPC's "method not found". */
const NOT_SERVED = -32601;

/** What a session remembers of an item between `item/started` and its approval. */
interface Started {
  command?: string;
  paths: string[];
}

/**
 * The protocol reader, and with `spec` the client too. Without one it only
 * reads (a transcript, as `parser()` gives it): it sends nothing and asks
 * nothing.
 */
function codexProtocol(
  spec: CoderSessionSpec | null,
  io: CoderSessionIo,
  options: CoderParserOptions = {},
): CoderSession {
  const billed: Billed = options.billing ?? 'unknown';
  const worktree = options.worktreePath ?? spec?.worktreePath;
  let nextId = 1;
  /** Our requests in flight, by id: what each was. */
  const sent = new Map<number, string>();
  /** The server's approval requests in flight, by our request id: its JSON-RPC id. */
  const prompts = new Map<string, string | number>();
  const mcpPrompts = new Set<string>();
  const items = new Map<string, Started>();
  let threadId: string | undefined;
  /** The thread id when it is a UUID, the only kind reported. */
  let vendorId: string | undefined;
  let seen = false;
  let done = false;
  let lastMessage = '';
  let lastError: string | undefined;
  let usage: { first?: { input: number; output: number }; total?: Json } = {};

  const send = (message: Json) => {
    if (spec && !done) io.write(JSON.stringify(message));
  };
  const request = (method: string, params: Json) => {
    const id = nextId++;
    sent.set(id, method);
    send({ id, method, params });
  };

  /** Inside the worktree, a path reads relative to it. Worktrees live under `<repo>/.worktrees/<slug>`. */
  const relative = (path: string) => {
    const root = worktree?.replace(/\/+$/, '');
    if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
    const at = /\/\.worktrees\/[^/]+\//.exec(path);
    return at ? path.slice(at.index + at[0].length) : path;
  };

  const error = (message: string) => {
    const text = oneLine(message, 300);
    if (!text || text === lastError) return;
    lastError = text;
    io.emit({ type: 'error', message: text });
  };

  /** A `TurnError` as one line, with the code the runner reads when the words lack it. */
  const errorText = (value: unknown): string => {
    if (!isObject(value)) return '';
    const message = str(value.message) ?? '';
    const info = str(value.codexErrorInfo);
    return info && NAMED_ERRORS.has(info) ? `${message} (${info})` : message;
  };

  const finish = (ok: boolean, reason?: string) => {
    if (done) return;
    const vendor = vendorId ? { vendor_session_id: vendorId } : {};
    if (ok) io.emit({ type: 'result', ok: true, summary: lastMessage, ...vendor });
    else {
      const said = oneLine(reason || 'Codex did not finish', 300);
      io.emit({ type: 'result', ok: false, summary: said, ...vendor, error: said });
    }
    done = true;
  };

  const fail = (reason: string) => {
    const said = oneLine(reason || 'Codex stopped with an error', 300);
    error(said);
    finish(false, said);
  };

  const setThread = (id: unknown) => {
    const reported = str(id);
    if (!reported || threadId) return;
    threadId = reported;
    if (isVendorSessionId(reported)) vendorId = reported;
    else io.emit(ignoredId());
  };

  const sandboxPolicy = (s: CoderSessionSpec): Json => {
    const gitDir = gitDirOf(s);
    return sandboxFor(s) === 'read-only'
      ? { type: 'readOnly', networkAccess: false }
      : {
          type: 'workspaceWrite',
          writableRoots: gitDir ? [gitDir] : [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };
  };

  const threadParams = (s: CoderSessionSpec): Json => ({
    cwd: s.worktreePath,
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: APPROVALS_REVIEWER,
    sandbox: sandboxFor(s),
    ...(s.model ? { model: s.model } : {}),
  });

  const startThread = () => {
    if (spec) request('thread/start', threadParams(spec));
  };

  const startTurn = () => {
    if (!spec || !threadId) return;
    request('turn/start', {
      threadId,
      input: [{ type: 'text', text: `${preamble(spec)}\n\n${spec.prompt}`, text_elements: [] }],
      approvalPolicy: APPROVAL_POLICY,
      sandboxPolicy: sandboxPolicy(spec),
    });
  };

  function item(entry: Json) {
    switch (entry.type) {
      case 'agentMessage': {
        const text = str(entry.text)?.trim();
        if (!text) return;
        lastMessage = text;
        io.emit({ type: 'text', text });
        return;
      }
      case 'reasoning': {
        const parts = Array.isArray(entry.summary) ? entry.summary : [];
        const joined = parts.filter((p): p is string => typeof p === 'string').join(' ');
        const text = oneLine(joined.replace(/\*\*/g, ''));
        if (text) io.emit({ type: 'text', text: oneLine(`Thinking: ${text}`) });
        return;
      }
      case 'commandExecution': {
        const command = unwrapShell(str(entry.command) ?? '');
        const code = entry.exitCode;
        const exitCode = typeof code === 'number' && Number.isInteger(code) ? code : undefined;
        let summary: string | undefined;
        if (entry.status === 'declined') summary = 'Declined';
        else if (exitCode !== undefined && exitCode !== 0) {
          const last = (str(entry.aggregatedOutput) ?? '').trim().split('\n').pop()?.trim();
          if (last) summary = oneLine(last, 200);
        }
        io.emit({
          type: 'command',
          command,
          ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
          ...(summary ? { summary } : {}),
        });
        return;
      }
      case 'fileChange': {
        if (entry.status !== 'completed') return;
        for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
          if (!isObject(change)) continue;
          const path = str(change.path);
          if (!path) continue;
          const kind = isObject(change.kind) ? str(change.kind.type) : undefined;
          io.emit({
            type: 'file_change',
            path: relative(path),
            kind: CHANGE_KIND[kind ?? ''] ?? 'edit',
          });
        }
        return;
      }
      case 'mcpToolCall': {
        const server = str(entry.server) ?? 'mcp';
        const tool = str(entry.tool) ?? 'tool';
        const failed = isObject(entry.error) ? str(entry.error.message) : undefined;
        const args = entry.arguments === undefined ? '' : JSON.stringify(entry.arguments);
        const summary = failed ? `Failed: ${failed}` : args;
        io.emit({ type: 'tool_use', name: `${server}.${tool}`, summary: oneLine(summary, 200) });
        return;
      }
      case 'dynamicToolCall': {
        const name = [str(entry.namespace), str(entry.tool) ?? 'tool'].filter(Boolean).join('.');
        io.emit({ type: 'tool_use', name, summary: '' });
        return;
      }
      case 'webSearch':
        io.emit({
          type: 'tool_use',
          name: 'web_search',
          summary: oneLine(str(entry.query) ?? '', 200),
        });
        return;
      case 'collabAgentToolCall':
        io.emit({ type: 'tool_use', name: str(entry.tool) ?? 'collab', summary: '' });
        return;
      default:
        // `userMessage`, `plan`, `contextCompaction` and anything newer.
        return;
    }
  }

  /** What `item/started` says, for the approval that may follow it. */
  function remember(entry: Json) {
    const id = str(entry.id);
    if (!id) return;
    if (entry.type === 'commandExecution') {
      items.set(id, { command: str(entry.command) ?? '', paths: [] });
    } else if (entry.type === 'fileChange') {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      const paths = changes
        .map((c) => (isObject(c) ? str(c.path) : undefined))
        .filter((p): p is string => !!p);
      items.set(id, { paths });
    }
  }

  function usageEvent(): CoderEvent | null {
    const total = usage.total;
    if (!total) return null;
    // A resumed thread's total counts its earlier turns: what came before
    // this process's first model call is taken off.
    const base = usage.first ?? { input: 0, output: 0 };
    return {
      type: 'usage',
      // OpenAI counts cached input inside `inputTokens`.
      input_tokens: Math.max(0, num(total.inputTokens) - base.input),
      output_tokens: Math.max(0, num(total.outputTokens) - base.output),
      billed,
    };
  }

  function notification(method: string, params: Json) {
    switch (method) {
      case 'thread/started':
        if (isObject(params.thread)) setThread(params.thread.id);
        return;
      case 'item/started':
        if (isObject(params.item)) remember(params.item);
        return;
      case 'item/completed':
        if (isObject(params.item)) item(params.item);
        return;
      case 'thread/tokenUsage/updated': {
        const tokens = isObject(params.tokenUsage) ? params.tokenUsage : {};
        const total = isObject(tokens.total) ? tokens.total : undefined;
        const last = isObject(tokens.last) ? tokens.last : {};
        if (!total) return;
        usage.first ??= {
          input: Math.max(0, num(total.inputTokens) - num(last.inputTokens)),
          output: Math.max(0, num(total.outputTokens) - num(last.outputTokens)),
        };
        usage.total = total;
        return;
      }
      case 'error':
        // `willRetry`: Codex reconnects on its own; only the last one counts.
        if (params.willRetry !== true) error(errorText(params.error));
        return;
      case 'turn/completed': {
        const turn = isObject(params.turn) ? params.turn : {};
        const counted = usageEvent();
        if (counted) io.emit(counted);
        usage = {};
        if (turn.status === 'completed') return finish(true);
        if (turn.status === 'interrupted') return fail('Codex was interrupted');
        return fail(errorText(turn.error) || 'Codex stopped with an error');
      }
      default:
        // `turn/started`, `thread/status/changed`, `warning` (the transport
        // fallback), `remoteControl/status/changed` and the rest.
        return;
    }
  }

  function serverRequest(id: string | number, method: string, params: Json) {
    if (!spec || done) return;
    const requestId = `codex-${typeof id === 'number' ? id : id.replace(/[^\w.-]/g, '')}`;
    const context = worktree ? { worktreePath: worktree } : undefined;
    if (method === 'item/commandExecution/requestApproval') {
      const started = items.get(str(params.itemId) ?? '');
      const command = str(params.command) ?? started?.command ?? '';
      const reason = str(params.reason);
      const network = isObject(params.networkApprovalContext)
        ? str(params.networkApprovalContext.host)
        : undefined;
      let verdict = classify('commandExecution', { command }, context);
      if (params.kind === 'writeStdin') {
        verdict = { ...verdict, title: `Type into: ${oneLine(unwrapShell(command), 200)}` };
      }
      if (network) {
        verdict = {
          ...verdict,
          action: strictest(verdict.action, 'install'),
          title: `Reach ${network} over the network: ${oneLine(unwrapShell(command), 160)}`,
        };
      }
      prompts.set(requestId, id);
      io.approval({
        request_id: requestId,
        tool_name: 'commandExecution',
        input: {
          command: unwrapShell(command),
          ...(str(params.cwd) ? { cwd: str(params.cwd) } : {}),
          ...(reason ? { reason } : {}),
          ...(network ? { network } : {}),
        },
        action: verdict.action,
        title: verdict.title,
        ...(reason || verdict.detail ? { detail: oneLine(reason ?? verdict.detail!, 300) } : {}),
      });
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      const started = items.get(str(params.itemId) ?? '');
      const reason = str(params.reason);
      const root = str(params.grantRoot);
      const paths = [...(started?.paths ?? []), ...(root ? [root] : [])];
      const verdict = classify('fileChange', { changes: paths.map((path) => ({ path })) }, context);
      prompts.set(requestId, id);
      io.approval({
        request_id: requestId,
        tool_name: 'fileChange',
        input: { paths, ...(reason ? { reason } : {}), ...(root ? { grantRoot: root } : {}) },
        action: verdict.action,
        title: verdict.title,
        ...(reason ? { detail: oneLine(reason, 300) } : {}),
      });
      return;
    }
    // Codex Apps uses MCP elicitation for tool approval, not command approval.
    // Only handle the known, empty confirmation form: never fabricate form answers.
    const meta = isObject(params._meta) ? params._meta : {};
    const schema = isObject(params.requestedSchema) ? params.requestedSchema : {};
    if (
      method === 'mcpServer/elicitation/request' &&
      params.mode === 'form' &&
      meta.codex_approval_kind === 'mcp_tool_call' &&
      meta.tool_title === 'create_pull_request' &&
      schema.type === 'object' &&
      isObject(schema.properties) &&
      Object.keys(schema.properties).length === 0 &&
      (!Array.isArray(schema.required) || schema.required.length === 0)
    ) {
      const args = isObject(meta.tool_params) ? meta.tool_params : {};
      prompts.set(requestId, id);
      mcpPrompts.add(requestId);
      io.approval({
        request_id: requestId,
        tool_name: `${str(params.serverName) ?? 'mcp'}.create_pull_request`,
        input: args,
        action: 'pr',
        title: 'Create pull request',
        detail: oneLine(
          [
            str(args.repository_full_name),
            str(args.title),
            str(args.head) && str(args.base) ? `${str(args.head)} → ${str(args.base)}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          1000,
        ),
      });
      return;
    }
    // Anything else (a question for the user, an MCP elicitation, a tool the
    // client would run, a token refresh): not served, so Codex carries on
    // without it rather than waiting.
    send({ id, error: { code: NOT_SERVED, message: `OpenBots does not answer ${method}` } });
  }

  function response(id: number, message: Json) {
    const method = sent.get(id);
    if (!method) return;
    sent.delete(id);
    const result = isObject(message.result) ? message.result : undefined;
    const failed = isObject(message.error) ? (str(message.error.message) ?? 'error') : undefined;
    switch (method) {
      case 'initialize':
        if (failed || !result) return fail(`Codex refused to start: ${failed ?? 'no answer'}`);
        send({ method: 'initialized' });
        if (spec?.resumeId && isVendorSessionId(spec.resumeId)) {
          request('thread/resume', {
            threadId: spec.resumeId,
            excludeTurns: true,
            ...threadParams(spec),
          });
        } else startThread();
        return;
      case 'thread/resume':
        if (failed || !result || !isObject(result.thread)) {
          // The earlier thread is gone (`no rollout found`): a new one, said so.
          io.emit({
            type: 'text',
            text: oneLine(
              `Codex could not continue its earlier thread (${failed ?? 'no thread'}), so it starts a new one`,
            ),
          });
          return startThread();
        }
        setThread(result.thread.id);
        return startTurn();
      case 'thread/start':
        if (failed || !result || !isObject(result.thread)) {
          return fail(`Codex could not start a thread: ${failed ?? 'no thread'}`);
        }
        setThread(result.thread.id);
        return startTurn();
      case 'turn/start':
        if (failed) fail(`Codex could not start the turn: ${failed}`);
        return;
      default:
        return;
    }
  }

  if (spec) {
    request('initialize', {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: OPTED_OUT,
      },
    });
  }

  return {
    onLine(text) {
      const trimmed = text.trim();
      if (!trimmed.startsWith('{')) return;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!isObject(message)) return;
      seen = true;
      const method = str(message.method);
      const id = message.id;
      const params = isObject(message.params) ? message.params : {};
      if (method && (typeof id === 'number' || typeof id === 'string')) {
        return serverRequest(id, method, params);
      }
      if (method) {
        if (!done) notification(method, params);
        return;
      }
      if (typeof id === 'number' && !done) response(id, message);
    },
    answer(requestId, decision) {
      const id = prompts.get(requestId);
      if (id === undefined) return;
      prompts.delete(requestId);
      if (mcpPrompts.delete(requestId)) {
        send({
          id,
          result: {
            action: decision === 'allow' ? 'accept' : 'decline',
            content: decision === 'allow' ? {} : null,
          },
        });
        return;
      }
      // Codex takes a decision only; the owner's words stay in OpenBots.
      send({ id, result: { decision: decision === 'allow' ? 'accept' : 'decline' } });
    },
    end() {
      if (done || !seen) return;
      finish(false, lastError ?? 'Codex did not finish');
    },
  };
}

/** A live `app-server` session for the runner (`transport: 'jsonrpc'`). */
export function codexSession(
  spec: CoderSessionSpec,
  io: CoderSessionIo,
  options?: CoderParserOptions,
): CoderSession {
  return codexProtocol(spec, io, options);
}

/**
 * A reader over an `app-server` transcript: the events a session would emit
 * from it, with nothing sent and nothing asked.
 */
export function codexParser(options: CoderParserOptions = {}): CoderOutputParser {
  let out: CoderEvent[] = [];
  const reader = codexProtocol(
    null,
    { write: () => {}, emit: (event) => out.push(event), approval: () => {} },
    options,
  );
  const take = () => {
    const events = out;
    out = [];
    return events;
  };
  return {
    line(text) {
      reader.onLine(text);
      return take();
    },
    end() {
      reader.end();
      return take();
    },
  };
}

// Signing in

const LOGIN_URL = /https:\/\/[^\s"'<>]+/;
/** `1PVB-90DS9`: four and five capitals or digits. */
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
const SIGNED_IN = /(?<!not )logged in|login successful|\bsuccess/i;
const LOGIN_ERROR = /^.*\b(?:denied|expired)\b.*$/im;

function parseLogin(chunk: string, state: CoderLoginParse): CoderLoginParse {
  const text = stripAnsi(chunk);
  const next: CoderLoginParse = { ...state, awaitingCode: false };
  if (!next.url) {
    const url = LOGIN_URL.exec(text)?.[0].replace(/[).,;]+$/, '');
    if (url) next.url = url;
  }
  if (!next.deviceCode) {
    const code = DEVICE_CODE.exec(text)?.[0];
    if (code) next.deviceCode = code;
  }
  if (SIGNED_IN.test(text)) {
    next.signedIn = true;
    if (/Logged in using ChatGPT/i.test(text)) next.accountLabel = 'ChatGPT';
  }
  const error = LOGIN_ERROR.exec(text)?.[0];
  if (error && !next.signedIn) next.error = oneLine(error, 300);
  return next;
}

// Classifying permission prompts
//
// A command approval is read as a shell command line and a file change as an
// edit of each path (classify.ts), the strictest winning.

const COMMAND_TOOLS = new Set(['command_execution', 'commandExecution', 'exec_command', 'shell']);
const FILE_TOOLS = new Set(['file_change', 'fileChange', 'apply_patch']);

function classify(
  toolName: string,
  input: unknown,
  context?: { worktreePath: string },
): ReturnType<CoderAdapter['classify']> {
  const args = isObject(input) ? input : {};
  if (COMMAND_TOOLS.has(toolName)) {
    const raw = Array.isArray(args.command)
      ? args.command.filter((w): w is string => typeof w === 'string').join(' ')
      : (str(args.command) ?? '');
    return classifyCommandLine(unwrapShell(raw), context?.worktreePath);
  }
  if (FILE_TOOLS.has(toolName)) {
    const changes = Array.isArray(args.changes) ? args.changes : [];
    const paths = [
      str(args.path),
      ...changes.map((c) => (isObject(c) ? str(c.path) : undefined)),
    ].filter((p): p is string => !!p);
    const root = context?.worktreePath.replace(/\/+$/, '');
    const shown = paths.map((p) =>
      root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p,
    );
    let verdict: ReturnType<CoderAdapter['classify']> = {
      action: 'other',
      title: shown.length ? oneLine(`Edit ${shown.join(', ')}`, 200) : 'Change files',
    };
    for (const path of paths) {
      const one = classifyPathAccess('Edit', path, context?.worktreePath);
      if (one && CLASS_RANK[one.action] > CLASS_RANK[verdict.action]) verdict = one;
    }
    return verdict;
  }
  return { action: 'other', title: `Use ${toolName}` };
}

// What Codex says when it is not signed in, or its sign-in lapsed.
const NOT_SIGNED_IN =
  /not logged in|\b401\b|unauthorized|codex login|please (?:log|sign) ?in|login (?:required|expired)/i;

/** The feed line a Codex session starts with: how its sandbox and its approvals work. */
export const CODEX_POSTURE =
  'Codex works inside its own sandbox with no network and asks before it steps outside it; OpenBots still gates pushes.';

/** What the owner sees when Codex's sign-in is refused by OpenAI (a 401); the raw text is logged. */
export const CODEX_SIGN_IN_REFUSED =
  'Codex could not sign in to OpenAI. Sign in again under Settings > Coding agents.';

/** OpenAI's 429, in Codex's words or the API's (`rate_limit_exceeded`). */
const RATE_LIMITED = /\b429\b|rate[ _-]?limit|too many requests/i;

export const codexAdapter: CoderAdapter = {
  agent: 'codex',
  command: 'codex',
  versionArgs: ['--version'],
  signIn: {
    kind: 'pty',
    instructions: 'Open this link on any device, sign in to ChatGPT and enter the code shown here.',
    hosts: ['auth.openai.com', 'chatgpt.com', 'openai.com', 'platform.openai.com'],
    // Device code sign-in: a link and a code to enter there; nothing is pasted back.
    login: () => ({ command: 'codex', args: ['login', '--device-auth'], timeoutMs: 15 * 60_000 }),
    parseLogin,
  },
  launch,
  parser: (options) => codexParser(options),
  transport: 'jsonrpc',
  session: (spec, io, options) => codexSession(spec, io, options),
  // Only a UUID reaches the terminal's preset.
  resumeCommand: (vendorSessionId) =>
    isVendorSessionId(vendorSessionId) ? `codex resume ${vendorSessionId}` : 'codex',
  classify,
  needsLogin: (text) => NOT_SIGNED_IN.test(text),
  rateLimited: (text) => RATE_LIMITED.test(text),
  posture: CODEX_POSTURE,
  signInRefused: CODEX_SIGN_IN_REFUSED,
  checkSignIn: async (ctx) => {
    const done = await ctx.run(['login', 'status']);
    if (!done) return null;
    return done.code === 0 ? codexStatus(`${done.stdout}\n${done.stderr}`) : { signedIn: false };
  },
};
