import {
  sessionTitle,
  wsEvent,
  type CoderAgent,
  type CoderChangedFile,
  type CoderCommit,
  type CoderMode,
  type CoderUsage,
  type CodingSessionStatus,
} from '@openbots/shared';
import type { AppDeps } from '../context.js';
import type { schema } from '../db/client.js';
import { publishEvent } from '../infra/index.js';

// A coding session as the API and `coding_session.updated` show it. A leaf
// module, so coder-state.ts can publish the view without importing
// coding-sessions.ts, which imports it.

type CodingSessionRow = typeof schema.codingSessions.$inferSelect;

/** A session as the API returns it (a type, so the event payload's index signature takes it). */
export type CodingSessionView = {
  id: string;
  botId: string;
  /** Its name in the drawer: from the first prompt (`sessionTitle`). */
  title: string;
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
};

export function toSessionView(row: CodingSessionRow): CodingSessionView {
  return {
    id: row.id,
    botId: row.botId,
    // Sessions from before titles were kept are named from their latest prompt.
    title: row.title ?? sessionTitle(row.prompt, row.repoFullName),
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

/** `coding_session.updated` to the session's owner, with the row as it is now. */
export function publishSessionUpdated(
  deps: Pick<AppDeps, 'infra'>,
  row: CodingSessionRow,
): Promise<void> {
  return publishEvent(
    deps.infra.bus,
    wsEvent(
      'coding_session.updated',
      { session: toSessionView(row) },
      { user_id: row.ownerId, workspace_id: row.workspaceId },
    ),
  );
}
