import { CODING_ROUTINE_TEMPLATES } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';

// The coding Routine templates on the Routines API (CA11; docs/TECHNICAL_PLAN.md
// 22.12, "Templates"): listed, and made with `template` on POST
// /bots/{id}/routines (`routineFromTemplate`, services/routines.ts), pinned to
// the repository and, through an App connection, to its installation.

const INSTALLATION = '4242';

describe('coding Routine templates', () => {
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

  it('lists the coding templates', async () => {
    const res = await call('GET', '/routines/templates');
    expect(res.status).toBe(200);
    const { templates } = (await res.json()) as { templates: { id: string }[] };
    expect(templates.map((x) => x.id)).toEqual(CODING_ROUTINE_TEMPLATES.map((x) => x.id));
    expect((await t.app.request('/api/v1/routines/templates')).status).toBe(401);
  });

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
});
