import { useId, type ReactNode } from 'react';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { cn } from '@/lib/utils';

/**
 * Form layout. The shadcn Field parts are re-exported for anything unusual, and
 * {@link FormField} is the concept's `.field`: label, control, hint, error. It
 * generates the id and hands it to the control through a render prop, so the
 * label's `htmlFor` and the control's `aria-describedby` can never drift apart.
 * For the `.option-row` and `.form-row` shapes use `FormRow.tsx`.
 */
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
};

export function FormField({
  label,
  hint,
  error,
  optionalText,
  children,
  className,
}: {
  readonly label: ReactNode;
  /** The helper line under the control. Hidden while `error` is set. */
  readonly hint?: ReactNode;
  readonly error?: string;
  /** The muted "(optional)" beside the label. */
  readonly optionalText?: ReactNode;
  readonly children: (ids: {
    readonly id: string;
    readonly describedBy: string | undefined;
    readonly invalid: boolean;
  }) => ReactNode;
  readonly className?: string;
}) {
  const baseId = useId();
  const id = `${baseId}-control`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const invalid = error !== undefined;
  const describedBy = invalid ? errorId : hint === undefined ? undefined : hintId;

  return (
    <Field data-invalid={invalid} className={cn('gap-1.5', className)}>
      <FieldLabel htmlFor={id} className="text-[0.8125rem] font-medium">
        {label}
        {optionalText === undefined ? null : (
          <span className="font-normal text-muted-foreground">{optionalText}</span>
        )}
      </FieldLabel>
      {children({ id, describedBy, invalid })}
      {invalid ? (
        <FieldError id={errorId} className="text-xs">
          {error}
        </FieldError>
      ) : hint === undefined ? null : (
        <FieldDescription id={hintId} className="text-xs">
          {hint}
        </FieldDescription>
      )}
    </Field>
  );
}
