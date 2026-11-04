import { describe, expect, it } from 'vitest';
import { previewHTML } from './html';

describe('bundled preview document', () => {
  it('blocks remote network access and exposes only the scoped path and random session', () => {
    const html = previewHTML(
      '12345678-1234-1234-1234-123456789abc',
      '12345678-1234-1234-1234-123456789abc',
    );
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('/api/v1/bots/12345678-1234-1234-1234-123456789abc/screen/vnc');
    expect(html).not.toContain('?control=1');
    expect(html).not.toContain('Bearer');
    expect(() => previewHTML('12345678-1234-1234-1234-123456789abc', '</script>')).toThrow();
  });
});
