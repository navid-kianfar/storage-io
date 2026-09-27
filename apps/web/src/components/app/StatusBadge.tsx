import type { AccessKeyStatus, JobStatus, S3UserStatus, ServerStatus } from '@storage-io/contracts';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * One badge for every status in the system, so "Degraded" looks the same on the
 * dashboard, the servers table and the server page. Each status maps to exactly
 * one Badge variant and one dot colour — that mapping lives here and nowhere else.
 */

type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'secondary' | 'outline';
type DotTone = 'ok' | 'warn' | 'err' | 'muted' | 'none';

interface StatusStyle {
  readonly variant: BadgeVariant;
  readonly dot: DotTone;
}

const SERVER_STATUS_STYLES: Readonly<Record<ServerStatus, StatusStyle>> = {
  healthy: { variant: 'success', dot: 'ok' },
  degraded: { variant: 'warning', dot: 'warn' },
  offline: { variant: 'danger', dot: 'err' },
  maintenance: { variant: 'secondary', dot: 'muted' },
  unknown: { variant: 'outline', dot: 'muted' },
};

const JOB_STATUS_STYLES: Readonly<Record<JobStatus, StatusStyle>> = {
  queued: { variant: 'secondary', dot: 'none' },
  scheduled: { variant: 'outline', dot: 'none' },
  running: { variant: 'info', dot: 'none' },
  paused: { variant: 'warning', dot: 'none' },
  completed: { variant: 'success', dot: 'none' },
  completed_with_errors: { variant: 'warning', dot: 'none' },
  failed: { variant: 'danger', dot: 'none' },
  cancelled: { variant: 'secondary', dot: 'none' },
};

const KEY_STATUS_STYLES: Readonly<Record<AccessKeyStatus, StatusStyle>> = {
  active: { variant: 'success', dot: 'none' },
  disabled: { variant: 'secondary', dot: 'none' },
  expired: { variant: 'danger', dot: 'none' },
};

const USER_STATUS_STYLES: Readonly<Record<S3UserStatus, StatusStyle>> = {
  enabled: { variant: 'success', dot: 'none' },
  disabled: { variant: 'secondary', dot: 'none' },
  unknown: { variant: 'outline', dot: 'none' },
};

const DOT_CLASSES: Readonly<Record<Exclude<DotTone, 'none'>, string>> = {
  ok: 'bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_22%,transparent)]',
  warn: 'bg-warning shadow-[0_0_0_3px_color-mix(in_oklab,var(--warning)_22%,transparent)]',
  err: 'bg-destructive shadow-[0_0_0_3px_color-mix(in_oklab,var(--destructive)_22%,transparent)]',
  muted: 'bg-muted-foreground',
};

/** The concept's `.dot` — also used on its own in the server switcher. */
export function StatusDot({
  tone,
  className,
}: {
  readonly tone: Exclude<DotTone, 'none'>;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-2 shrink-0 rounded-full', DOT_CLASSES[tone], className)}
    />
  );
}

export function serverStatusTone(status: ServerStatus): Exclude<DotTone, 'none'> {
  const dot = SERVER_STATUS_STYLES[status].dot;
  return dot === 'none' ? 'muted' : dot;
}

function StatusBadgeBase({
  style,
  label,
  className,
}: {
  readonly style: StatusStyle;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <Badge variant={style.variant} className={className}>
      {style.dot === 'none' ? null : <StatusDot tone={style.dot} />}
      {label}
    </Badge>
  );
}

export function ServerStatusBadge({
  status,
  className,
}: {
  readonly status: ServerStatus;
  readonly className?: string;
}) {
  const { t } = useTranslation('domain');
  return (
    <StatusBadgeBase
      style={SERVER_STATUS_STYLES[status]}
      label={t(`serverStatus.${status}`)}
      className={className}
    />
  );
}

export function JobStatusBadge({
  status,
  className,
}: {
  readonly status: JobStatus;
  readonly className?: string;
}) {
  const { t } = useTranslation('domain');
  return (
    <StatusBadgeBase
      style={JOB_STATUS_STYLES[status]}
      label={t(`jobStatus.${status}`)}
      className={className}
    />
  );
}

export function AccessKeyStatusBadge({
  status,
  expiringSoon = false,
  className,
}: {
  readonly status: AccessKeyStatus;
  /** An active key inside the expiry window reads as a warning, per the concept. */
  readonly expiringSoon?: boolean;
  readonly className?: string;
}) {
  const { t } = useTranslation('domain');
  if (status === 'active' && expiringSoon) {
    return (
      <StatusBadgeBase
        style={{ variant: 'warning', dot: 'none' }}
        label={t('keyStatus.expiring')}
        className={className}
      />
    );
  }
  return (
    <StatusBadgeBase
      style={KEY_STATUS_STYLES[status]}
      label={t(`keyStatus.${status}`)}
      className={className}
    />
  );
}

export function UserStatusBadge({
  status,
  className,
}: {
  readonly status: S3UserStatus;
  readonly className?: string;
}) {
  const { t } = useTranslation('domain');
  return (
    <StatusBadgeBase
      style={USER_STATUS_STYLES[status]}
      label={t(`userStatus.${status}`)}
      className={className}
    />
  );
}
