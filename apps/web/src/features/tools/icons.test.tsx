import { CATALOG_ICONS, loadCatalog } from '@openbots/mcp';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_ICONS, ConnectorIcon, lettermark, resolveIcon } from './icons.js';

describe('connector icons', () => {
  it('draws every icon the catalog may name, and lettermark is the name', () => {
    for (const icon of CATALOG_ICONS) {
      if (icon === 'lettermark') expect(resolveIcon(icon)).toBeNull();
      else expect(resolveIcon(icon), icon).toBe(CONNECTOR_ICONS[icon]);
    }
    for (const entry of loadCatalog().entries) {
      expect(entry.icon === 'lettermark' || resolveIcon(entry.icon) !== null, entry.id).toBe(true);
    }
  });

  it('falls back to a lettermark for an unknown, missing or inherited name', () => {
    for (const icon of [undefined, null, '', 'not-an-icon', 'toString', '__proto__']) {
      expect(resolveIcon(icon)).toBeNull();
    }
    expect(lettermark('Web search')).toBe('WS');
    expect(lettermark('Firecrawl')).toBe('F');
    expect(lettermark('my-server')).toBe('MS');
    expect(lettermark('GitHub (built-in)')).toBe('G');
    expect(lettermark('ölçer api')).toBe('ÖA');
    expect(lettermark('---')).toBe('');
  });

  it('renders a brand mark in currentColor, never an image from the network', () => {
    const html = renderToStaticMarkup(<ConnectorIcon icon="github" name="GitHub" />);
    expect(html).toContain('data-icon="github"');
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toMatch(/<img|https?:/);
  });

  it('gives a custom connector its lettermark, and a name with no letters the plug', () => {
    const custom = renderToStaticMarkup(<ConnectorIcon name="Acme tracker" />);
    expect(custom).toContain('data-icon="lettermark"');
    expect(custom).toContain('>AT</span>');
    expect(custom).not.toContain('<svg');
    const blank = renderToStaticMarkup(<ConnectorIcon name="!!" />);
    expect(blank).toContain('<svg');
    expect(blank).toContain('stroke="currentColor"');
  });
});
