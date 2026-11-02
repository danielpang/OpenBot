import { describe, expect, it } from 'vitest';
import {
  generateToken,
  hashToken,
  ipAllowed,
  presentedToken,
  safeEqual,
  tokenMatches,
  verifySignature,
} from './verify.js';

// The HMAC presets against known vectors: GitHub's and Slack's from their
// documentation, Stripe's and the generic one computed independently with
// `openssl dgst -sha256 -hmac`.

describe('signature presets', () => {
  it('verifies GitHub X-Hub-Signature-256 (GitHub docs vector)', () => {
    const body = Buffer.from('Hello, World!');
    const secret = "It's a Secret to Everybody";
    const good = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(
      verifySignature({ preset: 'github' }, secret, { 'x-hub-signature-256': good }, body),
    ).toEqual({ ok: true });
    expect(
      verifySignature(
        { preset: 'github' },
        secret,
        { 'x-hub-signature-256': good.replace(/7$/, '8') },
        body,
      ).ok,
    ).toBe(false);
    expect(verifySignature({ preset: 'github' }, secret, {}, body)).toEqual({
      ok: false,
      reason: 'Missing X-Hub-Signature-256',
    });
    expect(
      verifySignature({ preset: 'github' }, 'other', { 'x-hub-signature-256': good }, body).ok,
    ).toBe(false);
  });

  it('verifies Slack v0 signatures with a fresh timestamp (Slack docs vector)', () => {
    const body = Buffer.from(
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c',
    );
    const headers = {
      'x-slack-request-timestamp': '1531420618',
      'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
    };
    const secret = '8f742231b10e8888abcd99yyyzzz85a5';
    expect(verifySignature({ preset: 'slack' }, secret, headers, body, 1531420618 + 60)).toEqual({
      ok: true,
    });
    // Ten minutes later the same request is a replay.
    expect(verifySignature({ preset: 'slack' }, secret, headers, body, 1531420618 + 600)).toEqual({
      ok: false,
      reason: 'X-Slack-Request-Timestamp is too old',
    });
    expect(
      verifySignature(
        { preset: 'slack' },
        secret,
        headers,
        Buffer.concat([body, Buffer.from('x')]),
        1531420618,
      ).ok,
    ).toBe(false);
  });

  it('verifies Stripe-Signature with any of several v1 values', () => {
    const body = Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded"}');
    const v1 = '22d8dc182f5c588077683bd378368e29765bfe5df2560112b4f28fef120f0e31';
    const check = (header: string, now = 1700000030) =>
      verifySignature(
        { preset: 'stripe' },
        'whsec_test_secret',
        { 'stripe-signature': header },
        body,
        now,
      );
    expect(check(`t=1700000000,v1=${v1}`)).toEqual({ ok: true });
    // During a secret roll Stripe sends one v1 per secret.
    expect(check(`t=1700000000,v1=${'0'.repeat(64)},v1=${v1}`)).toEqual({ ok: true });
    expect(check(`t=1700000001,v1=${v1}`).ok).toBe(false);
    expect(check(`t=1700000000,v1=${v1}`, 1700000000 + 3600)).toEqual({
      ok: false,
      reason: 'Stripe-Signature timestamp is too old',
    });
    expect(check(`v1=${v1}`).ok).toBe(false);
  });

  it('verifies a generic HMAC in hex or base64, with or without sha256=, in the named header', () => {
    const body = Buffer.from('{"hello":"world"}');
    const hex = '9858e8fea916b4f991c984891b199af820f78dd387b5c596a48934a46b5d279a';
    const b64 = 'mFjo/qkWtPmRyYSJGxma+CD3jdOHtcWWpIk0pGtdJ5o=';
    const generic = { preset: 'generic' as const };
    expect(verifySignature(generic, 'generic-secret', { 'x-signature': hex }, body).ok).toBe(true);
    expect(
      verifySignature(generic, 'generic-secret', { 'x-signature': `sha256=${hex}` }, body).ok,
    ).toBe(true);
    expect(verifySignature(generic, 'generic-secret', { 'x-signature': b64 }, body).ok).toBe(true);
    expect(
      verifySignature(
        { preset: 'generic', header: 'X-Acme-Sig' },
        'generic-secret',
        { 'x-acme-sig': hex.toUpperCase() },
        body,
      ).ok,
    ).toBe(true);
    expect(verifySignature(generic, 'wrong', { 'x-signature': hex }, body).ok).toBe(false);
    expect(verifySignature(generic, 'generic-secret', {}, body)).toEqual({
      ok: false,
      reason: 'Missing X-Signature',
    });
  });
});

describe('tokens and addresses', () => {
  it('issues prefixed tokens and checks them against the stored hash', () => {
    const token = generateToken();
    expect(token).toMatch(/^whk_[A-Za-z0-9_-]{43}$/);
    expect(tokenMatches(token, hashToken(token))).toBe(true);
    expect(tokenMatches(`${token}x`, hashToken(token))).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('reads the token from bearer, X-OpenBots-Token, or the path, in that order', () => {
    expect(presentedToken({ authorization: 'Bearer a' }, 'c')).toBe('a');
    expect(presentedToken({ 'x-openbots-token': 'b' }, 'c')).toBe('b');
    expect(presentedToken({}, 'c')).toBe('c');
    expect(presentedToken({ authorization: 'Basic xyz' }, undefined)).toBeUndefined();
  });

  it('checks CIDR allowlists for IPv4, IPv6 and mapped addresses', () => {
    const ranges = ['192.30.252.0/22', '2a0a:a440::/29', '10.1.2.3'];
    expect(ipAllowed('192.30.253.7', ranges)).toBe(true);
    expect(ipAllowed('::ffff:192.30.252.1', ranges)).toBe(true);
    expect(ipAllowed('2a0a:a440::1', ranges)).toBe(true);
    expect(ipAllowed('10.1.2.3', ranges)).toBe(true);
    expect(ipAllowed('10.1.2.4', ranges)).toBe(false);
    expect(ipAllowed(null, ranges)).toBe(false);
    expect(ipAllowed('8.8.8.8', [])).toBe(true);
    expect(ipAllowed(null, null)).toBe(true);
  });
});
