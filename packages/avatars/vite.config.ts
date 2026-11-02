import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// `pnpm --filter @openbots/avatars grid`: the eyeballing page in dev/, a grid of
// 50 seeds in all six states plus the editor. Not named `dev` so `pnpm dev`
// (turbo) does not start it alongside the app.
export default defineConfig({
  root: 'dev',
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['@openbots/source', ...defaultClientConditions] },
});
