import { defaultServerConditions } from 'vite';
import { defineProject } from 'vitest/config';
import shared, { sourceConditions } from '../../vitest.shared.ts';

// As apps/server: Node's resolution without the bundler-only `module` condition.
const conditions = [...sourceConditions, ...defaultServerConditions.filter((c) => c !== 'module')];

export default defineProject({
  ...shared,
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  // Sign-up flows make many requests per test; under CI's parallel turbo run
  // they outgrow the 5s default though each takes well under a second alone.
  test: {
    ...shared.test,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    setupFiles: ['./src/test-setup.ts'],
  },
});
