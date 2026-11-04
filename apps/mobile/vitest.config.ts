import { fileURLToPath } from 'node:url';
import { defineProject, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.ts';
export default mergeConfig(
  shared,
  defineProject({
    resolve: {
      alias: {
        'react-native': fileURLToPath(new URL('./vitest.react-native.ts', import.meta.url)),
      },
    },
    test: { name: 'mobile' },
  }),
);
