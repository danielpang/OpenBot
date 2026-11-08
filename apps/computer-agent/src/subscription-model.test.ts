import { describe, expect, it } from 'vitest';
import { readSubscriptionCredential, writeSubscriptionCredential } from './subscription-model.js';

describe('shared subscription credentials', () => {
  const credential = {
    type: 'oauth' as const,
    access: 'new-access',
    refresh: 'new-refresh',
    expires: 42,
  };
  it('reads Claude Code credentials and writes refreshes back without losing account fields', () => {
    const data = {
      organization: 'org',
      claudeAiOauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
    };
    expect(readSubscriptionCredential('claude', data, 'anthropic')).toEqual({
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 1,
    });
    expect(writeSubscriptionCredential('claude', data, 'anthropic', credential)).toEqual({
      organization: 'org',
      claudeAiOauth: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 42,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
    });
  });
  it('reads Codex token expiry and preserves id tokens and other login fields on refresh', () => {
    const access = `header.${Buffer.from(JSON.stringify({ exp: 123 })).toString('base64url')}.signature`;
    const data = {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: access,
        refresh_token: 'refresh',
        id_token: 'identity',
        account_id: 'account',
      },
    };
    expect(readSubscriptionCredential('codex', data, 'openai-codex')).toEqual({
      type: 'oauth',
      access,
      refresh: 'refresh',
      expires: 123000,
      accountId: 'account',
    });
    expect(
      writeSubscriptionCredential('codex', data, 'openai-codex', {
        ...credential,
        accountId: 'account',
      }),
    ).toMatchObject({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'identity',
        account_id: 'account',
      },
    });
  });
  it('uses only the selected pi OAuth connection and keeps other connections intact', () => {
    const data = { xai: credential, anthropic: { type: 'api_key', key: 'private' } };
    expect(readSubscriptionCredential('pi', data, 'xai')).toEqual(credential);
    expect(readSubscriptionCredential('pi', data, 'anthropic')).toBeUndefined();
    expect(
      writeSubscriptionCredential('pi', data, 'xai', { ...credential, access: 'rotated' }),
    ).toEqual({ ...data, xai: { ...credential, access: 'rotated' } });
  });
  it('does not treat vendor API keys or absent credentials as a subscription', () => {
    expect(readSubscriptionCredential('claude', {}, 'anthropic')).toBeUndefined();
    expect(
      readSubscriptionCredential('codex', { OPENAI_API_KEY: 'key' }, 'openai-codex'),
    ).toBeUndefined();
  });
});
