import type { ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

/**
 * The concept's `.tabs-list` used as a control rather than as navigation: a view
 * switch (All / Near limit / Unlimited), a range switch (24h / 7d / 30d), a
 * density switch. Single-select and never empty — clicking the active item keeps
 * it active, which is what separates this from a ToggleGroup used as a filter.
 *
 * For switching between *panels* use Tabs; this is for switching a value.
 */

export interface SegmentedOption<TValue extends string> {
  readonly value: TValue;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  /** A count rendered as a pill after the label, as the concept's `.tab .count`. */
  readonly count?: ReactNode;
  readonly disabled?: boolean;
  readonly 'aria-label'?: string;
}

export function SegmentedControl<TValue extends string>({
  options,
  value,
  onValueChange,
  size = 'sm',
  className,
  'aria-label': ariaLabel,
}: {
  readonly options: readonly SegmentedOption<TValue>[];
  readonly value: TValue;
  readonly onValueChange: (value: TValue) => void;
  readonly size?: 'sm' | 'default';
  readonly className?: string;
  readonly 'aria-label': string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix hands back "" when the active item is clicked; keep the current value.
      onValueChange={(next) => {
        if (next !== '') onValueChange(next as TValue);
      }}
      aria-label={ariaLabel}
      className={cn('gap-0.5 rounded-lg bg-muted p-0.5', className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          aria-label={option['aria-label']}
          className={cn(
            'gap-1.5 rounded-md border-0 bg-transparent px-3 text-[0.8125rem] font-medium text-muted-foreground hover:text-foreground',
            'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
            size === 'sm'
              ? 'h-[calc(var(--control-h)-0.5rem)]'
              : 'h-[calc(var(--control-h)-0.25rem)]',
          )}
        >
          {option.icon}
          {option.label}
          {option.count !== undefined ? (
            <span className="num rounded-full bg-muted px-1.5 text-[0.6875rem]">
              {option.count}
            </span>
          ) : null}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
