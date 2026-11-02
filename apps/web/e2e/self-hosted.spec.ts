import { expect, test } from '@playwright/test';
import { signUp } from './auth.js';

// A self-hosted install (OPENBOTS_DEPLOYMENT=self_hosted, the default): the
// setup wizard makes the one account, its owner. Settings has no Admin or
// Audit log tab and their links go to Account; sign-up is closed, so
// /sign-up offers sign-in only. CI runs it in its own job on a fresh database.

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

test('the owner gets no admin screens, and sign-up closes', async ({ page, request }) => {
  const capabilities = (await (await request.get('/api/v1/capabilities')).json()) as {
    deployment: string;
  };
  test.skip(capabilities.deployment !== 'self_hosted', 'needs a self-hosted server');
  const setup = (await (await request.get('/api/v1/setup')).json()) as { setupRequired: boolean };
  test.skip(!setup.setupRequired, 'needs a fresh database so this user is the owner');

  await signUp(page, 'Owner', `owner-${Date.now()}@example.com`);

  await page.goto('/settings/account');
  const tabs = page.getByRole('tablist');
  for (const tab of ['Account', 'Models', 'Events', 'Limits']) {
    await expect(tabs.getByRole('tab', { name: tab })).toBeVisible();
  }
  await expect(tabs.getByRole('tab', { name: 'Admin' })).toHaveCount(0);
  await expect(tabs.getByRole('tab', { name: 'Audit log' })).toHaveCount(0);

  for (const path of ['/settings/admin', '/settings/audit']) {
    await page.goto(path);
    await expect(page).toHaveURL('/settings/account');
  }
  expect((await page.request.get('/api/v1/admin/members')).status()).toBe(404);
  expect((await page.request.get('/api/v1/admin/audit')).status()).toBe(404);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto('/sign-up');
  await expect(page).toHaveURL(/\/sign-in\?signup=closed/);
  await expect(page.getByText('Sign up is closed.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign up' })).toHaveCount(0);
});
