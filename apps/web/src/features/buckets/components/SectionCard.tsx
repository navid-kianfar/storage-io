import {
  PROVIDER_LABELS,
  type Capability,
  type CapabilityState,
  type Server,
} from '@storage-io/contracts';
import { BanIcon, CloudOffIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/app/Card';
import { EmptyState } from '@/components/app/EmptyState';
import { Skeleton } from '@/components/app/Skeleton';
import { cn } from '@/lib/utils';

/**
 * One section of the bucket settings page.
 *
 * Its job beyond layout is to answer "can this server even do this?" in one
 * place. A provider without a lifecycle API is not an error and not an empty
 * list: it is a section that says so and offers no controls, which is what
 * `capabilities` in the contract is for. The same applies to an offline server,
 * where the answer is "not right now" rather than "never".
 */

export type SectionAvailability = 'ready' | 'not_supported' | 'offline' | 'loading';

export function sectionAvailability(
  server: Server | undefined,
  capability: Capability,
  loading: boolean,
): SectionAvailability {
  if (server === undefined) return loading ? 'loading' : 'ready';
  if (server.status === 'offline') return 'offline';
  const state: CapabilityState = server.capabilities[capability];
  if (state === 'not_supported') return 'not_supported';
  return loading ? 'loading' : 'ready';
}

export function SectionCard({
  id,
  title,
  description,
  action,
  availability,
  provider,
  children,
  footer,
  className,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly availability: SectionAvailability;
  readonly provider?: Server['provider'];
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}) {
  const { t } = useTranslation('pages');

  return (
    <Card
      id={id}
      // The offset keeps an anchored section clear of the sticky topbar when the
      // sub-nav scrolls to it.
      className={cn('scroll-mt-24', className)}
    >
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action !== undefined && availability === 'ready' ? (
          <CardAction>{action}</CardAction>
        ) : null}
      </CardHeader>

      {availability === 'not_supported' ? (
        <EmptyState
          icon={BanIcon}
          title={t('bucket.notSupported.title', {
            provider: provider === undefined ? '' : PROVIDER_LABELS[provider],
          })}
          description={t('bucket.notSupported.description')}
        />
      ) : availability === 'offline' ? (
        <EmptyState
          icon={CloudOffIcon}
          title={t('bucket.offline.title')}
          description={t('bucket.offline.description')}
        />
      ) : availability === 'loading' ? (
        <div className="flex flex-col gap-3 px-(--card-pad) pb-(--card-pad)">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <>
          {children}
          {footer}
        </>
      )}
    </Card>
  );
}
