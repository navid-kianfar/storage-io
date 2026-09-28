import {
  NOTIFICATION_TARGET_KINDS,
  type NotificationTarget,
  type NotificationTargetKind,
} from '@storage-io/contracts';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/app/Button';
import { Checkbox } from '@/components/app/Checkbox';
import { Combobox } from '@/components/app/Combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/app/Dialog';
import { Input } from '@/components/app/Input';
import { Label } from '@/components/app/Label';
import { Spinner } from '@/components/app/Spinner';

/**
 * Add or edit an event destination.
 *
 * The event names are S3's own and are not translated: they travel to the storage
 * server verbatim and an operator matching them against a log needs the exact
 * string. The list is the set every supported provider understands.
 */

export const S3_EVENT_NAMES = [
  's3:ObjectCreated:*',
  's3:ObjectCreated:Put',
  's3:ObjectCreated:Post',
  's3:ObjectCreated:Copy',
  's3:ObjectCreated:CompleteMultipartUpload',
  's3:ObjectRemoved:*',
  's3:ObjectRemoved:Delete',
  's3:ObjectRemoved:DeleteMarkerCreated',
  's3:ObjectAccessed:Get',
  's3:ObjectAccessed:Head',
] as const;

export function EventDestinationDialog({
  open,
  onOpenChange,
  target,
  busy = false,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly target: NotificationTarget | null;
  readonly busy?: boolean;
  readonly onSubmit: (target: NotificationTarget) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <EventDestinationDialogBody
          target={target}
          busy={busy}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function EventDestinationDialogBody({
  target,
  busy,
  onCancel,
  onSubmit,
}: {
  readonly target: NotificationTarget | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (target: NotificationTarget) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const arnId = useId();
  const kindId = useId();
  const prefixId = useId();
  const suffixId = useId();
  const eventsId = useId();

  const isEdit = target !== null;
  const [arn, setArn] = useState(target?.arn ?? '');
  const [kind, setKind] = useState<NotificationTargetKind>(target?.kind ?? 'queue');
  const [events, setEvents] = useState<readonly string[]>(
    target?.events ?? ['s3:ObjectCreated:*'],
  );
  const [prefix, setPrefix] = useState(target?.prefix ?? '');
  const [suffix, setSuffix] = useState(target?.suffix ?? '');

  const kindOptions = useMemo(
    () =>
      NOTIFICATION_TARGET_KINDS.map((value) => ({
        value,
        label: t(`bucket.events.kind.${value}`),
      })),
    [t],
  );

  const canSubmit = arn.trim().length > 0 && events.length > 0 && !busy;

  function toggleEvent(name: string, checked: boolean): void {
    setEvents((current) =>
      checked ? [...current, name] : current.filter((existing) => existing !== name),
    );
  }

  function submit(): void {
    if (!canSubmit) return;
    onSubmit({
      // A new destination is identified by its ARN until the server assigns one.
      id: target?.id ?? arn.trim(),
      arn: arn.trim(),
      kind,
      events: [...events],
      prefix: prefix.trim(),
      suffix: suffix.trim(),
    });
  }

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {isEdit ? t('bucket.events.dialog.editTitle') : t('bucket.events.dialog.addTitle')}
        </DialogTitle>
        <DialogDescription>{t('bucket.events.dialog.description')}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={arnId}>{t('bucket.events.dialog.arn')}</Label>
          <Input
            id={arnId}
            value={arn}
            onChange={(event) => setArn(event.target.value)}
            placeholder="arn:minio:sqs::webhook:webhook"
            className="ltr-isolate font-mono"
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('bucket.events.dialog.arnHint')}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={kindId}>{t('bucket.events.dialog.kind')}</Label>
          <Combobox
            id={kindId}
            options={kindOptions}
            value={kind}
            onValueChange={(next) => setKind(next === null ? 'queue' : next)}
            aria-label={t('bucket.events.dialog.kind')}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={prefixId}>{t('bucket.events.dialog.prefix')}</Label>
          <Input
            id={prefixId}
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            placeholder="raw/"
            className="ltr-isolate font-mono"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={suffixId}>{t('bucket.events.dialog.suffix')}</Label>
          <Input
            id={suffixId}
            value={suffix}
            onChange={(event) => setSuffix(event.target.value)}
            placeholder=".jpg"
            className="ltr-isolate font-mono"
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2" aria-describedby={`${eventsId}-hint`}>
        <legend className="text-sm font-medium">{t('bucket.events.dialog.events')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {S3_EVENT_NAMES.map((name) => {
            const checkboxId = `${eventsId}-${name}`;
            return (
              <div key={name} className="flex items-center gap-2">
                <Checkbox
                  id={checkboxId}
                  checked={events.includes(name)}
                  onCheckedChange={(checked) => toggleEvent(name, checked === true)}
                />
                <Label htmlFor={checkboxId} className="ltr-isolate font-mono text-xs font-normal">
                  {name}
                </Label>
              </div>
            );
          })}
        </div>
        <p id={`${eventsId}-hint`} className="text-[0.8125rem] text-muted-foreground">
          {t('bucket.events.dialog.eventsHint')}
        </p>
      </fieldset>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy ? <Spinner /> : null}
          {isEdit ? tCommon('action.save') : tCommon('action.add')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
