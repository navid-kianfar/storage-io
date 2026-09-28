import { useTranslation } from 'react-i18next';
import { describeCron, weekdayName } from '@/features/jobs/cron';
import { useFormat } from '@/lib/format/FormatProvider';

/**
 * The human line under a cron expression. An expression this cannot describe
 * renders nothing rather than a guess — the raw expression is always shown above
 * it, so the operator still has the truth.
 */
export function CronText({ cron, className }: { readonly cron: string; readonly className?: string }) {
  const { t } = useTranslation('pages');
  const format = useFormat();
  const description = describeCron(cron);

  if (description === null) return null;

  switch (description.kind) {
    case 'everyMinute':
      return <span className={className}>{t('jobs.cron.everyMinute')}</span>;
    case 'everyNMinutes':
      return (
        <span className={className}>
          {t('jobs.cron.everyNMinutes', { count: description.minutes })}
        </span>
      );
    case 'hourly':
      return (
        <span className={className}>
          {t('jobs.cron.hourly', { minute: format.number(description.minute) })}
        </span>
      );
    case 'everyNHours':
      return (
        <span className={className}>
          {t('jobs.cron.everyNHours', { count: description.hours })}
        </span>
      );
    case 'daily':
      return (
        <span className={className}>{t('jobs.cron.daily', { time: description.time })}</span>
      );
    case 'weekdays':
      return (
        <span className={className}>{t('jobs.cron.weekdays', { time: description.time })}</span>
      );
    case 'weekly':
      return (
        <span className={className}>
          {t('jobs.cron.weekly', {
            weekday: weekdayName(description.weekday, format.locale),
            time: description.time,
          })}
        </span>
      );
    case 'monthly':
      return (
        <span className={className}>
          {t('jobs.cron.monthly', { day: format.number(description.day), time: description.time })}
        </span>
      );
    default:
      // `description` is narrowed to never here: a new CronDescription kind is a
      // compile error rather than a silently missing line.
      return exhausted(description);
  }
}

function exhausted(value: never): never {
  throw new Error(`Unhandled cron description: ${JSON.stringify(value)}`);
}
