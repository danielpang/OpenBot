import { describe, expect, it } from 'vitest';
import {
  applyUnifiedPatch,
  artifactFileName,
  artifactMime,
  diffSummary,
  formatDiffSummary,
  isTextMime,
  lineCount,
  lineDiff,
  mimeForName,
  PACKAGE_NAME,
  PatchError,
  rebaseEdit,
} from './index.js';

describe('@openbots/artifacts', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbots/artifacts');
  });
});

describe('diffSummary', () => {
  it('counts added and removed lines', () => {
    const before = 'one\ntwo\nthree\nfour\n';
    const after = 'one\n2\nthree\nfour\nfive\nsix\n';
    expect(diffSummary(before, after)).toEqual({ added: 3, removed: 1, summary: '+3 −1' });
  });

  it('counts a first version as all added', () => {
    expect(diffSummary('', 'a\nb\nc')).toMatchObject({ added: 3, removed: 0 });
  });

  it('formats with a real minus sign', () => {
    expect(formatDiffSummary(14, 10)).toBe('+14 −10');
  });

  it('counts lines with or without a trailing newline', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(2);
  });
});

describe('rebaseEdit', () => {
  const base = 'Title\n\nIntro line.\n\nMiddle.\n\nOutro line.\n';
  it('replays the owner’s change onto a newer version that changed elsewhere', () => {
    const edited = base.replace('Intro line.', 'Intro, edited by you.');
    const latest = base.replace('Outro line.', 'Outro, edited by the Bot.');
    expect(rebaseEdit(base, edited, latest)).toBe(
      'Title\n\nIntro, edited by you.\n\nMiddle.\n\nOutro, edited by the Bot.\n',
    );
  });

  it('gives up when both changed the same lines', () => {
    const edited = base.replace('Middle.', 'Middle, yours.');
    const latest = base.replace('Middle.', 'Middle, the Bot’s.');
    expect(rebaseEdit(base, edited, latest)).toBeNull();
  });

  it('keeps either side when the other did not change', () => {
    expect(rebaseEdit(base, base, 'new')).toBe('new');
    expect(rebaseEdit(base, 'mine', base)).toBe('mine');
  });
});

describe('applyUnifiedPatch', () => {
  const source = '# Q3 summary\n\nRevenue grew.\nCosts fell.\n';

  it('applies a unified diff', () => {
    const patch = [
      '--- a/q3.md',
      '+++ b/q3.md',
      '@@ -2,3 +2,4 @@',
      ' ',
      '-Revenue grew.',
      '+Revenue grew 12%.',
      '+Margin improved.',
      ' Costs fell.',
      '',
    ].join('\n');
    const result = applyUnifiedPatch(source, patch);
    expect(result).toBe('# Q3 summary\n\nRevenue grew 12%.\nMargin improved.\nCosts fell.\n');
    expect(diffSummary(source, result).summary).toBe('+2 −1');
  });

  it('applies a hunk without file headers', () => {
    const patch = '@@ -4 +4 @@\n-Costs fell.\n+Costs rose.\n';
    expect(applyUnifiedPatch(source, patch)).toContain('Costs rose.');
  });

  it('refuses a patch that does not fit the content', () => {
    const patch = '@@ -3 +3 @@\n-Revenue shrank.\n+Revenue grew.\n';
    expect(() => applyUnifiedPatch(source, patch)).toThrow(PatchError);
    expect(() => applyUnifiedPatch(source, patch)).toThrow(/does not apply/);
  });

  it('refuses text without hunks and multi-file patches', () => {
    expect(() => applyUnifiedPatch(source, 'just new text')).toThrow(/no hunks/);
    const two = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n';
    expect(() => applyUnifiedPatch('a\n', two)).toThrow(/more than one file/);
  });
});

describe('artifactMime', () => {
  it('uses the title extension, then the kind', () => {
    expect(artifactMime('code', 'main.py', 'print(1)')).toBe('text/x-python');
    expect(artifactMime('document', 'Q3 summary', '# Q3')).toBe('text/markdown');
    expect(artifactMime('data', 'rows', '[{"a":1}]')).toBe('application/json');
    expect(artifactMime('data', 'rows', 'a,b\n1,2\n')).toBe('text/csv');
    expect(artifactMime('design', 'logo', '<svg viewBox="0 0 1 1"></svg>')).toBe('image/svg+xml');
    expect(artifactMime('design', 'notes', 'not svg')).toBe('text/plain');
  });

  it('never gives text a binary type from the title', () => {
    expect(artifactMime('design', 'chart.png', '<svg></svg>')).toBe('image/svg+xml');
    expect(artifactMime('file', 'report.pdf', 'plain words')).toBe('text/plain');
  });

  it('knows PDFs and raster images by extension', () => {
    expect(mimeForName('report.PDF')).toBe('application/pdf');
    expect(mimeForName('photo.jpg')).toBe('image/jpeg');
    expect(mimeForName('photo.jpeg')).toBe('image/jpeg');
    expect(mimeForName('a.png')).toBe('image/png');
    expect(mimeForName('a.webp')).toBe('image/webp');
    expect(mimeForName('a.gif')).toBe('image/gif');
    expect(mimeForName('README')).toBeUndefined();
  });

  it('tells text types from binary ones', () => {
    for (const mime of ['text/markdown', 'application/json', 'image/svg+xml', 'text/csv; x=1']) {
      expect(isTextMime(mime), mime).toBe(true);
    }
    for (const mime of ['image/png', 'application/pdf', 'application/octet-stream']) {
      expect(isTextMime(mime), mime).toBe(false);
    }
  });

  it('names downloads with an extension', () => {
    expect(artifactFileName('Q3 summary', 'text/markdown')).toBe('Q3 summary.md');
    expect(artifactFileName('main.py', 'text/x-python')).toBe('main.py');
    expect(artifactFileName('a/b', 'text/plain')).toBe('a-b.txt');
    expect(artifactFileName('Logo', 'image/jpeg')).toBe('Logo.jpg');
    expect(artifactFileName('Q3 deck', 'application/pdf')).toBe('Q3 deck.pdf');
    expect(artifactFileName('blob', 'application/octet-stream')).toBe('blob.bin');
  });
});

describe('lineDiff', () => {
  it('marks each line added, removed or the same', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'B' },
      { type: 'same', text: 'c' },
      { type: 'added', text: 'd' },
    ]);
  });

  it('handles empty sides and a missing final newline', () => {
    expect(lineDiff('', 'one\ntwo')).toEqual([
      { type: 'added', text: 'one' },
      { type: 'added', text: 'two' },
    ]);
    expect(lineDiff('same', 'same')).toEqual([{ type: 'same', text: 'same' }]);
  });
});
