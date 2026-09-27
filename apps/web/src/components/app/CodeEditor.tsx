import { Suspense, lazy } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import type { CodeEditorLanguage, CodeEditorProps } from './CodeEditorImpl';

/**
 * CodeMirror 6, for the places the app edits text: a bucket or IAM policy
 * document, an object's contents, a CORS rule set.
 *
 * CodeMirror is around 250 kB and only three screens need it, so the editor is
 * loaded on demand: this module holds only the lazy boundary and the placeholder,
 * and nothing here pulls CodeMirror into the initial bundle. The API is the
 * implementation's — see CodeEditorImpl.tsx for the behaviour and the theming.
 */
const CodeEditorImpl = lazy(async () => {
  const module = await import('./CodeEditorImpl');
  return { default: module.CodeEditorImpl };
});

export type { CodeEditorLanguage, CodeEditorProps };

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense
      fallback={
        <Skeleton
          className="w-full rounded-lg"
          style={{ height: props.height ?? '18rem' }}
          aria-label={props.ariaLabel}
        />
      }
    >
      <CodeEditorImpl {...props} />
    </Suspense>
  );
}
