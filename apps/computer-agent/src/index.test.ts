import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@openbots/computer-agent', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbots/computer-agent');
  });
});
