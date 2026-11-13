import { describe, expect, it } from 'vitest';
import { BotStateKindSchema } from '@openbots/shared';
import { BotStateKindSchema as stubbed } from '../../office/shared-stub';

describe('office bundle stubs', () => {
  it('lists the same Bot states as the real schema', () => {
    expect(stubbed.options).toEqual(BotStateKindSchema.options);
  });
});
