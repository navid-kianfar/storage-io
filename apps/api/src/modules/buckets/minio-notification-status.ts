import type { Logger } from '@nestjs/common';
import type { NotificationTargetState } from '@storage-io/contracts';
import type { MinioAdminClient } from '../../providers/minio/minio-admin.client';
import type { StorageContext } from '../storage/storage-context.service';

/**
 * Delivery state for MinIO's notification targets, read from the admin API's
 * `services.notifications` list.
 *
 * MinIO reports one entry per configured target as `{ "<arn>": [{ status: "…" }] }`
 * inside `services.notifications`, and reports **nothing at all** when the server
 * has no targets configured — which is the state of a default deployment, because
 * a target must be declared in MinIO's own configuration before a bucket can point
 * at it. An ARN missing from that list therefore means "MinIO does not know this
 * target", and the caller reports `unknown` rather than guessing.
 *
 * The parsing is deliberately defensive. This is one of the few places a
 * provider's own JSON shape reaches storage-io, the shape has changed between
 * MinIO releases, and a list that cannot be parsed must degrade to `unknown`
 * rather than fail the request that asked for it. Nothing from the payload is
 * passed through unmapped: only the ARN and a normalised status.
 *
 * **Verified** against MinIO DEVELOPMENT.2025-05-24T17-08-30Z as far as the dev
 * container allows — `/info` answers with `services` carrying `kms` and `ldap` and
 * no `notifications` key, so the empty-map path is exercised. The online/offline
 * branch is **unverified** against a live target: the dev compose file configures
 * no notification destination, so MinIO rejects a bucket notification ARN outright.
 */

const STATUS_ONLINE = 'online';
const STATUS_OFFLINE = 'offline';

export interface TargetState {
  readonly state: NotificationTargetState;
  readonly detail: string | null;
}

interface AdminInfoServices {
  readonly services?: { readonly notifications?: unknown };
}

export async function minioTargetStates(
  context: StorageContext,
  admin: MinioAdminClient,
  logger: Logger,
): Promise<ReadonlyMap<string, TargetState>> {
  const empty = new Map<string, TargetState>();
  if (context.provider !== 'minio') return empty;

  try {
    const info = await admin.json<AdminInfoServices>(context.connection, '/info');
    return parseNotifications(info.services?.notifications);
  } catch (error) {
    // The admin API being unreachable is a normal deployment (a restricted key),
    // and it does not make the configured targets any less configured.
    logger.debug(
      { server: context.row.name, err: error instanceof Error ? error.message : String(error) },
      'MinIO admin info unavailable; notification target states reported as unknown',
    );
    return empty;
  }
}

/* ------------------------------ internals ------------------------- */

/**
 * `{ "<arn>": [{ status: "online" }] }`, possibly wrapped in an array of such
 * objects. Anything else yields no entries.
 */
function parseNotifications(raw: unknown): ReadonlyMap<string, TargetState> {
  const result = new Map<string, TargetState>();
  for (const group of asGroups(raw)) {
    for (const [arn, statuses] of Object.entries(group)) {
      const state = firstStatus(statuses);
      if (state === null) continue;
      result.set(arn, state);
    }
  }
  return result;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function asGroups(raw: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (isRecord(raw)) return [raw];
  return [];
}

function firstStatus(statuses: unknown): TargetState | null {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const status = entry['status'];
    if (typeof status !== 'string') continue;
    const normalized = status.toLowerCase();
    if (normalized === STATUS_ONLINE) return { state: 'online', detail: null };
    if (normalized === STATUS_OFFLINE) return { state: 'offline', detail: status };
    return { state: 'unknown', detail: status };
  }
  return null;
}
