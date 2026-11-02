import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@openbots/mcp', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbots/mcp');
  });
});
