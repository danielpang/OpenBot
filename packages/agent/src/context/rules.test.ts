import { describe, expect, it } from 'vitest';
import { OPERATING_RULES } from './rules.js';

describe('operating rules', () => {
  it('tells a Bot in a group that an @mention wakes the Bot it names', () => {
    expect(OPERATING_RULES).toContain('Writing @handle wakes that Bot and asks it to act');
    expect(OPERATING_RULES).toContain('write its name without the @');
    // Routing ignores a Bot's @everyone (packages/router), and the rules say so.
    expect(OPERATING_RULES).toContain('your @everyone wakes nobody');
  });
});
