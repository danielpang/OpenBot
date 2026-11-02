import { expect, test, type Page } from '@playwright/test';
import { signUp } from './auth.js';

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

const signUpRoster = (page: Page) =>
  signUp(page, 'Roster', `roster-${Date.now()}-${Math.random()}@example.com`);

const roster = (page: Page) => page.getByRole('navigation');

test('create a Bot from a name and an icon, and it asks what to work on', async ({ page }) => {
  await signUpRoster(page);
  await page.getByRole('button', { name: /New/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New Bot' })).toBeVisible();
  // The icon: pick a shape, then shuffle the rest; the shape stays.
  const shapes = dialog.getByRole('group', { name: 'Shape' });
  await shapes.getByRole('button', { name: 'Egg' }).click();
  await dialog.getByRole('button', { name: 'Shuffle' }).click();
  await expect(shapes.getByRole('button', { name: 'Egg' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByLabel('Bot name').fill('Finance');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page).toHaveURL(/\/bots\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  await expect(roster(page).getByRole('link', { name: /Finance/ })).toBeVisible();
  // The Bot spoke first, in its chat.
  await expect(
    page.getByRole('log').getByText("Hi, I'm Finance. What would you like me to work on?"),
  ).toBeVisible();

  // Its shape can change later in Settings.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('group', { name: 'Shape' }).getByRole('button', { name: 'Box' }).click();
  const save = page.getByRole('button', { name: 'Save', exact: true }).first();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole('group', { name: 'Shape' }).getByRole('button', { name: 'Box' }),
  ).toHaveAttribute('aria-pressed', 'true');
});
