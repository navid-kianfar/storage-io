import {
  ACCESS_KEY_EXPIRING_DAYS,
  API_PREFIX,
  type AccessKey,
  type AccessKeyList,
  type CreateAccessKeyRequest,
  type CreateS3UserRequest,
  type CreatedKey,
  type PolicyDetail,
  type PolicyList,
  type PolicySummary,
  type PolicyVersion,
  type PolicyVersionList,
  type RotateAccessKeyRequest,
  type S3Group,
  type S3GroupList,
  type S3User,
  type S3UserDetail,
  type S3UserList,
  type SetUserGroupsRequest,
  type SetUserPoliciesRequest,
  type SimulatePolicyRequest,
  type SimulatePolicyResponse,
  type UpdateAccessKeyRequest,
  type UpdateS3UserRequest,
  type UpsertS3GroupRequest,
  type ValidatePolicyRequest,
  type ValidatePolicyResponse,
  evaluatePolicy,
  validatePolicyDocument,
} from '@storage-io/contracts';
import { HttpResponse, http } from 'msw';
import { iamGroupId, iamPolicyId, iamUserId, accessKeyId as mintKeyId } from './ids';
import { mockServers } from './fixtures';

/**
 * Stateful mocks for `/iam/*` — S3 users, groups, policies and access keys —
 * so the three access pages are fully exercisable in `pnpm dev:mock`.
 *
 * Validation and simulation are **not** faked: they call the same pure helpers
 * from `@storage-io/contracts` that the API calls (`validatePolicyDocument`,
 * `evaluatePolicy`). A mocked "valid: true" would have let a broken policy editor
 * pass review.
 *
 * `unavailable` is populated for the offline server in the fixtures, because the
 * warning it drives is a real state the pages have to render and there is no other
 * way to reach it locally.
 */

const base = API_PREFIX;

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_LENGTH = 40;
const KEY_ID_LENGTH = 20;
const KEY_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function randomFrom(alphabet: string, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

const IAM_SERVERS = mockServers.filter((server) => server.capabilities.iamUsers === 'supported');
const PRIMARY = IAM_SERVERS[0] ?? mockServers[0];
// A distinct second server, so the fixtures exercise the aggregated-across-servers
// case. Falling back to PRIMARY would give two policies the same server+name key.
const SECONDARY = IAM_SERVERS[1] ?? mockServers.find((entry) => entry.id !== PRIMARY?.id) ?? PRIMARY;
const OFFLINE = mockServers.find((server) => server.status === 'offline');

function serverRef(id: string): { serverId: string; serverName: string } {
  const server = mockServers.find((entry) => entry.id === id);
  return { serverId: id, serverName: server?.name ?? id };
}

const unavailable =
  OFFLINE === undefined
    ? []
    : [{ serverId: OFFLINE.id, message: `${OFFLINE.name} is offline — its users are not listed.` }];

/* -------------------------------- users --------------------------------- */

function user(
  serverId: string,
  name: string,
  status: S3User['status'],
  policies: readonly string[],
  groups: readonly string[],
  accessKeyCount: number,
  createdAgoDays: number,
  lastActivityAgoHours: number | null,
): S3User {
  const ref = serverRef(serverId);
  return {
    id: iamUserId(serverId, name),
    ...ref,
    provider: mockServers.find((entry) => entry.id === serverId)?.provider ?? 'minio',
    name,
    status,
    policies: [...policies],
    groups: [...groups],
    accessKeyCount,
    createdAt: isoAgo(createdAgoDays * DAY_MS),
    lastActivityAt: lastActivityAgoHours === null ? null : isoAgo(lastActivityAgoHours * HOUR_MS),
  };
}

let users: S3User[] = [
  user(PRIMARY!.id, 'backup-agent', 'enabled', ['backup-writer'], ['automation'], 2, 210, 1),
  user(PRIMARY!.id, 'ci-runner', 'enabled', ['ci-artifacts-rw'], ['automation'], 1, 180, 4),
  user(PRIMARY!.id, 'analytics-read', 'enabled', ['readonly'], ['analysts'], 1, 90, 26),
  user(PRIMARY!.id, 'contractor-tmp', 'disabled', [], [], 0, 40, null),
  user(SECONDARY!.id, 'archive-writer', 'enabled', ['readwrite'], [], 1, 300, 9),
  user(SECONDARY!.id, 'media-transcode', 'enabled', ['media-rw'], ['automation'], 1, 120, 2),
];

let groups: S3Group[] = [
  {
    id: iamGroupId(PRIMARY!.id, 'automation'),
    ...serverRef(PRIMARY!.id),
    name: 'automation',
    members: ['backup-agent', 'ci-runner'],
    policies: ['backup-writer'],
    status: 'enabled',
  },
  {
    id: iamGroupId(PRIMARY!.id, 'analysts'),
    ...serverRef(PRIMARY!.id),
    name: 'analysts',
    members: ['analytics-read'],
    policies: ['readonly'],
    status: 'enabled',
  },
  {
    id: iamGroupId(SECONDARY!.id, 'archive'),
    ...serverRef(SECONDARY!.id),
    name: 'archive',
    members: [],
    policies: ['readwrite'],
    status: 'disabled',
  },
];

/* ------------------------------- policies -------------------------------- */

const READONLY_DOCUMENT: Record<string, unknown> = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'ReadEverything',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:ListBucket'],
      Resource: ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'],
    },
  ],
};

const BACKUP_WRITER_DOCUMENT: Record<string, unknown> = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'WriteBackups',
      Effect: 'Allow',
      Action: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListBucketMultipartUploads'],
      Resource: ['arn:aws:s3:::backups-daily/*'],
    },
    {
      Sid: 'DenyDelete',
      Effect: 'Deny',
      Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      Resource: ['arn:aws:s3:::backups-daily/*'],
    },
  ],
};

interface PolicyRecord extends PolicySummary {
  document: Record<string, unknown>;
  versions: PolicyVersion[];
}

function policy(
  serverId: string,
  name: string,
  builtIn: boolean,
  description: string | null,
  document: Record<string, unknown>,
  attachedCount: number,
): PolicyRecord {
  return {
    id: iamPolicyId(serverId, name),
    ...serverRef(serverId),
    name,
    builtIn,
    description,
    attachedCount,
    updatedAt: builtIn ? null : isoAgo(6 * DAY_MS),
    document,
    versions: builtIn
      ? []
      : [
          {
            id: `${name}-v1`,
            createdAt: isoAgo(30 * DAY_MS),
            document: READONLY_DOCUMENT,
            note: 'Initial version',
          },
        ],
  };
}

let policies: PolicyRecord[] = [
  policy(PRIMARY!.id, 'readonly', true, null, READONLY_DOCUMENT, 1),
  policy(PRIMARY!.id, 'readwrite', true, null, READONLY_DOCUMENT, 1),
  policy(PRIMARY!.id, 'consoleAdmin', true, null, READONLY_DOCUMENT, 0),
  policy(PRIMARY!.id, 'diagnostics', true, null, READONLY_DOCUMENT, 0),
  policy(PRIMARY!.id, 'writeonly', true, null, READONLY_DOCUMENT, 0),
  policy(
    PRIMARY!.id,
    'backup-writer',
    false,
    'Write-only into backups-daily, deletes denied',
    BACKUP_WRITER_DOCUMENT,
    2,
  ),
  policy(PRIMARY!.id, 'ci-artifacts-rw', false, 'CI publishes build artifacts', READONLY_DOCUMENT, 1),
  policy(SECONDARY!.id, 'media-rw', false, 'Transcoder read/write on media-cold', READONLY_DOCUMENT, 1),
  policy(SECONDARY!.id, 'readwrite', true, null, READONLY_DOCUMENT, 1),
];

/* ------------------------------ access keys ------------------------------ */

function accessKey(
  serverId: string,
  accessKeyId: string,
  userName: string,
  name: string | null,
  status: AccessKey['status'],
  expiresAt: string | null,
  lastUsedAgoHours: number | null,
  restricted = false,
): AccessKey {
  const ref = serverRef(serverId);
  return {
    id: mintKeyId(serverId, accessKeyId),
    ...ref,
    provider: mockServers.find((entry) => entry.id === serverId)?.provider ?? 'minio',
    accessKeyId,
    userName,
    name,
    status,
    restricted,
    createdAt: isoAgo(120 * DAY_MS),
    expiresAt,
    lastUsedAt: lastUsedAgoHours === null ? null : isoAgo(lastUsedAgoHours * HOUR_MS),
    rotation: null,
  };
}

let keys: AccessKey[] = [
  accessKey(PRIMARY!.id, 'AKIA5RJ2QK4LMNOPQ7F2', 'backup-agent', 'nightly backup', 'active', isoIn(3 * DAY_MS), 1),
  accessKey(PRIMARY!.id, 'AKIA7TG9WW2ZZXCVBN41', 'backup-agent', 'restore drill', 'active', null, 72),
  accessKey(PRIMARY!.id, 'AKIA2HH4MM8PPQQRR001', 'ci-runner', 'github actions', 'active', isoIn(20 * DAY_MS), 4, true),
  accessKey(PRIMARY!.id, 'AKIA9KK1LL5NNOOPP772', 'analytics-read', 'metabase', 'active', isoIn(5 * DAY_MS), 26),
  accessKey(PRIMARY!.id, 'AKIA3DD6EE7FFGGHH993', 'contractor-tmp', 'laptop', 'disabled', null, null),
  accessKey(SECONDARY!.id, 'AKIA8QQ2RR3SSTTUU114', 'archive-writer', null, 'expired', isoAgo(10 * DAY_MS), 480),
  accessKey(SECONDARY!.id, 'AKIA4VV5WW6XXYYZZ225', 'media-transcode', 'transcoder', 'active', null, 2),
];

function isExpiring(key: AccessKey): boolean {
  if (key.expiresAt === null || key.status !== 'active') return false;
  const remaining = Date.parse(key.expiresAt) - Date.now();
  return remaining > 0 && remaining <= ACCESS_KEY_EXPIRING_DAYS * DAY_MS;
}

function keyCounts(): AccessKeyList['counts'] {
  return {
    all: keys.length,
    active: keys.filter((key) => key.status === 'active').length,
    expiring: keys.filter(isExpiring).length,
    disabled: keys.filter((key) => key.status === 'disabled').length,
  };
}

/* -------------------------------- helpers -------------------------------- */

function problem(status: number, code: string, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: code, status, detail, code },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

const notFound = (detail: string) => problem(HTTP_NOT_FOUND, 'NOT_FOUND', detail);

function matchesQuery(haystack: readonly string[], query: string | null): boolean {
  if (query === null || query.length === 0) return true;
  const needle = query.toLowerCase();
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

function detailOf(entry: S3User): S3UserDetail {
  const inherited = groups
    .filter((group) => group.serverId === entry.serverId && group.members.includes(entry.name))
    .flatMap((group) => group.policies.map((policyName) => ({ policy: policyName, fromGroup: group.name })));
  return {
    ...entry,
    accessKeys: keys.filter((key) => key.serverId === entry.serverId && key.userName === entry.name),
    inheritedPolicies: inherited,
  };
}

function withKeyCount(entry: S3User): S3User {
  return {
    ...entry,
    accessKeyCount: keys.filter((key) => key.serverId === entry.serverId && key.userName === entry.name)
      .length,
  };
}

export const iamHandlers = [
  /* ------------------------------- users -------------------------------- */

  http.get(`${base}/iam/users`, ({ request }) => {
    const url = new URL(request.url);
    const serverId = url.searchParams.get('serverId');
    const query = url.searchParams.get('q');
    const status = url.searchParams.get('status');
    const filtered = users
      .map(withKeyCount)
      .filter((entry) => serverId === null || entry.serverId === serverId)
      .filter((entry) => status === null || entry.status === status)
      .filter((entry) => matchesQuery([entry.name, ...entry.policies, ...entry.groups], query));
    return HttpResponse.json({
      items: filtered,
      total: filtered.length,
      unavailable,
    } satisfies S3UserList);
  }),

  http.post(`${base}/servers/:sid/iam/users`, async ({ params, request }) => {
    const serverId = String(params.sid);
    const body = (await request.json()) as CreateS3UserRequest;
    if (users.some((entry) => entry.serverId === serverId && entry.name === body.name)) {
      return problem(HTTP_CONFLICT, 'CONFLICT', `${body.name} already exists on this server.`);
    }
    const created = user(serverId, body.name, 'enabled', body.policies, body.groups, 0, 0, null);
    users = [created, ...users];
    groups = groups.map((group) =>
      group.serverId === serverId && body.groups.includes(group.name)
        ? { ...group, members: [...group.members, body.name] }
        : group,
    );
    let key: CreatedKey | null = null;
    if (body.createAccessKey) {
      const newKey = accessKey(
        serverId,
        randomFrom(KEY_ID_ALPHABET, KEY_ID_LENGTH),
        body.name,
        body.name,
        'active',
        null,
        null,
      );
      keys = [newKey, ...keys];
      const server = mockServers.find((entry) => entry.id === serverId);
      key = {
        accessKey: newKey,
        secretAccessKey: randomFrom(SECRET_ALPHABET, SECRET_LENGTH),
        endpoint: server?.endpoint ?? 'http://localhost:9000',
        region: server?.region ?? 'us-east-1',
      };
    }
    return HttpResponse.json({ user: created, accessKey: key }, { status: HTTP_CREATED });
  }),

  http.get(`${base}/servers/:sid/iam/users/:name`, ({ params }) => {
    const entry = users.find(
      (candidate) => candidate.serverId === String(params.sid) && candidate.name === String(params.name),
    );
    return entry === undefined ? notFound('No such user.') : HttpResponse.json(detailOf(withKeyCount(entry)));
  }),

  http.patch(`${base}/servers/:sid/iam/users/:name`, async ({ params, request }) => {
    const body = (await request.json()) as UpdateS3UserRequest;
    let updated: S3User | undefined;
    users = users.map((entry) => {
      if (entry.serverId !== String(params.sid) || entry.name !== String(params.name)) return entry;
      updated = { ...entry, status: body.status };
      return updated;
    });
    return updated === undefined ? notFound('No such user.') : HttpResponse.json(detailOf(updated));
  }),

  http.put(`${base}/servers/:sid/iam/users/:name/policies`, async ({ params, request }) => {
    const body = (await request.json()) as SetUserPoliciesRequest;
    let updated: S3User | undefined;
    users = users.map((entry) => {
      if (entry.serverId !== String(params.sid) || entry.name !== String(params.name)) return entry;
      updated = { ...entry, policies: body.policies };
      return updated;
    });
    return updated === undefined ? notFound('No such user.') : HttpResponse.json(detailOf(updated));
  }),

  http.put(`${base}/servers/:sid/iam/users/:name/groups`, async ({ params, request }) => {
    const body = (await request.json()) as SetUserGroupsRequest;
    const name = String(params.name);
    const serverId = String(params.sid);
    let updated: S3User | undefined;
    users = users.map((entry) => {
      if (entry.serverId !== serverId || entry.name !== name) return entry;
      updated = { ...entry, groups: body.groups };
      return updated;
    });
    groups = groups.map((group) => {
      if (group.serverId !== serverId) return group;
      const shouldContain = body.groups.includes(group.name);
      const contains = group.members.includes(name);
      if (shouldContain === contains) return group;
      return {
        ...group,
        members: shouldContain
          ? [...group.members, name]
          : group.members.filter((member) => member !== name),
      };
    });
    return updated === undefined ? notFound('No such user.') : HttpResponse.json(detailOf(updated));
  }),

  http.delete(`${base}/servers/:sid/iam/users/:name`, ({ params }) => {
    const serverId = String(params.sid);
    const name = String(params.name);
    users = users.filter((entry) => !(entry.serverId === serverId && entry.name === name));
    keys = keys.filter((key) => !(key.serverId === serverId && key.userName === name));
    return new HttpResponse(null, { status: HTTP_NO_CONTENT });
  }),

  http.get(`${base}/iam/users/export.csv`, () => {
    const lines = ['serverName,provider,name,status,policies,groups,accessKeyCount'];
    for (const entry of users.map(withKeyCount)) {
      lines.push(
        [
          entry.serverName,
          entry.provider,
          entry.name,
          entry.status,
          entry.policies.join(' '),
          entry.groups.join(' '),
          String(entry.accessKeyCount),
        ].join(','),
      );
    }
    return new HttpResponse(lines.join('\n'), { headers: { 'content-type': 'text/csv' } });
  }),

  /* ------------------------------- groups ------------------------------- */

  http.get(`${base}/iam/groups`, ({ request }) => {
    const url = new URL(request.url);
    const serverId = url.searchParams.get('serverId');
    const query = url.searchParams.get('q');
    const filtered = groups
      .filter((group) => serverId === null || group.serverId === serverId)
      .filter((group) => matchesQuery([group.name, ...group.members], query));
    return HttpResponse.json({
      items: filtered,
      total: filtered.length,
      unavailable,
    } satisfies S3GroupList);
  }),

  http.post(`${base}/servers/:sid/iam/groups`, async ({ params, request }) => {
    const serverId = String(params.sid);
    const body = (await request.json()) as UpsertS3GroupRequest;
    if (groups.some((group) => group.serverId === serverId && group.name === body.name)) {
      return problem(HTTP_CONFLICT, 'CONFLICT', `${body.name} already exists on this server.`);
    }
    const created: S3Group = {
      id: iamGroupId(serverId, body.name),
      ...serverRef(serverId),
      name: body.name,
      members: body.members,
      policies: body.policies,
      status: body.status ?? 'enabled',
    };
    groups = [created, ...groups];
    users = users.map((entry) =>
      entry.serverId === serverId && body.members.includes(entry.name)
        ? { ...entry, groups: [...entry.groups, body.name] }
        : entry,
    );
    return HttpResponse.json(created, { status: HTTP_CREATED });
  }),

  http.patch(`${base}/servers/:sid/iam/groups/:name`, async ({ params, request }) => {
    const serverId = String(params.sid);
    const name = String(params.name);
    const body = (await request.json()) as UpsertS3GroupRequest;
    let updated: S3Group | undefined;
    groups = groups.map((group) => {
      if (group.serverId !== serverId || group.name !== name) return group;
      updated = {
        ...group,
        name: body.name,
        members: body.members,
        policies: body.policies,
        status: body.status ?? group.status,
      };
      return updated;
    });
    if (updated === undefined) return notFound('No such group.');
    const next = updated;
    users = users.map((entry) => {
      if (entry.serverId !== serverId) return entry;
      const shouldContain = next.members.includes(entry.name);
      const contains = entry.groups.includes(name);
      if (shouldContain === contains) return entry;
      return {
        ...entry,
        groups: shouldContain
          ? [...entry.groups, next.name]
          : entry.groups.filter((group) => group !== name),
      };
    });
    return HttpResponse.json(next);
  }),

  http.delete(`${base}/servers/:sid/iam/groups/:name`, ({ params }) => {
    const serverId = String(params.sid);
    const name = String(params.name);
    groups = groups.filter((group) => !(group.serverId === serverId && group.name === name));
    users = users.map((entry) =>
      entry.serverId === serverId
        ? { ...entry, groups: entry.groups.filter((group) => group !== name) }
        : entry,
    );
    return new HttpResponse(null, { status: HTTP_NO_CONTENT });
  }),

  /* ------------------------------ policies ------------------------------ */

  http.get(`${base}/iam/policies`, ({ request }) => {
    const url = new URL(request.url);
    const serverId = url.searchParams.get('serverId');
    const query = url.searchParams.get('q');
    const filtered = policies
      .filter((entry) => serverId === null || entry.serverId === serverId)
      .filter((entry) => matchesQuery([entry.name, entry.description ?? ''], query))
      .map(({ document: _document, versions: _versions, ...summary }) => summary);
    return HttpResponse.json({
      items: filtered,
      total: filtered.length,
      unavailable,
    } satisfies PolicyList);
  }),

  http.post(`${base}/iam/policies/validate`, async ({ request }) => {
    const body = (await request.json()) as ValidatePolicyRequest;
    const result = validatePolicyDocument(body.document);
    return HttpResponse.json({
      valid: result.valid,
      errors: [...result.errors],
      warnings: [...result.warnings],
    } satisfies ValidatePolicyResponse);
  }),

  http.post(`${base}/iam/policies/simulate`, async ({ request }) => {
    const body = (await request.json()) as SimulatePolicyRequest;
    const result = evaluatePolicy(body.document, {
      action: body.action,
      resource: body.resource,
      ...(body.context === undefined ? {} : { context: body.context }),
    });
    return HttpResponse.json({
      decision: result.decision,
      statementSid: result.statementSid,
      statementIndex: result.statementIndex,
    } satisfies SimulatePolicyResponse);
  }),

  http.get(`${base}/servers/:sid/iam/policies/:name/versions`, ({ params }) => {
    const entry = policies.find(
      (candidate) =>
        candidate.serverId === String(params.sid) && candidate.name === String(params.name),
    );
    if (entry === undefined) return notFound('No such policy.');
    return HttpResponse.json({ items: [...entry.versions] } satisfies PolicyVersionList);
  }),

  http.post(
    `${base}/servers/:sid/iam/policies/:name/versions/:vid/restore`,
    ({ params }) => {
      const serverId = String(params.sid);
      const name = String(params.name);
      const versionId = String(params.vid);
      let restored: PolicyRecord | undefined;
      policies = policies.map((entry) => {
        if (entry.serverId !== serverId || entry.name !== name) return entry;
        const version = entry.versions.find((candidate) => candidate.id === versionId);
        if (version === undefined) return entry;
        const next: PolicyRecord = {
          ...entry,
          document: version.document,
          updatedAt: new Date().toISOString(),
          versions: [
            {
              id: `${name}-v${String(entry.versions.length + 1)}`,
              createdAt: new Date().toISOString(),
              document: entry.document,
              note: 'Replaced by a restore',
            },
            ...entry.versions,
          ],
        };
        restored = next;
        return next;
      });
      if (restored === undefined) return notFound('No such policy version.');
      return HttpResponse.json(asDetail(restored));
    },
  ),

  http.get(`${base}/servers/:sid/iam/policies/:name`, ({ params }) => {
    const entry = policies.find(
      (candidate) =>
        candidate.serverId === String(params.sid) && candidate.name === String(params.name),
    );
    return entry === undefined ? notFound('No such policy.') : HttpResponse.json(asDetail(entry));
  }),

  http.put(`${base}/servers/:sid/iam/policies/:name`, async ({ params, request }) => {
    const serverId = String(params.sid);
    const name = String(params.name);
    const body = (await request.json()) as {
      document: Record<string, unknown>;
      description?: string;
    };
    const existing = policies.find(
      (candidate) => candidate.serverId === serverId && candidate.name === name,
    );
    if (existing?.builtIn === true) {
      return problem(HTTP_CONFLICT, 'CONFLICT', 'A built-in policy is read-only.');
    }
    if (existing === undefined) {
      const created: PolicyRecord = {
        id: iamPolicyId(serverId, name),
        ...serverRef(serverId),
        name,
        builtIn: false,
        description: body.description ?? null,
        attachedCount: 0,
        updatedAt: new Date().toISOString(),
        document: body.document,
        versions: [],
      };
      policies = [created, ...policies];
      return HttpResponse.json(asDetail(created));
    }
    const updated: PolicyRecord = {
      ...existing,
      description: body.description ?? existing.description,
      updatedAt: new Date().toISOString(),
      document: body.document,
      versions: [
        {
          id: `${name}-v${String(existing.versions.length + 1)}`,
          createdAt: new Date().toISOString(),
          document: existing.document,
          note: null,
        },
        ...existing.versions,
      ],
    };
    policies = policies.map((entry) => (entry === existing ? updated : entry));
    return HttpResponse.json(asDetail(updated));
  }),

  http.delete(`${base}/servers/:sid/iam/policies/:name`, ({ params }) => {
    const serverId = String(params.sid);
    const name = String(params.name);
    const existing = policies.find(
      (candidate) => candidate.serverId === serverId && candidate.name === name,
    );
    if (existing?.builtIn === true) {
      return problem(HTTP_CONFLICT, 'CONFLICT', 'A built-in policy cannot be deleted.');
    }
    policies = policies.filter((entry) => !(entry.serverId === serverId && entry.name === name));
    return new HttpResponse(null, { status: HTTP_NO_CONTENT });
  }),

  /* ---------------------------- access keys ----------------------------- */

  http.get(`${base}/iam/access-keys`, ({ request }) => {
    const url = new URL(request.url);
    const serverId = url.searchParams.get('serverId');
    const userName = url.searchParams.get('userName');
    const status = url.searchParams.get('status');
    const query = url.searchParams.get('q');
    const filtered = keys
      .filter((key) => serverId === null || key.serverId === serverId)
      .filter((key) => userName === null || key.userName === userName)
      .filter((key) => {
        if (status === null) return true;
        if (status === 'expiring') return isExpiring(key);
        return key.status === status;
      })
      .filter((key) => matchesQuery([key.accessKeyId, key.userName, key.name ?? ''], query));
    return HttpResponse.json({
      items: filtered,
      total: filtered.length,
      counts: keyCounts(),
      unavailable,
    } satisfies AccessKeyList);
  }),

  http.get(`${base}/iam/access-keys/export.csv`, () => {
    const lines = ['serverName,provider,accessKeyId,userName,name,status,createdAt,expiresAt'];
    for (const key of keys) {
      lines.push(
        [
          key.serverName,
          key.provider,
          key.accessKeyId,
          key.userName,
          key.name ?? '',
          key.status,
          key.createdAt ?? '',
          key.expiresAt ?? '',
        ].join(','),
      );
    }
    return new HttpResponse(lines.join('\n'), { headers: { 'content-type': 'text/csv' } });
  }),

  http.post(`${base}/servers/:sid/iam/access-keys`, async ({ params, request }) => {
    const serverId = String(params.sid);
    const body = (await request.json()) as CreateAccessKeyRequest;
    const created = accessKey(
      serverId,
      randomFrom(KEY_ID_ALPHABET, KEY_ID_LENGTH),
      body.userName,
      body.name,
      'active',
      body.expiresAt,
      null,
      body.policy !== null,
    );
    keys = [created, ...keys];
    const server = mockServers.find((entry) => entry.id === serverId);
    return HttpResponse.json(
      {
        accessKey: created,
        secretAccessKey: randomFrom(SECRET_ALPHABET, SECRET_LENGTH),
        endpoint: server?.endpoint ?? 'http://localhost:9000',
        region: server?.region ?? 'us-east-1',
      } satisfies CreatedKey,
      { status: HTTP_CREATED },
    );
  }),

  http.post(
    `${base}/servers/:sid/iam/access-keys/:accessKeyId/rotate`,
    async ({ params, request }) => {
      const serverId = String(params.sid);
      const oldId = String(params.accessKeyId);
      const body = (await request.json()) as RotateAccessKeyRequest;
      const old = keys.find((key) => key.serverId === serverId && key.accessKeyId === oldId);
      if (old === undefined) return notFound('No such access key.');
      const replacement = accessKey(
        serverId,
        randomFrom(KEY_ID_ALPHABET, KEY_ID_LENGTH),
        old.userName,
        old.name,
        'active',
        body.expiresAt,
        null,
        old.restricted,
      );
      keys = [
        replacement,
        ...keys.map((key) =>
          key.accessKeyId === oldId
            ? {
                ...key,
                status: body.graceSeconds === 0 ? ('disabled' as const) : key.status,
                rotation: {
                  replacedBy: replacement.accessKeyId,
                  disableAt: isoIn(body.graceSeconds * 1000),
                },
              }
            : key,
        ),
      ];
      const server = mockServers.find((entry) => entry.id === serverId);
      return HttpResponse.json({
        accessKey: replacement,
        secretAccessKey: randomFrom(SECRET_ALPHABET, SECRET_LENGTH),
        endpoint: server?.endpoint ?? 'http://localhost:9000',
        region: server?.region ?? 'us-east-1',
      } satisfies CreatedKey);
    },
  ),

  http.patch(`${base}/servers/:sid/iam/access-keys/:accessKeyId`, async ({ params, request }) => {
    const serverId = String(params.sid);
    const accessKeyId = String(params.accessKeyId);
    const body = (await request.json()) as UpdateAccessKeyRequest;
    let updated: AccessKey | undefined;
    keys = keys.map((key) => {
      if (key.serverId !== serverId || key.accessKeyId !== accessKeyId) return key;
      updated = {
        ...key,
        name: body.name ?? key.name,
        status: body.status ?? key.status,
        expiresAt: body.expiresAt === undefined ? key.expiresAt : body.expiresAt,
      };
      return updated;
    });
    return updated === undefined ? notFound('No such access key.') : HttpResponse.json(updated);
  }),

  http.delete(`${base}/servers/:sid/iam/access-keys/:accessKeyId`, ({ params }) => {
    const serverId = String(params.sid);
    const accessKeyId = String(params.accessKeyId);
    keys = keys.filter((key) => !(key.serverId === serverId && key.accessKeyId === accessKeyId));
    return new HttpResponse(null, { status: HTTP_NO_CONTENT });
  }),
];

function asDetail(entry: PolicyRecord): PolicyDetail {
  const attachedUsers = users
    .filter((candidate) => candidate.serverId === entry.serverId && candidate.policies.includes(entry.name))
    .map((candidate) => candidate.name);
  const attachedGroups = groups
    .filter((group) => group.serverId === entry.serverId && group.policies.includes(entry.name))
    .map((group) => group.name);
  return {
    id: entry.id,
    serverId: entry.serverId,
    serverName: entry.serverName,
    name: entry.name,
    builtIn: entry.builtIn,
    description: entry.description,
    attachedCount: attachedUsers.length + attachedGroups.length,
    updatedAt: entry.updatedAt,
    document: entry.document,
    attachedTo: { users: attachedUsers, groups: attachedGroups },
  };
}
