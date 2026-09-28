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
 * settles. The map is docs/ROUTES.md and that document is binding.
 *
 * Four conventions the whole app relies on:
 *
 * 1. **Every param is an opaque id.** `$serverId`, `$bucketId`, `$userId`,
 *    `$groupId`, `$policyId`, `$keyId`, `$jobId`, `$eventId`. Never a name: a name
 *    is unique only within one server, is not a safe path segment, and leaks what
 *    the operator called something into every link they paste.
 * 2. **Search params carry view state only** — filters, sort, page, tab, range.
 *    Identity travels in the path; context that is neither identity nor view state
 *    (the object selection that pre-fills the new-job wizard) travels in router
 *    history state. The root schema is loose so a page may add its own filters.
 * 3. **A dialog that creates or edits an entity is a child route.** It renders over
 *    its parent page through the parent's `<Outlet/>`, and closing it navigates to
 *    the parent. Small in-page confirmations (delete, rename, tag) stay component
 *    state and have no URL. There is no `?dialog=` registry any more.
 * 4. `staticData` carries the breadcrumb: `crumb` is a key in the `pages`
 *    namespace, and `crumbEntity` names the id param and what kind of entity it
 *    is, so the crumb shows the resolved *name* while the URL keeps the id.
 *
 * Each route is written out in full rather than produced by a helper, because
 * TanStack Router infers `Link`'s `to` types from the literal `path` — a helper
 * taking `path: string` collapses every route type in the app to `string`.
 */

export interface RouterContext {
  readonly queryClient: QueryClient;
}

/**
 * Reserved by the shell; unknown keys pass through so pages own their filters.
 * Nothing here is data: `redirect` is where to return after signing in, and
 * `theme`/`lang` are the two overrides a support link may carry.
 */
const rootSearchSchema = z.looseObject({
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

/* ------------------------------- servers -------------------------------- */

const serversRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/servers',
  staticData: { crumb: 'servers.title' },
  component: lazyRouteComponent(() => import('@/features/servers/ServersPage'), 'ServersPage'),
});

const addServerRoute = createRoute({
  getParentRoute: () => serversRoute,
  path: '/new',
  component: lazyRouteComponent(
    () => import('@/features/servers/dialogs/AddServerDialog'),
    'AddServerRoute',
  ),
});

const serverDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/servers/$serverId',
  staticData: { crumbEntity: { kind: 'server', param: 'serverId' } },
  component: lazyRouteComponent(
    () => import('@/features/servers/ServerDetailPage'),
    'ServerDetailPage',
  ),
});

const rotateServerCredentialsRoute = createRoute({
  getParentRoute: () => serverDetailRoute,
  path: '/rotate-credentials',
  component: lazyRouteComponent(
    () => import('@/features/servers/dialogs/RotateCredentialsDialog'),
    'RotateCredentialsRoute',
  ),
});

const editServerRoute = createRoute({
  getParentRoute: () => serverDetailRoute,
  path: '/edit',
  component: lazyRouteComponent(
    () => import('@/features/servers/dialogs/EditServerDialog'),
    'EditServerRoute',
  ),
});

/* ------------------------------- buckets -------------------------------- */

const bucketsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/buckets',
  staticData: { crumb: 'buckets.title' },
  component: lazyRouteComponent(() => import('@/features/buckets/BucketsPage'), 'BucketsPage'),
});

const createBucketRoute = createRoute({
  getParentRoute: () => bucketsRoute,
  path: '/new',
  component: lazyRouteComponent(
    () => import('@/features/buckets/dialogs/CreateBucketDialog'),
    'CreateBucketRoute',
  ),
});

const bucketSettingsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/buckets/$bucketId',
  staticData: { crumbEntity: { kind: 'bucket', param: 'bucketId' } },
  component: lazyRouteComponent(
    () => import('@/features/buckets/BucketSettingsPage'),
    'BucketSettingsPage',
  ),
});

const bucketQuotaRoute = createRoute({
  getParentRoute: () => bucketSettingsRoute,
  path: '/quota',
  component: lazyRouteComponent(
    () => import('@/features/quotas/dialogs/EditQuotaDialog'),
    'BucketQuotaRoute',
  ),
});

/**
 * The object browser. One pathless layout holds the listing, and the four paths
 * below are its modes, so opening the inspector or the upload sheet is a
 * navigation that does **not** remount the listing underneath it.
 *
 * The splat is the object's prefix on `browse`, `upload` and `import`, and the
 * object's key on `object`. A key is the object's identity in S3 and it has no
 * other id, which is why it is a path segment and never a query param.
 */
const objectBrowserRoute = createRoute({
  getParentRoute: () => protectedRoute,
  id: 'object-browser',
  staticData: { crumbEntity: { kind: 'bucket', param: 'bucketId' } },
  component: lazyRouteComponent(
    () => import('@/features/objects/ObjectBrowserPage'),
    'ObjectBrowserPage',
  ),
});

const browseRoute = createRoute({
  getParentRoute: () => objectBrowserRoute,
  path: '/buckets/$bucketId/browse/$',
  staticData: { browserMode: 'browse' },
  component: Outlet,
});

const objectRoute = createRoute({
  getParentRoute: () => objectBrowserRoute,
  path: '/buckets/$bucketId/object/$',
  staticData: { browserMode: 'object' },
  component: Outlet,
});

const uploadRoute = createRoute({
  getParentRoute: () => objectBrowserRoute,
  path: '/buckets/$bucketId/upload/$',
  staticData: { browserMode: 'upload' },
  component: lazyRouteComponent(
    () => import('@/features/objects/dialogs/UploadDialog'),
    'UploadRoute',
  ),
});

const importRoute = createRoute({
  getParentRoute: () => objectBrowserRoute,
  path: '/buckets/$bucketId/import/$',
  staticData: { browserMode: 'import' },
  component: lazyRouteComponent(
    () => import('@/features/objects/dialogs/ImportUrlDialog'),
    'ImportUrlRoute',
  ),
});

const bucketPickerRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/browse',
  staticData: { crumb: 'browse.title' },
  component: lazyRouteComponent(
    () => import('@/features/objects/BucketPickerPage'),
    'BucketPickerPage',
  ),
});

/* -------------------------------- quotas -------------------------------- */

const quotasRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/quotas',
  staticData: { crumb: 'quotas.title' },
  component: lazyRouteComponent(() => import('@/features/quotas/QuotasPage'), 'QuotasPage'),
});

const quotaEditRoute = createRoute({
  getParentRoute: () => quotasRoute,
  path: '/$bucketId',
  component: lazyRouteComponent(
    () => import('@/features/quotas/dialogs/EditQuotaDialog'),
    'QuotaEditRoute',
  ),
});

/* --------------------------------- jobs --------------------------------- */

const jobsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/jobs',
  staticData: { crumb: 'jobs.title' },
  component: lazyRouteComponent(() => import('@/features/jobs/JobsPage'), 'JobsPage'),
});

const newJobRoute = createRoute({
  getParentRoute: () => jobsRoute,
  path: '/new',
  component: lazyRouteComponent(
    () => import('@/features/jobs/dialogs/NewJobDialog'),
    'NewJobRoute',
  ),
});

/**
 * The sheets over the jobs list. They act on the row behind them — pause it,
 * resume it, cancel it — so the page keeps ownership and these routes only say
 * which overlay and which id (see `useRouteOverlay`).
 */
const jobDetailRoute = createRoute({
  getParentRoute: () => jobsRoute,
  path: '/$jobId',
  staticData: { overlay: 'job-log' },
  component: Outlet,
});

const jobRunsRoute = createRoute({
  getParentRoute: () => jobsRoute,
  path: '/$jobId/runs',
  staticData: { overlay: 'job-runs' },
  component: Outlet,
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

/* ------------------------------ IAM: users ------------------------------ */

const usersRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/users',
  staticData: { crumb: 'users.title' },
  component: lazyRouteComponent(() => import('@/features/iam/UsersPage'), 'UsersPage'),
});

const newUserRoute = createRoute({
  getParentRoute: () => usersRoute,
  path: '/new',
  component: lazyRouteComponent(
    () => import('@/features/iam/dialogs/CreateS3UserDialog'),
    'CreateS3UserRoute',
  ),
});

const newGroupRoute = createRoute({
  getParentRoute: () => usersRoute,
  path: '/groups/new',
  component: lazyRouteComponent(
    () => import('@/features/iam/dialogs/CreateS3GroupDialog'),
    'CreateS3GroupRoute',
  ),
});

const groupDetailRoute = createRoute({
  getParentRoute: () => usersRoute,
  path: '/groups/$groupId',
  staticData: { overlay: 'group-edit' },
  component: Outlet,
});

const userDetailRoute = createRoute({
  getParentRoute: () => usersRoute,
  path: '/$userId',
  staticData: { overlay: 'user-sheet' },
  component: Outlet,
});

/* ----------------------------- IAM: policies ---------------------------- */

const policiesRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/policies',
  staticData: { crumb: 'policies.title' },
  component: lazyRouteComponent(() => import('@/features/iam/PoliciesPage'), 'PoliciesPage'),
});

const newPolicyRoute = createRoute({
  getParentRoute: () => policiesRoute,
  path: '/new',
  component: lazyRouteComponent(
    () => import('@/features/iam/dialogs/CreatePolicyDialog'),
    'CreatePolicyRoute',
  ),
});

/** The editor pane of the policies page, addressed by the policy's id. */
const policyDetailRoute = createRoute({
  getParentRoute: () => policiesRoute,
  path: '/$policyId',
  staticData: { overlay: 'policy-editor' },
  component: Outlet,
});

/* ------------------------------- IAM: keys ------------------------------ */

const keysRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/keys',
  staticData: { crumb: 'keys.title' },
  component: lazyRouteComponent(() => import('@/features/iam/KeysPage'), 'KeysPage'),
});

const newKeyRoute = createRoute({
  getParentRoute: () => keysRoute,
  path: '/new',
  component: lazyRouteComponent(
    () => import('@/features/iam/dialogs/CreateAccessKeyDialog'),
    'CreateAccessKeyRoute',
  ),
});

const editKeyRoute = createRoute({
  getParentRoute: () => keysRoute,
  path: '/$keyId/edit',
  staticData: { overlay: 'key-edit' },
  component: Outlet,
});

const rotateKeyRoute = createRoute({
  getParentRoute: () => keysRoute,
  path: '/$keyId/rotate',
  staticData: { overlay: 'key-rotate' },
  component: Outlet,
});

/* ------------------------------- activity ------------------------------- */

const activityRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/activity',
  staticData: { crumb: 'activity.title' },
  component: lazyRouteComponent(() => import('@/features/activity/ActivityPage'), 'ActivityPage'),
});

const activityEventRoute = createRoute({
  getParentRoute: () => activityRoute,
  path: '/$eventId',
  staticData: { overlay: 'activity-event' },
  component: Outlet,
});

/* ------------------------------- settings ------------------------------- */

const settingsIndexRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings',
  staticData: { crumb: 'settings.title' },
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/settings/$section', params: { section: 'account' }, replace: true });
  },
  component: Outlet,
});

const settingsSectionRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/$section',
  staticData: { crumb: 'settings.title' },
  component: lazyRouteComponent(() => import('@/features/settings/SettingsPage'), 'SettingsPage'),
});

const createApiTokenRoute = createRoute({
  getParentRoute: () => settingsSectionRoute,
  path: '/new-token',
  component: lazyRouteComponent(
    () => import('@/features/settings/dialogs/CreateApiTokenDialog'),
    'CreateApiTokenRoute',
  ),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute.addChildren([welcomeRoute]),
  protectedRoute.addChildren([
    overviewRoute,
    serversRoute.addChildren([addServerRoute]),
    serverDetailRoute.addChildren([rotateServerCredentialsRoute, editServerRoute]),
    bucketsRoute.addChildren([createBucketRoute]),
    bucketSettingsRoute.addChildren([bucketQuotaRoute]),
    objectBrowserRoute.addChildren([browseRoute, objectRoute, uploadRoute, importRoute]),
    bucketPickerRoute,
    quotasRoute.addChildren([quotaEditRoute]),
    jobsRoute.addChildren([newJobRoute, jobDetailRoute, jobRunsRoute]),
    transfersRoute,
    usersRoute.addChildren([newUserRoute, newGroupRoute, groupDetailRoute, userDetailRoute]),
    policiesRoute.addChildren([newPolicyRoute, policyDetailRoute]),
    keysRoute.addChildren([newKeyRoute, editKeyRoute, rotateKeyRoute]),
    activityRoute.addChildren([activityEventRoute]),
    settingsIndexRoute,
    settingsSectionRoute.addChildren([createApiTokenRoute]),
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
