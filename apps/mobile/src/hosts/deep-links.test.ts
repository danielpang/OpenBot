import { describe, expect, it } from 'vitest';
import { nativeIntent } from './deep-links';
const fragment = `v=1&host=${'a'.repeat(26)}&key=${'A'.repeat(43)}&code=${'A'.repeat(43)}&relay=wss%3A%2F%2Frelay.example`;
describe('OS link routing', () => {
  it('preserves the fragment exactly inside the local pairing route', () => {
    for (const prefix of ['openbots://pair#', 'https://openbots.dev/pair#']) {
      const link = prefix + fragment;
      expect(new URL(nativeIntent(link), 'https://local').searchParams.get('link')).toBe(link);
    }
  });
  it('refuses malformed and third-party pairing links without echoing secrets', () => {
    expect(nativeIntent('https://evil.example/pair#' + fragment)).toBe('/');
    expect(nativeIntent('openbots://pair#v=99&code=secret')).toBe('/');
  });
});
