import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Avatar } from './avatar.js';
import { AVATAR_CSS, AVATAR_STATES } from './states.js';

// One avatar (bean, rose, pill eyes, hat) in every state.
const params = { kind: 'generated', seed: 'ada' } as const;

/** The avatar's frame, without the hoisted stylesheet. */
const frame = (html: string) => html.slice(html.indexOf('<span'));

describe('<Avatar>', () => {
  it.each(AVATAR_STATES)('renders the %s state', (state) => {
    expect(
      frame(renderToStaticMarkup(<Avatar params={params} state={state} size={24} />)),
    ).toMatchSnapshot();
  });

  it('ships keyframes for each moving state', () => {
    for (const state of ['idle', 'thinking', 'working', 'waiting', 'done']) {
      expect(AVATAR_CSS).toMatch(new RegExp(`data-state=${state}\\] [^{]+\\{animation:`));
    }
    expect(AVATAR_CSS).not.toMatch(/data-state=blocked\][^{]*\{animation:/);
    expect(AVATAR_CSS).toContain('ob-settle .9s ease-out 1 both');
  });

  it('renders without motion under reduced motion, keeping a colour cue', () => {
    const html = renderToStaticMarkup(
      <Avatar params={params} state="working" reducedMotion label="Ada" />,
    );
    expect(html).toContain('data-motion="reduced"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ada"');
    expect(AVATAR_CSS).toContain(
      '.ob-avatar[data-motion=reduced],.ob-avatar[data-motion=reduced] *{animation:none!important;transition:none!important}',
    );
    expect(AVATAR_CSS).toContain(
      '.ob-avatar[data-motion=reduced]:not([data-state=idle]){box-shadow:0 0 0 2px var(--ob-ring)}',
    );
    expect(AVATAR_CSS).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{\n\.ob-avatar,\.ob-avatar \*\{animation:none!important/,
    );
    expect(AVATAR_CSS).toContain('.ob-avatar[data-state=working]{--ob-ring:#3B82F6}');
  });

  it('renders an uploaded image in the same frame with a state ring', () => {
    const html = frame(
      renderToStaticMarkup(
        <Avatar
          params={{ kind: 'upload', file_id: '00000000-0000-4000-8000-000000000001' }}
          state="waiting"
          size={24}
        />,
      ),
    );
    expect(html).toContain('class="ob-avatar"');
    expect(html).toContain('data-kind="upload"');
    expect(html).toContain('src="/api/v1/files/00000000-0000-4000-8000-000000000001"');
    expect(AVATAR_CSS).toContain(
      '.ob-avatar[data-kind=upload]{box-shadow:0 0 0 2px var(--ob-ring)}',
    );
  });

  it('ships the stylesheet once for any number of avatars', () => {
    const html = renderToStaticMarkup(
      <div>
        <Avatar params={params} />
        <Avatar params={{ seed: 'grace' }} />
      </div>,
    );
    expect(html.split('@keyframes ob-breathe').length - 1).toBe(1);
  });
});
