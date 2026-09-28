import { TriangleAlertIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

/**
 * The only way this app asks "are you sure?". `window.confirm` is banned by an
 * ESLint rule; this is what replaces it.
 *
 * Two shapes:
 *
 * - plain: Cancel / Confirm.
 * - typed: pass `confirmValue` and the operator must type it — the bucket name
 *   before an empty, the server name before a removal. The action stays disabled
 *   until it matches exactly (no trimming, no case folding: that is the point).
 *
 * The body is a separate component mounted only while the dialog is open, so the
 * typed text resets by remounting. Resetting it in an effect would be a cascading
 * render, and would also briefly show the previous attempt.
 */

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Extra content between the description and the footer — a list, an Alert. */
  readonly children?: ReactNode;
  readonly confirmLabel?: ReactNode;
  readonly cancelLabel?: ReactNode;
  readonly destructive?: boolean;
  /** Turns this into the typed-name confirmation. */
  readonly confirmValue?: string;
  /** Accessible name for the confirmation field; defaults to "Confirmation". */
  readonly confirmValueLabel?: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
}

export function ConfirmDialog({ open, onOpenChange, ...body }: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {open ? <ConfirmDialogBody {...body} /> : null}
    </AlertDialog>
  );
}

type ConfirmDialogBodyProps = Omit<ConfirmDialogProps, 'open' | 'onOpenChange'>;

function ConfirmDialogBody({
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  destructive = false,
  confirmValue,
  confirmValueLabel,
  busy = false,
  onConfirm,
}: ConfirmDialogBodyProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const [typed, setTyped] = useState('');

  const needsTyping = confirmValue !== undefined;
  const matches = !needsTyping || typed === confirmValue;
  const mismatch = needsTyping && typed.length > 0 && !matches;

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        {destructive ? (
          <AlertDialogMedia className="bg-destructive/12 text-destructive">
            <TriangleAlertIcon />
          </AlertDialogMedia>
        ) : null}
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
      </AlertDialogHeader>

      {children}

      {needsTyping ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={inputId} className="text-sm font-normal text-muted-foreground">
            <Trans
              i18nKey="confirm.typeToConfirm"
              values={{ value: confirmValue }}
              components={{
                1: (
                  <code className="ltr-isolate rounded-xs bg-muted px-1 font-medium text-foreground" />
                ),
              }}
            />
          </Label>
          <Input
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={mismatch}
            aria-describedby={mismatch ? `${inputId}-error` : undefined}
            aria-label={confirmValueLabel ?? t('confirm.typeToConfirmLabel')}
            className="ltr-isolate font-mono"
          />
          {mismatch ? (
            <p id={`${inputId}-error`} className="text-[0.8125rem] text-destructive">
              {t('confirm.mismatch')}
            </p>
          ) : null}
        </div>
      ) : null}

      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>{cancelLabel ?? t('action.cancel')}</AlertDialogCancel>
        {/*
          The variant, not a className: AlertDialogAction renders its Button
          with `asChild`, and Radix's Slot concatenates the two class strings
          instead of running them through tailwind-merge. Appending
          `bg-destructive` therefore left `bg-primary` in place too, and the
          stylesheet's own order decided — which made every destructive
          confirmation in the app render in the primary colour.
        */}
        <AlertDialogAction
          disabled={!matches || busy}
          variant={destructive ? 'destructive' : 'default'}
          onClick={(event) => {
            // Keep the dialog up while the request runs; the caller closes it.
            event.preventDefault();
            onConfirm();
          }}
        >
          {busy ? <Spinner /> : null}
          {confirmLabel ?? t('action.confirm')}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
