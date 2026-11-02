import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, packageName } from './index.js';

describe('@openbots/shared', () => {
  it('names the product', () => {
    expect(PRODUCT_NAME).toBe('OpenBots');
  });

  it('scopes package names', () => {
    expect(packageName('agent')).toBe('@openbots/agent');
  });
});
