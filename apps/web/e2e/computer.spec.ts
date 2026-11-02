import { expect, test } from '@playwright/test';
import { signUp } from './auth.js';

// The Computer page (K1, K7) against an install that has a computer: start
// it, open the terminal, upload a file and download it again. Skipped unless
// the server reports a computer provider, which needs the docker guard
// (`pnpm --filter @openbots/computer docker-guard` in front of the local Docker
// socket, and `DOCKER_HOST=tcp://127.0.0.1:2375` for the server; the server
// refuses the raw socket or the socket proxy) or a running control agent
// (`OPENBOTS_COMPUTER_AGENT_URL` and `OPENBOTS_COMPUTER_AGENT_TOKEN`, e.g.
// `apps/computer-agent` started locally). The first start may pull the
// sandbox image.

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

test('start the computer, open its terminal, upload and download a file', async ({ page }) => {
  await signUp(page, 'Computer', `computer-${Date.now()}@example.com`);
  await expect(page).toHaveURL('/');

  const capabilities = (await (await page.request.get('/api/v1/capabilities')).json()) as {
    computer?: boolean;
  };
  test.skip(!capabilities.computer, 'the server has no computer provider');

  await page.getByRole('link', { name: 'Computer' }).click();
  const start = page.getByRole('button', { name: 'Start' });
  if (await start.isVisible()) await start.click();
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 300_000 });

  await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible();
  await expect(page.getByText('Connecting…')).toBeHidden({ timeout: 30_000 });

  const name = `e2e-${Date.now()}.txt`;
  await page.getByLabel('Files to upload').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from the e2e test'),
  });
  const link = page.getByRole('list', { name: 'Files' }).getByRole('link', { name });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(name);
});
