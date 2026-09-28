import type { ReactNode } from 'react';
import {
  Card as CardPrimitive,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The concept's `.card`. The primitives are re-exported so a page composes them
 * the way the concept draws them, and {@link SectionCard} covers the shape that
 * repeats on almost every screen: a title, an optional description, an action on
 * the inline-end, and a body.
 *
 * `flush` is the concept's `.card-flush`: a body that runs to the card's edges
 * because it holds a list or a table with its own padding.
 */
export const Card = CardPrimitive;
export { CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };

export function SectionCard({
  title,
  description,
  action,
  children,
  footer,
  flush = false,
  className,
  bodyClassName,
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Rendered on the inline-end of the header — a "View all" link, a refresh button. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  /** The body runs edge to edge (a list, a table). */
  readonly flush?: boolean;
  readonly className?: string;
  readonly bodyClassName?: string;
}) {
  return (
    <Card className={cn('gap-0 overflow-hidden py-0', className)}>
      {title === undefined && action === undefined ? null : (
        <CardHeader className="flex-row items-start gap-3 border-b px-(--card-pad) py-(--card-pad) [.border-b]:pb-(--card-pad)">
          <div className="min-w-0 flex-1">
            {title === undefined ? null : <CardTitle className="text-sm">{title}</CardTitle>}
            {description === undefined ? null : (
              <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>
            )}
          </div>
          {action === undefined ? null : (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">{action}</div>
          )}
        </CardHeader>
      )}
      <CardContent className={cn(flush ? 'px-0 py-0' : 'p-(--card-pad)', bodyClassName)}>
        {children}
      </CardContent>
      {footer === undefined ? null : (
        <CardFooter className="flex-wrap items-center gap-2 border-t px-(--card-pad) py-3">
          {footer}
        </CardFooter>
      )}
    </Card>
  );
}

/** The concept's `.list-row`: an icon, a two-line body and a trailing value. */
export function ListRow({
  media,
  title,
  subtitle,
  trailing,
  className,
}: {
  readonly media?: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b px-(--card-pad) py-2.5 last:border-b-0',
        className,
      )}
    >
      {media === undefined ? null : <span className="shrink-0">{media}</span>}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.8125rem] font-medium">{title}</span>
        {subtitle === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {trailing === undefined ? null : <span className="shrink-0 text-xs">{trailing}</span>}
    </div>
  );
}
