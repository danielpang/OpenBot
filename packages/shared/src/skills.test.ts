import { describe, expect, it } from 'vitest';
import { skillSlug, skillSummary } from './skills.js';

describe('skills', () => {
  it('summarizes the first line of text', () => {
    expect(skillSummary('# Weekly report\n\n## When\nUse on Fridays.')).toBe('Use on Fridays.');
    expect(skillSummary('\n\n- **On**\n  Fridays ')).toBe('**On**');
    expect(skillSummary('```\ncode\n```\n> Quoted   text')).toBe('Quoted text');
    expect(skillSummary('> * Nested item')).toBe('Nested item');
    expect(skillSummary('')).toBe('');
    expect(skillSummary('x'.repeat(400), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('summarizes a long run of markers quickly', () => {
    const started = performance.now();
    skillSummary(`${'-'.repeat(200_000)} `);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('slugs names', () => {
    expect(skillSlug('Weekly Report: Q3!')).toBe('weekly-report-q3');
    expect(skillSlug('Résumé review')).toBe('resume-review');
    expect(skillSlug('!!!')).toBe('skill');
  });
});
