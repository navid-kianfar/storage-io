import type { Me } from '@storage-io/contracts';
import type { QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { z } from 'zod';
import { AppShell } from '@/components/shell/AppShell';
import type { RouteCrumbData } from '@/components/shell/Breadcrumbs';
import { LoginPage } from '@/features/auth/LoginPage';
import { i18next } from '@/i18n';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query/keys';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { PlaceholderPage } from '@/pages/PlaceholderPage';

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
 */
const protectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'protected',
  beforeLoad: async ({ context, location }) => {
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
  },
  component: AppShell,
});

/** i18next is initialised in main.tsx, so page titles have to be read lazily. */
function pageText(key: string): string {
  return i18next.t(key, { ns: 'pages' });
}

function placeholder(page: string, components: readonly string[]) {
  return function PlaceholderRoute() {
    return (
      <PlaceholderPage
        title={pageText(`${page}.title`)}
        description={pageText(`${page}.description`)}
        components={components}
      />
    );
  };
}

const overviewRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/',
  staticData: { crumb: 'overview.title' },
  component: placeholder('overview', [
    'KpiCard',
    'Sparkline',
    'Meter',
    'DataTable',
    'ProviderMark',
    'ServerStatusBadge',
  ]),
});

const welcomeRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/welcome',
  staticData: { crumb: 'welcome.title' },
  component: placeholder('welcome', [
    'useStepper',
    'StepList',
    'StepperNav',
    'ChoiceCards',
    'ProviderMark',
  ]),
});

const serversRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/servers',
  staticData: { crumb: 'servers.title' },
  component: placeholder('servers', [
    'DataTable',
    'ProviderMark',
    'ServerStatusBadge',
    'Meter',
    'ConfirmDialog',
    'useStepper',
  ]),
});

const serverDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/servers/$server',
  staticData: { crumbFromParams: (params) => params.server ?? '' },
  component: placeholder('server', [
    'KpiCard',
    'DataTable',
    'Meter',
    'CopyField',
    'SegmentedControl',
    'ConfirmDialog',
  ]),
});

const bucketsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/buckets',
  staticData: { crumb: 'buckets.title' },
  component: placeholder('buckets', [
    'DataTable',
    'Meter',
    'Combobox',
    'ConfirmDialog',
    'EmptyState',
  ]),
});

const bucketDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/buckets/$server/$bucket',
  staticData: { crumbFromParams: (params) => params.bucket ?? '' },
  component: placeholder('bucket', [
    'CodeEditor',
    'Meter',
    'ConfirmDialog',
    'DatePicker',
    'Combobox',
    'SegmentedControl',
  ]),
});

const browseRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/browse',
  staticData: { crumb: 'browse.title' },
  component: placeholder('browse', ['Combobox', 'EmptyState', 'DataTable']),
});

const browsePrefixRoute = createRoute({
  getParentRoute: () => protectedRoute,
  // The trailing splat is the object prefix:
  // /browse/minio-prod-01/media-prod/2026/09/
  path: '/browse/$server/$bucket/$',
  staticData: { crumbFromParams: (params) => params.bucket ?? '' },
  component: placeholder('browse', [
    'DataTable',
    'FileDropzone',
    'CodeEditor',
    'ConfirmDialog',
    'CopyField',
  ]),
});

const quotasRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/quotas',
  staticData: { crumb: 'quotas.title' },
  component: placeholder('quotas', [
    'DataTable',
    'Meter',
    'Sparkline',
    'SegmentedControl',
    'Combobox',
  ]),
});

const jobsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/jobs',
  staticData: { crumb: 'jobs.title' },
  component: placeholder('jobs', [
    'DataTable',
    'Meter',
    'JobStatusBadge',
    'useStepper',
    'DateRangePicker',
    'CodeEditor',
  ]),
});

const transfersRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/transfers',
  staticData: { crumb: 'transfers.title' },
  component: placeholder('transfers', ['DataTable', 'Meter', 'Sparkline', 'useTransfers']),
});

const usersRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/users',
  staticData: { crumb: 'users.title' },
  component: placeholder('users', [
    'DataTable',
    'UserStatusBadge',
    'Combobox',
    'ConfirmDialog',
    'CopyField',
  ]),
});

const policiesRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/policies',
  staticData: { crumb: 'policies.title' },
  component: placeholder('policies', [
    'CodeEditor',
    'DataTable',
    'ConfirmDialog',
    'SegmentedControl',
    'EmptyState',
  ]),
});

const keysRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/keys',
  staticData: { crumb: 'keys.title' },
  component: placeholder('keys', [
    'DataTable',
    'AccessKeyStatusBadge',
    'DatePicker',
    'CopyField',
    'ConfirmDialog',
  ]),
});

const activityRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/activity',
  staticData: { crumb: 'activity.title' },
  component: placeholder('activity', [
    'DataTable',
    'DateRangePicker',
    'Combobox',
    'CodeEditor',
    'RelativeTime',
  ]),
});

const settingsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings',
  staticData: { crumb: 'settings.title' },
  component: placeholder('settings', [
    'SegmentedControl',
    'ChoiceCards',
    'Combobox',
    'CopyField',
    'ConfirmDialog',
  ]),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  protectedRoute.addChildren([
    overviewRoute,
    welcomeRoute,
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
