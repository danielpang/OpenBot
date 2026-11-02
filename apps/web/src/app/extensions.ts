import type { components } from '@openbots/api-client';
import type { ComponentType } from 'react';

// Extension points for the managed web app (plan 21.5). The core never
// imports ee/: ee/web imports the core, passes these to `startWeb`, and the
// core renders them where they go. The self-hosted web app passes none and
// has no organization concept anywhere.

export type Me = components['schemas']['Me'];
export type Role = NonNullable<Me['role']>;

/** The caller with an active organization they are not suspended in. */
export type ActiveMe = Me & {
  role: Role;
  workspace: NonNullable<Me['workspace']>;
  limits: NonNullable<Me['limits']>;
};

export const isActive = (me: Me): me is ActiveMe =>
  me.role !== null && me.workspace !== null && !me.workspace.suspended && me.limits !== null;

/** Owners and admins manage the organization (or a self-hosted owner, the install). */
export const isAdmin = (role: Me['role'] | undefined) => role === 'owner' || role === 'admin';

export interface SettingsTab {
  /** The path under /settings, as in `/settings/organization`. */
  section: string;
  label: string;
  /** Whether the caller gets the tab. */
  visible(me: ActiveMe): boolean;
  Component: ComponentType;
}

export interface WebExtensions {
  /** At the top of the sidebar, above New (the organization switcher). */
  SidebarHeader?: ComponentType;
  /** Settings tabs after the core's, each at `/settings/<section>`. */
  settingsTabs?: SettingsTab[];
  /**
   * `/onboarding`: shown to someone signed in with no active organization,
   * or suspended in theirs, and to anyone arriving with an invite
   * (`?invite=<id>`), after they sign in or sign up.
   */
  Onboarding?: ComponentType<{ me: Me; invite?: string }>;
  /**
   * Before a GitHub or Google sign-in from an invite link. The managed build
   * sets a short-lived cookie that carries the invite through the provider,
   * so the account the provider creates may join it (plan 21.6).
   */
  beforeSocialSignIn?(invite: string): Promise<void>;
}

let extensions: WebExtensions = {};

/** Sets the extensions; call once, before the app renders (`startWeb` does). */
export function configureWeb(next: WebExtensions) {
  extensions = next;
}

export function webExtensions(): WebExtensions {
  return extensions;
}
