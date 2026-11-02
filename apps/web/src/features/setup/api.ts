import { unwrap, type components } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';
import type { Provider } from '../models/api.js';

// The first-run wizard (D1, plan 16.3). `GET /setup` is public: the router
// asks it before sign-in, and shows the wizard only while no user exists.

export type SandboxImage = components['schemas']['SandboxImage'];

export const setupQuery = queryOptions({
  queryKey: ['setup'],
  queryFn: () => unwrap(api.GET('/api/v1/setup')),
  staleTime: 0,
});

/** Whether to show the wizard. An unreachable server counts as set up, so sign-in still shows. */
export async function setupRequired(
  fetchSetup: () => Promise<{ setupRequired: boolean }>,
): Promise<boolean> {
  try {
    return (await fetchSetup()).setupRequired;
  } catch {
    return false;
  }
}

export const createAdmin = (body: components['schemas']['CreateAdmin']) =>
  unwrap(api.POST('/api/v1/setup/admin', { body }));

export const sandboxImageQuery = queryOptions({
  queryKey: ['setup', 'sandbox-image'],
  queryFn: () => unwrap(api.GET('/api/v1/setup/sandbox-image')),
  // Status only: poll while the pull runs.
  refetchInterval: (query) => (query.state.data?.status === 'pulling' ? 2_000 : false),
});

export const startSandboxPull = () => unwrap(api.POST('/api/v1/setup/sandbox-image'));

/**
 * A provider the first Bot can run on: it has a key and its last Test passed
 * (L1). `degraded` does not count: Bots need tool calling.
 */
export function usableProvider(provider: Pick<Provider, 'hasKey' | 'status'>): boolean {
  return provider.hasKey && provider.status === 'ok';
}

/**
 * What the key step says under one provider after saving or testing its key;
 * nothing once the test passed, since a check mark replaces the button then.
 */
export function keyStatusText(
  provider: Pick<Provider, 'hasKey' | 'status' | 'testResult'>,
): string | null {
  if (!provider.hasKey) return 'No key yet';
  switch (provider.status) {
    case 'ok':
      return null;
    case 'degraded':
      return 'The key works, but tool calling failed, and Bots need it';
    case 'error':
      return `The key did not work: ${provider.testResult?.error ?? 'the test failed'}`;
    default:
      return 'Key saved, not tested yet';
  }
}

/** The empty key field's placeholder: the saved key's hint, `sk-ant-…a1b2 saved`, when there is one (P3). */
export function keyPlaceholder(provider?: Pick<Provider, 'hasKey' | 'keyHint'>): string {
  if (!provider?.hasKey) return 'API key';
  return provider.keyHint ? `${provider.keyHint} saved` : 'Key set (from .env or earlier)';
}

export const SANDBOX_LABELS: Record<SandboxImage['status'], string> = {
  not_configured: 'Not set up: Bots run without a computer',
  idle: 'Not started',
  pulling: 'Downloading the computer image in the background…',
  ready: 'Computer image ready',
  error: 'Download failed. It retries when a Bot needs its computer.',
};
