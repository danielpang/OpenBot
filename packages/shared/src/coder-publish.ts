import { z } from 'zod';

/** Agent-facing tool and the private, session-socket operation it invokes. */
export const CODER_PUBLISH_TOOL = 'publish_pull_request';
export const CODER_PUBLISH_OPERATION = 'openbots.publish_pull_request';

export const CoderPublishInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000),
  draft: z.boolean().optional(),
});
export type CoderPublishInput = z.infer<typeof CoderPublishInputSchema>;
export const CoderPublishResultSchema = z.strictObject({
  branch: z.string().min(1),
  prUrl: z.url(),
});
export type CoderPublishResult = z.infer<typeof CoderPublishResultSchema>;

/** JSON Schema also accepted by the coding agents' native tool registries. */
export const CODER_PUBLISH_PARAMETERS = {
  type: 'object' as const,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', maxLength: 20_000 },
    draft: { type: 'boolean' },
  },
  required: ['title', 'body'],
  additionalProperties: false,
};
export const CODER_PUBLISH_DESCRIPTION =
  'Push the current OpenBots coding-session branch and create its pull request through the trusted runner. Call automatically after committing and verifying changes. OpenBots handles approvals and credentials. Returns the branch and PR URL. Never use git push, gh pr create, or another PR tool instead. Not available in plan mode.';
