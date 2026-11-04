import { describe, expect, it } from 'vitest';
import { base64urlEncode } from '@openbots/tunnel';
import { parseConnectionQr } from './connection-qr';

const key = base64urlEncode(new Uint8Array(32).fill(1));
const link = `openbots://pair#v=1&host=aaaaaaaaaaaaaaaaaaaaaaaaaa&key=${key}&code=${key}&direct=https%3A%2F%2Fbots.example.com`;

describe('connection QR codes', () => {
  it('normalizes an HTTPS server URL for the manual sign-in form', () => {
    expect(parseConnectionQr(' https://bots.example.com:443/ ')).toEqual({
      kind: 'server',
      address: 'https://bots.example.com',
    });
  });

  it('preserves validated custom and universal pairing links', () => {
    for (const value of [link, link.replace('openbots://pair', 'https://openbots.dev/pair')]) {
      expect(parseConnectionQr(value)).toEqual({ kind: 'pairing', link: value });
    }
  });

  it.each([
    'not a URL',
    'javascript:alert(1)',
    'http://bots.example.com',
    'http://192.168.1.2:3000',
    'https://user:secret@bots.example.com',
    'https://bots.example.com/chat',
    'https://bots.example.com?key=secret',
    'https://bots.example.com#secret',
    'https://openbots.dev/pair',
    'openbots://pair#v=2',
  ])('rejects unsafe or malformed connection codes: %s', (value) => {
    expect(() => parseConnectionQr(value)).toThrow();
  });
});
