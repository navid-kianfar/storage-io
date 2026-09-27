import type { ColumnDef, RowSelectionState, SortingState } from '@tanstack/react-table';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, selectionColumn } from './DataTable';
import { EmptyState } from './EmptyState';
import { Button } from '@/components/ui/button';
import { renderWithProviders } from '@/test/render';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

const ROWS: readonly Row[] = [
  { id: 'a', name: 'media-prod', size: 30 },
  { id: 'b', name: 'backups-daily', size: 20 },
  { id: 'c', name: 'logs-2026', size: 10 },
];

const COLUMNS: readonly ColumnDef<Row, unknown>[] = [
  selectionColumn<Row>(),
  { id: 'name', accessorKey: 'name', header: 'Bucket', enableSorting: false },
  { id: 'size', accessorKey: 'size', header: 'Size', enableSorting: true },
];

function Harness({
  data = ROWS,
  loading = false,
  onRowClick,
  withBulk = true,
}: {
  readonly data?: readonly Row[];
  readonly loading?: boolean;
  readonly onRowClick?: (row: Row) => void;
  readonly withBulk?: boolean;
}) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [sorting, setSorting] = useState<SortingState>([]);

  return (
    <DataTable<Row>
      aria-label="Buckets"
      columns={COLUMNS}
      data={data}
      getRowId={(row) => row.id}
      loading={loading}
      emptyState={<EmptyState title="No buckets yet" />}
      rowSelection={rowSelection}
      onRowSelectionChange={setRowSelection}
      sorting={sorting}
      onSortingChange={setSorting}
      onRowClick={onRowClick}
      bulkActions={
        withBulk
          ? ({ selectedIds }) => (
              <Button size="sm" data-testid="bulk-delete">
                Delete {selectedIds.length}
              </Button>
            )
          : undefined
      }
    />
  );
}

describe('DataTable selection', () => {
  it('shows the bulk bar with a live count once a row is selected, and hides it again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    expect(screen.queryByTestId('bulk-delete')).not.toBeInTheDocument();

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: 'Select row' });
    await user.click(rowCheckboxes[0]!);

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-delete')).toHaveTextContent('Delete 1');

    await user.click(rowCheckboxes[1]!);
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByTestId('bulk-delete')).not.toBeInTheDocument();
  });

  it('selects and clears every row from the header checkbox', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const selectAll = screen.getByRole('checkbox', { name: 'Select all rows' });
    await user.click(selectAll);
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    await user.click(selectAll);
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('does not fire the row click when the checkbox is the thing clicked', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderWithProviders(<Harness onRowClick={onRowClick} />);

    await user.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]!);
    expect(onRowClick).not.toHaveBeenCalled();

    await user.click(screen.getByText('media-prod'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });
});

describe('DataTable sorting', () => {
  it('sorts a numeric column largest-first, then reverses, then clears', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const sizeHeader = screen.getByRole('columnheader', { name: /Size/ });
    const firstNames = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent ?? '');

    // A numeric column sorts descending first — biggest bucket at the top — and the
    // header's accessible name always names the action the next click performs.
    await user.click(within(sizeHeader).getByRole('button', { name: 'Sort descending' }));
    expect(firstNames()[0]).toContain('media-prod');

    await user.click(within(sizeHeader).getByRole('button', { name: 'Sort ascending' }));
    expect(firstNames()[0]).toContain('logs-2026');

    await user.click(within(sizeHeader).getByRole('button', { name: 'Clear sort' }));
    expect(firstNames()[0]).toContain('media-prod');
  });
});

describe('DataTable loading and empty states', () => {
  it('renders skeleton rows instead of the empty state while loading', () => {
    renderWithProviders(<Harness data={[]} loading />);
    expect(screen.queryByText('No buckets yet')).not.toBeInTheDocument();
    // Header row plus the skeleton rows.
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('renders the empty state when there is nothing and nothing is loading', () => {
    renderWithProviders(<Harness data={[]} />);
    expect(screen.getByText('No buckets yet')).toBeInTheDocument();
  });
});
