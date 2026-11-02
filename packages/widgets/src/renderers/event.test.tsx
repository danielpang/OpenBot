// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { EventRow } from './event.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(ui));
  return host;
}

describe('event rows', () => {
  it('turns an app path into a link that opens inside the app', () => {
    const onLink = vi.fn();
    const host = render(
      <EventRow
        kind="blocked"
        text="GitHub connector needs login. Sign in again on the Connectors page."
        fix="Sign in again on the Connectors page."
        link="/connectors?connector=c1"
        onLink={onLink}
      />,
    );
    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/connectors?connector=c1');
    expect(link.textContent).toBe('Open Connectors');
    act(() => link.click());
    expect(onLink).toHaveBeenCalledWith('/connectors?connector=c1');
  });

  it('names a Settings link', () => {
    const host = render(
      <EventRow
        kind="reply_undecided"
        text="The Bots couldn't decide who should reply. Check the small model in Settings > Models."
        link="/settings/models"
      />,
    );
    expect(host.querySelector('a')!.textContent).toBe('Open Settings');
  });

  it('ignores links that leave the app', () => {
    for (const link of ['javascript:alert(1)', 'https://evil.example', '//evil.example']) {
      const host = render(<EventRow kind="blocked" text="x" link={link} />);
      expect(host.querySelector('a')).toBeNull();
    }
  });
});
