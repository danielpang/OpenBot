import { createHmac, randomUUID } from 'node:crypto';
import { CODING_ROUTINE_TEMPLATES, GITHUB_APP_WEBHOOK_PATH } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { saveGithubApp } from '../services/github-app-store.js';
import { runSource } from '../services/policy.js';
import { createTestApp, type TestApp } from '../test-app.js';

// The GitHub App's webhook end to end (I19, F6): signature, idempotency on
// X-GitHub-Delivery, installation events on the connection, and deliveries
// starting only the matching Routines of the installation's owner, as
// webhook runs; plus the coding templates on the Routines API (CA11).

const SECRET = 'app-webhook-secret-0123456789';
const INSTALLATION = '4242';

describe('GitHub App webhook', () => {
  let t: TestApp;
  let dana: string;
  let eve: string;
  let danaId: string;
  let workspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    dana = (await t.signUp('dana@example.com')).cookie!;
    eve = (await t.signUp('eve@example.com')).cookie!;
    danaId = await t.userId('dana@example.com');
    workspaceId = await t.defaultOrganization();
  });
  afterAll(() => t.close());

  const call = (method: string, url: string, body?: unknown, as = dana) =>
    t.app.request(`/api/v1${url}`, {
      method,
      headers: {
        cookie: as,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const sign = (body: string, secret = SECRET) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  function deliver(
    event: string,
    payload: unknown,
    { id = randomUUID(), secret = SECRET }: { id?: string; secret?: string } = {},
  ) {
    const body = JSON.stringify(payload);
    return t.app.request(GITHUB_APP_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': id,
        'x-hub-signature-256': sign(body, secret),
      },
      body,
    });
  }

  async function newBot(name: string, as = dana) {
    const res = await call(
      'POST',
      '/bots',
      { name, modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' } },
      as,
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  const routineRuns = (routineId: string) =>
    t.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routineId));

  const connection = async () =>
    (
      await t.db
        .select()
        .from(schema.gitConnections)
        .where(eq(schema.gitConnections.id, connectionId))
    )[0]!;

  const installation = { id: Number(INSTALLATION), account: { login: 'acme' } };
  const repository = { full_name: 'acme/api' };
  const labeled = (label: string, repo = repository) => ({
    action: 'labeled',
    issue: { number: 7, title: 'Crash on start' },
    label: { name: label },
    repository: repo,
    installation,
  });

  it('refuses every delivery while no App is configured', async () => {
    const res = await deliver('issues', labeled('bot'));
    expect(res.status).toBe(401);
  });

  it('verifies X-Hub-Signature-256 with the App webhook secret', async () => {
    await saveGithubApp(t.ownerDeps, {
      appId: '1',
      slug: 'openbots-test',
      privateKeyPem: 'unused',
      clientId: 'cid',
      clientSecret: 'csecret',
      webhookSecret: SECRET,
      createdAt: new Date().toISOString(),
    });
    expect((await deliver('ping', { zen: 'hi' }, { secret: 'not-the-secret-at-all' })).status).toBe(
      401,
    );
    const unsigned = await t.app.request(GITHUB_APP_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
      body: '{}',
    });
    expect(unsigned.status).toBe(401);
    expect((await deliver('ping', { zen: 'hi' })).status).toBe(202);
  });

  it('lists the coding templates', async () => {
    const res = await call('GET', '/routines/templates');
    expect(res.status).toBe(200);
    const { templates } = (await res.json()) as { templates: { id: string }[] };
    expect(templates.map((x) => x.id)).toEqual(CODING_ROUTINE_TEMPLATES.map((x) => x.id));
    expect((await t.app.request('/api/v1/routines/templates')).status).toBe(401);
  });

  let fixRoutine: string;
  let reviewRoutine: string;
  let otherRepoRoutine: string;
  let eveRoutine: string;

  it('creates Routines from templates, pinned to the repository and its installation', async () => {
    const [conn] = await t.db
      .insert(schema.gitConnections)
      .values({
        workspaceId,
        ownerId: danaId,
        kind: 'app',
        installationId: INSTALLATION,
        accountLogin: 'acme',
        // Dana's own reach (H1): acme/api and acme/web, not acme/hidden.
        repositories: [
          { fullName: 'acme/api', push: true, admin: false },
          { fullName: 'acme/web', push: true, admin: false },
        ],
      })
      .returning();
    connectionId = conn!.id;
    await t.db.insert(schema.repos).values({
      workspaceId,
      ownerId: danaId,
      connectionId,
      fullName: 'acme/api',
      remoteUrl: 'https://github.com/acme/api.git',
    });
    const bot = await newBot('Coder');
    const fix = await call('POST', `/bots/${bot}/routines`, {
      template: { id: 'fix-labeled-issues', params: { repo: 'acme/api' } },
    });
    expect(fix.status).toBe(201);
    const fixed = (await fix.json()) as {
      id: string;
      name: string;
      prompt: string;
      trigger: { type: string; endpoint_id?: string; match?: Record<string, unknown> };
    };
    expect(fixed.trigger).toMatchObject({
      type: 'event',
      source: 'github',
      match: {
        event: 'label_added',
        repo: 'acme/api',
        label: 'bot',
        installation_id: INSTALLATION,
      },
    });
    expect(fixed.trigger.endpoint_id).toBeTruthy();
    expect(fixed.prompt).toContain('An issue in acme/api was labeled bot.');
    expect(fixed.prompt).not.toContain('{{');
    fixRoutine = fixed.id;

    expect((fixed as { webhook?: unknown }).webhook).toBeUndefined();
    const [fixEndpoint] = await t.db
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, fixed.trigger.endpoint_id!));
    // Delivered by the App: the endpoint keeps no token.
    expect(fixEndpoint!.tokenHash).toBe('none');

    // The template decides: a name, prompt or trigger sent beside it is ignored.
    const review = await call('POST', `/bots/${bot}/routines`, {
      template: { id: 'review-pull-requests', params: { repo: 'acme/api' } },
      name: 'My reviews',
      prompt: 'Something else entirely',
      trigger: { type: 'schedule', preset: { kind: 'daily', time: '08:00' } },
    });
    expect(review.status).toBe(201);
    const reviewed = (await review.json()) as {
      id: string;
      name: string;
      prompt: string;
      trigger: { type: string };
    };
    expect(reviewed.name).toBe('Review new pull requests (acme/api)');
    expect(reviewed.prompt).toContain('A pull request was opened in acme/api.');
    expect(reviewed.trigger.type).toBe('event');
    reviewRoutine = reviewed.id;

    // A repository with no App connection: no installation id, and a plain
    // GitHub endpoint with a token and a signing secret, for the owner to add
    // on GitHub by hand.
    const other = await call('POST', `/bots/${bot}/routines`, {
      template: { id: 'fix-labeled-issues', params: { repo: 'acme/web', label: 'fix-me' } },
    });
    expect(other.status).toBe(201);
    const otherBody = (await other.json()) as {
      id: string;
      name: string;
      trigger: { match: Record<string, unknown>; endpoint_id: string };
      webhook: { endpointId: string; url: string; token: string; signingSecret: string };
    };
    expect(otherBody.trigger.match).toEqual({
      event: 'label_added',
      repo: 'acme/web',
      label: 'fix-me',
    });
    expect(otherBody.name).toBe('Fix issues labeled fix-me (acme/web)');
    expect(otherBody.webhook.endpointId).toBe(otherBody.trigger.endpoint_id);
    expect(otherBody.webhook.token).toMatch(/^whk_/);
    expect(otherBody.webhook.url).toMatch(
      new RegExp(`/hooks/[^/]+/[^/]+/${otherBody.webhook.token}$`),
    );
    expect(otherBody.webhook.signingSecret.length).toBeGreaterThan(16);
    const [otherEndpoint] = await t.db
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, otherBody.webhook.endpointId));
    expect(otherEndpoint!.tokenHash).not.toBe('none');
    expect(otherEndpoint!.signature).toEqual({ preset: 'github' });
    expect(otherEndpoint!.signatureSecret).toBeTruthy();
    otherRepoRoutine = otherBody.id;

    const weekly = await call('POST', `/bots/${bot}/routines`, {
      template: { id: 'weekly-dependency-update', params: { repo: 'acme/api' } },
    });
    expect(weekly.status).toBe(201);
    expect(((await weekly.json()) as { trigger: unknown }).trigger).toMatchObject({
      type: 'schedule',
      preset: { kind: 'weekly', day: 1, time: '09:00' },
    });

    // Eve's Routine on the same repository: she has no connection to this installation.
    const eveBot = await newBot('Eve bot', eve);
    const eveRes = await call(
      'POST',
      `/bots/${eveBot}/routines`,
      { template: { id: 'fix-labeled-issues', params: { repo: 'acme/api' } } },
      eve,
    );
    expect(eveRes.status).toBe(201);
    eveRoutine = ((await eveRes.json()) as { id: string }).id;

    // The plain body shape still works, and a body with neither is refused.
    const plain = await call('POST', `/bots/${bot}/routines`, {
      name: 'Plain',
      trigger: { type: 'schedule', preset: { kind: 'daily', time: '08:00' } },
      prompt: 'Say hi',
    });
    expect(plain.status).toBe(201);
    expect((await call('POST', `/bots/${bot}/routines`, { prompt: 'x' })).status).toBe(400);
    expect(
      (
        await call('POST', `/bots/${bot}/routines`, {
          template: { id: 'nope', params: { repo: 'acme/api' } },
        })
      ).status,
    ).toBe(400);
    // Another user's Bot is 404, template or not.
    expect(
      (
        await call(
          'POST',
          `/bots/${bot}/routines`,
          { template: { id: 'fix-labeled-issues', params: { repo: 'acme/api' } } },
          eve,
        )
      ).status,
    ).toBe(404);
  });

  it('starts only the matching Routine of the installation owner, as a webhook run', async () => {
    const id = randomUUID();
    const res = await deliver('issues', labeled('bot'), { id });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run_ids: string[] };
    expect(body.run_ids).toHaveLength(1);

    const fixRuns = await routineRuns(fixRoutine);
    expect(fixRuns).toHaveLength(1);
    expect(fixRuns[0]!.reason).toBe('event');
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, body.run_ids[0]!));
    expect(run!.id).toBe(fixRuns[0]!.runId);
    expect(runSource(run!)).toBe('webhook');
    expect(await routineRuns(reviewRoutine)).toHaveLength(0);
    expect(await routineRuns(otherRepoRoutine)).toHaveLength(0);
    expect(await routineRuns(eveRoutine)).toHaveLength(0);

    // The delivery is in the Routine endpoint's log, verified and matched.
    const [routine] = await t.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, fixRoutine));
    const endpointId = (routine!.trigger as { endpoint_id: string }).endpoint_id;
    const logged = await t.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpointId));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ verified: true, matched: true, status: 'queued' });

    // GitHub redelivers with the same X-GitHub-Delivery: answered, nothing new starts.
    const again = await deliver('issues', labeled('bot'), { id });
    expect(again.status).toBe(202);
    expect(((await again.json()) as { run_ids: string[] }).run_ids).toEqual([]);
    expect(await routineRuns(fixRoutine)).toHaveLength(1);

    // Another label, or another installation, starts nothing.
    await deliver('issues', labeled('question'));
    await deliver('issues', { ...labeled('bot'), installation: { id: 999 } });
    expect(await routineRuns(fixRoutine)).toHaveLength(1);
  });

  it('starts the review Routine for an opened pull request, and nothing for a push', async () => {
    await deliver('pull_request', {
      action: 'opened',
      pull_request: { number: 3, title: 'Add a thing' },
      repository,
      installation,
    });
    expect(await routineRuns(reviewRoutine)).toHaveLength(1);
    expect(await routineRuns(fixRoutine)).toHaveLength(1);

    // A push matches no Routine event; it notes the push on the remembered repository.
    const res = await deliver('push', { ref: 'refs/heads/main', repository, installation });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { run_ids: string[] }).run_ids).toEqual([]);
    const [repo] = await t.db
      .select()
      .from(schema.repos)
      .where(and(eq(schema.repos.ownerId, danaId), eq(schema.repos.fullName, 'acme/api')));
    expect(repo!.lastRemotePushAt).toBeInstanceOf(Date);
  });

  it('tells an owner only of repositories in their own reach (H1)', async () => {
    const bot = await newBot('Hidden watcher');
    const res = await call('POST', `/bots/${bot}/routines`, {
      name: 'Hidden',
      trigger: {
        type: 'event',
        source: 'github',
        match: { event: 'label_added', repo: 'acme/hidden', label: 'bot' },
      },
      prompt: 'Look',
    });
    expect(res.status).toBe(201);
    const hidden = ((await res.json()) as { id: string }).id;
    await deliver('issues', labeled('bot', { full_name: 'acme/hidden' }));
    expect(await routineRuns(hidden)).toHaveLength(0);
  });

  it('spends the installation rate limit once per delivery, and goes on past a failing organization', async () => {
    // Another organization with a connection to the installation, older than
    // Dana's, whose row fails mid-delivery (a broken reach).
    const orgB = await t.createOrganization('Org B');
    await t.db.insert(schema.gitConnections).values({
      workspaceId: orgB,
      ownerId: danaId,
      kind: 'app',
      installationId: INSTALLATION,
      accountLogin: 'acme',
      repositories: { broken: true } as never,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
    const keys: string[] = [];
    const limiter = t.deps.infra.limiter;
    const consume = limiter.consume.bind(limiter);
    limiter.consume = (key, options) => {
      keys.push(key);
      return consume(key, options);
    };
    const errors: unknown[] = [];
    const logError = t.deps.logger.error.bind(t.deps.logger);
    t.deps.logger.error = ((...args: unknown[]) => {
      errors.push(args[0]);
      return (logError as (...a: unknown[]) => void)(...args);
    }) as typeof t.deps.logger.error;
    try {
      const before = (await routineRuns(fixRoutine)).length;
      const res = await deliver('issues', labeled('bot'));
      expect(res.status).toBe(202);
      expect(keys.filter((k) => k === `github-app:${INSTALLATION}`)).toHaveLength(1);
      // Org B failed and was logged; Dana's organization, after it, still ran.
      expect(errors).toEqual([expect.objectContaining({ workspaceId: orgB })]);
      expect(await routineRuns(fixRoutine)).toHaveLength(before + 1);
    } finally {
      limiter.consume = consume;
      t.deps.logger.error = logError;
      await t.db.delete(schema.gitConnections).where(eq(schema.gitConnections.workspaceId, orgB));
    }
  });

  it('moves the connection with installation events', async () => {
    await deliver('installation_repositories', { action: 'added', installation });
    expect((await connection()).lastSyncedAt).toBeInstanceOf(Date);
    // A repository taken out of the installation leaves the owner's reach.
    await deliver('installation_repositories', {
      action: 'removed',
      installation,
      repositories_removed: [{ full_name: 'acme/web' }],
    });
    expect((await connection()).repositories).toEqual([
      { fullName: 'acme/api', push: true, admin: false },
    ]);

    await deliver('installation', { action: 'suspend', installation });
    expect((await connection()).status).toBe('needs_reinstall');
    expect((await connection()).error).toBe('GitHub suspended the installation');
    // A suspended installation's deliveries start nothing.
    const runsBefore = (await routineRuns(fixRoutine)).length;
    await deliver('issues', labeled('bot'));
    expect(await routineRuns(fixRoutine)).toHaveLength(runsBefore);

    await deliver('installation', { action: 'unsuspend', installation });
    expect((await connection()).status).toBe('connected');
    expect((await connection()).error).toBeNull();

    await deliver('installation', { action: 'created', installation });
    expect((await connection()).status).toBe('connected');

    await deliver('installation', { action: 'deleted', installation });
    expect((await connection()).status).toBe('revoked');
    expect((await connection()).error).toBe('The installation was removed on GitHub');
  });

  it('refuses a body past the size limit', async () => {
    const big = 'x'.repeat(t.deps.config.limits.webhookPayloadBytes + 1);
    const res = await t.app.request(GITHUB_APP_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
      body: big,
    });
    expect(res.status).toBe(413);
  });
});
