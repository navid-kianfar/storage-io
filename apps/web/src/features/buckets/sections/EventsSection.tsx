import type {
  NotificationTarget,
  NotificationTargetState,
  Server,
} from '@storage-io/contracts';
import {
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WebhookIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/app/DropdownMenu';
import { EmptyState } from '@/components/app/EmptyState';
import { StatusDot } from '@/components/app/StatusBadge';
import { toastProblem } from '@/lib/api/problems';
import {
  useBucketNotificationStatus,
  useBucketNotifications,
  useSaveBucketNotifications,
  type BucketRefParams,
} from '../api';
import { SectionCard, sectionAvailability } from '../components/SectionCard';
import { EventDestinationDialog } from '../dialogs/EventDestinationDialog';

/**
 * Event destinations and how their delivery is going.
 *
 * The target set comes from `GET …/notifications` and the live state from
 * `GET …/notifications/status`, which only MinIO answers with anything but
 * `unknown`. The two are shown together but kept distinct: a destination that
 * exists and a destination that is delivering are different facts.
 */

const STATE_VARIANT: Readonly<Record<NotificationTargetState, 'success' | 'danger' | 'secondary'>> =
  {
    online: 'success',
    offline: 'danger',
    unknown: 'secondary',
  };

const STATE_DOT: Readonly<Record<NotificationTargetState, 'ok' | 'err' | 'muted'>> = {
  online: 'ok',
  offline: 'err',
  unknown: 'muted',
};

export function EventsSection({
  bucketRef,
  server,
  loading,
}: {
  readonly bucketRef: BucketRefParams;
  readonly server: Server | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  const availability = sectionAvailability(server, 'notifications', loading);
  const ready = availability === 'ready';
  const notifications = useBucketNotifications(bucketRef, ready);
  const status = useBucketNotificationStatus(bucketRef, ready);
  const save = useSaveBucketNotifications();

  const targets = useMemo(() => notifications.data?.targets ?? [], [notifications.data]);
  const [editing, setEditing] = useState<NotificationTarget | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const stateById = useMemo(() => {
    const map = new Map<string, { state: NotificationTargetState; detail: string | null }>();
    for (const entry of status.data?.items ?? []) {
      map.set(entry.targetId, { state: entry.state, detail: entry.detail });
    }
    return map;
  }, [status.data]);

  function write(next: readonly NotificationTarget[], message: string): void {
    save.mutate(
      { ref: bucketRef, body: { targets: [...next] } },
      {
        onSuccess: () => {
          toast.success(message);
          setDialogOpen(false);
          setEditing(null);
          void status.refetch();
        },
        onError: (error) => toastProblem(error, tCommon, t('bucket.events.saved')),
      },
    );
  }

  function upsert(target: NotificationTarget): void {
    const exists = targets.some((existing) => existing.id === target.id);
    const next = exists
      ? targets.map((existing) => (existing.id === target.id ? target : existing))
      : [...targets, target];
    write(next, t('bucket.events.saved'));
  }

  return (
    <SectionCard
      id="events"
      title={t('bucket.events.title')}
      description={t('bucket.events.description')}
      availability={availability}
      provider={server?.provider}
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('bucket.events.refreshStatus')}
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            <RefreshCwIcon />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <PlusIcon />
            {t('bucket.events.add')}
          </Button>
        </div>
      }
    >
      {targets.length === 0 ? (
        <EmptyState
          icon={WebhookIcon}
          title={t('bucket.events.empty.title')}
          description={t('bucket.events.empty.description')}
          action={
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <PlusIcon />
              {t('bucket.events.add')}
            </Button>
          }
        />
      ) : (
        <ul className="border-t">
          {targets.map((target) => {
            const live = stateById.get(target.id);
            const state: NotificationTargetState = live?.state ?? 'unknown';
            return (
              <li
                key={target.id}
                className="flex flex-wrap items-start gap-3 border-b px-(--card-pad) py-3.5 last:border-b-0"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
                  <WebhookIcon className="size-4" aria-hidden="true" />
                </span>

                <div className="flex min-w-0 grow flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="ltr-isolate truncate font-mono text-sm font-medium">
                      {target.arn}
                    </span>
                    <Badge variant={STATE_VARIANT[state]}>
                      <StatusDot tone={STATE_DOT[state]} />
                      {t(`bucket.events.state.${state}`)}
                    </Badge>
                    <Badge variant="outline">{t(`bucket.events.kind.${target.kind}`)}</Badge>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {target.events.map((name) => (
                      <span
                        key={name}
                        className="ltr-isolate rounded-sm border bg-muted/60 px-1.5 py-0.5 font-mono text-xs"
                      >
                        {name}
                      </span>
                    ))}
                    {target.prefix === '' ? null : (
                      <span className="ltr-isolate rounded-sm border bg-muted/60 px-1.5 py-0.5 font-mono text-xs">
                        <b>prefix</b>={target.prefix}
                      </span>
                    )}
                    {target.suffix === '' ? null : (
                      <span className="ltr-isolate rounded-sm border bg-muted/60 px-1.5 py-0.5 font-mono text-xs">
                        <b>suffix</b>={target.suffix}
                      </span>
                    )}
                  </div>

                  <span
                    className={
                      state === 'offline'
                        ? 'text-xs text-destructive-foreground'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {live?.detail ?? t('bucket.events.statusUnsupported')}
                  </span>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={tCommon('table.rowActions')}>
                      <EllipsisIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        setEditing(target);
                        setDialogOpen(true);
                      }}
                    >
                      <PencilIcon />
                      {t('bucket.events.menu.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() =>
                        write(
                          targets.filter((existing) => existing.id !== target.id),
                          t('bucket.events.removed'),
                        )
                      }
                    >
                      <Trash2Icon />
                      {t('bucket.events.menu.remove')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
      )}

      <EventDestinationDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        target={editing}
        busy={save.isPending}
        onSubmit={upsert}
      />
    </SectionCard>
  );
}
