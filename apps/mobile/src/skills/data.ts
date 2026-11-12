import { unwrap, type Client, type components } from '@openbots/api-client';
import { SKILL_NAME_MAX } from '@openbots/shared';
import { queryOptions } from '@tanstack/react-query';

// The Skills library on iOS: the same endpoints and cache keys as the web app.
// Every Skill change invalidates the `['skills']` prefix, which covers the
// library, its "used by" lists and each Skill's blocked Bots.

export type Skill = components['schemas']['Skill'];
export type SkillOrigin = NonNullable<Skill['origin']>;
export type SkillImportPreview = components['schemas']['SkillImportPreview'];

export const SKILLS_KEY = ['skills'] as const;

export const skillsQuery = (api: Client) =>
  queryOptions({
    queryKey: ['skills', 'list'] as const,
    queryFn: () => unwrap(api.GET('/api/v1/skills')),
  });

/** "Used by Ada and Scout", or that it is turned off for every Bot. */
export function usedByText(bots: readonly { name: string }[]): string {
  if (!bots.length) return 'Turned off for every Bot';
  const names = bots.map((b) => b.name);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Used by ${list}`;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type Picked = Record<string, { on: boolean; name: string }>;

/** The picks a GitHub preview starts with: every importable Skill, as far as the library has room. */
export function initialPicks(preview: Pick<SkillImportPreview, 'room' | 'skills'>): Picked {
  let room = preview.room;
  return Object.fromEntries(
    preview.skills.map((s) => {
      const on = !s.error && room > 0;
      if (on) room--;
      return [s.path, { on, name: s.suggestedName }];
    }),
  );
}

// --- Skill files from the device --------------------------------------------------

export interface SkillFile {
  /** From the frontmatter, else the file name; empty when neither names it. */
  name: string;
  /** The markdown without the frontmatter, after the description when there is one. */
  content: string;
}

const MARKDOWN = /\.(md|markdown|mdx|txt)$/i;
const FRONTMATTER_MAX = 64 * 1024;

/** A YAML scalar's text: quotes removed, `''` and `\"` unescaped. Good enough for names. */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\(["\\])/g, '$1');
  return value.replace(/\s+#.*$/, '');
}

/**
 * The top-level string fields of `---` frontmatter, read line by line: plain,
 * quoted and block (`|`, `>`) values. Anything else is skipped; the owner
 * reviews the result in the editor before it is saved.
 */
function frontmatter(text: string): { fields: Record<string, string>; body: string } | null {
  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return null;
  const yaml = lines.slice(1, end);
  if (yaml.join('\n').length > FRONTMATTER_MAX) return null;
  const fields: Record<string, string> = {};
  for (let i = 0; i < yaml.length; i++) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s?(.*)$/.exec(yaml[i]!);
    if (!match) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    const block = /^([|>])[-+]?\s*$/.exec(rest.trim());
    if (block) {
      const collected: string[] = [];
      while (i + 1 < yaml.length && (/^\s+\S/.test(yaml[i + 1]!) || !yaml[i + 1]!.trim())) {
        collected.push(yaml[++i]!.trim());
      }
      fields[key] =
        block[1] === '|'
          ? collected.join('\n').trim()
          : collected.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    let value = rest;
    // A plain scalar may continue on more-indented lines.
    while (i + 1 < yaml.length && /^\s+\S/.test(yaml[i + 1]!) && !/^\s*-\s/.test(yaml[i + 1]!)) {
      value += ` ${yaml[++i]!.trim()}`;
    }
    fields[key] = scalar(value);
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

/**
 * Reads a SKILL.md in the Agent Skills format (frontmatter `name` and
 * `description`, then markdown) or any other markdown file, the way the
 * server's GitHub import does: the name from the frontmatter, else the
 * folder (for a SKILL.md) or the file name.
 */
export function parseSkillFile(source: string, fileName = ''): SkillFile {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const front = frontmatter(text);
  const fields = front?.fields ?? {};
  const body = (front ? front.body : text).trim();
  const description = (fields.description ?? '').trim();
  const fromFile = /^skill\.md$/i.test(fileName) ? '' : fileName.replace(MARKDOWN, '');
  const name = (fields.name || fromFile).replace(/\s+/g, ' ').trim().slice(0, SKILL_NAME_MAX);
  return {
    name: name.trim(),
    content: description && !body.includes(description) ? `${description}\n\n${body}`.trim() : body,
  };
}
