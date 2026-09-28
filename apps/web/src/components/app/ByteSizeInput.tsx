import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useFormat } from '@/lib/format/FormatProvider';
import { cn } from '@/lib/utils';
import { Combobox, type ComboboxOption } from './Combobox';

/**
 * A byte count entered as a number plus a unit, the way the concept draws every
 * quota field ("4" + "TB"). The value travelling in and out is always bytes,
 * because that is what the contract carries.
 *
 * The unit is decimal or binary according to `Settings.region.sizeUnits`, so the
 * operator types the same number they read in the rest of the app.
 */

const DECIMAL_STEP = 1000;
const BINARY_STEP = 1024;
const UNIT_KEYS = ['mega', 'giga', 'tera', 'peta'] as const;
type UnitKey = (typeof UNIT_KEYS)[number];

const DECIMAL_LABELS: Readonly<Record<UnitKey, string>> = {
  mega: 'MB',
  giga: 'GB',
  tera: 'TB',
  peta: 'PB',
};
const BINARY_LABELS: Readonly<Record<UnitKey, string>> = {
  mega: 'MiB',
  giga: 'GiB',
  tera: 'TiB',
  peta: 'PiB',
};

function unitFactor(unit: UnitKey, step: number): number {
  const exponent = UNIT_KEYS.indexOf(unit) + 2;
  return step ** exponent;
}

/** The largest unit that still leaves a clean number, so 4e12 shows as "4 TB". */
function bestUnit(bytes: number, step: number): UnitKey {
  const candidates = [...UNIT_KEYS].reverse();
  for (const unit of candidates) {
    const factor = unitFactor(unit, step);
    if (bytes >= factor) return unit;
  }
  return 'giga';
}

export function ByteSizeInput({
  value,
  onValueChange,
  disabled = false,
  id,
  className,
  'aria-label': ariaLabel,
  unitLabel,
}: {
  /** Bytes, or null when nothing is set yet. */
  readonly value: number | null;
  readonly onValueChange: (bytes: number | null) => void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly 'aria-label': string;
  /** Accessible name for the unit picker; defaults to the value's own label. */
  readonly unitLabel?: string;
}) {
  const format = useFormat();
  const step = format.region.sizeUnits === 'binary' ? BINARY_STEP : DECIMAL_STEP;
  const labels = format.region.sizeUnits === 'binary' ? BINARY_LABELS : DECIMAL_LABELS;

  // The unit is view state: which unit 4e12 is shown in does not change the value.
  const [unit, setUnit] = useState<UnitKey>(() =>
    value === null || value <= 0 ? 'tera' : bestUnit(value, step),
  );
  const [text, setText] = useState(() =>
    value === null || value <= 0 ? '' : trimNumber(value / unitFactor(unit, step)),
  );

  const options = useMemo<readonly ComboboxOption<UnitKey>[]>(
    () => UNIT_KEYS.map((key) => ({ value: key, label: labels[key] })),
    [labels],
  );

  function emit(nextText: string, nextUnit: UnitKey): void {
    const amount = Number.parseFloat(nextText.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      onValueChange(null);
      return;
    }
    onValueChange(Math.round(amount * unitFactor(nextUnit, step)));
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        id={id}
        value={text}
        inputMode="decimal"
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => {
          setText(event.target.value);
          emit(event.target.value, unit);
        }}
        className="num w-28"
      />
      <Combobox
        options={options}
        value={unit}
        onValueChange={(next) => {
          if (next === null) return;
          setUnit(next);
          emit(text, next);
        }}
        disabled={disabled}
        aria-label={unitLabel ?? ariaLabel}
        className="w-24"
      />
    </div>
  );
}

/** "4" rather than "4.000000001", without dragging Intl into an input's value. */
function trimNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
