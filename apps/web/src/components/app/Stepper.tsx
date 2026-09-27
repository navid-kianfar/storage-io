import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The wizard pattern from the concept (`.steps` + `[data-step]`): the first-run
 * setup, Add server, New job.
 *
 * `useStepper` owns the index and what may be left; `<StepList>` draws the
 * numbered rail and `<StepperNav>` the Back / Next footer. Panels are rendered by
 * the caller, so each step keeps its own form state and validation.
 */

export interface StepDefinition {
  readonly id: string;
  readonly label: ReactNode;
  /** False blocks Next — a step whose form is not valid yet. */
  readonly canContinue?: boolean;
}

export interface StepperApi {
  readonly steps: readonly StepDefinition[];
  readonly index: number;
  readonly current: StepDefinition;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly canContinue: boolean;
  next: () => void;
  back: () => void;
  /** Only backwards, or to a step already completed: no skipping ahead. */
  goTo: (index: number) => void;
}

export function useStepper(steps: readonly StepDefinition[]): StepperApi {
  const [index, setIndex] = useState(0);
  const lastIndex = steps.length - 1;
  const current = steps[Math.min(index, lastIndex)];
  if (current === undefined) throw new Error('useStepper needs at least one step.');

  const canContinue = current.canContinue ?? true;

  const next = useCallback(() => {
    setIndex((value) => Math.min(lastIndex, value + 1));
  }, [lastIndex]);

  const back = useCallback(() => {
    setIndex((value) => Math.max(0, value - 1));
  }, []);

  const goTo = useCallback((target: number) => {
    setIndex((value) => (target <= value ? Math.max(0, target) : value));
  }, []);

  return useMemo(
    () => ({
      steps,
      index,
      current,
      isFirst: index === 0,
      isLast: index === lastIndex,
      canContinue,
      next,
      back,
      goTo,
    }),
    [steps, index, current, lastIndex, canContinue, next, back, goTo],
  );
}

export function StepList({
  stepper,
  className,
}: {
  readonly stepper: StepperApi;
  readonly className?: string;
}) {
  return (
    <ol className={cn('flex flex-wrap items-center gap-2', className)}>
      {stepper.steps.map((step, position) => {
        const done = position < stepper.index;
        const active = position === stepper.index;
        return (
          <li
            key={step.id}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 text-[0.8125rem] whitespace-nowrap',
              active
                ? 'font-medium text-foreground'
                : done
                  ? 'text-foreground'
                  : 'text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold',
                active && 'border-primary bg-primary text-primary-foreground',
                done && 'border-transparent bg-primary/15 text-primary',
                !active && !done && 'bg-background',
              )}
            >
              {done ? <CheckIcon className="size-3.5" /> : position + 1}
            </span>
            {step.label}
            {position < stepper.steps.length - 1 ? (
              <span aria-hidden="true" className="h-px w-6 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Renders only the panel of the current step, so hidden steps keep their state mounted-free. */
export function StepPanels({
  stepper,
  panels,
}: {
  readonly stepper: StepperApi;
  readonly panels: Readonly<Record<string, ReactNode>>;
}) {
  return <>{panels[stepper.current.id] ?? null}</>;
}

export function StepperNav({
  stepper,
  onFinish,
  finishLabel,
  nextLabel,
  busy = false,
  extra,
  className,
}: {
  readonly stepper: StepperApi;
  readonly onFinish: () => void;
  readonly finishLabel?: ReactNode;
  readonly nextLabel?: ReactNode;
  readonly busy?: boolean;
  /** Something between Back and Next — "Skip", a test button. */
  readonly extra?: ReactNode;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button
        type="button"
        variant="outline"
        onClick={stepper.back}
        disabled={stepper.isFirst || busy}
      >
        <ArrowLeftIcon className="flip-rtl" />
        {t('action.back')}
      </Button>
      {extra}
      <Button
        type="button"
        className="ms-auto"
        disabled={!stepper.canContinue || busy}
        onClick={stepper.isLast ? onFinish : stepper.next}
      >
        {stepper.isLast ? (finishLabel ?? t('action.finish')) : (nextLabel ?? t('action.next'))}
        {stepper.isLast ? null : <ArrowRightIcon className="flip-rtl" />}
      </Button>
    </div>
  );
}
