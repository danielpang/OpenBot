import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { MemoryKind } from '../tools/types.js';

// Post-run memory extraction (M1, plan 18.2): the small model reads the end
// of the conversation and proposes at most three memories. Plain JSON in a
// text reply rather than structured outputs, so it works on every provider.

export const MAX_EXTRACTED = 3;

const ExtractedSchema = z.array(
  z.object({
    kind: z.enum(['preference', 'fact', 'summary']),
    content: z.string().trim().min(3).max(500),
  }),
);

export interface ExtractedMemory {
  kind: MemoryKind;
  content: string;
}

export interface ExtractInput {
  model: LanguageModel;
  /** The end of the conversation, oldest first, already author-prefixed. */
  transcript: string[];
  /** What the Bot already remembers, so it is not saved twice. */
  existing: string[];
  abortSignal?: AbortSignal;
}

export const EXTRACTION_PROMPT = `You maintain the long-term memory of an assistant Bot. Read the conversation and list what is worth remembering for future conversations:
- preference: a stable working preference of the owner ("prefers British spelling")
- fact: an important fact that will stay true for a while ("the production database is on db-2")
- summary: one sentence on work the Bot finished ("drafted the Q3 report outline")
Skip small talk, one-off requests, secrets and anything already remembered. Return at most ${MAX_EXTRACTED} items, fewer or none when nothing qualifies.
Answer with only a JSON array of {"kind": "...", "content": "..."} objects, e.g. [] or [{"kind":"fact","content":"..."}].`;

export async function extractMemories(input: ExtractInput): Promise<ExtractedMemory[]> {
  const known = input.existing.length
    ? `Already remembered:\n${input.existing.map((c) => `- ${c}`).join('\n')}`
    : 'Already remembered: nothing';
  const { text } = await generateText({
    model: input.model,
    instructions: EXTRACTION_PROMPT,
    prompt: `${known}\n\nConversation:\n${input.transcript.join('\n')}`,
    maxRetries: 2,
    abortSignal: input.abortSignal,
  });
  return parseExtracted(text, input.existing);
}

/** The JSON array in a reply, validated, deduplicated, at most three items. */
export function parseExtracted(text: string, existing: string[] = []): ExtractedMemory[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const parsed = ExtractedSchema.safeParse(raw);
  if (!parsed.success) return [];
  const seen = new Set(existing.map(normalize));
  const out: ExtractedMemory[] = [];
  for (const item of parsed.data) {
    const key = normalize(item.content);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length === MAX_EXTRACTED) break;
  }
  return out;
}

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
