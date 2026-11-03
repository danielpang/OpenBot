import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';

// A standalone database restored into the compose stack: its computer was a
// `remote` one on the standalone container's loopback agent, which is nothing
// here. With Docker as the provider and no OPENBOTS_COMPUTER_AGENT_URL, it
// becomes a Docker computer at its next start, keeping its volume.

describe('a restored standalone computer', () => {
  let t: TestApp;
  let computer: TestComputer;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp();
    computer = await useTestComputer(t.ownerDeps);
    cookie = (await t.signUp('ada@example.com')).cookie!;
  });
  afterAll(async () => {
    await computer.close();
    await t.close();
  });

  it('is made again as a Docker computer with the same volume, not dialled on loopback', async () => {
    const ownerId = await t.userId('ada@example.com');
    const workspaceId = await t.defaultOrganization();
    const [row] = await t.db
      .insert(schema.computers)
      .values({
        workspaceId,
        ownerId,
        provider: 'remote',
        status: 'stopped',
        agentUrl: 'http://127.0.0.1:7070',
        agentToken: encryptSecret('standalone token', keyringFromConfig(t.deps.config)),
        volumeName: 'openbots-home-standalone',
      })
      .returning();
    const res = await t.app.request('/api/v1/computer/start', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [after] = await t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, row!.id));
    expect(after).toMatchObject({ provider: 'docker', volumeName: 'openbots-home-standalone' });
    expect(after!.agentUrl).toBe(computer.agent.url);
    const created = computer.docker.calls.find((c) => c.op === 'createContainer');
    expect(JSON.stringify(created?.args)).toContain('openbots-home-standalone');
  });
});
