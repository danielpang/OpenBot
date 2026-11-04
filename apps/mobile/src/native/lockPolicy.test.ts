import { describe, expect, it } from 'vitest';
import { AppLockPolicy, AUTO_LOCK_AFTER_MS } from './lockPolicy';

describe('owner app lock', () => {
  it('requires authentication on launch and after five minutes away', () => {
    let time = 0;
    const policy = new AppLockPolicy(() => time);
    expect(policy.locked).toBe(true);
    policy.unlock();
    policy.background();
    time = AUTO_LOCK_AFTER_MS - 1;
    expect(policy.foreground()).toBe(false);
    policy.background();
    time += AUTO_LOCK_AFTER_MS;
    expect(policy.foreground()).toBe(true);
  });
  it('does not reset the away timer on an inactive-to-background transition', () => {
    let time = 0;
    const policy = new AppLockPolicy(() => time);
    policy.unlock();
    policy.background();
    time += 1000;
    policy.background();
    time = AUTO_LOCK_AFTER_MS;
    expect(policy.foreground()).toBe(true);
  });
});
