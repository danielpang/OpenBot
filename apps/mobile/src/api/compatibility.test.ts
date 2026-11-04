import { describe, expect, it } from 'vitest';
import { serverCompatibility } from './compatibility';
describe('older self-hosted server compatibility', () => {
  it('treats missing version metadata as unknown instead of blocking older servers', () => {
    expect(serverCompatibility(undefined)).toBe('unknown');
    expect(serverCompatibility('unreleased')).toBe('unknown');
  });
  it('compares numeric versions correctly', () => {
    expect(serverCompatibility('1.9.0', '1.10.0')).toBe('update');
    expect(serverCompatibility('2.0.0', '1.10.0')).toBe('supported');
    expect(serverCompatibility('0.0.0')).toBe('supported');
  });
});
