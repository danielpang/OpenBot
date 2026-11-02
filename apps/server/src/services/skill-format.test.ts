import { describe, expect, it } from 'vitest';
import recorded from './__fixtures__/anthropics-skills.json' with { type: 'json' };
import { parseSkillFile, SkillFormatError } from './skill-format.js';

const files = recorded.files as Record<string, string>;

describe('parseSkillFile', () => {
  it('takes the name from the frontmatter and the content from the body, after the description', () => {
    const parsed = parseSkillFile(files['skills/webapp-testing/SKILL.md']!);
    expect(parsed.name).toBe('webapp-testing');
    expect(parsed.license).toBe('Complete terms in LICENSE.txt');
    expect(parsed.description).toMatch(/^Toolkit for interacting with and testing local web/);
    expect(parsed.content).toMatch(
      /^Toolkit for interacting with and testing local web applications using Playwright\..*\n\n# Web Application Testing\n/s,
    );
    expect(parsed.content).toContain('## Decision Tree: Choosing Your Approach');
    expect(parsed.content).not.toContain('---');
  });

  it('keeps headings and code as they are', () => {
    const body = '# Release notes\n\n## Steps\n1. List merged PRs\n```md\n## Output\n```';
    const parsed = parseSkillFile(`---\nname: Release notes\n---\n${body}\n`);
    expect(parsed).toEqual({
      name: 'Release notes',
      description: '',
      content: body,
      license: null,
    });
  });

  it('does not repeat a description the body already holds', () => {
    const parsed = parseSkillFile(
      '---\nname: x\ndescription: Use it on Fridays.\n---\nUse it on Fridays.\n\n1. Go',
    );
    expect(parsed.content).toBe('Use it on Fridays.\n\n1. Go');
  });

  it('reads a file without frontmatter as content only', () => {
    const parsed = parseSkillFile('# Weekly report\n\n1. Collect');
    expect(parsed).toEqual({
      name: '',
      description: '',
      content: '# Weekly report\n\n1. Collect',
      license: null,
    });
  });

  it('refuses frontmatter that is not YAML fields', () => {
    expect(() => parseSkillFile('---\nname: [unclosed\n---\nBody')).toThrow(SkillFormatError);
    expect(() => parseSkillFile('---\n- a list\n---\nBody')).toThrow(
      'The frontmatter is not a set of fields',
    );
  });

  it('reads CRLF line endings and a byte order mark', () => {
    const parsed = parseSkillFile(
      '\uFEFF---\r\nname: Win\r\ndescription: Here\r\n---\r\nDo it.\r\n',
    );
    expect(parsed).toMatchObject({ name: 'Win', content: 'Here\n\nDo it.' });
  });

  it('keeps an Agent Skill with little but frontmatter', () => {
    const parsed = parseSkillFile(files['template/SKILL.md']!);
    expect(parsed.name).toBe('template-skill');
    expect(parsed.content).toContain('# Insert instructions below');
  });
});

describe('untrusted input stays linear', () => {
  const quick = (input: string) => {
    const started = performance.now();
    try {
      parseSkillFile(input);
    } catch (error) {
      // Refusing bad frontmatter is fine; taking long over it is not.
      if (!(error instanceof SkillFormatError)) throw error;
    }
    return performance.now() - started;
  };

  it('parses pathological frontmatter and bodies in well under 100 ms', () => {
    const inputs = [
      `# ${' '.repeat(50_000)}x`,
      `${' '.repeat(50_000)}x`,
      `---\n${'#'.repeat(50_000)}\n${' '.repeat(50_000)}`,
      `---\nname: x\n${'--- \t'.repeat(10_000)}x\n---\nbody`,
      `---\ndescription: ${'a'.repeat(30_000)}\n---\n${'a'.repeat(100_000)}`,
    ];
    for (const input of inputs) expect(quick(input), input.slice(0, 20)).toBeLessThan(100);
  });

  it('refuses frontmatter longer than 64 KB', () => {
    expect(() => parseSkillFile(`---\na: ${'b'.repeat(70_000)}\n---\nBody`)).toThrow(
      'The frontmatter is longer than 64 KB',
    );
  });
});
