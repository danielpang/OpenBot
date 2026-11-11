import { cn } from '@openbots/ui';
import { memo, useEffect, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Prose in the transcript: GitHub-flavoured markdown (links, tables, task
// lists) with no raw HTML, and fenced code highlighted by shiki, which loads
// on first use so the transcript does not wait for it.

/**
 * Rich typography for a whole document (an Artifact): headings, spacing
 * between blocks, quotes and rules, on top of the transcript's prose.
 */
const DOCUMENT_CLASS = cn(
  'text-[15px] leading-7',
  '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:leading-tight [&_h1:first-child]:mt-0',
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:leading-snug',
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold',
  '[&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:font-semibold',
  '[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1 [&_li>p]:my-1',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
  '[&_hr]:my-6 [&_table]:my-4 [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded',
);

export const Markdown = memo(function Markdown({
  text,
  variant = 'chat',
}: {
  text: string;
  /** `document` for an Artifact read on its own; `chat` (the default) for messages. */
  variant?: 'chat' | 'document';
}) {
  return (
    <div
      className={cn(
        'prose-transcript min-w-0 break-words text-sm leading-relaxed [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_table]:my-2 [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2',
        variant === 'document' && DOCUMENT_CLASS,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const COMPONENTS: ComponentProps<typeof ReactMarkdown>['components'] = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer" className="underline underline-offset-2" />
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ node: _node, className, children, ...props }) => {
    const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1];
    const code = String(children ?? '');
    if (!lang && !code.includes('\n')) {
      return (
        <code {...props} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {children}
        </code>
      );
    }
    return <CodeBlock code={code.replace(/\n$/, '')} lang={lang} />;
  },
};

type Highlight = (code: string, lang: string) => Promise<string | null>;
let highlighter: Promise<Highlight> | undefined;

// A curated set of grammars, each its own chunk loaded on first use; any
// other language stays plain. The JavaScript regex engine avoids shipping
// Oniguruma's wasm.
const LANGS: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import('shiki/langs/shellscript.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};
const ALIASES: Record<string, string> = {
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

function loadHighlighter(): Promise<Highlight> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    const core = await createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
    return async (code, requested) => {
      const lang = ALIASES[requested.toLowerCase()] ?? requested.toLowerCase();
      const load = LANGS[lang];
      if (!load) return null;
      if (!core.getLoadedLanguages().includes(lang)) {
        await core.loadLanguage((await load()).default as never);
      }
      return core.codeToHtml(code, {
        lang,
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: 'light',
      });
    };
  })();
  return highlighter;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    loadHighlighter()
      .then((highlight) => highlight(code, lang))
      .then(
        (out) => !cancelled && out && setHtml(out),
        () => {}, // An unknown language stays plain.
      );
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const frame = 'my-2 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs';
  return (
    <>
      <style href="openbots-shiki" precedence="default">
        {SHIKI_CSS}
      </style>
      {html ? (
        // shiki escapes the code it is given; the markup is its own spans.
        <div className={`shiki-frame ${frame}`} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className={frame} data-lang={lang}>
          <code>{code}</code>
        </pre>
      )}
    </>
  );
}

// Dark mode follows the system (as the theme tokens do): switch shiki's dual
// theme to its dark colours.
const SHIKI_CSS = `
.shiki-frame pre { background: transparent !important; }
@media (prefers-color-scheme: dark) {
  .shiki-frame .shiki, .shiki-frame .shiki span { color: var(--shiki-dark) !important; }
}
`;
