import { expect, test } from '@playwright/test';
import { startFakeModel, useFakeModel, type FakeModel } from './fake-model.js';
import { signUp } from './auth.js';

// Send a message and watch a streamed reply arrive (plan 18.2), then open the
// activity log from the reply. The Bot answers through the scripted fake model
// unless E2E_PROVIDER_ID and E2E_MODEL_ID name a real provider and model.
// Creating the fake provider needs an admin, so run it against a fresh
// database (the first user to sign up is the admin), before other specs sign up.

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

let model: FakeModel | undefined;
test.afterAll(async () => model?.close());

test('send a message and watch a streamed reply arrive', async ({ page }) => {
  await signUp(page, 'Transcript', `transcript-${Date.now()}@example.com`);
  await expect(page).toHaveURL('/');

  const request = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await page.request.fetch(path, {
      method: init.method ?? 'GET',
      data: init.body,
    });
    expect(res.ok(), `${init.method ?? 'GET'} ${path}: ${await res.text()}`).toBe(true);
    return res.status() === 204 ? null : ((await res.json()) as unknown);
  };
  const name = `Ada ${Date.now() % 10_000}`;
  const bot = (await request('/api/v1/bots', { method: 'POST', body: { name } })) as { id: string };
  if (process.env.E2E_PROVIDER_ID && process.env.E2E_MODEL_ID) {
    await request(`/api/v1/bots/${bot.id}`, {
      method: 'PATCH',
      body: {
        modelConfig: {
          provider_id: process.env.E2E_PROVIDER_ID,
          model_id: process.env.E2E_MODEL_ID,
        },
      },
    });
  } else {
    const me = (await request('/api/v1/me')) as { role: string };
    test.skip(
      me.role !== 'owner' && me.role !== 'admin',
      'needs this user to own their organization',
    );
    model = await startFakeModel({ wordDelayMs: 120 });
    await useFakeModel(request, bot.id, model.baseUrl);
  }

  await page.reload();
  await page.getByRole('link', { name }).first().click();
  const log = page.getByRole('log');
  // A new Bot opens its chat by asking what to work on.
  await expect(log.getByText(`Hi, I'm ${name}. What would you like me to work on?`)).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Hello there');
  await composer.press('Enter');

  await expect(log.getByText('Hello there')).toBeVisible();
  if (model) {
    // Streaming: the first words show before the last ones have been written.
    await expect(log.getByText(/Hello from the/)).toBeVisible();
    await expect(log.getByText('const answer = 42;')).toBeVisible({ timeout: 15_000 });
    await expect(log.locator('strong', { hasText: 'test double' })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 30_000 });

  const reply = log.locator('[data-author="bot"]').last();
  await reply.hover();
  await reply.getByRole('button', { name: 'Activity' }).click();
  const panel = page.getByRole('complementary');
  await expect(panel.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(panel.getByText(/^Thought/)).toBeVisible();
  // The footer says how long the run took, and its cost when the model is
  // priced (the fake is not); token counts stay out of the UI (UI review).
  const tookAndCost = /^(\d+ms|\d+(\.\d)?s|\d+m( \d+s)?)( · \$[\d.]+)?$/;
  await expect(panel.getByRole('paragraph').filter({ hasText: tookAndCost })).toBeVisible();
  await expect(panel.getByText(/\d+ in · \d+ out/)).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close Activity' }).click();
  await expect(panel).toBeHidden();
});
