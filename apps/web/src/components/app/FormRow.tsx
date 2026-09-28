import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The two row shapes every settings card in the concept is built from.
 *
 * `FormRow` is `.form-row`: a label and its explanation on the inline-start, the
 * control on the inline-end, stacking below 48rem. `OptionRow` is `.option-row`:
 * the same idea for a single switch or button, without the border above.
 *
 * They exist so that the bucket settings page, the transfer settings card and
 * every dialog that lists options line up to the same grid instead of each one
 * inventing its own two-column layout.
 */
export function FormRow({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** Set when the row's control has a single input, so the label activates it. */
  readonly htmlFor?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'grid gap-3 border-t px-(--card-pad) py-4 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        {htmlFor === undefined ? (
          <div className="text-sm font-medium">{label}</div>
        ) : (
          // A plain <label> rather than the Label primitive: the primitive's
          // flex layout would fight the two-line label + hint stack here.
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
        )}
        {hint ? <p className="mt-1 text-[0.8125rem] text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function OptionRow({
  label,
  hint,
  children,
  className,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-b py-3.5 last:border-b-0',
        className,
      )}
    >
      {/*
       * `basis-48` is what makes `flex-wrap` above do anything. With a bare
       * `flex-1` the label column shrinks to its longest word instead, so a wide
       * control — a byte-size input and its unit select, not just a switch —
       * squeezed the hint into a one-word-per-line ribbon at 375px. Given a
       * basis, the row wraps the control onto its own line instead, and a narrow
       * control still sits inline at every width.
       */}
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-sm font-medium">{label}</div>
        {hint ? <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** The footer of an editable section: Cancel on the inline-end, then Save. */
export function FormActions({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/35 px-(--card-pad) py-3">
      {children}
    </div>
  );
}
