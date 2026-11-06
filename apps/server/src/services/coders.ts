import { randomBytes } from 'node:crypto';
import type {
  CoderAccountView,
  CoderServices,
  CoderStarted,
  CoderStartInput,
  RepoRef,
} from '@openbots/agent';
import { CODER_CONFIG_DIRS, COMPUTER_HOME } from '@openbots/computer';
import {
  CODER_AGENT_LABELS,
  CODER_AGENTS,
  CODER_PROVIDER_KINDS,
  CODING_SESSION_ENDED,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  coderEnabled,
  coderProviderFits,
  resolveToolPolicy,
  type CoderAgent,
  type CoderAuthKind,
  type CoderChangedFile,
  type CoderCommit,
  type CoderControl,
  type CoderMode,
  type CoderUsage,
  type CodingSessionStatus,
  type RunSource,
} from '@openbots/shared';
import {
  validateWidgetProps,
  widgetKind,
  widgetToolResult,
  type CodingSessionAction,
  type CodingSessionProps,
  type CodingSessionState,
} from '@openbots/widgets';
import { and, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { recordAudit, userActor } from './audit.js';
import { adapterFor, hasCoderAdapter } from './coder-adapters/index.js';
import { publishCoderControl } from './coder-control.js';
import { enqueueCoderJob } from './coder-jobs.js';
import {
  coderVersion,
  completeTerminalLogins,
  moveRunToWaitingLogin,
  runAsCoder,
  startLogin,
  stripAnsi,
} from './coder-login.js';
import { resumeIfSessionEnded, resumeWaitingRun } from './coder-runner.js';
import { readSessionLog, removeSessionLog, settleSession } from './coder-state.js';
import type { BotRow } from './bots.js';
import { agentFor, computerAvailable, getComputer, startComputer } from './computer.js';
import { announceMessage, postUserMessage, storeMessage } from './messages.js';
import { allowedRepos, listRepos, reposForContext, toRepoRef } from './repos.js';
import type { WidgetActionContext } from './hooks.js';
import { actOnWidget } from './runs.js';

// Coding agents for the API and the runtime (design doc F2, F3, F7; I4, I9,
// I14). Settings > Coding agents reads one card per agent from
// `coder_accounts` (no row reads as not signed in), and signs an agent out
// by emptying its config directory on the computer as `coder`. `code_task`
// reaches this file through `coderServices`: `start` checks the Bot may code
// and has no session running, inserts the `coding_sessions` row (or reopens
// an ended one to continue it), posts the `coding_session` widget in the
// run's chat with the run waiting on it (`widget_states.pending_run_id`),
// and enqueues the runner's `session` job (services/coder-runner.ts), which
// does the rest. An agent that is not signed in gets the `coder_login`
// widget instead (services/coder-login.ts), and the run waits on that.
//
// The widget's actions come back through `onCodingSessionAction`, which the
// widget action path calls (services/runs.ts): Stop publishes on the coder
// control channel (a session nobody claimed yet is stopped here), Continue
// posts the owner's prompt as an owner message in the session's chat, so a
// run of the Bot continues it through `code_task` (with a run to ask the
// owner in and to hear the result), Discard removes the worktree, its branch
// and its log. The REST routes for the same go through that path too, so
// the widget and the row never disagree.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

export type CodingSessionRow = typeof schema.codingSessions.$inferSelect;
type AccountRow = typeof schema.coderAccounts.$inferSelect;

const SESSION_KIND = 'coding_session';

/** The statuses of a session that holds its Bot (one at a time) and a runner slot. */
export const CODING_SESSION_ACTIVE: CodingSessionStatus[] = [
  'queued',
  'starting',
  'running',
  'waiting',
];

const ended = (status: string) => CODING_SESSION_ENDED.includes(status as CodingSessionStatus);

// Accounts

/** One card of Settings > Coding agents. */
export interface CoderAccountInfo {
  agent: CoderAgent;
  /** The agent's name: "Claude Code". */
  label: string;
  authKind: CoderAuthKind;
  /** The account as the agent names it: an email, or the plan. */
  accountLabel: string | null;
  signedInAt: string | null;
  version: string | null;
  lastError: string | null;
  providerId: string | null;
  /** This build has an adapter for it (`hasCoderAdapter`). */
  available: boolean;
  /** Never signed in, or the sign-in lapsed: the card offers to sign in (again). */
  needsSignIn: boolean;
  /** What `lastError` is about, so the card can word it: a lapsed sign-in, a refused key, or else. */
  lastErrorKind: CoderLastErrorKind | null;
}

export type CoderLastErrorKind = 'sign_in' | 'key' | 'other';

/**
 * Whether the agent has to be signed in before a session can start: never
 * signed in, or the runner found its sign-in gone (F7, which sets
 * `last_error` to "… is not signed in on the computer").
 */
export function needsSignIn(account: Pick<CoderAccountInfo, 'authKind' | 'lastError'>): boolean {
  if (account.authKind === 'none') return true;
  // A provider's key has no sign-in to lapse; a bad key fails the session plainly.
  if (account.authKind === 'api_key') return false;
  return !!account.lastError && LAPSED_SIGN_IN.test(account.lastError);
}

/** What the runner writes to `last_error` when the agent's sign-in is gone. */
const LAPSED_SIGN_IN =
  /not signed in|needs_login|signed out|could not sign in|sign(?:ed)?[- ]?in (?:has )?(?:expired|lapsed)|sign in again|log ?in again|\b401\b|unauthori[sz]ed/i;

/** What a refused provider key reads like (the runner's text, or the vendor's 401). */
const KEY_REFUSED =
  /\bapi[ _-]?key\b|\bkey\b.*\b(?:rejected|refused|invalid|revoked|expired)\b|\b401\b|unauthori[sz]ed|authentication_error/i;

/**
 * What an account's `last_error` is about: `sign_in` when a plan sign-in
 * lapsed, `key` when an api_key account's key was refused (it has no sign-in
 * to lapse, so a "not signed in" there is the key too), `other` otherwise.
 */
export function lastErrorKind(
  account: Pick<CoderAccountInfo, 'authKind' | 'lastError'>,
): CoderLastErrorKind | null {
  const error = account.lastError;
  if (!error) return null;
  if (account.authKind === 'api_key') {
    return KEY_REFUSED.test(error) || LAPSED_SIGN_IN.test(error) ? 'key' : 'other';
  }
  return LAPSED_SIGN_IN.test(error) ? 'sign_in' : 'other';
}

function toAccountInfo(agent: CoderAgent, row: AccountRow | undefined): CoderAccountInfo {
  const authKind = (row?.authKind as CoderAuthKind | undefined) ?? 'none';
  const lastError = row?.lastError ?? null;
  return {
    agent,
    label: CODER_AGENT_LABELS[agent],
    authKind,
    accountLabel: row?.accountLabel ?? null,
    signedInAt: row?.signedInAt?.toISOString() ?? null,
    version: row?.version ?? null,
    lastError,
    providerId: row?.providerId ?? null,
    available: hasCoderAdapter(agent),
    needsSignIn: needsSignIn({ authKind, lastError }),
    lastErrorKind: lastErrorKind({ authKind, lastError }),
  };
}

/** Every agent of CODER_AGENTS, signed in or not, in one query. */
export async function listCoderAccounts(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
): Promise<CoderAccountInfo[]> {
  const rows = await deps.db
    .select()
    .from(schema.coderAccounts)
    .where(
      and(
        eq(schema.coderAccounts.ownerId, owner.id),
        eq(schema.coderAccounts.workspaceId, owner.workspaceId),
      ),
    );
  return CODER_AGENTS.map((agent) =>
    toAccountInfo(
      agent,
      rows.find((r) => r.agent === agent),
    ),
  );
}

/** How long Settings waits for the CLI's version before it shows the card without it. */
const VERSION_WAIT_MS = 5_000;
/** The computers (and agents) whose version was asked for already, in this process. */
const versionAsked = new Set<string>();

/**
 * Settings > Coding agents: the cards, with the CLI's version filled in
 * lazily. An available agent without one gets `versionArgs` run as `coder`
 * once per computer, and the answer is stored on `coder_accounts`. Only
 * while the computer runs: it is never started for this.
 */
export async function listCoderAccountsForSettings(
  deps: AppDeps,
  owner: Owner,
): Promise<CoderAccountInfo[]> {
  const accounts = await listCoderAccounts(deps, owner);
  const missing = accounts.filter((a) => a.available && a.version === null);
  if (!missing.length || !computerAvailable(deps)) return accounts;
  const computer = await getComputer(deps, owner);
  if (computer?.status !== 'running') return accounts;
  const asks = missing
    .filter((a) => {
      const key = `${computer.id}:${a.agent}`;
      if (versionAsked.has(key)) return false;
      versionAsked.add(key);
      return true;
    })
    .map(async (a) => {
      const version = await coderVersion(agentFor(deps, computer), a.agent).catch(() => null);
      if (!version) return;
      await upsertAccount(deps.db, owner, a.agent, { version });
      a.version = version;
    });
  if (!asks.length) return accounts;
  const all = Promise.all(asks).catch((error: unknown) =>
    deps.logger.warn({ err: error }, 'reading a coding agent version failed'),
  );
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      setTimeout(resolve, VERSION_WAIT_MS).unref();
    }),
  ]);
  return accounts;
}

export async function getCoderAccount(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  agent: CoderAgent,
): Promise<CoderAccountInfo> {
  return (await listCoderAccounts(deps, owner)).find((a) => a.agent === agent)!;
}

/** The runtime's view of an account (`CoderServices.accounts`). */
export function toAccountView(info: CoderAccountInfo): CoderAccountView {
  return {
    agent: info.agent,
    // A lapsed sign-in reads as none, so `code_task` asks for it again.
    authKind: needsSignIn(info) ? 'none' : info.authKind,
    ...(info.accountLabel ? { label: info.accountLabel } : {}),
  };
}

async function upsertAccount(
  db: Db,
  owner: Owner,
  agent: CoderAgent,
  set: Partial<typeof schema.coderAccounts.$inferInsert>,
) {
  await db
    .insert(schema.coderAccounts)
    .values({ workspaceId: owner.workspaceId, ownerId: owner.id, agent, ...set })
    .onConflictDoUpdate({
      target: [
        schema.coderAccounts.workspaceId,
        schema.coderAccounts.ownerId,
        schema.coderAccounts.agent,
      ],
      set: { ...set, updatedAt: new Date() },
    });
}

/**
 * Uses a Settings > Models provider's key for the agent instead of a plan
 * sign-in. The provider must be the owner's or the instance's (404 otherwise)
 * and one the agent can use (CODER_PROVIDER_KINDS; 400
 * CODER_PROVIDER_UNSUPPORTED otherwise).
 */
export async function setCoderApiKey(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  agent: CoderAgent,
  providerId: string,
): Promise<CoderAccountInfo> {
  const [provider] = await deps.db
    .select({ kind: schema.providers.kind, protocol: schema.providers.protocol })
    .from(schema.providers)
    .where(
      and(
        eq(schema.providers.id, providerId),
        eq(schema.providers.workspaceId, owner.workspaceId),
        or(isNull(schema.providers.ownerId), eq(schema.providers.ownerId, owner.id)),
      ),
    );
  if (!provider) throw notFound('Provider not found');
  if (!coderProviderFits(agent, provider)) {
    throw new DomainError(400, 'CODER_PROVIDER_UNSUPPORTED', CODER_PROVIDER_KINDS[agent].message);
  }
  await deps.db.transaction(async (tx) => {
    await upsertAccount(tx, owner, agent, {
      authKind: 'api_key',
      providerId,
      lastError: null,
    });
    await recordAudit(tx, {
      workspaceId: owner.workspaceId,
      actor: userActor(owner),
      action: 'coder.api_key',
      targetType: 'coder_account',
      targetId: null,
      metadata: { agent, providerId },
    });
  });
  return getCoderAccount(deps, owner, agent);
}

/**
 * Signs the agent out: its config directory on the computer is emptied as
 * `coder` (hidden files included; the computer starts if it has to), then the
 * card reads not signed in. Without a computer provider only the card changes.
 */
export async function signOutCoder(
  deps: AppDeps,
  owner: Owner,
  agent: CoderAgent,
): Promise<CoderAccountInfo> {
  if (computerAvailable(deps)) {
    const { computer } = await startComputer(deps, owner);
    const dir = CODER_CONFIG_DIRS[agent].dir;
    const done = await runAsCoder(agentFor(deps, computer), 'sh', [
      '-c',
      '[ -d "$0" ] || exit 0; find "$0" -mindepth 1 -delete',
      dir,
    ]);
    if (done.code !== 0) {
      const said = (done.error ?? done.stderr).trim().split('\n').pop() ?? '';
      throw new DomainError(
        502,
        'CODER_SIGN_OUT_FAILED',
        `Signing out on the computer did not finish${said ? `: ${said.slice(0, 300)}` : ''}`,
      );
    }
  }
  await deps.db.transaction(async (tx) => {
    await upsertAccount(tx, owner, agent, {
      authKind: 'none',
      accountLabel: null,
      signedInAt: null,
      providerId: null,
      lastError: null,
    });
    await recordAudit(tx, {
      workspaceId: owner.workspaceId,
      actor: userActor(owner),
      action: 'coder.sign_out',
      targetType: 'coder_account',
      targetId: null,
      metadata: { agent },
    });
  });
  return getCoderAccount(deps, owner, agent);
}

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
  { id: 'xai', label: 'xAI' },
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

/** How a check found the agent signed in: what the card stores. */
export interface CheckedSignIn {
  authKind: 'subscription' | 'api_key';
  accountLabel: string;
}

/**
 * What pi's checks add up to: any OAuth sign-in is a plan (`subscription`,
 * named by its plans); otherwise ready keys are `api_key`, named by their
 * providers. No credential or status text is kept.
 */
export function piSignIn(
  ready: { provider: (typeof PI_CHECK_PROVIDERS)[number]; authType: string }[],
): CheckedSignIn | null {
  const unique = (names: string[]) => [...new Set(names)].join(', ').slice(0, 200);
  const plans = ready.filter((r) => r.authType === 'oauth');
  if (plans.length) {
    return {
      authKind: 'subscription',
      accountLabel: unique(plans.map((r) => r.provider.plan ?? r.provider.label)),
    };
  }
  if (!ready.length) return null;
  return {
    authKind: 'api_key',
    accountLabel: `API key through pi (${unique(ready.map((r) => r.provider.label))})`.slice(
      0,
      200,
    ),
  };
}

/**
 * Reads `codex login status`: `Logged in using ChatGPT` is a plan sign-in;
 * any other `Logged in` line (an API key, an access token) is `api_key`,
 * VENDOR-FACTS.md. The line itself is never kept: it can hold a masked key.
 */
export function codexStatus(output: string): CheckedSignIn | null {
  const text = stripAnsi(output);
  if (/not logged in/i.test(text) || !/logged in/i.test(text)) return null;
  if (/Logged in using ChatGPT/i.test(text)) {
    return { authKind: 'subscription', accountLabel: 'ChatGPT' };
  }
  return { authKind: 'api_key', accountLabel: 'API key through Codex' };
}

/** Runs `fn` over `items`, `limit` at a time, in order. */
async function inBatches<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/**
 * `POST /coders/{agent}/check`: asks the CLI on the computer, as `coder`
 * with the agent's config directory, whether it is signed in (Codex: `codex
 * login status`; pi: `pi auth check --provider <id> --json` per
 * PI_CHECK_PROVIDERS). Signed in, the card says how (`subscription` for a
 * plan, `api_key` for a key the CLI holds itself, so no provider), the
 * account, now; pi's sign-ins a Bot is waiting on end signed in, and their
 * runs resume. Not signed in, the card is left as it was. Claude Code signs
 * in through the widget's driver only (400). The computer starts if it has to.
 */
export async function checkCoderSignIn(
  deps: AppDeps,
  owner: Owner,
  agent: CoderAgent,
): Promise<CoderAccountInfo> {
  if (agent === 'claude') {
    throw new DomainError(
      400,
      'CODER_CHECK_UNSUPPORTED',
      'Claude Code signs in from Settings with Sign in; there is nothing to check',
    );
  }
  // An agent this build cannot run answers CODER_UNSUPPORTED.
  adapterFor(agent);
  if (!computerAvailable(deps)) {
    throw new DomainError(503, 'COMPUTER_UNAVAILABLE', 'There is no computer to check on');
  }
  const { computer } = await startComputer(deps, owner);
  const client = agentFor(deps, computer);
  const config = CODER_CONFIG_DIRS[agent];
  const env = { [config.env]: config.dir };
  let found: CheckedSignIn | null;
  if (agent === 'codex') {
    const done = await runAsCoder(client, 'codex', ['login', 'status'], { env });
    found = done.code === 0 ? codexStatus(`${done.stdout}\n${done.stderr}`) : null;
  } else {
    const checked = await inBatches(PI_CHECK_PROVIDERS, PI_CHECK_PARALLEL, async (provider) => {
      const done = await runAsCoder(
        client,
        'pi',
        ['auth', 'check', '--provider', provider.id, '--json'],
        { env },
      ).catch(() => null);
      const result = done ? piCheckResult(done.stdout) : null;
      return result ? { provider, authType: result.authType } : null;
    });
    found = piSignIn(checked.filter((c) => c !== null));
  }
  if (found) {
    const signedIn = found;
    const version = await coderVersion(client, agent).catch(() => null);
    await deps.db.transaction(async (tx) => {
      await upsertAccount(tx, owner, agent, {
        authKind: signedIn.authKind,
        accountLabel: signedIn.accountLabel,
        signedInAt: new Date(),
        providerId: null,
        lastError: null,
        ...(version ? { version } : {}),
      });
      await recordAudit(tx, {
        workspaceId: owner.workspaceId,
        actor: userActor(owner),
        action: 'coder.sign_in',
        targetType: 'coder_account',
        targetId: null,
        metadata: { agent, checked: true, authKind: signedIn.authKind },
      });
    });
    // pi signs in in its terminal: the sign-ins Bots asked for end here.
    if (agent === 'pi') await completeTerminalLogins(deps, owner, agent, signedIn.accountLabel);
  }
  return getCoderAccount(deps, owner, agent);
}

// The runtime

/** The run `code_task` is called from. */
export interface CoderRun {
  bot: BotRow;
  runId: string;
  chatId: string;
  /** The thread the run answers in, where the widget goes too. */
  thread?: string | null;
  source: RunSource;
}

/** `ToolContext.coder` for one run. `repos` and `accounts` are one query each and start nothing. */
export function coderServices(deps: AppDeps, run: CoderRun): CoderServices {
  const owner = { id: run.bot.ownerId, workspaceId: run.bot.workspaceId };
  const policy = resolveToolPolicy(run.bot.toolPolicy);
  return {
    ...(policy.coder.defaultAgent ? { defaultAgent: policy.coder.defaultAgent } : {}),
    repos: async () => allowedRepos(await reposForContext(deps, owner), policy.coder.allowedRepos),
    accounts: async () => (await listCoderAccounts(deps, owner)).map(toAccountView),
    start: (input) => startCodingSession(deps, run, input),
  };
}

/** What context assembly tells the Bot about coding: its repositories and the agents. */
export async function coderContextFor(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  bot: Pick<BotRow, 'toolPolicy'>,
): Promise<{ repos: RepoRef[]; accounts: CoderAccountView[] }> {
  const policy = resolveToolPolicy(bot.toolPolicy);
  const [repos, accounts] = await Promise.all([
    reposForContext(deps, owner),
    listCoderAccounts(deps, owner),
  ]);
  return {
    repos: allowedRepos(repos, policy.coder.allowedRepos),
    accounts: accounts.map(toAccountView),
  };
}

/** A git ref name the runner can pass to git safely. */
const REF_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![/.])$/;

function checkRef(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  const ref = value.trim();
  if (!REF_NAME.test(ref) || ref.length > 255) {
    throw new DomainError(400, 'INVALID_BRANCH', `${what} ${value} is not a valid git branch name`);
  }
  return ref;
}

/** `bot/<the first five words of the prompt>-<4 random characters>`. */
export function sessionBranch(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `bot/${slug || 'task'}-${randomBytes(3).toString('hex').slice(0, 4)}`;
}

const excerpt = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const shortName = (fullName: string) => fullName.split('/').pop() ?? fullName;

const botBusy = (row: Pick<CodingSessionRow, 'id' | 'repoFullName'>) =>
  new DomainError(
    409,
    'CODER_BUSY',
    `You already have a coding session running${row.repoFullName ? ` on ${row.repoFullName}` : ''} (session ${row.id}). Wait for it to finish, or tell the owner; a Bot runs one coding session at a time.`,
  );

/**
 * `CoderServices.start`: checks, inserts or reopens the session, posts its
 * widget with the run waiting on it, and enqueues the runner. An agent that
 * is not signed in starts its sign-in instead, and the run waits on that.
 */
export async function startCodingSession(
  deps: AppDeps,
  run: CoderRun,
  input: CoderStartInput,
): Promise<CoderStarted> {
  const { bot } = run;
  const owner = { id: bot.ownerId, workspaceId: bot.workspaceId };
  const policy = resolveToolPolicy(bot.toolPolicy);
  if (!coderEnabled(policy)) {
    throw new DomainError(
      403,
      'CODER_DISABLED',
      'Coding agents are turned off for this Bot. The owner can turn them on in Bot Settings.',
    );
  }

  // Continuing: the session's own agent, repository and branch.
  const previous = input.session_id ? await ownSession(deps.db, owner, input.session_id) : null;
  if (previous && previous.botId !== bot.id) {
    throw new DomainError(403, 'SESSION_NOT_YOURS', 'That coding session belongs to another Bot.');
  }
  if (previous && !ended(previous.status)) {
    throw new DomainError(
      409,
      'SESSION_RUNNING',
      'That coding session is still running. Wait for it to finish before you continue it.',
    );
  }
  const agent = (previous?.agent as CoderAgent | undefined) ?? input.agent;
  // An agent this build cannot run answers CODER_UNSUPPORTED.
  if (!hasCoderAdapter(agent)) adapterFor(agent);
  const label = CODER_AGENT_LABELS[agent];

  const account = (await listCoderAccounts(deps, owner)).find((a) => a.agent === agent)!;
  if (needsSignIn(account)) {
    const login = await startLogin(deps, owner, agent, {
      botId: bot.id,
      runId: run.runId,
      chatId: run.chatId,
    });
    if (!login.posted) throw new Error('The sign-in widget was not posted');
    return {
      // The sign-in's id: there is no session until the agent is signed in.
      sessionId: login.login.id,
      kind: 'coder_login',
      posted: login.posted,
      label: `Waiting for sign-in: ${label}`,
      props: login.props,
    };
  }

  // The repository: the one continued, or one of the Bot's by id or full name.
  let repo: { id: string | null; fullName: string; remoteUrl: string | null; base: string };
  if (previous) {
    // The policy may have changed since the session began.
    if (
      !allowedRepos([{ full_name: previous.repoFullName ?? '' }], policy.coder.allowedRepos).length
    ) {
      throw new DomainError(
        403,
        'REPO_NOT_ALLOWED',
        `This Bot may not work on ${previous.repoFullName ?? 'that repository'} any more. The owner can allow it in Bot Settings.`,
      );
    }
    repo = {
      id: previous.repoId,
      fullName: previous.repoFullName ?? 'repository',
      remoteUrl: previous.remoteUrl,
      base: previous.base ?? 'main',
    };
  } else {
    const all = await listRepos(deps, owner);
    const wanted = input.repo
      .trim()
      .replace(/\.git$/, '')
      .toLowerCase();
    const match = all.find(
      (r) => r.repo.id === input.repo || r.repo.fullName.toLowerCase() === wanted,
    );
    if (!match) {
      throw new DomainError(
        404,
        'REPO_UNKNOWN',
        `${input.repo} is not one of the owner's repositories. Ask the owner to add it on the Computer page, under Repositories, then try again.`,
      );
    }
    if (!allowedRepos([toRepoRef(match)], policy.coder.allowedRepos).length) {
      throw new DomainError(
        403,
        'REPO_NOT_ALLOWED',
        `This Bot may not work on ${match.repo.fullName}. The owner can allow it in Bot Settings.`,
      );
    }
    repo = {
      id: match.repo.id,
      fullName: match.repo.fullName,
      remoteUrl: match.repo.remoteUrl,
      base: match.repo.defaultBranch,
    };
  }
  const branch =
    previous?.branch ?? checkRef(input.branch, 'Branch') ?? sessionBranch(input.prompt);
  const base = previous?.base ?? checkRef(input.base, 'Base') ?? repo.base;
  const mode: CoderMode = input.mode;

  const [chat] = await deps.db.select().from(schema.chats).where(eq(schema.chats.id, run.chatId));
  if (!chat) throw notFound('Chat not found');

  const done = await deps.db.transaction(async (tx) => {
    // One session per Bot: two calls at once see each other.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`coder-bot:${bot.id}`}))`);
    const [busy] = await tx
      .select()
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.botId, bot.id),
          inArray(schema.codingSessions.status, CODING_SESSION_ACTIVE),
          ...(previous ? [ne(schema.codingSessions.id, previous.id)] : []),
        ),
      )
      .limit(1);
    if (busy) throw botBusy(busy);
    const [{ n: running } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.ownerId, owner.id),
          eq(schema.codingSessions.workspaceId, owner.workspaceId),
          inArray(schema.codingSessions.status, CODING_SESSION_ACTIVE),
        ),
      );

    let session: CodingSessionRow;
    if (previous) {
      const [reopened] = await tx
        .update(schema.codingSessions)
        .set({
          status: 'queued',
          prompt: input.prompt,
          mode,
          runId: run.runId,
          chatId: chat.id,
          // An approved push was for the last prompt: this one asks again.
          pushAllowed: false,
          error: null,
          finishedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.codingSessions.id, previous.id),
            inArray(schema.codingSessions.status, [...CODING_SESSION_ENDED]),
          ),
        )
        .returning();
      if (!reopened) throw botBusy(previous);
      session = reopened;
    } else {
      const [inserted] = await tx
        .insert(schema.codingSessions)
        .values({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          botId: bot.id,
          runId: run.runId,
          chatId: chat.id,
          agent,
          repoId: repo.id,
          repoFullName: repo.fullName,
          remoteUrl: repo.remoteUrl,
          branch,
          base,
          mode,
          prompt: input.prompt,
          status: 'queued',
        })
        .returning();
      session = inserted!;
    }

    const checked = validateWidgetProps(SESSION_KIND, {
      session_id: session.id,
      agent,
      repo: repo.fullName,
      branch,
      base,
      mode,
      prompt_excerpt: excerpt(input.prompt, 300),
    } satisfies CodingSessionProps);
    if (!checked.ok) throw new Error(checked.error);
    const props = checked.value as CodingSessionProps;
    const initial = widgetKind(SESSION_KIND)!.initialState!(props) as CodingSessionState;
    const state: CodingSessionState =
      running >= DEFAULT_MAX_CONCURRENT_SESSIONS
        ? {
            ...initial,
            feed: [
              {
                t: new Date().toISOString(),
                type: 'text',
                text: `Queued: ${DEFAULT_MAX_CONCURRENT_SESSIONS} coding sessions are running; this one starts when one ends`,
              },
            ],
          }
        : initial;
    const message = await storeMessage(tx, chat, {
      authorType: 'bot',
      authorId: bot.id,
      ...(run.thread ? { threadRootId: run.thread } : {}),
      parts: [{ type: 'widget', kind: SESSION_KIND, props, state: initial }],
    });
    await tx.insert(schema.widgetStates).values({
      workspaceId: chat.workspaceId,
      messageId: message.id,
      partIndex: 0,
      state,
      pendingRunId: run.runId,
    });
    const [placed] = await tx
      .update(schema.codingSessions)
      .set({ messageId: message.id, partIndex: 0 })
      .where(eq(schema.codingSessions.id, session.id))
      .returning();
    if (repo.id) {
      await tx
        .update(schema.repos)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.repos.id, repo.id));
    }
    return { session: placed!, message, props };
  });

  await announceMessage(deps, done.message);
  await enqueueCoderJob(deps, { kind: 'session', sessionId: done.session.id });
  return {
    sessionId: done.session.id,
    kind: 'coding_session',
    posted: { messageId: done.message.id, partIndex: 0 },
    label: `Coding: ${shortName(repo.fullName)} with ${label}`,
    props: done.props,
  };
}

/**
 * A run paused on a coding widget posted by `code_task` (workers/runs.ts):
 * when what it waits on already ended before the pause, it resumes now. A
 * session's widget asks the runner's helper (unless a sign-in the runner
 * started lists the run: it waits on that instead); a sign-in's reads its state.
 */
export async function resumeIfCoderWidgetDone(
  deps: AppDeps,
  runId: string,
  posted: { messageId: string; partIndex: number },
  kind: string,
): Promise<void> {
  if (kind === SESSION_KIND) {
    // The runner found the agent signed out before the run paused: it waits on the sign-in.
    if (await moveRunToWaitingLogin(deps, runId)) return;
    const [session] = await deps.db
      .select({ id: schema.codingSessions.id })
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.messageId, posted.messageId),
          eq(schema.codingSessions.partIndex, posted.partIndex),
        ),
      );
    if (session) await resumeIfSessionEnded(deps, session.id);
    return;
  }
  const [stored] = await deps.db
    .select()
    .from(schema.widgetStates)
    .where(
      and(
        eq(schema.widgetStates.messageId, posted.messageId),
        eq(schema.widgetStates.partIndex, posted.partIndex),
      ),
    );
  const status = (stored?.state as { status?: string } | undefined)?.status;
  if (!status || status === 'pending' || status === 'awaiting_code') return;
  await resumeWaitingRun(deps, runId, widgetToolResult(kind, stored!.state), { waitMs: 0 });
}

/** The widget kinds a run started by `code_task` waits on. */
export const CODER_WIDGET_KINDS = new Set([SESSION_KIND, 'coder_login']);

// Sessions

/** A session as the API returns it. */
export interface CodingSessionView {
  id: string;
  botId: string;
  runId: string | null;
  chatId: string | null;
  messageId: string | null;
  partIndex: number | null;
  agent: CoderAgent;
  repoId: string | null;
  repoFullName: string | null;
  branch: string | null;
  base: string | null;
  mode: CoderMode;
  status: CodingSessionStatus;
  pushAllowed: boolean;
  vendorSessionId: string | null;
  usage: CoderUsage | null;
  summary: string | null;
  changedFiles: CoderChangedFile[];
  commits: CoderCommit[];
  prUrl: string | null;
  /** The Artifact holding the branch's diff against its base, once it settled with commits. */
  diffArtifactId: string | null;
  error: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export function toSessionView(row: CodingSessionRow): CodingSessionView {
  return {
    id: row.id,
    botId: row.botId,
    runId: row.runId,
    chatId: row.chatId,
    messageId: row.messageId,
    partIndex: row.partIndex,
    agent: row.agent as CoderAgent,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    branch: row.branch,
    base: row.base,
    mode: row.mode as CoderMode,
    status: row.status as CodingSessionStatus,
    pushAllowed: row.pushAllowed,
    vendorSessionId: row.vendorSessionId,
    usage: row.usage ?? null,
    summary: row.summary,
    changedFiles: row.changedFiles ?? [],
    commits: row.commits ?? [],
    prUrl: row.prUrl,
    diffArtifactId: row.diffArtifactId,
    error: row.error,
    worktreePath: row.worktreePath,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function ownSession(db: Db, owner: Owner, sessionId: string): Promise<CodingSessionRow> {
  const [row] = await db
    .select()
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.id, sessionId),
        eq(schema.codingSessions.ownerId, owner.id),
        eq(schema.codingSessions.workspaceId, owner.workspaceId),
      ),
    );
  if (!row) throw notFound('Coding session not found');
  return row;
}

export interface SessionFilter {
  botId?: string;
  status?: CodingSessionStatus;
  limit?: number;
}

/** The owner's sessions, newest first. */
export async function listSessions(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  { botId, status, limit = 50 }: SessionFilter = {},
): Promise<CodingSessionRow[]> {
  return deps.db
    .select()
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.ownerId, owner.id),
        eq(schema.codingSessions.workspaceId, owner.workspaceId),
        ...(botId ? [eq(schema.codingSessions.botId, botId)] : []),
        ...(status ? [eq(schema.codingSessions.status, status)] : []),
      ),
    )
    .orderBy(desc(schema.codingSessions.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export function getSession(deps: Pick<AppDeps, 'db'>, owner: Owner, sessionId: string) {
  return ownSession(deps.db, owner, sessionId);
}

const sessionEnded = () =>
  new DomainError(409, 'SESSION_ENDED', 'This coding session already ended');
const sessionRunning = () =>
  new DomainError(409, 'SESSION_RUNNING', 'This coding session is still running');

/**
 * Applies an owner's Stop, Continue or Discard through the session's widget,
 * so its state moves with the row; a session whose widget is gone is acted
 * on directly.
 */
async function viaWidget(
  deps: AppDeps,
  owner: Owner,
  row: CodingSessionRow,
  action: CodingSessionAction,
): Promise<CodingSessionRow> {
  if (row.messageId && row.partIndex !== null) {
    await actOnWidget(deps, owner, row.messageId, row.partIndex, action);
  } else {
    const effect = await sessionEffect(deps, deps.db, row, action, null);
    await effect?.();
  }
  return ownSession(deps.db, owner, row.id);
}

export async function stopSession(deps: AppDeps, owner: Owner, sessionId: string) {
  const row = await ownSession(deps.db, owner, sessionId);
  if (ended(row.status)) throw sessionEnded();
  return viaWidget(deps, owner, row, { type: 'stop' });
}

/**
 * Continue from the API: like the widget's Continue, the prompt goes to the
 * Bot as an owner message, and its run continues the session through
 * `code_task`. The row is left as it is until then.
 */
export async function continueSession(
  deps: AppDeps,
  owner: Owner,
  sessionId: string,
  prompt: string,
) {
  const row = await ownSession(deps.db, owner, sessionId);
  if (!ended(row.status)) throw sessionRunning();
  return viaWidget(deps, owner, row, { type: 'continue', prompt });
}

export async function discardSession(deps: AppDeps, owner: Owner, sessionId: string) {
  const row = await ownSession(deps.db, owner, sessionId);
  if (!ended(row.status)) {
    throw new DomainError(409, 'SESSION_RUNNING', 'Stop the session before discarding its branch');
  }
  return viaWidget(deps, owner, row, { type: 'discard' });
}

/**
 * Where Open terminal opens (F4, I15): the worktree, as `coder`, with the
 * agent's resume command typed and ready. The PTY proxy checks the path
 * against the owner's sessions again.
 */
export async function terminalFor(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  sessionId: string,
): Promise<{ cwd: string; user: 'coder'; preset: string }> {
  const row = await ownSession(deps.db, owner, sessionId);
  if (!row.worktreePath) {
    throw new DomainError(409, 'NO_WORKTREE', 'This session has no worktree on the computer');
  }
  const agent = row.agent as CoderAgent;
  const preset =
    row.vendorSessionId && hasCoderAdapter(agent)
      ? adapterFor(agent).resumeCommand(row.vendorSessionId)
      : '';
  return { cwd: row.worktreePath, user: 'coder', preset };
}

/** The most of a session's log the API returns: its end. */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The session's full event log, its last LOG_MAX_BYTES (empty before the
 * runner wrote any). The runner writes it on the server
 * (services/coder-state.ts), so the computer is not involved.
 */
export async function sessionLog(deps: AppDeps, owner: Owner, sessionId: string): Promise<string> {
  const row = await ownSession(deps.db, owner, sessionId);
  return readSessionLog(deps, row, LOG_MAX_BYTES);
}

/**
 * Whether a terminal may open in `cwd` (I15): the worktree of one of the
 * owner's coding sessions, or the checkout of one of their repositories.
 */
export async function isCoderTerminalCwd(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  cwd: string,
): Promise<boolean> {
  const path = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  // The home: where a sign-in that runs in the terminal opens (pi's /login, CODER_LOGIN_IN_TERMINAL).
  if (path === COMPUTER_HOME) return true;
  const [session] = await deps.db
    .select({ id: schema.codingSessions.id })
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.ownerId, owner.id),
        eq(schema.codingSessions.workspaceId, owner.workspaceId),
        eq(schema.codingSessions.worktreePath, path),
      ),
    )
    .limit(1);
  if (session) return true;
  const [checkout] = await deps.db
    .select({ id: schema.repoCheckouts.id })
    .from(schema.repoCheckouts)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.repoCheckouts.repoId))
    .where(
      and(
        eq(schema.repos.ownerId, owner.id),
        eq(schema.repos.workspaceId, owner.workspaceId),
        eq(schema.repoCheckouts.path, path),
      ),
    )
    .limit(1);
  return !!checkout;
}

// The widget's actions

/**
 * The `coding_session` widget's action hook (called from services/runs.ts
 * inside the action's transaction): moves the row with the widget and clears
 * `control`, which only says what the owner asked for. Throws to refuse.
 */
export async function onCodingSessionAction(
  deps: Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>,
  tx: Db,
  context: WidgetActionContext,
): Promise<{ state?: unknown; after?: () => Promise<void> } | void> {
  const action = context.action as CodingSessionAction;
  if (action.type === 'open_terminal') return;
  const props = context.props as CodingSessionProps;
  const [row] = await tx
    .select()
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.id, props.session_id),
        eq(schema.codingSessions.workspaceId, context.message.workspaceId),
      ),
    )
    .for('update');
  if (!row) return;
  const { control: _, ...reduced } = context.state as CodingSessionState;
  // Continue leaves the session ended: the Bot's `code_task` reopens it.
  const state: CodingSessionState =
    action.type === 'continue'
      ? { ...reduced, status: row.status as CodingSessionStatus }
      : reduced;
  const after = await sessionEffect(
    deps as AppDeps,
    tx,
    row,
    action,
    context.message.threadRootId ?? null,
  );
  return { state, ...(after ? { after } : {}) };
}

/**
 * The row side of an owner's action, written with `tx`; returns what runs
 * once the action is stored (publishing, the job, the computer).
 */
async function sessionEffect(
  deps: AppDeps,
  tx: Db,
  row: CodingSessionRow,
  action: CodingSessionAction,
  /** The thread the session's widget is in, where Continue's message goes. */
  thread: string | null,
): Promise<(() => Promise<void>) | undefined> {
  switch (action.type) {
    case 'stop': {
      if (ended(row.status)) throw sessionEnded();
      // Nobody claimed it yet: it stops here, and its run hears so.
      const [unclaimed] = await tx
        .update(schema.codingSessions)
        .set({ status: 'stopped', finishedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(schema.codingSessions.id, row.id), eq(schema.codingSessions.status, 'queued')),
        )
        .returning();
      return async () => {
        await publishCoderControl(deps, { type: 'stop', sessionId: row.id } satisfies CoderControl);
        if (!unclaimed) return;
        const state = await settleSession(deps, row.id, { status: 'stopped' });
        if (row.runId) {
          await resumeWaitingRun(deps, row.runId, widgetToolResult(SESSION_KIND, state), {
            waitMs: 0,
          });
        }
      };
    }
    case 'continue': {
      if (!ended(row.status)) throw sessionRunning();
      const [busy] = await tx
        .select({ id: schema.codingSessions.id })
        .from(schema.codingSessions)
        .where(
          and(
            eq(schema.codingSessions.botId, row.botId),
            inArray(schema.codingSessions.status, CODING_SESSION_ACTIVE),
            ne(schema.codingSessions.id, row.id),
          ),
        )
        .limit(1);
      if (busy) {
        throw new DomainError(
          409,
          'CODER_BUSY',
          'This Bot is running another coding session; continue this one when it ends',
        );
      }
      const [chat] = row.chatId
        ? await tx.select().from(schema.chats).where(eq(schema.chats.id, row.chatId))
        : [];
      const [bot] = await tx
        .select({ handle: schema.bots.handle, archivedAt: schema.bots.archivedAt })
        .from(schema.bots)
        .where(eq(schema.bots.id, row.botId));
      if (!chat || !bot || bot.archivedAt) {
        throw new DomainError(
          409,
          'SESSION_NO_CHAT',
          'The chat this session started in is gone, so its Bot cannot continue it',
        );
      }
      // The Bot continues it with `code_task`, from a run of its own: so the
      // session has a run to ask the owner in, and the Bot hears the result.
      // Outside its transcript the message mentions the Bot, so it is routed there.
      const text = `${chat.type === 'bot_dm' ? '' : `@${bot.handle} `}Continue coding session ${row.id}: ${action.prompt}`;
      const owner = { id: row.ownerId, workspaceId: row.workspaceId };
      return async () => {
        await postUserMessage(deps, owner, chat.id, {
          text,
          ...(thread ? { threadRootId: thread } : {}),
        });
      };
    }
    case 'discard':
      if (!ended(row.status)) {
        throw new DomainError(409, 'SESSION_RUNNING', 'Stop the session before discarding it');
      }
      return () => discardWorktree(deps, row);
    case 'open_terminal':
      return undefined;
  }
}

/**
 * Removes a session's worktree and its local branch on the computer, as
 * `coder`, best effort (the computer starts if it has to), and its log on
 * the server, then forgets the path. The remote branch, if it was pushed, stays.
 */
async function discardWorktree(deps: AppDeps, row: CodingSessionRow): Promise<void> {
  const owner = { id: row.ownerId, workspaceId: row.workspaceId };
  const worktree = row.worktreePath;
  if (worktree) {
    const at = worktree.indexOf('/.worktrees/');
    const repoDir = at > 0 ? worktree.slice(0, at) : null;
    try {
      const { computer } = await startComputer(deps, owner);
      const script = repoDir
        ? 'git -C "$0" worktree remove --force "$1"; git -C "$0" worktree prune; if [ -n "$2" ]; then git -C "$0" branch -D "$2"; fi; exit 0'
        : 'rm -rf -- "$1"; exit 0';
      await runAsCoder(agentFor(deps, computer), 'sh', [
        '-c',
        script,
        repoDir ?? worktree,
        worktree,
        row.branch ?? '',
      ]);
    } catch (error) {
      deps.logger.warn({ err: error, sessionId: row.id }, 'discarding a worktree failed');
    }
  }
  await removeSessionLog(deps, row).catch((error: unknown) =>
    deps.logger.warn({ err: error, sessionId: row.id }, 'removing a session log failed'),
  );
  await deps.db
    .update(schema.codingSessions)
    .set({ worktreePath: null, updatedAt: new Date() })
    .where(eq(schema.codingSessions.id, row.id));
}
