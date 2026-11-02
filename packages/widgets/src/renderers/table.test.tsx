// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { Widget } from './registry.js';
import { csvName, toCsv } from './table.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(ui));
  return host;
}

const props = {
  title: 'Open PRs',
  columns: [
    { key: 'title', label: 'Title' },
    { key: 'age', label: 'Age', type: 'number' as const },
    { key: 'draft', label: 'Draft' },
  ],
  rows: [
    { title: 'Fix login', age: 12, draft: false },
    { title: 'Docs', age: null, draft: true },
    { title: 'Add charts', age: 3, draft: false },
  ],
  caption: 'From GitHub',
};

describe('table widget', () => {
  it('shows the rows and sorts by a column, empty cells last', () => {
    const host = render(<Widget kind="table" props={props} />);
    const column = (i: number) =>
      [...host.querySelectorAll('tbody tr')].map((tr) => tr.children[i]!.textContent);
    const header = (label: string) =>
      [...host.querySelectorAll('th')].find((th) => th.textContent!.startsWith(label))!;
    expect(host.querySelector('h3')!.textContent).toBe('Open PRs');
    expect(host.textContent).toContain('3 rows');
    expect(column(0)).toEqual(['Fix login', 'Docs', 'Add charts']);
    expect(column(2)).toEqual(['No', 'Yes', 'No']);

    act(() => header('Age').querySelector('button')!.click());
    expect(header('Age').getAttribute('aria-sort')).toBe('ascending');
    expect(column(1)).toEqual(['3', '12', '']);
    act(() => header('Age').querySelector('button')!.click());
    expect(header('Age').getAttribute('aria-sort')).toBe('descending');
    expect(column(1)).toEqual(['12', '3', '']);
    act(() => header('Title').querySelector('button')!.click());
    expect(header('Age').getAttribute('aria-sort')).toBe('none');
    expect(column(0)).toEqual(['Add charts', 'Docs', 'Fix login']);
  });

  it('downloads the rows as CSV', () => {
    const host = render(<Widget kind="table" props={props} />);
    const link = host.querySelector('a[download]')!;
    expect(link.getAttribute('download')).toBe('open-prs.csv');
    expect(decodeURIComponent(link.getAttribute('href')!)).toBe(
      'data:text/csv;charset=utf-8,Title,Age,Draft\r\nFix login,12,false\r\nDocs,,true\r\n' +
        'Add charts,3,false',
    );
  });

  it('quotes CSV cells and defuses formulas', () => {
    expect(
      toCsv(
        [
          { key: 'a', label: 'A, B' },
          { key: 'b', label: 'B' },
        ],
        [
          { a: 'say "hi"', b: '=HYPERLINK("x")' },
          { a: -4, b: 'line\nbreak' },
        ],
      ),
    ).toBe('"A, B",B\r\n"say ""hi""","\'=HYPERLINK(""x"")"\r\n-4,"line\nbreak"');
    expect(csvName(undefined, 'table')).toBe('table.csv');
    expect(csvName('Q3: revenue!', 'table')).toBe('q3-revenue.csv');
  });

  it('says so when there are no rows', () => {
    const host = render(<Widget kind="table" props={{ ...props, rows: [] }} />);
    expect(host.textContent).toContain('No rows.');
    expect(host.querySelector('a[download]')).toBeNull();
  });
});
