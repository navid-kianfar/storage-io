import type { ComponentType } from 'react';

/**
 * URL-addressable dialogs.
 * ========================
 *
 * A dialog that can be opened from somewhere else — the command palette, a
 * dashboard quick action, a link in a toast, a bookmark — lives in the URL:
 *
 *   /servers?dialog=add-server
 *   /buckets?dialog=edit-quota&d_server=minio-prod-01&d_bucket=media-prod
 *
 * `dialog` names the dialog. Everything after `d_` is that dialog's own context,
 * and no page may use a search param starting with `d_` for anything else.
 *
 * A page that owns a dialog does two things:
 *
 *   1. `registerDialog('edit-quota', EditQuotaDialog)` at module scope.
 *   2. adds the key to {@link DIALOG_OWNERS} with the route that renders it, so
 *      opening it from anywhere navigates there first.
 *
 * The dialog component receives `params` (the `d_`-prefixed values, prefix
 * stripped) and `onClose`. It renders an always-open shadcn Dialog/Sheet:
 * closing is `onClose()`, which removes `dialog` and every `d_` param from the
 * URL, so Back closes the dialog too.
 */

export const DIALOG_PARAM_PREFIX = 'd_';
export const DIALOG_SEARCH_PARAM = 'dialog';

/**
 * Every dialog the app can address by URL. The palette, the dashboard's quick
 * actions and the empty states all pick from this list, so a typo is a type
 * error rather than a dialog that never opens.
 */
export const DIALOG_KEYS = [
  'add-server',
  'edit-server',
  'rotate-server-credentials',
  'create-bucket',
  'edit-quota',
  'bucket-access',
  'lifecycle-rule',
  'upload',
  'import-url',
  'new-folder',
  'share-link',
  'create-access-key',
  'rotate-access-key',
  'create-s3-user',
  'create-s3-group',
  'create-policy',
  'new-job',
  'create-api-token',
] as const;

export type DialogKey = (typeof DIALOG_KEYS)[number];

export type DialogParams = Readonly<Record<string, string>>;

export interface DialogProps {
  /** The `d_`-prefixed search params, prefix stripped. */
  readonly params: DialogParams;
  /** Clears `dialog` and every `d_` param from the URL. */
  readonly onClose: () => void;
}

export type DialogComponent = ComponentType<DialogProps>;

/**
 * Which route renders each dialog. Opening a dialog from elsewhere navigates
 * here first, because the component registers itself when its module loads and a
 * lazily-loaded route has not loaded yet.
 */
export const DIALOG_OWNERS: Readonly<Record<DialogKey, string>> = {
  'add-server': '/servers',
  'edit-server': '/servers',
  'rotate-server-credentials': '/servers',
  'create-bucket': '/buckets',
  'edit-quota': '/quotas',
  'bucket-access': '/buckets',
  'lifecycle-rule': '/buckets',
  upload: '/browse',
  'import-url': '/browse',
  'new-folder': '/browse',
  'share-link': '/browse',
  'create-access-key': '/keys',
  'rotate-access-key': '/keys',
  'create-s3-user': '/users',
  'create-s3-group': '/users',
  'create-policy': '/policies',
  'new-job': '/jobs',
  'create-api-token': '/settings',
};

const registry = new Map<DialogKey, DialogComponent>();

export function registerDialog(key: DialogKey, component: DialogComponent): void {
  registry.set(key, component);
}

export function getDialog(key: string): DialogComponent | undefined {
  return registry.get(key as DialogKey);
}

export function isDialogKey(value: string): value is DialogKey {
  return (DIALOG_KEYS as readonly string[]).includes(value);
}

/** Test-only: drop registrations so one test's dialog does not leak into the next. */
export function clearDialogRegistry(): void {
  registry.clear();
}
