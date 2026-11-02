import { z } from 'zod';
import { defineWidget, invalidAction, type InvalidAction } from './types.js';

// A generic form (plan 12.2, W1, W2): fields the Bot lays out and a Submit.
// Submit posts `{type: 'submit', values}`; the reducer checks the values
// against the fields and stores them, so a reload shows what was submitted,
// and the Bot's next run is told the values. A form is submitted once.

export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'email',
  'date',
  'select',
  'checkbox',
] as const;

export const FormFieldOptionSchema = z.strictObject({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
});

const FormValue = z.union([z.string().max(10_000), z.number(), z.boolean()]);

export const FormFieldSchema = z
  .strictObject({
    /** The key the value is submitted under. */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and underscores'),
    label: z.string().min(1).max(200),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().optional(),
    placeholder: z.string().max(200).optional(),
    /** The choices of a `select` field. */
    options: z.array(FormFieldOptionSchema).min(1).max(50).optional(),
    default: FormValue.optional(),
  })
  .refine((f) => f.type !== 'select' || f.options?.length, {
    message: 'A select field needs options',
    path: ['options'],
  });

export const FormPropsSchema = z
  .strictObject({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2_000).optional(),
    fields: z.array(FormFieldSchema).min(1).max(20),
    submit_label: z.string().min(1).max(40).optional(),
  })
  .refine((p) => new Set(p.fields.map((f) => f.name)).size === p.fields.length, {
    message: 'Field names must be unique',
    path: ['fields'],
  });

export type FormProps = z.infer<typeof FormPropsSchema>;
export type FormField = FormProps['fields'][number];
export type FormValues = Record<string, string | number | boolean>;

export const FormActionSchema = z.strictObject({
  type: z.literal('submit'),
  values: z.record(z.string(), FormValue),
});

export interface FormState {
  status: 'open' | 'submitted';
  /** The values as submitted; empty optional fields are left out. */
  values?: FormValues;
}

/** Checks submitted values against the fields: the stored values, or why they are refused. */
export function checkFormValues(fields: FormField[], values: FormValues): FormValues | string {
  const known = new Set(fields.map((f) => f.name));
  const unknown = Object.keys(values).find((name) => !known.has(name));
  if (unknown) return `Unknown field ${unknown}`;
  const checked: FormValues = {};
  for (const field of fields) {
    const value = values[field.name];
    const empty = value === undefined || (typeof value === 'string' && !value.trim());
    if (field.type === 'checkbox') {
      if (value !== undefined && typeof value !== 'boolean') return `${field.label}: not a yes/no`;
      if (field.required && value !== true) return `${field.label} is required`;
      checked[field.name] = value === true;
      continue;
    }
    if (empty) {
      if (field.required) return `${field.label} is required`;
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${field.label}: not a number`;
      }
    } else if (typeof value !== 'string') {
      return `${field.label}: not text`;
    } else if (field.type === 'select' && !field.options?.some((o) => o.value === value)) {
      return `${field.label}: not one of the options`;
    } else if (field.type === 'email' && !/^[^\s@]+@[^\s@]+$/.test(value.trim())) {
      return `${field.label}: not an email address`;
    } else if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `${field.label}: not a date`;
    }
    checked[field.name] =
      typeof value === 'string' && field.type !== 'textarea' ? value.trim() : value;
  }
  return checked;
}

export const formWidget = defineWidget({
  kind: 'form',
  description:
    'A form the owner fills in and submits once: {title?, description?, fields: [{name, label, ' +
    'type: text|textarea|number|email|date|select|checkbox, required?, placeholder?, ' +
    'options?: [{value, label}] for select, default?}], submit_label?}. The values come back to you',
  props: FormPropsSchema,
  action: FormActionSchema,
  botEmits: true,
  initialState: (): FormState => ({ status: 'open' }),
  reduce: (state: FormState | undefined, action, props): FormState | string | InvalidAction => {
    if (state?.status === 'submitted') return 'This form was already submitted';
    const values = checkFormValues(props.fields, action.values);
    return typeof values === 'string' ? invalidAction(values) : { status: 'submitted', values };
  },
  toolResult: (state: FormState) => ({ submitted: true, values: state.values ?? {} }),
});
