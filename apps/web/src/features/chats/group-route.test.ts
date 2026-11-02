import { describe, expect, it } from 'vitest';
import { Route as BotRoute } from '../../routes/_app/bots/$botId/index.js';
import { Route as GroupRoute } from '../../routes/_app/groups/$chatId.js';

// A group deep link (`openbots://chat/{id}/message/{seq}`, the Mac app) opens
// `/groups/{id}?seq=N`; the group route reads `?seq=` as the Bot route does.
// A message in a Bot to Bot chat (`openbots://bot/{id}/message/{seq}?chat=`)
// opens `/bots/{id}?chat={chat id}&seq=N`, that chat under the transcript.

const CHAT = '7f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5';
type Validate = (s: Record<string, unknown>) => unknown;

describe('the group route', () => {
  it('accepts ?seq= like the Bot route', () => {
    const validate = GroupRoute.options.validateSearch as Validate;
    const bot = BotRoute.options.validateSearch as Validate;
    expect(validate({ seq: '7' })).toEqual({ seq: 7 });
    expect(validate({ seq: 'x' })).toEqual({});
    for (const search of [{ seq: '7' }, { seq: '3', thread: CHAT }, {}]) {
      expect(bot(search)).toEqual(validate(search));
    }
  });
});

describe('the Bot route', () => {
  it('accepts ?chat= for a message in one of its Bot to Bot chats', () => {
    const validate = BotRoute.options.validateSearch as Validate;
    expect(validate({ chat: CHAT.toUpperCase(), seq: '4' })).toEqual({ chat: CHAT, seq: 4 });
    expect(validate({ chat: '../x', seq: '4' })).toEqual({ seq: 4 });
  });
});
