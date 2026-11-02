import { z } from 'zod';

// Skills (plan 4.6, 10.1; S1 to S3). A Skill is a name and free-form
// markdown content: the instructions a Bot follows. The server, the
// `skill_draft` widget and the web editor share these limits and helpers.

export const SKILL_NAME_MAX = 100;
export const SKILL_CONTENT_MAX = 100_000;

export const SkillContentSchema = z.string().max(SKILL_CONTENT_MAX);

export const SkillSourceSchema = z.enum(['manual', 'saved_from_run', 'demonstration', 'imported']);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s*#/;
/** Leading quote and list markers (`>`, `-`, `+`, `* `), each a single pass, so linear. */
const MARKERS = /^[\s>+-]+/;
const STAR_ITEM = /^\*\s+/;

/**
 * The one line the Skills index and the library show: the content's first
 * line of text that is not a heading or code, without quote or list markers.
 */
export function skillSummary(content: string, max = 300): string {
  let fenced = false;
  for (const raw of content.split('\n')) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || HEADING.test(raw)) continue;
    const line = raw
      .slice(0, max * 4)
      .replace(MARKERS, '')
      .replace(STAR_ITEM, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return '';
}

/** A lowercase slug for a Skill name, unique per owner once suffixed. */
export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return slug || 'skill';
}
