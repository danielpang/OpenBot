import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AvatarEditor } from './editor.js';
import { AVATAR_ACCESSORIES, AVATAR_EYES, AVATAR_PALETTES, BOT_SHAPES } from './parts.js';

describe('<AvatarEditor>', () => {
  it('offers shuffle, upload, a six-state preview and a picker per part', () => {
    const html = renderToStaticMarkup(
      <AvatarEditor value={{ kind: 'generated', seed: 'ada' }} onChange={() => {}} />,
    );
    expect(html).toContain('Shuffle');
    expect(html).toContain('Upload image');
    expect(html).toContain('type="file"');
    // Raster images only: the server refuses SVG and anything else as an avatar.
    expect(html).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    for (const state of ['idle', 'thinking', 'working', 'waiting', 'blocked', 'done']) {
      expect(html).toContain(`data-state="${state}"`);
    }
    const pickers =
      BOT_SHAPES.length + AVATAR_PALETTES.length + AVATAR_EYES.length + AVATAR_ACCESSORIES.length;
    expect(html.match(/aria-pressed=/g)).toHaveLength(pickers);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(4);
  });

  it('offers the three Bot shapes, Moon, Box and Egg, and no others', () => {
    const html = renderToStaticMarkup(
      <AvatarEditor
        value={{ kind: 'generated', seed: 'ada', shape: 'blob' }}
        onChange={() => {}}
      />,
    );
    for (const label of ['Moon', 'Box', 'Egg']) expect(html).toContain(`title="${label}"`);
    expect(html).toMatch(/aria-pressed="true" title="Egg"/);
    expect(html).not.toContain('title="circle"');
    expect(html).not.toContain('title="ghost"');
  });

  it('offers a way back from an uploaded image', () => {
    const html = renderToStaticMarkup(
      <AvatarEditor
        value={{ kind: 'upload', file_id: '00000000-0000-4000-8000-000000000001' }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('Use a generated avatar');
    expect(html).not.toContain('aria-pressed');
  });
});
