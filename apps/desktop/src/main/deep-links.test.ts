import { describe, expect, it } from 'vitest';
import { deepLinkFromArgv, deepLinkPath, formatDeepLink, parseDeepLink } from './deep-links.js';

const BOT = '0b3f8a52-1c1e-4b9a-9d55-3f2a8c6e7d10';
const CHAT = '7f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5';

describe('deep links', () => {
  it('parses a Bot message link', () => {
    expect(parseDeepLink(`openbots://bot/${BOT}/message/42`)).toEqual({
      kind: 'bot',
      botId: BOT,
      seq: 42,
    });
  });

  it('parses a Bot link without a message and a group chat link', () => {
    expect(parseDeepLink(`openbots://bot/${BOT}`)).toEqual({ kind: 'bot', botId: BOT });
    expect(parseDeepLink(`openbots://bot/${BOT}/`)).toEqual({ kind: 'bot', botId: BOT });
    expect(parseDeepLink(`openbots://chat/${CHAT}/message/3`)).toEqual({
      kind: 'chat',
      chatId: CHAT,
      seq: 3,
    });
  });

  it('opens the Connectors page, where an OAuth sign-in in the browser links back', () => {
    const link = parseDeepLink('openbots://connectors');
    expect(link).toEqual({ kind: 'connectors' });
    expect(deepLinkPath(link!)).toBe('/connectors');
    expect(formatDeepLink(link!)).toBe('openbots://connectors');
    expect(parseDeepLink('openbots://connectors/x')).toBeNull();
    expect(parseDeepLink('openbots://connectors?next=https://evil.example.com')).toBeNull();
  });

  it('lowercases the id', () => {
    expect(parseDeepLink(`openbots://bot/${BOT.toUpperCase()}/message/1`)).toEqual({
      kind: 'bot',
      botId: BOT,
      seq: 1,
    });
  });

  it.each([
    ['another scheme', `https://bot/${BOT}/message/1`],
    ['an unknown kind', `openbots://settings/${BOT}`],
    ['an id that is not a uuid', 'openbots://bot/../../etc/message/1'],
    ['a missing id', 'openbots://bot/'],
    ['a seq that is not a number', `openbots://bot/${BOT}/message/abc`],
    ['seq 0', `openbots://bot/${BOT}/message/0`],
    ['a negative seq', `openbots://bot/${BOT}/message/-1`],
    ['a missing seq', `openbots://bot/${BOT}/message`],
    ['another segment', `openbots://bot/${BOT}/thread/1`],
    ['extra segments', `openbots://bot/${BOT}/message/1/more`],
    ['not a URL', 'openbots:'],
    ['a chat that is not a uuid', `openbots://bot/${BOT}/message/1?chat=../x`],
    ['a chat on a group link', `openbots://chat/${CHAT}/message/1?chat=${BOT}`],
  ])('rejects %s', (_case, raw) => {
    expect(parseDeepLink(raw)).toBeNull();
  });

  it('parses a thread reply link', () => {
    expect(parseDeepLink(`openbots://bot/${BOT}/message/12?thread=${CHAT.toUpperCase()}`)).toEqual({
      kind: 'bot',
      botId: BOT,
      seq: 12,
      thread: CHAT,
    });
    expect(parseDeepLink(`openbots://chat/${CHAT}/message/4?thread=${BOT}`)).toEqual({
      kind: 'chat',
      chatId: CHAT,
      seq: 4,
      thread: BOT,
    });
    expect(parseDeepLink(`openbots://bot/${BOT}/message/12?thread=../x`)).toBeNull();
    expect(parseDeepLink(`openbots://bot/${BOT}/message/12?thread=`)).toBeNull();
  });

  it('formats links that parse back to themselves', () => {
    for (const link of [
      { kind: 'bot', botId: BOT, seq: 9 },
      { kind: 'bot', botId: BOT },
      { kind: 'chat', chatId: CHAT, seq: 2 },
      { kind: 'bot', botId: BOT, seq: 9, thread: CHAT },
      { kind: 'chat', chatId: CHAT, seq: 2, thread: BOT },
      { kind: 'bot', botId: BOT, chat: CHAT, seq: 4 },
    ] as const) {
      expect(parseDeepLink(formatDeepLink(link))).toEqual(link);
    }
    expect(formatDeepLink({ kind: 'bot', botId: BOT, seq: 9 })).toBe(
      `openbots://bot/${BOT}/message/9`,
    );
  });

  it('parses a link to a message in one of the Bot’s chats with another Bot', () => {
    expect(parseDeepLink(`openbots://bot/${BOT}/message/4?chat=${CHAT.toUpperCase()}`)).toEqual({
      kind: 'bot',
      botId: BOT,
      chat: CHAT,
      seq: 4,
    });
    expect(deepLinkPath({ kind: 'bot', botId: BOT, chat: CHAT, seq: 4 })).toBe(
      `/bots/${BOT}?chat=${CHAT}&seq=4`,
    );
  });

  it('opens the transcript or the group at the message', () => {
    expect(deepLinkPath({ kind: 'bot', botId: BOT, seq: 9 })).toBe(`/bots/${BOT}?seq=9`);
    expect(deepLinkPath({ kind: 'bot', botId: BOT })).toBe(`/bots/${BOT}`);
    expect(deepLinkPath({ kind: 'chat', chatId: CHAT, seq: 2 })).toBe(`/groups/${CHAT}?seq=2`);
    expect(deepLinkPath({ kind: 'chat', chatId: CHAT })).toBe(`/groups/${CHAT}`);
    expect(deepLinkPath({ kind: 'chat', chatId: CHAT, seq: 2, thread: BOT })).toBe(
      `/groups/${CHAT}?seq=2&thread=${BOT}`,
    );
  });

  it('finds the link among process arguments', () => {
    expect(deepLinkFromArgv(['/Applications/OpenBots', '--flag', `openbots://bot/${BOT}`])).toBe(
      `openbots://bot/${BOT}`,
    );
    expect(deepLinkFromArgv(['/Applications/OpenBots'])).toBeUndefined();
  });
});
