import { describe, expect, it } from 'vitest';
import { validateWidgetAction, validateWidgetProps } from '../index.js';

const props = {
  title: 'Open PRs',
  columns: [
    { key: 'title', label: 'Title' },
    { key: 'age', label: 'Age (days)', type: 'number' },
  ],
  rows: [
    { title: 'Fix login', age: 3 },
    { title: 'Docs', age: null },
  ],
};

describe('table widget', () => {
  it('validates columns and rows', () => {
    expect(validateWidgetProps('table', props).ok).toBe(true);
    expect(validateWidgetProps('table', { ...props, rows: [] }).ok).toBe(true);
    expect(validateWidgetProps('table', { ...props, columns: [] }).ok).toBe(false);
    expect(
      validateWidgetProps('table', { ...props, columns: [props.columns[0], props.columns[0]] }),
    ).toEqual({ ok: false, error: 'columns: Column keys must be unique' });
    expect(validateWidgetProps('table', { ...props, rows: [{ title: { nested: 1 } }] }).ok).toBe(
      false,
    );
    expect(
      validateWidgetProps('table', { ...props, rows: Array.from({ length: 501 }, () => ({})) }).ok,
    ).toBe(false);
  });

  it('is read only', () => {
    expect(validateWidgetAction('table', { type: 'sort' })).toEqual({
      ok: false,
      error: 'A table widget takes no actions',
    });
  });
});
