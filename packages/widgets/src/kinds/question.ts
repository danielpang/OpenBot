import { z } from 'zod';
import { defineWidget, invalidAction, type InvalidAction } from './types.js';

// A question with options or free text (plan 12.2). `ask_user` posts it; the
// owner's answer resumes the waiting run with the answer as the tool result.

export const QuestionOptionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
});

export const QuestionPropsSchema = z.strictObject({
  question: z.string().min(1).max(2_000),
  /** Buttons; empty or absent means free text only. */
  options: z.array(QuestionOptionSchema).max(8).optional(),
  /** Whether a typed answer is accepted alongside the options. Defaults to true. */
  allow_text: z.boolean().optional(),
});

export const QuestionActionSchema = z
  .strictObject({
    type: z.literal('answer'),
    option_id: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(10_000).optional(),
  })
  .refine((a) => a.option_id !== undefined || a.text !== undefined, {
    message: 'An answer needs an option or text',
  });

export interface QuestionState {
  status: 'pending' | 'answered';
  answer?: { option_id?: string; label?: string; text?: string };
}

export const questionWidget = defineWidget({
  kind: 'question',
  description: 'A question with option buttons or a free-text answer',
  props: QuestionPropsSchema,
  action: QuestionActionSchema,
  botEmits: true,
  initialState: (): QuestionState => ({ status: 'pending' }),
  reduce: (
    state: QuestionState | undefined,
    action,
    props,
  ): QuestionState | string | InvalidAction => {
    if (state?.status === 'answered') return 'This question was already answered';
    const options = props.options ?? [];
    if (action.option_id !== undefined) {
      const option = options.find((o) => o.id === action.option_id);
      if (!option) return invalidAction(`Unknown option ${action.option_id}`);
      return {
        status: 'answered',
        answer: {
          option_id: option.id,
          label: option.label,
          ...(action.text ? { text: action.text } : {}),
        },
      };
    }
    if (props.allow_text === false && options.length) {
      return invalidAction('Pick one of the options');
    }
    return { status: 'answered', answer: { text: action.text! } };
  },
  toolResult: (state: QuestionState) => ({ answered: true, ...state.answer }),
});
