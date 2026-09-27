import { CalendarIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DateRange, DayPickerLocale, Matcher } from 'react-day-picker';
import { ar, enUS, faIR, tr } from 'react-day-picker/locale';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useFormat } from '@/lib/format/FormatProvider';
import { cn } from '@/lib/utils';
import type { Language } from '@/stores/preferences';

/**
 * Calendar + Popover. Used everywhere a date is needed — an activity filter, a
 * key expiry, a job schedule — so no native `<input type="date">` ever appears.
 *
 * Known limitation: the month grid is Gregorian. react-day-picker has no
 * Solar Hijri or Hijri calendar, so with `Settings.region.calendar = 'persian'`
 * the *displayed value* is Solar Hijri (it goes through `Intl`) while the grid you
 * pick from is Gregorian. Swapping the grid needs a custom day-picker `dateLib`
 * and is tracked separately.
 */

export type { DateRange };

const DAY_PICKER_LOCALES: Readonly<Record<Language, DayPickerLocale>> = {
  en: enUS,
  tr,
  fa: faIR,
  ar,
};

function useDayPickerLocale(): DayPickerLocale {
  const { language } = useFormat();
  return DAY_PICKER_LOCALES[language];
}

export interface DatePickerProps {
  readonly value: Date | null;
  readonly onValueChange: (value: Date | null) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly clearable?: boolean;
  /** Restricts the selectable range — a key expiry cannot be in the past. */
  readonly fromDate?: Date;
  readonly toDate?: Date;
  readonly id?: string;
  readonly className?: string;
  readonly 'aria-label'?: string;
}

export function DatePicker({
  value,
  onValueChange,
  placeholder,
  disabled = false,
  clearable = true,
  fromDate,
  toDate,
  id,
  className,
  'aria-label': ariaLabel,
}: DatePickerProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const locale = useDayPickerLocale();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn('w-full justify-start gap-2 font-normal', className)}
        >
          <CalendarIcon className="size-4 text-muted-foreground" />
          <span className={cn('truncate', value === null && 'text-muted-foreground')}>
            {value === null
              ? (placeholder ?? t('form.datePlaceholder'))
              : format.dateTime(value, 'date')}
          </span>
          {clearable && value !== null ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label={t('form.clearDate')}
              className="ms-auto rounded-xs p-0.5 opacity-60 hover:opacity-100"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onValueChange(null);
              }}
            >
              <XIcon className="size-3.5" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          locale={locale}
          autoFocus
          selected={value ?? undefined}
          onSelect={(next) => {
            onValueChange(next ?? null);
            setOpen(false);
          }}
          startMonth={fromDate}
          endMonth={toDate}
          disabled={disabledMatcher(fromDate, toDate)}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface DateRangePickerProps {
  readonly value: DateRange | null;
  readonly onValueChange: (value: DateRange | null) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly clearable?: boolean;
  readonly fromDate?: Date;
  readonly toDate?: Date;
  /** Two months side by side on wide screens, as the activity filter does. */
  readonly numberOfMonths?: number;
  readonly id?: string;
  readonly className?: string;
  readonly 'aria-label'?: string;
}

export function DateRangePicker({
  value,
  onValueChange,
  placeholder,
  disabled = false,
  clearable = true,
  fromDate,
  toDate,
  numberOfMonths = 2,
  id,
  className,
  'aria-label': ariaLabel,
}: DateRangePickerProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const locale = useDayPickerLocale();
  const [open, setOpen] = useState(false);

  const label = useMemo(() => {
    if (value?.from === undefined) return placeholder ?? t('form.dateRangePlaceholder');
    const from = format.dateTime(value.from, 'date');
    if (value.to === undefined) return from;
    return `${from} – ${format.dateTime(value.to, 'date')}`;
  }, [value, placeholder, t, format]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn('w-full justify-start gap-2 font-normal', className)}
        >
          <CalendarIcon className="size-4 text-muted-foreground" />
          <span className={cn('truncate', value?.from === undefined && 'text-muted-foreground')}>
            {label}
          </span>
          {clearable && value?.from !== undefined ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label={t('form.clearDate')}
              className="ms-auto rounded-xs p-0.5 opacity-60 hover:opacity-100"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onValueChange(null);
              }}
            >
              <XIcon className="size-3.5" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="range"
          locale={locale}
          autoFocus
          numberOfMonths={numberOfMonths}
          selected={value ?? undefined}
          onSelect={(next) => onValueChange(next ?? null)}
          startMonth={fromDate}
          endMonth={toDate}
          disabled={disabledMatcher(fromDate, toDate)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * react-day-picker wants a matcher for "outside these bounds", not two props, and
 * `DateInterval` has no optional members — so only the bounds that exist are set.
 */
function disabledMatcher(fromDate?: Date, toDate?: Date): Matcher[] | undefined {
  const matchers: Matcher[] = [];
  if (fromDate !== undefined) matchers.push({ before: fromDate });
  if (toDate !== undefined) matchers.push({ after: toDate });
  return matchers.length === 0 ? undefined : matchers;
}
