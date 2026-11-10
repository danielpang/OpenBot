import type { CoderAccountView } from '@openbots/agent';
import { CODER_CONFIG_DIRS } from '@openbots/computer';
import {
  CODER_AGENT_LABELS,
  CODER_AGENTS,
  CODER_PROVIDER_KINDS,
  SUBSCRIPTION_SIGN_OUT,
  coderProviderFits,
  type CoderAgent,
  type CoderAuthKind,
  type CoderPlanProvider,
  type CoderSignInStyle,
} from '@openbots/shared';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { recordAudit, userActor } from './audit.js';
import { adapterFor, CODER_ADAPTERS } from './coder-adapters/index.js';
import { PI_CHECK_PROVIDERS } from './coder-adapters/pi.js';
import { coderVersion, runAsCoder } from './coder-commands.js';
import { completeTerminalLogins } from './coder-login.js';
import { agentFor, computerAvailable, getComputer, startComputer } from './computer.js';

// The owner's coding agent accounts (docs/plans/TECHNICAL_PLAN.md 22.5, 22.13).
// Settings > Coding agents reads one card per agent from `coder_accounts`
// (no row reads as not signed in): its sign-in, an API key from Settings >
// Models instead, Sign out (the agent's config directory on the computer
// emptied as `coder`) and Check (the CLI asked whether it is signed in).
// No token is ever stored here; the credentials are on the computer.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

type AccountRow = typeof schema.coderAccounts.$inferSelect;

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
  /** This build runs it: every agent of CODER_AGENTS has an adapter (CODER_ADAPTERS). */
  available: boolean;
  /** Never signed in, or the sign-in lapsed: the card offers to sign in (again). */
  needsSignIn: boolean;
  /** What `lastError` is about, so the card can word it: a lapsed sign-in, a refused key, or else. */
  lastErrorKind: CoderLastErrorKind | null;
  /** Whose plan a `subscription` account bills; null without one. */
  planProvider: CoderPlanProvider | null;
  /** The adapter can ask the CLI whether it is signed in (Check). */
  checkAvailable: boolean;
  /** How the agent signs in. */
  signIn: CoderSignInStyle;
  /** The owner's default model for the agent; null when not chosen (CA9). */
  model: string | null;
  /** The owner's default agent (CA9): at most one. */
  isDefault: boolean;
}

export type CoderLastErrorKind = 'sign_in' | 'key' | 'other';

/**
 * Whether the agent has to be signed in before a session can start: never
 * signed in, or the runner found its sign-in gone (CA10, which sets
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

/** The plan ids pi signs in to, by the words its check puts in the label (PI_CHECK_PROVIDERS). */
const PI_PLANS = PI_CHECK_PROVIDERS.filter((p) => p.plan).map((p) => ({
  plan: p.plan!,
  provider: (p.id.startsWith('anthropic')
    ? 'anthropic'
    : p.id.startsWith('openai')
      ? 'openai'
      : 'other') as CoderPlanProvider,
}));

/**
 * Whose plan the account bills: Claude Code's plan is Anthropic's and
 * Codex's OpenAI's; pi's is read from the label its check stored (the plans
 * it found signed in, joined), Anthropic first when there are several, since
 * a Claude plan bills pi as extra usage. Null unless a plan sign-in.
 */
export function planProviderOf(
  agent: CoderAgent,
  authKind: CoderAuthKind,
  label: string | null,
): CoderPlanProvider | null {
  if (authKind !== 'subscription') return null;
  if (agent === 'claude') return 'anthropic';
  if (agent === 'codex') return 'openai';
  const found = new Set(PI_PLANS.filter((p) => label?.includes(p.plan)).map((p) => p.provider));
  if (found.has('anthropic')) return 'anthropic';
  if (found.has('openai')) return 'openai';
  return 'other';
}

/**
 * How the agent signs in: in the terminal, or by the vendor's login on a
 * pty, which shows a code to enter (`device`) when the login asks for
 * device auth and a link to open (`link`) otherwise.
 */
export function signInStyleOf(agent: CoderAgent): CoderSignInStyle {
  const signIn = adapterFor(agent).signIn;
  if (signIn.kind === 'terminal') return 'terminal';
  return signIn.login().args.includes('--device-auth') ? 'device' : 'link';
}

/** What the adapter says about signing in; an agent with no adapter has no Check. */
function adapterFacts(agent: CoderAgent): Pick<CoderAccountInfo, 'checkAvailable' | 'signIn'> {
  if (!Object.hasOwn(CODER_ADAPTERS, agent)) return { checkAvailable: false, signIn: 'terminal' };
  return { checkAvailable: !!adapterFor(agent).checkSignIn, signIn: signInStyleOf(agent) };
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
    available: Object.hasOwn(CODER_ADAPTERS, agent),
    needsSignIn: needsSignIn({ authKind, lastError }),
    lastErrorKind: lastErrorKind({ authKind, lastError }),
    planProvider: planProviderOf(agent, authKind, row?.accountLabel ?? null),
    ...adapterFacts(agent),
    model: row?.model ?? null,
    isDefault: row?.isDefault ?? false,
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

/** For tests: forgets which versions this process asked for. */
export function resetVersionAsked(): void {
  versionAsked.clear();
}

/**
 * Settings > Coding agents: the cards, with the CLI's version filled in
 * lazily. An available agent without one gets `<cli> --version` run as
 * `coder` once per computer, and the answer is stored on `coder_accounts`.
 * Only while the computer runs: it is never started for this.
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
    ...(info.isDefault ? { isDefault: true } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.available ? {} : { available: false }),
  };
}

/** The owner's coding defaults (CA9): the default agent, and a model per agent. */
export interface CoderDefaults {
  /** Null clears the default agent, so `code_task` asks again. */
  defaultAgent?: CoderAgent | null;
  /** A model per agent; null (or an empty name) clears that agent's. Agents left out keep theirs. */
  models?: Partial<Record<CoderAgent, string | null>>;
}

/**
 * Writes the owner's coding defaults on their `coder_accounts` rows (a row
 * is made for an agent never signed in): `is_default` moves to the one
 * agent, and each model named is set or cleared. In `db`, so a widget
 * action's transaction can use it.
 */
export async function writeCoderDefaults(
  db: Db,
  owner: Owner,
  defaults: CoderDefaults,
): Promise<void> {
  if (defaults.defaultAgent !== undefined) {
    // Cleared first: the partial unique index allows one default per owner.
    await db
      .update(schema.coderAccounts)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(schema.coderAccounts.ownerId, owner.id),
          eq(schema.coderAccounts.workspaceId, owner.workspaceId),
          eq(schema.coderAccounts.isDefault, true),
        ),
      );
    if (defaults.defaultAgent) {
      await upsertAccount(db, owner, defaults.defaultAgent, { isDefault: true });
    }
  }
  for (const [agent, model] of Object.entries(defaults.models ?? {}) as [
    CoderAgent,
    string | null | undefined,
  ][]) {
    if (model === undefined) continue;
    await upsertAccount(db, owner, agent, { model: model?.trim() || null });
  }
}

/** Settings > Coding agents' Defaults: written together, then the cards read again. */
export async function setCoderDefaults(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  defaults: CoderDefaults,
): Promise<CoderAccountInfo[]> {
  await deps.db.transaction(async (tx) => {
    await writeCoderDefaults(tx, owner, defaults);
    await recordAudit(tx, {
      workspaceId: owner.workspaceId,
      actor: userActor(owner),
      action: 'coder.defaults',
      targetType: 'coder_account',
      targetId: null,
      metadata: { ...defaults },
    });
  });
  return listCoderAccounts(deps, owner);
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
      setWhere:
        set.authKind === 'api_key' ? ne(schema.coderAccounts.authKind, 'subscription') : undefined,
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
    // Decide at the write, not from an earlier account read: a concurrent
    // successful login must not be switched to API billing by saving a key.
    await tx
      .insert(schema.coderAccounts)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        agent,
        authKind: 'api_key',
        providerId,
        lastError: null,
      })
      .onConflictDoUpdate({
        target: [
          schema.coderAccounts.workspaceId,
          schema.coderAccounts.ownerId,
          schema.coderAccounts.agent,
        ],
        set: {
          authKind: sql`case when ${schema.coderAccounts.authKind} = 'subscription' then 'subscription' else 'api_key' end`,
          providerId,
          lastError: sql`case when ${schema.coderAccounts.authKind} = 'subscription' then ${schema.coderAccounts.lastError} else null end`,
          updatedAt: new Date(),
        },
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
    const done = await runAsCoder(agentFor(deps, computer), 'node', [SUBSCRIPTION_SIGN_OUT, agent]);
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
 * `POST /coders/{agent}/check`: asks the CLI on the computer, as `coder`
 * with the agent's config directory, whether it is signed in (the adapter's
 * `checkSignIn`). Signed in, the card says how (`subscription` for a plan,
 * `api_key` for a key or token the CLI holds itself, so no provider), the
 * account, now; for an agent that signs in in its terminal, the sign-ins a
 * Bot is waiting on end signed in, and their runs resume. Not signed in, the
 * card is left as it was. The computer starts if it has to.
 */
export async function checkCoderSignIn(
  deps: AppDeps,
  owner: Owner,
  agent: CoderAgent,
): Promise<CoderAccountInfo> {
  const adapter = adapterFor(agent);
  const check = adapter.checkSignIn;
  if (!check) {
    throw new DomainError(
      400,
      'CODER_CHECK_UNSUPPORTED',
      `${CODER_AGENT_LABELS[agent]} has no sign-in check; sign in from Settings with Sign in`,
    );
  }
  if (!computerAvailable(deps)) {
    throw new DomainError(503, 'COMPUTER_UNAVAILABLE', 'There is no computer to check on');
  }
  const { computer } = await startComputer(deps, owner);
  const client = agentFor(deps, computer);
  const config = CODER_CONFIG_DIRS[agent];
  const env = { [config.env]: config.dir };
  const found = await check({ run: (args) => runAsCoder(client, adapter.command, args, { env }) });
  if (found?.signedIn) {
    const version = await coderVersion(client, agent).catch(() => null);
    await deps.db.transaction(async (tx) => {
      await upsertAccount(tx, owner, agent, {
        authKind: found.authKind,
        accountLabel: found.label,
        signedInAt: new Date(),
        providerId: null,
        lastError: null,
        ...(version ? { version } : {}),
      });
      if (found.authKind === 'api_key')
        await tx
          .update(schema.coderAccounts)
          .set({
            lastError: `${CODER_AGENT_LABELS[agent]} is not signed in with a subscription. Reconnect in Settings > Models.`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.coderAccounts.ownerId, owner.id),
              eq(schema.coderAccounts.workspaceId, owner.workspaceId),
              eq(schema.coderAccounts.agent, agent),
              eq(schema.coderAccounts.authKind, 'subscription'),
            ),
          );
      await recordAudit(tx, {
        workspaceId: owner.workspaceId,
        actor: userActor(owner),
        action: 'coder.sign_in',
        targetType: 'coder_account',
        targetId: null,
        metadata: { agent, checked: true, authKind: found.authKind },
      });
    });
    // Signed in in its terminal: the sign-ins Bots asked for end here.
    if (adapter.signIn.kind === 'terminal') {
      await completeTerminalLogins(deps, owner, agent, found.label);
    }
  } else if (found && !found.signedIn) {
    // Keep the subscription selected, but do not present a failed check as connected.
    // Clearing authKind here would silently enable API billing on the next bot run.
    await deps.db
      .update(schema.coderAccounts)
      .set({
        lastError: `${CODER_AGENT_LABELS[agent]} is not signed in on the computer. Reconnect in Settings > Models.`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.coderAccounts.ownerId, owner.id),
          eq(schema.coderAccounts.workspaceId, owner.workspaceId),
          eq(schema.coderAccounts.agent, agent),
          eq(schema.coderAccounts.authKind, 'subscription'),
        ),
      );
  }
  return getCoderAccount(deps, owner, agent);
}
