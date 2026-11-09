import { CODER_CONFIG_DIRS, type ComputerAgentClient } from '@openbots/computer';
import type { CoderAgent, CoderLoginStatus } from '@openbots/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { stripAnsi } from './coder-adapters/common.js';
import { adapterFor, type CoderLoginParse } from './coder-adapters/index.js';
import { coderVersion } from './coder-commands.js';
import { subscribeCoderControl } from './coder-control.js';
import {
  ACTIVE_LOGIN,
  endLogin,
  isPast,
  patchWidget,
  signInErrorForOwner,
  type CoderLoginRow,
} from './coder-login.js';
import { agentFor, startComputer } from './computer.js';

// The sign-in driver (docs/TECHNICAL_PLAN.md 22.5): the runner's `login` job.
// It runs the adapter's login in a PTY on the computer as `coder` with the
// agent's config directory, so the credentials land on the root-only state
// volume and never pass through the server. It reads the link and device
// code from the output through the adapter's `parseLogin`, shows them on the
// row and the widget, and writes the code the owner pastes back into the PTY.
// The code arrives over the coder control channel (`stdin` for the login's
// id), so the API process that takes it need not be this worker, and it is
// never stored.

/** How much of the login's output a failure keeps for its error. */
const TAIL_CHARS = 500;
/** How long a signed-in CLI gets to write its credentials and exit before it is closed. */
const SIGNED_IN_EXIT_MS = 10_000;

/** Said when the CLI printed a link on a host its adapter does not sign in on. */
export const UNEXPECTED_LOGIN_HOST = 'The sign-in printed a link on an unexpected host';

/**
 * The sign-in's link only when it is an https link on one of the adapter's
 * sign-in `hosts`; `rejected` when it is a link anywhere else.
 */
export function loginLink(
  url: string | undefined,
  hosts: readonly string[],
): { url?: string; rejected?: true } {
  if (!url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    url.length > 2_000 ||
    !allowed.has(parsed.hostname.toLowerCase())
  ) {
    return { rejected: true };
  }
  return { url };
}

type Outcome =
  | { type: 'signed_in' }
  | { type: 'exit'; error?: string }
  | { type: 'cancelled' }
  | { type: 'timeout' };

/**
 * Runs one sign-in for the runner's `login` job: starts the computer if it
 * has to, runs the adapter's login in a PTY as `coder` with the agent's
 * config directory, and follows it until it signs in, fails, is cancelled
 * or runs out of time.
 */
export async function runCoderLogin(deps: AppDeps, loginId: string): Promise<void> {
  const [found] = await deps.db
    .select()
    .from(schema.coderLogins)
    .where(eq(schema.coderLogins.id, loginId));
  if (!found || !ACTIVE_LOGIN.includes(found.status as CoderLoginStatus)) return;
  let row = found;
  if (isPast(row)) {
    await endLogin(deps, row, 'expired', { error: 'The sign-in expired' });
    return;
  }
  const workspaceId = row.workspaceId;
  const scoped = <T>(fn: () => Promise<T>) => inWorkspace(workspaceId, fn);
  const owner = { id: row.ownerId, workspaceId };
  const agentName = row.agent as CoderAgent;
  const signIn = adapterFor(agentName).signIn;
  // Signed in in the terminal: Check ends it, there is nothing to run.
  if (signIn.kind !== 'pty') return;
  const plan = signIn.login();

  let computer;
  try {
    ({ computer } = await startComputer(deps, owner, SYSTEM_ACTOR));
  } catch (error) {
    await endLogin(deps, row, 'failed', {
      error: `The computer did not start: ${(error as Error).message}`,
    });
    return;
  }
  const agent = agentFor(deps, computer);
  const config = CODER_CONFIG_DIRS[agentName];

  let parse: CoderLoginParse = {};
  let tail = '';
  /** The codes the owner sent, kept out of any error text (the PTY echoes them). */
  const codes: string[] = [];
  let settle!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => (settle = resolve));
  let exited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => (exited = resolve));
  // Row and widget writes, one at a time and in order.
  let writes: Promise<unknown> = Promise.resolve();
  const persist = (fn: () => Promise<unknown>) => {
    writes = writes
      .then(() => scoped(fn))
      .catch((error: unknown) =>
        deps.logger.warn({ err: error, loginId }, 'saving the sign-in progress failed'),
      );
  };

  const read = (data: string) => {
    const text = stripAnsi(data);
    tail = (tail + text).slice(-TAIL_CHARS * 4);
    const before = parse;
    parse = signIn.parseLogin(text, parse);
    const link = loginLink(parse.url, signIn.hosts);
    if (link.rejected) {
      // Never shown to the owner: a tampered CLI or environment could phish.
      settle({ type: 'exit', error: UNEXPECTED_LOGIN_HOST });
      return;
    }
    const url = link.url;
    // A refused code: the owner reads why on the widget, and may paste again.
    const noticeChanged = parse.notice !== before.notice;
    const changed =
      url !== loginLink(before.url, signIn.hosts).url ||
      parse.deviceCode !== before.deviceCode ||
      (parse.awaitingCode && !before.awaitingCode) ||
      noticeChanged;
    if (changed) {
      const deviceCode = parse.deviceCode;
      const awaitingCode = !!parse.awaitingCode;
      const notice = parse.notice;
      persist(async () => {
        const [current] = await deps.db
          .select()
          .from(schema.coderLogins)
          .where(eq(schema.coderLogins.id, loginId));
        if (!current) return;
        // A code the owner already sent keeps the sign-in at awaiting_code.
        const status: CoderLoginStatus =
          awaitingCode || current.status === 'awaiting_code' ? 'awaiting_code' : 'pending';
        const [updated] = await deps.db
          .update(schema.coderLogins)
          .set({
            // The link and code stay on the row (and the widget) through awaiting_code.
            url: url ?? current.url,
            deviceCode: deviceCode ?? current.deviceCode,
            status,
            ...(noticeChanged ? { error: notice ?? null } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.coderLogins.id, loginId),
              inArray(schema.coderLogins.status, ACTIVE_LOGIN),
            ),
          )
          .returning();
        if (updated) {
          row = updated;
          await patchWidget(deps, updated, {
            status,
            ...(updated.url ? { url: updated.url } : {}),
            ...(updated.deviceCode ? { device_code: updated.deviceCode } : {}),
            ...(noticeChanged ? { error: notice } : {}),
          });
        }
      });
    }
    if (parse.signedIn) settle({ type: 'signed_in' });
    else if (parse.error) settle({ type: 'exit', error: parse.error });
  };

  let proc: Awaited<ReturnType<ComputerAgentClient['coder']>> | undefined;
  const unsubscribe = await subscribeCoderControl(deps, (msg) => {
    if (!('sessionId' in msg) || msg.sessionId !== loginId) return;
    if (msg.type === 'stdin') {
      codes.push(msg.data.trim());
      // A new code: what the CLI said of the last one no longer applies.
      if (parse.notice) {
        const { notice: _, ...rest } = parse;
        parse = rest;
        persist(async () => {
          const [updated] = await deps.db
            .update(schema.coderLogins)
            .set({ error: null, updatedAt: new Date() })
            .where(
              and(
                eq(schema.coderLogins.id, loginId),
                inArray(schema.coderLogins.status, ACTIVE_LOGIN),
              ),
            )
            .returning();
          if (updated) await patchWidget(deps, updated, { error: undefined });
        });
      }
      try {
        proc?.write(msg.data);
      } catch {
        // It ended; the exit says how.
      }
    } else if (msg.type === 'stop') {
      settle({ type: 'cancelled' });
    }
  });

  const expiresIn = row.expiresAt ? row.expiresAt.getTime() - Date.now() : plan.timeoutMs;
  const timer = setTimeout(() => settle({ type: 'timeout' }), Math.min(plan.timeoutMs, expiresIn));
  try {
    try {
      proc = await agent.coder(
        {
          session_id: loginId,
          user: 'coder',
          pty: true,
          command: plan.command,
          args: plan.args,
          env: { [config.env]: config.dir, ...(plan.env ?? {}) },
          git_credentials: false,
        },
        {
          stdout: read,
          stderr: read,
          credentialRequest: () => {},
          permissionRequest: () => {},
          exit: (info) => {
            exited();
            settle({ type: 'exit', ...(info.error ? { error: info.error } : {}) });
          },
        },
      );
    } catch (error) {
      settle({ type: 'exit', error: (error as Error).message });
    }
    const result = await outcome;
    clearTimeout(timer);
    if (result.type === 'signed_in') {
      // The CLI writes its credentials as it says so; give it the moment to exit.
      await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, SIGNED_IN_EXIT_MS))]);
    }
    await proc?.close().catch(() => {});
    await writes;
    await scoped(async () => {
      if (result.type === 'signed_in') {
        await signedIn(deps, row, agent, parse.accountLabel?.trim() || null);
      } else if (result.type === 'timeout') {
        await endLogin(deps, row, 'expired', { error: 'The sign-in expired' });
      } else if (result.type === 'exit') {
        const said = redact(stripAnsi(tail).trim(), codes).slice(-TAIL_CHARS);
        const raw = result.error ?? (said || 'The sign-in ended before it finished');
        const error = signInErrorForOwner(agentName, raw);
        if (error !== raw) {
          deps.logger.warn({ loginId, agent: agentName, output: raw }, 'the sign-in was refused');
        }
        await endLogin(deps, row, 'failed', { error });
      }
      // Cancelled: cancelLogin moved the row and the widget already.
    });
  } finally {
    clearTimeout(timer);
    await unsubscribe();
  }
}

function redact(text: string, codes: string[]) {
  return codes.filter(Boolean).reduce((out, code) => out.split(code).join('…'), text);
}

/** The sign-in worked: the account row says so, and every waiting run resumes. */
async function signedIn(
  deps: AppDeps,
  row: CoderLoginRow,
  agent: ComputerAgentClient,
  /** Null when the CLI did not say whose account it signed in to. */
  accountLabel: string | null,
) {
  const agentName = row.agent as CoderAgent;
  const version = await coderVersion(agent, agentName).catch(() => null);
  const now = new Date();
  await deps.db
    .insert(schema.coderAccounts)
    .values({
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      agent: agentName,
      authKind: 'subscription',
      accountLabel,
      signedInAt: now,
      lastError: null,
      ...(version ? { version } : {}),
    })
    .onConflictDoUpdate({
      target: [
        schema.coderAccounts.workspaceId,
        schema.coderAccounts.ownerId,
        schema.coderAccounts.agent,
      ],
      set: {
        authKind: 'subscription',
        accountLabel,
        signedInAt: now,
        lastError: null,
        ...(version ? { version } : {}),
        updatedAt: now,
      },
    });
  await recordAudit(deps.db, {
    workspaceId: row.workspaceId,
    actor: { type: 'user', id: row.ownerId } satisfies AuditActor,
    action: 'coder.sign_in',
    targetType: 'coder_login',
    targetId: row.id,
    metadata: { agent: agentName },
  });
  await endLogin(deps, row, 'signed_in', accountLabel ? { account_label: accountLabel } : {});
}
