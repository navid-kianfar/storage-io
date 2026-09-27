import { Link } from '@tanstack/react-router';
import { FileQuestionIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/app/EmptyState';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  const { t } = useTranslation('pages');
  return (
    <EmptyState
      icon={FileQuestionIcon}
      title={t('notFound.title')}
      description={t('notFound.description')}
      action={
        <Button asChild>
          <Link to="/">{t('notFound.backToOverview')}</Link>
        </Button>
      }
    />
  );
}
