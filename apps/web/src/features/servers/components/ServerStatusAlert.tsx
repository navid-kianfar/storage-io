import type { ServerStatus } from '@storage-io/contracts';
import { CircleXIcon, ConstructionIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle, RelativeTime } from '@/components/app';

/**
 * The banner a server in trouble shows — the dashboard's incident banner, the
 * degraded and offline states on a server card, and the header of a server's own
 * page. One component, so "unreachable" reads identically in all three places.
 *
 * A healthy server renders nothing: the caller can pass its status
 * unconditionally rather than branching around this.
 */

const STATUS_ICONS = {
  degraded: TriangleAlertIcon,
  offline: CircleXIcon,
  maintenance: ConstructionIcon,
} as const;

const STATUS_VARIANTS = {
  degraded: 'warning',
  offline: 'danger',
  maintenance: 'default',
} as const;

type AlertingStatus = keyof typeof STATUS_ICONS;

function alertingStatusOf(status: ServerStatus): AlertingStatus | null {
  switch (status) {
    case 'degraded':
      return 'degraded';
    case 'offline':
      return 'offline';
    case 'maintenance':
      return 'maintenance';
    case 'healthy':
    case 'unknown':
      return null;
  }
}

export function ServerStatusAlert({
  serverName,
  status,
  detail,
  since,
  note,
  actions,
  className,
}: {
  readonly serverName: string;
  readonly status: ServerStatus;
  /** The API's own text — "Connection refused on port 3900". */
  readonly detail: string | null;
  /** When the server was last seen, or when the incident started. */
  readonly since: string | null;
  /** An extra consequence line, e.g. "6 buckets are read-only until it recovers." */
  readonly note?: ReactNode;
  /** Retry / Details buttons, on the inline-end. */
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  const { t } = useTranslation('pages');
  const alerting = alertingStatusOf(status);
  if (alerting === null) return null;

  const Icon = STATUS_ICONS[alerting];

  return (
    <Alert variant={STATUS_VARIANTS[alerting]} className={className}>
      <Icon />
      <AlertTitle className="line-clamp-none">
        <span className="font-mono">{serverName}</span>{' '}
        <span className="font-normal">{t(`servers.incident.${alerting}`)}</span>
      </AlertTitle>
      <AlertDescription className="block text-xs">
        {detail === null ? null : <span>{detail}</span>}
        {detail !== null && since !== null ? ' · ' : null}
        {since === null ? null : (
          <>
            <span>{t('servers.incident.lastSeen')} </span>
            <RelativeTime value={since} />
          </>
        )}
        {note === undefined ? null : <> · {note}</>}
      </AlertDescription>
      {actions === undefined ? null : (
        <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2 sm:absolute sm:end-4 sm:top-1/2 sm:col-start-auto sm:mt-0 sm:-translate-y-1/2">
          {actions}
        </div>
      )}
    </Alert>
  );
}
