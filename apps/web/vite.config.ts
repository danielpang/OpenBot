import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';
import shared, { sourceConditions } from '../../vitest.shared.ts';

const server = process.env.OPENBOTS_DEV_SERVER ?? 'http://localhost:3000';

export default mergeConfig(
  shared,
  defineConfig({
    plugins: [
      // Generates src/routeTree.gen.ts from the files under src/routes.
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
        quoteStyle: 'single',
        semicolons: true,
      }),
      react(),
      tailwindcss(),
    ],
    resolve: { conditions: [...sourceConditions, ...defaultClientConditions] },
    server: {
      proxy: {
        // The server's CORS and better-auth's origin check trust only
        // OPENBOTS_PUBLIC_URL, so proxied requests present the server's origin.
        // `ws` for the computer's terminal and screen sockets under /api/v1.
        // The Mac app's local sign-in, passed through as sent: the server refuses
        // it from anything with an Origin (apps/server routes/local.ts). First, as
        // the first matching key wins.
        '/api/v1/local/session': { target: server, changeOrigin: true },
        '/api': { target: server, changeOrigin: true, ws: true, headers: { origin: server } },
        '/ws': { target: server, changeOrigin: true, ws: true, headers: { origin: server } },
        // The Mac app checks these before it opens a dev server (OPENBOTS_DESKTOP_LOCAL_URL).
        '/healthz': { target: server, changeOrigin: true },
        '/readyz': { target: server, changeOrigin: true },
      },
    },
  }),
);
