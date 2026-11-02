import { describe, expect, it } from 'vitest';
import { promptText, scriptedModel } from '../testing.js';
import { SUMMARY_MAX_CHARS, SUMMARY_PROMPT, summarizeChat } from './summarize.js';

describe('summarizeChat', () => {
  it('folds the new messages into the previous summary', async () => {
    const model = scriptedModel([[{ text: '  Dana wants the launch on Friday.  ' }]]);
    const summary = await summarizeChat({
      model,
      previous: 'Dana is planning a launch.',
      transcript: ['[@dana (owner)] Make it Friday', '[@scout (bot)] Moved to Friday.'],
    });
    expect(summary).toBe('Dana wants the launch on Friday.');
    const prompt = promptText(model.calls[0]!);
    expect(prompt).toContain(SUMMARY_PROMPT);
    expect(prompt).toContain('Summary so far:\nDana is planning a launch.');
    expect(prompt).toContain('New messages:\n[@dana (owner)] Make it Friday\n[@scout (bot)]');
  });

  it('starts from nothing and caps a long reply at a sentence', async () => {
    const long = 'A decision was made. '.repeat(400);
    const model = scriptedModel([[{ text: long }]]);
    const summary = await summarizeChat({ model, previous: null, transcript: ['[system] hi'] });
    expect(promptText(model.calls[0]!)).toContain('Summary so far:\n(nothing yet)');
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(summary.endsWith('made.')).toBe(true);
  });
});
