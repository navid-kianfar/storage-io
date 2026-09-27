import { Link, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

/**
 * Breadcrumbs, derived from the matched routes rather than declared per page.
 *
 * Each route carries `staticData.crumb`: either an i18n key in the `pages`
 * namespace, or a function of the route's params for a dynamic segment (a server
 * or bucket name). A route with no `crumb` contributes nothing, which is how
 * `/buckets/$server/$bucket` shows "Buckets › media-prod" and not the server id.
 */

export interface RouteCrumbData {
  /** Key in the `pages` namespace, e.g. `servers.title`. */
  readonly crumb?: string;
  /** For a dynamic segment: the literal text to show. */
  readonly crumbFromParams?: (params: Readonly<Record<string, string>>) => string;
  /** Renders in a monospace font — a server, bucket or object name. */
  readonly crumbMono?: boolean;
}

interface Crumb {
  readonly key: string;
  readonly label: string;
  readonly to: string;
  readonly mono: boolean;
}

export function Breadcrumbs() {
  const { t } = useTranslation('pages');
  const matches = useRouterState({ select: (state) => state.matches });

  const crumbs: Crumb[] = [];
  for (const match of matches) {
    const data = match.staticData as RouteCrumbData | undefined;
    if (data === undefined) continue;
    const params = match.params as Readonly<Record<string, string>>;

    if (data.crumbFromParams !== undefined) {
      crumbs.push({
        key: match.id,
        label: data.crumbFromParams(params),
        to: match.pathname,
        mono: data.crumbMono ?? true,
      });
      continue;
    }
    if (data.crumb !== undefined) {
      crumbs.push({
        key: match.id,
        label: t(data.crumb),
        to: match.pathname,
        mono: data.crumbMono ?? false,
      });
    }
  }

  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb className="min-w-0 flex-[0_1_auto] overflow-hidden">
      <BreadcrumbList className="flex-nowrap text-[0.8125rem] whitespace-nowrap">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          const label = crumb.mono ? (
            <span className="ltr-isolate font-mono">{crumb.label}</span>
          ) : (
            crumb.label
          );
          return (
            <BreadcrumbItem
              key={crumb.key}
              // Only the last crumb survives on a phone, as in the concept.
              className={last ? 'min-w-0 overflow-hidden' : 'hidden sm:flex'}
            >
              {last ? (
                <BreadcrumbPage className="truncate font-medium">{label}</BreadcrumbPage>
              ) : (
                <>
                  <BreadcrumbLink asChild>
                    <Link to={crumb.to}>{label}</Link>
                  </BreadcrumbLink>
                  <BreadcrumbSeparator className="[&>svg]:size-3.5 [&>svg]:opacity-60" />
                </>
              )}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
