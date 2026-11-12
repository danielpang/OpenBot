import { describe, expect, it } from 'vitest';
import { availabilityText, initialPicks, parseSkillFile } from './data';

describe('parseSkillFile', () => {
  it('reads the Agent Skills frontmatter and puts the description first', () => {
    const file = [
      '---',
      'name: pdf-tools',
      'description: "Use when the owner asks about PDFs"',
      'license: MIT',
      '---',
      '',
      '# PDF tools',
      '',
      'Split and merge PDFs.',
    ].join('\r\n');
    expect(parseSkillFile(`\uFEFF${file}`, 'SKILL.md')).toEqual({
      name: 'pdf-tools',
      content: 'Use when the owner asks about PDFs\n\n# PDF tools\n\nSplit and merge PDFs.',
    });
  });

  it('reads folded and literal block descriptions', () => {
    const folded = parseSkillFile(
      ['---', 'name: Notes', 'description: >-', '  Two lines', '  folded.', '---', 'Body'].join(
        '\n',
      ),
    );
    expect(folded.content).toBe('Two lines folded.\n\nBody');
    const literal = parseSkillFile(
      ['---', "name: 'It''s'", 'description: |', '  One', '  Two', '---', 'Body'].join('\n'),
    );
    expect(literal).toEqual({ name: "It's", content: 'One\nTwo\n\nBody' });
  });

  it('does not repeat a description the body already has', () => {
    const parsed = parseSkillFile('---\ndescription: Say hi\n---\nSay hi to everyone.');
    expect(parsed.content).toBe('Say hi to everyone.');
  });

  it('falls back to the file name, except for SKILL.md', () => {
    expect(parseSkillFile('Just markdown', 'weekly-report.md')).toEqual({
      name: 'weekly-report',
      content: 'Just markdown',
    });
    expect(parseSkillFile('Just markdown', 'SKILL.md').name).toBe('');
  });

  it('keeps unterminated frontmatter as content', () => {
    expect(parseSkillFile('---\nname: x\nno end', 'a.md').content).toBe('---\nname: x\nno end');
  });

  it('caps the name length', () => {
    expect(parseSkillFile(`---\nname: ${'a'.repeat(150)}\n---\n`).name).toHaveLength(100);
  });
});

describe('initialPicks', () => {
  it('picks importable Skills while the library has room', () => {
    const skill = (path: string, error: string | null = null) => ({
      path,
      name: path,
      suggestedName: `${path} 2`,
      description: '',
      error,
    });
    expect(
      initialPicks({ room: 1, skills: [skill('a', 'broken'), skill('b'), skill('c')] }),
    ).toEqual({
      a: { on: false, name: 'a 2' },
      b: { on: true, name: 'b 2' },
      c: { on: false, name: 'c 2' },
    });
  });
});

describe('availabilityText', () => {
  const bots = [
    { id: 'b1', name: 'Ada' },
    { id: 'b2', name: 'Bo' },
    { id: 'b3', name: 'Cy' },
  ];
  it('says where a Skill is on', () => {
    expect(availabilityText([], [])).toBe('No Bots hired yet');
    expect(availabilityText([], bots)).toBe('On for every Bot');
    expect(availabilityText(['b2'], bots)).toBe('Off for Bo');
    expect(availabilityText(['b1', 'b2'], bots)).toBe('Off for Ada and Bo');
    expect(availabilityText(['b1', 'b2', 'b3'], bots)).toBe('Turned off for every Bot');
  });
});
