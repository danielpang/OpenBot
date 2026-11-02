import type { MessagePart } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../policy/index.js';
import { executeRun } from '../run/execute.js';
import { promptText, scriptedModel } from '../testing.js';
import { toolFacts, toolsFor } from '../tools/index.js';
import type { SkillServices, ToolContext } from '../tools/types.js';
import { draftSkill, parseSkillDraft } from './draft.js';

const run = { id: 'run-1', botId: 'bot-1', chatId: 'chat-1', trigger: 'message' };
const memory = {
  remember: async () => ({ id: 'm', kind: 'fact' as const, content: '' }),
  search: async () => [],
};
const content = 'Use on Fridays.\n\n1. Collect';

function skillServices(): SkillServices & { drafts: unknown[] } {
  const drafts: unknown[] = [];
  return {
    drafts,
    load: async (name) => {
      if (name.toLowerCase() !== 'weekly report') throw new Error(`No Skill named "${name}"`);
      return { skill_id: 's1', name: 'Weekly report', content: '1. List merged PRs' };
    },
    draft: async (input) => {
      drafts.push(input);
      return { skill_id: 's2', name: input.name ?? 'Drafted', content };
    },
  };
}

async function runWith(turns: Parameters<typeof scriptedModel>[0], skills: SkillServices) {
  const model = scriptedModel(turns);
  const parts: MessagePart[] = [];
  const toolContext: ToolContext = { run, memory, skills };
  await executeRun({
    run,
    model,
    instructions: 'You are a test Bot.',
    messages: [{ role: 'user', content: '[@dana (owner)] hello' }],
    tools: toolsFor(toolContext),
    toolContext,
    policy: defaultPolicy,
    abortSignal: new AbortController().signal,
    sink: {
      text: async (t) => void parts.push({ type: 'text', text: t }),
      reasoning: async () => {},
      part: async (p) => parts.push(p) - 1,
    },
    setState: async () => {},
    recordStep: async () => {},
    drainSteering: async () => [],
  });
  return { model, parts };
}

describe('Skill tools', () => {
  it('are offered only with a Skills library, in the conversation group', () => {
    expect(Object.keys(toolsFor({ run, memory }))).not.toContain('use_skill');
    const ctx: ToolContext = { run, memory, skills: skillServices() };
    expect(Object.keys(toolsFor(ctx))).toEqual(expect.arrayContaining(['use_skill', 'save_skill']));
    expect(toolFacts(ctx).get('save_skill')).toEqual({ group: 'conversation' });
  });

  it('use_skill loads the content into the tool result', async () => {
    const { model } = await runWith(
      [[{ tool: 'use_skill', args: { name: 'Weekly report' }, id: 'u1' }], [{ text: 'On it.' }]],
      skillServices(),
    );
    expect(promptText(model.calls[1]!)).toContain('1. List merged PRs');
  });

  it('save_skill posts a skill_draft widget after its result', async () => {
    const skills = skillServices();
    const { parts } = await runWith(
      [
        [{ tool: 'save_skill', args: { name: 'Weekly report', notes: 'Skip drafts' }, id: 's1' }],
        [{ text: 'Drafted.' }],
      ],
      skills,
    );
    expect(skills.drafts).toEqual([{ name: 'Weekly report', notes: 'Skip drafts' }]);
    expect(parts.filter((p) => p.type === 'widget')).toEqual([
      {
        type: 'widget',
        kind: 'skill_draft',
        props: { skill_id: 's2', name: 'Weekly report', content },
        state: { status: 'draft' },
      },
    ]);
  });
});

describe('draftSkill', () => {
  it('drafts a name and content from the steps and the conversation with the small model', async () => {
    const reply = JSON.stringify({
      name: 'Weekly report',
      content: ' Use on Fridays.\n\n1. List merged PRs\n2. Summarize ',
    });
    const model = scriptedModel([[{ text: `Here it is:\n${reply}` }]]);
    const draft = await draftSkill({
      model,
      transcript: ['[@dana (owner)] summarize the week'],
      steps: ['Listed pull requests', 'Wrote the summary'],
      notes: 'Keep it short',
    });
    expect(draft).toEqual({
      name: 'Weekly report',
      content: 'Use on Fridays.\n\n1. List merged PRs\n2. Summarize',
    });
    const prompt = promptText(model.calls[0]!);
    expect(prompt).toContain('1. Listed pull requests\n2. Wrote the summary');
    expect(prompt).toContain('Keep it short');
    expect(JSON.stringify(model.calls[0]!.prompt)).toContain(
      '{\\"name\\": \\"...\\", \\"content\\": \\"...\\"}',
    );
  });

  it('keeps a chosen name and survives a reply without JSON', () => {
    expect(parseSkillDraft('{"name":"X","content":"go"}', 'Chosen')).toEqual({
      name: 'Chosen',
      content: 'go',
    });
    expect(parseSkillDraft('sorry')).toEqual({ name: 'New Skill', content: '' });
  });
});
