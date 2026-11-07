import { describe, expect, it, vi } from 'vitest';
import { updatePolicy } from './update-policy.js';

describe('Mac update policy', () => {
  it('never contacts signing tools for development and non-Mac builds', async () => {
    for (const override of [{ packaged: false }, { platform: 'linux' }, { version: '0.0.0' }]) {
      const verifySignature = vi.fn();
      expect(
        await updatePolicy({
          packaged: true,
          platform: 'darwin',
          version: '1.0.0',
          ...override,
          verifySignature,
        }),
      ).toHaveProperty('disabledReason');
      expect(verifySignature).not.toHaveBeenCalled();
    }
  });
  it('allows automatic installation only after Developer ID verification', async () => {
    const verifySignature = vi.fn(async () => undefined);
    expect(
      await updatePolicy({ packaged: true, platform: 'darwin', version: '1.0.0', verifySignature }),
    ).toEqual({});
    expect(verifySignature).toHaveBeenCalledOnce();
  });
  it('falls back to a manual installer for unsigned or invalidly signed releases', async () => {
    expect(
      await updatePolicy({
        packaged: true,
        platform: 'darwin',
        version: '1.0.0',
        verifySignature: async () => {
          throw new Error('unsigned');
        },
      }),
    ).toEqual({ manual: true });
  });
});
