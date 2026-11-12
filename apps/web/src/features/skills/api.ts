import { unwrap, type components } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// The Skills library (S1 to S3): the owner's Skills with the Bots that use
// each, and which Skills a Bot has enabled. Every Skill change invalidates
// the `['skills']` prefix, which the composer's `/` picker reads too.

export type Skill = components['schemas']['Skill'];
export type CreateSkill = components['schemas']['CreateSkill'];
export type UpdateSkill = components['schemas']['UpdateSkill'];
/** Where an imported Skill came from; the generated component is nullable. */
export type SkillOrigin = NonNullable<Skill['origin']>;
export type SkillImportPreview = components['schemas']['SkillImportPreview'];
export type SkillImportRequest = components['schemas']['SkillImportRequest'];
export type SkillImportResult = components['schemas']['SkillImportResult'];

export const skillsQuery = queryOptions({
  queryKey: ['skills', 'list'],
  queryFn: () => unwrap(api.GET('/api/v1/skills')),
});

export const botSkillsQuery = (botId: string) =>
  queryOptions({
    queryKey: ['skills', 'bot', botId],
    queryFn: () => unwrap(api.GET('/api/v1/bots/{id}/skills', { params: { path: { id: botId } } })),
  });

export const createSkill = (body: CreateSkill) => unwrap(api.POST('/api/v1/skills', { body }));

export const updateSkill = (id: string, body: UpdateSkill) =>
  unwrap(api.PATCH('/api/v1/skills/{id}', { params: { path: { id } }, body }));

export const deleteSkill = (id: string) =>
  unwrap(api.DELETE('/api/v1/skills/{id}', { params: { path: { id } } }));

/** What a GitHub link holds (S3), read on the server. */
export const previewSkillImport = (url: string) =>
  unwrap(api.POST('/api/v1/skills/import/preview', { body: { url } }));

/** Imports the picked Skills, all or none. */
export const importSkills = (body: SkillImportRequest) =>
  unwrap(api.POST('/api/v1/skills/import', { body }));

/** Replaces the Bots that have the Skill enabled. */
export const putSkillBots = (skillId: string, botIds: string[]) =>
  unwrap(
    api.PUT('/api/v1/skills/{id}/bots', { params: { path: { id: skillId } }, body: { botIds } }),
  );

export const putBotSkills = (botId: string, skillIds: string[]) =>
  unwrap(
    api.PUT('/api/v1/bots/{id}/skills', { params: { path: { id: botId } }, body: { skillIds } }),
  );

/**
 * The Skills `/` offers in a chat (S2): enabled for one of the chat's Bots,
 * matching what is typed after `/` by name or slug.
 */
export function matchSkills<T extends Pick<Skill, 'name' | 'slug' | 'usedBy'>>(
  skills: readonly T[],
  query: string,
  botIds: readonly string[],
): T[] {
  const q = query.toLowerCase();
  return usableSkills(skills, botIds)
    .filter((s) => !q || s.slug.includes(q) || s.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The Skills enabled for any of `botIds`. */
export function usableSkills<T extends Pick<Skill, 'usedBy'>>(
  skills: readonly T[],
  botIds: readonly string[],
): T[] {
  return skills.filter((s) => s.usedBy.some((bot) => botIds.includes(bot.id)));
}
