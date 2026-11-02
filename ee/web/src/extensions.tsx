import { isAdmin, type WebExtensions } from '@openbots/web/extensions';
import { carryInvite } from './api.js';
import { AuditLog } from './audit-log.js';
import { MembersSettings } from './members.js';
import { Onboarding } from './onboarding.js';
import { OrganizationSettings } from './organization-settings.js';
import { OrganizationSwitcher } from './switcher.js';

// What the managed web app adds to the core app (plan 21.5): the switcher,
// onboarding (create an organization, or join through an invite), the
// organization's settings, and an invite carried through a GitHub or Google
// sign-up. Model providers at both levels are the core's
// Settings > Models, which shows "Organization" and "Yours" here.

export const managedWeb: WebExtensions = {
  SidebarHeader: OrganizationSwitcher,
  Onboarding,
  beforeSocialSignIn: (invite) => carryInvite(invite),
  settingsTabs: [
    {
      section: 'organization',
      label: 'Organization',
      visible: () => true,
      Component: OrganizationSettings,
    },
    {
      section: 'members',
      label: 'Members',
      visible: (me) => isAdmin(me.role),
      Component: MembersSettings,
    },
    {
      section: 'audit',
      label: 'Audit log',
      visible: (me) => isAdmin(me.role),
      Component: AuditLog,
    },
  ],
};
