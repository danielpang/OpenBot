import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineProject } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (the "@openbots/source"
// export condition) so tests never need a prior build.
export const sourceConditions = ['@openbots/source'];

export default defineProject({
  resolve: { conditions: [...sourceConditions, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [...sourceConditions, ...defaultServerConditions] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
