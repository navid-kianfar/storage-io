import {
  CAPABILITIES,
  type CapabilityMap,
  type CheckResult,
  type CheckStatus,
} from '@storage-io/contracts';
import {
  BanIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  MinusIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle, Badge, Ms, Skeleton, Spinner } from '@/components/app';
import { cn } from '@/lib/utils';

/**
 * The verification list from the concept (`server-checks`), shared by the
 * first-run wizard, the Add-server wizard and the server's Connection tab.
 *
 * Three states, and all three are drawn: running (a spinner per pending row),
 * finished (icon, label and the API's own `detail`), and failed (the row that
 * failed keeps its detail, which is the actual error text the operator needs).
 * The capabilities strip below appears only once a run has finished, because a
 * half-probed capability map would be a lie.
 */

const CHECK_ICONS: Readonly<Record<CheckStatus, typeof CircleCheckIcon>> = {
  ok: CircleCheckIcon,
  warn: TriangleAlertIcon,
  fail: CircleXIcon,
  skipped: MinusIcon,
};

const CHECK_TONES: Readonly<Record<CheckStatus, string>> = {
  ok: 'text-success',
  warn: 'text-warning',
  fail: 'text-destructive',
  skipped: 'text-muted-foreground',
};

const PENDING_ROWS = 6;

export function ServerChecks({
  checks,
  running,
  error,
  capabilities,
  version,
  bucketCount,
  className,
}: {
  readonly checks: readonly CheckResult[] | undefined;
  readonly running: boolean;
  /** Shown when the request itself failed, rather than an individual check. */
  readonly error?: ReactNode;
  readonly capabilities?: CapabilityMap;
  readonly version?: string | null;
  readonly bucketCount?: number | null;
  readonly className?: string;
}) {
  const { t } = useTranslation('pages');

  const finished = !running && checks !== undefined;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {error === undefined ? null : (
        <Alert variant="danger">
          <CircleXIcon />
          <AlertTitle>{t('servers.checks.failedTitle')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <ul className="flex flex-col divide-y rounded-lg border">
        {running && checks === undefined
          ? Array.from({ length: PENDING_ROWS }, (_unused, index) => (
              <li key={index} className="flex items-center gap-3 px-3.5 py-2.5">
                <Spinner className="size-4 text-muted-foreground" />
                <Skeleton className="h-3.5 w-40" />
              </li>
            ))
          : (checks ?? []).map((check) => {
              const Icon = CHECK_ICONS[check.status];
              return (
                <li key={check.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
                  <Icon
                    className={cn('size-4 shrink-0', CHECK_TONES[check.status])}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{check.label}</span>
                  {check.detail === null ? null : (
                    <span
                      className={cn(
                        'ltr-isolate truncate font-mono text-xs',
                        check.status === 'fail' ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {check.detail}
                    </span>
                  )}
                  <Ms value={check.durationMs} className="shrink-0 text-xs text-muted-foreground" />
                  <span className="sr-only">{t(`servers.checks.status.${check.status}`)}</span>
                </li>
              );
            })}
        {finished && (checks ?? []).length === 0 ? (
          <li className="px-3.5 py-2.5 text-sm text-muted-foreground">
            {t('servers.checks.none')}
          </li>
        ) : null}
      </ul>

      {finished && capabilities !== undefined ? (
        <CapabilityStrip
          capabilities={capabilities}
          version={version ?? null}
          bucketCount={bucketCount ?? null}
        />
      ) : null}
    </div>
  );
}

function CapabilityStrip({
  capabilities,
  version,
  bucketCount,
}: {
  readonly capabilities: CapabilityMap;
  readonly version: string | null;
  readonly bucketCount: number | null;
}) {
  const { t } = useTranslation('pages');
  const { t: tDomain } = useTranslation('domain');

  // All three states are drawn. A capability that is merely *not configured* is
  // available on this endpoint once someone sets it up, which is a different fact
  // from one the provider cannot do — leaving it out would hide it entirely.
  const supported = CAPABILITIES.filter((name) => capabilities[name] === 'supported');
  const notConfigured = CAPABILITIES.filter((name) => capabilities[name] === 'not_configured');
  const notSupported = CAPABILITIES.filter((name) => capabilities[name] === 'not_supported');

  return (
    <Alert variant="info">
      <SparklesIcon />
      <AlertTitle>{t('servers.checks.capabilitiesTitle')}</AlertTitle>
      <AlertDescription>
        {version === null && bucketCount === null ? null : (
          <span className="text-xs">
            {version === null ? null : <span className="font-mono">{version}</span>}
            {version !== null && bucketCount !== null ? ' · ' : null}
            {bucketCount === null
              ? null
              : t('servers.checks.bucketCount', { count: bucketCount })}
          </span>
        )}
        <div className="mt-1 flex flex-wrap gap-1.5">
          {supported.map((name) => (
            <Badge key={name} variant="secondary">
              <CheckIcon />
              {tDomain(`capability.${name}`)}
            </Badge>
          ))}
          {notConfigured.map((name) => (
            <Badge key={name} variant="warning">
              <TriangleAlertIcon />
              {tDomain(`capability.${name}`)}
            </Badge>
          ))}
          {notSupported.map((name) => (
            <Badge key={name} variant="outline" className="text-muted-foreground">
              <BanIcon />
              {tDomain(`capability.${name}`)}
            </Badge>
          ))}
        </div>
      </AlertDescription>
    </Alert>
  );
}
