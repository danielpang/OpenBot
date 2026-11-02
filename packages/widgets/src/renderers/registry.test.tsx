import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WIDGET_KIND_NAMES, WIDGET_KINDS } from '../kinds/index.js';
import { EventRow } from './event.js';
import { formatBytes } from './file.js';
import { Widget, WIDGET_RENDERERS } from './registry.js';

describe('widget renderers', () => {
  it('has one entry per kind, with a renderer for every kind that has a schema', () => {
    expect(Object.keys(WIDGET_RENDERERS).sort()).toEqual([...WIDGET_KIND_NAMES].sort());
    for (const kind of WIDGET_KIND_NAMES) {
      expect(WIDGET_KINDS[kind]).not.toBeNull();
      expect(WIDGET_RENDERERS[kind]).not.toBeNull();
    }
  });

  it('falls back for unknown kinds and invalid props', () => {
    for (const [kind, props] of [
      ['sparkline', {}],
      ['chart', {}],
      ['approval', { tool_name: 'bash' }],
      ['question', { options: 'nope' }],
    ] as const) {
      expect(renderToStaticMarkup(<Widget kind={kind} props={props} />)).toContain(
        `Unknown widget <code>${kind}</code>`,
      );
    }
  });

  it('renders an event as a compact row, not a bubble', () => {
    const html = renderToStaticMarkup(
      <Widget kind="event" props={{ event: 'routine_ran', text: 'Morning brief ran' }} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('data-event="routine_ran"');
    expect(html).toContain('Morning brief ran');
    expect(html).toContain('text-xs');
    expect(html).not.toContain('rounded-lg');
  });

  it('marks a blocked row and shows its fix once', () => {
    const html = renderToStaticMarkup(
      <EventRow kind="blocked" text="No model set." fix="Choose one in Bot Settings." />,
    );
    expect(html).toContain('bg-destructive');
    expect(html.match(/Choose one in Bot Settings\./g)).toHaveLength(1);
    const already = renderToStaticMarkup(
      <EventRow kind="blocked" text="No model set. Choose one." fix="Choose one." />,
    );
    expect(already.match(/Choose one\./g)).toHaveLength(1);
  });

  it('renders a file card with open and download links', () => {
    const html = renderToStaticMarkup(
      <Widget
        kind="file"
        props={{ file_id: 'f1', name: 'report.pdf', mime: 'application/pdf', size: 52_300 }}
      />,
    );
    expect(html).toContain('href="/api/v1/files/f1"');
    expect(html).toContain('download="report.pdf"');
    expect(html).toContain('PDF · 51 KB');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
