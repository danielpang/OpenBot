import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AVATAR_CSS } from '@openbots/avatars';
import { describe, expect, it } from 'vitest';

// The start page's Content-Security-Policy allows no inline style but the
// avatars' motion CSS, which <Avatar> puts in a style element: by its hash,
// so a change to AVATAR_CSS fails here until index.html has the new one.

describe('index.html', () => {
  it("allows the avatars' motion style by its hash", () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    const hash = createHash('sha256').update(AVATAR_CSS).digest('base64');
    expect(html).toContain(`style-src 'self' 'sha256-${hash}';`);
  });
});
