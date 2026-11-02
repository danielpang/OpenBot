import { describe, expect, it } from 'vitest';
import {
  botPair,
  isForBot,
  routeTargets,
  type AuthorType,
  type ChatType,
  type RouteContext,
  type RouteMessage,
} from './route.js';

// The route table (plan 7) for every chat type and author combination.

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const OWNER = 'dddddddd-0000-4000-8000-000000000004';
/** A Bot that is not in any of the chats. */
const OUTSIDER = 'eeeeeeee-0000-4000-8000-000000000005';

const chats: Record<ChatType, string[]> = { bot_dm: [A], bot_to_bot: [A, B], group: [A, B, C] };

function message(authorType: AuthorType, extra: Partial<RouteMessage> = {}): RouteMessage {
  const authorId = authorType === 'user' ? OWNER : authorType === 'bot' ? A : null;
  return { authorType, authorId, mentions: [], mentionEveryone: false, ...extra };
}

/** `shouldReply` says yes for B only, and records whom it was asked about. */
function decider(yes: string[] = [B]) {
  const asked: string[] = [];
  return {
    asked,
    fn: async (botId: string) => {
      asked.push(botId);
      return yes.includes(botId);
    },
  };
}

const route = async (type: ChatType, m: RouteMessage, yes?: string[], context?: RouteContext) => {
  const d = decider(yes);
  const targets = await routeTargets({ type, botIds: chats[type] }, m, d.fn, context);
  return { targets: targets.map((t) => `${t.botId.slice(0, 1)}:${t.trigger}`), asked: d.asked };
};

describe('routeTargets', () => {
  it.each([
    // chat, author, mentions, everyone, targets
    ['bot_dm', 'user', [], false, ['a:message']],
    ['bot_dm', 'bot', [], false, []],
    ['bot_dm', 'system', [], false, ['a:message']],
    ['bot_dm', 'webhook', [], false, ['a:message']],
    ['bot_dm', 'routine', [], false, ['a:message']],
    ['bot_to_bot', 'bot', [], false, ['b:bot_dm']],
    ['bot_to_bot', 'bot', [C], true, ['b:bot_dm']],
    ['bot_to_bot', 'user', [], false, []],
    ['bot_to_bot', 'system', [], false, []],
    ['bot_to_bot', 'webhook', [], false, []],
    ['bot_to_bot', 'routine', [], false, []],
    ['group', 'user', [], false, ['b:bot_message']],
    ['group', 'user', [C], false, ['c:mention']],
    ['group', 'user', [A, C], false, ['a:mention', 'c:mention']],
    ['group', 'user', [OUTSIDER], false, []],
    ['group', 'user', [], true, ['a:mention', 'b:mention', 'c:mention']],
    ['group', 'bot', [], false, []],
    ['group', 'bot', [C], false, ['c:mention']],
    ['group', 'bot', [A, B], false, ['b:mention']],
    ['group', 'bot', [], true, ['b:mention', 'c:mention']],
    ['group', 'system', [], true, []],
    ['group', 'webhook', [B], false, []],
    ['group', 'routine', [], false, []],
  ] as const)(
    '%s, %s author, mentions %j, everyone %s -> %j',
    async (type, author, mentions, everyone, expected) => {
      const { targets } = await route(
        type,
        message(author, { mentions: [...mentions], mentionEveryone: everyone }),
      );
      expect(targets).toEqual(expected);
    },
  );

  it('asks shouldReply only about owner messages that address nobody in particular', async () => {
    expect((await route('group', message('user'))).asked).toEqual([A, B, C]);
    expect((await route('group', message('user', { mentions: [B] }))).asked).toEqual([]);
    expect((await route('group', message('user', { mentions: [OUTSIDER] }))).asked).toEqual([]);
    expect((await route('group', message('user', { mentionEveryone: true }))).asked).toEqual([]);
    expect((await route('group', message('bot'))).asked).toEqual([]);
    expect((await route('bot_dm', message('user'))).asked).toEqual([]);
    expect((await route('bot_to_bot', message('bot'))).asked).toEqual([]);
  });

  it('directs a mention only to the mentioned Bots, even when others would answer (C5)', async () => {
    const { targets, asked } = await route('group', message('user', { mentions: [A] }), [B, C]);
    expect(targets).toEqual(['a:mention']);
    expect(asked).toEqual([]);
  });

  it('wakes nobody when no Bot wants to answer', async () => {
    expect((await route('group', message('user'), [])).targets).toEqual([]);
  });

  it('ignores a Bot-to-Bot message from a Bot outside the pair', async () => {
    const m = message('bot', { authorId: C });
    expect((await route('bot_to_bot', m)).targets).toEqual([]);
  });

  it("gives an owner's thread reply that mentions nobody to the thread's Bot alone (C7)", async () => {
    const reply = await route('group', message('user'), [B, C], { threadBotId: A });
    expect(reply).toEqual({ targets: ['a:mention'], asked: [] });
    // A mention still wins (C5).
    const named = await route('group', message('user', { mentions: [C] }), [], {
      threadBotId: A,
    });
    expect(named.targets).toEqual(['c:mention']);
    // A Bot's reply in the thread wakes nobody it does not mention.
    expect((await route('group', message('bot'), [], { threadBotId: B })).targets).toEqual([]);
    // A thread about a Bot that left the chat is open to every Bot.
    const left = await route('group', message('user'), [B], { threadBotId: OUTSIDER });
    expect(left).toEqual({ targets: ['b:bot_message'], asked: [A, B, C] });
  });

  it('gives an owner message that addresses nobody to a Bot at work without asking it', async () => {
    const { targets, asked } = await route('group', message('user'), [C], { atWork: [A] });
    expect(targets).toEqual(['a:bot_message', 'c:bot_message']);
    expect(asked).toEqual([B, C]);
    // A mention still goes only to the mentioned Bot.
    const named = await route('group', message('user', { mentions: [B] }), [], { atWork: [A] });
    expect(named.targets).toEqual(['b:mention']);
  });

  it('agrees with routing about which owner messages are for a Bot at work (plan 5.2)', () => {
    expect(isForBot(A, { mentions: [], mentionEveryone: false })).toBe(true);
    expect(isForBot(A, { mentions: [A], mentionEveryone: false })).toBe(true);
    expect(isForBot(A, { mentions: [B], mentionEveryone: false })).toBe(false);
    expect(isForBot(A, { mentions: [OUTSIDER], mentionEveryone: false })).toBe(false);
    expect(isForBot(A, { mentions: [B], mentionEveryone: true })).toBe(true);
    expect(isForBot(A, { mentions: [], mentionEveryone: false }, A)).toBe(true);
    expect(isForBot(A, { mentions: [], mentionEveryone: false }, B)).toBe(false);
    expect(isForBot(A, { mentions: [A], mentionEveryone: false }, B)).toBe(true);
  });

  it('orders a pair low id first', () => {
    expect(botPair(B, A)).toEqual([A, B]);
    expect(botPair(A, B)).toEqual([A, B]);
  });
});
