import { Link } from '@tanstack/react-router';
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bytes, Pct } from '@/components/app/Format';
import { Meter } from '@/components/app/Meter';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { sortedTransfers, transferCounts, transferRatio, useTransfers } from '@/stores/transfers';
import { cn } from '@/lib/utils';

const MAX_VISIBLE = 6;

/**
 * The topbar's transfers popover. It reads the real browser-side transfer queue
 * (src/stores/transfers.ts) — the object browser pushes uploads and downloads into
 * that store, and the /transfers page renders the same data in full.
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
                        tone={transfer.status === 'failed' ? 'crit' : undefined}
                        label={transfer.name}
                      />
                      <span className="text-xs text-muted-foreground">
                        <Bytes value={transfer.transferredBytes} /> /{' '}
                        <Bytes value={transfer.totalBytes} />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <div className="border-t p-2">
          <Button variant="ghost" size="sm" className="w-full" asChild>
            <Link to="/transfers">{t('transfers.openManager')}</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
