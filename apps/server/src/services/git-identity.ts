import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError } from '../errors.js';
import { recordAudit } from './audit.js';
import { runAsCoder } from './coder-commands.js';
import type { ComputerAgentClient } from '@openbots/computer';
import { agentFor, computerAvailable, getComputer } from './computer.js';

// Who an owner's commits are by (GH8). Coding sessions commit as the Bot by
// default, with the owner as co-author; `commitAs: 'owner'` makes the owner
// the author. The name and email the owner saves here override their
// account's, which in the Mac app's local mode is the placeholder
// `owner@openbots.local` that GitHub links to no one. The same identity is
// written into git's global config on the owner's computer, for `bot` (the
// terminal) and `coder` (sessions), so commits made by hand there carry it;
// a session's own commits still take the GIT_AUTHOR_* variables it starts
// with (coder-adapters/common.ts).

type Owner = { id: string; workspaceId: string };
export type CommitAs = 'bot' | 'owner';

export interface GitIdentity {
  commitAs: CommitAs;
  name: string | null;
  email: string | null;
  account: { name: string; email: string };
}

export interface GitIdentityInput {
  commitAs: CommitAs;
  name: string | null;
  email: string | null;
}

/** Where the identity reached on the computer after a save. */
export type ComputerApplied = 'applied' | 'off' | 'failed';

/** The local mode owner's address, and anything like it: no one on GitHub. */
const PLACEHOLDER_EMAIL = /@openbots\.local$/i;

/** A plausible address: no whitespace or angle brackets, an @ and a dot after it. */
export function plausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email);
}

/** The owner's own address for commits: the saved one, else a real account address. */
export function effectiveEmail(identity: Pick<GitIdentity, 'email' | 'account'>): string | null {
  if (identity.email) return identity.email;
  const account = identity.account.email.trim();
  return account && !PLACEHOLDER_EMAIL.test(account) && plausibleEmail(account) ? account : null;
}

/** The owner's name for commits: the saved one, the account's, else the email's local part. */
export function effectiveName(
  identity: Pick<GitIdentity, 'name' | 'account'>,
  email: string | null,
) {
  return identity.name || identity.account.name.trim() || email?.split('@')[0] || '';
}

const blankToNull = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const invalid = (code: string, message: string) => new DomainError(400, code, message);

export async function getGitIdentity(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
): Promise<GitIdentity> {
  const [[row], [user]] = await Promise.all([
    deps.db
      .select()
      .from(schema.gitIdentities)
      .where(
        and(
          eq(schema.gitIdentities.ownerId, owner.id),
          eq(schema.gitIdentities.workspaceId, owner.workspaceId),
        ),
      ),
    deps.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, owner.id)),
  ]);
  return {
    commitAs: row?.commitAs === 'owner' ? 'owner' : 'bot',
    name: row?.name ?? null,
    email: row?.email ?? null,
    account: { name: user?.name ?? '', email: user?.email ?? '' },
  };
}

/** Saves the owner's identity, then writes it into the computer's git config when it runs. */
export async function putGitIdentity(
  deps: AppDeps,
  owner: Owner,
  input: GitIdentityInput,
): Promise<GitIdentity & { computer: ComputerApplied }> {
  const name = blankToNull(input.name);
  const email = blankToNull(input.email);
  if (name !== null && name.length > 100) {
    throw invalid('GIT_IDENTITY_NAME_INVALID', 'Use a name of at most 100 characters');
  }
  if (name !== null && /[<>\r\n]/.test(name)) {
    throw invalid(
      'GIT_IDENTITY_NAME_INVALID',
      'A name cannot contain angle brackets or line breaks',
    );
  }
  if (email !== null && !plausibleEmail(email)) {
    throw invalid('GIT_IDENTITY_EMAIL_INVALID', 'Enter an email address such as you@example.com');
  }
  const current = await getGitIdentity(deps, owner);
  const next = { ...current, commitAs: input.commitAs, name, email };
  if (next.commitAs === 'owner' && !effectiveEmail(next)) {
    throw invalid(
      'GIT_IDENTITY_EMAIL_REQUIRED',
      'Add the email on your GitHub account to commit as yourself',
    );
  }
  await deps.db
    .insert(schema.gitIdentities)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      commitAs: next.commitAs,
      name,
      email,
    })
    .onConflictDoUpdate({
      target: [schema.gitIdentities.workspaceId, schema.gitIdentities.ownerId],
      set: { commitAs: next.commitAs, name, email, updatedAt: new Date() },
    });
  await recordAudit(deps.db, {
    workspaceId: owner.workspaceId,
    actor: { type: 'user', id: owner.id },
    action: 'git_identity.update',
    targetType: 'user',
    targetId: owner.id,
    // The address is the owner's own; whether one is set is enough here.
    metadata: { commitAs: next.commitAs, name: name !== null, email: email !== null },
  });
  const computer = await applyGitIdentityOnComputer(deps, owner, next);
  return { ...next, computer };
}

/** The users git config is written for on the computer: the terminal's and the sessions'. */
const COMPUTER_USERS = ['bot', 'coder'] as const;

/**
 * Writes the owner's name and email into `git config --global` for `bot` and
 * `coder` on the owner's computer, when it runs. The human at the terminal is
 * the owner either way, so `commitAs` does not change what is written. An
 * email that is only the local mode placeholder is left out. Each value is
 * its own argument: nothing goes through a shell.
 */
export async function applyGitIdentityOnComputer(
  deps: AppDeps,
  owner: Owner,
  known?: GitIdentity,
): Promise<ComputerApplied> {
  if (!computerAvailable(deps)) return 'off';
  const computer = await getComputer(deps, owner);
  if (computer?.status !== 'running') return 'off';
  const identity = known ?? (await getGitIdentity(deps, owner));
  return writeGitIdentity(deps, agentFor(deps, computer), identity);
}

/** The `git config --global` writes for one identity, as `bot` and then `coder`. */
export async function writeGitIdentity(
  deps: Pick<AppDeps, 'logger'>,
  agent: ComputerAgentClient,
  identity: GitIdentity,
): Promise<ComputerApplied> {
  const email = effectiveEmail(identity);
  const name = effectiveName(identity, email)
    .replace(/[<>\r\n]+/g, ' ')
    .trim();
  const settings: [string, string][] = [];
  if (name) settings.push(['user.name', name]);
  if (email) settings.push(['user.email', email]);
  if (!settings.length) return 'applied';
  try {
    for (const user of COMPUTER_USERS) {
      for (const [key, value] of settings) {
        const run = await runAsCoder(agent, 'git', ['config', '--global', key, value], { user });
        if (run.code !== 0) {
          deps.logger.warn(
            { user, key, code: run.code, error: run.error ?? run.stderr.slice(0, 300) },
            'setting the git identity on the computer failed',
          );
          return 'failed';
        }
      }
    }
  } catch (error) {
    deps.logger.warn({ err: error }, 'setting the git identity on the computer failed');
    return 'failed';
  }
  return 'applied';
}
