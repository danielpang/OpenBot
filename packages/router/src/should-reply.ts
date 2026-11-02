import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';

// `shouldReply` (plan 7, C5): in a group, a message that addresses nobody is
// shown to each Bot's small model with the Bot's label and description and
// the last few messages; the answer is a structured `{reply, reason}`.

export const SHOULD_REPLY_WINDOW = 8;

export const ShouldReplySchema = z.object({
  reply: z.boolean().describe('Whether this Bot should answer the last message'),
  reason: z.string().max(300).describe('One short sentence on why'),
});

export type ShouldReplyDecision = z.infer<typeof ShouldReplySchema> & {
  /**
   * Set when there was no decision: the model call failed or its answer was
   * not the schema. `reply` is then false; the caller tells the owner when
   * no Bot of a group could decide (C5).
   */
  error?: string;
};

export interface ShouldReplyInput {
  model: LanguageModel;
  bot: { handle: string; name: string; label: string | null; description: string };
  /** The other participants, for "is this for someone else?". */
  roster: { handle: string; label?: string | null; kind: 'owner' | 'bot' }[];
  /** The end of the group transcript, oldest first, author-prefixed; the last line is the new message. */
  recent: string[];
  abortSignal?: AbortSignal;
}

export const SHOULD_REPLY_PROMPT = `You decide whether one Bot in a group chat should answer the newest message. The owner wrote it without naming anyone, so the Bots in the chat decide among themselves who responds.
Answer yes when the message is within this Bot's role or asks something the Bot is well placed to do, or when it is clearly addressed to everyone. Answer no when another participant is better placed, when it is small talk the Bot has nothing to add to, or when the Bot already answered it.
Messages are prefixed with their author, like [@dana (owner)] or [@researcher (bot)].`;

export async function shouldReply(input: ShouldReplyInput): Promise<ShouldReplyDecision> {
  const { bot } = input;
  const roster = input.roster
    .map((r) => `- @${r.handle} (${r.kind})${r.label ? `: ${r.label}` : ''}`)
    .join('\n');
  const recent = input.recent.slice(-SHOULD_REPLY_WINDOW).join('\n');
  try {
    const { output } = await generateText({
      model: input.model,
      instructions: SHOULD_REPLY_PROMPT,
      prompt:
        `The Bot: @${bot.handle} (${bot.name})${bot.label ? `, ${bot.label}` : ''}\n` +
        `Its standing rules:\n${bot.description.trim() || '(none)'}\n\n` +
        `Others in the chat:\n${roster || '(nobody)'}\n\n` +
        `Recent messages, newest last:\n${recent}`,
      output: Output.object({ schema: ShouldReplySchema, name: 'should_reply' }),
      maxRetries: 2,
      abortSignal: input.abortSignal,
    });
    return output;
  } catch (error) {
    const message = (error as Error).message;
    return { reply: false, reason: `No decision: ${message}`.slice(0, 300), error: message };
  }
}
