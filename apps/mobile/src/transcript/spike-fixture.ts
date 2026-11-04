import type { Message } from './model';

/** A deterministic 500-row replay workload for device profiling. These are
 * synthetic fixture messages, never mixed into a user's real conversations. */
export function spikeMessages(): Message[] {
  return Array.from({ length: 500 }, (_, index) => ({
    id: `spike-${index}`,
    chatId: 'spike-chat',
    seq: index + 1,
    threadRootId: null,
    authorType: index % 3 === 0 ? 'user' : 'bot',
    authorId: null,
    parts: [
      {
        type: 'text',
        text:
          index % 3 === 0
            ? `Review task ${index + 1}: what should happen next?`
            : `### Task ${index + 1}\n\nI checked the latest changes. Here is the next step:\n\n- Verify the existing behavior\n- Update the implementation\n- Run the focused checks\n\nThe result is **ready to review** with \`streaming\` enabled.`,
      },
      ...(index % 9 === 0
        ? [
            {
              type: 'tool_result' as const,
              tool_call_id: `tool-${index}`,
              tool_name: 'read_file',
              label: 'Read project notes',
              result: { lines: 64, ok: true },
            },
          ]
        : []),
    ],
    mentions: [],
    mentionEveryone: false,
    runId: null,
    status: index === 499 ? 'streaming' : 'complete',
    deltaSeq: 0,
    updatedSeq: index + 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
  }));
}
const replayText =
  '\n\n## Live update\n\nThis reply is arriving in small chunks while the other 499 messages stay unchanged. Scroll up and down during the replay.\n\n```typescript\nconst result = await bot.run(task);\nconsole.log(result.status);\n```\n\nThe transcript contains headings, lists, code blocks, tools and streaming markdown. ';
export const spikeReplay = Array.from({ length: 80 }, (_, index) => ({
  deltaSeq: index + 1,
  deltas: [
    {
      partIndex: 0,
      type: 'text',
      text: replayText.slice(
        (index % 20) * Math.ceil(replayText.length / 20),
        ((index % 20) + 1) * Math.ceil(replayText.length / 20),
      ),
    },
  ],
}));
