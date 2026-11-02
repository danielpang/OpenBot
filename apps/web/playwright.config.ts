import { defineConfig } from '@playwright/test';

// End-to-end smoke tests, skipped unless E2E=1. They drive the Vite dev server
// (started here if it is not already up), which proxies to the API server on
// :3000; start that yourself with a fresh database, OPENBOTS_DEPLOYMENT=managed
// and signup mode `open`, as CI does: the specs sign up several users, and a
// self-hosted install closes sign-up after its owner.
// Browsers are not installed with the dependencies; run
// `pnpm --filter @openbots/web exec playwright install chromium` once.

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL },
  webServer: process.env.E2E
    ? { command: 'pnpm dev', url: baseURL, reuseExistingServer: true }
    : undefined,
});
