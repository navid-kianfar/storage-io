import { CheckIcon, ChevronsUpDownIcon, XIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * A searchable single-select, built from Popover + Command (cmdk). This is the
 * replacement for a native `<select>` with many options — a server picker, a
 * bucket picker, a timezone picker. For a handful of fixed options, use Select.
 */

export interface ComboboxOption<TValue extends string = string> {
  readonly value: TValue;
  readonly label: string;
  /** Second line, e.g. the provider or the server a bucket belongs to. */
  readonly description?: string;
  /** Rendered before the label: a ProviderMark, a StatusDot, an icon. */
  readonly icon?: ReactNode;
  /** Extra words the search should match but which are not displayed. */
  readonly keywords?: readonly string[];
  readonly disabled?: boolean;
}

export interface ComboboxProps<TValue extends string = string> {
  readonly options: readonly ComboboxOption<TValue>[];
  readonly value: TValue | null;
  readonly onValueChange: (value: TValue | null) => void;
  readonly placeholder?: string;
  readonly searchPlaceholder?: string;
  readonly emptyMessage?: string;
  /** Adds a clear button, for an optional filter. */
  readonly clearable?: boolean;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly 'aria-label'?: string;
}

export function Combobox<TValue extends string = string>({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  clearable = false,
  disabled = false,
  id,
  className,
  contentClassName,
  'aria-label': ariaLabel,
}: ComboboxProps<TValue>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const select = (next: TValue) => {
    onValueChange(next === value ? null : next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon}
            <span className={cn('truncate', selected === null && 'text-muted-foreground')}>
              {selected?.label ?? placeholder ?? t('form.comboboxPlaceholder')}
            </span>
          </span>
          <span className="flex items-center gap-1">
            {clearable && selected !== null ? (
              <span
                role="button"
                tabIndex={-1}
                aria-label={t('action.clear')}
                className="rounded-xs p-0.5 opacity-60 hover:opacity-100"
                onPointerDown={(event) => {
                  // Stop the popover from opening on the clear click.
                  event.preventDefault();
                  event.stopPropagation();
                  onValueChange(null);
                }}
              >
                <XIcon className="size-3.5" />
              </span>
            ) : null}
            <ChevronsUpDownIcon className="size-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn('w-[--radix-popover-trigger-width] min-w-56 p-0', contentClassName)}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder ?? t('form.comboboxSearch')} />
          <CommandList>
            <CommandEmpty>{emptyMessage ?? t('form.comboboxEmpty')}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.description ?? '', ...(option.keywords ?? [])]}
                  disabled={option.disabled}
                  onSelect={() => select(option.value)}
                >
                  {option.icon}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.description ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  <CheckIcon
                    className={cn(
                      'ms-auto size-4',
                      option.value === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
