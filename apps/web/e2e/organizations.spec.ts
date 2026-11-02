import { expect, test, type Browser, type Page } from '@playwright/test';
import { signUp, signUpAt } from './auth.js';

// Organizations on the managed service (plan 21), from the managed server
// and web app (ee/server, ee/web), as CI's "organizations" job runs them:
// sign up and create an organization; invite someone, who joins through the
// link; a second organization and the switcher; Bots that stay in their
// organization; providers at two levels; and suspension.

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

const stamp = Date.now();
const ADA = `ada-${stamp}@example.com`;
const BEA = `bea-${stamp}@example.com`;

async function managed(page: Page) {
  const capabilities = (await (await page.request.get('/api/v1/capabilities')).json()) as {
    deployment: string;
  };
  return capabilities.deployment === 'managed';
}

async function newPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

test('organizations: onboarding, invites, switching and isolation', async ({ browser, page }) => {
  test.skip(!(await managed(page)), 'needs the managed server');

  // Ada signs up without an invite: she creates Acme in one step and owns it.
  await signUp(page, 'Ada', ADA, { organization: `Acme ${stamp}` });
  await page.goto('/settings/organization');
  await expect(page.getByLabel('Name')).toHaveValue(`Acme ${stamp}`);
  // One organization: no switcher yet.
  await expect(page.getByRole('button', { name: 'Organization', exact: true })).toHaveCount(0);

  // Ada invites Bea from Settings > Members and copies the link.
  await page.goto('/settings/members');
  await page.getByLabel('Invite email').fill(BEA);
  await page.getByRole('button', { name: 'Invite' }).click();
  const link = await page.getByLabel('Invite link').inputValue();
  expect(link).toContain('/sign-up?invite=');
  await expect(page.getByText(BEA)).toBeVisible();

  // Bea signs up through the link: no onboarding step, just Join.
  const bea = await newPage(browser);
  await signUpAt(bea, new URL(link).pathname + new URL(link).search, 'Bea', BEA);
  await expect(bea.getByRole('heading', { name: `Join Acme ${stamp}` })).toBeVisible();
  await bea.getByRole('button', { name: 'Join' }).click();
  await expect(bea).toHaveURL('/');
  await bea.goto('/settings/members');
  // A member has no Members tab.
  await expect(bea).toHaveURL('/settings/account');

  // Bea makes a Bot in Acme.
  await bea.goto('/');
  await bea.getByRole('button', { name: /New/ }).click();
  const dialog = bea.getByRole('dialog');
  await dialog.getByLabel('Bot name').fill(`Acme helper ${stamp}`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(bea).toHaveURL(/\/bots\/[0-9a-f-]+$/);
  await expect(bea.getByRole('navigation').getByText(`Acme helper ${stamp}`)).toBeVisible();

  // Bea creates her own organization; the switcher appears and she is in it.
  await bea.goto('/settings/organization');
  await bea.getByRole('button', { name: 'Create organization' }).click();
  await bea.getByLabel('Name').last().fill(`Bea Co ${stamp}`);
  await bea.getByRole('button', { name: 'Create organization' }).click();
  await expect(bea).toHaveURL('/');
  const switcher = bea.getByRole('button', { name: 'Organization', exact: true });
  await expect(switcher).toContainText(`Bea Co ${stamp}`);
  // Her Acme Bot is not here: each organization has its own.
  await expect(bea.getByRole('navigation').getByText(`Acme helper ${stamp}`)).toHaveCount(0);

  // Models: her organization's providers and her own, apart.
  await bea.goto('/settings/models');
  await expect(bea.getByRole('heading', { name: 'Organization' })).toBeVisible();
  await expect(bea.getByRole('heading', { name: 'Yours' })).toBeVisible();

  // Back to Acme through the switcher; the Bot is there again.
  await switcher.click();
  await bea.getByRole('menuitem', { name: `Acme ${stamp}` }).click();
  await expect(bea.getByRole('navigation').getByText(`Acme helper ${stamp}`)).toBeVisible();

  // Ada never sees Bea's Bot (U2), as owner or not.
  await page.goto('/');
  await expect(page.getByRole('navigation').getByText(`Acme helper ${stamp}`)).toHaveCount(0);

  // Ada suspends Bea in Acme: Bea is sent to pick another organization.
  await page.goto('/settings/members');
  const row = page.locator(`[data-member="${BEA}"]`);
  await row.getByRole('button', { name: 'Suspend' }).click();
  await expect(row.getByText('Suspended')).toBeVisible();
  await bea.reload();
  await expect(bea).toHaveURL('/onboarding');
  await expect(bea.getByText(`You are suspended in Acme ${stamp}.`)).toBeVisible();
  await bea.getByRole('button', { name: `Bea Co ${stamp}` }).click();
  await expect(bea).toHaveURL('/');

  // The audit log shows what happened in Acme.
  await page.goto('/settings/audit');
  await expect(page.getByText('member.suspend')).toBeVisible();
  await expect(page.getByText('invitation.accept')).toBeVisible();
});
