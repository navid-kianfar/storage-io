import { SETTINGS_DEFAULTS, cidrSchema, type Settings } from '@storage-io/contracts';
import { useNavigate } from '@tanstack/react-router';
import {
  InfoIcon,
  LaptopIcon,
  MonitorIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  Dash,
  FormActions,
  FormRow,
  Input,
  RelativeTime,
  SectionCard,
  Skeleton,
  Spinner,
  type ComboboxOption,
} from '@/components/app';
import {
  useApiTokens,
  useAuthSessions,
  useRevokeApiToken,
  useRevokeOtherSessions,
  useRevokeSession,
  useUpdateSettings,
} from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Sessions, CLI tokens and the two settings that decide who can reach the console.
 *
 * There is no password form. The administrator's credentials come from the
 * environment (`ADMIN_USERNAME` / `ADMIN_PASSWORD`), so there is no endpoint to
 * change them and offering a field that silently did nothing would be worse than
 * saying so — which is what the first card does.
 */

const SESSION_TTL_CHOICES = [1, 8, 24, 24 * 7, 24 * 30] as const;

function deviceIcon(userAgent: string | null) {
  if (userAgent === null) return TerminalIcon;
  const lowered = userAgent.toLowerCase();
  if (lowered.includes('mac') || lowered.includes('iphone')) return LaptopIcon;
  if (lowered.includes('curl') || lowered.includes('sio_')) return TerminalIcon;
  return MonitorIcon;
}

export function SecuritySection({
  settings,
  loading,
}: {
  readonly settings: Settings | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const navigate = useNavigate();

  const sessions = useAuthSessions();
  const tokens = useApiTokens();
  const revokeSession = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const revokeToken = useRevokeApiToken();
  const save = useUpdateSettings();

  const saved = settings?.security ?? SETTINGS_DEFAULTS.security;
  const [ttlHours, setTtlHours] = useState<number | null>(null);
  const [networks, setNetworks] = useState<readonly string[] | null>(null);
  const [draftNetwork, setDraftNetwork] = useState('');
  const [confirmSignOutOthers, setConfirmSignOutOthers] = useState(false);
  const [tokenToRevoke, setTokenToRevoke] = useState<string | null>(null);

  const effectiveTtl = ttlHours ?? saved.sessionTtlHours;
  const effectiveNetworks = networks ?? saved.allowedNetworks;
  const dirty =
    effectiveTtl !== saved.sessionTtlHours ||
    JSON.stringify(effectiveNetworks) !== JSON.stringify(saved.allowedNetworks);

  // The stored value is always offered, even when it is not one of the presets:
  // the API accepts 1..8760 hours and a deployment may have been configured with
  // something else. Without this the control would read "Select an option" over a
  // perfectly valid setting, and saving would silently change it.
  const ttlOptions = useMemo<readonly ComboboxOption<string>[]>(() => {
    const presets: readonly number[] = SESSION_TTL_CHOICES;
    const hours = presets.includes(effectiveTtl)
      ? [...presets]
      : [...presets, effectiveTtl].sort((left, right) => left - right);
    return hours.map((value) => ({
      value: String(value),
      label: t('settings.security.ttlOption', { count: value }),
    }));
  }, [effectiveTtl, t]);

  const draftValid = cidrSchema.safeParse(draftNetwork.trim()).success;

  const addNetwork = () => {
    const value = draftNetwork.trim();
    if (!draftValid || effectiveNetworks.includes(value)) return;
    setNetworks([...effectiveNetworks, value]);
    setDraftNetwork('');
  };

  const submit = () => {
    save.mutate(
      { security: { sessionTtlHours: effectiveTtl, allowedNetworks: [...effectiveNetworks] } },
      {
        onSuccess: () => {
          toast.success(t('settings.security.saved'));
          setTtlHours(null);
          setNetworks(null);
        },
        onError: (error) => apiError.toastError(error, t('settings.security.failed')),
      },
    );
  };

  return (
    <>
      <SectionCard
        flush
        title={t('settings.security.title')}
        description={t('settings.security.description')}
        footer={
          <FormActions>
            <Button onClick={submit} disabled={!dirty || save.isPending || loading}>
              {save.isPending ? <Spinner /> : null}
              {t('settings.saveChanges')}
            </Button>
          </FormActions>
        }
      >
        <FormRow
          label={t('settings.security.credentials')}
          hint={t('settings.security.credentialsHint')}
        >
          <Alert variant="info">
            <InfoIcon />
            <AlertTitle>{t('settings.security.managedByEnv')}</AlertTitle>
            <AlertDescription>{t('settings.security.managedByEnvBody')}</AlertDescription>
          </Alert>
        </FormRow>

        <FormRow
          label={t('settings.security.sessions')}
          hint={t('settings.security.sessionsHint')}
        >
          <div className="flex flex-col">
            {sessions.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : sessions.isError ? (
              <p className="text-sm text-destructive">{apiError.message(sessions.error)}</p>
            ) : (
              (sessions.data?.items ?? []).map((session) => {
                const Icon = deviceIcon(session.userAgent);
                return (
                  <div
                    key={session.id}
                    className="flex items-center gap-3 border-t py-3 first:border-t-0"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] font-medium">
                        <span className="truncate">
                          {session.userAgent ?? t('settings.security.unknownDevice')}
                        </span>
                        {session.current ? (
                          <Badge variant="success">{t('settings.security.thisDevice')}</Badge>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <span className="font-mono" dir="ltr">
                          {session.ip ?? '—'}
                        </span>{' '}
                        ·{' '}
                        {session.lastSeenAt === null ? (
                          <Dash />
                        ) : (
                          <RelativeTime value={session.lastSeenAt} />
                        )}
                      </span>
                    </div>
                    {session.current ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revokeSession.isPending}
                        onClick={() =>
                          revokeSession.mutate(session.id, {
                            onSuccess: () => toast.success(t('settings.security.sessionRevoked')),
                            onError: (error) =>
                              apiError.toastError(error, t('settings.security.revokeFailed')),
                          })
                        }
                      >
                        {t('settings.security.revoke')}
                      </Button>
                    )}
                  </div>
                );
              })
            )}

            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmSignOutOthers(true)}
                disabled={(sessions.data?.items ?? []).length < 2}
              >
                {t('settings.security.signOutOthers')}
              </Button>
            </div>
          </div>
        </FormRow>

        <FormRow label={t('settings.security.tokens')} hint={t('settings.security.tokensHint')}>
          <div className="flex flex-col">
            {tokens.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : (tokens.data?.items ?? []).length === 0 ? (
              <p className="py-2 text-[0.8125rem] text-muted-foreground">
                {t('settings.security.noTokens')}
              </p>
            ) : (
              (tokens.data?.items ?? []).map((token) => (
                <div key={token.id} className="flex items-center gap-3 border-t py-3 first:border-t-0">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <TerminalIcon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[0.8125rem] font-medium">{token.name}</span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono" dir="ltr">
                        {token.prefix}…
                      </span>{' '}
                      ·{' '}
                      {token.lastUsedAt === null ? (
                        t('settings.security.neverUsed')
                      ) : (
                        <>
                          {t('settings.security.lastUsed')}{' '}
                          <RelativeTime value={token.lastUsedAt} />
                        </>
                      )}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setTokenToRevoke(token.id)}>
                    {t('settings.security.revoke')}
                  </Button>
                </div>
              ))
            )}
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: '/settings/$section/new-token',
                    params: { section: 'security' },
                  })
                }
              >
                <PlusIcon />
                {t('settings.security.newToken')}
              </Button>
            </div>
          </div>
        </FormRow>

        <FormRow
          label={t('settings.security.sessionTimeout')}
          hint={t('settings.security.sessionTimeoutHint')}
        >
          <Combobox
            options={ttlOptions}
            value={String(effectiveTtl)}
            onValueChange={(value) => {
              if (value === null) return;
              setTtlHours(Number.parseInt(value, 10));
            }}
            className="sm:w-64"
            aria-label={t('settings.security.sessionTimeout')}
          />
        </FormRow>

        <FormRow
          label={t('settings.security.allowedNetworks')}
          hint={t('settings.security.allowedNetworksHint')}
        >
          <div className="flex flex-col gap-2">
            {effectiveNetworks.length === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                {t('settings.security.anywhere')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {effectiveNetworks.map((network) => (
                  <Badge key={network} variant="secondary" className="gap-1 font-mono">
                    <span dir="ltr">{network}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setNetworks(effectiveNetworks.filter((entry) => entry !== network))
                      }
                      aria-label={t('settings.security.removeNetwork', { network })}
                      className="rounded-full hover:text-destructive"
                    >
                      <XIcon className="size-3" aria-hidden="true" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={draftNetwork}
                onChange={(event) => setDraftNetwork(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  addNetwork();
                }}
                placeholder="10.0.0.0/8"
                className="font-mono sm:w-64"
                dir="ltr"
                aria-label={t('settings.security.allowedNetworks')}
                aria-invalid={draftNetwork.length > 0 && !draftValid}
              />
              <Button type="button" variant="outline" onClick={addNetwork} disabled={!draftValid}>
                <PlusIcon />
                {tCommon('action.add')}
              </Button>
            </div>
            {draftNetwork.length > 0 && !draftValid ? (
              <p className="text-xs text-destructive">{t('settings.security.invalidCidr')}</p>
            ) : null}
          </div>
        </FormRow>
      </SectionCard>

      <ConfirmDialog
        open={confirmSignOutOthers}
        onOpenChange={setConfirmSignOutOthers}
        title={t('settings.security.signOutOthersTitle')}
        description={t('settings.security.signOutOthersDescription')}
        confirmLabel={t('settings.security.signOutOthers')}
        destructive
        busy={revokeOthers.isPending}
        onConfirm={() =>
          revokeOthers.mutate(undefined, {
            onSuccess: () => {
              toast.success(t('settings.security.signedOutOthers'));
              setConfirmSignOutOthers(false);
            },
            onError: (error) => apiError.toastError(error, t('settings.security.revokeFailed')),
          })
        }
      />

      <ConfirmDialog
        open={tokenToRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setTokenToRevoke(null);
        }}
        title={t('settings.security.revokeTokenTitle')}
        description={t('settings.security.revokeTokenDescription')}
        confirmLabel={t('settings.security.revoke')}
        destructive
        busy={revokeToken.isPending}
        onConfirm={() => {
          if (tokenToRevoke === null) return;
          revokeToken.mutate(tokenToRevoke, {
            onSuccess: () => {
              toast.success(t('settings.security.tokenRevoked'));
              setTokenToRevoke(null);
            },
            onError: (error) => apiError.toastError(error, t('settings.security.revokeFailed')),
          });
        }}
      />
    </>
  );
}
