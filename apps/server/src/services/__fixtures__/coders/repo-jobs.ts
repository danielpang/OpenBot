import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { schema } from '../../../db/client.js';
import { resetCheckoutLocks } from '../../repos-checkout.js';
import { resetRefreshQueue } from '../../repos-refresh.js';
import { resetRescues } from '../../repos-rescue.js';
import {
  coderWorld,
  defaultGit,
  REPO_PATH,
  type CoderIo,
  type CoderWorld,
  type GitAnswer,
} from './setup.js';

// The remembered repositories' jobs (repos-scan.ts, repos-refresh.ts,
// repos-rescue.ts) against a scripted `/coder` whose git and other commands
// (`find`, `test`) answer from the test. Call `useRepoJobsWorld` inside a
// `describe`: it registers the hooks and hands back the world and helpers.

export const WORKTREE = `${REPO_PATH}/.worktrees/bot-x`;
export const STASH = 'a'.repeat(40);
export const WORKTREES = `worktree ${REPO_PATH}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD def\nbranch refs/heads/bot/x\n`;

export interface RepoJobsWorld {
  readonly w: CoderWorld;
  readonly computerId: string;
  /** What `test -e <path>/.git` answers, by path. */
  onDisk: (path: string) => boolean;
  findOutput: string;
  inOrg<T>(fn: () => Promise<T>): Promise<T>;
  checkout(): Promise<typeof schema.repoCheckouts.$inferSelect | undefined>;
  readyCheckout(over?: Partial<typeof schema.repoCheckouts.$inferInsert>): Promise<unknown>;
  /** git answers by the path after `-C`, falling back to `defaultGit`. */
  gitBy(answer: (args: string[], at: string | undefined) => GitAnswer | undefined): void;
}

export function useRepoJobsWorld(email: string): RepoJobsWorld {
  let w: CoderWorld;
  let computerId: string;
  const j: RepoJobsWorld = {
    get w() {
      return w;
    },
    get computerId() {
      return computerId;
    },
    onDisk: () => true,
    findOutput: '',
    inOrg: (fn) => w.t.inOrganization(fn),
    checkout: async () =>
      (
        await w.t.db
          .select()
          .from(schema.repoCheckouts)
          .where(eq(schema.repoCheckouts.repoId, w.repoId))
      )[0],
    readyCheckout: (over = {}) =>
      w.t.db.insert(schema.repoCheckouts).values({
        workspaceId: w.workspaceId,
        repoId: w.repoId,
        computerId,
        path: REPO_PATH,
        state: 'ready',
        ...over,
      }),
    gitBy: (answer) => {
      w.coder.git = (args) => {
        const at = args[args.indexOf('-C') + 1];
        return answer(args, args.includes('-C') ? at : undefined) ?? defaultGit(args);
      };
    },
  };

  beforeAll(async () => {
    w = await coderWorld(email);
    const [computer] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, w.ownerId));
    computerId = computer!.id;
    const res = await w.call('POST', '/connectors', {
      catalogId: 'github_builtin',
      secrets: { GITHUB_TOKEN: 'ghp-jobs-token' },
    });
    expect(res.status).toBe(201);
  });
  beforeEach(async () => {
    j.onDisk = () => true;
    j.findOutput = '';
    w.coder.agent = (io: CoderIo) => {
      const { command, args = [] } = io.call.launch;
      if (command === 'find') io.stdout(j.findOutput);
      if (command === 'test') return io.exit(j.onDisk(args[1]!.replace(/\/\.git$/, '')) ? 0 : 1);
      io.exit(0);
    };
    await w.t.db.delete(schema.repoCheckouts);
    await w.t.db
      .delete(schema.repos)
      .where(and(eq(schema.repos.ownerId, w.ownerId), eq(schema.repos.fullName, 'acme/tool')));
  });
  afterEach(() => {
    w.coder.git = defaultGit;
  });
  afterAll(async () => {
    resetCheckoutLocks();
    resetRefreshQueue();
    resetRescues();
    await w.close();
  });
  return j;
}
