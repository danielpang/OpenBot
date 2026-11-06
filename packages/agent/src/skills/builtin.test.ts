import { readFileSync } from 'node:fs';
import { SKILL_CONTENT_MAX, SKILL_NAME_MAX } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS, WORKING_IN_A_REPOSITORY_SKILL } from './builtin.js';

describe('built-in Skills (CA12)', () => {
  it('keeps "Working in a repository" the same as its markdown file', () => {
    const md = readFileSync(new URL('./working-in-a-repository.md', import.meta.url), 'utf8');
    expect(WORKING_IN_A_REPOSITORY_SKILL.content).toBe(md);
    expect(md).toMatch(/plan mode/);
    expect(md).toMatch(/tests/);
  });

  it('fits the library limits, with unique slugs and no dashes in the text', () => {
    const slugs = new Set(BUILTIN_SKILLS.map((s) => s.slug));
    expect(slugs.size).toBe(BUILTIN_SKILLS.length);
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.name.length).toBeLessThanOrEqual(SKILL_NAME_MAX);
      expect(skill.content.length).toBeLessThanOrEqual(SKILL_CONTENT_MAX);
      expect(skill.content).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
