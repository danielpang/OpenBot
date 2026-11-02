import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { capabilitiesQuery, meQuery } from '../../app/api.js';
import { adminLabel, useManaged } from '../../app/deployment.js';
import { settingsQuery } from '../settings/admin-settings.js';
import { catalogQuery, connectorsQuery } from './api.js';
import { BlockList, CustomStdioSetting } from './block-list.js';
import { Catalog } from './catalog.js';
import { ConnectorCard } from './connector-card.js';
import { CustomServerForm, ImportForm } from './custom-server.js';
import { ErrorText } from './fields.js';
import { stdioAvailability } from './forms.js';
import { useTestConnector } from './hooks.js';
import { useRealtime } from '../transcript/realtime.js';

// The account-level Connectors page (T1 to T3, PRD section 5): the owner's
// connectors, the catalog, a custom server, pasted JSON, and for admins the
// connector policy: custom stdio on or off, the block list and the allow
// list. `?connector=<id>` scrolls to a connector (the "needs login" event
// links here); a sign-in in this same tab comes back with
// `oauth=connected|error`. A sign-in finished anywhere (a popup, the Mac
// app's browser, another tab) arrives as `connector.updated` and refreshes
// the list at once.

export interface ToolsSearch {
  connector?: string;
  oauth?: 'connected' | 'error';
  message?: string;
}

export function ToolsPage({
  search,
  onSearchHandled,
}: {
  search: ToolsSearch;
  /** Drops `oauth` and `message` from the URL once read, so a reload does not repeat them. */
  onSearchHandled?(): void;
}) {
  const me = useQuery(meQuery);
  const isAdmin = me.data?.role === 'owner' || me.data?.role === 'admin';
  const managed = useManaged();
  const capabilities = useQuery({ ...capabilitiesQuery, enabled: false });
  const settings = useQuery({ ...settingsQuery, enabled: isAdmin });
  const stdio = stdioAvailability(
    me.data?.role,
    settings.data?.customStdioEnabled,
    capabilities.data?.customStdio ?? true,
  );
  const catalog = useQuery(catalogQuery);
  const connectors = useQuery(connectorsQuery);
  const test = useTestConnector();
  const [notice] = useState(() => oauthNotice(search));
  const queryClient = useQueryClient();
  const { client } = useRealtime();

  useEffect(
    () =>
      client?.on('connector.updated', () => {
        void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      }),
    [client, queryClient],
  );
  const handled = useRef(false);

  // A successful login is when the connector can first list its tools.
  useEffect(() => {
    if (handled.current || !search.oauth) return;
    handled.current = true;
    if (search.oauth === 'connected' && search.connector) test.mutate(search.connector);
    onSearchHandled?.();
  }, [search, test, onSearchHandled]);

  const target = search.connector;
  const items = connectors.data?.items;
  useEffect(() => {
    if (!target || !items?.some((c) => c.id === target)) return;
    document
      .getElementById(`connector-${target}`)
      ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [target, items]);

  const entries = new Map(catalog.data?.items.map((e) => [e.id, e]));
  return (
    <>
      {notice && (
        <p
          role="status"
          className={
            notice.ok
              ? 'rounded-md border px-3 py-2 text-sm'
              : 'rounded-md border border-destructive px-3 py-2 text-sm text-destructive'
          }
        >
          {notice.text}
        </p>
      )}
      <section className="flex flex-col gap-3" aria-labelledby="connectors-title">
        <h2 id="connectors-title" className="font-medium">
          Your connectors
        </h2>
        <p className="text-sm text-muted-foreground">
          Your Bots can use these; narrow them in each Bot&apos;s Settings.
        </p>
        <ErrorText error={connectors.error} />
        {items && !items.length && (
          <p className="text-sm text-muted-foreground">No connectors yet.</p>
        )}
        <ul className="flex flex-col gap-3">
          {items?.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              entry={connector.catalogId ? entries.get(connector.catalogId) : undefined}
              highlighted={connector.id === target}
              admin={isAdmin}
            />
          ))}
        </ul>
      </section>
      <Catalog />
      <Fold title="Add custom MCP server">
        <CustomServerForm key={stdio} stdio={stdio} />
      </Fold>
      <Fold title="Import JSON">
        <ImportForm stdio={stdio} />
      </Fold>
      {isAdmin && (
        <section className="flex flex-col gap-3" aria-labelledby="block-title">
          <h2 id="block-title" className="font-medium">
            {adminLabel(managed, 'connector policy')}
          </h2>
          <CustomStdioSetting />
          <BlockList />
        </section>
      )}
    </>
  );
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer select-none text-sm font-medium">{title}</summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

/** What the OAuth callback said, as a line at the top of the page. */
export function oauthNotice(search: ToolsSearch): { ok: boolean; text: string } | null {
  if (search.oauth === 'connected') return { ok: true, text: 'Connected. Checking its tools…' };
  if (search.oauth === 'error') {
    return {
      ok: false,
      text: `Could not connect${search.message ? `: ${search.message}` : '.'}`,
    };
  }
  return null;
}
