import { defaultServerConditions } from 'vite';
import { defineProject } from 'vitest/config';
import shared, { sourceConditions } from '../../vitest.shared.ts';

// Like the shared config, but resolving packages the way Node does, without
// the bundler-only `module` condition: prom-client's optional
// `@opentelemetry/api` ships a `module` build only a bundler loads.
const conditions = [...sourceConditions, ...defaultServerConditions.filter((c) => c !== 'module')];

export default defineProject({
  ...shared,
  resolve: { conditions },
  ssr: { resolve: { conditions } },
});
