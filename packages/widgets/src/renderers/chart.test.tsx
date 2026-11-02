// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { chartTable, niceTicks } from './chart.js';
import { Widget } from './registry.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(ui));
  return host;
}

const props = {
  title: 'Signups',
  type: 'bar' as const,
  labels: ['Mon', 'Tue', 'Wed'],
  series: [
    { name: 'Web', values: [4, 7, 5] },
    { name: 'Mobile', values: [2, 3, 6] },
  ],
  unit: ' users',
};

describe('chart widget', () => {
  it('draws one bar per value with a legend, axis ticks and labels', () => {
    const host = render(<Widget kind="chart" props={props} />);
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Signups: bar chart of Web, Mobile');
    expect(host.querySelectorAll('[data-series="Web"] path')).toHaveLength(3);
    expect(host.querySelectorAll('[data-series="Mobile"] path')).toHaveLength(3);
    expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Web', 'Mobile']);
    const text = [...svg.querySelectorAll('text')].map((t) => t.textContent);
    expect(text).toEqual(['0', '2', '4', '6', '8', 'Mon', 'Tue', 'Wed']);
  });

  it('shows the values at a label on hover', () => {
    const host = render(<Widget kind="chart" props={props} />);
    const hit = host.querySelector('[data-hit="1"]')!;
    expect(hit.querySelector('title')!.textContent).toBe('Tue: Web 7 users, Mobile 3 users');
    act(() => {
      hit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
    });
    const tooltip = host.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toBe('TueWeb7 usersMobile3 users');
    act(() => {
      hit.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('draws a line per series, without a legend for one', () => {
    const host = render(
      <Widget
        kind="chart"
        props={{ ...props, type: 'line', series: [{ name: 'Web', values: [40, 70, 55] }] }}
      />,
    );
    expect(host.querySelector('figure')!.dataset.chart).toBe('line');
    expect(host.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3);
    expect(host.querySelectorAll('circle')).toHaveLength(3);
    expect(host.querySelector('ul')).toBeNull();
  });

  it('carries its data as a table and a CSV', () => {
    const host = render(<Widget kind="chart" props={{ ...props, x_label: 'Day' }} />);
    const rows = [...host.querySelectorAll('details tbody tr')].map((tr) => tr.textContent);
    expect(rows).toEqual(['Mon42', 'Tue73', 'Wed56']);
    const link = host.querySelector('a[download]')!;
    expect(link.getAttribute('download')).toBe('signups.csv');
    expect(decodeURIComponent(link.getAttribute('href')!)).toBe(
      'data:text/csv;charset=utf-8,Day,Web,Mobile\r\nMon,4,2\r\nTue,7,3\r\nWed,5,6',
    );
    expect(chartTable(props).columns.map((c) => c.label)).toEqual(['Label', 'Web', 'Mobile']);
  });

  it('picks round ticks', () => {
    expect(niceTicks(0, 37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(-3, 7)).toEqual([-5, -2.5, 0, 2.5, 5, 7.5]);
    expect(niceTicks(0, 0)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(niceTicks(5, 5)).toEqual([0, 2, 4, 6]);
    expect(niceTicks(0.1, 0.35)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(-12, -3)).toEqual([-12.5, -10, -7.5, -5, -2.5]);
  });
});
