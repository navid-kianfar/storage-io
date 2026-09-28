import { useVirtualizer } from '@tanstack/react-virtual';
import { EllipsisIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
import { Checkbox } from '@/components/app/Checkbox';
import { Bytes, DateTime } from '@/components/app/Format';
import { Spinner } from '@/components/app/Spinner';
import { cn } from '@/lib/utils';
import { KIND_ICONS, KIND_TINTS } from '../fileKind';
import type { Entry } from '../entries';

/**
 * The object listing: one row per folder or object, windowed.
 *
 * Why not `DataTable`: cursor pagination appends, so after a few "load more" steps a
 * busy prefix holds thousands of rows, and `DataTable` renders every row it is
 * given. This is the one list in the app that windows its rows, with
 * `@tanstack/react-virtual` 3.14.
 *
 * Why ARIA roles on divs rather than a real `<table>`: a virtualized row is
 * absolutely positioned inside a sized spacer, which a table's own layout
 * algorithm fights. The roles give a screen reader the same structure a table
 * would, and the column widths stay under this component's control.
 *
 * The scroll container is this component's own, which is what drives the
 * "infinite" part of the loading: reaching the end of the window fetches the next
 * cursor page.
 */

const ROW_HEIGHT = 48;
const GRID_ROW_HEIGHT = 152;
const GRID_MIN_CARD = 176;
const DEFAULT_COLUMNS = 4;
const OVERSCAN = 8;
const LOAD_MORE_THRESHOLD = 6;

export type ListingView = 'list' | 'grid';

export interface ObjectListingProps {
  readonly entries: readonly Entry[];
  readonly view: ListingView;
  readonly selected: ReadonlySet<string>;
  readonly activeId: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
  readonly onToggle: (id: string, selected: boolean) => void;
  /** Shift-click selects every row between the last click and this one. */
  readonly onRangeTo: (id: string) => void;
  readonly onActivate: (entry: Entry) => void;
  readonly onOpen: (entry: Entry) => void;
  readonly onMenu: (entry: Entry, at: { readonly x: number; readonly y: number }) => void;
  readonly emptyState: ReactNode;
}

export function ObjectListing({
  entries,
  view,
  selected,
  activeId,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onToggle,
  onRangeTo,
  onActivate,
  onOpen,
  onMenu,
  emptyState,
}: ObjectListingProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(scrollRef, view);

  const rowCount = view === 'list' ? entries.length : Math.ceil(entries.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (view === 'list' ? ROW_HEIGHT : GRID_ROW_HEIGHT),
    overscan: OVERSCAN,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.at(-1)?.index ?? 0;

  useEffect(() => {
    if (!hasMore || loadingMore || rowCount === 0) return;
    if (lastRendered < rowCount - LOAD_MORE_THRESHOLD) return;
    onLoadMore();
  }, [hasMore, loadingMore, lastRendered, rowCount, onLoadMore]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center" aria-busy="true">
        <Spinner />
        <span className="sr-only">{tCommon('state.loading')}</span>
      </div>
    );
  }

  if (entries.length === 0) return <>{emptyState}</>;

  return (
    <>
      <div
        ref={scrollRef}
        className="max-h-[calc(100dvh-24rem)] min-h-64 overflow-auto"
        role={view === 'list' ? 'table' : 'list'}
        aria-label={t('browse.title')}
        aria-rowcount={view === 'list' ? entries.length + 1 : undefined}
      >
        {view === 'list' ? (
          <>
            <div
              role="row"
              className="sticky top-0 z-10 flex items-center border-b bg-(--table-head) text-[0.8125rem] font-medium text-muted-foreground"
              style={{ height: `${String(ROW_HEIGHT)}px` }}
            >
              <span className="w-10 shrink-0" />
              <span role="columnheader" className="grow px-3">
                {t('browse.column.name')}
              </span>
              <span role="columnheader" className="w-28 shrink-0 px-3 text-end">
                {t('browse.column.size')}
              </span>
              <span role="columnheader" className="hidden w-44 shrink-0 px-3 md:block">
                {t('browse.column.modified')}
              </span>
              <span role="columnheader" className="hidden w-36 shrink-0 px-3 lg:block">
                {t('browse.column.storageClass')}
              </span>
              <span className="w-12 shrink-0" />
            </div>

            <div style={{ height: `${String(virtualizer.getTotalSize())}px`, position: 'relative' }}>
              {virtualRows.map((virtualRow) => {
                const entry = entries[virtualRow.index];
                if (entry === undefined) return null;
                return (
                  <ListRow
                    key={entry.id}
                    entry={entry}
                    rowIndex={virtualRow.index + 2}
                    top={virtualRow.start}
                    height={virtualRow.size}
                    selected={selected.has(entry.id)}
                    active={activeId === entry.id}
                    onToggle={onToggle}
                    onRangeTo={onRangeTo}
                    onActivate={onActivate}
                    onOpen={onOpen}
                    onMenu={onMenu}
                  />
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ height: `${String(virtualizer.getTotalSize())}px`, position: 'relative' }}>
            {virtualRows.map((virtualRow) => {
              const start = virtualRow.index * columns;
              const rowEntries = entries.slice(start, start + columns);
              return (
                <div
                  key={virtualRow.key}
                  className="absolute inset-x-0 grid gap-3 px-3 pt-3"
                  style={{
                    top: `${String(virtualRow.start)}px`,
                    height: `${String(virtualRow.size)}px`,
                    gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
                  }}
                >
                  {rowEntries.map((entry) => (
                    <GridCard
                      key={entry.id}
                      entry={entry}
                      selected={selected.has(entry.id)}
                      active={activeId === entry.id}
                      onToggle={onToggle}
                      onActivate={onActivate}
                      onOpen={onOpen}
                      onMenu={onMenu}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {hasMore ? (
        <div className="flex justify-center border-t p-3">
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? <Spinner /> : null}
            {loadingMore ? t('browse.foot.loading') : t('browse.foot.loadMore')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** How many cards fit, measured rather than guessed from a breakpoint. */
function useGridColumns(scrollRef: RefObject<HTMLDivElement | null>, view: ListingView): number {
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);

  useEffect(() => {
    if (view !== 'grid') return;
    const element = scrollRef.current;
    if (element === null) return;

    const measure = () => {
      const next = Math.max(1, Math.floor(element.clientWidth / GRID_MIN_CARD));
      setColumns((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef, view]);

  return view === 'grid' ? columns : 1;
}

/* --------------------------------- one row ------------------------------- */

interface RowProps {
  readonly entry: Entry;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onToggle: (id: string, selected: boolean) => void;
  readonly onRangeTo: (id: string) => void;
  readonly onActivate: (entry: Entry) => void;
  readonly onOpen: (entry: Entry) => void;
  readonly onMenu: (entry: Entry, at: { readonly x: number; readonly y: number }) => void;
  readonly rowIndex: number;
  readonly top: number;
  readonly height: number;
}

function ListRow({
  entry,
  selected,
  active,
  onToggle,
  onRangeTo,
  onActivate,
  onOpen,
  onMenu,
  rowIndex,
  top,
  height,
}: RowProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const kind = entry.kind === 'prefix' ? 'folder' : entry.fileKind;
  const Icon = KIND_ICONS[kind];

  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onActivate(entry)}
      onDoubleClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(entry);
        if (event.key === ' ') {
          event.preventDefault();
          onActivate(entry);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onActivate(entry);
        onMenu(entry, { x: event.clientX, y: event.clientY });
      }}
      className={cn(
        'absolute inset-x-0 flex cursor-pointer items-center border-b transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        selected && 'bg-primary/7',
        active && 'bg-primary/10',
      )}
      style={{ top: `${String(top)}px`, height: `${String(height)}px` }}
    >
      <span className="flex w-10 shrink-0 justify-center">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onToggle(entry.id, checked === true)}
          onClick={(event) => {
            event.stopPropagation();
            if (event.shiftKey) onRangeTo(entry.id);
          }}
          aria-label={`${tCommon('table.selectRow')}: ${entry.name}`}
        />
      </span>

      <span role="cell" className="flex min-w-0 grow items-center gap-2.5 px-3">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-md', KIND_TINTS[kind])}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="ltr-isolate truncate text-sm font-medium">{entry.name}</span>
      </span>

      <span role="cell" className="num w-28 shrink-0 px-3 text-end text-sm text-muted-foreground">
        {entry.kind === 'prefix' ? '—' : <Bytes value={entry.object.size} />}
      </span>

      <span
        role="cell"
        className="hidden w-44 shrink-0 px-3 text-[0.8125rem] text-muted-foreground md:block"
      >
        {entry.kind === 'prefix' ? (
          '—'
        ) : (
          <DateTime value={entry.object.lastModified} style="datetime" />
        )}
      </span>

      <span role="cell" className="hidden w-36 shrink-0 px-3 lg:block">
        {entry.kind === 'prefix' ? (
          <span className="text-muted-foreground">—</span>
        ) : entry.object.deleteMarker ? (
          <Badge variant="danger">{t('browse.inspector.deleteMarker')}</Badge>
        ) : (
          <Badge variant="outline" className="ltr-isolate font-mono">
            {entry.object.storageClass ?? 'STANDARD'}
          </Badge>
        )}
      </span>

      <span className="flex w-12 shrink-0 justify-end pe-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${t('browse.row.actions')}: ${entry.name}`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onActivate(entry);
            onMenu(entry, { x: rect.right, y: rect.bottom });
          }}
        >
          <EllipsisIcon />
        </Button>
      </span>
    </div>
  );
}

/* --------------------------------- one card ------------------------------ */

function GridCard({
  entry,
  selected,
  active,
  onToggle,
  onActivate,
  onOpen,
  onMenu,
}: Omit<RowProps, 'top' | 'height' | 'rowIndex' | 'onRangeTo'>) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const kind = entry.kind === 'prefix' ? 'folder' : entry.fileKind;
  const Icon = KIND_ICONS[kind];

  return (
    <div
      role="listitem"
      tabIndex={0}
      onClick={() => onActivate(entry)}
      onDoubleClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(entry);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onActivate(entry);
        onMenu(entry, { x: event.clientX, y: event.clientY });
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        selected && 'border-primary/60 bg-primary/7',
        active && 'ring-2 ring-ring/40',
      )}
    >
      <div className="flex items-start justify-between">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onToggle(entry.id, checked === true)}
          onClick={(event) => event.stopPropagation()}
          aria-label={`${tCommon('table.selectRow')}: ${entry.name}`}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`${t('browse.row.actions')}: ${entry.name}`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onActivate(entry);
            onMenu(entry, { x: rect.right, y: rect.bottom });
          }}
        >
          <EllipsisIcon />
        </Button>
      </div>

      <span className={cn('grid size-10 place-items-center rounded-md', KIND_TINTS[kind])}>
        <Icon className="size-5" aria-hidden="true" />
      </span>

      <span className="ltr-isolate line-clamp-2 text-[0.8125rem] leading-snug font-medium">
        {entry.name}
      </span>
      <span className="num mt-auto text-xs text-muted-foreground">
        {entry.kind === 'prefix' ? t('browse.folder') : <Bytes value={entry.object.size} />}
      </span>
    </div>
  );
}
