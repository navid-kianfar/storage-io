import { GitBranchIcon, SaveIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
import { CodeEditor } from '@/components/app/CodeEditor';
import { Kbd } from '@/components/app/Kbd';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/app/Sheet';
import { Skeleton } from '@/components/app/Skeleton';
import { Spinner } from '@/components/app/Spinner';
import { ConfirmDialog } from '@/components/app/ConfirmDialog';
import { toastProblem } from '@/lib/api/problems';
import { useFormat } from '@/lib/format/FormatProvider';
import { isMacPlatform } from '@/lib/platform';
import { fetchObjectText, parentPrefix, usePutObjectContent, type ObjectScope } from '../api';
import { TEXT_PREVIEW_MAX_BYTES, editorLanguage } from '../fileKind';

/**
 * Edit contents. `PUT …/content` writes the text back, which on a versioned bucket
 * creates a new version and leaves the current one restorable — the footer says
 * which of the two will happen.
 *
 * ⌘S / Ctrl+S saves, because anyone editing a file in a text box will press it.
 * Closing with unsaved changes asks first: a sheet that dismisses on a stray click
 * outside must not be able to lose work.
 */
export function EditContentsSheet({
  open,
  onOpenChange,
  scope,
  objectKey,
  sizeBytes,
  versioned,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly versioned: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const format = useFormat();
  const [text, setText] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [original, setOriginal] = useState('');
  const [failed, setFailed] = useState(false);
  const save = usePutObjectContent(scope);

  const tooLarge = sizeBytes > TEXT_PREVIEW_MAX_BYTES;

  // No reset here: the page mounts this sheet per object (and unmounts it on
  // close), so a different object gets a fresh component and the only setState
  // calls are the fetch's own.
  useEffect(() => {
    if (tooLarge) return;
    let cancelled = false;
    fetchObjectText(scope, objectKey).then(
      (content) => {
        if (cancelled) return;
        setText(content);
        setOriginal(content);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tooLarge, scope, objectKey]);

  const dirty = text !== null && text !== original;

  function submit(): void {
    if (text === null || save.isPending) return;
    save.mutate(
      { key: objectKey, content: text },
      {
        onSuccess: () => {
          setOriginal(text);
          toast.success(t('browse.edit.saved'), { description: objectKey });
          onOpenChange(false);
        },
        onError: (error) => toastProblem(error, tCommon),
      },
    );
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const withModifier = isMacPlatform() ? event.metaKey : event.ctrlKey;
      if (!withModifier || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      submit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // `submit` closes over the current text, which is exactly what the shortcut needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text, save.isPending]);

  const name = objectKey.split('/').pop() ?? objectKey;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Unsaved work must not vanish because a click landed outside the sheet.
        if (!next && dirty) {
          setConfirmClose(true);
          return;
        }
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="ltr-isolate flex items-center gap-2 font-mono">
            {name}
            {dirty ? <Badge variant="warning">{t('bucket.unsaved')}</Badge> : null}
          </SheetTitle>
          <SheetDescription className="ltr-isolate font-mono">
            {scope.bucket}/{parentPrefix(objectKey)}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 grow overflow-auto px-4">
          {tooLarge ? (
            <Alert variant="warning">
              <AlertDescription>
                {t('browse.edit.tooLarge', { size: format.bytes(sizeBytes) })}
              </AlertDescription>
            </Alert>
          ) : failed ? (
            <Alert variant="destructive">
              <AlertDescription>{tCommon('state.error')}</AlertDescription>
            </Alert>
          ) : text === null ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <CodeEditor
              value={text}
              onValueChange={setText}
              language={editorLanguage(objectKey)}
              height="calc(100dvh - 16rem)"
              ariaLabel={objectKey}
            />
          )}
        </div>

        <SheetFooter className="flex-row items-center justify-between gap-3 border-t">
          <span className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
            <GitBranchIcon className="size-3.5" aria-hidden="true" />
            {versioned ? t('browse.edit.description') : t('browse.edit.noVersioning')}
          </span>
          <span className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => (dirty ? setConfirmClose(true) : onOpenChange(false))}
              disabled={save.isPending}
            >
              {t('browse.edit.discard')}
            </Button>
            <Button onClick={submit} disabled={!dirty || save.isPending}>
              {save.isPending ? <Spinner /> : <SaveIcon />}
              {t('browse.edit.save')}
              <Kbd>{isMacPlatform() ? '⌘S' : 'Ctrl+S'}</Kbd>
            </Button>
          </span>
        </SheetFooter>
      </SheetContent>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        destructive
        title={t('browse.edit.discard')}
        description={tCommon('confirm.irreversible')}
        confirmLabel={t('browse.edit.discard')}
        onConfirm={() => {
          setConfirmClose(false);
          setText(original);
          onOpenChange(false);
        }}
      />
    </Sheet>
  );
}
