import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CheckIcon,
  CardHeader,
  CardTitle,
  cn,
  Input,
  Kbd,
  PACKAGE_NAME,
  ScrollArea,
  Spinner,
  Textarea,
} from './index.js';

describe('@openbots/ui', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbots/ui');
  });

  it('merges conflicting Tailwind classes, last one winning', () => {
    expect(cn('px-2 text-sm', false, 'px-4')).toBe('text-sm px-4');
  });

  it('renders a button variant and a child element via asChild', () => {
    expect(renderToString(<Button variant="outline">Save</Button>)).toContain('border');
    const link = renderToString(
      <Button asChild>
        <a href="/x">Go</a>
      </Button>,
    );
    expect(link).toMatch(/^<a [^>]*href="\/x"/);
  });

  it('renders an input with its props', () => {
    expect(renderToString(<Input type="email" name="email" />)).toContain('type="email"');
  });

  it('renders a card with its slots', () => {
    const html = renderToString(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
        </CardHeader>
        <CardContent>Body</CardContent>
      </Card>,
    );
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('bg-card');
    expect(html).toContain('data-slot="card-title"');
  });

  it('renders an alert as role alert, in its variant', () => {
    const html = renderToString(
      <Alert variant="destructive">
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>Try again.</AlertDescription>
      </Alert>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('text-destructive');
    expect(renderToString(<Alert variant="warning" />)).toContain('text-amber-700');
  });

  it('renders a badge, a textarea, a key and a spinner', () => {
    expect(renderToString(<Badge variant="outline">New</Badge>)).toContain('data-slot="badge"');
    expect(renderToString(<Textarea rows={3} />)).toContain('rows="3"');
    expect(renderToString(<Kbd>esc</Kbd>)).toMatch(/^<kbd /);
    expect(renderToString(<Spinner />)).toContain('role="status"');
  });

  it('gives every scrolling area the quiet scrollbar, light and dark', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toContain('scrollbar-color: var(--scrollbar) transparent;');
    expect(css).toMatch(/::-webkit-scrollbar-thumb \{[^}]*background-clip: padding-box;/);
    expect(css.match(/--scrollbar:/g)).toHaveLength(2);
    expect(renderToString(<ScrollArea>Text</ScrollArea>)).toContain('Text');
  });

  it('has a success colour for light and dark, and a check mark to draw in it', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css.match(/--success: oklch\(/g)).toHaveLength(2);
    expect(css).toContain('--color-success: var(--success);');
    expect(renderToString(<CheckIcon className="text-success" />)).toContain('M20 6 9 17l-5-5');
  });
});
