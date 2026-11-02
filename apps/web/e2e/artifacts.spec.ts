import { expect, test } from '@playwright/test';
import { startFakeModel, useFakeModel, type FakeModel } from './fake-model.js';
import { signUp } from './auth.js';

// The Phase 3 exit criterion (plan 18): a Bot writes a document, the owner
// edits it in the viewer, and both versions are visible, the Bot's and the
// owner's. The Bot is the scripted fake model, which calls `create_artifact`
// on "write a document"; creating its provider needs an admin, so run this
// against a fresh database (the first user to sign up is the admin).

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

let model: FakeModel | undefined;
test.afterAll(async () => model?.close());

test('a Bot writes a document, the owner edits it, both versions are visible', async ({ page }) => {
  await signUp(page, 'Artifacts', `artifacts-${Date.now()}@example.com`);
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
  const name = `Writer ${Date.now() % 10_000}`;
  const bot = (await request('/api/v1/bots', { method: 'POST', body: { name } })) as { id: string };
  model = await startFakeModel({ wordDelayMs: 20 });
  await useFakeModel(request, bot.id, model.baseUrl);

  await page.reload();
  await page.getByRole('link', { name }).first().click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Please write a document for the launch');
  await composer.press('Enter');

  // The Bot's version 1 arrives as a card in the transcript.
  const card = page.getByRole('log').locator('[data-artifact]').first();
  await expect(card).toContainText('Launch plan', { timeout: 30_000 });
  await expect(card).toContainText('Document · v1');
  await card.getByRole('button', { name: 'Open' }).click();

  const panel = page.getByRole('complementary');
  await expect(panel.getByRole('heading', { name: 'Launch plan', level: 3 })).toBeVisible();
  await expect(panel.getByText('Ship on Monday.')).toBeVisible();

  // The owner's edit becomes version 2.
  await panel.getByRole('button', { name: 'Edit' }).click();
  const editor = panel.getByRole('textbox', { name: 'Edit Launch plan' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Tell support on Friday.');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByText('v2 (current)')).toBeVisible();
  await expect(panel.getByText('Tell support on Friday.')).toBeVisible();

  // Both versions are in the history, the Bot's and the owner's.
  const history = panel.locator('ol');
  // Each version says who made it (A1): the owner's edit, the Bot's write.
  const version = (n: number) => history.locator(`li[data-version="${n}"]`);
  await expect(version(2)).toContainText('Edited by you');
  await expect(version(1)).toContainText(/^v1.*By /s);
  await version(1).getByRole('button', { name: /^v1/ }).click();
  await expect(panel.getByText('v1 of 2')).toBeVisible();
  await expect(panel.getByText('Tell support on Friday.')).toBeHidden();

  await panel.getByRole('button', { name: 'Compare' }).click();
  await panel.getByLabel('Compare to').selectOption('2');
  await expect(panel.locator('[data-diff="added"]')).toContainText('Tell support on Friday.');

  // The card follows the new version, and the Artifacts tab lists the document.
  await expect(card).toContainText('Document · v2');
  await page.getByRole('tab', { name: 'Artifacts' }).click();
  await expect(page).toHaveURL(/\/artifacts$/);
  const row = page.getByRole('main').getByRole('button', { name: /Launch plan/ });
  await expect(row).toContainText('2 versions');
  await row.click();
  await expect(panel.getByText('v2 (current)')).toBeVisible();
});
