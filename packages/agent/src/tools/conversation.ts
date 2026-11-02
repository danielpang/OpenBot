import { SKILL_NAME_MAX, type MessagePart } from '@openbots/shared';
import { botWidgetKinds, validateBotWidget, validateWidgetProps } from '@openbots/widgets';
import { z } from 'zod';
import { WaitFor } from '../gated.js';
import { defineTool, type DraftedSkill, type ToolGroup } from './types.js';

// Conversation tools (plan 5.4): widgets, questions, memory, reactions, Bot
// to Bot messages and Skills (`use_skill`, `save_skill`; plan 10.1).
// `propose_routine` joins this group with Routines. Mentioning a Bot needs no tool: an `@handle` in a
// group reply wakes it (plan 7).

export const MEMORY_SEARCH_LIMIT = 10;

const widgetKindList = () =>
  botWidgetKinds()
    .map((k) => `${k.kind} (${k.description})`)
    .join(', ');

export const showWidget = defineTool({
  get description() {
    return (
      'Answer with a widget instead of prose when it is clearer. Kinds: ' +
      `${widgetKindList()}. To ask the owner something and wait for the answer, use ask_user.`
    );
  },
  inputSchema: z.object({
    kind: z.string().describe('The widget kind'),
    props: z.record(z.string(), z.unknown()).describe("The kind's props"),
  }),
  async execute({ kind, props }) {
    const checked = validateBotWidget(kind, props);
    if (!checked.ok) throw new Error(checked.error);
    return { shown: true, kind };
  },
});

/** The widget the loop posts after a `show_widget` result, with its props as the kind parses them (W1). */
export function shownWidgetPart(
  toolName: string,
  input: unknown,
  output: unknown,
): MessagePart | null {
  if (toolName !== 'show_widget' || !(output as { shown?: boolean } | undefined)?.shown)
    return null;
  const { kind, props } = input as { kind: string; props: unknown };
  const checked = validateBotWidget(kind, props);
  return checked.ok ? { type: 'widget', kind, props: checked.value } : null;
}

export const askUser = defineTool({
  description:
    'Ask the owner a question and wait for the answer. Use it when you are unsure what they ' +
    'want or a choice is theirs to make. Offer options when the likely answers are few. The ' +
    'run pauses until they answer; the answer comes back as this tool result.',
  inputSchema: z.object({
    question: z.string().min(1).max(2_000),
    options: z
      .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(200) }))
      .max(8)
      .optional()
      .describe('Buttons to offer; omit for a free-text answer'),
    allow_text: z.boolean().optional().describe('Accept a typed answer besides the options'),
  }),
  async execute(args) {
    const checked = validateWidgetProps('question', args);
    if (!checked.ok) throw new Error(checked.error);
    throw new WaitFor({
      reason: 'question',
      widget: { kind: 'question', props: checked.value },
      label: 'Waiting for your answer',
    });
  },
});

export const requestLogin = defineTool({
  description:
    'Ask the owner to sign in to a site on the computer when you need a login you do not have. ' +
    'Never ask for a password or a code in chat. The owner signs in on a screen and the login ' +
    'is shared with every Bot on the computer. The run pauses until they are done; the result ' +
    'says whether they signed in.',
  inputSchema: z.object({
    site: z.string().trim().min(1).max(253).describe("The site's host name, e.g. github.com"),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2_000)
      .optional()
      .describe('The sign-in page, if you know it'),
    reason: z.string().trim().min(1).max(1_000).describe('What you need the login for'),
  }),
  async execute(args, ctx) {
    if (!ctx.logins) throw new Error('Sign-in requests are not available here');
    const plan = await ctx.logins.request(args);
    throw new WaitFor({
      reason: 'widget',
      widget: plan.widget,
      label: `Waiting for sign-in: ${plan.site}`,
      ...(plan.posted ? { posted: plan.posted } : {}),
    });
  },
});

export const remember = defineTool({
  description:
    'Save something worth keeping across conversations: a stable preference of the owner, an ' +
    'important fact, or a short summary of work done. One idea per call, in one sentence.',
  inputSchema: z.object({
    kind: z.enum(['preference', 'fact', 'summary']),
    content: z.string().min(1).max(1_000),
  }),
  async execute({ kind, content }, ctx) {
    const item = await ctx.memory.remember({ kind, content });
    return { saved: true, id: item.id };
  },
});

export const searchMemory = defineTool({
  description:
    'Search your saved memories. Memory can be stale: check a current source before acting on ' +
    'it for anything consequential.',
  inputSchema: z.object({ query: z.string().min(1).max(500) }),
  async execute({ query }, ctx) {
    const items = await ctx.memory.search(query, MEMORY_SEARCH_LIMIT);
    return { items: items.map(({ id, kind, content }) => ({ id, kind, content })) };
  },
});

export const messageBot = defineTool({
  description:
    "Send a message to another of your owner's Bots by handle. It lands in your private chat " +
    'with that Bot (your owner can read it) and wakes it; it answers later in that chat, which ' +
    'wakes you again. Use it to hand off or ask for work outside the current chat; in a group, ' +
    '@mention the Bot instead. Write a complete request: the other Bot sees only that chat.',
  inputSchema: z.object({
    handle: z.string().min(1).max(64).describe("The other Bot's handle, with or without @"),
    text: z.string().min(1).max(8_000),
  }),
  async execute({ handle, text }, ctx) {
    if (!ctx.bots) throw new Error('Messaging other Bots is not available here');
    const sent = await ctx.bots.send({ handle: handle.replace(/^@/, '').toLowerCase(), text });
    if (!sent.woke) {
      return {
        sent: true,
        chat_id: sent.chatId,
        note: 'A loop guard stopped this exchange; the Bot was not woken',
      };
    }
    return { sent: true, chat_id: sent.chatId };
  },
});

export const react = defineTool({
  description:
    'React to a message with one emoji, as a lightweight acknowledgement ("seen", "done", ' +
    '"thanks") when a reply would add nothing. Without message_id it reacts to the latest ' +
    'message in this chat (or this thread) from someone other than you.',
  inputSchema: z.object({
    emoji: z.string().trim().min(1).max(32).describe('One emoji, e.g. 👍'),
    message_id: z.uuid().optional().describe('The message to react to'),
  }),
  async execute({ emoji, message_id }, ctx) {
    if (!ctx.reactions) throw new Error('Reactions are not available here');
    const done = await ctx.reactions.react({
      emoji,
      ...(message_id ? { messageId: message_id } : {}),
    });
    return { reacted: true, message_id: done.messageId, emoji };
  },
});

export const useSkill = defineTool({
  description:
    'Load the full instructions of one of your Skills by its name from the Skills list in your ' +
    'instructions, when the task matches it. Follow the Skill, including what it says needs ' +
    'approval.',
  inputSchema: z.object({ name: z.string().trim().min(1).max(200).describe('The Skill name') }),
  async execute({ name }, ctx) {
    if (!ctx.skills) throw new Error('Skills are not available here');
    return ctx.skills.load(name);
  },
});

export const saveSkill = defineTool({
  description:
    'Save the work you just finished in this chat as a reusable Skill when the owner asks for ' +
    'it. Its instructions are written from the run and shown to the owner, who can edit them. ' +
    'Name it after the task.',
  inputSchema: z.object({
    name: z.string().trim().min(1).max(SKILL_NAME_MAX).optional().describe('A short name'),
    notes: z
      .string()
      .max(2_000)
      .optional()
      .describe('What the owner said to keep or change, for the draft'),
  }),
  async execute(args, ctx) {
    if (!ctx.skills) throw new Error('Skills are not available here');
    const drafted = await ctx.skills.draft(args);
    return { drafted: true, ...drafted };
  },
});

/** The `skill_draft` widget the loop posts after a `save_skill` result (S3). */
export function skillDraftPart(toolName: string, output: unknown): MessagePart | null {
  if (toolName !== 'save_skill') return null;
  const drafted = output as ({ drafted?: boolean } & Partial<DraftedSkill>) | undefined;
  if (!drafted?.drafted || !drafted.skill_id || !drafted.name || drafted.content === undefined) {
    return null;
  }
  return {
    type: 'widget',
    kind: 'skill_draft',
    props: { skill_id: drafted.skill_id, name: drafted.name, content: drafted.content },
    state: { status: 'draft' },
  };
}

export const conversationTools: ToolGroup = {
  name: 'conversation',
  tools: (ctx) => ({
    show_widget: showWidget,
    ask_user: askUser,
    remember,
    search_memory: searchMemory,
    ...(ctx.reactions ? { react } : {}),
    ...(ctx.bots ? { message_bot: messageBot } : {}),
    ...(ctx.logins ? { request_login: requestLogin } : {}),
    ...(ctx.skills ? { use_skill: useSkill, save_skill: saveSkill } : {}),
  }),
};
