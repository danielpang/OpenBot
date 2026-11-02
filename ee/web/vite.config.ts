import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';
import shared, { sourceConditions } from '../../vitest.shared.ts';

// The managed web app (plan 21.5): apps/web's app, its routes and its public
// files, started with the managed extensions. Its route tree is the one
// apps/web generates; nothing here adds routes.

const server = process.env.OPENBOTS_DEV_SERVER ?? 'http://localhost:3000';

export default mergeConfig(
  shared,
  defineConfig({
    plugins: [react(), tailwindcss()],
    publicDir: '../../apps/web/public',
    resolve: { conditions: [...sourceConditions, ...defaultClientConditions] },
    server: {
      proxy: {
        '/api': { target: server, changeOrigin: true, ws: true, headers: { origin: server } },
        '/ws': { target: server, changeOrigin: true, ws: true, headers: { origin: server } },
      },
    },
  }),
);
