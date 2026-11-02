import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';
import type { Role } from '@openbots/server/workspace';

// Roles in an organization (plan 21.6), through better-auth's access
// control. Owners and admins manage members, invitations, the organization's
// providers, settings and limits, and read its audit log; only owners delete
// the organization (not offered yet). Members manage nothing of the
// organization's. Nobody here reaches a member's Bots or other per-user
// data: the core's ownership checks hold for every role (U2).
//
// What the statements cannot say is in `organizations.ts`: only an owner
// makes or removes an owner, and an organization always keeps one.

export const statements = {
  ...defaultStatements,
  provider: ['manage'],
  settings: ['update'],
  audit: ['read'],
} as const;

export const ac = createAccessControl(statements);

const manager = {
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  provider: ['manage'],
  settings: ['update'],
  audit: ['read'],
} as const;

export const roles = {
  owner: ac.newRole({ ...manager, organization: ['update', 'delete'] }),
  admin: ac.newRole({ ...manager, organization: ['update'] }),
  member: ac.newRole({}),
};

type Request = { [K in keyof typeof statements]?: (typeof statements)[K][number][] };

/** Whether a role may do what `request` names. */
export function can(role: Role, request: Request): boolean {
  return roles[role].authorize(request as never).success;
}
