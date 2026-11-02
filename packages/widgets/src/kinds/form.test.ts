import { describe, expect, it } from 'vitest';
import {
  reduceWidget,
  validateWidgetAction,
  validateWidgetProps,
  widgetToolResult,
} from '../index.js';
import { FormPropsSchema } from './form.js';

const props = {
  title: 'Trip details',
  fields: [
    { name: 'city', label: 'City', type: 'text', required: true },
    { name: 'nights', label: 'Nights', type: 'number' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'date', label: 'Arrival', type: 'date' },
    {
      name: 'room',
      label: 'Room',
      type: 'select',
      options: [
        { value: 'single', label: 'Single' },
        { value: 'double', label: 'Double' },
      ],
    },
    { name: 'notes', label: 'Notes', type: 'textarea' },
    { name: 'breakfast', label: 'Breakfast', type: 'checkbox' },
  ],
} as const;

const submit = (values: Record<string, unknown>, state?: unknown) =>
  reduceWidget('form', state, { type: 'submit', values }, FormPropsSchema.parse(props));

const invalid = (error: string) => ({ ok: false, error, invalid: true });

describe('form widget', () => {
  it('validates its fields', () => {
    expect(validateWidgetProps('form', props).ok).toBe(true);
    expect(validateWidgetProps('form', { fields: [] }).ok).toBe(false);
    expect(
      validateWidgetProps('form', { fields: [{ name: 'a', label: 'A', type: 'select' }] }),
    ).toEqual({ ok: false, error: 'fields.0.options: A select field needs options' });
    expect(
      validateWidgetProps('form', {
        fields: [
          { name: 'a', label: 'A', type: 'text' },
          { name: 'a', label: 'Again', type: 'text' },
        ],
      }),
    ).toEqual({ ok: false, error: 'fields: Field names must be unique' });
    expect(
      validateWidgetProps('form', { fields: [{ name: 'a b', label: 'A', type: 'text' }] }).ok,
    ).toBe(false);
    expect(
      validateWidgetProps('form', { fields: [{ name: 'a', label: 'A', type: 'color' }] }).ok,
    ).toBe(false);
  });

  it('takes a submit with values only', () => {
    expect(validateWidgetAction('form', { type: 'submit', values: { city: 'Oslo' } }).ok).toBe(
      true,
    );
    expect(validateWidgetAction('form', { type: 'submit' }).ok).toBe(false);
    expect(validateWidgetAction('form', { type: 'submit', values: { a: [1] } }).ok).toBe(false);
    expect(validateWidgetAction('form', { type: 'answer', text: 'x' }).ok).toBe(false);
  });

  it('stores checked values, trimmed, with empty optional fields left out', () => {
    const next = submit({
      city: ' Oslo ',
      nights: 3,
      email: '',
      room: 'double',
      notes: ' early check-in\n',
      breakfast: true,
    });
    expect(next).toEqual({
      ok: true,
      value: {
        status: 'submitted',
        values: {
          city: 'Oslo',
          nights: 3,
          room: 'double',
          notes: ' early check-in\n',
          breakfast: true,
        },
      },
    });
    expect(widgetToolResult('form', (next as { value: unknown }).value)).toEqual({
      submitted: true,
      values: {
        city: 'Oslo',
        nights: 3,
        room: 'double',
        notes: ' early check-in\n',
        breakfast: true,
      },
    });
    expect(submit({ city: 'Oslo' })).toMatchObject({
      ok: true,
      value: { values: { city: 'Oslo', breakfast: false } },
    });
  });

  it('refuses values that do not fit the fields', () => {
    expect(submit({})).toEqual(invalid('City is required'));
    expect(submit({ city: '   ' })).toEqual(invalid('City is required'));
    expect(submit({ city: 'Oslo', nights: '3' })).toEqual(invalid('Nights: not a number'));
    expect(submit({ city: 'Oslo', room: 'suite' })).toEqual(
      invalid('Room: not one of the options'),
    );
    expect(submit({ city: 'Oslo', email: 'nope' })).toEqual(invalid('Email: not an email address'));
    expect(submit({ city: 'Oslo', date: 'tomorrow' })).toEqual(invalid('Arrival: not a date'));
    expect(submit({ city: 'Oslo', breakfast: 'yes' })).toEqual(invalid('Breakfast: not a yes/no'));
    expect(submit({ city: 'Oslo', admin: true })).toEqual(invalid('Unknown field admin'));
  });

  it('is submitted once', () => {
    expect(submit({ city: 'Oslo' }, { status: 'submitted', values: { city: 'Rome' } })).toEqual({
      ok: false,
      error: 'This form was already submitted',
    });
  });
});
