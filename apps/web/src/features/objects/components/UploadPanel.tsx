import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  CloudUploadIcon,
  PauseIcon,
  PlayIcon,
  RotateCwIcon,
  XIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/app/Button';
import { Bytes, Pct } from '@/components/app/Format';
import { Meter } from '@/components/app/Meter';
import { ScrollArea } from '@/components/app/ScrollArea';
import {
  cancelTransfer,
  pauseTransfer,
  resumeTransfer,
  retryTransfer,
} from '@/features/transfers/engine';
import { transferRatio, useTransfers, type Transfer } from '@/stores/transfers';
import { cn } from '@/lib/utils';

/**
 * The floating upload panel the concept draws over the object browser.
 *
 * It reads the same store the topbar popover and the /transfers page read, filtered
 * to uploads, and it disappears when there is nothing to show — a panel that sits
 * empty over the listing is in the way.
 *
 * Per-file controls are the engine's, not this component's: pausing here and
 * pausing on /transfers are the same call.
 */
export function UploadPanel() {
  const { t } = useTranslation('pages');
  const transfers = useTransfers((state) => state.transfers);
  const [collapsed, setCollapsed] = useState(false);
  /** Which batch of uploads was dismissed, so a new one brings the panel back. */
  const [dismissedBatch, setDismissedBatch] = useState<string | null>(null);

  const uploads = useMemo(
    () => transfers.filter((transfer) => transfer.direction === 'upload'),
    [transfers],
  );

  const active = uploads.filter(
    (transfer) => transfer.status === 'running' || transfer.status === 'queued',
  );
  const done = uploads.filter((transfer) => transfer.status === 'completed').length;

  // The batch is identified by the ids in it, so the panel reappears for the next
  // upload without an effect resetting the dismissal.
  const batch = uploads.map((transfer) => transfer.id).join(',');
  const dismissed = dismissedBatch === batch;

  if (uploads.length === 0 || dismissed) return null;

  const totalBytes = uploads.reduce((sum, transfer) => sum + transfer.totalBytes, 0);
  const sentBytes = uploads.reduce((sum, transfer) => sum + transfer.transferredBytes, 0);
  const ratio = totalBytes === 0 ? null : sentBytes / totalBytes;

  return (
    <aside
      aria-label={t('browse.uploadPanel.label')}
      className="fixed end-4 bottom-4 z-40 w-80 overflow-hidden rounded-lg border bg-card shadow-concept-lg"
    >
      <div className="flex items-center gap-2.5 border-b px-3 py-2.5">
        <CloudUploadIcon className="size-4 shrink-0 text-success-foreground" aria-hidden="true" />
        <div className="flex min-w-0 grow flex-col gap-1">
          <span className="text-[0.8125rem] font-medium">
            {active.length > 0
              ? t('browse.uploadPanel.uploading', { done, total: uploads.length })
              : t('browse.uploadPanel.finished', { count: done })}
          </span>
          <Meter
            value={ratio}
            striped={active.length > 0}
            // The batch bar is progress, not a quota: full means done.
            tone={active.length === 0 ? 'ok' : 'default'}
            label={t('browse.uploadPanel.label')}
          />
        </div>
        <Pct value={ratio} className="text-xs text-muted-foreground" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            collapsed ? t('browse.uploadPanel.expand') : t('browse.uploadPanel.collapse')
          }
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('browse.uploadPanel.close')}
          onClick={() => setDismissedBatch(batch)}
        >
          <XIcon />
        </Button>
      </div>

      {collapsed ? null : (
        <ScrollArea className="max-h-64">
          <ul>
            {uploads.map((transfer) => (
              <UploadRow key={transfer.id} transfer={transfer} />
            ))}
          </ul>
        </ScrollArea>
      )}
    </aside>
  );
}

function UploadRow({ transfer }: { readonly transfer: Transfer }) {
  const { t } = useTranslation('pages');
  const ratio = transferRatio(transfer);

  return (
    <li className="flex items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0">
      <StatusIcon status={transfer.status} />
      <div className="flex min-w-0 grow flex-col gap-1">
        <span className="ltr-isolate truncate font-mono">{transfer.name}</span>
        {transfer.status === 'failed' ? (
          <span className="truncate text-destructive-foreground">{transfer.error}</span>
        ) : transfer.status === 'queued' ? (
          <span className="text-muted-foreground">{t('browse.uploadPanel.queued')}</span>
        ) : transfer.status === 'completed' ? (
          <span className="text-muted-foreground">
            <Bytes value={transfer.totalBytes} />
          </span>
        ) : (
          <Meter
            value={ratio}
            striped={transfer.status === 'running'}
            // Progress, not a quota: the branch above already covers failed and
            // completed, so what is left is in flight.
            tone="default"
            label={transfer.name}
          />
        )}
      </div>

      {transfer.status === 'running' ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('browse.uploadPanel.pause')}
          onClick={() => pauseTransfer(transfer.id)}
        >
          <PauseIcon />
        </Button>
      ) : transfer.status === 'paused' ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('browse.uploadPanel.resume')}
          onClick={() => resumeTransfer(transfer.id)}
        >
          <PlayIcon />
        </Button>
      ) : transfer.status === 'failed' ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => retryTransfer(transfer.id)}
        >
          {t('browse.uploadPanel.retry')}
        </Button>
      ) : null}

      {transfer.status === 'running' ||
      transfer.status === 'queued' ||
      transfer.status === 'paused' ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('browse.uploadPanel.cancel')}
          onClick={() => cancelTransfer(transfer.id)}
        >
          <XIcon />
        </Button>
      ) : null}
    </li>
  );
}

function StatusIcon({ status }: { readonly status: Transfer['status'] }) {
  const className = 'size-4 shrink-0';
  if (status === 'completed') {
    return <CircleCheckIcon className={cn(className, 'text-success-foreground')} aria-hidden="true" />;
  }
  if (status === 'failed') {
    return <CircleAlertIcon className={cn(className, 'text-destructive')} aria-hidden="true" />;
  }
  if (status === 'queued') {
    return <ClockIcon className={cn(className, 'text-muted-foreground')} aria-hidden="true" />;
  }
  if (status === 'paused') {
    return <PauseIcon className={cn(className, 'text-warning-foreground')} aria-hidden="true" />;
  }
  return <RotateCwIcon className={cn(className, 'animate-spin text-muted-foreground')} aria-hidden="true" />;
}
