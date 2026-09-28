import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The concept's `.tile`: a square shortcut with an icon tile above its label —
 * the dashboard's quick actions and the first-run wizard's "what next" grid.
 *
 * It renders whatever `as` is given, because half of these are links (a route)
 * and half are buttons (a dialog). A `<Link>` is passed in by the page rather
 * than imported here, so this file stays router-agnostic.
 */
export function Tile({
  icon: Icon,
  label,
  description,
  onClick,
  disabled = false,
  asChild,
  className,
}: {
  readonly icon: LucideIcon;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  /** A `<Link>` or `<a>` that wraps the tile's own content. */
  readonly asChild?: (content: ReactNode, className: string) => ReactNode;
  readonly className?: string;
}) {
  const shape = cn(
    'flex flex-col items-start gap-2 rounded-lg border bg-card p-3.5 text-start transition-[border-color,background-color,box-shadow]',
    'hover:border-foreground/20 hover:bg-accent/40',
    'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
    disabled && 'pointer-events-none opacity-50',
    className,
  );

  const content = (
    <>
      <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="text-[0.8125rem] font-medium">{label}</span>
      {description === undefined ? null : (
        <span className="text-xs text-muted-foreground">{description}</span>
      )}
    </>
  );

  if (asChild) return asChild(content, shape);

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={shape}>
      {content}
    </button>
  );
}
