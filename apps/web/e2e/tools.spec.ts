import {
  startMockAuthServer,
  startTestHttpServer,
  type MockAuthServer,
  type TestHttpServer,
} from '@openbots/mcp/testing';
import { expect, test } from '@playwright/test';
import { startFakeModel, useFakeModel, type FakeModel } from './fake-model.js';
import { signUp } from './auth.js';

// The Phase 2 exit criterion (plan 18.3) through the UI: add an MCP server on
// the Connectors page by pasting its URL and clicking Connect (it is tested on
// add, so its tools are listed), connect an OAuth server with one click (the
// popup signs in at the mock authorization server, which consents at once,
// and closes itself; the card turns Connected without a reload), a Bot calls
// its destructive tool, the approval appears in the transcript, Approve, and
// the run continues with the tool's result. The MCP server is the HTTP test
// server from `@openbots/mcp/testing` (build that package first) and the model
// is the scripted fake. Needs a fresh database: the first user is the admin
// who can add the fake provider.

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

let model: FakeModel | undefined;
let mcp: TestHttpServer | undefined;
let authServer: MockAuthServer | undefined;
let secured: TestHttpServer | undefined;
test.afterAll(async () => {
  await model?.close();
  await mcp?.close();
  await secured?.close();
  await authServer?.close();
});

test('add a connector, then approve its destructive tool from the transcript', async ({ page }) => {
  await signUp(page, 'Tools', `tools-${Date.now()}@example.com`);
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
  const name = `Grace ${Date.now() % 10_000}`;
  const bot = (await request('/api/v1/bots', { method: 'POST', body: { name } })) as { id: string };
  model = await startFakeModel({ wordDelayMs: 10 });
  await useFakeModel(request, bot.id, model.baseUrl);
  mcp = await startTestHttpServer();

  // Add the server by its URL. It listens on 127.0.0.1, so the check before
  // adding and the test on add are refused (S-8) until the owner marks it as
  // running on their network; it is added as is, and Test then lists the two
  // tools.
  await page.goto('/connectors');
  await page.getByText('Add custom MCP server').click();
  const form = page.getByRole('form', { name: 'Custom MCP server' });
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/v1/connectors/discover'));
  await form.getByLabel('URL', { exact: true }).fill(mcp.url);
  await checked;
  await form.getByRole('button', { name: 'Connect' }).click();
  const card = page.locator('[data-connector]', { hasText: new URL(mcp.url).host });
  await expect(card.locator('[data-status]')).toHaveAttribute('data-status', 'error', {
    timeout: 20_000,
  });
  await card.getByRole('switch', { name: /runs on my network/i }).check();
  await expect(card.getByText('· on my network')).toBeVisible();
  await card.getByRole('button', { name: 'Test' }).click();
  await expect(card.getByText(/Working · 2 tools/)).toBeVisible({ timeout: 20_000 });

  // One-click OAuth: the owner marks the sign-in server's connector local (it
  // is on 127.0.0.1 too), then Connect opens the popup, the mock authorization
  // server consents at once, the callback page tells this page and closes, and
  // the card says Connected and lists the tools without a reload.
  authServer = await startMockAuthServer();
  const auth = authServer;
  secured = await startTestHttpServer({
    authorize: (a) => auth.validates(a),
    authorizationServer: auth.url,
  });
  const oauth = (await request('/api/v1/connectors', {
    method: 'POST',
    body: { name: 'Secured', url: secured.url, auth: 'oauth' },
  })) as { id: string };
  await request(`/api/v1/connectors/${oauth.id}/local`, { method: 'PUT', body: { local: true } });
  await page.reload();
  const securedCard = page.locator(`[data-connector="${oauth.id}"]`);
  await expect(securedCard.locator('[data-status]')).toHaveText(/Not connected/);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    securedCard.getByRole('button', { name: 'Connect' }).click(),
  ]);
  await popup.waitForEvent('close', { timeout: 20_000 });
  await expect(securedCard.getByText(/Connected · 2 tools/)).toBeVisible({ timeout: 20_000 });
  await expect(securedCard.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);

  // The Bot calls the destructive tool; the policy asks.
  await page.getByRole('link', { name }).first().click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Please delete everything');
  await composer.press('Enter');
  const approval = page.locator('[data-widget="approval"]');
  await expect(approval).toHaveAttribute('data-status', 'pending', { timeout: 20_000 });
  await expect(approval.getByText(/delete_everything/).first()).toBeVisible();

  await approval.getByRole('button', { name: 'Approve' }).click();
  await expect(approval).toHaveAttribute('data-status', 'approved');
  await expect(approval.getByText(/Approved by you/)).toBeVisible();
  // The run resumes with the tool's real result. The fake echoes it as the
  // model reads it, framed on lines of its own in <tool_result> (S-10), and a
  // regex matches the text as written, so `.` must also cross line breaks.
  await expect(page.getByRole('log').getByText(/Got it: .*"deleted"/s)).toBeVisible({
    timeout: 20_000,
  });
});
