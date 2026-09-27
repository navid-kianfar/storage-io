import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * The CodeMirror 6 editor itself. Loaded on demand through `CodeEditor.tsx` — every
 * import in this file is part of the ~250 kB CodeMirror bundle, which must not be in
 * the initial page load when only three screens use it.
 *
 * Two things worth knowing:
 *
 * - The editor is always LTR, even on a Persian or Arabic page. JSON and object
 *   contents are code, and code does not mirror. `dir="ltr"` is set on the host
 *   element and `.cm-editor` in globals.css pins it.
 * - The theme is the app's tokens, resolved through CSS variables in
 *   globals.css rather than a CodeMirror theme object, so switching light/dark
 *   needs no editor rebuild.
 */

export type CodeEditorLanguage = 'json' | 'markdown' | 'plain';

const LANGUAGE_EXTENSIONS: Readonly<Record<CodeEditorLanguage, () => readonly Extension[]>> = {
  json: () => [json()],
  markdown: () => [markdown()],
  plain: () => [],
};

/**
 * Highlighting maps onto the chart and status tokens, the same colours the
 * concept used for its static `.code` blocks (global.css section 25).
 */
const highlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--chart-1)' },
  { tag: tags.keyword, color: 'var(--chart-1)' },
  { tag: tags.string, color: 'var(--success-foreground)' },
  { tag: tags.number, color: 'var(--warning-foreground)' },
  { tag: tags.bool, color: 'var(--warning-foreground)' },
  { tag: tags.null, color: 'var(--warning-foreground)' },
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: tags.heading, color: 'var(--foreground)', fontWeight: '600' },
  { tag: tags.link, color: 'var(--info-foreground)', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
]);

export interface CodeEditorProps {
  readonly value: string;
  readonly onValueChange?: (value: string) => void;
  readonly language?: CodeEditorLanguage;
  readonly readOnly?: boolean;
  readonly placeholder?: string;
  readonly showLineNumbers?: boolean;
  /** CSS height for the scroll area, e.g. `'18rem'`. */
  readonly height?: string;
  readonly ariaLabel: string;
  readonly className?: string;
}

export function CodeEditorImpl({
  value,
  onValueChange,
  language = 'json',
  readOnly = false,
  placeholder,
  showLineNumbers = true,
  height = '18rem',
  ariaLabel,
  className,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Kept in a ref so a new inline callback does not rebuild the editor. Written in
  // an effect, because a ref must not be mutated during render.
  const onChangeRef = useRef(onValueChange);
  useEffect(() => {
    onChangeRef.current = onValueChange;
  }, [onValueChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const extensions: Extension[] = [
      history(),
      bracketMatching(),
      indentOnInput(),
      highlightActiveLine(),
      syntaxHighlighting(highlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
      ...LANGUAGE_EXTENSIONS[language](),
    ];
    if (showLineNumbers) extensions.push(lineNumbers(), highlightActiveLineGutter());
    if (placeholder !== undefined) extensions.push(placeholderExtension(placeholder));
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        onChangeRef.current?.(update.state.doc.toString());
      }),
    );

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: value, extensions }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `value` is intentionally absent: it is synced by the effect below, so
    // typing does not tear down and rebuild the editor on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, showLineNumbers, placeholder, ariaLabel]);

  // Adopt an externally changed value (a reset, a template, a fetched document)
  // without disturbing the cursor when the text already matches.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={hostRef}
      dir="ltr"
      style={{ '--code-editor-height': height } as React.CSSProperties}
      className={cn(
        'overflow-hidden rounded-lg border bg-muted',
        '[&_.cm-scroller]:h-(--code-editor-height) [&_.cm-scroller]:overflow-auto',
        'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        className,
      )}
    />
  );
}
