import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { defaultClientConditions, type Plugin } from 'vite';

// electron-vite (plan 18.8): the main process, the preload and the app's own
// pages, built into dist/ where electron-builder picks them up. The workspace
// packages are bundled from source; electron-updater and ws stay external and
// ship in the app's node_modules. The app's own pages are React with
// Tailwind and the web app's theme and components (@openbots/ui).

const sourceConditions = ['@openbots/source'];
const bundled = ['@openbots/api-client', '@openbots/shared'];

export default defineConfig({
  main: {
    resolve: { conditions: [...sourceConditions, 'node', 'import', 'default'] },
    build: {
      outDir: 'dist/main',
      externalizeDeps: { exclude: bundled },
      rollupOptions: { input: resolve('src/main/index.ts') },
    },
  },
  preload: {
    resolve: { conditions: [...sourceConditions, 'browser', 'import', 'default'] },
    build: {
      outDir: 'dist/preload',
      // A sandboxed preload can only require Electron's renderer modules, so
      // everything else is bundled into one CommonJS file.
      externalizeDeps: false,
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        // The stack bridge imports the manager's module for its error class;
        // none of the manager's Node imports may reach the preload.
        treeshake: { moduleSideEffects: false },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), devContentSecurityPolicy()],
    resolve: { conditions: [...sourceConditions, ...defaultClientConditions] },
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'quick-ask': resolve('src/renderer/quick-ask.html'),
          pair: resolve('src/renderer/pair.html'),
        },
      },
    },
  },
});

/**
 * The pages' Content-Security-Policy allows no inline script. The dev server
 * needs one for React Fast Refresh, so `electron-vite dev` alone allows it;
 * a build keeps the policy as written.
 */
function devContentSecurityPolicy(): Plugin {
  return {
    name: 'openbots:dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
  };
}
