import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app';
import { useMe } from '@/features/auth/api';
import { SettingsNav } from '@/features/settings/SettingsNav';
import { useUpdateSettings } from '@/features/settings/api';
import { AboutSection } from '@/features/settings/sections/AboutSection';
import { AccountSection } from '@/features/settings/sections/AccountSection';
import { ActivityForwardingSection } from '@/features/settings/sections/ActivityForwardingSection';
import { AppearanceSection } from '@/features/settings/sections/AppearanceSection';
import { BackupSection } from '@/features/settings/sections/BackupSection';
import { NotificationsSection } from '@/features/settings/sections/NotificationsSection';
import { RegionSection } from '@/features/settings/sections/RegionSection';
import { SecuritySection } from '@/features/settings/sections/SecuritySection';
import { useSettings } from '@/features/shell/api';
import { TransferSettingsCard } from '@/features/transfers/TransfersPage';
import { useApiError } from '@/lib/api/useApiError';

/** Registers `?dialog=create-api-token`; the palette opens it by URL. */
import '@/features/settings/dialogs/CreateApiTokenDialog';

/**
 * One long page with a sticky section nav, as the concept draws it — not a set of
 * tabs. Settings is read far more often than it is changed, and a page that can be
 * scrolled and searched with the browser's own find is worth more here than one
 * that hides eight of nine sections behind a click.
 *
 * Each section owns its own save. `PATCH /settings` takes one section at a time, so
 * a single page-wide Save button would either send everything (overwriting what
 * another administrator changed a minute ago) or pretend to be atomic when it is
 * not. Appearance has no save at all: it is this browser's, and it applies as it is
 * clicked.
 *
 * Transfers is the transfers page's own card, imported rather than re-implemented:
 * both edit `Settings.transfers`, and two forms over one section is how the two
 * drift apart.
 */
export function SettingsPage() {
  const { t } = useTranslation('pages');
  const apiError = useApiError();

  const me = useMe();
  const settings = useSettings();
  const saveSettings = useUpdateSettings();

  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />

      <div className="grid gap-(--gap-lg) lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <SettingsNav />

        <div className="flex min-w-0 flex-col gap-(--gap-lg)">
          <section id="account" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <AccountSection me={me.data} loading={me.isLoading} />
          </section>

          <section id="security" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <SecuritySection settings={settings.data} loading={settings.isLoading} />
          </section>

          <section id="appearance" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <AppearanceSection />
          </section>

          <section id="region" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <RegionSection settings={settings.data} loading={settings.isLoading} />
          </section>

          <section id="transfers" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <TransferSettingsCard
              settings={settings.data}
              loading={settings.isLoading}
              saving={saveSettings.isPending}
              onSave={(patch, onDone) =>
                saveSettings.mutate(
                  { transfers: patch },
                  {
                    onSuccess: () => {
                      toast.success(t('transfers.settings.saved'));
                      onDone();
                    },
                    onError: (error) => apiError.toastError(error, t('transfers.settings.failed')),
                  },
                )
              }
            />
          </section>

          <section id="notifications" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <NotificationsSection settings={settings.data} loading={settings.isLoading} />
          </section>

          <section id="activity-forwarding" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <ActivityForwardingSection settings={settings.data} loading={settings.isLoading} />
          </section>

          <section id="backup-retention" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <BackupSection settings={settings.data} loading={settings.isLoading} />
          </section>

          <section id="about" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
            <AboutSection />
          </section>
        </div>
      </div>
    </>
  );
}
