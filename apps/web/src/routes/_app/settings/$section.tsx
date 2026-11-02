import { createFileRoute, redirect } from '@tanstack/react-router';
import { webExtensions } from '../../../app/extensions.js';

// A settings tab the managed build adds (plan 21.5), such as
// /settings/organization. Tabs the core has are their own routes and win.

export const Route = createFileRoute('/_app/settings/$section')({
  beforeLoad: ({ context, params }) => {
    const tab = webExtensions().settingsTabs?.find((t) => t.section === params.section);
    if (!tab || !tab.visible(context.me)) throw redirect({ to: '/settings' });
  },
  component: ExtensionTab,
});

function ExtensionTab() {
  const { section } = Route.useParams();
  const tab = webExtensions().settingsTabs?.find((t) => t.section === section);
  return tab ? <tab.Component /> : null;
}
