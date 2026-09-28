import type { ActivityEvent } from '@storage-io/contracts';
import { BracesIcon, KeyRoundIcon, ListFilterIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  CodeEditor,
  CopyField,
  Dash,
  DateTime,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/app';
import { ACTIVITY_RESULT_BADGES } from '@/features/activity/eventStyles';

/**
 * One event, in full: the fields an operator reads first, then the raw JSON the
 * API stored.
 *
 * Both are shown because they answer different questions. The list answers "what
 * happened"; the raw document answers "what exactly did the server say", which is
 * what gets pasted into a ticket. Copying it is one button for the same reason.
 */
export function ActivityEventSheet({
  event,
  onClose,
  onFilterByActor,
}: {
  readonly event: ActivityEvent;
  readonly onClose: () => void;
  readonly onFilterByActor: (actorName: string) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');

  const raw = JSON.stringify(event, null, 2);

  const copyJson = () => {
    void navigator.clipboard.writeText(raw).then(
      () => toast.success(tCommon('action.copied')),
      () => toast.error(t('keys.copyFailed')),
    );
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader className="flex-row items-center gap-3 border-b">
          <div className="flex min-w-0 flex-1 flex-col">
            <SheetTitle className="truncate text-sm">{event.title}</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs" dir="ltr">
              {event.action}
              {event.target === null ? '' : ` · ${event.target}`}
            </SheetDescription>
          </div>
          <Badge variant={ACTIVITY_RESULT_BADGES[event.result]}>
            {tDomain(`activityResult.${event.result}`)}
          </Badge>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          <dl className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-2 text-[0.8125rem]">
            <dt className="text-muted-foreground">{t('activity.detail.event')}</dt>
            <dd className="font-mono" dir="ltr">
              {event.action}
            </dd>
            <dt className="text-muted-foreground">{t('activity.column.category')}</dt>
            <dd>{tDomain(`activityCategory.${event.category}`)}</dd>
            <dt className="text-muted-foreground">{t('activity.column.time')}</dt>
            <dd>
              <DateTime value={event.at} style="long" />
            </dd>
            <dt className="text-muted-foreground">{t('activity.column.actor')}</dt>
            <dd className="font-mono">
              {event.actor.name} <span className="text-muted-foreground">({event.actor.type})</span>
            </dd>
            <dt className="text-muted-foreground">{t('activity.column.server')}</dt>
            <dd className="font-mono">{event.serverName ?? <Dash />}</dd>
            <dt className="text-muted-foreground">{t('activity.column.target')}</dt>
            <dd className="font-mono break-all" dir="ltr">
              {event.target ?? <Dash />}
            </dd>
            <dt className="text-muted-foreground">{t('activity.column.ip')}</dt>
            <dd className="font-mono" dir="ltr">
              {event.ip ?? <Dash />}
            </dd>
            <dt className="text-muted-foreground">{t('activity.column.result')}</dt>
            <dd>
              <Badge variant={ACTIVITY_RESULT_BADGES[event.result]}>
                {tDomain(`activityResult.${event.result}`)}
              </Badge>
            </dd>
          </dl>

          {event.requestId === null ? null : (
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.8125rem] font-medium">{t('activity.detail.requestId')}</span>
              <CopyField value={event.requestId} label={t('activity.detail.copyRequestId')} />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[0.8125rem] font-medium">{t('activity.detail.raw')}</span>
              <Button variant="outline" size="sm" onClick={copyJson}>
                <BracesIcon />
                {t('activity.detail.copyJson')}
              </Button>
            </div>
            <CodeEditor
              value={raw}
              language="json"
              readOnly
              height="20rem"
              ariaLabel={t('activity.detail.raw')}
            />
          </div>
        </div>

        <SheetFooter className="flex-row items-center gap-2 border-t">
          {event.category === 'access' ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/keys">
                <KeyRoundIcon />
                {t('activity.detail.viewKeys')}
              </Link>
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onFilterByActor(event.actor.name)}
          >
            <ListFilterIcon />
            {t('activity.detail.filterByActor')}
          </Button>
          <Button variant="ghost" size="sm" className="ms-auto" onClick={onClose}>
            {tCommon('action.close')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
