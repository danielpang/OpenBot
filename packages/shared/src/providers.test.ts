import { describe, expect, it } from 'vitest';
import {
  botModelNeeds,
  DEFAULT_CAPABILITIES,
  defaultReasoning,
  missingCapabilities,
  usesComputer,
} from './providers.js';

describe('model needs', () => {
  it('needs vision only for a Bot that uses its computer', () => {
    expect(botModelNeeds({}, true)).toEqual(['tools', 'vision']);
    expect(botModelNeeds(null, false)).toEqual(['tools']);
    // Denying the computer group takes the computer away; asking keeps it.
    expect(botModelNeeds({ groups: { computer: 'deny' } }, true)).toEqual(['tools']);
    expect(usesComputer({ groups: { computer: 'ask' } }, true)).toBe(true);
    expect(usesComputer({ tools: { computer: 'deny' } }, true)).toBe(true);
    expect(usesComputer({}, false)).toBe(false);
  });

  it('lists the needs a model lacks', () => {
    expect(missingCapabilities(DEFAULT_CAPABILITIES, ['tools', 'vision'])).toEqual(['vision']);
  });
});

describe('defaultReasoning', () => {
  const reasons = { reasoning: true };
  it('turns adaptive thinking on for Anthropic models that reason', () => {
    expect(defaultReasoning({ kind: 'anthropic', protocol: 'native' }, reasons)).toBe(true);
    expect(defaultReasoning({ kind: 'custom', protocol: 'anthropic_compatible' }, reasons)).toBe(
      true,
    );
    expect(defaultReasoning({ kind: 'anthropic' }, { reasoning: false })).toBeUndefined();
  });

  it('leaves other providers as they are', () => {
    expect(defaultReasoning({ kind: 'openai', protocol: 'native' }, reasons)).toBeUndefined();
    expect(
      defaultReasoning({ kind: 'custom', protocol: 'openai_compatible' }, reasons),
    ).toBeUndefined();
  });
});
