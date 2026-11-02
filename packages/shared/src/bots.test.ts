import { describe, expect, it } from 'vitest';
import {
  AvatarSchema,
  BotHandleSchema,
  HANDLE_MAX_LENGTH,
  ModelConfigSchema,
  handleFromName,
  withHandleSuffix,
} from './bots.js';

describe('Bot handles', () => {
  it('makes a handle from a name', () => {
    expect(handleFromName('Ada Lovelace!')).toBe('ada-lovelace');
    expect(handleFromName('  Café  Bot ')).toBe('cafe-bot');
    expect(handleFromName('机器人')).toBe('bot');
    expect(handleFromName('x'.repeat(50))).toHaveLength(HANDLE_MAX_LENGTH);
  });

  it('appends a suffix within the length limit', () => {
    expect(withHandleSuffix('ada', 'copy')).toBe('ada-copy');
    const long = withHandleSuffix('a'.repeat(HANDLE_MAX_LENGTH), 'copy-2');
    expect(long).toHaveLength(HANDLE_MAX_LENGTH);
    expect(long.endsWith('-copy-2')).toBe(true);
  });

  it('validates handles and strips the @', () => {
    expect(BotHandleSchema.parse('@Ada_1')).toBe('ada_1');
    for (const bad of ['', '-ada', 'ada-', 'a b', 'a'.repeat(HANDLE_MAX_LENGTH + 1)]) {
      expect(BotHandleSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('Bot jsonb values', () => {
  it('accepts generated and uploaded avatars', () => {
    expect(AvatarSchema.parse({ kind: 'generated', seed: 's', eyes: 'round' })).toBeTruthy();
    expect(
      AvatarSchema.safeParse({ kind: 'upload', file_id: '00000000-0000-4000-8000-000000000000' })
        .success,
    ).toBe(true);
    expect(AvatarSchema.safeParse({ kind: 'upload' }).success).toBe(false);
  });

  it('requires a provider and model', () => {
    expect(ModelConfigSchema.safeParse({ model_id: 'x' }).success).toBe(false);
    expect(
      ModelConfigSchema.safeParse({
        provider_id: '00000000-0000-4000-8000-000000000000',
        model_id: 'gpt-x',
        max_steps: 40,
      }).success,
    ).toBe(true);
  });
});
