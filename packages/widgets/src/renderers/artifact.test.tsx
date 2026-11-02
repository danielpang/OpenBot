// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactCard } from './artifact.js';
import { Widget } from './registry.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(ui: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}

const card = { artifact_id: 'a1', title: 'Q3 summary', kind: 'document', version: 1 } as const;
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('<ArtifactCard>', () => {
  it('shows the title, kind icon and version, with Open and Download', () => {
    const onOpen = vi.fn();
    render(<ArtifactCard artifact={card} onOpen={onOpen} />);
    expect(host.textContent).toContain('Q3 summary');
    expect(host.textContent).toContain('Document · v1');
    expect(host.querySelector('svg[data-kind="document"]')).not.toBeNull();
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe(
      '/api/v1/artifacts/a1/download?version=1',
    );
    act(() => button('Open')!.click());
    expect(onOpen).toHaveBeenCalledWith('a1', 1);
  });

  it('follows a newer version and title from the live state', () => {
    const onOpen = vi.fn();
    render(
      <ArtifactCard artifact={card} live={{ version: 3, title: 'Q3 report' }} onOpen={onOpen} />,
    );
    expect(host.textContent).toContain('Q3 report');
    expect(host.textContent).toContain('v3');
    expect(host.querySelector('a[download]')?.getAttribute('href')).toContain('version=3');
    act(() => button('Open')!.click());
    expect(onOpen).toHaveBeenCalledWith('a1', 3);
  });

  it('never goes back to an older version than the card was posted with', () => {
    render(<ArtifactCard artifact={{ ...card, version: 4 }} live={{ version: 2 }} />);
    expect(host.textContent).toContain('v4');
  });

  it('has no Open where there is no viewer, and renders through the registry', () => {
    render(<Widget kind="artifact" props={card} />);
    expect(button('Open')).toBeUndefined();
    expect(host.textContent).toContain('Download');
    const onOpenArtifact = vi.fn();
    act(() =>
      root!.render(<Widget kind="artifact" props={card} onOpenArtifact={onOpenArtifact} />),
    );
    act(() => button('Open')!.click());
    expect(onOpenArtifact).toHaveBeenCalledWith('a1', 1);
  });
});
