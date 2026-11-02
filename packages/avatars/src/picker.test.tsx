import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AvatarPicker, ShapePicker } from './picker.js';

describe('<AvatarPicker>', () => {
  it('shows the icon, the three shapes with the chosen one pressed, and Shuffle', () => {
    const html = renderToStaticMarkup(
      <AvatarPicker
        value={{ kind: 'generated', seed: 'ada', shape: 'rounded' }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Icon preview"');
    expect(html).toContain('Shuffle');
    expect(html.match(/aria-pressed=/g)).toHaveLength(3);
    expect(html).toMatch(/aria-pressed="true" title="Box"/);
  });

  it('presses the shape the seed draws when none is pinned', () => {
    // `ada` draws a bean, which is Moon.
    const html = renderToStaticMarkup(
      <ShapePicker value={{ kind: 'generated', seed: 'ada' }} onChange={() => {}} />,
    );
    expect(html).toMatch(/aria-pressed="true" title="Moon"/);
  });
});
