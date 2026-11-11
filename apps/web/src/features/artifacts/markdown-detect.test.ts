import { describe, expect, it } from 'vitest';
import { isMarkdownDocument } from './viewer.js';

describe('isMarkdownDocument', () => {
  it('trusts the mime type and a .md name', () => {
    expect(isMarkdownDocument('Notes', 'text/markdown', 'plain words')).toBe(true);
    expect(isMarkdownDocument('notes.md', 'text/plain', 'plain words')).toBe(true);
  });

  it('spots Markdown in plain text', () => {
    expect(isMarkdownDocument('Notes', 'text/plain', '# Title\nBody')).toBe(true);
    expect(isMarkdownDocument('Notes', 'text/plain', 'Intro\n- one\n- two')).toBe(true);
    expect(isMarkdownDocument('Notes', 'text/plain', '1. First\n2. Second')).toBe(true);
    expect(isMarkdownDocument('Notes', 'text/plain', 'A **bold** claim')).toBe(true);
    expect(isMarkdownDocument('Notes', 'text/plain', 'See [docs](https://x.dev)')).toBe(true);
  });

  it('leaves ordinary text and other types alone', () => {
    expect(isMarkdownDocument('Notes', 'text/plain', 'Just a sentence. And another.')).toBe(false);
    expect(isMarkdownDocument('data', 'text/csv', '# not a heading')).toBe(false);
  });
});
