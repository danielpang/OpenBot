import { generateText, type LanguageModel } from 'ai';

// Rolling chat summary (plan 5.3 item 6, 18.6): messages that have scrolled
// out of the context window are folded into `chats.summary` by the small
// model, a batch at a time, so a long chat keeps its earlier decisions.

/** Characters kept of a summary; a longer reply is cut at the last sentence that fits. */
export const SUMMARY_MAX_CHARS = 4_000;

export interface SummarizeInput {
  model: LanguageModel;
  /** The summary so far; null for the first batch. */
  previous: string | null;
  /** The messages to fold in, oldest first, already author-prefixed. */
  transcript: string[];
  abortSignal?: AbortSignal;
}

export const SUMMARY_PROMPT = `You keep the running summary of a chat between people and assistant Bots. Fold the new messages into the summary so far and return the updated summary.
Keep what later replies may need: decisions, requests and who made them, open questions, commitments, names, numbers, dates and results. Drop small talk and anything superseded. Refer to participants by their @handle.
Write plain prose or short bullet points, at most about 300 words, with no preamble.`;

export async function summarizeChat(input: SummarizeInput): Promise<string> {
  const previous = input.previous?.trim() ? input.previous.trim() : '(nothing yet)';
  const { text } = await generateText({
    model: input.model,
    instructions: SUMMARY_PROMPT,
    prompt: `Summary so far:\n${previous}\n\nNew messages:\n${input.transcript.join('\n')}`,
    maxRetries: 2,
    abortSignal: input.abortSignal,
  });
  return clipSummary(text.trim());
}

function clipSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const cut = text.slice(0, SUMMARY_MAX_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (end > SUMMARY_MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut).trim();
}
