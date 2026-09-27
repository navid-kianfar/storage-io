import { ConstructionIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/app/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

/**
 * A route that exists, with its breadcrumbs, title and shell, waiting for the
 * agent that builds it. It states plainly that it is not built yet rather than
 * pretending — and it lists the kit components the page is expected to use, so
 * whoever picks it up starts from the right building blocks.
 *
 * Every one of these is replaced by a real page; none ships.
 */
export function PlaceholderPage({
  title,
  description,
  components,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  /** Kit component names this page is expected to build from. */
  readonly components?: readonly string[];
  readonly children?: ReactNode;
}) {
  const { t } = useTranslation('pages');

  return (
    <>
      <div className="hero-glow" aria-hidden="true" />
      <PageHeader
        title={title}
        description={description}
        actions={<Badge variant="secondary">{t('placeholder.badge')}</Badge>}
      />
      {children}
      <Card>
        <CardContent className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <ConstructionIcon className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm">{t('placeholder.body')}</p>
            {components === undefined || components.length === 0 ? null : (
              <p className="text-[0.8125rem] text-muted-foreground">
                {t('placeholder.kit', { components: components.join(', ') })}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
