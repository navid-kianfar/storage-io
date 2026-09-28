import { Injectable } from '@nestjs/common';
import type { IamDriver } from '@storage-io/contracts';
import { ProviderError } from '../../common/errors/domain.exception';
import type { IamSubDriver, RawIamUser, ServerConnection } from '../provider-driver';
import { AdminHttpClient, AdminHttpError } from './admin-http.client';
import type {
  CreateRawKeyInput,
  CreateRawUserInput,
  IamAccessKeyOperations,
  IamUserOperations,
  RawAccessKey,
  RawCreatedKey,
  RawIamUserDetail,
} from './iam-driver';
import { asArray } from './iam-driver';

/**
 * `ceph-admin`: the RGW Admin Ops API — SigV4-signed REST under `/admin`.
 *
 * What it maps, and what it deliberately does not:
 *
 * - **Users** are RGW users. `GET /admin/metadata/user` lists their ids;
 *   `GET|PUT|POST|DELETE /admin/user` reads, creates, modifies and removes one.
 *   `suspended` is RGW's disabled flag, so `setStatus` is real here.
 * - **Access keys** are the user's S3 keys, created and removed through the
 *   `?key` sub-resource. RGW has no per-key status, no expiry and no name, so
 *   `expiresAt` and `name` are app-tracked in `key_meta`, and a key is disabled
 *   by removing it — which is destructive, so `update` is absent and a status
 *   change comes back as `NOT_SUPPORTED`.
 * - **Groups** do not exist in RGW.
 * - **Policies**: RGW's IAM-compatible endpoint (user inline policies) is not
 *   implemented here, so `iamPolicies` is `not_supported` in the Ceph profile
 *   rather than a surface that half works. Bucket policies are the supported way
 *   to grant access on Ceph, and those are the buckets module's.
 *
 * **Unverified against a live cluster.** The paths and parameter names come from
 * the Ceph RGW Admin Ops documentation; there is no Ceph container in
 * `docker/docker-compose.dev.yml`, so the coverage here is a fixture test
 * (`test/unit/ceph-iam.spec.ts`) that asserts the request line, the SigV4
 * `Authorization` header and the response mapping against a local HTTP server.
 * `rgw_admin_entry` is assumed to be its default, `admin`.
 */

/** RGW's default `rgw_admin_entry`. */
const ADMIN_PREFIX = '/admin';
const NO_SUCH_USER = 'NoSuchUser';
const NO_SUCH_KEY = 'InvalidAccessKeyId';

interface RgwKey {
  readonly user?: string;
  readonly access_key?: string;
  readonly secret_key?: string;
}

interface RgwUser {
  readonly user_id?: string;
  readonly display_name?: string;
  readonly suspended?: number;
  readonly keys?: readonly RgwKey[];
}

@Injectable()
export class CephIamDriver implements IamSubDriver {
  readonly kind: IamDriver = 'ceph-admin';

  readonly users: IamUserOperations;
  readonly keys: IamAccessKeyOperations;

  constructor(private readonly http: AdminHttpClient) {
    this.users = {
      list: (connection) => this.listUserDetails(connection),
      get: (connection, name) => this.getUser(connection, name),
      create: (connection, input) => this.createUser(connection, input),
      delete: (connection, name) => this.deleteUser(connection, name),
      setStatus: (connection, name, status) => this.setUserStatus(connection, name, status),
      // No groups and no named policies on RGW, so both are absent rather than
      // stubbed — `NOT_SUPPORTED` comes from the registry, once.
    };

    this.keys = {
      supportsNativeExpiry: false,
      supportsSessionPolicy: false,
      supportsKeyName: false,
      list: (connection, userName) => this.listKeys(connection, userName),
      get: (connection, accessKeyId) => this.getKey(connection, accessKeyId),
      create: (connection, input) => this.createKey(connection, input),
      delete: (connection, accessKeyId, userName) =>
        this.deleteKey(connection, accessKeyId, userName),
      // RGW cannot deactivate a key, only remove it. Absent rather than a
      // `update` that silently deletes the caller's credential.
    };
  }

  async ping(connection: ServerConnection): Promise<void> {
    await this.listUserIds(connection);
  }

  async listUsers(connection: ServerConnection): Promise<readonly RawIamUser[]> {
    return this.listUserDetails(connection);
  }

  async countUsers(connection: ServerConnection): Promise<number> {
    const ids = await this.listUserIds(connection);
    return ids.length;
  }

  /* ------------------------------ users --------------------------- */

  private async listUserIds(connection: ServerConnection): Promise<readonly string[]> {
    const response = await this.http.json<unknown>(connection, {
      method: 'GET',
      auth: 'sigv4',
      baseUrl: this.baseUrl(connection),
      path: `${ADMIN_PREFIX}/metadata/user`,
    });
    return asArray<string>(response);
  }

  private async listUserDetails(
    connection: ServerConnection,
  ): Promise<readonly RawIamUserDetail[]> {
    const ids = await this.listUserIds(connection);
    const users = await Promise.all(ids.map(async (id) => this.getUser(connection, id)));
    return users.filter((user): user is RawIamUserDetail => user !== null);
  }

  private async getUser(
    connection: ServerConnection,
    name: string,
  ): Promise<RawIamUserDetail | null> {
    const user = await this.fetchUser(connection, name);
    if (user === null) return null;
    return {
      name: user.user_id ?? name,
      status: user.suspended === 1 ? 'disabled' : 'enabled',
      // RGW grants through bucket policies and user caps, not named policies.
      policies: [],
      memberOf: [],
      // RGW's user metadata carries no creation time.
      createdAt: null,
    };
  }

  private async fetchUser(connection: ServerConnection, name: string): Promise<RgwUser | null> {
    try {
      return await this.http.json<RgwUser>(connection, {
        method: 'GET',
        auth: 'sigv4',
        baseUrl: this.baseUrl(connection),
        path: `${ADMIN_PREFIX}/user`,
        query: { uid: name },
      });
    } catch (error) {
      if (isCode(error, NO_SUCH_USER) || isStatus(error, 404)) return null;
      throw error;
    }
  }

  private async createUser(connection: ServerConnection, input: CreateRawUserInput): Promise<void> {
    // RGW requires a display name; the user name is the only thing storage-io has
    // to offer, and the UI shows the user name anyway.
    await this.http.request(connection, {
      method: 'PUT',
      auth: 'sigv4',
      baseUrl: this.baseUrl(connection),
      path: `${ADMIN_PREFIX}/user`,
      query: { uid: input.name, 'display-name': input.name },
    });
  }

  private async deleteUser(connection: ServerConnection, name: string): Promise<void> {
    try {
      await this.http.request(connection, {
        method: 'DELETE',
        auth: 'sigv4',
        baseUrl: this.baseUrl(connection),
        path: `${ADMIN_PREFIX}/user`,
        query: { uid: name, 'purge-data': 'True' },
      });
    } catch (error) {
      if (isCode(error, NO_SUCH_USER)) return;
      throw error;
    }
  }

  private async setUserStatus(
    connection: ServerConnection,
    name: string,
    status: 'enabled' | 'disabled',
  ): Promise<void> {
    await this.http.request(connection, {
      method: 'POST',
      auth: 'sigv4',
      baseUrl: this.baseUrl(connection),
      path: `${ADMIN_PREFIX}/user`,
      query: { uid: name, suspended: status === 'disabled' ? 'True' : 'False' },
    });
  }

  /* --------------------------- access keys ------------------------ */

  private async listKeys(
    connection: ServerConnection,
    userName?: string,
  ): Promise<readonly RawAccessKey[]> {
    const ids = userName === undefined ? await this.listUserIds(connection) : [userName];
    const perUser = await Promise.all(ids.map(async (id) => this.keysOfUser(connection, id)));
    return perUser.flat();
  }

  private async keysOfUser(
    connection: ServerConnection,
    userName: string,
  ): Promise<readonly RawAccessKey[]> {
    const user = await this.fetchUser(connection, userName);
    if (user === null) return [];

    return (user.keys ?? [])
      .filter((key) => key.access_key !== undefined)
      .map((key) => ({
        accessKeyId: key.access_key ?? '',
        userName: key.user ?? userName,
        name: null,
        // RGW has no per-key status; a suspended user disables all of its keys.
        enabled: user.suspended !== 1,
        restricted: false,
        createdAt: null,
        expiresAt: null,
        lastUsedAt: null,
      }));
  }

  private async getKey(
    connection: ServerConnection,
    accessKeyId: string,
  ): Promise<RawAccessKey | null> {
    const keys = await this.listKeys(connection);
    return keys.find((key) => key.accessKeyId === accessKeyId) ?? null;
  }

  private async createKey(
    connection: ServerConnection,
    input: CreateRawKeyInput,
  ): Promise<RawCreatedKey> {
    // The `?key` sub-resource with `generate-key=True` returns the full key list
    // for the user, newest last.
    const response = await this.http.json<unknown>(connection, {
      method: 'PUT',
      auth: 'sigv4',
      baseUrl: this.baseUrl(connection),
      path: `${ADMIN_PREFIX}/user`,
      query: { key: null, uid: input.userName, 'key-type': 's3', 'generate-key': 'True' },
    });

    // RGW answers with the user's whole key list, newest last.
    const keys = asArray<RgwKey>(response);
    const created = keys[keys.length - 1];
    if (created?.access_key === undefined || created.secret_key === undefined) {
      throw new ProviderError('Ceph created a key without returning its secret.');
    }
    return {
      accessKeyId: created.access_key,
      secretAccessKey: created.secret_key,
      expiresAt: null,
    };
  }

  private async deleteKey(
    connection: ServerConnection,
    accessKeyId: string,
    userName: string,
  ): Promise<void> {
    try {
      await this.http.request(connection, {
        method: 'DELETE',
        auth: 'sigv4',
        baseUrl: this.baseUrl(connection),
        path: `${ADMIN_PREFIX}/user`,
        query: { key: null, uid: userName, 'access-key': accessKeyId },
      });
    } catch (error) {
      if (isCode(error, NO_SUCH_KEY) || isCode(error, NO_SUCH_USER)) return;
      throw error;
    }
  }

  /** RGW serves the admin API on the S3 endpoint unless one was configured. */
  private baseUrl(connection: ServerConnection): string {
    return connection.options.adminEndpoint ?? connection.endpoint;
  }
}

const isCode = (error: unknown, code: string): boolean =>
  error instanceof AdminHttpError && error.providerCode === code;

const isStatus = (error: unknown, status: number): boolean =>
  error instanceof AdminHttpError && error.httpStatus === status;
