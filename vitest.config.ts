import { defineConfig } from 'vitest/config';

// Runs every workspace project in one process: `pnpm exec vitest run`.
// `pnpm test` runs each package through Turborepo instead, with caching.
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
  },
});
