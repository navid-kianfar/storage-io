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
import { Skeleton } from '@/components/app/Skeleton';
import { useEntityName, type EntityKind } from '@/lib/entities/resolve';

/**
 * Breadcrumbs, derived from the matched routes rather than declared per page.
 *
 * Each route carries `staticData`: either `crumb`, an i18n key in the `pages`
 * namespace, or `crumbEntity`, which names an id route param and the kind of
 * entity it is. The URL carries opaque ids (docs/ROUTES.md rule 1) and a
 * breadcrumb showing a UUID is useless, so `crumbEntity` resolves the id to the
 * entity's *name* through the shared resolver — one cache entry per id, seeded by
 * whichever list the operator came from, so arriving from a list costs nothing.
 *
 * While the name is still unknown the crumb is a skeleton, never the raw id: a
 * UUID flashing into a name is worse than a placeholder that becomes one.
 */

export interface RouteCrumbData {
  /** Key in the `pages` namespace, e.g. `servers.title`. */
  readonly crumb?: string;
  /** An id param to resolve to the entity's display name. */
  readonly crumbEntity?: { readonly kind: EntityKind; readonly param: string };
  /** Renders in a monospace font — a server, bucket or object name. */
  readonly crumbMono?: boolean;
  /** The object browser's mode; see `ObjectBrowserPage`. */
  readonly browserMode?: 'browse' | 'object' | 'upload' | 'import';
  /** Which overlay this route opens over its parent page; see `useRouteOverlay`. */
  readonly overlay?: string;
}

interface Crumb {
  readonly key: string;
  readonly label: string | null;
  readonly entity: { readonly kind: EntityKind; readonly id: string } | null;
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

    if (data.crumbEntity !== undefined) {
      const id = params[data.crumbEntity.param];
      if (id === undefined) continue;
      crumbs.push({
        key: match.id,
        label: null,
        entity: { kind: data.crumbEntity.kind, id },
        to: match.pathname,
        mono: data.crumbMono ?? true,
      });
      continue;
    }
    if (data.crumb !== undefined) {
      crumbs.push({
        key: match.id,
        label: t(data.crumb),
        entity: null,
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
          return (
            <BreadcrumbItem
              key={crumb.key}
              // Only the last crumb survives on a phone, as in the concept.
              className={last ? 'min-w-0 overflow-hidden' : 'hidden sm:flex'}
            >
              {last ? (
                <BreadcrumbPage className="truncate font-medium">
                  <CrumbLabel crumb={crumb} />
                </BreadcrumbPage>
              ) : (
                <>
                  <BreadcrumbLink asChild>
                    <Link to={crumb.to}>
                      <CrumbLabel crumb={crumb} />
                    </Link>
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

/**
 * One crumb's text. It is its own component because resolving an entity name is a
 * hook, and a list of crumbs cannot call one per iteration.
 */
function CrumbLabel({ crumb }: { readonly crumb: Crumb }) {
  const resolved = useEntityName(crumb.entity?.kind ?? 'bucket', crumb.entity?.id);
  const text = crumb.entity === null ? crumb.label : resolved;

  if (text === null) return <Skeleton className="inline-block h-4 w-24 align-middle" />;
  if (!crumb.mono) return <>{text}</>;
  return <span className="ltr-isolate font-mono">{text}</span>;
}
