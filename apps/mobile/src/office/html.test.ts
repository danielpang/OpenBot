import { describe, expect, it } from 'vitest';
import { officeHTML, scriptJSON } from './html';

describe('office page', () => {
  it('keeps Bot names from closing the inline script', () => {
    const bot = { id: 'b', name: '</script><script>alert(1)</script>\\u2028' };
    const html = officeHTML([bot as never], false);
    expect(html).not.toContain('</script><script>alert');
    expect(scriptJSON(' ')).toBe('"\\u2028"');
  });

  it('loads nothing from outside the page', () => {
    expect(officeHTML([], true)).toContain("default-src 'none'");
  });
});
