import { describe, expect, it } from 'vitest';
import { validateWidgetAction, validateWidgetProps } from '../index.js';

const props = {
  title: 'Signups',
  type: 'bar',
  labels: ['Mon', 'Tue', 'Wed'],
  series: [
    { name: 'Web', values: [4, 7, 5] },
    { name: 'Mobile', values: [2, 3, 6] },
  ],
};

describe('chart widget', () => {
  it('validates bars and lines with one value per label per series', () => {
    expect(validateWidgetProps('chart', props).ok).toBe(true);
    expect(validateWidgetProps('chart', { ...props, type: 'line', unit: '%' }).ok).toBe(true);
    expect(validateWidgetProps('chart', { ...props, type: 'pie' }).ok).toBe(false);
    expect(
      validateWidgetProps('chart', { ...props, series: [{ name: 'Web', values: [1, 2] }] }),
    ).toEqual({ ok: false, error: 'series: Every series needs one value per label' });
    expect(validateWidgetProps('chart', { ...props, series: [] }).ok).toBe(false);
    expect(
      validateWidgetProps('chart', {
        ...props,
        series: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, values: [1, 2, 3] })),
      }).ok,
    ).toBe(false);
    expect(
      validateWidgetProps('chart', { ...props, series: [{ name: 'Web', values: [1, NaN, 3] }] }).ok,
    ).toBe(false);
  });

  it('is read only', () => {
    expect(validateWidgetAction('chart', { type: 'download' }).ok).toBe(false);
  });
});
