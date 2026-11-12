import { createRoute, z } from '@hono/zod-openapi';
import { SKILL_CONTENT_MAX, SKILL_NAME_MAX } from '@openbots/shared';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  importSkillsFromGithub,
  IMPORT_LIMITS,
  previewSkillImport,
} from '../services/skill-import.js';
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  setSkillBlocks,
  skillOrigin,
  updateSkill,
  type SkillRecord,
} from '../services/skills.js';

// The Skills library (S1 to S3; plan 10.1, 14.1): one private library per
// account, each Skill a name and markdown content. Every Skill is on for all
// of the owner's Bots except those its blocklist turns it off for.
// Owner-scoped: another user's Skill or Bot is 404. Skills can also be
// imported from a GitHub link: a preview lists what the link holds, then the
// import adds the picked ones.

const SkillOriginSchema = z
  .object({
    kind: z.literal('github'),
    url: z.string().openapi({ description: 'The link the owner imported from' }),
    permalink: z.string().openapi({ description: "The Skill's file at the imported commit" }),
    repo: z.string().openapi({ description: 'owner/name' }),
    ref: z.string(),
    sha: z.string(),
    path: z.string(),
    license: z.string().nullable(),
    importedAt: z.iso.datetime(),
  })
  .openapi('SkillOrigin', { description: 'Where an imported Skill came from (S3)' });

const SkillSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    summary: z.string().openapi({ description: 'The first line of the content (the Bot index)' }),
    content: z.string().openapi({ description: 'The instructions a Bot follows, markdown' }),
    source: z.enum(['manual', 'saved_from_run', 'demonstration', 'imported']),
    createdFromRunId: z.uuid().nullable(),
    origin: SkillOriginSchema.nullable(),
    usedBy: z
      .array(z.object({ id: z.uuid(), name: z.string(), handle: z.string() }))
      .openapi({ description: "The owner's Bots it is on for: all but the blocked ones" }),
    blockedBotIds: z
      .array(z.uuid())
      .openapi({ description: "The owner's Bots it is turned off for" }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Skill');

const name = z.string().trim().min(1).max(SKILL_NAME_MAX);
const content = z.string().max(SKILL_CONTENT_MAX).openapi({ description: 'Markdown' });

const CreateSkillSchema = z
  .strictObject({ name, content: content.optional() })
  .openapi('CreateSkill');

const UpdateSkillSchema = z
  .strictObject({ name: name.optional(), content: content.optional() })
  .openapi('UpdateSkill');

const BlockedBotsSchema = z
  .strictObject({
    botIds: z
      .array(z.uuid())
      .max(500)
      .openapi({ description: 'The Bots the Skill is turned off for' }),
  })
  .openapi('SkillBlockedBots');

const githubUrl = z.string().trim().min(1).max(2000).openapi({
  description: 'A GitHub repository, folder (…/tree/ref/path) or file (…/blob/ref/path/SKILL.md)',
  example: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
});

const ImportPreviewRequestSchema = z
  .strictObject({ url: githubUrl })
  .openapi('SkillImportPreviewRequest');

const ImportPreviewSchema = z
  .object({
    source: z.object({
      url: z.string(),
      repo: z.string(),
      ref: z.string(),
      sha: z
        .string()
        .openapi({ description: 'The commit the ref resolved to; import at this one' }),
      path: z.string(),
    }),
    skills: z.array(
      z.object({
        path: z.string().openapi({ description: "The Skill's file in the repository" }),
        name: z.string(),
        suggestedName: z
          .string()
          .openapi({ description: 'The name, suffixed when the library already has it' }),
        description: z.string(),
        error: z.string().nullable().openapi({ description: 'Why it cannot be imported' }),
      }),
    ),
    more: z.boolean().openapi({
      description: `More than ${IMPORT_LIMITS.skillsFound} Skills were found; link a folder to see the rest`,
    }),
    authenticated: z
      .boolean()
      .openapi({ description: "Read with the owner's GitHub connector token" }),
    room: z.number().int().openapi({ description: 'Skills the library has room for' }),
    limit: z.number().int(),
  })
  .openapi('SkillImportPreview');

const ImportRequestSchema = z
  .strictObject({
    url: githubUrl,
    ref: z.string().min(1).max(255),
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    skills: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(1000),
          name: z.string().trim().max(SKILL_NAME_MAX).openapi({
            description: 'The name to give it; empty keeps the one in the file',
          }),
        }),
      )
      .min(1)
      .max(IMPORT_LIMITS.skillsFound),
  })
  .openapi('SkillImportRequest');

const ImportResultSchema = z
  .object({
    items: z.array(z.object({ skill: SkillSchema, path: z.string() })),
  })
  .openapi('SkillImportResult');

const githubProblems = {
  404: problemResponse(
    'No such repository, ref, folder or file, or it is private (`GITHUB_NOT_FOUND`)',
  ),
  429: problemResponse("GitHub's rate limit is used up; the message says when it resets"),
  502: problemResponse('GitHub refused the request or could not be reached'),
  504: problemResponse('GitHub took too long'),
};

function toSkill({ skill, usedBy, blockedBotIds }: SkillRecord): z.infer<typeof SkillSchema> {
  const origin = skillOrigin(skill.origin);
  return {
    id: skill.id,
    name: skill.name,
    slug: skill.slug,
    summary: skill.summary,
    content: skill.content,
    source: skill.source,
    createdFromRunId: skill.createdFromRunId,
    origin: origin && {
      kind: origin.kind,
      url: origin.url,
      permalink: origin.permalink,
      repo: origin.repo,
      ref: origin.ref,
      sha: origin.sha,
      path: origin.path,
      license: origin.license,
      importedAt: origin.importedAt,
    },
    usedBy,
    blockedBotIds,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

const idParams = z.object({ id: z.uuid() });
const skillResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: SkillSchema } },
});

export const skillRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/skills',
      tags: ['skills'],
      summary: 'The Skills library, most recently changed first',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Skills',
          content: { 'application/json': { schema: z.object({ items: z.array(SkillSchema) }) } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const records = await listSkills(c.var.deps.db, c.var.user);
      return c.json({ items: records.map(toSkill) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/skills',
      tags: ['skills'],
      summary: "Write a Skill, on for every one of the owner's Bots",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: { content: { 'application/json': { schema: CreateSkillSchema } }, required: true },
      },
      responses: {
        201: skillResponse('The Skill'),
        ...authProblems,
        400: problemResponse('Invalid'),
        409: problemResponse('The library is at its Skill limit (`SKILL_LIMIT_REACHED`)'),
      },
    }),
    async (c) => {
      const record = await createSkill(c.var.deps, c.var.user, c.req.valid('json'));
      return c.json(toSkill(record), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/skills/import/preview',
      tags: ['skills'],
      summary: 'List the Skills a GitHub link holds, before importing',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          content: { 'application/json': { schema: ImportPreviewRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: 'The Skills found',
          content: { 'application/json': { schema: ImportPreviewSchema } },
        },
        ...authProblems,
        400: problemResponse('Not a GitHub link, or not a markdown file'),
        413: problemResponse('The repository is too large to list'),
        ...githubProblems,
      },
    }),
    async (c) => {
      const preview = await previewSkillImport(c.var.deps, c.var.user, c.req.valid('json').url);
      return c.json(preview, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/skills/import',
      tags: ['skills'],
      summary: 'Import Skills from GitHub, all or none',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: { content: { 'application/json': { schema: ImportRequestSchema } }, required: true },
      },
      responses: {
        201: {
          description: 'The imported Skills',
          content: { 'application/json': { schema: ImportResultSchema } },
        },
        ...authProblems,
        400: problemResponse('Invalid, or a path that is not a Skill at that commit'),
        409: problemResponse('The Skills would pass the library limit (`SKILL_LIMIT_REACHED`)'),
        413: problemResponse('More files or bytes than an import reads'),
        ...githubProblems,
      },
    }),
    async (c) => {
      const items = await importSkillsFromGithub(c.var.deps, c.var.user, c.req.valid('json'));
      return c.json(
        {
          items: items.map((item) => ({ skill: toSkill(item.record), path: item.path })),
        },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/skills/{id}',
      tags: ['skills'],
      summary: 'A Skill',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParams },
      responses: {
        200: skillResponse('The Skill'),
        ...authProblems,
        404: problemResponse('No such Skill'),
      },
    }),
    async (c) => {
      const record = await getSkill(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json(toSkill(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/skills/{id}',
      tags: ['skills'],
      summary: 'Edit a Skill',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: idParams,
        body: { content: { 'application/json': { schema: UpdateSkillSchema } }, required: true },
      },
      responses: {
        200: skillResponse('The Skill'),
        ...authProblems,
        400: problemResponse('Invalid'),
        404: problemResponse('No such Skill'),
      },
    }),
    async (c) => {
      const record = await updateSkill(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(toSkill(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/skills/{id}',
      tags: ['skills'],
      summary: 'Delete a Skill; Bots that had it enabled lose it',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParams },
      responses: {
        204: { description: 'Deleted' },
        ...authProblems,
        404: problemResponse('No such Skill'),
      },
    }),
    async (c) => {
      await deleteSkill(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/skills/{id}/blocked-bots',
      tags: ['skills'],
      summary: 'Replace the Bots the Skill is turned off for; it stays on for every other Bot',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: idParams,
        body: { content: { 'application/json': { schema: BlockedBotsSchema } }, required: true },
      },
      responses: {
        200: skillResponse('The Skill'),
        ...authProblems,
        400: problemResponse('Invalid'),
        404: problemResponse('No such Skill or Bot'),
      },
    }),
    async (c) => {
      const record = await setSkillBlocks(
        c.var.deps.db,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json').botIds,
      );
      return c.json(toSkill(record), 200);
    },
  );
