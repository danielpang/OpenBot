import { describe, expect, it } from 'vitest';
import { COMPUTER_TOOL_NAMES, isComputerTool, SCREEN_TOOL_NAMES } from './computer.js';
import { WsEventSchema, wsEvent } from './events.js';

describe('computer', () => {
  it('lights the title-bar icon for computer tools only (I5)', () => {
    for (const name of COMPUTER_TOOL_NAMES) expect(isComputerTool(name)).toBe(true);
    expect(isComputerTool('publish_artifact')).toBe(true);
    expect(isComputerTool('web_fetch')).toBe(false);
    expect(isComputerTool(null)).toBe(false);
  });

  it('knows which tools use the screen', () => {
    expect(SCREEN_TOOL_NAMES).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_screenshot',
      'computer',
    ]);
  });

  it('scopes computer.status to the owner and screen.control to the Bot', () => {
    const status = wsEvent(
      'computer.status',
      { computerId: 'c1', status: 'running' },
      { user_id: 'u1' },
    );
    expect(WsEventSchema.parse(status)).toMatchObject({ user_id: 'u1' });
    const control = wsEvent(
      'screen.control',
      { screenId: 's1', controller: 'user', userId: 'u1', botId: 'b1', display: 10 },
      { bot_id: 'b1' },
    );
    expect(WsEventSchema.parse(control)).toMatchObject({ bot_id: 'b1' });
  });
});
