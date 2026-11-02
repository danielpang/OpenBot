import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { isAdmin, webExtensions, type ActiveMe } from '../../app/extensions.js';
import { Page } from '../../app/page.js';

export const Route = createFileRoute('/_app/settings')({
  component: Settings,
});

// The active tab looks like the sidebar's active link. It goes through the
// Link's `data-status`, because a variant beats the base text colour where a
// second plain colour class may not.
const TAB_CLASS =
  'rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-foreground';

/**
 * The tabs a caller gets. A self-hosted owner changes the limits in Limits.
 * The managed build adds its organization tabs (plan 21.5), where an
 * organization's owners and admins find its limits. In the Mac app's local
 * mode there is no account: General, with the owner's name, takes Account's
 * place.
 */
function settingsTabs(me: ActiveMe, managed: boolean, localAuth: boolean) {
  return [
    localAuth
      ? { to: '/settings/general', label: 'General' }
      : { to: '/settings/account', label: 'Account' },
    { to: '/settings/models', label: 'Models' },
    { to: '/settings/events', label: 'Events' },
    ...(isAdmin(me.role) && !managed ? [{ to: '/settings/limits', label: 'Limits' }] : []),
    ...(webExtensions().settingsTabs ?? [])
      .filter((tab) => tab.visible(me))
      .map((tab) => ({ to: `/settings/${tab.section}`, label: tab.label })),
  ];
}

function Settings() {
  const { me, deployment, localAuth } = Route.useRouteContext();
  const tabs = settingsTabs(me, deployment === 'managed', localAuth);

  return (
    <Page title="Settings">
      <div role="tablist" className="flex gap-1 border-b pb-2">
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            role="tab"
            className={TAB_CLASS}
            activeProps={{ 'aria-selected': true }}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <Outlet />
    </Page>
  );
}
