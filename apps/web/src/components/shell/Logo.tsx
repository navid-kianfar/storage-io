import { cn } from '@/lib/utils';

/**
 * The storage-io mark: a stacked-disc glyph in a rounded square. Copied from the
 * concept so the sidebar, the login art panel and the favicon agree.
 *
 * Colours are props rather than tokens because the login panel draws it on its own
 * dark gradient, where the sidebar tokens do not apply.
 */
export function Logo({
  className,
  tileFill = 'var(--sidebar-primary)',
  strokeColor = 'var(--sidebar)',
}: {
  readonly className?: string;
  readonly tileFill?: string;
  readonly strokeColor?: string;
}) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-7 shrink-0', className)}>
      <rect width="32" height="32" rx="8" fill={tileFill} />
      <g fill="none" stroke={strokeColor} strokeWidth="2.3" strokeLinecap="round">
        <ellipse cx="16" cy="10" rx="7" ry="2.8" />
        <path d="M9 10v11.5c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V10" />
        <path d="M9 15.8c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8" />
      </g>
    </svg>
  );
}
