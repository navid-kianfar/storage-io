import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type PaginationState,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Table as TanStackTable,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  Settings2Icon,
  XIcon,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The app's table. TanStack Table for the model, the shadcn Table primitives for
 * the markup, and the concept's chrome around it: a toolbar, a bulk-action bar
 * that replaces the toolbar while rows are selected, a columns menu, a loading
 * skeleton, an empty state, and server-side pagination.
 *
 * What it deliberately does NOT do: fetch. The page owns the query, passes
 * `data`, `total`, `loading` and the pagination state, and this renders it. That
 * keeps every list page's data flow visible in the page rather than hidden here.
 *
 * Selection, sorting and pagination are *controlled*, so they can live in the URL
 * (and therefore in a bookmark, a shared link and the Back button).
 */

const SKELETON_ROWS = 8;
const SELECT_COLUMN_ID = 'select';
export const DEFAULT_PAGE_SIZE = 50;

export interface DataTableProps<TData> {
  readonly columns: readonly ColumnDef<TData, unknown>[];
  readonly data: readonly TData[];
  /** Stable row id — required, because selection survives a refetch by id. */
  readonly getRowId: (row: TData) => string;

  readonly loading?: boolean;
  /** Rendered instead of the rows when `data` is empty and not loading. */
  readonly emptyState?: ReactNode;

  readonly sorting?: SortingState;
  readonly onSortingChange?: OnChangeFn<SortingState>;

  readonly rowSelection?: RowSelectionState;
  readonly onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  /** Rendered in the bar that replaces the toolbar while rows are selected. */
  readonly bulkActions?: (context: BulkActionContext<TData>) => ReactNode;

  readonly columnVisibility?: VisibilityState;
  readonly onColumnVisibilityChange?: OnChangeFn<VisibilityState>;
  /** Shows the columns menu in the toolbar. */
  readonly showColumnsMenu?: boolean;

  /** Server pagination: `pageIndex` is 0-based here and `page` is 1-based on the wire. */
  readonly pagination?: PaginationState;
  readonly onPaginationChange?: OnChangeFn<PaginationState>;
  readonly total?: number;

  readonly onRowClick?: (row: TData) => void;
  /** Marks the row the detail pane is showing (the concept's `.is-active`). */
  readonly activeRowId?: string;

  /** Filters, search, view switches — the inline-start of the toolbar. */
  readonly toolbar?: ReactNode;
  /** Export, refresh — the inline-end of the toolbar, before the columns menu. */
  readonly toolbarActions?: ReactNode;

  readonly className?: string;
  readonly 'aria-label': string;
}

export interface BulkActionContext<TData> {
  readonly selectedIds: readonly string[];
  readonly selectedRows: readonly TData[];
  readonly clearSelection: () => void;
}

/**
 * The selection column, ready to spread into a column list. Kept here so every
 * table's checkbox column has the same id, width and accessible names.
 */
export function selectionColumn<TData>(): ColumnDef<TData, unknown> {
  return {
    id: SELECT_COLUMN_ID,
    size: 40,
    enableSorting: false,
    enableHiding: false,
    header: ({ table }) => <SelectAllCheckbox table={table} />,
    cell: ({ row }) => <SelectRowCheckbox row={row} />,
  };
}

function SelectAllCheckbox<TData>({ table }: { readonly table: TanStackTable<TData> }) {
  const { t } = useTranslation();
  const allSelected = table.getIsAllPageRowsSelected();
  const someSelected = table.getIsSomePageRowsSelected();
  return (
    <Checkbox
      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
      onCheckedChange={(checked) => table.toggleAllPageRowsSelected(checked === true)}
      aria-label={t('table.selectAllRows')}
    />
  );
}

function SelectRowCheckbox<TData>({ row }: { readonly row: Row<TData> }) {
  const { t } = useTranslation();
  return (
    <Checkbox
      checked={row.getIsSelected()}
      disabled={!row.getCanSelect()}
      onCheckedChange={(checked) => row.toggleSelected(checked === true)}
      aria-label={t('table.selectRow')}
      // A click on the checkbox must not also trigger the row's own click.
      onClick={(event) => event.stopPropagation()}
    />
  );
}

export function DataTable<TData>({
  columns,
  data,
  getRowId,
  loading = false,
  emptyState,
  sorting,
  onSortingChange,
  rowSelection,
  onRowSelectionChange,
  bulkActions,
  columnVisibility,
  onColumnVisibilityChange,
  showColumnsMenu = false,
  pagination,
  onPaginationChange,
  total,
  onRowClick,
  activeRowId,
  toolbar,
  toolbarActions,
  className,
  'aria-label': ariaLabel,
}: DataTableProps<TData>) {
  const { t } = useTranslation();

  const rows = useMemo(() => [...data], [data]);
  const columnList = useMemo(() => [...columns], [columns]);

  const manualPagination = pagination !== undefined;
  const pageCount =
    manualPagination && total !== undefined
      ? Math.max(1, Math.ceil(total / Math.max(1, pagination.pageSize)))
      : undefined;

  const table = useReactTable<TData>({
    data: rows,
    columns: columnList,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    // Sorting is server-side whenever the caller controls pagination too:
    // sorting one page of a paginated list would be wrong.
    getSortedRowModel: manualPagination ? undefined : getSortedRowModel(),
    manualSorting: manualPagination,
    manualPagination,
    pageCount,
    enableRowSelection: rowSelection !== undefined,
    state: {
      ...(sorting === undefined ? {} : { sorting }),
      ...(rowSelection === undefined ? {} : { rowSelection }),
      ...(columnVisibility === undefined ? {} : { columnVisibility }),
      ...(pagination === undefined ? {} : { pagination }),
    },
    onSortingChange,
    onRowSelectionChange,
    onColumnVisibilityChange,
    onPaginationChange,
  });

  const selectedRowModel = table.getSelectedRowModel().rows;
  const selectionCount = selectedRowModel.length;
  const hasSelection = selectionCount > 0;

  const bulkContext: BulkActionContext<TData> = {
    selectedIds: selectedRowModel.map((row) => row.id),
    selectedRows: selectedRowModel.map((row) => row.original),
    clearSelection: () => table.resetRowSelection(),
  };

  const visibleColumnCount = table.getVisibleLeafColumns().length;
  const showEmptyState = !loading && rows.length === 0;

  return (
    <div className={cn('overflow-hidden rounded-lg border bg-card', className)}>
      {hasSelection && bulkActions !== undefined ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-primary/7 px-2.5 py-2">
          <span className="num ps-1 pe-2 text-sm font-semibold">
            {t('table.rowsSelected', { count: selectionCount })}
          </span>
          {bulkActions(bulkContext)}
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto"
            onClick={bulkContext.clearSelection}
          >
            <XIcon />
            {t('table.clearSelection')}
          </Button>
        </div>
      ) : toolbar !== undefined || toolbarActions !== undefined || showColumnsMenu ? (
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          {toolbar}
          <div className="ms-auto flex items-center gap-2">
            {toolbarActions}
            {showColumnsMenu ? <ColumnsMenu table={table} /> : null}
          </div>
        </div>
      ) : null}

      <div className="relative max-h-[calc(100dvh-18rem)] overflow-auto">
        <Table aria-label={ariaLabel}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDirection = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      style={
                        header.column.columnDef.size === undefined
                          ? undefined
                          : { width: header.getSize() }
                      }
                      className={header.column.id === SELECT_COLUMN_ID ? 'pe-0' : undefined}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="-mx-1 inline-flex items-center gap-1 rounded-xs px-1 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                          // The label states what the *next* click does. Never assume
                          // that is ascending: TanStack sorts a numeric column
                          // descending first, which is right for a Size column and
                          // would make a hard-coded "Sort ascending" a lie.
                          aria-label={sortActionLabel(header.column.getNextSortingOrder(), t)}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sortDirection === 'asc' ? (
                            <ArrowUpIcon className="size-3.5" />
                          ) : sortDirection === 'desc' ? (
                            <ArrowDownIcon className="size-3.5" />
                          ) : (
                            <ChevronsUpDownIcon className="size-3.5 opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {loading
              ? Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
                  <TableRow key={`skeleton-${rowIndex}`} className="hover:bg-transparent">
                    {Array.from({ length: visibleColumnCount }, (_unused, cellIndex) => (
                      <TableCell key={`skeleton-${rowIndex}-${cellIndex}`}>
                        <Skeleton className="h-4 w-full max-w-40" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : showEmptyState
                ? null
                : table.getRowModel().rows.map((row) => (
                    <TableRow
                      key={row.id}
                      data-state={row.getIsSelected() ? 'selected' : undefined}
                      data-active={row.id === activeRowId ? 'true' : undefined}
                      onClick={
                        onRowClick === undefined ? undefined : () => onRowClick(row.original)
                      }
                      className={cn(
                        onRowClick !== undefined && 'cursor-pointer',
                        'data-[active=true]:bg-primary/10',
                      )}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={cell.column.id === SELECT_COLUMN_ID ? 'pe-0' : undefined}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
          </TableBody>
        </Table>

        {showEmptyState ? <div className="border-t">{emptyState}</div> : null}
      </div>

      {manualPagination ? (
        <DataTablePagination table={table} total={total ?? 0} pagination={pagination} />
      ) : null}
    </div>
  );
}

type Translate = (key: string) => string;

/** `false` from `getNextSortingOrder()` means the next click clears the sort. */
function sortActionLabel(next: 'asc' | 'desc' | false, t: Translate): string {
  if (next === 'asc') return t('table.sortAscending');
  if (next === 'desc') return t('table.sortDescending');
  return t('table.noSort');
}

function ColumnsMenu<TData>({ table }: { readonly table: TanStackTable<TData> }) {
  const { t } = useTranslation();
  const hideable = table.getAllLeafColumns().filter((column) => column.getCanHide());
  if (hideable.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2Icon />
          {t('table.columns')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{t('table.toggleColumns')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideable.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(checked) => column.toggleVisibility(checked)}
            onSelect={(event) => event.preventDefault()}
          >
            {columnLabel(column.id, column.columnDef.header)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A header can be a render function; fall back to the id when it is. */
function columnLabel(id: string, header: unknown): string {
  return typeof header === 'string' ? header : id;
}

function DataTablePagination<TData>({
  table,
  total,
  pagination,
}: {
  readonly table: TanStackTable<TData>;
  readonly total: number;
  readonly pagination: PaginationState;
}) {
  const { t } = useTranslation();
  const from = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const to = Math.min(total, (pagination.pageIndex + 1) * pagination.pageSize);
  const pageCount = table.getPageCount();

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-[0.8125rem] text-muted-foreground">
      <span className="num">{t('table.showingRange', { from, to, total })}</span>
      <div className="flex items-center gap-2">
        <span className="num">
          {t('table.pageOf', { page: pagination.pageIndex + 1, pages: pageCount })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('table.firstPage')}
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.setPageIndex(0)}
          >
            <ChevronsLeftIcon className="flip-rtl" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('table.previousPage')}
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeftIcon className="flip-rtl" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('table.nextPage')}
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRightIcon className="flip-rtl" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('table.lastPage')}
            disabled={!table.getCanNextPage()}
            onClick={() => table.setPageIndex(pageCount - 1)}
          >
            <ChevronsRightIcon className="flip-rtl" />
          </Button>
        </div>
      </div>
    </div>
  );
}
