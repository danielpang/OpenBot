// Account-level pages linked at the foot of the sidebar (PRD section 5). Add
// an entry here when a page lands; the sidebar renders this list as is.

export interface NavLink {
  to: '/connectors' | '/skills' | '/computer' | '/settings';
  label: string;
}

export const NAV_LINKS: NavLink[] = [
  { to: '/connectors', label: 'Connectors' },
  { to: '/skills', label: 'Skills' },
  { to: '/computer', label: 'Computer' },
  { to: '/settings', label: 'Settings' },
];
