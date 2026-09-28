import type { ReplicationRule } from '@storage-io/contracts';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/app/Button';
import { Combobox, type ComboboxOption } from '@/components/app/Combobox';
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
import { OptionRow } from '@/components/app/FormRow';
import { Spinner } from '@/components/app/Spinner';
import { Switch } from '@/components/app/Switch';
import { useServerList } from '@/features/shell/api';
import { useBuckets } from '../api';

/**
 * Add or edit a replication rule.
 *
 * The destination is an ARN in the contract (`destination.bucketArn`), which is
 * what S3 replication actually stores. Typing an ARN by hand is error-prone, so
 * the dialog offers a server and a bucket from the inventory and composes the ARN
 * from them, while still letting it be edited directly for a destination
 * storage-io does not manage.
 */

const ARN_PREFIX = 'arn:aws:s3:::';
const DEFAULT_PRIORITY = 1;
const BUCKET_PICKER_PAGE_SIZE = 200;

export function ReplicationRuleDialog({
  open,
  onOpenChange,
  rule,
  existingIds,
  busy = false,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly rule: ReplicationRule | null;
  readonly existingIds: readonly string[];
  readonly busy?: boolean;
  readonly onSubmit: (rule: ReplicationRule) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ReplicationRuleDialogBody
          rule={rule}
          existingIds={existingIds}
          busy={busy}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function ReplicationRuleDialogBody({
  rule,
  existingIds,
  busy,
  onCancel,
  onSubmit,
}: {
  readonly rule: ReplicationRule | null;
  readonly existingIds: readonly string[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (rule: ReplicationRule) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const nameId = useId();
  const arnId = useId();
  const prefixId = useId();
  const priorityId = useId();
  const classId = useId();

  const isEdit = rule !== null;
  const [id, setId] = useState(rule?.id ?? '');
  const [serverId, setServerId] = useState<string | null>(null);
  const [arn, setArn] = useState(rule?.destination.bucketArn ?? '');
  const [storageClass, setStorageClass] = useState(rule?.destination.storageClass ?? '');
  const [prefix, setPrefix] = useState(rule?.prefix ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? DEFAULT_PRIORITY));
  const [deleteMarkers, setDeleteMarkers] = useState(rule?.deleteMarkers ?? false);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);

  const servers = useServerList();
  const destinationBuckets = useBuckets({
    serverId: serverId ?? undefined,
    sort: 'name',
    page: 1,
    pageSize: BUCKET_PICKER_PAGE_SIZE,
  });

  const serverOptions = useMemo<readonly ComboboxOption[]>(
    () => (servers.data?.items ?? []).map((server) => ({ value: server.id, label: server.name })),
    [servers.data],
  );

  const bucketOptions = useMemo<readonly ComboboxOption[]>(
    () =>
      serverId === null
        ? []
        : (destinationBuckets.data?.items ?? []).map((bucket) => ({
            value: bucket.name,
            label: bucket.name,
          })),
    [destinationBuckets.data, serverId],
  );

  const trimmedId = id.trim();
  const takenIds = existingIds.filter((existing) => existing !== rule?.id);
  const duplicateId = trimmedId.length > 0 && takenIds.includes(trimmedId);
  const parsedPriority = Number.parseInt(priority, 10);
  const priorityValid = Number.isFinite(parsedPriority) && parsedPriority >= 0;
  const canSubmit =
    trimmedId.length > 0 && !duplicateId && arn.trim().length > 0 && priorityValid && !busy;

  function submit(): void {
    if (!canSubmit) return;
    onSubmit({
      id: trimmedId,
      enabled,
      prefix: prefix.trim(),
      destination: {
        bucketArn: arn.trim(),
        storageClass: storageClass.trim() === '' ? null : storageClass.trim(),
      },
      deleteMarkers,
      priority: parsedPriority,
    });
  }

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? t('bucket.replication.dialog.editTitle')
            : t('bucket.replication.dialog.addTitle')}
        </DialogTitle>
        <DialogDescription>{t('bucket.replication.dialog.description')}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>{t('bucket.replication.dialog.name')}</Label>
          <Input
            id={nameId}
            value={id}
            onChange={(event) => setId(event.target.value)}
            aria-invalid={duplicateId}
            autoComplete="off"
            className="ltr-isolate font-mono"
          />
          {duplicateId ? (
            <p className="text-[0.8125rem] text-destructive">
              {t('bucket.lifecycle.dialog.duplicateId')}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={priorityId}>{t('bucket.replication.dialog.priority')}</Label>
          <Input
            id={priorityId}
            value={priority}
            inputMode="numeric"
            aria-invalid={!priorityValid}
            onChange={(event) => setPriority(event.target.value)}
            className="num w-24"
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('bucket.replication.dialog.priorityHint')}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            {t('bucket.replication.dialog.destinationServer')}
          </span>
          <Combobox
            options={serverOptions}
            value={serverId}
            onValueChange={setServerId}
            placeholder={tCommon('form.comboboxPlaceholder')}
            aria-label={t('bucket.replication.dialog.destinationServer')}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            {t('bucket.replication.dialog.destinationBucket')}
          </span>
          <Combobox
            options={bucketOptions}
            value={null}
            onValueChange={(bucket) => {
              if (bucket !== null) setArn(`${ARN_PREFIX}${bucket}`);
            }}
            placeholder={tCommon('form.comboboxPlaceholder')}
            disabled={serverId === null || destinationBuckets.isLoading}
            aria-label={t('bucket.replication.dialog.destinationBucket')}
          />
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={arnId}>{t('bucket.replication.dialog.destinationArn')}</Label>
          <Input
            id={arnId}
            value={arn}
            onChange={(event) => setArn(event.target.value)}
            placeholder={`${ARN_PREFIX}bucket-name`}
            className="ltr-isolate font-mono"
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('bucket.replication.dialog.destinationArnHint')}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={prefixId}>{t('bucket.replication.dialog.prefix')}</Label>
          <Input
            id={prefixId}
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            placeholder="raw/"
            className="ltr-isolate font-mono"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={classId}>{t('bucket.replication.dialog.storageClass')}</Label>
          <Input
            id={classId}
            value={storageClass}
            onChange={(event) => setStorageClass(event.target.value)}
            placeholder="STANDARD"
            className="ltr-isolate font-mono"
          />
        </div>
      </div>

      <div className="rounded-lg border px-(--card-pad)">
        <OptionRow label={t('bucket.replication.dialog.enabled')}>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('bucket.replication.dialog.enabled')}
          />
        </OptionRow>
        <OptionRow label={t('bucket.replication.dialog.deleteMarkers')}>
          <Switch
            checked={deleteMarkers}
            onCheckedChange={setDeleteMarkers}
            aria-label={t('bucket.replication.dialog.deleteMarkers')}
          />
        </OptionRow>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy ? <Spinner /> : null}
          {isEdit ? tCommon('action.save') : tCommon('action.create')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
