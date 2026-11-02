import { expect, test } from '@playwright/test';
import { signUp } from './auth.js';

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

test('sign up and land on the shell', async ({ page }) => {
  await signUp(page, 'Smoke', `smoke-${Date.now()}@example.com`);

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: /New/ })).toBeVisible();
  for (const section of ['Pinned', 'Bots', 'Groups']) {
    await expect(page.getByRole('heading', { name: section })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
});
