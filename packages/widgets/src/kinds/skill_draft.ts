import { SKILL_NAME_MAX, SkillContentSchema } from '@openbots/shared';
import { z } from 'zod';
import { defineWidget } from './types.js';

// A Skill draft (plan 10.1, 12.2; S3): the name and content a Bot drafted
// with `save_skill` from a finished run, already in the library. The owner
// edits them and saves; the server writes the action through to the `skills`
// row the widget names. Once saved the widget closes and later edits happen
// in the Skills library.

export const SkillDraftPropsSchema = z.strictObject({
  skill_id: z.string().min(1),
  name: z.string().min(1).max(SKILL_NAME_MAX),
  content: SkillContentSchema,
});

export type SkillDraftProps = z.infer<typeof SkillDraftPropsSchema>;

/** Omitted fields keep the current ones. */
export const SkillDraftActionSchema = z.strictObject({
  type: z.literal('save'),
  name: z.string().trim().min(1).max(SKILL_NAME_MAX).optional(),
  content: SkillContentSchema.optional(),
});

export type SkillDraftAction = z.infer<typeof SkillDraftActionSchema>;

export interface SkillDraftState {
  status: 'draft' | 'saved';
  /** The Skill as saved from the widget. */
  name?: string;
  content?: string;
}

export const skillDraftWidget = defineWidget({
  kind: 'skill_draft',
  description: 'A drafted Skill the owner edits and saves',
  props: SkillDraftPropsSchema,
  action: SkillDraftActionSchema,
  // Posted by save_skill, which stores the Skill first.
  botEmits: false,
  initialState: (): SkillDraftState => ({ status: 'draft' }),
  reduce: (state: SkillDraftState | undefined, action, props): SkillDraftState | string => {
    if (state && state.status !== 'draft') {
      return 'This Skill is already saved; edit it in the Skills library';
    }
    return {
      status: 'saved',
      name: action.name ?? props.name,
      content: action.content ?? props.content,
    };
  },
});
