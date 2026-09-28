import type { Me } from '@storage-io/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  FormActions,
  FormRow,
  InitialsAvatar,
  Input,
  SectionCard,
  Skeleton,
  Spinner,
} from '@/components/app';
import { useUpdateProfile } from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * The one administrator's profile. The username comes from the environment and
 * cannot be changed here — it is shown, not edited, because changing it means
 * changing `ADMIN_USERNAME` and restarting the service.
 */
export function AccountSection({ me, loading }: { readonly me: Me | undefined; readonly loading: boolean }) {
  const { t } = useTranslation('pages');

  if (loading || me === undefined) {
    return (
      <SectionCard title={t('settings.account.title')} description={t('settings.account.description')}>
        <Skeleton className="h-24 w-full" />
      </SectionCard>
    );
  }

  return <AccountForm key={`${me.displayName}/${me.email ?? ''}`} me={me} />;
}

function AccountForm({ me }: { readonly me: Me }) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const save = useUpdateProfile();

  const [displayName, setDisplayName] = useState(me.displayName);
  const [email, setEmail] = useState(me.email ?? '');

  const dirty = displayName !== me.displayName || email !== (me.email ?? '');
  const nameValid = displayName.trim().length > 0;
  const emailValid = email.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const submit = () => {
    save.mutate(
      {
        displayName: displayName.trim(),
        email: email.trim().length === 0 ? null : email.trim(),
      },
      {
        onSuccess: () => toast.success(t('settings.account.saved')),
        onError: (error) => {
          const handled = apiError.applyFieldErrors(error, () => undefined, []);
          if (!handled) apiError.toastError(error, t('settings.account.failed'));
        },
      },
    );
  };

  return (
    <SectionCard
      flush
      title={t('settings.account.title')}
      description={t('settings.account.description')}
      footer={
        <FormActions>
          <Button
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDisplayName(me.displayName);
              setEmail(me.email ?? '');
            }}
          >
            {tCommon('action.cancel')}
          </Button>
          <Button onClick={submit} disabled={!dirty || !nameValid || !emailValid || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {t('settings.saveChanges')}
          </Button>
        </FormActions>
      }
    >
      <FormRow label={t('settings.account.profile')} hint={t('settings.account.profileHint')}>
        <div className="flex items-center gap-3">
          <InitialsAvatar name={me.displayName} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-label={t('settings.account.profile')}
              aria-invalid={!nameValid}
            />
            <span className="text-xs text-muted-foreground">
              {t('settings.account.username')}: <span className="font-mono">{me.username}</span>
            </span>
          </div>
        </div>
      </FormRow>

      <FormRow label={t('settings.account.email')} hint={t('settings.account.emailHint')}>
        <Input
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          inputMode="email"
          dir="ltr"
          aria-label={t('settings.account.email')}
          aria-invalid={!emailValid}
          placeholder="admin@storage.local"
        />
      </FormRow>
    </SectionCard>
  );
}
