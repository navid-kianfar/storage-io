import type { HealthEventKind, Server, ServerHealthEvent } from '@storage-io/contracts';
import {
  ActivityIcon,
  CircleCheckIcon,
  CircleXIcon,
  HardDriveIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ListRow,
  Meter,
  Ms,
  Pct,
  RelativeTime,
  Skeleton,
  Sparkline,
  Spinner,
} from '@/components/app';
import { useServerEvents } from '@/features/servers/api';
import { useFormat } from '@/lib/format/FormatProvider';
import { cn } from '@/lib/utils';

/**
 * Uptime, the latency trend and the health event feed, as the concept's
 * "Health checks" card. The sparkline is hand-drawn rather than Recharts: it has
 * no axes and sits next to eleven other small numbers, and one resize observer per
 * sparkline is what Recharts would cost here.
 */

const EVENT_ICONS: Readonly<Record<HealthEventKind, typeof CircleCheckIcon>> = {
  up: CircleCheckIcon,
  down: CircleXIcon,
  degraded: HardDriveIcon,
  latency: ActivityIcon,
  check: CircleCheckIcon,
};

const EVENT_TONES: Readonly<Record<HealthEventKind, string>> = {
  up: 'text-success',
  down: 'text-destructive',
  degraded: 'text-warning',
  latency: 'text-warning',
  check: 'text-muted-foreground',
};

export function ServerHealthCard({
  server,
  latency,
  latencyLoading,
  onCheckNow,
  checking,
}: {
  readonly server: Server;
  /** The latency series from `GET /servers/:id/metrics`, oldest first. */
  readonly latency: readonly number[];
  readonly latencyLoading: boolean;
  readonly onCheckNow: () => void;
  readonly checking: boolean;
}) {
  const { t } = useTranslation('pages');
  const format = useFormat();
  const events = useServerEvents(server.id);

  const uptime = server.uptime24h;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex-row items-start gap-3 border-b px-(--card-pad) py-(--card-pad) [.border-b]:pb-(--card-pad)">
        <div className="min-w-0 flex-1">
          <CardTitle className="text-sm">{t('server.health.title')}</CardTitle>
          <CardDescription className="mt-0.5 text-xs">
            {t('server.health.every', { seconds: server.options.healthIntervalSec })}
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onCheckNow}
          disabled={checking}
          aria-label={t('server.health.runNow')}
        >
          {checking ? <Spinner /> : <RefreshCwIcon />}
        </Button>
      </CardHeader>

      <CardContent className="px-(--card-pad) pt-(--card-pad) pb-2">
        <div className="flex items-center justify-between">
          <span className="text-[0.8125rem] text-muted-foreground">
            {t('server.health.uptime24h')}
          </span>
          <Pct
            value={uptime}
            fractionDigits={2}
            className={cn('font-semibold', uptime !== null && uptime >= 0.999 && 'text-success')}
          />
        </div>
        <Meter
          value={uptime}
          tone={uptime !== null && uptime >= 0.99 ? 'ok' : 'warn'}
          className="mt-2"
          label={t('server.health.uptime24h')}
        />

        <div className="mt-4 flex items-center justify-between">
          <span className="text-[0.8125rem] text-muted-foreground">
            {t('server.health.responseTime')}
          </span>
          <Ms value={server.latencyMs} className="font-semibold" />
        </div>
        {latencyLoading ? (
          <Skeleton className="mt-2 h-10 w-full" />
        ) : latency.length < 2 ? (
          <p className="mt-2 text-xs text-muted-foreground">{t('server.health.noLatency')}</p>
        ) : (
          <>
            <Sparkline
              values={latency}
              tone="chart-3"
              filled={false}
              className="mt-1"
              ariaLabel={t('server.health.latencyChartLabel', {
                min: format.milliseconds(Math.min(...latency)),
                max: format.milliseconds(Math.max(...latency)),
              })}
            />
            <div className="flex items-center justify-between text-[0.6875rem] text-muted-foreground">
              <span>{format.relativeSeconds(-86_400)}</span>
              <span>{t('server.health.now')}</span>
            </div>
          </>
        )}
      </CardContent>

      <div className="border-t">
        {events.isLoading ? (
          <div className="flex flex-col gap-2 p-(--card-pad)">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (events.data?.items ?? []).length === 0 ? (
          <p className="p-(--card-pad) text-xs text-muted-foreground">
            {t('server.health.noEvents')}
          </p>
        ) : (
          (events.data?.items ?? []).map((event, index) => (
            <HealthEventRow key={`${event.at}-${index}`} event={event} />
          ))
        )}
      </div>
    </Card>
  );
}

function HealthEventRow({ event }: { readonly event: ServerHealthEvent }) {
  const { t } = useTranslation('pages');
  const Icon = EVENT_ICONS[event.kind];
  return (
    <ListRow
      media={<Icon className={cn('size-4', EVENT_TONES[event.kind])} aria-hidden="true" />}
      title={t(`server.health.event.${event.kind}`)}
      subtitle={
        event.detail === null ? undefined : (
          <span className="font-mono">{event.detail}</span>
        )
      }
      trailing={<RelativeTime value={event.at} className="text-muted-foreground" />}
    />
  );
}
