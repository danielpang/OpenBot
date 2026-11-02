import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { configureWeb, type WebExtensions } from './app/extensions.js';
import { createAppRouter } from './app/router.js';

// Renders the web app into #root. The self-hosted build (main.tsx) starts it
// with no extensions; the managed build (ee/web) passes its own (plan 21.5).
// Each entry imports its own stylesheet.

export function startWeb(extensions: WebExtensions = {}) {
  configureWeb(extensions);
  const root = document.getElementById('root');
  if (!root) throw new Error('missing #root element');

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient);

  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
