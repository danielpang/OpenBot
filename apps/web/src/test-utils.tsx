import { DEFAULT_LIMITS } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { createAppRouter } from './app/router.js';

// Renders a path through the real route tree after its guards have run,
// following redirects the way the browser router would.

export async function renderPath(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(queryClient, history);
  let redirectTo: string | undefined;
  const resolveRedirect = router.resolveRedirect;
  router.resolveRedirect = (redirect) => {
    const resolved = resolveRedirect(redirect);
    redirectTo = resolved.options.href;
    return resolved;
  };
  for (let hops = 0; ; hops++) {
    redirectTo = undefined;
    await router.load();
    if (!redirectTo) break;
    if (hops > 5) throw new Error(`redirect loop at ${redirectTo}`);
    history.push(redirectTo);
  }
  const html = renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const { pathname, searchStr } = router.state.location;
  return { html, pathname, search: searchStr };
}

export const me = (role: 'owner' | 'admin' | 'member') => ({
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'ada@example.com',
    name: 'Ada',
    image: null,
    emailVerified: false,
    createdAt: '2026-10-14T00:00:00.000Z',
  },
  role,
  workspace: { id: '00000000-0000-4000-8000-000000000002', name: 'OpenBots', suspended: false },
  limits: { ...DEFAULT_LIMITS },
});
