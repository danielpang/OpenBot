import { SKILL_CONTENT_MAX, SKILL_NAME_MAX } from '@openbots/shared';
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';

// Drafting a Skill from finished work (S3, plan 10.1): the small model reads
// the run's activity log and the conversation around it and writes a name
// and markdown instructions. Plain JSON in a text reply rather than
// structured outputs, so it works on every provider, as memory extraction
// does.

export interface DraftSkillInput {
  model: LanguageModel;
  /** The conversation, oldest first, already author-prefixed. */
  transcript: string[];
  /** The finished run's activity log labels, in order ("Searched web 'x'"). */
  steps: string[];
  /** A name the Bot or owner chose; the model proposes one otherwise. */
  name?: string;
  /** What the owner asked to keep or change. */
  notes?: string;
  abortSignal?: AbortSignal;
}

export interface SkillDraft {
  name: string;
  content: string;
}

export const SKILL_DRAFT_PROMPT = `You turn a piece of work an assistant Bot just finished into a reusable Skill: instructions the Bot can follow next time. Write short markdown: when to use it, the steps in order, how to check the result and what to return. Keep it general enough to reuse and specific about the tools, connectors and checks that were actually used. Leave out secrets, one-off values and personal data.
Answer with only a JSON object: {"name": "...", "content": "..."}.`;

const DraftSchema = z.object({
  name: z.string().trim().min(1).max(SKILL_NAME_MAX).optional(),
  content: z.string().optional(),
});

export async function draftSkill(input: DraftSkillInput): Promise<SkillDraft> {
  const asked = input.name?.trim() ? `Name: ${input.name.trim()}` : 'Name: propose a short one';
  const notes = input.notes?.trim() ? `\n\nThe owner's notes:\n${input.notes.trim()}` : '';
  const steps = input.steps.length
    ? input.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(no steps recorded)';
  const { text } = await generateText({
    model: input.model,
    instructions: SKILL_DRAFT_PROMPT,
    prompt: `${asked}${notes}\n\nActivity log of the run:\n${steps}\n\nConversation:\n${input.transcript.join('\n')}`,
    maxRetries: 2,
    abortSignal: input.abortSignal,
  });
  return parseSkillDraft(text, input.name);
}

/** The JSON object in a reply as a draft; a bad reply has empty content. */
export function parseSkillDraft(text: string, name?: string): SkillDraft {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let raw: unknown = {};
  if (start >= 0 && end > start) {
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      raw = {};
    }
  }
  const parsed = DraftSchema.safeParse(raw);
  const data = parsed.success ? parsed.data : {};
  const chosen = name?.trim() || data.name || 'New Skill';
  return {
    name: chosen.slice(0, SKILL_NAME_MAX),
    content: (data.content ?? '').trim().slice(0, SKILL_CONTENT_MAX),
  };
}
