import { describe, expect, it } from 'vitest';
import { fakeBridge } from './fake-bridge.js';
import { createQuickAskFlow, LAST_BOT } from './quick-ask-flow.js';

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe('quick ask', () => {
  it('picks the Bot asked last, and sends the text to it', async () => {
    const bridge = fakeBridge();
    bridge.quickAsk.bots.mockResolvedValueOnce([
      { id: 'a', name: 'Ada' },
      { id: 'b', name: 'Grace' },
    ]);
    const storage = memory({ [LAST_BOT]: 'b' });
    const flow = createQuickAskFlow(bridge, storage);
    await flow.start();
    expect(flow.store.get().botId).toBe('b');
    flow.setText('Hello');
    await flow.send();
    expect(bridge.quickAsk.send).toHaveBeenCalledWith('b', 'Hello');
    expect(flow.store.get()).toMatchObject({ text: '', sending: false, error: null });
    expect(storage.values.get(LAST_BOT)).toBe('b');
  });

  it('sends nothing blank, and says when there is no Bot yet', async () => {
    const bridge = fakeBridge();
    bridge.quickAsk.bots.mockResolvedValueOnce([]);
    const flow = createQuickAskFlow(bridge, memory());
    await flow.start();
    expect(flow.store.get().error).toBe('Make a Bot in OpenBots first.');
    flow.setText('   ');
    await flow.send();
    expect(bridge.quickAsk.send).not.toHaveBeenCalled();
  });

  it('keeps the text when a send fails', async () => {
    const bridge = fakeBridge();
    bridge.quickAsk.send.mockRejectedValueOnce(new Error('Sign in to OpenBots first.'));
    const flow = createQuickAskFlow(bridge, memory());
    await flow.start();
    flow.setText('Hello');
    await flow.send();
    expect(flow.store.get()).toMatchObject({ text: 'Hello', error: 'Sign in to OpenBots first.' });
  });
});
