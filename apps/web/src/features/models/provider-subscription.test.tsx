import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import { codersQuery, type CoderAccount } from '../coders/api.js';
import { ProviderSubscription } from './provider-subscription.js';

function connection(
  kind: 'anthropic' | 'openai' | 'xai',
  overrides: Partial<CoderAccount> = {},
  computer = true,
  configured = true,
) {
  const agent = kind === 'anthropic' ? 'claude' : kind === 'openai' ? 'codex' : 'pi';
  const account: CoderAccount = {
    agent,
    label: agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'pi',
    authKind: 'none',
    accountLabel: null,
    signedInAt: null,
    version: '1.5',
    lastError: null,
    providerId: null,
    available: true,
    needsSignIn: true,
    lastErrorKind: null,
    planProvider: null,
    checkAvailable: true,
    signIn: agent === 'pi' ? 'terminal' : 'link',
    ...overrides,
  };
  const client = new QueryClient();
  client.setQueryData(capabilitiesQuery.queryKey, {
    computer,
    oauth: { github: false, google: false },
    deployment: 'self_hosted',
  });
  client.setQueryData(codersQuery.queryKey, { agents: [account] });
  return renderToString(
    <QueryClientProvider client={client}>
      <ProviderSubscription kind={kind} canEdit configured={configured} />
    </QueryClientProvider>,
  );
}

describe('provider subscription connections', () => {
  it('distinguishes a saved connection from verified access and makes billing priority explicit', () => {
    const html = connection('openai', {
      authKind: 'subscription',
      accountLabel: 'ChatGPT Plus',
      needsSignIn: false,
    });
    expect(html).toContain('>Connected<');
    expect(html).toContain('Test a model to verify access');
    expect(html).toContain('Preferred over an API key');
    expect(html).toContain('We do not switch to API billing');
    expect(html).toContain('>Disconnect<');
    expect(html).not.toContain('Subscription active');
    expect(html).not.toContain('Use API key');
  });
  it('shows a failed sign-in as needing reconnection', () => {
    const html = connection('anthropic', {
      authKind: 'subscription',
      needsSignIn: true,
      lastErrorKind: 'sign_in',
      lastError: '401 expired',
    });
    expect(html).toContain('Reconnect required');
    expect(html).not.toContain('>Connected<');
    expect(html).toContain('>Reconnect<');
    expect(html).toContain('extra usage');
  });
  it('does not mistake another pi provider for xAI access', () => {
    const html = connection('xai', {
      authKind: 'subscription',
      accountLabel: 'OpenAI (ChatGPT Plus/Pro)',
      needsSignIn: false,
    });
    expect(html).not.toContain('>Connected<');
    expect(html).toContain('choose xAI for SuperGrok or X Premium');
    expect(html).toContain('>Connect<');
  });
  it('uses the card provider for billing copy even when pi reports multiple plans', () => {
    const html = connection('xai', {
      authKind: 'subscription',
      accountLabel: 'Anthropic (Claude Pro/Max), OpenAI (ChatGPT Plus/Pro), xAI',
      planProvider: 'anthropic',
      needsSignIn: false,
    });
    expect(html).toContain('>Connected<');
    expect(html).toContain('Uses your xAI subscription');
    expect(html).not.toContain('Claude plan');
    expect(html).not.toContain('ChatGPT plan');
    expect(html).toContain('all pi providers');
  });
  it('does not present Claude bot usage as guaranteed coverage under the Claude Code plan', () => {
    const html = connection('anthropic', {
      authKind: 'subscription',
      needsSignIn: false,
      planProvider: 'anthropic',
    });
    expect(html).toContain('Uses your Claude account');
    expect(html).toContain('may require extra usage');
    expect(html).not.toContain('Usage is billed to your Claude plan');
  });
  it('offers a short Enable action when a connected plan needs its native bot provider', () => {
    const html = connection(
      'openai',
      { authKind: 'subscription', needsSignIn: false },
      true,
      false,
    );
    expect(html).toContain('Enable this connection for bot conversations');
    expect(html).toContain('>Enable<');
    expect(html).not.toContain('Use subscription for bots');
  });
  it('lets a stored subscription be disconnected when its computer is unavailable', () => {
    const html = connection(
      'openai',
      { authKind: 'subscription', needsSignIn: false },
      false,
      false,
    );
    expect(html).toContain('A computer is required');
    expect(html).toContain('>Disconnect<');
    expect(html).not.toContain('>Enable<');
  });
  it('explains why a computer is required rather than showing dead connection actions', () => {
    const html = connection('openai', {}, false);
    expect(html).toContain('Configure a computer to connect a subscription');
    expect(html).not.toContain('<button');
  });
});
