import {
  bucketNameSchema,
  isValidBucketName,
  type CreateBucketRequest,
  type Server,
} from '@storage-io/contracts';
import { useNavigate } from '@tanstack/react-router';
import { BracesIcon, CircleCheckIcon, CircleXIcon, GlobeIcon, LockIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/app/Alert';
import { Button } from '@/components/app/Button';
import { ByteSizeInput } from '@/components/app/ByteSizeInput';
import { ChoiceCards, type ChoiceOption } from '@/components/app/ChoiceCards';
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
import { FormField } from '@/components/app/FormField';
import { OptionRow } from '@/components/app/FormRow';
import { ProviderMark } from '@/components/app/ProviderMark';
import { Spinner } from '@/components/app/Spinner';
import { Switch } from '@/components/app/Switch';
import { useServerList } from '@/features/shell/api';
import { useRouteState } from '@/lib/dialogs/route';
import { toastProblem } from '@/lib/api/problems';
import { useCreateBucket } from '../api';

/**
 * Create bucket — the `/buckets/new` route over the buckets list. A server may
 * be pre-selected through router history state, so the
 * command palette, a server page and an empty state can all open it pre-filled.
 *
 * The name is validated as the operator types with the contract's own
 * `isValidBucketName`, which is the same function the API uses; there is no second
 * opinion about what a legal bucket name is.
 *
 * Object lock cannot be added to a bucket later, so the switch is only meaningful
 * here — and it requires versioning, which is why turning it on turns versioning
 * on with it.
 */

type AccessChoice = 'private' | 'public-read' | 'custom';

export interface CreateBucketDialogProps {
  /** Pre-selected server, from router history state; never from the URL. */
  readonly initialServerId: string | null;
  readonly onClose: () => void;
}

function CreateBucketDialog({ initialServerId, onClose }: CreateBucketDialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const servers = useServerList();
  const create = useCreateBucket();

  const options = useMemo<readonly ComboboxOption[]>(
    () =>
      (servers.data?.items ?? []).map((server) => ({
        value: server.id,
        label: server.name,
        description:
          server.status === 'offline'
            ? t('buckets.create.serverOffline')
            : (server.version ?? server.endpoint),
        icon: <ProviderMark provider={server.provider} size="sm" />,
        keywords: [server.provider, server.endpoint],
        disabled: server.status === 'offline',
      })),
    [servers.data, t],
  );

  const [selectedServer, setSelectedServer] = useState<string | null>(initialServerId);
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [versioning, setVersioning] = useState(true);
  const [objectLock, setObjectLock] = useState(false);
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const [access, setAccess] = useState<AccessChoice>('private');

  const server = useMemo<Server | undefined>(
    () => servers.data?.items.find((item) => item.id === selectedServer || item.name === selectedServer),
    [servers.data, selectedServer],
  );

  const nameCheck = isValidBucketName(name);
  const nameTouched = name.length > 0;
  const nameError = nameTouched && !nameCheck.valid;
  const lockSupported = server === undefined || server.capabilities.objectLock !== 'not_supported';
  const quotaSupported = server === undefined || server.capabilities.bucketQuota !== 'not_supported';

  const accessOptions = useMemo<readonly ChoiceOption<AccessChoice>[]>(
    () => [
      {
        value: 'private',
        label: t('buckets.create.accessPrivate'),
        description: t('buckets.create.accessPrivateHint'),
        media: <LockIcon aria-hidden="true" />,
      },
      {
        value: 'public-read',
        label: t('buckets.create.accessPublic'),
        description: t('buckets.create.accessPublicHint'),
        media: <GlobeIcon aria-hidden="true" />,
      },
      {
        value: 'custom',
        label: t('buckets.create.accessCustom'),
        description: t('buckets.create.accessCustomHint'),
        media: <BracesIcon aria-hidden="true" />,
      },
    ],
    [t],
  );

  const canSubmit =
    selectedServer !== null && nameCheck.valid && !create.isPending && server?.status !== 'offline';

  function submit(): void {
    if (!canSubmit || selectedServer === null) return;
    const parsedName = bucketNameSchema.safeParse(name);
    if (!parsedName.success) return;

    const quota: CreateBucketRequest['quota'] =
      quotaBytes === null || !quotaSupported
        ? null
        : { limitBytes: quotaBytes, mode: server?.capabilities.bucketQuota === 'supported' ? 'hard' : 'alert' };

    create.mutate(
      {
        serverId: selectedServer,
        name: parsedName.data,
        region: region.trim() === '' ? undefined : region.trim(),
        // Object lock needs versioning, so the request never contradicts itself.
        versioning: versioning || objectLock,
        objectLock: objectLock && lockSupported,
        quota,
        // `custom` is not a settable access level: the bucket starts private and
        // the operator edits the policy on its settings page.
        access: access === 'public-read' ? 'public-read' : 'private',
      },
      {
        onSuccess: (bucket) => {
          toast.success(t('buckets.create.created'), {
            description: `${bucket.name} · ${bucket.serverName}`,
          });
          if (access === 'custom') {
            void navigate({
              to: '/buckets/$bucketId',
              params: { bucketId: bucket.id },
              hash: 'access',
            });
            return;
          }
          onClose();
        },
        onError: (error) => toastProblem(error, tCommon, t('buckets.create.failed')),
      },
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('buckets.create.title')}</DialogTitle>
          <DialogDescription>{t('buckets.create.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid items-start gap-4 sm:grid-cols-2">
          <FormField label={t('buckets.create.server')}>
            {({ id, describedBy }) => (
              <Combobox
                id={id}
                aria-describedby={describedBy}
                options={options}
                value={selectedServer}
                onValueChange={setSelectedServer}
                placeholder={tCommon('form.comboboxPlaceholder')}
                disabled={servers.isLoading}
                aria-label={t('buckets.create.server')}
              />
            )}
          </FormField>
          <FormField label={t('buckets.create.region')}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                placeholder={server?.region ?? ''}
                className="ltr-isolate font-mono"
              />
            )}
          </FormField>
          <FormField
            className="sm:col-span-2"
            label={t('buckets.create.name')}
            hint={
              <span className="flex items-center gap-1.5">
                {nameError ? (
                  <CircleXIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                ) : (
                  <CircleCheckIcon
                    className="size-3.5 shrink-0 text-success-foreground"
                    aria-hidden="true"
                  />
                )}
                {nameError ? nameCheck.message : t('buckets.create.nameHint')}
              </span>
            }
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={nameError}
                className="ltr-isolate font-mono"
              />
            )}
          </FormField>
        </div>

        <div className="rounded-lg border px-(--card-pad)">
          <OptionRow label={t('buckets.create.versioning')} hint={t('buckets.create.versioningHint')}>
            <Switch
              checked={versioning || objectLock}
              disabled={objectLock}
              onCheckedChange={setVersioning}
              aria-label={t('buckets.create.versioning')}
            />
          </OptionRow>
          <OptionRow
            label={t('buckets.create.objectLock')}
            hint={
              lockSupported
                ? t('buckets.create.objectLockHint')
                : // Not "enable versioning first": versioning will not help, this
                  // provider has no object lock at all.
                  t('buckets.create.objectLockNotSupported', {
                    provider: server?.provider ?? '',
                  })
            }
          >
            <Switch
              checked={objectLock}
              disabled={!lockSupported}
              onCheckedChange={(checked) => {
                setObjectLock(checked);
                if (checked) setVersioning(true);
              }}
              aria-label={t('buckets.create.objectLock')}
            />
          </OptionRow>
          <OptionRow
            label={t('buckets.create.quota')}
            hint={quotaSupported ? t('buckets.create.quotaHint') : t('buckets.create.quotaNotSupported')}
          >
            <ByteSizeInput
              value={quotaBytes}
              onValueChange={setQuotaBytes}
              aria-label={t('buckets.create.quota')}
            />
          </OptionRow>
        </div>

        <FormField label={t('buckets.create.access')} className="gap-2">
          {() => (
          <ChoiceCards
            options={accessOptions}
            value={access}
            onValueChange={setAccess}
            columns={3}
            aria-label={t('buckets.create.access')}
          />
          )}
        </FormField>

        {access === 'public-read' ? (
          <Alert variant="warning">
            <AlertTitle>{t('bucket.access.publicWarning')}</AlertTitle>
            <AlertDescription>{t('bucket.access.publicWarningDetail')}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            {tCommon('action.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {create.isPending ? <Spinner /> : null}
            {t('buckets.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { CreateBucketDialog };

/** `/buckets/new` — the create dialog over the buckets list. */
export function CreateBucketRoute() {
  const navigate = useNavigate();
  const state = useRouteState();
  const close = useCallback(() => {
    void navigate({ to: '/buckets' });
  }, [navigate]);
  return <CreateBucketDialog initialServerId={state.serverId ?? null} onClose={close} />;
}
