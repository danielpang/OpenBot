// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('<Markdown>', () => {
  it('renders prose and links safely, then highlights fenced code with shiki', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const text = [
      'See https://example.com and <b>raw</b> `inline`.',
      '',
      '```ts',
      'const answer: number = 42;',
      '```',
      '',
      '```klingon',
      'Qapla!',
      '```',
    ].join('\n');
    act(() => root.render(<Markdown text={text} />));

    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelector('code')!.textContent).toBe('inline');
    expect(host.querySelectorAll('pre')).toHaveLength(2);

    // One act per wait: React commits the highlighted block when an act
    // ends, so polling inside a single act never sees it.
    for (let i = 0; i < 200 && !host.querySelector('.shiki'); i++) {
      await act(() => new Promise((r) => setTimeout(r, 50)));
    }
    const highlighted = host.querySelector('.shiki-frame .shiki')!;
    expect(highlighted.textContent).toBe('const answer: number = 42;');
    expect(highlighted.querySelectorAll('span[style]').length).toBeGreaterThan(1);
    expect(host.querySelector('pre[data-lang="klingon"]')!.textContent).toBe('Qapla!');
    act(() => root.unmount());
  }, 15_000);
});
