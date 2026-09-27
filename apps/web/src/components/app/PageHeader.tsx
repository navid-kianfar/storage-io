import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The heading block every page starts with: eyebrow, title, description on the
 * inline-start, actions on the inline-end, wrapping on narrow screens.
 * Reproduces `.page-head` / `.page-title` / `.page-desc` from the concept.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('mb-(--gap-lg) flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <div className="font-mono text-[0.6875rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-(length:--h1) font-semibold tracking-[-0.02em]">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
