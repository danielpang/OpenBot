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
        '/api': { target: server, changeOrigin: true, ws: true, headers: { origin: server } },
        '/ws': { target: server, changeOrigin: true, ws: true, headers: { origin: server } },
      },
    },
  }),
);
