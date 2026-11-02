import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery';

/**
 * Signs a new user up and lands on the shell. A fresh self-hosted install has
 * no users, so its sign-up page redirects to the first-run wizard (D1): the
 * first user is created there, as the owner, and the wizard's remaining
 * steps are skipped.
 *
 * The managed service (its server from ee/server, as CI runs it) has no
 * wizard: the email comes first, confirmed with a code (see `verificationCode`),
 * then the name and password; then the account
 * creates its organization, named `organization` or after the person, and
 * owns it. `signUpAt` does the same from an invite link instead.
 */
export async function signUp(
  page: Page,
  name: string,
  email: string,
  { organization }: { organization?: string } = {},
): Promise<void> {
  const setup = (await (await page.request.get('/api/v1/setup')).json()) as {
    setupRequired: boolean;
  };
  if (setup.setupRequired && (await createOwner(page, name, email))) {
    await page.goto('/');
  } else {
    await signUpAt(page, '/sign-up', name, email);
    // The app redirects to /onboarding on its own, after the page loads, so
    // wait for where it settles rather than reading the URL now.
    const create = page.getByRole('heading', { name: 'Create your organization' });
    const shell = page.getByRole('button', { name: /New/ });
    await expect(create.or(shell)).toBeVisible();
    if (await create.isVisible()) {
      await page.getByLabel('Name').fill(organization ?? `${name} Org`);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(shell).toBeVisible();
    }
  }
  await expect(page).toHaveURL('/');
}

/**
 * Signs up at `path` (/sign-up, or an invite link) in the managed service's
 * three steps: the email, the code the server logged, then the name and
 * password. Returns once the page has moved on.
 */
export async function signUpAt(page: Page, path: string, name: string, email: string) {
  const seen = logLines().length;
  await page.goto(path);
  await page.getByLabel('Email').fill(email);
  await submit(page, 'Send code', '/api/auth/sign-up/start');
  await expect(page.getByRole('heading', { name: 'Enter the code' })).toBeVisible();
  await page.getByLabel('Code').fill(await verificationCode(email, seen));
  await submit(page, 'Confirm', '/api/auth/sign-up/verify');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill(PASSWORD);
  await submit(page, 'Create account', '/api/auth/sign-up/complete');
  await expect(page.getByRole('heading', { name: 'Finish signing up' })).toBeHidden();
}

/** The server's log (E2E_SERVER_LOG), one JSON line each, or none. */
function logLines(): string[] {
  const file = process.env.E2E_SERVER_LOG;
  if (!file) return [];
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/**
 * The newest email verification code for `email` in the server's log after
 * line `after`. CI runs the managed server without email and with
 * OPENBOTS_DEV_LOG_EMAIL_LINKS=1, which logs the code instead of sending it.
 */
export async function verificationCode(email: string, after: number): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = logLines()
      .slice(after)
      .map((line) => {
        try {
          return JSON.parse(line) as { msg?: string; email?: string; code?: string };
        } catch {
          return {};
        }
      })
      .filter((entry) => entry.msg === 'email verification code' && entry.email === email)
      .at(-1)?.code;
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no email verification code for ${email} in E2E_SERVER_LOG`);
}

/** Attempts while the limit refuses them; each waits out the server's X-Retry-After. */
const ATTEMPTS = 4;

/**
 * Clicks `button`, which posts to `path`. Every spec signs up from the same
 * IP address, and sign-up and codes are rate limited per IP (kept on in CI),
 * so specs in one run can find the limit spent. Then the server answers 429
 * with X-Retry-After in seconds; this waits that long and clicks again.
 */
async function submit(page: Page, button: string, path: string) {
  for (let attempt = 1; ; attempt++) {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(path) && r.request().method() === 'POST'),
      page.getByRole('button', { name: button, exact: true }).click(),
    ]);
    if (res.status() !== 429) return;
    expect(attempt, `${button} stayed rate limited`).toBeLessThan(ATTEMPTS);
    const seconds = Number(res.headers()['x-retry-after']) || 10;
    await page.waitForTimeout(seconds * 1000 + 250);
  }
}

async function createOwner(page: Page, name: string, email: string): Promise<boolean> {
  await page.goto('/setup');
  await fillAccount(page, name, email);
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/setup/admin') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Create account' }).click(),
  ]);
  if (res.ok()) return true;
  expect(res.status(), 'only losing the race to another test is expected').toBe(409);
  return false;
}

async function fillAccount(page: Page, name: string, email: string) {
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
}
