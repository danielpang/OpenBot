import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';
import { shouldReply, type ShouldReplyInput } from './should-reply.js';

// `shouldReply` against a mocked small model: one structured call per Bot.

function model(reply: string | Error) {
  const prompts: string[] = [];
  const m = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      if (reply instanceof Error) throw reply;
      return {
        content: [{ type: 'text', text: reply }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { m, prompts, calls: () => m.doGenerateCalls };
}

const input = (m: MockLanguageModelV4): ShouldReplyInput => ({
  model: m,
  bot: {
    handle: 'researcher',
    name: 'Researcher',
    label: 'Finds sources',
    description: 'Answer research questions.',
  },
  roster: [
    { handle: 'dana', kind: 'owner' },
    { handle: 'writer', kind: 'bot', label: 'Drafts posts' },
  ],
  recent: ['[@dana (owner)] Can someone find three papers on loop guards?'],
});

describe('shouldReply', () => {
  it('is the package', () => expect(PACKAGE_NAME).toBe('@openbots/router'));

  it('returns the structured decision', async () => {
    const { m, prompts, calls } = model('{"reply": true, "reason": "Research is my role"}');
    // A decision carries no error.
    expect(await shouldReply(input(m))).toEqual({ reply: true, reason: 'Research is my role' });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.responseFormat).toMatchObject({ type: 'json', name: 'should_reply' });
    expect(prompts[0]).toContain('@researcher (Researcher), Finds sources');
    expect(prompts[0]).toContain('@writer (bot): Drafts posts');
    expect(prompts[0]).toContain('three papers on loop guards');
  });

  it('declines on a reply that is not the schema', async () => {
    const { m } = model('Sure, I will help!');
    const decision = await shouldReply(input(m));
    expect(decision.reply).toBe(false);
    expect(decision.error).toBeTruthy();
  });

  it('declines when the model call fails', async () => {
    const { m } = model(new Error('overloaded'));
    const decision = await shouldReply(input(m));
    expect(decision.reply).toBe(false);
    expect(decision.reason).toContain('overloaded');
    expect(decision.error).toContain('overloaded');
  });
});
