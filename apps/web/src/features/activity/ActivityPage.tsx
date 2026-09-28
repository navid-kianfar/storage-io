import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_RESULTS,
  type ActivityCategory,
  type ActivityEvent,
  type ActivityResult,
  type ListActivityQuery,
} from '@storage-io/contracts';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { FileDownIcon, ListFilterIcon, RefreshCwIcon, ScrollTextIcon, SearchIcon, WebhookIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Combobox,
  DEFAULT_PAGE_SIZE,
  DataTable,
  Dash,
  DateRangePicker,
  DateTime,
  EmptyState,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  PageHeader,
  SectionCard,
  SegmentedControl,
  type ComboboxOption,
  type DateRange,
  type SegmentedOption,
} from '@/components/app';
import { ActivityEventSheet } from '@/features/activity/ActivityEventSheet';
import { fetchActivityCsv, useActivity } from '@/features/activity/api';
import {
  ACTIVITY_RANGES,
  ACTIVITY_RESULT_BADGES,
  ACTIVITY_RESULT_TONES,
  activityIcon,
  dayBounds,
  dayKey,
  rangeFrom,
  type ActivityRange,
} from '@/features/activity/eventStyles';
import { useSettings } from '@/features/shell/api';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { csvFileName, downloadBlob } from '@/lib/csv/csv';
import { useFormat } from '@/lib/format/FormatProvider';
import { cn } from '@/lib/utils';

/**
 * Every administrative and data action, newest first.
 *
 * Filters live in the URL and go to the server: this is the one list in the app
 * that is genuinely large, and "filter what happens to be on this page" is not a
 * filter. That also makes a filtered view a link — the shape of half the questions
 * this page answers ("what did that key do yesterday?").
 *
 * Rows are grouped by day the way the concept draws it: the first row of each day
 * carries the date above its time, so one table still reads as a diary. The full
 * width day separator the concept uses is a native `<tr>` trick the kit's DataTable
 * has no equivalent for, and the date-in-first-cell is the honest adaptation.
 *
 * Live updates come from the shell's SSE stream. `job.status` already invalidates
 * the activity scope; `notification` does too (see `useEventStream`), which covers
 * the events the API also notifies on. There is no dedicated `activity.*` event in
 * the contract — that is reported, not worked around with a poll.
 */

const ACTIVITY_PAGE_SIZE = DEFAULT_PAGE_SIZE;
const RESULT_FILTERS = ['all', ...ACTIVITY_RESULTS] as const;
type ResultFilter = (typeof RESULT_FILTERS)[number];

function isCategory(value: unknown): value is ActivityCategory {
  return typeof value === 'string' && (ACTIVITY_CATEGORIES as readonly string[]).includes(value);
}

function isResult(value: unknown): value is ActivityResult {
  return typeof value === 'string' && (ACTIVITY_RESULTS as readonly string[]).includes(value);
}

function isRange(value: unknown): value is ActivityRange {
  return typeof value === 'string' && (ACTIVITY_RANGES as readonly string[]).includes(value);
}

export function ActivityPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const navigate = useNavigate();
  const apiError = useApiError();
  const format = useFormat();

  const search = useSearch({ strict: false });
  const query = typeof search.q === 'string' ? search.q : '';
  const serverId = typeof search.serverId === 'string' ? search.serverId : null;
  const category = isCategory(search.category) ? search.category : null;
  const result: ResultFilter = isResult(search.result) ? search.result : 'all';
  const range: ActivityRange = isRange(search.range) ? search.range : '24h';
  const fromParam = typeof search.from === 'string' ? search.from : null;
  const toParam = typeof search.to === 'string' ? search.to : null;

  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: ACTIVITY_PAGE_SIZE,
  });
  const [openEvent, setOpenEvent] = useState<ActivityEvent | null>(null);
  const [exporting, setExporting] = useState(false);

  const servers = useServers();
  const settings = useSettings();

  const filters = useMemo<ListActivityQuery>(() => {
    const presetFrom = range === 'custom' ? fromParam : rangeFrom(range);
    return {
      ...(query.length > 0 ? { q: query } : {}),
      ...(serverId === null ? {} : { serverId }),
      ...(category === null ? {} : { category }),
      ...(result === 'all' ? {} : { result }),
      ...(presetFrom === null ? {} : { from: presetFrom }),
      ...(range === 'custom' && toParam !== null ? { to: toParam } : {}),
    };
  }, [category, fromParam, query, range, result, serverId, toParam]);

  const activity = useActivity({
    ...filters,
    page: pagination.pageIndex + 1,
    pageSize: pagination.pageSize,
  });

  const items = useMemo(() => activity.data?.items ?? [], [activity.data]);

  const setSearch = useCallback(
    (next: Record<string, string | undefined>) => {
      setPagination((state) => ({ ...state, pageIndex: 0 }));
      void navigate({
        to: '/activity',
        search: (current: Record<string, unknown>) => ({ ...current, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (servers.data?.items ?? []).map((server) => ({
        value: server.id,
        label: server.name,
        description: server.endpoint,
      })),
    [servers.data],
  );

  const categoryOptions = useMemo<readonly ComboboxOption<ActivityCategory>[]>(
    () =>
      ACTIVITY_CATEGORIES.map((value) => ({
        value,
        label: tDomain(`activityCategory.${value}`),
      })),
    [tDomain],
  );

  const rangeOptions = useMemo<readonly ComboboxOption<ActivityRange>[]>(
    () => ACTIVITY_RANGES.map((value) => ({ value, label: t(`activity.range.${value}`) })),
    [t],
  );

  const resultOptions = useMemo<readonly SegmentedOption<ResultFilter>[]>(
    () =>
      RESULT_FILTERS.map((value) => ({
        value,
        label: value === 'all' ? t('activity.result.all') : tDomain(`activityResult.${value}`),
      })),
    [t, tDomain],
  );

  const customRange = useMemo<DateRange | null>(() => {
    if (range !== 'custom' || fromParam === null) return null;
    return {
      from: new Date(fromParam),
      to: toParam === null ? undefined : new Date(toParam),
    };
  }, [fromParam, range, toParam]);

  const exportCsv = useCallback(() => {
    setExporting(true);
    fetchActivityCsv(filters).then(
      (blob) => {
        const fileName = csvFileName('activity');
        downloadBlob(blob, fileName);
        toast.success(tCommon('table.exportCsv'), { description: fileName });
        setExporting(false);
      },
      (error: unknown) => {
        apiError.toastError(error, t('activity.exportFailed'));
        setExporting(false);
      },
    );
  }, [apiError, filters, t, tCommon]);

  /** The first row of each day carries the date; the rest carry only the time. */
  const dayStarts = useMemo(() => {
    const starts = new Set<string>();
    let previous: string | null = null;
    for (const event of items) {
      const key = dayKey(event.at);
      if (key !== previous) {
        starts.add(event.id);
        previous = key;
      }
    }
    return starts;
  }, [items]);

  const columns = useMemo<readonly ColumnDef<ActivityEvent, unknown>[]>(
    () => [
      {
        id: 'time',
        size: 120,
        header: () => t('activity.column.time'),
        cell: ({ row }) => (
          <span className="flex flex-col">
            {dayStarts.has(row.original.id) ? (
              <span className="text-xs font-semibold">
                <DateTime value={row.original.at} style="date" />
              </span>
            ) : null}
            <span className="num text-xs text-muted-foreground">
              <DateTime value={row.original.at} style="time" />
            </span>
          </span>
        ),
      },
      {
        id: 'event',
        header: () => t('activity.column.event'),
        cell: ({ row }) => {
          const event = row.original;
          const Icon = activityIcon(event.action, event.category);
          return (
            <span className="flex items-center gap-2.5">
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-md',
                  ACTIVITY_RESULT_TONES[event.result],
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[0.8125rem] font-medium">{event.title}</span>
                <span className="truncate font-mono text-xs text-muted-foreground" dir="ltr">
                  {event.action}
                </span>
              </span>
            </span>
          );
        },
      },
      {
        id: 'actor',
        header: () => t('activity.column.actor'),
        cell: ({ row }) => (
          <span className="truncate text-xs">
            {row.original.actor.name}
            {row.original.actor.type === 'system' ? (
              <span className="text-muted-foreground"> ({row.original.actor.type})</span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'target',
        header: () => t('activity.column.target'),
        cell: ({ row }) =>
          row.original.target === null ? (
            <Dash />
          ) : (
            <span className="truncate font-mono text-xs text-muted-foreground" dir="ltr">
              {row.original.target}
            </span>
          ),
      },
      {
        id: 'server',
        header: () => t('activity.column.server'),
        cell: ({ row }) =>
          row.original.serverName === null ? (
            <Dash />
          ) : (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {row.original.serverName}
            </span>
          ),
      },
      {
        id: 'ip',
        header: () => t('activity.column.ip'),
        cell: ({ row }) =>
          row.original.ip === null ? (
            <Dash />
          ) : (
            <span className="font-mono text-xs text-muted-foreground" dir="ltr">
              {row.original.ip}
            </span>
          ),
      },
      {
        id: 'result',
        size: 100,
        header: () => t('activity.column.result'),
        cell: ({ row }) => (
          <Badge variant={ACTIVITY_RESULT_BADGES[row.original.result]}>
            {tDomain(`activityResult.${row.original.result}`)}
          </Badge>
        ),
      },
    ],
    [dayStarts, t, tDomain],
  );

  const hasFilters =
    query.length > 0 ||
    serverId !== null ||
    category !== null ||
    result !== 'all' ||
    range !== '24h';

  const retentionDays = settings.data?.retention.activityDays;

  return (
    <>
      <PageHeader
        title={t('activity.title')}
        description={t('activity.description')}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/settings" hash="activity-forwarding">
                <WebhookIcon />
                {t('activity.forwardToSyslog')}
              </Link>
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={exporting}>
              <FileDownIcon />
              {tCommon('table.exportCsv')}
            </Button>
          </>
        }
      />

      <div className="mb-(--gap) flex flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:w-72">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setSearch({ q: event.target.value })}
            placeholder={t('activity.searchPlaceholder')}
            aria-label={t('activity.searchPlaceholder')}
          />
        </InputGroup>

        <Combobox
          options={rangeOptions}
          value={range}
          onValueChange={(next) => setSearch({ range: next ?? '24h' })}
          className="w-full sm:w-44"
          aria-label={t('activity.rangeLabel')}
        />

        {range === 'custom' ? (
          <DateRangePicker
            value={customRange}
            onValueChange={(next) => {
              if (next?.from === undefined) {
                setSearch({ from: undefined, to: undefined });
                return;
              }
              const bounds = dayBounds(next.from, next.to ?? next.from);
              setSearch({ from: bounds.from, to: bounds.to });
            }}
            clearable
            toDate={new Date()}
            className="w-full sm:w-64"
            aria-label={t('activity.customRange')}
          />
        ) : null}

        <Combobox
          options={serverOptions}
          value={serverId}
          onValueChange={(next) => setSearch({ serverId: next ?? undefined })}
          placeholder={t('activity.allServers')}
          clearable
          className="w-full sm:w-44"
          aria-label={t('activity.serverFilter')}
        />

        <Combobox
          options={categoryOptions}
          value={category}
          onValueChange={(next) => setSearch({ category: next ?? undefined })}
          placeholder={t('activity.allCategories')}
          clearable
          className="w-full sm:w-44"
          aria-label={t('activity.categoryFilter')}
        />

        {/* Scrolls rather than pushing the page wide at 375px. */}
        <div className="-mx-1 w-full overflow-x-auto px-1 sm:mx-0 sm:w-auto sm:px-0">
          <SegmentedControl
            options={resultOptions}
            value={result}
            onValueChange={(next) => setSearch({ result: next === 'all' ? undefined : next })}
            aria-label={t('activity.resultFilter')}
          />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="sm:ms-auto"
          onClick={() => void activity.refetch()}
          aria-label={tCommon('action.refresh')}
        >
          <RefreshCwIcon />
        </Button>
      </div>

      <SectionCard flush>
        {activity.isError ? (
          <EmptyState
            icon={ScrollTextIcon}
            title={tCommon('state.error')}
            description={apiError.message(activity.error)}
          />
        ) : (
          <DataTable
            aria-label={t('activity.title')}
            columns={columns}
            data={items}
            getRowId={(event) => event.id}
            loading={activity.isLoading}
            pagination={pagination}
            onPaginationChange={setPagination}
            total={activity.data?.total}
            showColumnsMenu
            onRowClick={(event) => setOpenEvent(event)}
            activeRowId={openEvent?.id}
            emptyState={
              <EmptyState
                icon={ScrollTextIcon}
                title={hasFilters ? tCommon('state.noResults') : t('activity.empty.title')}
                description={t('activity.empty.description')}
                action={
                  hasFilters ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setSearch({
                          q: undefined,
                          serverId: undefined,
                          category: undefined,
                          result: undefined,
                          range: undefined,
                          from: undefined,
                          to: undefined,
                        })
                      }
                    >
                      <ListFilterIcon />
                      {t('users.resetFilters')}
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </SectionCard>

      <Alert variant="info" className="mt-(--gap)">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>
            {retentionDays === undefined
              ? t('activity.retentionUnknown')
              : t('activity.retention', { days: format.number(retentionDays) })}
          </span>
          <Button variant="ghost" size="sm" asChild className="ms-auto">
            <Link to="/settings" hash="backup-retention">
              {t('activity.changeInSettings')}
            </Link>
          </Button>
        </AlertDescription>
      </Alert>

      {openEvent === null ? null : (
        <ActivityEventSheet
          event={openEvent}
          onClose={() => setOpenEvent(null)}
          onFilterByActor={(actorName) => {
            setSearch({ q: actorName });
            setOpenEvent(null);
          }}
        />
      )}
    </>
  );
}
