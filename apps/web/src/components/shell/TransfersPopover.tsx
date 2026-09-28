import { Link } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  PauseIcon,
  PlayIcon,
  RotateCwIcon,
  XIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bytes, Pct } from '@/components/app/Format';
import { Meter } from '@/components/app/Meter';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  cancelTransfer,
  clearCompletedTransfers,
  pauseAllTransfers,
  pauseTransfer,
  resumeAllTransfers,
  resumeTransfer,
  retryTransfer,
} from '@/features/transfers/engine';
import { sortedTransfers, transferCounts, transferRatio, useTransfers } from '@/stores/transfers';
import { cn } from '@/lib/utils';

const MAX_VISIBLE = 6;

/**
 * The topbar's transfers popover. It reads the real browser-side transfer queue
 * (src/stores/transfers.ts) — the object browser pushes uploads and downloads into
 * that store, and the /transfers page renders the same data in full.
 *
 * Its per-row and footer controls call `src/features/transfers/engine.ts`, the same
 * functions the /transfers page and the browser's upload panel call, so pausing a
 * transfer here and pausing it there are one code path.
 */
export function TransfersPopover() {
  const { t } = useTranslation('nav');
  const transfers = useTransfers((state) => state.transfers);
  const counts = useMemo(() => transferCounts(transfers), [transfers]);
  const visible = useMemo(() => sortedTransfers(transfers).slice(0, MAX_VISIBLE), [transfers]);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={t('topbar.transfers')}
            >
              <ArrowUpDownIcon />
              {counts.active > 0 ? (
                <span className="num absolute top-0.5 end-0 grid min-w-4 place-items-center rounded-full border-2 border-background bg-primary px-0.5 font-mono text-[0.5625rem] leading-3 font-semibold text-primary-foreground">
                  {counts.active}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.transfers')}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-88 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">{t('transfers.title')}</span>
          <span className="num text-xs text-muted-foreground">
            {t('transfers.summary', {
              uploading: counts.uploading,
              downloading: counts.downloading,
            })}
          </span>
        </div>

        <ScrollArea className="max-h-80">
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('transfers.empty')}
            </p>
          ) : (
            <ul>
              {visible.map((transfer) => {
                const ratio = transferRatio(transfer);
                const Icon = transfer.direction === 'upload' ? ArrowUpIcon : ArrowDownIcon;
                return (
                  <li
                    key={transfer.id}
                    className="flex items-start gap-3 border-t px-4 py-3 first:border-t-0"
                  >
                    <Icon
                      className={cn(
                        'mt-0.5 size-4 shrink-0',
                        transfer.direction === 'upload' ? 'text-success' : 'text-info',
                      )}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="ltr-isolate truncate font-mono text-sm">
                          {transfer.name}
                        </span>
                        <Pct value={ratio} className="text-xs text-muted-foreground" />
                      </div>
                      <Meter
                        value={ratio}
                        striped={transfer.status === 'running'}
                        // Progress, not a quota: full means finished, not "over".
                        tone={
                          transfer.status === 'failed'
                            ? 'crit'
                            : transfer.status === 'completed'
                              ? 'ok'
                              : 'default'
                        }
                        label={transfer.name}
                      />
                      <span className="text-xs text-muted-foreground">
                        {transfer.status === 'failed' && transfer.error !== null ? (
                          <span className="text-destructive-foreground">{transfer.error}</span>
                        ) : (
                          <>
                            <Bytes value={transfer.transferredBytes} /> /{' '}
                            <Bytes value={transfer.totalBytes} />
                          </>
                        )}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5">
                      {transfer.status === 'running' ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('transfers.pause')}
                          onClick={() => pauseTransfer(transfer.id)}
                        >
                          <PauseIcon />
                        </Button>
                      ) : transfer.status === 'paused' ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('transfers.resume')}
                          onClick={() => resumeTransfer(transfer.id)}
                        >
                          <PlayIcon />
                        </Button>
                      ) : transfer.status === 'failed' ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('transfers.retry')}
                          onClick={() => retryTransfer(transfer.id)}
                        >
                          <RotateCwIcon />
                        </Button>
                      ) : null}
                      {transfer.status === 'completed' ||
                      transfer.status === 'cancelled' ? null : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('transfers.cancel')}
                          onClick={() => cancelTransfer(transfer.id)}
                        >
                          <XIcon />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <div className="flex items-center gap-1 border-t p-2">
          {counts.active > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => pauseAllTransfers()}>
              <PauseIcon />
              {t('transfers.pauseAll')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => resumeAllTransfers()}>
              <PlayIcon />
              {t('transfers.resumeAll')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => clearCompletedTransfers()}>
            {t('transfers.clearCompleted')}
          </Button>
          <Button variant="ghost" size="sm" className="ms-auto" asChild>
            <Link to="/transfers">{t('transfers.openManager')}</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
