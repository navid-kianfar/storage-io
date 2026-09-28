import { Outlet, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app';
import { useMe } from '@/features/auth/api';
import { SettingsNav } from '@/features/settings/SettingsNav';
import { isSettingsSection, type SettingsSectionId } from '@/features/settings/sections';
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

/**
 * Settings, one section per route (`/settings/$section`, docs/ROUTES.md), with a
 * sticky section nav beside it.
 *
 * It was one long scrolling page with anchors; a section is now an address, which
 * is what lets a notification, an alert or a colleague link to *this* setting
 * rather than to the top of a page the reader then has to scan. On a phone the nav
 * becomes a scrolling row of chips above the section, because a two-pane layout at
 * 375 px is one pane and a memory of another.
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

  const { section } = useParams({ from: '/protected/settings/$section' });
  const active: SettingsSectionId = isSettingsSection(section) ? section : 'account';

  const me = useMe();
  const settings = useSettings();
  const saveSettings = useUpdateSettings();

  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />

      <div className="grid gap-(--gap-lg) lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] lg:items-start">
        <SettingsNav active={active} />

        <div className="flex min-w-0 flex-col gap-(--gap-lg)">
          {active === 'account' ? <AccountSection me={me.data} loading={me.isLoading} /> : null}

          {active === 'security' ? (
            <SecuritySection settings={settings.data} loading={settings.isLoading} />
          ) : null}

          {active === 'appearance' ? <AppearanceSection /> : null}

          {active === 'region' ? (
            <RegionSection settings={settings.data} loading={settings.isLoading} />
          ) : null}

          {active === 'transfers' ? (
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
          ) : null}

          {active === 'notifications' ? (
            <NotificationsSection settings={settings.data} loading={settings.isLoading} />
          ) : null}

          {active === 'forwarding' ? (
            <ActivityForwardingSection settings={settings.data} loading={settings.isLoading} />
          ) : null}

          {active === 'backup' ? (
            <BackupSection settings={settings.data} loading={settings.isLoading} />
          ) : null}

          {active === 'about' ? <AboutSection /> : null}
        </div>
      </div>

      {/* `/settings/$section/new-token` renders here. */}
      <Outlet />
    </>
  );
}
