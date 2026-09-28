import type { UnavailableServer } from '@storage-io/contracts';
import { ServerOffIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/app';

/**
 * The servers an aggregated IAM list could not reach.
 *
 * Every access page renders this. Without it a table that is missing half its rows
 * looks exactly like a table with half as many rows, and an operator concludes the
 * user they are looking for has been deleted.
 */
export function UnavailableServersAlert({
  unavailable,
}: {
  readonly unavailable: readonly UnavailableServer[];
}) {
  const { t } = useTranslation('pages');
  if (unavailable.length === 0) return null;

  return (
    <Alert variant="warning" className="mb-(--gap)">
      <ServerOffIcon />
      <AlertTitle>{t('iam.unavailable.title', { count: unavailable.length })}</AlertTitle>
      <AlertDescription className="block text-xs">
        {unavailable.map((entry) => (
          <span key={entry.serverId} className="me-3">
            {entry.message}
          </span>
        ))}
      </AlertDescription>
    </Alert>
  );
}
