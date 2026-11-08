import { CODER_PI_EXTENSION } from '@openbots/computer';
import { CODER_MODE_ENV, type CoderEvent } from '@openbots/shared';
import { classifyCommandLine, classifyPathAccess } from './classify.js';
import {
  gitIdentityEnv,
  ignoredId,
  isObject,
  num,
  oneLine,
  preamble,
  str,
  type Json,
} from './common.js';
import {
  isVendorSessionId,
  type CoderCheckContext,
  type CoderAdapter,
  type CoderLaunchPlan,
  type CoderOutputParser,
  type CoderParserOptions,
  type CoderSessionSpec,
  type CoderSignInCheck,
} from './types.js';

// pi (docs/TECHNICAL_PLAN.md 22.13; I10, I11), checked against the pinned
// 1.5.0 (docs/CODING_AGENT_VENDORS.md). The session runs `pi -p --mode json`, one JSON
// event per line: a `session` header with the session id, then agent, turn,
// message and tool execution events. A finished assistant message arrives
// whole in `message_end`; its `stopReason` says how the run ended, and pi
// exits 0 even when the provider refused it, so the outcome is read from the
// stream, never from the exit code.
//
// pi has no sandbox and no approval mode. Its one gate is an extension's
// `tool_call` hook: the launch loads only the OpenBots extension
// (`--no-extensions -e CODER_PI_EXTENSION`), which relays every tool call over
// the session socket the way the Claude Code permission MCP server does, and
// `classify` below turns each into an action class. `--no-mcp` and the
// `--tools` allowlist keep the tools to pi's own, so nothing reaches past the
// hook; `--no-approve` ignores the repository's own `.pi/` settings.
//
// Sessions: `--session-id <id>` opens the worktree's session with that id or
// creates it, so the first run and a continued one pass the same flag and the
// same id (`--session-id` cannot be combined with `--session` or
// `--continue`). The session file lives under the coder's PI_CODING_AGENT_DIR
// on the state volume, which outlives the session directory. The id is the
// OpenBots session id, a UUID, so it passes `isVendorSessionId` like the
// other agents' ids. The owner takes over with `pi --session <id>`, which
// opens it in its own working directory.

/** pi's built in tools: the only ones a session may use. */
const EDIT_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
/** What a plan session may use; the extension also blocks the rest in plan mode. */
const PLAN_TOOLS = ['read', 'grep', 'find', 'ls'];

/**
 * pi's provider ids for the provider kinds whose key it reads from the
 * environment (`coderProviderEnv`), as `pi --list-models` lists them.
 */
export const PI_PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  xai: 'xai',
};

/**
 * `--model`, and for an `api_key` account `--provider` too, so the model is
 * looked up at the provider whose key the session has. pi refuses
 * `--provider` without `--model`, so with no override neither is passed and
 * pi picks a model it has a credential for: the one key in the environment.
 * A bare model name gets the provider's prefix (`anthropic/claude-sonnet-4-5`).
 */
function modelArgs(spec: CoderSessionSpec): string[] {
  if (!spec.model) return [];
  const provider = spec.apiKeyProvider ? PI_PROVIDERS[spec.apiKeyProvider] : undefined;
  if (!provider) return ['--model', spec.model];
  const model = spec.model.startsWith(`${provider}/`) ? spec.model : `${provider}/${spec.model}`;
  return ['--provider', provider, '--model', model];
}

function launch(spec: CoderSessionSpec): CoderLaunchPlan {
  const sessionId =
    spec.resumeId && isVendorSessionId(spec.resumeId) ? spec.resumeId : spec.sessionId;
  const args = [
    '-p',
    '--mode',
    'json',
    '--session-id',
    sessionId,
    '--no-extensions',
    '-e',
    CODER_PI_EXTENSION,
    '--no-mcp',
    '--no-approve',
    '--tools',
    (spec.mode === 'plan' ? PLAN_TOOLS : EDIT_TOOLS).join(','),
    ...modelArgs(spec),
    // The prompt is positional; `--` keeps a prompt that starts with a dash
    // from reading as an option.
    '--',
    `${preamble(spec)}\n\n${spec.prompt}`,
  ];
  const env: Record<string, string> = {
    // The extension reads the mode from it (coder-pi-extension.ts).
    [CODER_MODE_ENV]: spec.mode,
    // The CLI is pinned in the image; it must not ask pi.dev for a newer one.
    PI_SKIP_VERSION_CHECK: '1',
    ...gitIdentityEnv(spec),
  };
  return { command: 'pi', args, env };
}

// Parsing `--mode json`

/** How pi's bash tool words a command that failed. */
const EXIT_CODE = /(?:exit(?:ed with)? code|exit status)[:\s]+(\d+)/i;

/** The lines a unified diff adds and removes. */
function diffCounts(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** A tool result's text blocks, joined. */
function resultText(result: unknown): string {
  const content = isObject(result) ? result.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isObject(block) && block.type === 'text' ? (str(block.text) ?? '') : ''))
    .join('\n');
}

/** The line a tool call shows in the feed. */
function toolSummary(input: Json): string {
  for (const key of ['path', 'pattern', 'query', 'url']) {
    const value = str(input[key]);
    if (value) return oneLine(value, 200);
  }
  return oneLine(JSON.stringify(input), 200);
}

/** Why a run that did not stop cleanly ended, from the last assistant message. */
function failure(stopReason: string | undefined, errorMessage: string | undefined): string {
  if (stopReason === 'error')
    return errorMessage ? oneLine(errorMessage, 300) : 'pi stopped with an error';
  if (stopReason === 'aborted') return 'pi was stopped before it finished';
  if (stopReason === 'length') return "The reply reached the model's output limit";
  return 'pi did not finish';
}

/** One parser per process: it keeps the session id, the usage and the open tool calls. */
export function piParser(options: CoderParserOptions = {}): CoderOutputParser {
  // pi reports cost, but not whether a plan or API credits paid for it: the
  // account's `auth_kind` says, which the runner passes in.
  const billed = options.billing ?? 'unknown';
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let started = false;
  let finished = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | undefined;
  /** The last assistant message's outcome and text. */
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let lastText = '';
  /** Tool calls by id, so a result can name its command or file. */
  const calls = new Map<string, { name: string; args: Json }>();

  const relative = (path: string) =>
    cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;

  function assistant(message: Json): CoderEvent[] {
    const events: CoderEvent[] = [];
    const usage = isObject(message.usage) ? message.usage : {};
    inputTokens += num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
    outputTokens += num(usage.output);
    const total = isObject(usage.cost) ? usage.cost.total : undefined;
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
      cost = (cost ?? 0) + total;
    }
    stopReason = str(message.stopReason);
    errorMessage = str(message.errorMessage);
    const texts: string[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block)) continue;
      // `thinking` blocks are the model's raw reasoning: not shown.
      if (block.type === 'text') {
        const text = str(block.text)?.trim();
        if (text) {
          texts.push(text);
          events.push({ type: 'text', text });
        }
        continue;
      }
      if (block.type !== 'toolCall') continue;
      const name = str(block.name) ?? 'tool';
      const args = isObject(block.arguments) ? block.arguments : {};
      const id = str(block.id);
      if (id) calls.set(id, { name, args });
      if (name === 'bash') {
        events.push({ type: 'command', command: str(args.command) ?? '' });
      } else if (name !== 'edit' && name !== 'write') {
        // Edits and writes show once they ran (`tool_execution_end`), with their counts.
        events.push({ type: 'tool_use', name, summary: toolSummary(args) });
      }
    }
    lastText = texts.join('\n\n');
    return events;
  }

  function toolEnd(line: Json): CoderEvent[] {
    const id = str(line.toolCallId);
    const call = id ? calls.get(id) : undefined;
    if (id) calls.delete(id);
    const name = str(line.toolName) ?? call?.name;
    const args = call?.args ?? {};
    const failed = line.isError === true;
    if (name === 'bash') {
      // A command that worked needs no second line; a failed one says how.
      if (!failed) return [];
      const text = resultText(line.result).trim();
      const code = EXIT_CODE.exec(text);
      const first = text.split('\n').find((l) => l.trim() && !EXIT_CODE.test(l));
      return [
        {
          type: 'command',
          command: str(args.command) ?? '',
          ...(code ? { exit_code: Number(code[1]) } : {}),
          ...(first ? { summary: oneLine(first, 200) } : {}),
        },
      ];
    }
    if ((name === 'edit' || name === 'write') && !failed) {
      const path = relative(str(args.path) ?? '');
      if (name === 'write') return [{ type: 'file_change', path, kind: 'create' }];
      const details = isObject(line.result) ? line.result.details : undefined;
      const patch = isObject(details) ? str(details.patch) : undefined;
      return [{ type: 'file_change', path, kind: 'edit', ...(patch ? diffCounts(patch) : {}) }];
    }
    return [];
  }

  function result(): CoderEvent[] {
    finished = true;
    const ok = stopReason === 'stop';
    const why = failure(stopReason, errorMessage);
    return [
      {
        type: 'usage',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cost !== undefined ? { cost_usd: cost } : {}),
        billed,
      },
      {
        type: 'result',
        ok,
        summary: lastText || (ok ? '' : why),
        ...(sessionId ? { vendor_session_id: sessionId } : {}),
        ...(ok ? {} : { error: why }),
      },
    ];
  }

  return {
    line(text) {
      const trimmed = text.trim();
      if (!trimmed.startsWith('{')) return [];
      let line: unknown;
      try {
        line = JSON.parse(trimmed);
      } catch {
        return [];
      }
      if (!isObject(line)) return [];
      switch (line.type) {
        case 'session': {
          cwd = str(line.cwd) ?? cwd;
          const reported = str(line.id);
          if (reported === undefined) return [];
          if (!isVendorSessionId(reported)) return [ignoredId()];
          sessionId = reported;
          return [];
        }
        case 'agent_start':
          started = true;
          return [];
        case 'message_end': {
          const message = isObject(line.message) ? line.message : undefined;
          return message?.role === 'assistant' ? assistant(message) : [];
        }
        case 'tool_execution_end':
          return toolEnd(line);
        case 'agent_end':
          return finished ? [] : result();
        default:
          return [];
      }
    },
    // A run that started but never ended (killed, or crashed) still reports;
    // one that never started (no credential: the reason is on stderr) leaves
    // the outcome to the exit code.
    end: () => (started && !finished ? result() : []),
  };
}

// Classifying tool calls
//
// Every tool call reaches OpenBots through the extension, in pi's terms.
// classify.ts reads a command the way the shell would and resolves paths
// against the worktree; pi's file tools are read as the access they make.

/** pi's file tools and the Claude Code tool each one is classed as. */
const PATH_TOOLS: Record<string, 'Read' | 'Edit' | 'Write'> = {
  read: 'Read',
  grep: 'Read',
  find: 'Read',
  ls: 'Read',
  edit: 'Edit',
  write: 'Write',
};

function classify(
  toolName: string,
  input: unknown,
  context?: { worktreePath: string },
): ReturnType<CoderAdapter['classify']> {
  const args = isObject(input) ? input : {};
  if (toolName === 'bash') {
    return classifyCommandLine(str(args.command) ?? '', context?.worktreePath);
  }
  const as = Object.hasOwn(PATH_TOOLS, toolName) ? PATH_TOOLS[toolName] : undefined;
  if (as) {
    // grep, find and ls default to the working directory, the worktree.
    const path = str(args.path);
    const verdict = path ? classifyPathAccess(as, path, context?.worktreePath) : null;
    if (verdict) return verdict;
    const target = path ?? str(args.pattern);
    return {
      action: 'other',
      title: target ? `${toolName}: ${oneLine(target, 200)}` : `Use ${toolName}`,
    };
  }
  return { action: 'other', title: `Use ${toolName}` };
}

// Signing in
//
// pi has no headless login: `/login` runs in its own terminal UI, so the
// owner signs in from the computer's terminal and the Settings card checks
// with `pi auth check`.

/** What the owner is told, on the sign-in widget and with the 409. */
export const PI_SIGN_IN_INSTRUCTIONS =
  'pi signs in from its own terminal. Open the Computer page, run pi, type /login and choose a provider. Then press Check under Settings > Models.';

/**
 * The providers `pi auth check --provider <id> --json` is asked about: pi's
 * built-in providers (`getBuiltinProviders()` of the pinned pi-ai), with the
 * name the card shows, and the plan an OAuth sign-in to it is (`plan`). An id
 * pi does not know answers `provider_not_found`.
 */
export const PI_CHECK_PROVIDERS: { id: string; label: string; plan?: string }[] = [
  { id: 'anthropic', label: 'Anthropic', plan: 'Anthropic (Claude Pro/Max)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openai-codex', label: 'OpenAI', plan: 'OpenAI (ChatGPT Plus/Pro)' },
  { id: 'google', label: 'Google Gemini' },
  { id: 'google-vertex', label: 'Google Vertex AI' },
  { id: 'xai', label: 'xAI', plan: 'xAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'github-copilot', label: 'GitHub Copilot' },
  { id: 'amazon-bedrock', label: 'Amazon Bedrock' },
  { id: 'azure', label: 'Azure OpenAI' },
  { id: 'ant-ling', label: 'Ant Ling' },
  { id: 'baseten', label: 'Baseten' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'cloudflare-ai-gateway', label: 'Cloudflare AI Gateway' },
  { id: 'cloudflare-workers-ai', label: 'Cloudflare Workers AI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'fireworks', label: 'Fireworks' },
  { id: 'groq', label: 'Groq' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'kimi-coding', label: 'Kimi For Coding' },
  { id: 'meta', label: 'Meta' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'minimax-cn', label: 'MiniMax (China)' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'moonshotai', label: 'Moonshot AI' },
  { id: 'moonshotai-cn', label: 'Moonshot AI (China)' },
  { id: 'nvidia', label: 'NVIDIA NIM' },
  { id: 'opencode', label: 'OpenCode Zen' },
  { id: 'opencode-go', label: 'OpenCode Go' },
  { id: 'qwen-token-plan', label: 'Qwen Token Plan' },
  { id: 'qwen-token-plan-cn', label: 'Qwen Token Plan (China)' },
  { id: 'qwen-token-plan-individual', label: 'Qwen Token Plan Individual' },
  { id: 'radius', label: 'Radius' },
  { id: 'together', label: 'Together AI' },
  { id: 'typesafe', label: 'TypeSafe' },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway' },
  { id: 'xiaomi', label: 'Xiaomi MiMo' },
  { id: 'xiaomi-token-plan-ams', label: 'Xiaomi MiMo Token Plan (Amsterdam)' },
  { id: 'xiaomi-token-plan-cn', label: 'Xiaomi MiMo Token Plan (China)' },
  { id: 'xiaomi-token-plan-sgp', label: 'Xiaomi MiMo Token Plan (Singapore)' },
  { id: 'zai', label: 'ZAI Coding Plan' },
  { id: 'zai-coding-cn', label: 'ZAI Coding Plan (China)' },
];

/** How many `pi auth check` processes run at once. */
const PI_CHECK_PARALLEL = 6;

/**
 * What `pi auth check --provider <id> --json` says: `{status, provider,
 * authType}` with `status` `ready` when the provider has credentials, and
 * `authType` `oauth` (a plan sign-in through /login) or `api_key` (a key in
 * auth.json or the environment). Null when it is not ready.
 */
export function piCheckResult(stdout: string): { authType: string } | null {
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(text) as { status?: unknown; authType?: unknown };
      if (parsed.status !== 'ready') return null;
      return { authType: typeof parsed.authType === 'string' ? parsed.authType : 'unknown' };
    } catch {
      // Not the JSON line.
    }
  }
  return null;
}

/**
 * What pi's checks add up to: any OAuth sign-in is a plan (`subscription`,
 * named by its plans); otherwise ready keys are `api_key`, named by their
 * providers. No credential or status text is kept.
 */
export function piSignIn(
  ready: { provider: (typeof PI_CHECK_PROVIDERS)[number]; authType: string }[],
): CoderSignInCheck {
  const unique = (names: string[]) => [...new Set(names)].join(', ').slice(0, 200);
  const plans = ready.filter((r) => r.authType === 'oauth');
  if (plans.length) {
    return {
      signedIn: true,
      authKind: 'subscription',
      label: unique(plans.map((r) => r.provider.plan ?? r.provider.label)),
    };
  }
  if (!ready.length) return { signedIn: false };
  return {
    signedIn: true,
    authKind: 'api_key',
    label: `API key through pi (${unique(ready.map((r) => r.provider.label))})`.slice(0, 200),
  };
}

/** Asks pi about every provider of PI_CHECK_PROVIDERS, PI_CHECK_PARALLEL at a time. */
async function checkSignIn(ctx: CoderCheckContext): Promise<CoderSignInCheck> {
  const ready: { provider: (typeof PI_CHECK_PROVIDERS)[number]; authType: string }[] = [];
  for (let i = 0; i < PI_CHECK_PROVIDERS.length; i += PI_CHECK_PARALLEL) {
    const batch = PI_CHECK_PROVIDERS.slice(i, i + PI_CHECK_PARALLEL);
    const answers = await Promise.all(
      batch.map(async (provider) => {
        const done = await ctx
          .run(['auth', 'check', '--provider', provider.id, '--json'])
          .catch(() => null);
        const result = done ? piCheckResult(done.stdout) : null;
        return result ? { provider, authType: result.authType } : null;
      }),
    );
    for (const answer of answers) if (answer) ready.push(answer);
  }
  return piSignIn(ready);
}

/**
 * What pi says when it has no credential (`No API key found for ...`, then a
 * `/login` hint on stderr) or the provider refused the one it has (a 401 in
 * the assistant message's `errorMessage`).
 */
const NOT_SIGNED_IN =
  /no api key found|use \/login|not signed in|not logged in|credentials_not_configured|\b401\b|authentication_error|invalid (?:x-)?api[ -]key|unauthorized/i;

/** A provider's 429 in the last assistant message's `errorMessage` (`stopReason` error). */
const RATE_LIMITED = /\b429\b|rate[ _-]?limit|too many requests/i;

export const piAdapter: CoderAdapter = {
  agent: 'pi',
  command: 'pi',
  versionArgs: ['--version'],
  signIn: { kind: 'terminal', instructions: PI_SIGN_IN_INSTRUCTIONS, preset: 'pi' },
  launch,
  parser: (options) => piParser(options),
  // Only a UUID reaches the terminal's preset.
  resumeCommand: (vendorSessionId) =>
    isVendorSessionId(vendorSessionId) ? `pi --session ${vendorSessionId}` : 'pi',
  classify,
  needsLogin: (text) => NOT_SIGNED_IN.test(text),
  rateLimited: (text) => RATE_LIMITED.test(text),
  checkSignIn,
};
