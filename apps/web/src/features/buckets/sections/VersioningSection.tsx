import type {
  BucketDetail,
  BucketObjectLockResponse,
  ObjectLockMode,
  Server,
} from '@storage-io/contracts';
import { ShieldAlertIcon, ShieldIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/app/Alert';
import { Button } from '@/components/app/Button';
import { CardContent } from '@/components/app/Card';
import { ChoiceCards } from '@/components/app/ChoiceCards';
import { FormActions, FormRow } from '@/components/app/FormRow';
import { Input } from '@/components/app/Input';
import { Spinner } from '@/components/app/Spinner';
import { toastProblem } from '@/lib/api/problems';
import {
  useBucketObjectLock,
  useBucketVersioning,
  useSaveBucketObjectLock,
  useSaveBucketVersioning,
  type BucketRefParams,
} from '../api';
import { SectionCard, sectionAvailability } from '../components/SectionCard';

/**
 * Versioning and object lock.
 *
 * Versioning has two settable states: S3 has no way back to "never versioned", so
 * `off` is not offered — only `enabled` and `suspended`, which is what the
 * contract's `bucketVersioningBodySchema` allows.
 *
 * Object lock can only be turned on when a bucket is created. When it is off, the
 * whole lock half is explanation rather than controls, because a switch here would
 * be a switch that always fails.
 */

type VersioningChoice = 'enabled' | 'suspended';

const DEFAULT_RETENTION_DAYS = 30;

export function VersioningSection({
  bucketRef,
  bucket,
  server,
  loading,
}: {
  readonly bucketRef: BucketRefParams;
  readonly bucket: BucketDetail | undefined;
  readonly server: Server | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');

  const availability = sectionAvailability(server, 'versioning', loading);
  const ready = availability === 'ready';
  const lockAvailability = sectionAvailability(server, 'objectLock', loading);
  const lockSupported = lockAvailability !== 'not_supported';

  const versioningQuery = useBucketVersioning(bucketRef, ready);
  const lockQuery = useBucketObjectLock(bucketRef, ready && lockSupported);

  const versioning = versioningQuery.data;
  const lock = lockQuery.data;
  // The lock request is skipped entirely when the provider has no lock API, so
  // "still loading" only counts the requests that were actually made.
  const waiting = versioning === undefined || (lockSupported && lock === undefined);

  return (
    <SectionCard
      id="versioning"
      title={t('bucket.versioning.title')}
      description={t('bucket.versioning.description')}
      availability={ready && waiting ? 'loading' : availability}
      provider={server?.provider}
    >
      {waiting ? null : (
        <VersioningForm
          key={`${versioning.status}:${JSON.stringify(lock ?? null)}`}
          bucketRef={bucketRef}
          savedStatus={versioning.status === 'suspended' ? 'suspended' : 'enabled'}
          lock={lock}
          lockEnabled={lock?.enabled ?? bucket?.objectLock ?? false}
          lockSupported={lockSupported}
        />
      )}
    </SectionCard>
  );
}

/** Mounted with the server's answer as its initial state and keyed by it. */
function VersioningForm({
  bucketRef,
  savedStatus,
  lock,
  lockEnabled,
  lockSupported,
}: {
  readonly bucketRef: BucketRefParams;
  readonly savedStatus: VersioningChoice;
  readonly lock: BucketObjectLockResponse | undefined;
  readonly lockEnabled: boolean;
  readonly lockSupported: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const retentionId = useId();

  const saveVersioning = useSaveBucketVersioning();
  const saveLock = useSaveBucketObjectLock();

  const savedMode: ObjectLockMode = lock?.mode ?? 'GOVERNANCE';
  const savedDays = String(lock?.days ?? DEFAULT_RETENTION_DAYS);

  const [versioning, setVersioning] = useState<VersioningChoice>(savedStatus);
  const [lockMode, setLockMode] = useState<ObjectLockMode>(savedMode);
  const [retentionDays, setRetentionDays] = useState(savedDays);

  const parsedDays = Number.parseInt(retentionDays, 10);
  const daysValid = Number.isFinite(parsedDays) && parsedDays >= 1;
  const busy = saveVersioning.isPending || saveLock.isPending;
  const dirty =
    versioning !== savedStatus || lockMode !== savedMode || retentionDays !== savedDays;
  const canSave = dirty && (!lockEnabled || daysValid) && !busy;

  function reset(): void {
    setVersioning(savedStatus);
    setLockMode(savedMode);
    setRetentionDays(savedDays);
    toast.info(t('bucket.discard'));
  }

  function submit(): void {
    if (!canSave) return;
    saveVersioning.mutate(
      { ref: bucketRef, body: { status: versioning } },
      {
        onSuccess: () => {
          if (!lockEnabled) {
            toast.success(t('bucket.versioning.saved'));
            return;
          }
          // Lock is a second resource, written only when the bucket has it and only
          // after versioning succeeded — the lock needs versioning on.
          saveLock.mutate(
            { ref: bucketRef, body: { mode: lockMode, days: parsedDays, years: null } },
            {
              onSuccess: () => toast.success(t('bucket.versioning.saved')),
              onError: (error) => toastProblem(error, tCommon, t('bucket.versioning.saved')),
            },
          );
        },
        onError: (error) => toastProblem(error, tCommon, t('bucket.versioning.saved')),
      },
    );
  }

  return (
    <>
      <FormRow label={t('bucket.versioning.label')} hint={t('bucket.versioning.hint')}>
        <ChoiceCards
          options={[
            {
              value: 'enabled',
              label: t('bucket.versioning.enabled'),
              description: t('bucket.versioning.enabledHint'),
            },
            {
              value: 'suspended',
              label: t('bucket.versioning.suspended'),
              description: t('bucket.versioning.suspendedHint'),
            },
          ]}
          value={versioning}
          onValueChange={setVersioning}
          orientation="rows"
          aria-label={t('bucket.versioning.label')}
        />
      </FormRow>

      {!lockSupported ? null : (
        <FormRow label={t('bucket.versioning.lockMode')} hint={t('bucket.versioning.lockModeHint')}>
          {lockEnabled ? (
            <div className="flex flex-col gap-3">
              <ChoiceCards
                options={[
                  {
                    value: 'GOVERNANCE',
                    label: t('bucket.versioning.governance'),
                    description: t('bucket.versioning.governanceHint'),
                    media: <ShieldIcon aria-hidden="true" />,
                  },
                  {
                    value: 'COMPLIANCE',
                    label: t('bucket.versioning.compliance'),
                    description: t('bucket.versioning.complianceHint'),
                    media: <ShieldAlertIcon aria-hidden="true" />,
                  },
                ]}
                value={lockMode}
                onValueChange={setLockMode}
                columns={2}
                aria-label={t('bucket.versioning.lockMode')}
              />
              <div className="flex items-center gap-2">
                <label htmlFor={retentionId} className="grow text-sm text-muted-foreground">
                  {t('bucket.versioning.retention')}
                </label>
                <Input
                  id={retentionId}
                  value={retentionDays}
                  inputMode="numeric"
                  aria-invalid={!daysValid}
                  onChange={(event) => setRetentionDays(event.target.value)}
                  className="num w-20"
                />
                <span className="text-sm text-muted-foreground">
                  {t('bucket.versioning.days')}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-[0.8125rem] text-muted-foreground">
              {t('bucket.versioning.lockOnlyAtCreationDetail')}
            </p>
          )}
        </FormRow>
      )}

      <CardContent>
        <Alert variant="warning">
          <AlertTitle>{t('bucket.versioning.lockOnlyAtCreation')}</AlertTitle>
          <AlertDescription>
            {lockEnabled
              ? t('bucket.versioning.lockOnDetail')
              : t('bucket.versioning.lockOnlyAtCreationDetail')}
          </AlertDescription>
        </Alert>
      </CardContent>

      <FormActions>
        <Button variant="outline" disabled={!dirty || busy} onClick={reset}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSave}>
          {busy ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      </FormActions>
    </>
  );
}
