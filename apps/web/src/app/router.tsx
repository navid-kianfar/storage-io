import type { Me } from '@storage-io/contracts';
import type { QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { z } from 'zod';
import { AppShell } from '@/components/shell/AppShell';
import type { RouteCrumbData } from '@/components/shell/Breadcrumbs';
import { LoginPage } from '@/features/auth/LoginPage';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query/keys';
import { NotFoundPage } from '@/pages/NotFoundPage';

/**
 * Code-based routes (not the file-based generator), as docs/ARCHITECTURE.md
 * settles. Every page in the concept has a route here.
 *
 * Three conventions every page agent relies on:
 *
 * 1. `staticData` carries the breadcrumb: `crumb` is a key in the `pages`
 *    namespace, `crumbFromParams` produces the text for a dynamic segment.
 * 2. The root route's search schema is *loose*, so a page may add its own filter
 *    params without declaring them here. `dialog` and anything starting with `d_`
 *    are reserved for the dialog host (src/lib/dialogs/registry.ts).
 * 3. Each route is written out in full rather than produced by a helper, because
 *    TanStack Router infers `Link`'s `to` types from the literal `path` — a helper
 *    that takes `path: string` collapses every route type to `string` and every
 *    `<Link to="/servers">` in the app stops type-checking.
 *
 * To build a page: replace that route's `component` with the real one, and leave
 * `path` and `staticData` alone.
 */

export interface RouterContext {
  readonly queryClient: QueryClient;
}

/** Reserved by the shell; unknown keys pass through so pages own their filters. */
const rootSearchSchema = z.looseObject({
  dialog: z.string().optional(),
  redirect: z.string().optional(),
  theme: z.string().optional(),
  lang: z.string().optional(),
});

const rootRoute = createRootRouteWithContext<RouterContext>()({
  validateSearch: rootSearchSchema,
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

/**
 * Everything below here needs a session. The check is a `beforeLoad` on the layout
 * route, so a protected page never renders and then vanishes; a later 401 from any
 * request is handled by the API client's unauthorized handler.
 *
 * There are two such layouts: the app shell, and the bare first-run chrome. The
 * guard is one function shared by both, so a route cannot end up protected by one
 * and not the other.
 */
async function requireSession({
  context,
  location,
}: {
  readonly context: RouterContext;
  readonly location: { readonly href: string };
}): Promise<void> {
  try {
    await context.queryClient.ensureQueryData({
      queryKey: queryKeys.auth.me(),
      queryFn: () => api.get<Me>('/auth/me'),
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    });
  } catch (error) {
    if (isApiError(error) && (error.status === 401 || error.status === 403)) {
      // TanStack's `redirect()` is a control-flow signal the router unwraps; it is
      // deliberately not an Error subclass.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: '/login', search: { redirect: location.href }, replace: true });
    }
    // A network or 5xx failure is not an auth failure: let the shell render and
    // report it, rather than bouncing the operator to a login they do not need.
  }
}

const protectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'protected',
  beforeLoad: requireSession,
  component: AppShell,
});

/**
 * The first-run layout: signed in, but no sidebar and no top bar. `/welcome` runs
 * before any server exists, so the shell would be a menu of things that do not
 * work yet — the concept's `setup.html` draws it as a logo bar and a centred
 * wizard, and this is that.
 */
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'setup',
  beforeLoad: requireSession,
  component: lazyRouteComponent(
    () => import('@/features/welcome/WelcomeLayout'),
    'WelcomeLayout',
  ),
});

const overviewRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/',
  staticData: { crumb: 'overview.title' },
  component: lazyRouteComponent(
    () => import('@/features/dashboard/OverviewPage'),
    'OverviewPage',
  ),
});

const welcomeRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/welcome',
  staticData: { crumb: 'welcome.title' },
  component: lazyRouteComponent(() => import('@/features/welcome/WelcomePage'), 'WelcomePage'),
});

const serversRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/servers',
  staticData: { crumb: 'servers.title' },
  component: lazyRouteComponent(() => import('@/features/servers/ServersPage'), 'ServersPage'),
});

const serverDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/servers/$server',
  staticData: { crumbFromParams: (params) => params.server ?? '' },
  component: lazyRouteComponent(
    () => import('@/features/servers/ServerDetailPage'),
    'ServerDetailPage',
  ),
});

const bucketsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/buckets',
  staticData: { crumb: 'buckets.title' },
  component: lazyRouteComponent(
    () => import('@/features/buckets/BucketsPage'),
    'BucketsPage',
  ),
});

const bucketDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/buckets/$server/$bucket',
  staticData: { crumbFromParams: (params) => params.bucket ?? '' },
  component: lazyRouteComponent(
    () => import('@/features/buckets/BucketSettingsPage'),
    'BucketSettingsPage',
  ),
});

const browseRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/browse',
  staticData: { crumb: 'browse.title' },
  component: lazyRouteComponent(
    () => import('@/features/objects/BucketPickerPage'),
    'BucketPickerPage',
  ),
});

const browsePrefixRoute = createRoute({
  getParentRoute: () => protectedRoute,
  // The trailing splat is the object prefix:
  // /browse/minio-prod-01/media-prod/2026/09/
  path: '/browse/$server/$bucket/$',
  staticData: { crumbFromParams: (params) => params.bucket ?? '' },
  component: lazyRouteComponent(
    () => import('@/features/objects/ObjectBrowserPage'),
    'ObjectBrowserPage',
  ),
});

const quotasRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/quotas',
  staticData: { crumb: 'quotas.title' },
  component: lazyRouteComponent(() => import('@/features/quotas/QuotasPage'), 'QuotasPage'),
});

const jobsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/jobs',
  staticData: { crumb: 'jobs.title' },
  component: lazyRouteComponent(() => import('@/features/jobs/JobsPage'), 'JobsPage'),
});

const transfersRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/transfers',
  staticData: { crumb: 'transfers.title' },
  component: lazyRouteComponent(
    () => import('@/features/transfers/TransfersPage'),
    'TransfersPage',
  ),
});

const usersRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/users',
  staticData: { crumb: 'users.title' },
  component: lazyRouteComponent(() => import('@/features/iam/UsersPage'), 'UsersPage'),
});

const policiesRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/policies',
  staticData: { crumb: 'policies.title' },
  component: lazyRouteComponent(() => import('@/features/iam/PoliciesPage'), 'PoliciesPage'),
});

const keysRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/keys',
  staticData: { crumb: 'keys.title' },
  component: lazyRouteComponent(() => import('@/features/iam/KeysPage'), 'KeysPage'),
});

const activityRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/activity',
  staticData: { crumb: 'activity.title' },
  component: lazyRouteComponent(() => import('@/features/activity/ActivityPage'), 'ActivityPage'),
});

const settingsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings',
  staticData: { crumb: 'settings.title' },
  component: lazyRouteComponent(() => import('@/features/settings/SettingsPage'), 'SettingsPage'),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute.addChildren([welcomeRoute]),
  protectedRoute.addChildren([
    overviewRoute,
    serversRoute,
    serverDetailRoute,
    bucketsRoute,
    bucketDetailRoute,
    browseRoute,
    browsePrefixRoute,
    quotasRoute,
    jobsRoute,
    transfersRoute,
    usersRoute,
    policiesRoute,
    keysRoute,
    activityRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // The query cache is the cache; the router should not keep a second copy.
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: NotFoundPage,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
  // Makes `staticData` on every route the breadcrumb shape, so a typo is caught.
  // Module augmentation needs an interface; it adds members to TanStack's own.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface StaticDataRouteOption extends RouteCrumbData {}
}
