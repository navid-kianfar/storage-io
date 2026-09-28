import type { ReactNode } from 'react';
import {
  Select as SelectRoot,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * The single-select. `<select>` is an ESLint error in feature code; this is what
 * replaces it.
 *
 * The parts are re-exported for a trigger that needs custom content, and
 * {@link Select} is the shape almost every use wants: a list of options and a
 * value. Radix's Select has no "empty" value, so an optional filter uses
 * `Combobox` with `clearable` instead of a blank item here.
 */
export {
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};

export interface SelectOption<TValue extends string> {
  readonly value: TValue;
  readonly label: ReactNode;
  /** Shown in the list but not in the closed trigger. */
  readonly hint?: ReactNode;
  readonly disabled?: boolean;
  /** The text the closed trigger shows, when the rich label would not fit. */
  readonly textValue?: string;
}

export function Select<TValue extends string>({
  options,
  value,
  onValueChange,
  placeholder,
  disabled = false,
  size = 'default',
  id,
  className,
  contentClassName,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: {
  readonly options: readonly SelectOption<TValue>[];
  readonly value: TValue;
  readonly onValueChange: (value: TValue) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly size?: 'sm' | 'default';
  readonly id?: string;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
}) {
  return (
    <SelectRoot value={value} onValueChange={(next) => onValueChange(next as TValue)} disabled={disabled}>
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn('w-full', className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            textValue={option.textValue}
          >
            <span className="flex min-w-0 flex-col text-start">
              <span className="truncate">{option.label}</span>
              {option.hint === undefined ? null : (
                <span className="truncate text-xs text-muted-foreground">{option.hint}</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
