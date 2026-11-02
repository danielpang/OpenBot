import { expect, test } from '@playwright/test';
import { startFakeModel, useFakeModel, type FakeModel } from './fake-model.js';
import { signUp } from './auth.js';

// Routines through the UI (R1, R3, R4): create a Routine in the Bot's
// Routines tab with the preset editor, Run now, and see its run record
// complete and open the activity log. The Bot is the scripted fake model;
// creating its provider needs an admin, so run this against a fresh database
// (the first user to sign up is the admin).

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

let model: FakeModel | undefined;
test.afterAll(async () => model?.close());

test('create a Routine, run it now, and see its run record', async ({ page }) => {
  await signUp(page, 'Routines', `routines-${Date.now()}@example.com`);
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
  const name = `Briefer ${Date.now() % 10_000}`;
  const bot = (await request('/api/v1/bots', { method: 'POST', body: { name } })) as { id: string };
  model = await startFakeModel({ wordDelayMs: 10 });
  await useFakeModel(request, bot.id, model.baseUrl);

  await page.goto(`/bots/${bot.id}/routines`);
  await page.getByRole('button', { name: 'New Routine' }).click();
  const form = page.getByRole('form', { name: 'New Routine' });
  await form.getByLabel('Routine name').fill('Morning briefing');
  await form.getByLabel('Prompt').fill('Summarize what happened overnight');
  await form.getByLabel('Repeats').selectOption('daily');
  await form.getByLabel('Time', { exact: true }).fill('07:30');
  await form.getByLabel('Timezone').fill('Europe/London');
  await expect(form.getByText(/^Every day at 07:30\. Next: /)).toBeVisible();
  await form.getByRole('button', { name: 'Create Routine' }).click();

  const row = page.locator('[data-routine]', { hasText: 'Morning briefing' });
  await expect(row).toBeVisible();
  await expect(row.getByText('Every day at 07:30 (Europe/London)')).toBeVisible();
  await expect(row.getByText('Never')).toBeVisible();

  await row.getByRole('button', { name: 'Run now' }).click();
  await row.getByText('Runs', { exact: true }).click();
  const record = row.locator('[data-status="completed"]');
  await expect(record).toBeVisible({ timeout: 30_000 });
  await expect(record.getByText(/Run now/)).toBeVisible();
  await record.getByRole('button', { name: 'Activity log' }).click();
  await expect(page.getByRole('complementary')).toBeVisible();
});
