import { CODER_CONTROL_CHANNEL, type CoderControl } from '@openbots/shared';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { createInfra } from '../infra/index.js';
import { publishCoderControl, subscribeCoderControl } from './coder-control.js';

// The coding sessions' control channel: checked against the schema on the
// way out and on the way in.

describe('coder control', () => {
  const infra = createInfra({});
  const deps = { infra, logger: createLogger('silent') };
  const SESSION = '0b4f6c1e-6c0e-4d8a-9a35-9a1d2b3c4d5e';

  it('delivers valid messages and drops malformed ones', async () => {
    const got: CoderControl[] = [];
    const off = await subscribeCoderControl(deps, (msg) => got.push(msg));
    await publishCoderControl(deps, { type: 'stop', sessionId: SESSION });
    await publishCoderControl(deps, {
      type: 'approval',
      sessionId: SESSION,
      approvalId: SESSION,
      decision: 'approved',
    });
    // Someone else's publish on the channel, not through publishCoderControl.
    await infra.bus.publish(CODER_CONTROL_CHANNEL, { type: 'stop', sessionId: 'not-a-uuid' });
    await infra.bus.publish(CODER_CONTROL_CHANNEL, { type: 'launch_missiles' });
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got[0]).toEqual({ type: 'stop', sessionId: SESSION });
    expect(got[1]).toMatchObject({ type: 'approval', decision: 'approved' });
    await off();
  });

  it('refuses to publish a malformed message', async () => {
    await expect(
      publishCoderControl(deps, { type: 'stdin', sessionId: SESSION } as unknown as CoderControl),
    ).rejects.toThrow();
  });
});
