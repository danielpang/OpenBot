import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { CODER_PUBLISH_OPERATION, CODERS_QUEUE } from '@openbots/shared';
import type { CoderPermissionAnswer } from '@openbots/computer';
import { schema } from '../db/client.js';
import {
  coderWorld,
  defaultGit,
  initLine,
  jsonl,
  resultLine,
  type CoderWorld,
  type CoderIo,
} from './__fixtures__/coders/setup.js';
import { createCoderWorker } from './coder-runner.js';
import { enqueueCoderJob, type CoderJob } from './coder-jobs.js';
import { publishCoderControl } from './coder-control.js';

const metadata = { title: 'Fix reconnect', body: 'Changes and verification.', draft: true };
const PR = 'https://github.com/acme/relay/pull/123';

describe('session-scoped publishing', () => {
  let w: CoderWorld;
  let github: Server;
  const posts: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  let conflict = false;
  let failures = 0;
  let noOpenPr = false;
  const options = { runWaitMs: 0, stopGraceMs: 20, sessionMinutes: 60, githubApi: '' };
  beforeAll(async () => {
    w = await coderWorld('publishing@example.com');
    github = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        if (req.method === 'GET') {
          lookups.push(req.url!);
          res.writeHead(200, { 'content-type': 'application/json' });
          const ref = w.coder
            .gitCalls()
            .filter((args) => args.includes('push'))
            .at(-1)
            ?.find((arg) => arg.includes(':refs/heads/'));
          res.end(
            JSON.stringify(
              noOpenPr
                ? []
                : [
                    {
                      html_url: PR,
                      head: { ref: 'bot/fix-reconnect', sha: ref?.split(':')[0] ?? 'abc1234' },
                      base: { ref: 'main' },
                    },
                  ],
            ),
          );
          return;
        }
        posts.push(JSON.parse(body) as Record<string, unknown>);
        const fail = failures-- > 0;
        if (!fail && !conflict) noOpenPr = false;
        res.writeHead(fail ? 500 : conflict ? 422 : 201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            fail
              ? { message: 'Temporary GitHub error' }
              : conflict
                ? { message: 'A pull request already exists' }
                : { html_url: PR },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
    options.githubApi = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    await w.t.deps.infra
      .queue<CoderJob>(CODERS_QUEUE)
      .process(createCoderWorker(w.t.deps, options), { concurrency: 4 });
    expect(
      (
        await w.call('POST', '/connectors', {
          catalogId: 'github_builtin',
          secrets: { GITHUB_TOKEN: 'ghp-publisher' },
        })
      ).status,
    ).toBe(201);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => github.close(() => resolve()));
    await w.close();
  });
  const start = (id: string) =>
    w.t.inOrganization(() => enqueueCoderJob(w.t.deps, { kind: 'session', sessionId: id }));
  const ended = (id: string) =>
    w.until(async () => {
      const row = await w.session(id);
      expect(['settled', 'failed', 'stopped']).toContain(row.status);
      return row;
    });
  const approvals = (id: string) =>
    w.t.db.select().from(schema.approvals).where(eq(schema.approvals.sessionId, id));
  const approve = async (id: string, decision = 'approve') => {
    const row = await w.until(async () => {
      const [row] = await w.t.db
        .select()
        .from(schema.approvals)
        .where(and(eq(schema.approvals.sessionId, id), eq(schema.approvals.status, 'pending')));
      expect(row).toBeDefined();
      return row!;
    });
    expect((await w.call('POST', `/approvals/${row.id}/decide`, { decision })).status).toBe(200);
  };
  const request = (io: CoderIo, id = 'publish', input: unknown = metadata) =>
    io.permission(id, CODER_PUBLISH_OPERATION, input);
  const complete = (io: CoderIo) => {
    io.stdout(jsonl(resultLine('Done')));
    io.exit(0);
  };

  it('publishes live through the runner, returns the URL, and deduplicates tool calls and exit fallback', async () => {
    const before = posts.length;
    const replies: CoderPermissionAnswer[] = [];
    let credential: unknown;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      replies.push(await request(io));
      credential = await io.credential({
        host: 'github.com',
        path: 'acme/relay.git',
        username: 'push',
      });
      replies.push(await request(io, 'publish-again'));
      complete(io);
    };
    const { sessionId } = await w.newSession({ mode: 'pr' });
    const firstCall = w.coder.calls.length;
    await start(sessionId);
    await approve(sessionId);
    const row = await ended(sessionId);
    expect(row).toMatchObject({ status: 'settled', prUrl: PR, pushedSha: 'abc1234' });
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(reply.decision).toBe('allow');
      expect(JSON.parse(reply.message!)).toEqual({ branch: 'bot/fix-reconnect', prUrl: PR });
    }
    expect(credential).toHaveProperty('denied');
    expect(await approvals(sessionId)).toHaveLength(1);
    expect(posts.slice(before)).toEqual([
      expect.objectContaining({
        title: metadata.title,
        draft: true,
        head: 'bot/fix-reconnect',
        base: 'main',
      }),
    ]);
    const pushes = w.coder.calls
      .slice(firstCall)
      .filter((call) => call.launch.command === 'git' && call.launch.args?.includes('push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.launch.user).toBe('runner');
    expect(pushes[0]!.launch.args).toContain('abc1234:refs/heads/bot/fix-reconnect');
    expect(pushes[0]!.launch.args).not.toContain('-u');
  });

  it('returns live MCP publishing results over the process relay even when Codex uses JSON-RPC', async () => {
    const thread = '01a1ad70-3c2e-7a41-9b0d-5e8f2c4a6b10';
    let answer: CoderPermissionAnswer | undefined;
    w.coder.agent = async (io) => {
      await io.written((line) => line.includes('"method":"initialize"'));
      io.stdout(jsonl({ id: 1, result: {} }));
      await io.written((line) => line.includes('"method":"thread/start"'));
      io.stdout(jsonl({ id: 2, result: { thread: { id: thread } } }));
      await io.written((line) => line.includes('"method":"turn/start"'));
      io.stdout(jsonl({ id: 3, result: { turn: { id: 't1', status: 'inProgress' } } }));
      answer = await request(io);
      io.stdout(
        jsonl(
          {
            method: 'item/completed',
            params: {
              threadId: thread,
              turnId: 't1',
              item: { id: 'm1', type: 'agentMessage', text: 'Published the PR.' },
            },
          },
          {
            method: 'turn/completed',
            params: { threadId: thread, turn: { id: 't1', status: 'completed', error: null } },
          },
        ),
      );
      await io.stdinClosed();
      io.exit(0);
    };
    const { sessionId } = await w.newSession({ agent: 'codex', mode: 'pr' });
    await start(sessionId);
    await approve(sessionId);
    expect(await ended(sessionId)).toMatchObject({ status: 'settled', prUrl: PR });
    expect(answer).toMatchObject({
      decision: 'allow',
      message: JSON.stringify({ branch: 'bot/fix-reconnect', prUrl: PR }),
    });
  });

  it('does not reprompt at exit after the owner denies publication', async () => {
    const before = posts.length;
    let answer: CoderPermissionAnswer | undefined;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      answer = await request(io);
      complete(io);
    };
    const { sessionId } = await w.newSession({ mode: 'pr' });
    await start(sessionId);
    await approve(sessionId, 'deny');
    expect((await ended(sessionId)).status).toBe('settled');
    expect(answer?.decision).toBe('deny');
    expect(await approvals(sessionId)).toHaveLength(1);
    expect(posts).toHaveLength(before);
  });

  it.each(['plan', 'invalid'] as const)(
    'refuses a %s publishing request without asking',
    async (kind) => {
      let answer: CoderPermissionAnswer | undefined;
      w.coder.agent = async (io) => {
        io.stdout(jsonl(initLine()));
        answer = await request(
          io,
          'publish',
          kind === 'invalid' ? { ...metadata, branch: 'main' } : metadata,
        );
        complete(io);
      };
      const { sessionId } = await w.newSession({ mode: kind === 'plan' ? 'plan' : 'edit' });
      await start(sessionId);
      if (kind === 'invalid') await approve(sessionId);
      expect((await ended(sessionId)).status).toBe('settled');
      expect(answer?.decision).toBe('deny');
      expect(await approvals(sessionId)).toHaveLength(kind === 'invalid' ? 1 : 0);
    },
  );

  it.each([
    { push: 'auto', pr: 'auto', decision: 'auto' },
    { push: 'deny', pr: 'auto', decision: 'deny' },
    { push: 'auto', pr: 'deny', decision: 'deny' },
  ] as const)(
    'honors push=$push and pr=$pr without an extra approval',
    async ({ push, pr, decision }) => {
      const [bot] = await w.t.db.select().from(schema.bots).where(eq(schema.bots.id, w.bot.id));
      await w.t.db
        .update(schema.bots)
        .set({ toolPolicy: { coder: { actions: { push, pr } } } })
        .where(eq(schema.bots.id, w.bot.id));
      let answer: CoderPermissionAnswer | undefined;
      try {
        w.coder.agent = async (io) => {
          io.stdout(jsonl(initLine()));
          answer = await request(io);
          complete(io);
        };
        const { sessionId } = await w.newSession();
        await start(sessionId);
        expect((await ended(sessionId)).status).toBe('settled');
        expect(answer?.decision).toBe(decision === 'auto' ? 'allow' : 'deny');
        expect(await approvals(sessionId)).toEqual([]);
      } finally {
        await w.t.db
          .update(schema.bots)
          .set({ toolPolicy: bot!.toolPolicy })
          .where(eq(schema.bots.id, w.bot.id));
      }
    },
  );

  it.each(['bot', 'webhook'] as const)(
    'keeps the %s trigger approval floor even when both policies say auto',
    async (requestedBy) => {
      const [bot] = await w.t.db.select().from(schema.bots).where(eq(schema.bots.id, w.bot.id));
      await w.t.db
        .update(schema.bots)
        .set({ toolPolicy: { coder: { actions: { push: 'auto', pr: 'auto' } } } })
        .where(eq(schema.bots.id, w.bot.id));
      let answer: CoderPermissionAnswer | undefined;
      try {
        w.coder.agent = async (io) => {
          io.stdout(jsonl(initLine()));
          answer = await request(io);
          complete(io);
        };
        const { sessionId, runId } = await w.newSession();
        await w.t.db
          .update(schema.runs)
          .set({ trigger: requestedBy === 'bot' ? 'bot_dm' : 'webhook' })
          .where(eq(schema.runs.id, runId));
        await start(sessionId);
        await approve(sessionId);
        expect(await ended(sessionId)).toMatchObject({ status: 'settled', prUrl: PR });
        expect(answer?.decision).toBe('allow');
        expect(await approvals(sessionId)).toHaveLength(1);
      } finally {
        await w.t.db
          .update(schema.bots)
          .set({ toolPolicy: bot!.toolPolicy })
          .where(eq(schema.bots.id, w.bot.id));
      }
    },
  );

  it('denies raw pushes and alternate PR tools, redirecting the agent to the runner', async () => {
    const replies: CoderPermissionAnswer[] = [];
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      replies.push(await io.permission('raw-push', 'Bash', { command: 'git push -u origin main' }));
      replies.push(
        await io.permission('raw-pr', 'Bash', { command: 'gh pr create --title Fix --body Done' }),
      );
      complete(io);
    };
    const { sessionId } = await w.newSession();
    await start(sessionId);
    await approve(sessionId);
    await ended(sessionId);
    expect(replies).toHaveLength(2);
    for (const reply of replies)
      expect(reply).toMatchObject({
        decision: 'deny',
        message: expect.stringContaining('publish_pull_request'),
      });
    expect(await approvals(sessionId)).toHaveLength(1);
  });

  it('does not publish if stopped while the owner is deciding', async () => {
    const before = posts.length;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      await request(io);
      io.exit(0);
    };
    const { sessionId } = await w.newSession();
    await start(sessionId);
    await w.until(async () =>
      expect((await approvals(sessionId)).some((row) => row.status === 'pending')).toBe(true),
    );
    await publishCoderControl(w.t.deps, { type: 'stop', sessionId });
    expect((await ended(sessionId)).status).toBe('stopped');
    expect(posts).toHaveLength(before);
  });

  it('recovers an existing PR after a crash before the URL was saved', async () => {
    conflict = true;
    const before = lookups.length;
    let answer: CoderPermissionAnswer | undefined;
    try {
      w.coder.agent = async (io) => {
        io.stdout(jsonl(initLine()));
        answer = await request(io);
        complete(io);
      };
      const { sessionId } = await w.newSession();
      await start(sessionId);
      await approve(sessionId);
      expect((await ended(sessionId)).prUrl).toBe(PR);
      expect(answer?.decision).toBe('allow');
      expect(lookups.length).toBeGreaterThan(before);
      for (const lookup of lookups.slice(before))
        expect(lookup).toContain('head=acme%3Abot%2Ffix-reconnect');
    } finally {
      conflict = false;
    }
  });

  it('pushes a follow-up commit to the same PR without creating another', async () => {
    const before = posts.length;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      await request(io);
      complete(io);
    };
    const { sessionId } = await w.newSession();
    await start(sessionId);
    await approve(sessionId);
    await ended(sessionId);
    await w.t.db
      .update(schema.codingSessions)
      .set({ status: 'queued', prompt: 'Add another test' })
      .where(eq(schema.codingSessions.id, sessionId));
    w.coder.git = (args) =>
      args.includes('rev-parse') && args.includes('HEAD')
        ? { code: 0, stdout: 'def5678\n' }
        : defaultGit(args);
    try {
      await start(sessionId);
      await approve(sessionId);
      expect(await ended(sessionId)).toMatchObject({ prUrl: PR, pushedSha: 'def5678' });
      expect(posts).toHaveLength(before + 1);
      expect(await approvals(sessionId)).toHaveLength(2);
    } finally {
      w.coder.git = defaultGit;
    }
  });

  it('does not publish a branch with no commits', async () => {
    w.coder.git = (args) => (args.includes('log') ? { code: 0, stdout: '' } : defaultGit(args));
    let answer: CoderPermissionAnswer | undefined;
    try {
      w.coder.agent = async (io) => {
        io.stdout(jsonl(initLine()));
        answer = await request(io);
        complete(io);
      };
      const { sessionId } = await w.newSession();
      await start(sessionId);
      await ended(sessionId);
      expect(answer).toMatchObject({
        decision: 'deny',
        message: 'There are no commits to publish.',
      });
      expect(await approvals(sessionId)).toEqual([]);
    } finally {
      w.coder.git = defaultGit;
    }
  });
  it('automatically publishes edit sessions even when the agent never calls the tool', async () => {
    const before = posts.length;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      complete(io);
    };
    const { sessionId } = await w.newSession({ mode: 'edit' });
    await start(sessionId);
    await approve(sessionId);
    expect(await ended(sessionId)).toMatchObject({
      status: 'settled',
      prUrl: PR,
      pushedSha: 'abc1234',
    });
    expect(posts).toHaveLength(before + 1);
  });

  it('publishes the final commit after a live publish, with a fresh SHA approval', async () => {
    const firstCall = w.coder.calls.length;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      expect((await request(io)).decision).toBe('allow');
      w.coder.git = (args) =>
        args.includes('rev-parse') && args.includes('HEAD')
          ? { code: 0, stdout: 'def5678\n' }
          : args.includes('log')
            ? { code: 0, stdout: 'def5678\tFix the final test\nabc1234\tInitial changes\n' }
            : defaultGit(args);
      complete(io);
    };
    try {
      const { sessionId } = await w.newSession({ mode: 'pr' });
      await start(sessionId);
      await approve(sessionId);
      await approve(sessionId);
      const row = await ended(sessionId);
      expect(row).toMatchObject({ status: 'settled', prUrl: PR, pushedSha: 'def5678' });
      expect(row.commits).toEqual(
        expect.arrayContaining([expect.objectContaining({ sha: 'def5678' })]),
      );
      // Count from recorded process calls, since preparation uses non-Git commands too.
      expect(
        w.coder.calls
          .slice(firstCall)
          .filter((c) => c.launch.command === 'git' && c.launch.args?.includes('push')),
      ).toHaveLength(2);
      expect((await approvals(sessionId)).map((a) => (a.args as { sha: string }).sha)).toEqual([
        'abc1234',
        'def5678',
      ]);
    } finally {
      w.coder.git = defaultGit;
    }
  });

  it('never reports an old closed PR as success after push succeeds and PR creation fails', async () => {
    noOpenPr = true;
    failures = 3;
    const before = posts.length;
    const replies: CoderPermissionAnswer[] = [];
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      replies.push(await request(io));
      replies.push(await request(io, 'retry'));
      complete(io);
    };
    try {
      const { sessionId } = await w.newSession({ mode: 'pr', prUrl: PR, pushedSha: 'old1111' });
      await start(sessionId);
      await approve(sessionId);
      const row = await ended(sessionId);
      expect(replies.map((r) => r.decision)).toEqual(['deny', 'deny']);
      expect(row.prUrl).toBeNull();
      expect(row.error).toContain('Temporary GitHub error');
      expect(row.summary).toContain('Temporary GitHub error');
      expect(posts).toHaveLength(before + 3);
      expect(await approvals(sessionId)).toHaveLength(1);
    } finally {
      noOpenPr = false;
      failures = 0;
    }
  });

  it('retries a temporary GitHub failure once at completion, reusing the exact approved metadata and SHA', async () => {
    const before = posts.length;
    failures = 1;
    noOpenPr = true;
    let answer: CoderPermissionAnswer | undefined;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      answer = await request(io);
      complete(io);
    };
    try {
      const { sessionId } = await w.newSession({ mode: 'pr' });
      await start(sessionId);
      await approve(sessionId);
      const row = await ended(sessionId);
      expect(answer?.decision).toBe('deny');
      expect(row).toMatchObject({ status: 'settled', prUrl: PR, error: null });
      expect(row.summary).not.toContain('Temporary GitHub error');
      expect(posts).toHaveLength(before + 2);
      expect(posts.at(-1)).toMatchObject({
        ...metadata,
        body: expect.stringContaining(metadata.body),
      });
      expect(await approvals(sessionId)).toHaveLength(1);
    } finally {
      failures = 0;
      noOpenPr = false;
    }
  });

  it('expires pending publication on time limit, without pushing after the agent exits', async () => {
    const before = posts.length;
    options.sessionMinutes = 0.002;
    let exited = false;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      const publishing = request(io);
      await io.signalled();
      exited = true;
      io.exit(null, 'SIGTERM');
      await publishing;
    };
    try {
      const { sessionId } = await w.newSession({ mode: 'pr' });
      await start(sessionId);
      const row = await ended(sessionId);
      expect(exited).toBe(true);
      expect(row.error).toContain('minute limit');
      expect(row.prUrl).toBeNull();
      expect(posts).toHaveLength(before);
      expect(await approvals(sessionId)).toEqual([expect.objectContaining({ status: 'expired' })]);
      const [approval] = await approvals(sessionId);
      expect(
        (await w.call('POST', `/approvals/${approval!.id}/decide`, { decision: 'approve' })).status,
      ).not.toBe(200);
    } finally {
      options.sessionMinutes = 60;
    }
  });
  it('does not publish a final commit when its fresh approval is declined', async () => {
    const before = w.coder.calls.length;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      await request(io);
      w.coder.git = (args) =>
        args.includes('rev-parse') && args.includes('HEAD')
          ? { code: 0, stdout: 'def5678\n' }
          : defaultGit(args);
      complete(io);
    };
    try {
      const { sessionId } = await w.newSession({ mode: 'edit' });
      await start(sessionId);
      await approve(sessionId);
      await approve(sessionId, 'deny');
      expect(await ended(sessionId)).toMatchObject({
        status: 'settled',
        pushedSha: 'abc1234',
        prUrl: null,
        summary: expect.stringContaining('not approved'),
      });
      expect(
        w.coder.calls
          .slice(before)
          .filter((c) => c.launch.command === 'git' && c.launch.args?.includes('push')),
      ).toHaveLength(1);
      expect(await approvals(sessionId)).toHaveLength(2);
    } finally {
      w.coder.git = defaultGit;
    }
  });

  it('reconciles a safety-net commit left after live publication', async () => {
    let dirty = false;
    let safetyNetCommitted = false;
    w.coder.git = (args) => {
      if (args.includes('commit')) {
        dirty = false;
        safetyNetCommitted = true;
        return { code: 0 };
      }
      if (args.includes('status') && args.includes('--porcelain'))
        return { code: 0, stdout: dirty ? ' M src/link.ts\0' : '' };
      if (args.includes('rev-parse') && args.includes('HEAD') && safetyNetCommitted)
        return { code: 0, stdout: 'def5678\n' };
      return defaultGit(args);
    };
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      await request(io);
      dirty = true;
      io.stdout(
        jsonl({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'late-edit',
                name: 'Edit',
                input: {
                  file_path: '/home/bot/repos/acme/relay/.worktrees/bot-fix-reconnect/src/link.ts',
                },
              },
            ],
          },
        }),
      );
      complete(io);
    };
    try {
      const { sessionId } = await w.newSession({ mode: 'edit' });
      await start(sessionId);
      await approve(sessionId);
      await approve(sessionId);
      expect(await ended(sessionId)).toMatchObject({
        status: 'settled',
        pushedSha: 'def5678',
        prUrl: PR,
      });
      expect(safetyNetCommitted).toBe(true);
      expect((await approvals(sessionId)).map((a) => (a.args as { sha: string }).sha)).toEqual([
        'abc1234',
        'def5678',
      ]);
    } finally {
      w.coder.git = defaultGit;
    }
  });

  it('requires fresh approval when a retry changes PR metadata for the same commit', async () => {
    const before = posts.length;
    failures = 1;
    noOpenPr = true;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      expect((await request(io)).decision).toBe('deny');
      expect(
        (await request(io, 'new-metadata', { ...metadata, title: 'A different title' })).decision,
      ).toBe('allow');
      complete(io);
    };
    try {
      const { sessionId } = await w.newSession();
      await start(sessionId);
      await approve(sessionId);
      await approve(sessionId);
      expect(await ended(sessionId)).toMatchObject({ status: 'settled', prUrl: PR });
      expect(await approvals(sessionId)).toHaveLength(2);
      expect(posts).toHaveLength(before + 2);
    } finally {
      failures = 0;
      noOpenPr = false;
    }
  });
});
