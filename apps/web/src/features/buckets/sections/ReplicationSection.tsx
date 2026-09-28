import type { ReplicationRule, Server } from '@storage-io/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { EllipsisIcon, PencilIcon, PlusIcon, RepeatIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/app/Alert';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
import { CardContent } from '@/components/app/Card';
import { DataTable } from '@/components/app/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/app/DropdownMenu';
import { EmptyState } from '@/components/app/EmptyState';
import { Num } from '@/components/app/Format';
import { StatusDot } from '@/components/app/StatusBadge';
import { toastProblem } from '@/lib/api/problems';
import { useBucketReplication, useSaveBucketReplication, type BucketRefParams } from '../api';
import { SectionCard, sectionAvailability } from '../components/SectionCard';
import { ReplicationRuleDialog } from '../dialogs/ReplicationRuleDialog';

/**
 * Replication rules. Like lifecycle, `PUT …/replication` takes the whole set, so
 * every action recomputes the array and sends it once.
 *
 * The concept also drew a lag and a pending count per rule. The contract carries
 * neither — `bucketReplicationResponseSchema` has `rules` and one overall
 * `status` — so this shows the rule's own state and the server's status line
 * rather than inventing numbers.
 */
export function ReplicationSection({
  bucketRef,
  server,
  loading,
}: {
  readonly bucketRef: BucketRefParams;
  readonly server: Server | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  const availability = sectionAvailability(server, 'replication', loading);
  const replication = useBucketReplication(bucketRef, availability === 'ready');
  const save = useSaveBucketReplication();

  const rules = useMemo(() => replication.data?.rules ?? [], [replication.data]);
  const [editing, setEditing] = useState<ReplicationRule | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function write(next: readonly ReplicationRule[]): void {
    save.mutate(
      { ref: bucketRef, body: { rules: [...next] } },
      {
        onSuccess: () => {
          toast.success(t('bucket.replication.saved'));
          setDialogOpen(false);
          setEditing(null);
        },
        onError: (error) => toastProblem(error, tCommon, t('bucket.replication.saved')),
      },
    );
  }

  function upsert(rule: ReplicationRule): void {
    const exists = rules.some((existing) => existing.id === rule.id);
    write(exists ? rules.map((existing) => (existing.id === rule.id ? rule : existing)) : [...rules, rule]);
  }

  const columns = useMemo<readonly ColumnDef<ReplicationRule, unknown>[]>(
    () => [
      {
        id: 'destination',
        header: t('bucket.replication.column.destination'),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="ltr-isolate font-mono text-sm font-medium">{row.original.id}</span>
            <span className="ltr-isolate font-mono text-xs text-muted-foreground">
              {row.original.destination.bucketArn}
            </span>
          </div>
        ),
      },
      {
        id: 'scope',
        header: t('bucket.replication.column.scope'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.prefix === '' ? (
            <Badge variant="secondary">{t('bucket.lifecycle.wholeBucket')}</Badge>
          ) : (
            <Badge variant="outline" className="ltr-isolate font-mono">
              {row.original.prefix}
            </Badge>
          ),
      },
      {
        id: 'status',
        header: t('bucket.replication.column.status'),
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={row.original.enabled ? 'success' : 'secondary'}>
            <StatusDot tone={row.original.enabled ? 'ok' : 'muted'} />
            {row.original.enabled ? t('bucket.replication.enabled') : t('bucket.replication.disabled')}
          </Badge>
        ),
      },
      {
        id: 'priority',
        header: t('bucket.replication.column.priority'),
        enableSorting: false,
        cell: ({ row }) => <Num value={row.original.priority} />,
      },
      {
        id: 'actions',
        size: 48,
        enableSorting: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={tCommon('table.rowActions')}>
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setEditing(row.original);
                    setDialogOpen(true);
                  }}
                >
                  <PencilIcon />
                  {tCommon('action.edit')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => write(rules.filter((rule) => rule.id !== row.original.id))}
                >
                  <Trash2Icon />
                  {tCommon('action.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    // `write` closes over `rules`, so the set is part of what defines a column.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, tCommon, rules],
  );

  return (
    <SectionCard
      id="replication"
      title={t('bucket.replication.title')}
      description={t('bucket.replication.description')}
      availability={availability}
      provider={server?.provider}
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <PlusIcon />
          {t('bucket.replication.addRule')}
        </Button>
      }
    >
      <DataTable
        aria-label={t('bucket.replication.title')}
        columns={columns}
        data={rules}
        getRowId={(rule) => rule.id}
        loading={replication.isLoading}
        className="rounded-none border-0 border-t"
        emptyState={
          <EmptyState
            icon={RepeatIcon}
            title={t('bucket.replication.empty.title')}
            description={t('bucket.replication.empty.description')}
          />
        }
      />

      <CardContent>
        <Alert variant="info">
          <AlertTitle>{t('bucket.replication.onlyNewTitle')}</AlertTitle>
          <AlertDescription>
            {t('bucket.replication.onlyNewDetail')}
            {replication.data?.status == null ? null : ` · ${replication.data.status}`}
          </AlertDescription>
        </Alert>
      </CardContent>

      <ReplicationRuleDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        rule={editing}
        existingIds={rules.map((rule) => rule.id)}
        busy={save.isPending}
        onSubmit={upsert}
      />
    </SectionCard>
  );
}
