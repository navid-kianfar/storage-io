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
  UpdateRawKeyInput,
} from './iam-driver';
import { asArray } from './iam-driver';

/**
 * `garage-admin`: the Garage admin API, authenticated with the admin bearer token.
 *
 * Garage has no users — it has **keys**, and a key is the identity a bucket is
 * granted to. That is mapped honestly rather than invented around:
 *
 * - A **user** is a key, named by its key id, and its "name" is the key's label.
 *   Creating a user creates a key; deleting one deletes the key.
 * - An **access key** is the same object, listed under `/iam/access-keys` too, so
 *   an operator sees it in whichever screen they open. Its secret is returned
 *   once, at creation, exactly as Garage returns it.
 * - **Groups** and **policies** do not exist; both are absent, so the Garage
 *   profile reports them `not_supported` and the endpoints answer `NOT_SUPPORTED`.
 * - Garage cannot deactivate a key, so `update` carries only the key's name; a
 *   status change is refused rather than silently deleting a credential.
 *
 * Bucket permissions (`/v1/bucket/allow`, `/v1/bucket/deny`) are how access is
 * granted on Garage, and they belong to a bucket screen, not to this driver.
 *
 * **Unverified against a live Garage.** The paths below are the v1 admin API
 * (Garage 0.9–1.x); there is no Garage container in
 * `docker/docker-compose.dev.yml`. Garage 2.x renamed the admin API to
 * `/v2/<Operation>`, which this driver does **not** speak — a 404 from it becomes
 * "the admin API does not offer this operation", which is the honest answer until
 * someone can test against 2.x. Coverage here is a fixture test
 * (`test/unit/garage-iam.spec.ts`) asserting the request line, the bearer header
 * and the response mapping.
 */

const KEY_PATH = '/v1/key';

/** `name` is genuinely nullable in Garage's answer, not merely absent. */
interface GarageKeyListEntry {
  readonly id?: string;
  readonly name?: string | null;
}

interface GarageKeyInfo {
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly name?: string | null;
}

@Injectable()
export class GarageIamDriver implements IamSubDriver {
  readonly kind: IamDriver = 'garage-admin';

  readonly users: IamUserOperations;
  readonly keys: IamAccessKeyOperations;

  constructor(private readonly http: AdminHttpClient) {
    this.users = {
      list: (connection) => this.listUserDetails(connection),
      get: (connection, name) => this.getUser(connection, name),
      create: (connection, input) => this.createUser(connection, input),
      delete: (connection, name) => this.deleteKeyById(connection, name),
      // Garage has no enabled/disabled key, no groups and no named policies.
    };

    this.keys = {
      supportsNativeExpiry: false,
      supportsSessionPolicy: false,
      supportsKeyName: true,
      list: (connection, userName) => this.listKeys(connection, userName),
      get: (connection, accessKeyId) => this.getKey(connection, accessKeyId),
      create: (connection, input) => this.createKey(connection, input),
      delete: (connection, accessKeyId) => this.deleteKeyById(connection, accessKeyId),
      update: (connection, accessKeyId, _userName, patch) =>
        this.updateKey(connection, accessKeyId, patch),
    };
  }

  async ping(connection: ServerConnection): Promise<void> {
    await this.listKeyEntries(connection);
  }

  async listUsers(connection: ServerConnection): Promise<readonly RawIamUser[]> {
    return this.listUserDetails(connection);
  }

  async countUsers(connection: ServerConnection): Promise<number> {
    const entries = await this.listKeyEntries(connection);
    return entries.length;
  }

  /* -------------------- keys, seen as users too ------------------- */

  private async listKeyEntries(
    connection: ServerConnection,
  ): Promise<readonly GarageKeyListEntry[]> {
    const response = await this.http.json<unknown>(connection, {
      method: 'GET',
      auth: 'bearer',
      baseUrl: this.baseUrl(connection),
      path: KEY_PATH,
      query: { list: null },
    });
    return asArray<GarageKeyListEntry>(response);
  }

  private async listUserDetails(
    connection: ServerConnection,
  ): Promise<readonly RawIamUserDetail[]> {
    const entries = await this.listKeyEntries(connection);
    return entries
      .filter((entry) => entry.id !== undefined)
      .map((entry) => ({
        name: entry.id ?? '',
        // Garage keys are always usable; there is nothing to disable.
        status: 'enabled' as const,
        policies: [],
        memberOf: [],
        createdAt: null,
      }));
  }

  private async getUser(
    connection: ServerConnection,
    name: string,
  ): Promise<RawIamUserDetail | null> {
    const key = await this.fetchKey(connection, name);
    if (key === null) return null;
    return {
      name: key.accessKeyId ?? name,
      status: 'enabled',
      policies: [],
      memberOf: [],
      createdAt: null,
    };
  }

  private async createUser(connection: ServerConnection, input: CreateRawUserInput): Promise<void> {
    await this.createKey(connection, {
      userName: input.name,
      name: input.name,
      description: null,
      expiresAt: null,
      policy: null,
    });
  }

  private async fetchKey(
    connection: ServerConnection,
    accessKeyId: string,
  ): Promise<GarageKeyInfo | null> {
    try {
      return await this.http.json<GarageKeyInfo>(connection, {
        method: 'GET',
        auth: 'bearer',
        baseUrl: this.baseUrl(connection),
        path: KEY_PATH,
        query: { id: accessKeyId },
      });
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  private async listKeys(
    connection: ServerConnection,
    userName?: string,
  ): Promise<readonly RawAccessKey[]> {
    const entries = await this.listKeyEntries(connection);
    const wanted =
      userName === undefined ? entries : entries.filter((entry) => entry.id === userName);

    return wanted
      .filter((entry) => entry.id !== undefined)
      .map((entry) => toRawKey(entry.id ?? '', entry.name));
  }

  private async getKey(
    connection: ServerConnection,
    accessKeyId: string,
  ): Promise<RawAccessKey | null> {
    const key = await this.fetchKey(connection, accessKeyId);
    if (key === null) return null;
    return toRawKey(key.accessKeyId ?? accessKeyId, key.name);
  }

  private async createKey(
    connection: ServerConnection,
    input: CreateRawKeyInput,
  ): Promise<RawCreatedKey> {
    const created = await this.http.json<GarageKeyInfo>(connection, {
      method: 'POST',
      auth: 'bearer',
      baseUrl: this.baseUrl(connection),
      path: KEY_PATH,
      json: { name: input.name },
    });

    if (created.accessKeyId === undefined || created.secretAccessKey === undefined) {
      throw new ProviderError('Garage created a key without returning its secret.');
    }
    return {
      accessKeyId: created.accessKeyId,
      secretAccessKey: created.secretAccessKey,
      expiresAt: null,
    };
  }

  private async updateKey(
    connection: ServerConnection,
    accessKeyId: string,
    patch: UpdateRawKeyInput,
  ): Promise<void> {
    // `enabled` is not in Garage's vocabulary; the service refuses a status
    // change before it gets here, and a name-only patch is all that is left.
    if (patch.name === undefined) return;
    await this.http.request(connection, {
      method: 'POST',
      auth: 'bearer',
      baseUrl: this.baseUrl(connection),
      path: KEY_PATH,
      query: { id: accessKeyId },
      json: { name: patch.name },
    });
  }

  private async deleteKeyById(connection: ServerConnection, accessKeyId: string): Promise<void> {
    try {
      await this.http.request(connection, {
        method: 'DELETE',
        auth: 'bearer',
        baseUrl: this.baseUrl(connection),
        path: KEY_PATH,
        query: { id: accessKeyId },
      });
    } catch (error) {
      if (isStatus(error, 404)) return;
      throw error;
    }
  }

  /** Garage's admin API is a separate port, so it needs `adminEndpoint`. */
  private baseUrl(connection: ServerConnection): string {
    const configured = connection.options.adminEndpoint;
    if (configured === null || configured.length === 0) {
      throw new ProviderError(
        'This Garage server has no admin endpoint configured, so its keys cannot be managed.',
      );
    }
    return configured;
  }
}

const toRawKey = (accessKeyId: string, name: string | null | undefined): RawAccessKey => ({
  accessKeyId,
  // In Garage a key *is* the identity, so it is its own owner.
  userName: accessKeyId,
  name: name === null || name === undefined || name.length === 0 ? null : name,
  enabled: true,
  restricted: false,
  createdAt: null,
  expiresAt: null,
  lastUsedAt: null,
});

const isStatus = (error: unknown, status: number): boolean =>
  error instanceof AdminHttpError && error.httpStatus === status;
