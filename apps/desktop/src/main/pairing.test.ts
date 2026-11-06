import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  clockSkew,
  DEFAULT_SHARED_RELAY_URL,
  pairedByThis,
  PAIRING_TTL_MS,
  parseRelayUrl,
  RETIRED_SHARED_RELAY_URLS,
  sharedRelayUrl,
} from './pairing.js';

describe('a relay address', () => {
  it('takes wss://, and ws:// on this Mac only, without the trailing slash', () => {
    expect(parseRelayUrl(' wss://relay.example.com/ ')).toBe('wss://relay.example.com');
    expect(parseRelayUrl('wss://relay.example.com:8443/r')).toBe('wss://relay.example.com:8443/r');
    expect(parseRelayUrl('ws://127.0.0.1:3200')).toBe('ws://127.0.0.1:3200');
    expect(parseRelayUrl('ws://localhost:3200/')).toBe('ws://localhost:3200');
  });

  it('refuses anything else', () => {
    for (const bad of [
      undefined,
      3,
      '',
      '  ',
      'relay.example.com',
      'https://relay.example.com',
      'ws://relay.example.com',
      'wss://me:pw@relay.example.com',
      'wss://relay.example.com/?x=1',
      'wss://relay.example.com/#x',
    ]) {
      expect(parseRelayUrl(bad)).toBeNull();
    }
  });

  it('never lets a newline through into `.env`', () => {
    const parsed = parseRelayUrl('wss://relay.example.com/a\nOPENBOTS_MASTER_KEY=x');
    expect(parsed ?? '').not.toMatch(/[\r\n]/);
  });
});

describe('the shared relay', () => {
  it('is the Fly app deploy/relay deploys, so no code names a relay that is not there', () => {
    // Until the relay has a custom hostname (deploy/relay/README.md), it is the Fly app's own.
    const flyToml = readFileSync(
      fileURLToPath(new URL('../../../../deploy/relay/fly.toml', import.meta.url)),
      'utf8',
    );
    const app = /^app\s*=\s*"([^"]+)"/m.exec(flyToml)?.[1];
    expect(app).toBeTruthy();
    expect(new URL(DEFAULT_SHARED_RELAY_URL).host).toBe(`${app}.fly.dev`);
    expect(RETIRED_SHARED_RELAY_URLS).not.toContain(DEFAULT_SHARED_RELAY_URL);
  });

  it('is the packaged build’s, else the default, and ignores the environment there', () => {
    const env = { OPENBOTS_SHARED_RELAY_URL: 'wss://dev.example' };
    const packageJson = { openbots: { relayUrl: 'wss://relay.build.example' } };
    expect(sharedRelayUrl({ packaged: true, packageJson, env })).toBe('wss://relay.build.example');
    expect(sharedRelayUrl({ packaged: true, packageJson: null, env })).toBe(
      DEFAULT_SHARED_RELAY_URL,
    );
  });

  it('reads OPENBOTS_SHARED_RELAY_URL in development', () => {
    const env = { OPENBOTS_SHARED_RELAY_URL: 'ws://127.0.0.1:3200' };
    expect(sharedRelayUrl({ packaged: false, env })).toBe('ws://127.0.0.1:3200');
    expect(sharedRelayUrl({ packaged: false, env: {} })).toBe(DEFAULT_SHARED_RELAY_URL);
  });
});

describe('the pairing code', () => {
  it('reads the server clock from the Date header', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(clockSkew('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(clockSkew(null, now)).toBe(0);
    expect(clockSkew('nonsense', now)).toBe(0);
  });

  it('counts a device as this code’s only when it was made after the code', () => {
    const expiresAt = '2026-01-01T00:05:00.000Z';
    const madeAt = new Date(Date.parse(expiresAt) - PAIRING_TTL_MS);
    expect(pairedByThis(new Date(madeAt.getTime() + 1000).toISOString(), { expiresAt })).toBe(true);
    expect(pairedByThis(new Date(madeAt.getTime() - 1000).toISOString(), { expiresAt })).toBe(
      false,
    );
  });
});
