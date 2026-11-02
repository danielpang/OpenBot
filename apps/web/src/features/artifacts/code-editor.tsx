import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

// CodeMirror for the viewer (plan 12.1): read only for `code` and as the
// editor for document, code and data. The language comes from the file name
// (the Artifact's title), else from the mime type; grammars load on demand.

export function CodeEditor({
  value,
  fileName,
  mime,
  onChange,
  label,
}: {
  /** The starting text; later changes are ignored, so key the editor on the version. */
  value: string;
  fileName: string;
  mime?: string;
  /** Makes the editor editable. */
  onChange?: (value: string) => void;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const editable = onChange !== undefined;

  useEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language.of([]),
          EditorView.lineWrapping,
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    let live = true;
    void detectLanguage(fileName, mime)
      ?.load()
      .then((support) => {
        if (live) view.dispatch({ effects: language.reconfigure(support) });
      })
      .catch(() => {
        // No grammar: the text stays plain.
      });
    return () => {
      live = false;
      view.destroy();
    };
    // The document is set once per mount; the parent keys the editor on the version.
  }, [editable, fileName, mime, label]);

  return <div ref={host} className="text-xs [&_.cm-editor]:h-full [&_.cm-focused]:outline-none" />;
}

const BY_MIME: Record<string, string> = {
  'text/markdown': 'Markdown',
  'application/json': 'JSON',
  'text/csv': 'CSV',
  'text/html': 'HTML',
  'image/svg+xml': 'XML',
  'application/xml': 'XML',
  'application/yaml': 'YAML',
};

/** The grammar for a file name (`report.py`), else for its mime type. */
export function detectLanguage(fileName: string, mime?: string): LanguageDescription | null {
  const byName = LanguageDescription.matchFilename(languages, fileName.trim());
  if (byName) return byName;
  const name = mime ? BY_MIME[mime] : undefined;
  return name ? LanguageDescription.matchLanguageName(languages, name, false) : null;
}
