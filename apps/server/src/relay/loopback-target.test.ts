import { describe, expect, it } from 'vitest';
import { loopbackTarget } from './adapter.js';

describe('loopbackTarget', () => {
  const origin = 'ws://127.0.0.1:3000';

  it('joins a path and query to the loopback origin', () => {
    expect(loopbackTarget(origin, '/ws')).toBe('ws://127.0.0.1:3000/ws');
    expect(loopbackTarget(origin, '/bots/1/screen/vnc?control=1')).toBe(
      'ws://127.0.0.1:3000/bots/1/screen/vnc?control=1',
    );
  });

  it('refuses a path that would leave the server', () => {
    for (const bad of ['//evil.example/ws', 'ws://evil.example/ws', 'ws', '']) {
      expect(loopbackTarget(origin, bad), bad).toBeNull();
    }
  });
});
