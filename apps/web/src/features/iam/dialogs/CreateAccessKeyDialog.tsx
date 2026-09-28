import type { CreatedKey } from '@storage-io/contracts';
import { KeyRoundIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  Button,
  CodeEditor,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  OptionRow,
  SectionCard,
  SegmentedControl,
  Spinner,
  Switch,
  type ComboboxOption,
  type SegmentedOption,
} from '@/components/app';
import { useCreateAccessKey, useIamUsers } from '@/features/iam/api';
import { SecretRevealDialog } from '@/features/iam/components/SecretRevealDialog';
import { isoInDays } from '@/features/iam/expiry';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { useNavigate } from '@tanstack/react-router';
import { useRouteState } from '@/lib/dialogs/route';

/**
 * Create an access key for an existing S3 user — the `/keys/new` route. The
 * server and user may be pre-selected through router history state, with
 * `d_server` and `d_user` prefilled from the users page or a user's sheet.
 *
 * The key is created on the storage server, so the server list is filtered to the
 * ones whose driver actually has access keys — offering a key on a provider that
 * cannot issue one is an error the operator would only see after filling the form.
 * Expiry is likewise offered only where the driver supports it (`accessKeyExpiry`);
 * elsewhere the control says why it is not there.
 *
 * On success this dialog does not close: it swaps to the one-time secret, because
 * the secret is not retrievable afterwards.
 */

const EXPIRY_PRESETS = ['30d', '90d', '1y', 'never'] as const;
type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

const USER_PICKER_PAGE_SIZE = 500;
const PRESET_DAYS: Readonly<Record<Exclude<ExpiryPreset, 'never'>, number>> = {
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

const DEFAULT_SESSION_POLICY = `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::bucket-name/*"
    }
  ]
}`;

export interface CreateAccessKeyDialogProps {
  /** Pre-fill from router history state; never from the URL. */
  readonly initialServerId: string | null;
  readonly initialUserName: string | null;
  readonly onClose: () => void;
}

export function CreateAccessKeyDialog({
  initialServerId,
  initialUserName,
  onClose,
}: CreateAccessKeyDialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const servers = useServers();
  const createKey = useCreateAccessKey();

  const [serverId, setServerId] = useState<string | null>(initialServerId);
  const [userName, setUserName] = useState<string | null>(initialUserName);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<ExpiryPreset>('90d');
  const [restricted, setRestricted] = useState(false);
  const [policyText, setPolicyText] = useState(DEFAULT_SESSION_POLICY);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const keyCapableServers = useMemo(
    () => (servers.data?.items ?? []).filter((server) => server.capabilities.accessKeys === 'supported'),
    [servers.data],
  );

  const server = keyCapableServers.find((entry) => entry.id === serverId) ?? null;
  const expirySupported = server?.capabilities.accessKeyExpiry === 'supported';

  const users = useIamUsers({
    page: 1,
    pageSize: USER_PICKER_PAGE_SIZE,
    ...(serverId === null ? {} : { serverId }),
  });

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      keyCapableServers.map((entry) => ({
        value: entry.id,
        label: entry.name,
        description: entry.endpoint,
        disabled: entry.status === 'offline',
      })),
    [keyCapableServers],
  );

  const userOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (users.data?.items ?? [])
        .filter((entry) => entry.serverId === serverId)
        .map((entry) => ({
          value: entry.name,
          label: entry.name,
          description: entry.policies.join(', '),
          disabled: entry.status === 'disabled',
        })),
    [serverId, users.data],
  );

  const expiryOptions = useMemo<readonly SegmentedOption<ExpiryPreset>[]>(
    () =>
      EXPIRY_PRESETS.map((value) => ({
        value,
        label: t(`keys.create.expiry.${value}`),
        disabled: !expirySupported && value !== 'never',
      })),
    [expirySupported, t],
  );

  const policyValid = useMemo(() => {
    if (!restricted) return true;
    try {
      const parsed: unknown = JSON.parse(policyText);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, [policyText, restricted]);

  const canSubmit =
    serverId !== null && userName !== null && name.trim().length > 0 && policyValid;

  const submit = () => {
    if (serverId === null || userName === null) return;
    const effectiveExpiry: ExpiryPreset = expirySupported ? expiry : 'never';
    const expiresAt =
      effectiveExpiry === 'never' ? null : isoInDays(PRESET_DAYS[effectiveExpiry]);

    createKey.mutate(
      {
        serverId,
        userName,
        name: name.trim(),
        expiresAt,
        policy: restricted ? (JSON.parse(policyText) as Record<string, unknown>) : null,
      },
      {
        onSuccess: (result) => setCreated(result),
        onError: (error) => apiError.toastError(error, t('keys.create.failed')),
      },
    );
  };

  if (created !== null) {
    return (
      <SecretRevealDialog
        created={created}
        serverName={server?.name ?? ''}
        onDone={() => {
          toast.success(t('keys.create.done'), { description: created.accessKey.name ?? '' });
          onClose();
        }}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('keys.create.title')}</DialogTitle>
          <DialogDescription>{t('keys.create.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('keys.create.server')}>
              {({ id }) => (
                <Combobox
                  id={id}
                  options={serverOptions}
                  value={serverId}
                  onValueChange={(next) => {
                    setServerId(next);
                    setUserName(null);
                  }}
                  placeholder={t('keys.create.pickServer')}
                  aria-label={t('keys.create.server')}
                />
              )}
            </FormField>
            <FormField
              label={t('keys.create.user')}
              hint={userOptions.length === 0 && serverId !== null ? t('keys.create.noUsers') : undefined}
            >
              {({ id }) => (
                <Combobox
                  id={id}
                  options={userOptions}
                  value={userName}
                  onValueChange={setUserName}
                  placeholder={t('keys.create.pickUser')}
                  disabled={serverId === null}
                  aria-label={t('keys.create.user')}
                />
              )}
            </FormField>
          </div>

          <FormField label={t('keys.create.name')} hint={t('keys.create.nameHint')}>
            {({ id }) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('keys.create.namePlaceholder')}
              />
            )}
          </FormField>

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('keys.create.expires')}</span>
            <SegmentedControl
              options={expiryOptions}
              value={expirySupported ? expiry : 'never'}
              onValueChange={setExpiry}
              className="w-full [&>*]:flex-1"
              aria-label={t('keys.create.expires')}
            />
            {serverId !== null && !expirySupported ? (
              <Alert variant="info">
                <AlertDescription>
                  {t('keys.create.noExpirySupport', { server: server?.name ?? '' })}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          <SectionCard flush>
            <OptionRow label={t('keys.create.restrict')} hint={t('keys.create.restrictHint')}>
              <Switch
                checked={restricted}
                onCheckedChange={setRestricted}
                aria-label={t('keys.create.restrict')}
              />
            </OptionRow>
          </SectionCard>

          {restricted ? (
            <FormField
              label={t('keys.create.sessionPolicy')}
              hint={t('keys.create.sessionPolicyHint')}
              error={policyValid ? undefined : t('keys.create.invalidJson')}
            >
              {() => (
                <CodeEditor
                  value={policyText}
                  onValueChange={setPolicyText}
                  language="json"
                  height="14rem"
                  ariaLabel={t('keys.create.sessionPolicy')}
                />
              )}
            </FormField>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit || createKey.isPending}>
            {createKey.isPending ? <Spinner /> : <KeyRoundIcon />}
            {t('keys.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `/keys/new` — the create dialog over the access keys list. */
export function CreateAccessKeyRoute() {
  const navigate = useNavigate();
  const state = useRouteState();
  const close = useCallback(() => {
    void navigate({ to: '/keys', search: true });
  }, [navigate]);
  return (
    <CreateAccessKeyDialog
      initialServerId={state.serverId ?? null}
      initialUserName={state.userName ?? null}
      onClose={close}
    />
  );
}
