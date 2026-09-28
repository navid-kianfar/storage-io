import type { LifecycleRule, Server } from '@storage-io/contracts';
import type { TFunction } from 'i18next';
import type { ColumnDef } from '@tanstack/react-table';
import { CopyIcon, EllipsisIcon, PencilIcon, PlusIcon, TimerIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
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
import { Switch } from '@/components/app/Switch';
import { toastProblem } from '@/lib/api/problems';
import { useBucketLifecycle, useSaveBucketLifecycle, type BucketRefParams } from '../api';
import { SectionCard, sectionAvailability } from '../components/SectionCard';
import { LifecycleRuleDialog } from '../dialogs/LifecycleRuleDialog';

/**
 * Lifecycle rules.
 *
 * `PUT …/lifecycle` takes the whole rule set, so every action here — add, edit,
 * duplicate, delete, toggle — is "the list with one thing changed", computed as a
 * new array and sent once. That is why there is no per-rule endpoint and no
 * optimistic half-state: the server's copy is always a complete set.
 */

export function LifecycleSection({
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

  const availability = sectionAvailability(server, 'lifecycle', loading);
  const lifecycle = useBucketLifecycle(bucketRef, availability === 'ready');
  const save = useSaveBucketLifecycle();

  const rules = useMemo(() => lifecycle.data?.rules ?? [], [lifecycle.data]);
  const [editing, setEditing] = useState<LifecycleRule | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function write(next: readonly LifecycleRule[], message: string): void {
    save.mutate(
      { ref: bucketRef, body: { rules: [...next] } },
      {
        onSuccess: () => {
          toast.success(message);
          setDialogOpen(false);
          setEditing(null);
        },
        onError: (error) => toastProblem(error, tCommon, t('bucket.lifecycle.saved')),
      },
    );
  }

  function upsert(rule: LifecycleRule): void {
    const exists = rules.some((existing) => existing.id === rule.id);
    const next = exists
      ? rules.map((existing) => (existing.id === rule.id ? rule : existing))
      : [...rules, rule];
    write(next, t('bucket.lifecycle.saved'));
  }

  function duplicate(rule: LifecycleRule): void {
    const base = `${rule.id}-copy`;
    let candidate = base;
    let counter = 2;
    while (rules.some((existing) => existing.id === candidate)) {
      candidate = `${base}-${String(counter)}`;
      counter += 1;
    }
    write([...rules, { ...rule, id: candidate }], t('bucket.lifecycle.saved'));
  }

  function remove(rule: LifecycleRule): void {
    const next = rules.filter((existing) => existing.id !== rule.id);
    write(next, t('bucket.lifecycle.deleted'));
  }

  function toggle(rule: LifecycleRule, enabled: boolean): void {
    const next = rules.map((existing) =>
      existing.id === rule.id ? { ...existing, enabled } : existing,
    );
    write(next, t('bucket.lifecycle.saved'));
  }

  const columns = useMemo<readonly ColumnDef<LifecycleRule, unknown>[]>(
    () => [
      {
        id: 'rule',
        header: t('bucket.lifecycle.column.rule'),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="ltr-isolate font-mono text-sm font-medium">{row.original.id}</span>
        ),
      },
      {
        id: 'scope',
        header: t('bucket.lifecycle.column.scope'),
        enableSorting: false,
        cell: ({ row }) => <ScopeBadge rule={row.original} label={t('bucket.lifecycle.wholeBucket')} />,
      },
      {
        id: 'action',
        header: t('bucket.lifecycle.column.action'),
        enableSorting: false,
        cell: ({ row }) => (
          <ul className="flex flex-col gap-0.5 text-[0.8125rem]">
            {describeRule(row.original, t).map((line) => (
              <li key={line.key}>
                {line.label}
                {line.days === null ? null : (
                  <>
                    {' · '}
                    <Num value={line.days} /> {t('bucket.versioning.days')}
                  </>
                )}
              </li>
            ))}
          </ul>
        ),
      },
      {
        id: 'enabled',
        header: t('bucket.lifecycle.column.enabled'),
        size: 90,
        enableSorting: false,
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            disabled={save.isPending}
            onCheckedChange={(checked) => toggle(row.original, checked)}
            aria-label={`${row.original.id} — ${t('bucket.lifecycle.column.enabled')}`}
          />
        ),
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
                  {t('bucket.lifecycle.menu.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => duplicate(row.original)}>
                  <CopyIcon />
                  {t('bucket.lifecycle.menu.duplicate')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => remove(row.original)}>
                  <Trash2Icon />
                  {t('bucket.lifecycle.menu.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    // `toggle`, `duplicate` and `remove` all close over `rules`, which is why the
    // rule set is a dependency of the column definitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, tCommon, rules, save.isPending],
  );

  return (
    <SectionCard
      id="lifecycle"
      title={t('bucket.lifecycle.title')}
      description={t('bucket.lifecycle.description')}
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
          {t('bucket.lifecycle.addRule')}
        </Button>
      }
    >
      <DataTable
        aria-label={t('bucket.lifecycle.title')}
        columns={columns}
        data={rules}
        getRowId={(rule) => rule.id}
        loading={lifecycle.isLoading}
        className="rounded-none border-0 border-t"
        emptyState={
          <EmptyState
            icon={TimerIcon}
            title={t('bucket.lifecycle.empty.title')}
            description={t('bucket.lifecycle.empty.description')}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <PlusIcon />
                {t('bucket.lifecycle.addRule')}
              </Button>
            }
          />
        }
      />

      <LifecycleRuleDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        rule={editing}
        existingIds={rules.map((rule) => rule.id)}
        storageClasses={undefined}
        busy={save.isPending}
        onSubmit={upsert}
      />
    </SectionCard>
  );
}

function ScopeBadge({ rule, label }: { readonly rule: LifecycleRule; readonly label: string }) {
  const tagEntries = Object.entries(rule.tags);
  if (rule.prefix !== '') {
    return (
      <Badge variant="outline" className="ltr-isolate font-mono">
        {rule.prefix}
      </Badge>
    );
  }
  if (tagEntries.length > 0) {
    return (
      <span className="flex flex-wrap gap-1">
        {tagEntries.map(([key, value]) => (
          <Badge key={key} variant="outline" className="ltr-isolate font-mono">
            {key}={value}
          </Badge>
        ))}
      </span>
    );
  }
  return <Badge variant="secondary">{label}</Badge>;
}

/** Every action a rule performs, so a row is readable without opening it. */
interface RuleAction {
  readonly key: string;
  readonly label: string;
  readonly days: number | null;
}

function describeRule(rule: LifecycleRule, t: TFunction): readonly RuleAction[] {
  const lines: RuleAction[] = [];
  if (rule.expireDays !== null) {
    lines.push({ key: 'expire', label: t('bucket.lifecycle.expire'), days: rule.expireDays });
  }
  if (rule.noncurrentExpireDays !== null) {
    lines.push({
      key: 'noncurrent',
      label: t('bucket.lifecycle.noncurrent'),
      days: rule.noncurrentExpireDays,
    });
  }
  if (rule.abortMultipartDays !== null) {
    lines.push({
      key: 'abort',
      label: t('bucket.lifecycle.abort'),
      days: rule.abortMultipartDays,
    });
  }
  if (rule.transition !== null) {
    lines.push({
      key: 'transition',
      label: t('bucket.lifecycle.transition', { storageClass: rule.transition.storageClass }),
      days: rule.transition.days,
    });
  }
  if (rule.expiredDeleteMarkers) {
    lines.push({ key: 'markers', label: t('bucket.lifecycle.expiredDeleteMarkers'), days: null });
  }
  if (lines.length === 0) {
    lines.push({ key: 'none', label: t('bucket.lifecycle.noAction'), days: null });
  }
  return lines;
}
