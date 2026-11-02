import { unwrap } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';
import createFetchClient from 'openapi-fetch';
import type { components, paths } from './schema.js';

// The managed routes' client (ee/server/openapi.json), beside the core's.
// Same origin, with the session cookie.

const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;

export const orgApi = createFetchClient<paths>({ baseUrl: origin, credentials: 'include' });

export type Organization = components['schemas']['Organization'];
export type Member = components['schemas']['OrganizationMember'];
export type Invitation = components['schemas']['OrganizationInvitation'];
export type Role = components['schemas']['OrganizationRole'];
export type AuditEntry = components['schemas']['AuditEntry'];

export const organizationsQuery = queryOptions({
  queryKey: ['organizations'],
  queryFn: () => unwrap(orgApi.GET('/api/v1/organizations')),
  staleTime: 60_000,
});

export const membersQuery = queryOptions({
  queryKey: ['organization', 'members'],
  queryFn: () => unwrap(orgApi.GET('/api/v1/organization/members')),
});

export const invitationsQuery = queryOptions({
  queryKey: ['organization', 'invitations'],
  queryFn: () => unwrap(orgApi.GET('/api/v1/organization/invitations')),
});

/**
 * Before a GitHub or Google sign-in from an invite link: the server sets a
 * signed cookie for 10 minutes, so the account the provider creates may join
 * the invitation. An invitation that is no longer pending carries nothing;
 * onboarding then says why.
 */
export async function carryInvite(invite: string, fetch = globalThis.fetch) {
  await orgApi.POST('/api/v1/invitations/{id}/oauth', {
    params: { path: { id: invite } },
    fetch,
  });
}

export const invitationQuery = (id: string) =>
  queryOptions({
    queryKey: ['invitation', id],
    queryFn: () => unwrap(orgApi.GET('/api/v1/invitations/{id}', { params: { path: { id } } })),
    retry: false,
  });

/**
 * Everything on the page belongs to one organization, the realtime socket
 * included, so switching starts the app again in the new one.
 */
export function reloadInto(path = '/') {
  window.location.assign(path);
}

export const createOrganization = (name: string) =>
  unwrap(orgApi.POST('/api/v1/organizations', { body: { name } }));

export const activateOrganization = (id: string) =>
  unwrap(orgApi.POST('/api/v1/organizations/{id}/activate', { params: { path: { id } } }));

export const acceptInvitation = (id: string) =>
  unwrap(orgApi.POST('/api/v1/invitations/{id}/accept', { params: { path: { id } } }));
