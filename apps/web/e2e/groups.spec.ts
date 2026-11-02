import { expect, test } from '@playwright/test';
import { startFakeModel, type FakeModel } from './fake-model.js';
import { signUp } from './auth.js';

// The Phase 5 exit criterion (plan 18): a Chief of Staff Bot routes work to
// three specialists with visible handoffs, and the loop guard stops a
// ping-pong. On the way it starts the group from New chat, mentions through
// the `@` picker, replies in a thread and reacts. Every Bot is the scripted
// fake model (see fake-model.ts for the group script); creating its provider
// needs an admin, so run this against a fresh database.

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

let model: FakeModel | undefined;
test.afterAll(async () => model?.close());

type Bot = { id: string; name: string; handle: string };

test('a Chief of Staff routes work to three specialists; the loop guard stops a ping-pong', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signUp(page, 'Groups', `groups-${Date.now()}@example.com`);
  await expect(page).toHaveURL('/');

  const request = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await page.request.fetch(path, { method: init.method ?? 'GET', data: init.body });
    expect(res.ok(), `${init.method ?? 'GET'} ${path}: ${await res.text()}`).toBe(true);
    return res.status() === 204 ? null : ((await res.json()) as unknown);
  };
  const me = (await request('/api/v1/me')) as { role: string };
  test.skip(
    me.role !== 'owner' && me.role !== 'admin',
    'needs this user to own their organization',
  );

  model = await startFakeModel({ wordDelayMs: 10 });
  const provider = (await request('/api/v1/providers', {
    method: 'POST',
    body: {
      name: `E2E groups ${Date.now()}`,
      protocol: 'openai_compatible',
      baseUrl: model.baseUrl,
      local: true, // on 127.0.0.1, see useFakeModel
      models: [{ modelId: 'e2e-model', capabilities: { tools: true } }],
    },
  })) as { id: string };
  const n = Date.now() % 10_000;
  const create = async (name: string) => {
    const bot = (await request('/api/v1/bots', { method: 'POST', body: { name } })) as Bot;
    await request(`/api/v1/bots/${bot.id}`, {
      method: 'PATCH',
      body: { modelConfig: { provider_id: provider.id, model_id: 'e2e-model' } },
    });
    return bot;
  };
  const chief = await create(`Chief ${n}`);
  const team = [
    await create(`Researcher ${n}`),
    await create(`Writer ${n}`),
    await create(`Designer ${n}`),
  ];
  const paddles = [await create(`Paddle ${n} A`), await create(`Paddle ${n} B`)];

  // New chat: pick the Chief and the three specialists.
  await page.reload();
  await page.getByRole('button', { name: /^New/ }).first().click();
  await page.getByRole('button', { name: 'New chat' }).click();
  // The sidebar's avatars carry the Bots' names too, so pick within the dialog.
  const dialog = page.getByRole('dialog');
  for (const bot of [chief, ...team]) {
    await dialog.getByRole('checkbox', { name: bot.name }).check();
  }
  await expect(dialog.getByText('4 picked; up to 6.')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Group name' }).fill(`Launch ${n}`);
  await dialog.getByRole('button', { name: 'Start chat' }).click();
  await expect(page).toHaveURL(/\/groups\//);
  await expect(page.getByRole('link', { name: `Launch ${n}` })).toBeVisible();

  // Address the Chief through the picker, and let it hand the work out.
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('@');
  await expect(page.getByRole('option', { name: /@everyone/ })).toBeVisible();
  await composer.pressSequentially('chief');
  await expect(page.getByRole('option')).toHaveText([new RegExp(chief.name)]);
  await composer.press('Enter');
  await composer.pressSequentially('please route the launch');
  await composer.press('Enter');

  const log = page.getByRole('log', { name: `Launch ${n}` });
  const handoff = log.locator('[data-author="bot"]', { hasText: 'Routing the launch.' });
  await expect(handoff).toBeVisible({ timeout: 30_000 });
  await expect(handoff).toContainText(chief.name);
  for (const bot of team) {
    await expect(handoff).toContainText(`@${bot.handle}`);
    const answer = log.locator('[data-author="bot"]', { hasText: `On it: @${bot.handle}` });
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(answer).toContainText(bot.name);
  }

  // React to the handoff.
  await handoff.hover();
  await handoff.getByRole('button', { name: 'React' }).click();
  await handoff.getByRole('option', { name: 'React with 👍' }).click();
  const chip = handoff.getByRole('list', { name: 'Reactions' }).getByRole('button');
  await expect(chip).toHaveText('👍1');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');

  // Reply in a thread on one specialist's result; its answer stays in the thread.
  const [researcher] = team;
  const result = log.locator('[data-author="bot"]', { hasText: `On it: @${researcher!.handle}` });
  await result.hover();
  await result.getByRole('button', { name: 'Reply in thread' }).click();
  const panel = page.getByRole('complementary');
  await expect(panel.getByRole('heading', { name: 'Thread' })).toBeVisible();
  const reply = panel.getByRole('textbox', { name: 'Message' });
  await reply.fill(`@${researcher!.handle} make it shorter`);
  await reply.press('Enter');
  const thread = panel.getByRole('log', { name: 'Thread' });
  await expect(thread.getByText('make it shorter')).toBeVisible();
  await expect(thread.getByText(/Hello from the/)).toBeVisible({ timeout: 30_000 });
  await expect(result.getByRole('button', { name: '2 replies' })).toBeVisible();
  await expect(log.getByText(/Hello from the/)).toBeHidden();
  await panel.getByRole('button', { name: 'Close Thread' }).click();

  // Two Bots that serve to each other until the loop guard stops them.
  const rally = (await request('/api/v1/chats', {
    method: 'POST',
    body: { botIds: paddles.map((b) => b.id), title: `Rally ${n}` },
  })) as { id: string };
  await page.goto(`/groups/${rally.id}`);
  await composer.fill(`@${paddles[0]!.handle} serve`);
  await composer.press('Enter');
  const rallyLog = page.getByRole('log', { name: `Rally ${n}` });
  await expect(rallyLog.getByText(/^Stopped a Bot loop/)).toBeVisible({ timeout: 60_000 });
  const serves = await rallyLog.locator('[data-author="bot"]').count();
  expect(serves).toBeGreaterThan(1);
  expect(serves).toBeLessThanOrEqual(6);
});
