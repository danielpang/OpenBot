// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bot } from '../bots/queries.js';
import type { Message } from '../transcript/api.js';
import { topLevel } from '../transcript/chat-timeline.js';
import { MessageView } from '../transcript/message-view.js';
import { reactionChips, withoutReaction, withReaction } from '../transcript/reactions.js';
import { botChatsOf, groupLimit, groupTitle, type Chat } from './api.js';
import { BotPicker, pickState } from './bot-picker.js';
import { GroupMembers } from './group-members.js';

// Group chats in the web app (C4 to C8): the New chat picker's two-to-six
// rule, group names, a Bot's Bot-to-Bot chats, author prefixes, thread reply
// counts and reaction chips.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = (n: number): Bot =>
  ({
    id: `b${n}`,
    handle: `bot${n}`,
    name: `Bot ${n}`,
    label: null,
    avatar: { kind: 'generated', seed: `b${n}` },
    state: { botId: `b${n}`, state: 'idle', currentAction: null, runId: null, updatedAt: '' },
  }) as Bot;
const BOTS = [1, 2, 3, 4, 5, 6, 7].map(bot);

const chat = (over: Partial<Chat>): Chat => ({
  id: 'c1',
  type: 'group',
  title: null,
  botId: null,
  peerBotId: null,
  botIds: [],
  lastSeq: 0,
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('the New chat Bot picker', () => {
  let root: Root;
  let host: HTMLElement;
  let picked: string[] = [];
  function Harness({ limit }: { limit: number }) {
    const [selected, setSelected] = useState<string[]>([]);
    picked = selected;
    return <BotPicker bots={BOTS} selected={selected} limit={limit} onChange={setSelected} />;
  }
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const hint = () => host.querySelector('[role="status"]')!.textContent;

  it('needs two Bots and stops at the group limit', () => {
    act(() => root.render(<Harness limit={6} />));
    expect(hint()).toBe('Pick 2 to 6 Bots.');
    act(() => boxes()[0]!.click());
    expect(hint()).toBe('Pick at least 1 more.');
    for (const box of boxes().slice(1, 6)) act(() => box.click());
    expect(picked).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    expect(hint()).toBe('6 picked, the most a group holds.');
    // The seventh cannot be ticked; unticking one makes room again.
    expect(boxes()[6]!.disabled).toBe(true);
    act(() => boxes()[6]!.click());
    expect(picked).toHaveLength(6);
    act(() => boxes()[0]!.click());
    expect(boxes()[6]!.disabled).toBe(false);
    expect(hint()).toBe('5 picked; up to 6.');
  });

  it('follows a limit the admin changed', () => {
    act(() => root.render(<Harness limit={3} />));
    for (const box of boxes().slice(0, 4)) act(() => box.click());
    expect(picked).toEqual(['b1', 'b2', 'b3']);
    expect(boxes()[3]!.disabled).toBe(true);
  });

  it('decides readiness from the count', () => {
    expect(pickState(0, 6)).toMatchObject({ ready: false, room: true });
    expect(pickState(1, 6)).toMatchObject({ ready: false, room: true });
    expect(pickState(2, 6)).toMatchObject({ ready: true, room: true });
    expect(pickState(6, 6)).toMatchObject({ ready: true, room: false });
    expect(pickState(7, 6)).toMatchObject({ ready: false, room: false });
    expect(groupLimit(undefined)).toBe(6);
    expect(groupLimit({ botsPerGroup: 4 })).toBe(4);
  });
});

describe('the group members menu', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

  it('removes a Bot while two or more stay (C4)', () => {
    const removed: string[] = [];
    act(() =>
      root.render(
        <GroupMembers
          members={BOTS.slice(0, 3)}
          onRemove={(b) => removed.push(b.id)}
          defaultOpen
        />,
      ),
    );
    expect(items().map((i) => i.textContent)).toEqual([
      'Bot 1 @bot1Remove',
      'Bot 2 @bot2Remove',
      'Bot 3 @bot3Remove',
    ]);
    act(() => items()[1]!.click());
    expect(removed).toEqual(['b2']);
  });

  it('keeps the last two Bots', () => {
    act(() =>
      root.render(<GroupMembers members={BOTS.slice(0, 2)} onRemove={() => {}} defaultOpen />),
    );
    expect(items().every((i) => i.hasAttribute('data-disabled'))).toBe(true);
    expect(document.body.textContent).toContain('A group keeps at least 2 Bots.');
  });
});

describe('chat helpers', () => {
  it('names a group by its title, or by its Bots', () => {
    expect(groupTitle(chat({ title: 'Launch week' }), BOTS)).toBe('Launch week');
    expect(groupTitle(chat({ botIds: ['b1', 'b2'] }), BOTS)).toBe('Bot 1 and Bot 2');
    expect(groupTitle(chat({ botIds: ['b1', 'b2', 'b3'] }), BOTS)).toBe('Bot 1, Bot 2 and Bot 3');
    expect(groupTitle(chat({ botIds: ['gone'] }), BOTS)).toBe('Group');
  });

  it("finds a Bot's chats with other Bots, from either side of the pair", () => {
    const chats = [
      chat({ id: 'g' }),
      chat({ id: 'p1', type: 'bot_to_bot', botId: 'b1', peerBotId: 'b2' }),
      chat({ id: 'p2', type: 'bot_to_bot', botId: 'b0', peerBotId: 'b1' }),
      chat({ id: 'p3', type: 'bot_to_bot', botId: 'b2', peerBotId: 'b3' }),
    ];
    expect(botChatsOf(chats, 'b1').map((p) => [p.chat.id, p.peerId])).toEqual([
      ['p1', 'b2'],
      ['p2', 'b0'],
    ]);
  });
});

const message = (over: Partial<Message>): Message => ({
  id: 'm1',
  chatId: 'c1',
  seq: 1,
  threadRootId: null,
  authorType: 'bot',
  authorId: 'b1',
  parts: [{ type: 'text', text: '@bot2 please draft it' }],
  mentions: [],
  mentionEveryone: false,
  runId: 'run-1',
  status: 'complete',
  deltaSeq: 0,
  updatedSeq: 1,
  createdAt: '',
  ...over,
});

describe('group messages', () => {
  it("prefix every Bot's message with its name in a group, not in its own transcript", () => {
    const named = renderToStaticMarkup(
      <MessageView message={message({})} bot={BOTS[0]} ownerId="u1" named />,
    );
    expect(named).toContain('>Bot 1</div>');
    const own = renderToStaticMarkup(
      <MessageView message={message({})} bot={BOTS[0]} ownerId="u1" />,
    );
    expect(own).not.toContain('>Bot 1</div>');
  });

  it('offer a thread on a result, with the reply count once there are replies', () => {
    const open = () => {};
    const none = renderToStaticMarkup(
      <MessageView message={message({})} bot={BOTS[0]} ownerId="u1" onOpenThread={open} />,
    );
    expect(none).toContain('Reply in thread');
    expect(none).not.toContain('repl');
    const two = renderToStaticMarkup(
      <MessageView
        message={message({})}
        bot={BOTS[0]}
        ownerId="u1"
        onOpenThread={open}
        replies={2}
      />,
    );
    expect(two).toContain('2 replies');
  });

  it('list top-level messages and count thread replies apart', () => {
    const root = message({ id: 'r' });
    const { messages, replies } = topLevel([
      root,
      message({ id: 'x', threadRootId: 'r' }),
      message({ id: 'y' }),
      message({ id: 'z', threadRootId: 'r' }),
    ]);
    expect(messages.map((m) => m.id)).toEqual(['r', 'y']);
    expect(replies.get('r')).toBe(2);
  });

  it('count replies from the read replyCount plus the replies newer than it counted', () => {
    const root = message({ id: 'r', seq: 1, replyCount: 3, lastReplySeq: 5 });
    const reply = (seq: number) => message({ id: `x${seq}`, seq, threadRootId: 'r' });
    expect(topLevel([root]).replies.get('r')).toBe(3);
    // A resync brings back a reply the count already has, then a new one arrives.
    expect(topLevel([root, reply(5), reply(7)]).replies.get('r')).toBe(4);
    expect(
      topLevel([message({ id: 'y', replyCount: 0, lastReplySeq: null })]).replies.get('y'),
    ).toBe(0);
  });
});

describe('reactions', () => {
  const by = (emoji: string, reactorType: 'user' | 'bot', reactorId: string) => ({
    messageId: 'm1',
    emoji,
    reactorType,
    reactorId,
  });

  it('group by emoji, mark the owner’s own, and ignore a repeat', () => {
    let r = withReaction({}, by('👍', 'bot', 'b1'));
    r = withReaction(r, by('👍', 'user', 'u1'));
    r = withReaction(r, by('👀', 'bot', 'b2'));
    expect(withReaction(r, by('👀', 'bot', 'b2'))).toBe(r);
    expect(reactionChips(r.m1).map(({ emoji, count, mine }) => [emoji, count, mine])).toEqual([
      ['👍', 2, true],
      ['👀', 1, false],
    ]);
    r = withoutReaction(r, by('👍', 'user', 'u1'));
    expect(reactionChips(r.m1).map((c) => [c.emoji, c.count, c.mine])).toEqual([
      ['👍', 1, false],
      ['👀', 1, false],
    ]);
  });
});
