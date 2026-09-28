import type { Bucket, Server } from '@storage-io/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import {
  ArrowRightIcon,
  DatabaseIcon,
  EllipsisIcon,
  FolderOpenIcon,
  GaugeIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  SearchIcon,
  Settings2Icon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Badge,
  Bytes,
  Button,
  DEFAULT_PAGE_SIZE,
  DataTable,
  Dash,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Meter,
  Num,
  Pct,
  RelativeTime,
  SectionCard,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  meterToneFor,
} from '@/components/app';
import { useServerBuckets } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { useDialogs } from '@/lib/dialogs/useDialogs';

/**
 * The buckets that live on this server, largest first. It is deliberately a
 * narrower view than `/buckets`: no cross-server columns, no bulk actions — the
 * toolbar's "All buckets" link is where those belong, and duplicating them here
 * would be two implementations of the same screen.
 *
 * Quota editing opens the `edit-quota` dialog by URL, which `/quotas` owns, so the
 * same dialog serves both places.
 */
export function ServerBucketsTab({ server }: { readonly server: Server }) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const apiError = useApiError();

  const [query, setQuery] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const buckets = useServerBuckets(server.id, {
    q: query,
    page: pagination.pageIndex + 1,
    pageSize: pagination.pageSize,
    sort: 'size',
    enabled: true,
  });

  const copyUri = useCallback(
    (bucket: Bucket) => {
      const write = async () => {
        await navigator.clipboard.writeText(`s3://${bucket.name}`);
        toast.success(tCommon('action.copied'), { description: `s3://${bucket.name}` });
      };
      write().catch(() => toast.error(tCommon('error.unexpected')));
    },
    [tCommon],
  );

  const columns = useMemo<readonly ColumnDef<Bucket, unknown>[]>(
    () => [
      {
        id: 'name',
        header: () => t('server.buckets.bucket'),
        cell: ({ row }) => {
          const bucket = row.original;
          return (
            <div className="flex items-center gap-2">
              <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate font-mono text-[0.8125rem] font-medium">{bucket.name}</span>
              {bucket.objectLock ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>{tDomain('capability.objectLock')}</TooltipContent>
                </Tooltip>
              ) : null}
              {bucket.access === 'public-read' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <GlobeIcon className="size-3.5 shrink-0 text-warning" />
                  </TooltipTrigger>
                  <TooltipContent>{tDomain('access.public-read')}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'size',
        header: () => t('server.buckets.size'),
        cell: ({ row }) => <Bytes value={row.original.sizeBytes} />,
      },
      {
        id: 'objects',
        header: () => t('server.buckets.objects'),
        cell: ({ row }) => <Num value={row.original.objects} compact />,
      },
      {
        id: 'quota',
        size: 180,
        header: () => t('server.buckets.quota'),
        cell: ({ row }) => {
          const bucket = row.original;
          if (bucket.quota === null) {
            return <span className="text-xs text-muted-foreground">{tCommon('meter.noQuota')}</span>;
          }
          const ratio =
            bucket.sizeBytes === null || bucket.quota.limitBytes === 0
              ? null
              : bucket.sizeBytes / bucket.quota.limitBytes;
          return (
            <div className="flex items-center gap-2">
              <Meter
                value={ratio}
                tone={meterToneFor(ratio)}
                className="flex-1"
                label={t('server.buckets.quotaMeter', { name: bucket.name })}
              />
              <Pct value={ratio} className="text-xs text-muted-foreground" />
            </div>
          );
        },
      },
      {
        id: 'versioning',
        header: () => t('server.buckets.versioning'),
        cell: ({ row }) => {
          const state = row.original.versioning;
          return (
            <Badge variant={state === 'enabled' ? 'success' : state === 'suspended' ? 'secondary' : 'outline'}>
              {tDomain(`versioning.${state}`)}
            </Badge>
          );
        },
      },
      {
        id: 'statsAt',
        header: () => t('server.buckets.lastStats'),
        cell: ({ row }) =>
          row.original.statsAt === null ? (
            <Dash />
          ) : (
            <RelativeTime value={row.original.statsAt} className="text-muted-foreground" />
          ),
      },
      {
        id: 'actions',
        size: 48,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => {
          const bucket = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tCommon('table.rowActions')}
                  onClick={(event) => event.stopPropagation()}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link
                    to="/browse/$server/$bucket/$"
                    params={{ server: server.name, bucket: bucket.name, _splat: '' }}
                  >
                    <FolderOpenIcon />
                    {t('server.buckets.browse')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link
                    to="/buckets/$server/$bucket"
                    params={{ server: server.name, bucket: bucket.name }}
                  >
                    <Settings2Icon />
                    {t('server.buckets.settings')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    dialogs.open('edit-quota', { server: server.name, bucket: bucket.name })
                  }
                >
                  <GaugeIcon />
                  {t('server.buckets.editQuota')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => copyUri(bucket)}>
                  <LinkIcon />
                  {t('server.buckets.copyUri')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [copyUri, dialogs, server.name, t, tCommon, tDomain],
  );

  const items = buckets.data?.items ?? [];

  return (
    <SectionCard
      title={t('server.buckets.title')}
      description={t('server.buckets.description', {
        shown: items.length,
        total: buckets.data?.total ?? server.counts.buckets,
      })}
      action={
        <>
          <InputGroup className="w-full sm:w-56">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPagination((state) => ({ ...state, pageIndex: 0 }));
              }}
              placeholder={t('server.buckets.filterPlaceholder')}
              aria-label={t('server.buckets.filterPlaceholder')}
            />
          </InputGroup>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/buckets" search={{ serverId: server.id }}>
              {t('server.buckets.allBuckets')}
              <ArrowRightIcon className="flip-rtl" />
            </Link>
          </Button>
        </>
      }
      flush
    >
      {buckets.isError ? (
        <EmptyState
          icon={DatabaseIcon}
          title={tCommon('state.error')}
          description={apiError.message(buckets.error)}
        />
      ) : (
        <DataTable
          aria-label={t('server.buckets.title')}
          columns={columns}
          data={items}
          getRowId={(bucket) => bucket.name}
          loading={buckets.isLoading}
          pagination={pagination}
          onPaginationChange={setPagination}
          total={buckets.data?.total}
          onRowClick={(bucket) =>
            void navigate({
              to: '/buckets/$server/$bucket',
              params: { server: server.name, bucket: bucket.name },
            })
          }
          emptyState={
            <EmptyState
              icon={DatabaseIcon}
              title={query.length > 0 ? tCommon('state.noResults') : t('server.buckets.emptyTitle')}
              description={
                query.length > 0 ? undefined : t('server.buckets.emptyDescription')
              }
            />
          }
        />
      )}
    </SectionCard>
  );
}
