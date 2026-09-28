import type { RetentionSettings, Settings } from '@storage-io/contracts';
import { FileDownIcon, FileUpIcon, TriangleAlertIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FileDropzone,
  FormActions,
  FormField,
  FormRow,
  Input,
  SectionCard,
  Skeleton,
  Spinner,
  type ComboboxOption,
  type DroppedFile,
} from '@/components/app';
import { useExportConfig, useImportConfig, useUpdateSettings } from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';
import { downloadBlob } from '@/lib/csv/csv';

/**
 * storage-io's own configuration: the servers it knows, the credentials it holds
 * and the preferences on this page — not the data on the storage servers.
 *
 * The export is encrypted with a passphrase the operator chooses, and there is no
 * way to recover it: it is not stored anywhere, which is the point of it. The
 * dialog says so before the file is produced rather than after.
 */

const PASSPHRASE_MIN = 8;
const ACTIVITY_DAYS_CHOICES = [30, 90, 180, 365] as const;
const METRICS_DAYS_CHOICES = [30, 90, 365, 395] as const;

export function BackupSection({
  settings,
  loading,
}: {
  readonly settings: Settings | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const apiError = useApiError();
  const save = useUpdateSettings();
  const exportConfig = useExportConfig();
  const importConfig = useImportConfig();

  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [retention, setRetention] = useState<RetentionSettings | null>(null);

  const saved = settings?.retention;
  const effective = retention ?? saved;
  const dirty = effective !== undefined && JSON.stringify(effective) !== JSON.stringify(saved);

  const activityOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      ACTIVITY_DAYS_CHOICES.map((days) => ({
        value: String(days),
        label: t('settings.backup.days', { count: days }),
      })),
    [t],
  );

  const metricsOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      METRICS_DAYS_CHOICES.map((days) => ({
        value: String(days),
        label: t('settings.backup.days', { count: days }),
      })),
    [t],
  );

  if (loading || settings === undefined || effective === undefined) {
    return (
      <SectionCard title={t('settings.backup.title')} description={t('settings.backup.description')}>
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard
        flush
        title={t('settings.backup.title')}
        description={t('settings.backup.description')}
        footer={
          <FormActions>
            <Button
              onClick={() =>
                save.mutate(
                  { retention: effective },
                  {
                    onSuccess: () => {
                      toast.success(t('settings.backup.retentionSaved'));
                      setRetention(null);
                    },
                    onError: (error) => apiError.toastError(error, t('settings.backup.failed')),
                  },
                )
              }
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? <Spinner /> : null}
              {t('settings.saveChanges')}
            </Button>
          </FormActions>
        }
      >
        <FormRow label={t('settings.backup.export')} hint={t('settings.backup.exportHint')}>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setExportOpen(true)}>
              <FileDownIcon />
              {t('settings.backup.exportAction')}
            </Button>
            <Button variant="ghost" onClick={() => setImportOpen(true)}>
              <FileUpIcon />
              {t('settings.backup.importAction')}
            </Button>
          </div>
        </FormRow>

        <FormRow
          label={t('settings.backup.activityRetention')}
          hint={t('settings.backup.activityRetentionHint')}
        >
          <Combobox
            options={activityOptions}
            value={String(effective.activityDays)}
            onValueChange={(value) => {
              if (value === null) return;
              setRetention({ ...effective, activityDays: Number.parseInt(value, 10) });
            }}
            className="sm:w-64"
            aria-label={t('settings.backup.activityRetention')}
          />
        </FormRow>

        <FormRow
          label={t('settings.backup.metricsRetention')}
          hint={t('settings.backup.metricsRetentionHint')}
        >
          <Combobox
            options={metricsOptions}
            value={String(effective.metricsDays)}
            onValueChange={(value) => {
              if (value === null) return;
              setRetention({ ...effective, metricsDays: Number.parseInt(value, 10) });
            }}
            className="sm:w-64"
            aria-label={t('settings.backup.metricsRetention')}
          />
        </FormRow>
      </SectionCard>

      <PassphraseDialog
        open={exportOpen}
        title={t('settings.backup.exportTitle')}
        description={t('settings.backup.exportDescription')}
        confirmLabel={t('settings.backup.exportAction')}
        busy={exportConfig.isPending}
        requireConfirmation
        onClose={() => setExportOpen(false)}
        onSubmit={(passphrase) =>
          exportConfig.mutate(passphrase, {
            onSuccess: (blob) => {
              // The API names it `storage-io-<date>.sioconf` in Content-Disposition;
              // the same name is rebuilt here because fetch does not expose that
              // header cross-origin and a mismatched extension is a file the import
              // dropzone then refuses.
              const fileName = `storage-io-${new Date().toISOString().slice(0, 10)}.sioconf`;
              downloadBlob(blob, fileName);
              toast.success(t('settings.backup.exported'), { description: fileName });
              setExportOpen(false);
            },
            onError: (error) => apiError.toastError(error, t('settings.backup.exportFailed')),
          })
        }
      >
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{t('settings.backup.passphraseWarningTitle')}</AlertTitle>
          <AlertDescription>{t('settings.backup.passphraseWarningBody')}</AlertDescription>
        </Alert>
      </PassphraseDialog>

      <ImportConfigDialog
        open={importOpen}
        busy={importConfig.isPending}
        onClose={() => setImportOpen(false)}
        onSubmit={(file, passphrase) =>
          importConfig.mutate(
            { file, passphrase },
            {
              onSuccess: (result) => {
                toast.success(t('settings.backup.imported'), {
                  description: t('settings.backup.importedDetail', { servers: result.servers }),
                });
                setImportOpen(false);
              },
              onError: (error) => apiError.toastError(error, t('settings.backup.importFailed')),
            },
          )
        }
      />
    </>
  );
}

function PassphraseDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  requireConfirmation,
  children,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  /** Asks for the passphrase twice, for the export that cannot be recovered. */
  readonly requireConfirmation: boolean;
  readonly children?: React.ReactNode;
  readonly onClose: () => void;
  readonly onSubmit: (passphrase: string) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const longEnough = passphrase.length >= PASSPHRASE_MIN;
  const matches = !requireConfirmation || passphrase === confirmation;
  const valid = longEnough && matches;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPassphrase('');
          setConfirmation('');
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {children}

        <FormField
          label={t('settings.backup.passphrase')}
          hint={t('settings.backup.passphraseHint', { min: PASSPHRASE_MIN })}
          error={passphrase.length > 0 && !longEnough ? t('settings.backup.tooShort') : undefined}
        >
          {({ id, invalid }) => (
            <Input
              id={id}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              type="password"
              autoComplete="new-password"
              dir="ltr"
              aria-invalid={invalid}
            />
          )}
        </FormField>

        {requireConfirmation ? (
          <FormField
            label={t('settings.backup.passphraseConfirm')}
            error={confirmation.length > 0 && !matches ? t('settings.backup.mismatch') : undefined}
          >
            {({ id, invalid }) => (
              <Input
                id={id}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                type="password"
                autoComplete="new-password"
                dir="ltr"
                aria-invalid={invalid}
              />
            )}
          </FormField>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={() => onSubmit(passphrase)} disabled={!valid || busy}>
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportConfigDialog({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (file: File, passphrase: string) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [files, setFiles] = useState<readonly DroppedFile[]>([]);
  const [passphrase, setPassphrase] = useState('');

  const file = files[0]?.file;
  const valid = file !== undefined && passphrase.length >= PASSPHRASE_MIN;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFiles([]);
          setPassphrase('');
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.backup.importTitle')}</DialogTitle>
          <DialogDescription>{t('settings.backup.importDescription')}</DialogDescription>
        </DialogHeader>

        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{t('settings.backup.importWarningTitle')}</AlertTitle>
          <AlertDescription>{t('settings.backup.importWarningBody')}</AlertDescription>
        </Alert>

        <FileDropzone
          files={files}
          onFilesChange={setFiles}
          accept=".sioconf,.enc,application/octet-stream"
          maxFiles={1}
          description={t('settings.backup.dropHint')}
        />

        <FormField
          label={t('settings.backup.passphrase')}
          hint={t('settings.backup.importPassphraseHint')}
        >
          {({ id }) => (
            <Input
              id={id}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              type="password"
              autoComplete="off"
              dir="ltr"
            />
          )}
        </FormField>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (file !== undefined) onSubmit(file, passphrase);
            }}
            disabled={!valid || busy}
          >
            {busy ? <Spinner /> : <FileUpIcon />}
            {t('settings.backup.importAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
