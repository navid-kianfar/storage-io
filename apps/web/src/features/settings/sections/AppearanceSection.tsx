import { DENSITIES } from '@storage-io/contracts';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Combobox,
  FormRow,
  SectionCard,
  SegmentedControl,
  Switch,
  type ComboboxOption,
  type SegmentedOption,
} from '@/components/app';
import { useUpdateSettings } from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';
import {
  THEMES,
  usePreferences,
  type Density,
  type Theme,
} from '@/stores/preferences';
import { cn } from '@/lib/utils';

/**
 * Appearance is *this browser's* choice, so every control here writes to the
 * preferences store and takes effect immediately — there is no Save button,
 * because there is nothing to send anywhere.
 *
 * Density is the exception and it is deliberate: the installation holds a default
 * in `Settings.appearance.density` and this browser holds its own. Changing it here
 * does both, so a fresh browser starts where the operator left it.
 */

const CLICK_BEHAVIOURS = ['details', 'preview'] as const;
type ClickBehaviour = (typeof CLICK_BEHAVIOURS)[number];

/** Where the object browser's single-click behaviour lives, per browser. */
export const CLICK_BEHAVIOUR_KEY = 'sio.objectClick';

function readClickBehaviour(): ClickBehaviour {
  try {
    const stored = window.localStorage.getItem(CLICK_BEHAVIOUR_KEY);
    return stored === 'preview' ? 'preview' : 'details';
  } catch {
    // Private mode, or site data blocked. The default is the safe answer.
    return 'details';
  }
}

function writeClickBehaviour(value: ClickBehaviour): void {
  try {
    window.localStorage.setItem(CLICK_BEHAVIOUR_KEY, value);
  } catch {
    // Nothing to do: the preference simply does not persist in this browser.
  }
}

export function AppearanceSection() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const save = useUpdateSettings();

  const theme = usePreferences((state) => state.theme);
  const setTheme = usePreferences((state) => state.setTheme);
  const density = usePreferences((state) => state.density);
  const setDensity = usePreferences((state) => state.setDensity);
  const reduceMotion = usePreferences((state) => state.reduceMotion);
  const setReduceMotion = usePreferences((state) => state.setReduceMotion);
  // Read once, on mount: localStorage is impure and must not be read in render.
  const [clickBehaviour, setClickBehaviour] = useState<ClickBehaviour>(readClickBehaviour);

  const densityOptions = useMemo<readonly SegmentedOption<Density>[]>(
    () => DENSITIES.map((value) => ({ value, label: tCommon(`density.${value}`) })),
    [tCommon],
  );

  const clickOptions = useMemo<readonly ComboboxOption<ClickBehaviour>[]>(
    () =>
      CLICK_BEHAVIOURS.map((value) => ({
        value,
        label: t(`settings.appearance.click.${value}`),
      })),
    [t],
  );

  const applyDensity = (next: Density) => {
    setDensity(next);
    // Also the installation default, so a new browser starts here.
    save.mutate(
      { appearance: { density: next } },
      { onError: (error) => apiError.toastError(error, t('settings.appearance.failed')) },
    );
  };

  return (
    <SectionCard
      flush
      title={t('settings.appearance.title')}
      description={t('settings.appearance.description')}
    >
      <FormRow label={tCommon('theme.label')}>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {THEMES.map((value) => (
            <ThemeCard
              key={value}
              value={value}
              label={tCommon(`theme.${value}`)}
              selected={theme === value}
              onSelect={() => setTheme(value)}
            />
          ))}
        </div>
      </FormRow>

      <FormRow label={tCommon('density.label')} hint={t('settings.appearance.densityHint')}>
        <SegmentedControl
          options={densityOptions}
          value={density}
          onValueChange={applyDensity}
          aria-label={tCommon('density.label')}
        />
      </FormRow>

      <FormRow
        label={t('settings.appearance.reduceMotion')}
        hint={t('settings.appearance.reduceMotionHint')}
      >
        <Switch
          checked={reduceMotion}
          onCheckedChange={setReduceMotion}
          aria-label={t('settings.appearance.reduceMotion')}
        />
      </FormRow>

      <FormRow
        label={t('settings.appearance.openObjects')}
        hint={t('settings.appearance.openObjectsHint')}
      >
        <Combobox
          options={clickOptions}
          value={clickBehaviour}
          onValueChange={(value) => {
            if (value === null) return;
            setClickBehaviour(value);
            writeClickBehaviour(value);
            toast.success(t('settings.appearance.clickSaved'));
          }}
          className="sm:w-64"
          aria-label={t('settings.appearance.openObjects')}
        />
      </FormRow>
    </SectionCard>
  );
}

/**
 * The concept's miniature window: a sidebar, a title bar and two cards, in the
 * theme's own colours. It is drawn from tokens rather than a screenshot so it
 * cannot go stale when the palette changes.
 */
function ThemeCard({
  value,
  label,
  selected,
  onSelect,
}: {
  readonly value: Theme;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const dark = value === 'dark';
  const system = value === 'system';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-2.5 text-start transition-[border-color,box-shadow]',
        'hover:border-foreground/20',
        selected && 'border-primary shadow-[0_0_0_1px_var(--primary)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid aspect-[16/10] w-full grid-cols-[28%_1fr] overflow-hidden rounded-md border',
          system && 'bg-gradient-to-br from-transparent from-50% to-neutral-900 to-50%',
        )}
      >
        <span
          className={cn(
            'flex flex-col gap-[10%] border-e p-[12%]',
            system ? 'border-neutral-500/25' : dark ? 'border-white/10 bg-neutral-900' : 'border-neutral-200 bg-neutral-50',
          )}
        >
          <span className="h-[6%] min-h-[3px] w-[70%] rounded-[2px] bg-primary" />
          <span
            className={cn(
              'h-[6%] min-h-[3px] rounded-[2px]',
              system ? 'bg-neutral-500/40' : dark ? 'bg-neutral-700' : 'bg-neutral-200',
            )}
          />
          <span
            className={cn(
              'h-[6%] min-h-[3px] rounded-[2px]',
              system ? 'bg-neutral-500/40' : dark ? 'bg-neutral-700' : 'bg-neutral-200',
            )}
          />
        </span>
        <span
          className={cn(
            'flex flex-col gap-[8%] p-[10%]',
            system ? '' : dark ? 'bg-neutral-950' : 'bg-white',
          )}
        >
          <span
            className={cn(
              'h-[12%] w-[55%] rounded-[3px]',
              system ? 'bg-neutral-500/40' : dark ? 'bg-neutral-700' : 'bg-neutral-200',
            )}
          />
          <span
            className={cn(
              'flex-1 rounded-[3px] border',
              system
                ? 'border-neutral-500/25 bg-neutral-500/15'
                : dark
                  ? 'border-white/10 bg-neutral-900'
                  : 'border-neutral-200 bg-white',
            )}
          />
        </span>
      </span>
      <span className="text-[0.8125rem] font-medium">{label}</span>
    </button>
  );
}
