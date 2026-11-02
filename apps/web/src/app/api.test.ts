import { describe, expect, it } from 'vitest';
import { wsUrl } from './api.js';

describe('wsUrl', () => {
  it('maps the page origin to the /ws endpoint', () => {
    expect(wsUrl('http://localhost:5173')).toBe('ws://localhost:5173/ws');
    expect(wsUrl('https://openbots.example.com')).toBe('wss://openbots.example.com/ws');
  });
});
