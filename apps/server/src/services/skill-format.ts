import { SKILL_NAME_MAX } from '@openbots/shared';
import { parse as parseYaml } from 'yaml';

// Reading a Skill file from elsewhere (S3): a SKILL.md in the Agent Skills
// format, with YAML frontmatter (`name`, `description`) and a markdown body,
// or any other markdown file. The name comes from the frontmatter (the
// import falls back to the folder or file name); the content is the body,
// after the description when the frontmatter has one, since it says when to
// use the Skill. The text is untrusted, so the frontmatter is found line by
// line and capped, and nothing here backtracks.

export interface ParsedSkillFile {
  /** From the frontmatter; empty when it names nothing. */
  name: string;
  description: string;
  /** The markdown without the frontmatter. */
  content: string;
  /** The frontmatter's `license`, when it has one. */
  license: string | null;
}

export class SkillFormatError extends Error {}

const FRONTMATTER_MAX = 64 * 1024;

/** Splits `---` YAML frontmatter from the body; null when the file has none. */
function frontmatter(text: string): { data: Record<string, unknown>; body: string } | null {
  const first = text.indexOf('\n');
  if (first < 0 || text.slice(0, first).trimEnd() !== '---') return null;
  let yaml: string | null = null;
  let body = '';
  for (let pos = first + 1; pos < text.length;) {
    const next = text.indexOf('\n', pos);
    const end = next < 0 ? text.length : next;
    const line = text.slice(pos, end).trimEnd();
    if (line === '---' || line === '...') {
      yaml = text.slice(first + 1, pos);
      body = next < 0 ? '' : text.slice(next + 1);
      break;
    }
    pos = end + 1;
  }
  if (yaml === null) return null;
  if (yaml.length > FRONTMATTER_MAX) {
    throw new SkillFormatError(`The frontmatter is longer than ${FRONTMATTER_MAX / 1024} KB`);
  }
  let data: unknown;
  try {
    data = parseYaml(yaml, { maxAliasCount: 50 });
  } catch (error) {
    throw new SkillFormatError(
      `The frontmatter is not valid YAML: ${(error as Error).message.split('\n')[0]}`,
    );
  }
  if (data !== null && data !== undefined && (typeof data !== 'object' || Array.isArray(data))) {
    throw new SkillFormatError('The frontmatter is not a set of fields');
  }
  return { data: (data ?? {}) as Record<string, unknown>, body };
}

const field = (data: Record<string, unknown>, name: string) => {
  const value = data[name];
  return typeof value === 'string' ? value.trim() : '';
};

/** Reads a Skill file; throws `SkillFormatError` for unreadable frontmatter. */
export function parseSkillFile(source: string): ParsedSkillFile {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const front = frontmatter(text);
  const data = front?.data ?? {};
  const body = (front ? front.body : text).trim();
  const description = field(data, 'description');
  return {
    name: field(data, 'name').replace(/\s+/g, ' ').trim().slice(0, SKILL_NAME_MAX).trim(),
    description,
    content: description && !body.includes(description) ? `${description}\n\n${body}`.trim() : body,
    license: field(data, 'license') || null,
  };
}
