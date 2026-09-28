import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The concept's `.dl`: a two-column label/value list that collapses to one column
 * on a narrow screen. Used by the bucket's General section and the object
 * inspector, which draw exactly the same list.
 */
export interface DefinitionRow {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** Identifiers, keys and ARNs: monospaced and always left-to-right. */
  readonly mono?: boolean;
}

export function DefinitionList({
  rows,
  className,
}: {
  readonly rows: readonly DefinitionRow[];
  readonly className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]',
        className,
      )}
    >
      {rows.map((row, index) => (
        // The label is the key only when it is a string; a rendered label can
        // repeat across rows, so the index is part of the key.
        <div key={`${typeof row.label === 'string' ? row.label : 'row'}-${String(index)}`} className="grid gap-x-6 sm:col-span-2 sm:grid-cols-subgrid">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={cn('min-w-0 break-words', row.mono === true && 'ltr-isolate font-mono')}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
