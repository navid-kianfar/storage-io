import { CircleCheckIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * The concept's `.choice` cards: a radio group that looks like a row of cards —
 * the provider picker in the Add server wizard, the quota mode picker, the
 * conflict-policy picker.
 *
 * Built on RadioGroup, so arrow-key navigation, roving focus and the required
 * semantics come from Radix. The visible radio is hidden and the selected state
 * is the card's border plus a tick, exactly as drawn.
 */

export interface ChoiceOption<TValue extends string> {
  readonly value: TValue;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** A ProviderMark, an icon tile, anything that identifies the option. */
  readonly media?: ReactNode;
  readonly disabled?: boolean;
}

export function ChoiceCards<TValue extends string>({
  options,
  value,
  onValueChange,
  orientation = 'grid',
  columns = 4,
  name,
  className,
  'aria-label': ariaLabel,
}: {
  readonly options: readonly ChoiceOption<TValue>[];
  readonly value: TValue | null;
  readonly onValueChange: (value: TValue) => void;
  /** `grid` stacks media above the label (the provider picker); `rows` is one line each. */
  readonly orientation?: 'grid' | 'rows';
  readonly columns?: 2 | 3 | 4;
  readonly name?: string;
  readonly className?: string;
  readonly 'aria-label': string;
}) {
  const groupId = useId();
  const isGrid = orientation === 'grid';

  return (
    <RadioGroup
      name={name}
      value={value ?? undefined}
      onValueChange={(next) => onValueChange(next as TValue)}
      aria-label={ariaLabel}
      className={cn(
        isGrid
          ? cn(
              'grid gap-2.5',
              columns === 2 && 'grid-cols-1 sm:grid-cols-2',
              columns === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
              columns === 4 && 'grid-cols-2 lg:grid-cols-4',
            )
          : 'grid gap-2',
        className,
      )}
    >
      {options.map((option) => {
        const itemId = `${groupId}-${option.value}`;
        const selected = option.value === value;
        return (
          <Label
            key={option.value}
            htmlFor={itemId}
            data-selected={selected}
            className={cn(
              'relative cursor-pointer rounded-lg border bg-card p-3.5 text-start transition-[border-color,box-shadow,background-color]',
              'hover:border-foreground/20',
              'has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50',
              'data-[selected=true]:border-primary data-[selected=true]:bg-primary/4 data-[selected=true]:shadow-[0_0_0_1px_var(--primary)]',
              option.disabled && 'pointer-events-none opacity-50',
              isGrid ? 'flex flex-col items-start gap-2' : 'flex items-center gap-3',
            )}
          >
            {/* The radio itself carries the semantics but is not drawn: the card is. */}
            <RadioGroupItem
              id={itemId}
              value={option.value}
              disabled={option.disabled}
              className="sr-only"
            />
            {option.media}
            <span className="flex min-w-0 flex-col gap-0">
              <span className="text-sm font-semibold">{option.label}</span>
              {option.description ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
            <CircleCheckIcon
              aria-hidden="true"
              className={cn(
                'size-4 text-primary transition-opacity',
                isGrid ? 'absolute top-3 end-3' : 'ms-auto',
                selected ? 'opacity-100' : 'opacity-0',
              )}
            />
          </Label>
        );
      })}
    </RadioGroup>
  );
}
