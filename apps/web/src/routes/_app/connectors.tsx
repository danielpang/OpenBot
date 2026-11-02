import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { Page } from '../../app/page.js';
import { ToolsPage, type ToolsSearch } from '../../features/tools/tools-page.js';

export const Route = createFileRoute('/_app/connectors')({
  validateSearch: (search: Record<string, unknown>): ToolsSearch => ({
    ...(typeof search.connector === 'string' ? { connector: search.connector } : {}),
    ...(search.oauth === 'connected' || search.oauth === 'error' ? { oauth: search.oauth } : {}),
    ...(typeof search.message === 'string' ? { message: search.message } : {}),
  }),
  component: Connectors,
});

function Connectors() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const connector = search.connector;
  const handled = useCallback(
    () => void navigate({ search: connector ? { connector } : {}, replace: true }),
    [navigate, connector],
  );
  return (
    <Page title="Connectors">
      <ToolsPage search={search} onSearchHandled={handled} />
    </Page>
  );
}
