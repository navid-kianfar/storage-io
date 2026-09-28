import type { CreatedKey } from '@storage-io/contracts';
import { EyeIcon, EyeOffIcon, LockIcon, RefreshCwIcon, UserPlusIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Checkbox,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  OptionRow,
  ScrollArea,
  SectionCard,
  Skeleton,
  Spinner,
  Switch,
  type ComboboxOption,
} from '@/components/app';
import { useCreateIamUser, useIamGroups, useIamPolicies } from '@/features/iam/api';
import { SecretRevealDialog } from '@/features/iam/components/SecretRevealDialog';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { useNavigate } from '@tanstack/react-router';
import { useRouteState } from '@/lib/dialogs/route';

/**
 * Create an S3 user on one server — the `/users/new` route. The server may be
 * pre-selected through router history state
 * prefilled from the server detail page or the users filter.
 *
 * A secret is only offered where the driver needs one — MinIO's admin API takes the
 * user's secret at creation, the AWS-style drivers do not (`CreateS3UserRequest.secret`
 * is nullable for exactly that reason). Generating it here rather than asking the
 * operator to invent one is deliberate: an operator-chosen S3 secret is usually a
 * weak one, and this is the only moment it can be set.
 *
 * Policies and groups are offered from the chosen server only, because both are
 * per-server objects — a policy name on one server means nothing on another.
 */

const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_LENGTH = 40;
const USER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Providers whose IAM driver takes the user's secret when the user is created. */
const SECRET_AT_CREATION: readonly string[] = ['minio'];

function generateSecret(): string {
  const bytes = new Uint8Array(SECRET_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += SECRET_ALPHABET[byte % SECRET_ALPHABET.length];
  return out;
}

export interface CreateS3UserDialogProps {
  /** Pre-selected server, from router history state; never from the URL. */
  readonly initialServerId: string | null;
  readonly onClose: () => void;
}

export function CreateS3UserDialog({ initialServerId, onClose }: CreateS3UserDialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const servers = useServers();
  const createUser = useCreateIamUser();

  const [serverId, setServerId] = useState<string | null>(initialServerId);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState(() => generateSecret());
  const [secretVisible, setSecretVisible] = useState(false);
  const [selectedPolicies, setSelectedPolicies] = useState<readonly string[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<readonly string[]>([]);
  const [createKey, setCreateKey] = useState(true);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const iamServers = useMemo(
    () => (servers.data?.items ?? []).filter((entry) => entry.capabilities.iamUsers === 'supported'),
    [servers.data],
  );
  const server = iamServers.find((entry) => entry.id === serverId) ?? null;
  const needsSecret = server !== null && SECRET_AT_CREATION.includes(server.provider);

  const policies = useIamPolicies(serverId === null ? {} : { serverId });
  const groups = useIamGroups(serverId === null ? {} : { serverId });

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      iamServers.map((entry) => ({
        value: entry.id,
        label: entry.name,
        description:
          entry.status === 'offline' ? t('users.create.serverOffline') : entry.endpoint,
        disabled: entry.status === 'offline',
      })),
    [iamServers, t],
  );

  const nameValid = USER_NAME_PATTERN.test(name);
  const canSubmit = serverId !== null && nameValid;

  const toggle = (
    list: readonly string[],
    setList: (next: readonly string[]) => void,
    value: string,
    on: boolean,
  ) => {
    setList(on ? [...list, value] : list.filter((entry) => entry !== value));
  };

  const submit = () => {
    if (serverId === null) return;
    createUser.mutate(
      {
        serverId,
        name,
        secret: needsSecret ? secret : null,
        policies: [...selectedPolicies],
        groups: [...selectedGroups],
        createAccessKey: createKey,
      },
      {
        onSuccess: (result) => {
          toast.success(t('users.toast.created'), { description: `${name} · ${server?.name ?? ''}` });
          if (result.accessKey === null) {
            onClose();
            return;
          }
          setCreated(result.accessKey);
        },
        onError: (error) => apiError.toastError(error, t('users.create.failed')),
      },
    );
  };

  if (created !== null) {
    return (
      <SecretRevealDialog
        created={created}
        serverName={server?.name ?? ''}
        onDone={onClose}
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
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('users.create.title')}</DialogTitle>
          <DialogDescription>{t('users.create.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <FormField label={t('users.create.server')}>
            {({ id }) => (
              <Combobox
                id={id}
                options={serverOptions}
                value={serverId}
                onValueChange={(next) => {
                  setServerId(next);
                  setSelectedPolicies([]);
                  setSelectedGroups([]);
                }}
                placeholder={t('keys.create.pickServer')}
                aria-label={t('users.create.server')}
              />
            )}
          </FormField>

          <FormField
            label={t('users.create.username')}
            hint={t('users.create.usernameHint')}
            error={name.length > 0 && !nameValid ? t('users.create.usernameInvalid') : undefined}
          >
            {({ id, invalid }) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="font-mono"
                dir="ltr"
                autoComplete="off"
                aria-invalid={invalid}
                placeholder="svc-reports"
              />
            )}
          </FormField>

          {needsSecret ? (
            <FormField label={t('users.create.secret')} hint={t('users.create.secretHint')}>
              {({ id }) => (
                <div className="flex items-center gap-2">
                  <InputGroup className="min-w-0 flex-1">
                    <InputGroupInput
                      id={id}
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      type={secretVisible ? 'text' : 'password'}
                      className="font-mono"
                      dir="ltr"
                      autoComplete="off"
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        onClick={() => setSecretVisible((visible) => !visible)}
                        aria-label={
                          secretVisible ? tCommon('form.hideSecret') : tCommon('form.showSecret')
                        }
                      >
                        {secretVisible ? <EyeOffIcon /> : <EyeIcon />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setSecret(generateSecret());
                      toast.success(t('users.create.secretGenerated'));
                    }}
                  >
                    <RefreshCwIcon />
                    {t('users.create.generate')}
                  </Button>
                </div>
              )}
            </FormField>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('users.create.policies')}</span>
            <SectionCard flush>
              {policies.isLoading ? (
                <div className="flex flex-col gap-2 p-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (policies.data?.items ?? []).length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  {t('users.create.noPolicies')}
                </p>
              ) : (
                <ScrollArea className="max-h-48">
                  {(policies.data?.items ?? []).map((policy) => (
                    <label
                      key={policy.name}
                      className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                    >
                      <Checkbox
                        checked={selectedPolicies.includes(policy.name)}
                        onCheckedChange={(checked) =>
                          toggle(selectedPolicies, setSelectedPolicies, policy.name, checked === true)
                        }
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-[0.8125rem] font-medium">
                          {policy.name}
                        </span>
                        {policy.description === null ? null : (
                          <span className="truncate text-xs text-muted-foreground">
                            {policy.description}
                          </span>
                        )}
                      </span>
                      {policy.builtIn ? (
                        <Badge variant="secondary">
                          <LockIcon />
                          {t('users.sheet.builtIn')}
                        </Badge>
                      ) : (
                        <Badge variant="outline">{t('users.sheet.custom')}</Badge>
                      )}
                    </label>
                  ))}
                </ScrollArea>
              )}
            </SectionCard>
            <span className="text-xs text-muted-foreground">{t('users.create.policiesHint')}</span>
          </div>

          {(groups.data?.items ?? []).length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.8125rem] font-medium">{t('users.create.groups')}</span>
              <div className="flex flex-wrap gap-3">
                {(groups.data?.items ?? []).map((group) => (
                  <label key={group.name} className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedGroups.includes(group.name)}
                      onCheckedChange={(checked) =>
                        toggle(selectedGroups, setSelectedGroups, group.name, checked === true)
                      }
                    />
                    <span className="font-mono text-[0.8125rem]">{group.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <SectionCard flush>
            <OptionRow label={t('users.create.createKey')} hint={t('users.create.createKeyHint')}>
              <Switch
                checked={createKey}
                onCheckedChange={setCreateKey}
                aria-label={t('users.create.createKey')}
              />
            </OptionRow>
          </SectionCard>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit || createUser.isPending}>
            {createUser.isPending ? <Spinner /> : <UserPlusIcon />}
            {t('users.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `/users/new` — the create dialog over the S3 users list. */
export function CreateS3UserRoute() {
  const navigate = useNavigate();
  const state = useRouteState();
  const close = useCallback(() => {
    void navigate({ to: '/users', search: true });
  }, [navigate]);
  return <CreateS3UserDialog initialServerId={state.serverId ?? null} onClose={close} />;
}
