import { RefreshCwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Duration, SectionCard, Skeleton, Spinner } from '@/components/app';
import { Logo } from '@/components/shell/Logo';
import {
  UPDATE_CHECK_URL,
  useCheckForUpdates,
  useHealth,
} from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * What is running, and — only where it is possible — whether something newer
 * exists.
 *
 * storage-io is on-premise software that may have no route to the internet, so
 * there is no call to a release feed baked in. "Check for updates" appears only
 * when `VITE_UPDATE_CHECK_URL` is configured for this deployment; with none set the
 * card shows the running version and says where a check would come from, instead of
 * a button that times out behind a firewall and teaches the operator to distrust it.
 */

const BUILD_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0';

export function AboutSection() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const health = useHealth();
  const check = useCheckForUpdates();

  const runningVersion = health.data?.version ?? BUILD_VERSION;
  const newer = check.data !== undefined && check.data.version !== runningVersion;

  return (
    <SectionCard>
      <div className="flex flex-wrap items-center gap-4">
        <Logo className="size-12" tileFill="var(--primary)" strokeColor="var(--primary-foreground)" />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold">{tCommon('app.name')}</span>
          {health.isLoading ? (
            <Skeleton className="h-4 w-48" />
          ) : (
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-mono" dir="ltr">
                v{runningVersion}
              </span>
              {health.data === undefined ? (
                <span>{t('settings.about.apiUnreachable')}</span>
              ) : (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t('settings.about.uptime')}{' '}
                    <Duration seconds={health.data.uptimeSec} />
                  </span>
                </>
              )}
              {check.data === undefined ? null : newer ? (
                <Badge variant="info">
                  {t('settings.about.updateAvailable', { version: check.data.version })}
                </Badge>
              ) : (
                <Badge variant="success">{t('settings.about.upToDate')}</Badge>
              )}
            </span>
          )}
        </div>

        {UPDATE_CHECK_URL === undefined ? (
          <span className="max-w-xs text-xs text-muted-foreground">
            {t('settings.about.noUpdateUrl')}
          </span>
        ) : (
          <Button
            variant="outline"
            disabled={check.isPending}
            onClick={() =>
              check.mutate(undefined, {
                onSuccess: (result) => {
                  if (result.version === runningVersion) {
                    toast.success(t('settings.about.upToDate'));
                    return;
                  }
                  toast.info(t('settings.about.updateAvailable', { version: result.version }), {
                    description: result.notes,
                  });
                },
                onError: (error) => apiError.toastError(error, t('settings.about.checkFailed')),
              })
            }
          >
            {check.isPending ? <Spinner /> : <RefreshCwIcon />}
            {t('settings.about.checkForUpdates')}
          </Button>
        )}
      </div>
    </SectionCard>
  );
}
