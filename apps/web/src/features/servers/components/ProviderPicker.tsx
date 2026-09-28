import { PROVIDERS, type Provider } from '@storage-io/contracts';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChoiceCards, ProviderMark, type ChoiceOption } from '@/components/app';

/**
 * The concept's provider grid (`provider-grid`), shared by the first-run wizard
 * and the Add-server dialog. It is a radio group, so it arrives with roving
 * focus and arrow-key navigation from Radix.
 *
 * The description under each name is what that provider's driver can actually do
 * — it is the first thing an operator needs in order to choose, and it comes from
 * the same capability story the Capabilities tab tells later.
 */
export function ProviderPicker({
  value,
  onValueChange,
}: {
  readonly value: Provider;
  readonly onValueChange: (value: Provider) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tDomain } = useTranslation('domain');

  const options = useMemo<readonly ChoiceOption<Provider>[]>(
    () =>
      PROVIDERS.map((provider) => ({
        value: provider,
        label: tDomain(`provider.${provider}`),
        description: t(`servers.providerHint.${provider}`),
        media: <ProviderMark provider={provider} size="lg" />,
      })),
    [t, tDomain],
  );

  return (
    <ChoiceCards
      options={options}
      value={value}
      onValueChange={onValueChange}
      columns={4}
      aria-label={t('servers.wizard.providerStep')}
    />
  );
}
