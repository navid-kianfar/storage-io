#!/usr/bin/env node
/**
 * storage-io — demo seed.
 *
 * Fills a *local development* installation with enough realistic data that
 * every page in the console has something on it: both dev storage servers,
 * a spread of buckets (versioned, quota'd, object-locked, one public-read),
 * varied objects under nested prefixes, S3 users / groups / policies / access
 * keys on MinIO, and two bulk jobs — one finished, one scheduled.
 *
 *   docker compose -f docker/docker-compose.dev.yml up -d
 *   pnpm dev                       # or just the API
 *   pnpm seed:demo
 *
 * It talks to the running API over HTTP exactly as the browser does — nothing
 * here reaches into the database or the S3 endpoints directly, so what it
 * creates is what the console would have created.
 *
 * **Idempotent.** Every step checks first and skips what exists, so running it
 * twice changes nothing. Re-running never duplicates a bucket, a user, a key or
 * a job, and an object is re-uploaded only when its size no longer matches.
 *
 * **Credentials.** The admin login comes from flags, then the environment, then
 * `apps/api/.env` — never from this file. The two storage servers are registered
 * with the fixed development credentials documented at the top of
 * `docker/docker-compose.dev.yml`; they exist so the integration tests can find
 * them and must never appear in a deployed environment. Every S3 user and access
 * key this script creates gets a random secret that is generated, sent once and
 * discarded: nothing prints a secret, and nothing writes one to disk.
 *
 * Node >= 22. No dependencies.
 *
 * Flags (each also readable from the environment):
 *   --api <url>             SIO_API_URL       default http://localhost:3000
 *   --username <name>       SIO_ADMIN_USERNAME / ADMIN_USERNAME
 *   --password <secret>     SIO_ADMIN_PASSWORD / ADMIN_PASSWORD
 *   --minio-endpoint <url>  SIO_MINIO_ENDPOINT     default http://localhost:9000
 *   --seaweed-endpoint <url> SIO_SEAWEED_ENDPOINT  default http://localhost:8333
 *   --seaweed-iam <url>     SIO_SEAWEED_IAM        default http://localhost:8111
 *   --skip-jobs             do not create or wait on bulk jobs
 *   --quiet
 *
 * Passing --password on the command line puts it in your shell history and in
 * the process list. Prefer the environment or apps/api/.env.
 */

import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * Arguments and configuration
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const flags = new Map();
  const bare = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      bare.add(arg.slice(2));
    }
  }
  return { flags, bare };
}

/** A deliberately small .env reader: `KEY=value`, optional quotes, `#` comments. */
function readDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const { flags, bare } = parseArgs(process.argv.slice(2));
const dotEnv = readDotEnv(join(REPO_ROOT, 'apps', 'api', '.env'));

const pick = (flag, ...envKeys) => {
  const fromFlag = flags.get(flag);
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag;
  for (const key of envKeys) {
    if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
    if (dotEnv[key] !== undefined && dotEnv[key] !== '') return dotEnv[key];
  }
  return undefined;
};

const CONFIG = {
  api: (pick('api', 'SIO_API_URL') ?? 'http://localhost:3000').replace(/\/+$/, ''),
  username: pick('username', 'SIO_ADMIN_USERNAME', 'ADMIN_USERNAME'),
  password: pick('password', 'SIO_ADMIN_PASSWORD', 'ADMIN_PASSWORD'),
  minioEndpoint: pick('minio-endpoint', 'SIO_MINIO_ENDPOINT') ?? 'http://localhost:9000',
  seaweedEndpoint: pick('seaweed-endpoint', 'SIO_SEAWEED_ENDPOINT') ?? 'http://localhost:8333',
  seaweedIam: pick('seaweed-iam', 'SIO_SEAWEED_IAM') ?? 'http://localhost:8111',
  skipJobs: bare.has('skip-jobs'),
  quiet: bare.has('quiet'),
};

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const counts = { created: 0, skipped: 0, warned: 0 };
const say = (...a) => {
  if (!CONFIG.quiet) console.log(...a);
};
const step = (m) => say(`\n\x1b[1m${m}\x1b[0m`);
const made = (m) => {
  counts.created += 1;
  say(`  \x1b[32m+\x1b[0m ${m}`);
};
const kept = (m) => {
  counts.skipped += 1;
  say(`  \x1b[2m·\x1b[0m ${m}`);
};
const warn = (m) => {
  counts.warned += 1;
  console.warn(`  \x1b[33m!\x1b[0m ${m}`);
};

/**
 * Every step runs inside this: a provider that cannot do something (SeaweedFS
 * has no groups, MinIO has no per-bucket CORS) must not stop the seed, or the
 * pages after it never get their data.
 */
async function attempt(label, fn) {
  try {
    return await fn();
  } catch (error) {
    warn(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * The API client
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, code, detail) {
    super(`${status}${code ? ` ${code}` : ''}: ${detail}`);
    this.status = status;
    this.code = code;
  }
}

class Api {
  #cookie = null;

  constructor(base) {
    this.base = base;
    this.prefix = `${base}/api/v1`;
    // A cookie-authenticated mutation must present an Origin the API serves on
    // (OriginGuard — CSRF defence). Same-origin is what a browser would send.
    this.origin = new URL(base).origin;
  }

  async login(username, password) {
    const res = await fetch(`${this.prefix}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.origin },
      body: JSON.stringify({ username, password, remember: false }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new ApiError(res.status, 'AUTH', detail.slice(0, 200));
    }
    const jar = res.headers.getSetCookie?.() ?? [];
    const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('sio_session='));
    if (session === undefined) throw new Error('login succeeded but set no session cookie');
    this.#cookie = session;
  }

  async request(method, path, { query, json, body, headers = {}, raw = false } = {}) {
    const url = new URL(path.startsWith('http') ? path : `${this.prefix}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const init = {
      method,
      headers: {
        accept: 'application/json',
        origin: this.origin,
        ...(this.#cookie ? { cookie: this.#cookie } : {}),
        ...headers,
      },
    };
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }

    const res = await fetch(url, init);
    if (res.status === 204) return null;

    const text = await res.text();
    let parsed;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const code = parsed && typeof parsed === 'object' ? parsed.code : undefined;
      const detail =
        parsed && typeof parsed === 'object' ? (parsed.detail ?? parsed.title) : String(parsed);
      throw new ApiError(res.status, code, String(detail).slice(0, 300));
    }
    return raw ? text : parsed;
  }

  get = (p, o) => this.request('GET', p, o);
  post = (p, o) => this.request('POST', p, o);
  put = (p, o) => this.request('PUT', p, o);
  patch = (p, o) => this.request('PATCH', p, o);
}

/** 404 is "not there", which is an answer; anything else is a real failure. */
async function orNull(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Content generators — everything below builds its bytes in-process, so the
 * repository carries no binary fixtures.
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A deterministic PRNG, so two runs produce byte-identical objects. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/**
 * A real, valid PNG: 8-bit truecolour, one IDAT, no interlacing. `shade(x, y)`
 * returns `[r, g, b]`. Small gradients compress to a few hundred bytes, which
 * is the point — the object browser needs a thumbnail, not a photograph.
 */
function png(width, height, shade) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0; // filter: none
    at += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = shade(x, y);
      raw[at] = r & 0xff;
      raw[at + 1] = g & 0xff;
      raw[at + 2] = b & 0xff;
      at += 3;
    }
  }

  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([head, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  // zlib wrapper by hand (deflateRawSync + the 2-byte header and Adler-32)
  // keeps this to one allocation and makes the framing visible.
  const deflated = deflateRawSync(raw, { level: 9 });
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i += 1) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  const zlibStream = Buffer.concat([Buffer.from([0x78, 0x9c]), deflated, adler]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStream),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A stored (method 0) ZIP. The archive preview reads the central directory. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const dos = { time: 0x6000, date: 0x5a2f }; // 12:00, 2025-01-15 — fixed, so runs match

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(dos.time, 10);
    local.writeUInt16LE(dos.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(dos.time, 12);
    dir.writeUInt16LE(dos.date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

const text = (s) => Buffer.from(s, 'utf8');

/** Incompressible-ish filler, for an object whose size is the point. */
function filler(bytes, seed) {
  const next = lcg(seed);
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 4) buf.writeUInt32LE(next(), Math.min(i, bytes - 4));
  return buf;
}

const gradient = (r0, g0, b0) => (x, y) => [
  (r0 + x * 3) % 256,
  (g0 + y * 5) % 256,
  (b0 + (x + y) * 2) % 256,
];

const checker = (a, b) => (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? a : b);

function logLines(day, count, seed) {
  const next = lcg(seed);
  const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
  const routes = ['/api/v1/buckets', '/api/v1/servers', '/api/v1/jobs', '/api/v1/iam/users'];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const n = next();
    const hh = String(Math.floor((i / count) * 24)).padStart(2, '0');
    const mm = String(n % 60).padStart(2, '0');
    const ss = String((n >> 6) % 60).padStart(2, '0');
    out.push(
      `${day}T${hh}:${mm}:${ss}Z ${levels[n % levels.length]} ` +
        `req=${(n >>> 8).toString(16).padStart(6, '0')} ` +
        `${routes[(n >> 3) % routes.length]} ${200 + (n % 5) * 100} ${n % 900}ms`,
    );
  }
  return text(`${out.join('\n')}\n`);
}

/* ------------------------------------------------------------------ *
 * The demo data
 * ------------------------------------------------------------------ */

const GiB = 1024 ** 3;

const SERVERS = [
  {
    key: 'minio',
    name: 'minio-dev',
    provider: 'minio',
    endpointFrom: () => CONFIG.minioEndpoint,
    region: 'us-east-1',
    accessKeyId: 'sio-dev-admin',
    // Development value, fixed in docker/docker-compose.dev.yml and read by the
    // integration tests. Not a secret, and never valid anywhere else.
    secretAccessKey: 'sio-dev-secret-key',
    options: () => ({
      pathStyle: true,
      tlsVerify: false,
      adminEndpoint: CONFIG.minioEndpoint,
      healthIntervalSec: 30,
    }),
  },
  {
    key: 'seaweedfs',
    name: 'seaweedfs-dev',
    provider: 'seaweedfs',
    endpointFrom: () => CONFIG.seaweedEndpoint,
    region: 'us-east-1',
    accessKeyId: 'sio-dev-seaweed',
    secretAccessKey: 'sio-dev-seaweed-secret',
    options: () => ({
      pathStyle: true,
      tlsVerify: false,
      iamEndpoint: CONFIG.seaweedIam,
      healthIntervalSec: 30,
    }),
  },
];

const BUCKETS = [
  {
    server: 'minio',
    name: 'media-assets',
    versioning: true,
    objectLock: false,
    quota: { limitBytes: 50 * GiB, mode: 'hard' },
    access: 'private',
    tags: { team: 'design', tier: 'hot' },
    lifecycle: [
      {
        id: 'expire-old-thumbnails',
        enabled: true,
        prefix: 'photos/thumbnails/',
        tags: {},
        expireDays: 90,
        noncurrentExpireDays: 30,
        abortMultipartDays: 7,
        transition: null,
        expiredDeleteMarkers: true,
      },
    ],
  },
  {
    server: 'minio',
    name: 'app-logs',
    versioning: false,
    objectLock: false,
    quota: { limitBytes: 10 * GiB, mode: 'alert' },
    access: 'private',
    tags: { team: 'platform', retention: '30d' },
    lifecycle: [
      {
        id: 'expire-logs',
        enabled: true,
        prefix: '',
        tags: {},
        expireDays: 30,
        noncurrentExpireDays: null,
        abortMultipartDays: 1,
        transition: null,
        expiredDeleteMarkers: false,
      },
    ],
  },
  {
    server: 'minio',
    name: 'public-downloads',
    versioning: false,
    objectLock: false,
    quota: null,
    access: 'public-read',
    tags: { team: 'release', visibility: 'public' },
  },
  {
    server: 'minio',
    name: 'analytics-exports',
    versioning: true,
    objectLock: false,
    quota: { limitBytes: 25 * GiB, mode: 'alert' },
    access: 'private',
    tags: { team: 'data' },
  },
  {
    server: 'minio',
    name: 'db-backups',
    versioning: true,
    // Object lock needs versioning and can only be set when the bucket is
    // created; a provider that refuses it is caught and the bucket is made
    // without it rather than skipped.
    objectLock: true,
    quota: { limitBytes: 200 * GiB, mode: 'hard' },
    access: 'private',
    tags: { team: 'platform', tier: 'cold', compliance: 'yes' },
  },
  {
    server: 'seaweedfs',
    name: 'edge-cache',
    versioning: false,
    objectLock: false,
    quota: { limitBytes: 20 * GiB, mode: 'alert' },
    access: 'private',
    tags: { team: 'edge' },
  },
  {
    server: 'seaweedfs',
    name: 'archive-cold',
    versioning: false,
    objectLock: false,
    quota: null,
    access: 'private',
    tags: { team: 'platform', tier: 'archive' },
  },
];

function demoObjects() {
  const readme = text(
    [
      '# Media assets',
      '',
      'Source images for the marketing site and the in-app illustrations.',
      '',
      '## Layout',
      '',
      '- `photos/<year>/<month>/` — full-size captures',
      '- `photos/thumbnails/` — generated, expired after 90 days by lifecycle',
      '- `vector/` — logos and icon sets',
      '',
      '> Versioning is on. Overwriting a file keeps the previous version; the',
      '> object browser shows them under **Versions**.',
      '',
    ].join('\n'),
  );

  const events = {
    generatedAt: '2026-01-31T23:59:59.000Z',
    window: { from: '2026-01-01', to: '2026-01-31' },
    totals: { sessions: 48213, uploads: 9127, downloads: 33481, bytes: 918273645 },
    topBuckets: [
      { bucket: 'media-assets', requests: 21044 },
      { bucket: 'public-downloads', requests: 18740 },
      { bucket: 'app-logs', requests: 6402 },
    ],
    errors: [
      { code: 'NoSuchKey', count: 118 },
      { code: 'AccessDenied', count: 27 },
      { code: 'SlowDown', count: 4 },
    ],
  };

  const csv = (month, seed) => {
    const next = lcg(seed);
    const rows = ['date,bucket,operation,objects,bytes'];
    for (let d = 1; d <= 28; d += 1) {
      const n = next();
      rows.push(
        `2026-${month}-${String(d).padStart(2, '0')},media-assets,PUT,${n % 400},${n % 90000000}`,
      );
    }
    return text(`${rows.join('\n')}\n`);
  };

  const logo = text(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-label="storage-io">',
      '  <rect width="96" height="96" rx="20" fill="#0f172a"/>',
      '  <ellipse cx="48" cy="30" rx="26" ry="10" fill="none" stroke="#38bdf8" stroke-width="5"/>',
      '  <path d="M22 30v36c0 5.5 11.6 10 26 10s26-4.5 26-10V30" fill="none" stroke="#38bdf8" stroke-width="5"/>',
      '  <path d="M22 48c0 5.5 11.6 10 26 10s26-4.5 26-10" fill="none" stroke="#38bdf8" stroke-width="5"/>',
      '</svg>',
      '',
    ].join('\n'),
  );

  const icons = text(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 48">',
      '  <g fill="none" stroke="#64748b" stroke-width="4" stroke-linecap="round">',
      '    <path d="M12 24h24M24 12v24"/>',
      '    <circle cx="72" cy="24" r="12"/>',
      '    <rect x="108" y="12" width="24" height="24" rx="4"/>',
      '    <path d="M156 12l12 12-12 12"/>',
      '  </g>',
      '</svg>',
      '',
    ].join('\n'),
  );

  const releaseNotes = text(
    [
      '# storage-io 0.1.0',
      '',
      'First public release.',
      '',
      '- One console for MinIO, SeaweedFS, Ceph RGW, Garage, AWS S3, R2 and Wasabi',
      '- Buckets, objects, versions, quotas and lifecycle',
      '- S3 users, groups, policies and access keys',
      '- Bulk jobs with schedules, pause/resume and a per-job log',
      '',
      'See the checksums file next to this one before you unpack anything.',
      '',
    ].join('\n'),
  );

  const bundle = zip([
    { name: 'storage-io/README.md', data: releaseNotes },
    {
      name: 'storage-io/LICENSE',
      data: text('MIT License\n\nCopyright (c) 2026 storage-io contributors\n'),
    },
    { name: 'storage-io/config/example.env', data: text('ADMIN_USERNAME=admin\nAPP_SECRET=\n') },
    { name: 'storage-io/bin/storage-io', data: filler(64 * 1024, 7) },
  ]);

  const quarterly = zip([
    { name: 'q4/summary.md', data: text('# Q4 2025\n\nArchived from analytics-exports.\n') },
    { name: 'q4/raw/events.json', data: text(`${JSON.stringify(events, null, 2)}\n`) },
  ]);

  return [
    // media-assets — images, vectors, markdown, nested prefixes
    { bucket: 'media-assets', key: 'README.md', type: 'text/markdown', data: readme, versions: 3 },
    {
      bucket: 'media-assets',
      key: 'photos/2026/01/sunrise.png',
      type: 'image/png',
      data: png(256, 160, gradient(240, 120, 40)),
    },
    {
      bucket: 'media-assets',
      key: 'photos/2026/01/harbour.png',
      type: 'image/png',
      data: png(256, 160, gradient(20, 90, 180)),
    },
    {
      bucket: 'media-assets',
      key: 'photos/2026/02/market.png',
      type: 'image/png',
      data: png(320, 200, gradient(120, 200, 90)),
    },
    {
      bucket: 'media-assets',
      key: 'photos/thumbnails/sunrise-thumb.png',
      type: 'image/png',
      data: png(64, 40, gradient(240, 120, 40)),
    },
    {
      bucket: 'media-assets',
      key: 'photos/thumbnails/harbour-thumb.png',
      type: 'image/png',
      data: png(64, 40, gradient(20, 90, 180)),
    },
    { bucket: 'media-assets', key: 'vector/logo.svg', type: 'image/svg+xml', data: logo },
    { bucket: 'media-assets', key: 'vector/icon-set.svg', type: 'image/svg+xml', data: icons },
    {
      bucket: 'media-assets',
      key: 'raw/camera-dump.bin',
      type: 'application/octet-stream',
      data: filler(2 * 1024 * 1024, 11),
    },

    // app-logs — plain text under nested prefixes
    {
      bucket: 'app-logs',
      key: 'app/2026-01-14.log',
      type: 'text/plain',
      data: logLines('2026-01-14', 400, 21),
    },
    {
      bucket: 'app-logs',
      key: 'app/2026-01-15.log',
      type: 'text/plain',
      data: logLines('2026-01-15', 400, 22),
    },
    {
      bucket: 'app-logs',
      key: 'app/2026-01-16.log',
      type: 'text/plain',
      data: logLines('2026-01-16', 400, 23),
    },
    {
      bucket: 'app-logs',
      key: 'nginx/access-2026-01-15.log',
      type: 'text/plain',
      data: logLines('2026-01-15', 900, 24),
    },
    {
      bucket: 'app-logs',
      key: 'nginx/error-2026-01-15.log',
      type: 'text/plain',
      data: logLines('2026-01-15', 60, 25),
    },

    // public-downloads — the public-read bucket
    { bucket: 'public-downloads', key: 'index.md', type: 'text/markdown', data: releaseNotes },
    {
      bucket: 'public-downloads',
      key: 'releases/v0.1.0/storage-io-0.1.0.zip',
      type: 'application/zip',
      data: bundle,
    },
    {
      bucket: 'public-downloads',
      key: 'releases/v0.1.0/checksums.txt',
      type: 'text/plain',
      data: text(`${crc32(bundle).toString(16)}  storage-io-0.1.0.zip\n`),
    },
    {
      bucket: 'public-downloads',
      key: 'releases/v0.1.0/logo.svg',
      type: 'image/svg+xml',
      data: logo,
    },

    // analytics-exports — JSON and CSV
    {
      bucket: 'analytics-exports',
      key: 'exports/2026/01/events.json',
      type: 'application/json',
      data: text(`${JSON.stringify(events, null, 2)}\n`),
      versions: 2,
    },
    {
      bucket: 'analytics-exports',
      key: 'exports/2026/01/usage.csv',
      type: 'text/csv',
      data: csv('01', 31),
    },
    {
      bucket: 'analytics-exports',
      key: 'exports/2026/02/usage.csv',
      type: 'text/csv',
      data: csv('02', 32),
    },
    {
      bucket: 'analytics-exports',
      key: 'schema/events.schema.json',
      type: 'application/json',
      data: text(
        `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'event', type: 'object', required: ['at', 'kind'], properties: { at: { type: 'string', format: 'date-time' }, kind: { type: 'string' }, bucket: { type: 'string' } } }, null, 2)}\n`,
      ),
    },

    // db-backups — the few megabytes
    {
      bucket: 'db-backups',
      key: 'nightly/2026-01-15/pg-dump.bin',
      type: 'application/octet-stream',
      data: filler(3 * 1024 * 1024, 41),
    },
    {
      bucket: 'db-backups',
      key: 'nightly/2026-01-16/pg-dump.bin',
      type: 'application/octet-stream',
      data: filler(3 * 1024 * 1024, 42),
    },
    {
      bucket: 'db-backups',
      key: 'nightly/2026-01-16/manifest.json',
      type: 'application/json',
      data: text(
        `${JSON.stringify({ takenAt: '2026-01-16T03:00:00.000Z', database: 'storage_io', sizeBytes: 3 * 1024 * 1024, engine: 'postgres 17' }, null, 2)}\n`,
      ),
    },

    // seaweedfs
    {
      bucket: 'edge-cache',
      key: 'manifest.json',
      type: 'application/json',
      data: text(
        `${JSON.stringify({ zoom: [8, 9, 10], updatedAt: '2026-01-20T10:00:00.000Z', tiles: 3 }, null, 2)}\n`,
      ),
    },
    {
      bucket: 'edge-cache',
      key: 'tiles/z10/x512/y340.png',
      type: 'image/png',
      data: png(128, 128, checker([30, 41, 59], [51, 65, 85])),
    },
    {
      bucket: 'edge-cache',
      key: 'tiles/z10/x512/y341.png',
      type: 'image/png',
      data: png(128, 128, checker([56, 189, 248], [14, 116, 144])),
    },
    {
      bucket: 'archive-cold',
      key: '2025/q4/report.md',
      type: 'text/markdown',
      data: text('# Q4 2025 storage report\n\nArchived from `analytics-exports`. Read-only.\n'),
    },
    { bucket: 'archive-cold', key: '2025/q4/bundle.zip', type: 'application/zip', data: quarterly },
  ];
}

const POLICIES = [
  {
    name: 'sio-demo-readonly',
    description: 'Read every bucket and object, change nothing.',
    document: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ReadEverything',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
          Resource: ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'],
        },
      ],
    },
  },
  {
    name: 'sio-demo-media-writer',
    description: 'Full access to media-assets, read-only elsewhere.',
    document: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'MediaFullAccess',
          Effect: 'Allow',
          Action: ['s3:*'],
          Resource: ['arn:aws:s3:::media-assets', 'arn:aws:s3:::media-assets/*'],
        },
        {
          Sid: 'ListOthers',
          Effect: 'Allow',
          Action: ['s3:ListBucket', 's3:GetBucketLocation'],
          Resource: ['arn:aws:s3:::*'],
        },
        {
          Sid: 'NeverTouchBackups',
          Effect: 'Deny',
          Action: ['s3:*'],
          Resource: ['arn:aws:s3:::db-backups', 'arn:aws:s3:::db-backups/*'],
        },
      ],
    },
  },
  {
    name: 'sio-demo-logs-reader',
    description: 'Read app-logs only.',
    document: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ReadLogs',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: ['arn:aws:s3:::app-logs', 'arn:aws:s3:::app-logs/*'],
        },
      ],
    },
  },
];

const GROUPS = [
  {
    name: 'sio-demo-developers',
    members: ['demo-alice', 'demo-ci'],
    policies: ['sio-demo-media-writer'],
  },
  { name: 'sio-demo-auditors', members: ['demo-bob'], policies: ['sio-demo-readonly'] },
];

const USERS = [
  { name: 'demo-alice', policies: ['sio-demo-media-writer'] },
  { name: 'demo-bob', policies: ['sio-demo-readonly'] },
  { name: 'demo-carol', policies: ['sio-demo-logs-reader'] },
  { name: 'demo-ci', policies: ['sio-demo-media-writer'] },
];

const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

const ACCESS_KEYS = [
  { userName: 'demo-ci', name: 'ci-pipeline', expiresAt: null, policy: null },
  { userName: 'demo-alice', name: 'alice-laptop', expiresAt: inDays(11), policy: null },
  {
    userName: 'demo-bob',
    name: 'bob-audit-readonly',
    expiresAt: inDays(120),
    // A session policy: narrower than the user's own permissions, which is what
    // makes the key show as "restricted" in the console.
    policy: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: ['arn:aws:s3:::analytics-exports', 'arn:aws:s3:::analytics-exports/*'],
        },
      ],
    },
  },
];

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

async function ensureServers(api) {
  step('Storage servers');
  const existing = await api.get('/servers');
  const byName = new Map((existing.items ?? []).map((s) => [s.name, s]));
  const resolved = {};

  for (const spec of SERVERS) {
    const found = byName.get(spec.name);
    if (found !== undefined) {
      resolved[spec.key] = found;
      kept(`${spec.name} (${spec.provider}) already registered`);
      continue;
    }
    const created = await attempt(`register ${spec.name}`, () =>
      api.post('/servers', {
        json: {
          name: spec.name,
          provider: spec.provider,
          endpoint: spec.endpointFrom(),
          region: spec.region,
          accessKeyId: spec.accessKeyId,
          secretAccessKey: spec.secretAccessKey,
          options: spec.options(),
        },
      }),
    );
    if (created === undefined) continue;
    resolved[spec.key] = created;
    made(`${spec.name} → ${spec.endpointFrom()}`);
  }

  // One health check now, so the overview and the servers list have a status
  // and a latency instead of "never checked".
  for (const server of Object.values(resolved)) {
    await attempt(`health check ${server.name}`, () => api.post(`/servers/${server.id}/check`));
  }

  return resolved;
}

async function ensureBuckets(api, servers) {
  step('Buckets');
  const byServer = new Map();
  for (const [key, server] of Object.entries(servers)) {
    const list = await attempt(`list buckets on ${server.name}`, () =>
      api.get('/buckets', { query: { serverId: server.id, pageSize: 500 } }),
    );
    byServer.set(key, new Map((list?.items ?? []).map((b) => [b.name, b])));
  }

  const resolved = new Map();

  for (const spec of BUCKETS) {
    const server = servers[spec.server];
    if (server === undefined) continue;
    const known = byServer.get(spec.server);

    let bucket = known?.get(spec.name);
    if (bucket !== undefined) {
      kept(`${server.name}/${spec.name}`);
    } else {
      const body = {
        name: spec.name,
        versioning: spec.versioning,
        objectLock: spec.objectLock,
        quota: spec.quota,
        access: spec.access,
      };
      bucket = await attempt(`create ${spec.name}`, () =>
        api.post(`/servers/${server.id}/buckets`, { json: body }),
      );
      // Object lock is set at creation and several providers refuse it. Losing
      // the bucket over it is worse than losing the lock.
      if (bucket === undefined && spec.objectLock) {
        bucket = await attempt(`create ${spec.name} without object lock`, () =>
          api.post(`/servers/${server.id}/buckets`, { json: { ...body, objectLock: false } }),
        );
      }
      if (bucket === undefined) continue;
      made(`${server.name}/${spec.name}${spec.access === 'public-read' ? ' (public-read)' : ''}`);
    }

    resolved.set(spec.name, { ...bucket, serverId: server.id, serverKey: spec.server });

    const base = `/servers/${server.id}/buckets/${encodeURIComponent(spec.name)}`;
    if (spec.tags !== undefined) {
      await attempt(`tags on ${spec.name}`, () =>
        api.put(`${base}/tags`, { json: { tags: spec.tags } }),
      );
    }
    if (spec.lifecycle !== undefined) {
      await attempt(`lifecycle on ${spec.name}`, () =>
        api.put(`${base}/lifecycle`, { json: { rules: spec.lifecycle } }),
      );
    }
  }

  return resolved;
}

async function uploadObjects(api, buckets) {
  step('Objects');
  let uploaded = 0;

  for (const item of demoObjects()) {
    const bucket = buckets.get(item.bucket);
    if (bucket === undefined) continue;

    const base = `/servers/${bucket.serverId}/buckets/${encodeURIComponent(item.bucket)}/objects`;
    const meta = await attempt(`head ${item.bucket}/${item.key}`, () =>
      orNull(api.get(`${base}/meta`, { query: { key: item.key } })),
    );

    if (meta !== undefined && meta !== null && meta.size === item.data.length) {
      counts.skipped += 1;
      continue;
    }

    // `versions` writes the same key more than once on a versioned bucket, so
    // the object browser's Versions tab has a history to show. It runs only on
    // the first pass — the size check above short-circuits every later run.
    const writes = meta === null ? (item.versions ?? 1) : 1;
    let ok = true;
    for (let i = 0; i < writes; i += 1) {
      const body =
        writes > 1 && i < writes - 1
          ? Buffer.concat([item.data, text(`\n<!-- revision ${i + 1} -->\n`)])
          : item.data;
      const result = await attempt(`upload ${item.bucket}/${item.key}`, () =>
        api.put(`${base}/upload`, {
          query: { key: item.key, overwrite: true },
          body,
          headers: { 'content-type': item.type, 'content-length': String(body.length) },
        }),
      );
      if (result === undefined) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    uploaded += 1;
    counts.created += 1;
    say(
      `  \x1b[32m+\x1b[0m ${item.bucket}/${item.key} ` +
        `\x1b[2m(${(item.data.length / 1024).toFixed(1)} KiB${writes > 1 ? `, ${writes} versions` : ''})\x1b[0m`,
    );
  }

  if (uploaded === 0) say('  \x1b[2m· every demo object is already in place\x1b[0m');
}

async function ensureIam(api, servers) {
  step('S3 users, groups, policies and access keys (MinIO)');
  const server = servers.minio;
  if (server === undefined) {
    warn('MinIO is not registered — skipping IAM');
    return;
  }
  const sid = server.id;

  const policies = await attempt('list policies', () =>
    api.get('/iam/policies', { query: { serverId: sid } }),
  );
  const knownPolicies = new Set((policies?.items ?? []).map((p) => p.name));
  for (const policy of POLICIES) {
    if (knownPolicies.has(policy.name)) {
      kept(`policy ${policy.name}`);
      continue;
    }
    const done = await attempt(`policy ${policy.name}`, () =>
      api.put(`/servers/${sid}/iam/policies/${encodeURIComponent(policy.name)}`, {
        json: { document: policy.document, description: policy.description },
      }),
    );
    if (done !== undefined) made(`policy ${policy.name}`);
  }

  const users = await attempt('list users', () =>
    api.get('/iam/users', { query: { serverId: sid, pageSize: 200 } }),
  );
  const knownUsers = new Set((users?.items ?? []).map((u) => u.name));
  for (const user of USERS) {
    if (knownUsers.has(user.name)) {
      kept(`user ${user.name}`);
      continue;
    }
    // A random secret, generated here, sent once and dropped. Nothing prints it
    // and nothing writes it down — these accounts exist to populate a screen.
    const secret = randomBytes(24).toString('base64url');
    const done = await attempt(`user ${user.name}`, () =>
      api.post(`/servers/${sid}/iam/users`, {
        json: {
          name: user.name,
          secret,
          policies: user.policies,
          groups: [],
          createAccessKey: false,
        },
      }),
    );
    if (done !== undefined) made(`user ${user.name} (${user.policies.join(', ')})`);
  }

  const groups = await attempt('list groups', () =>
    api.get('/iam/groups', { query: { serverId: sid } }),
  );
  const knownGroups = new Set((groups?.items ?? []).map((g) => g.name));
  for (const group of GROUPS) {
    if (knownGroups.has(group.name)) {
      kept(`group ${group.name}`);
      continue;
    }
    const done = await attempt(`group ${group.name}`, () =>
      api.post(`/servers/${sid}/iam/groups`, {
        json: { name: group.name, members: group.members, policies: group.policies },
      }),
    );
    if (done !== undefined) made(`group ${group.name} (${group.members.length} members)`);
  }

  const keys = await attempt('list access keys', () =>
    api.get('/iam/access-keys', { query: { serverId: sid, pageSize: 200 } }),
  );
  const knownKeys = new Set((keys?.items ?? []).map((k) => k.name).filter(Boolean));
  for (const key of ACCESS_KEYS) {
    if (knownKeys.has(key.name)) {
      kept(`access key ${key.name}`);
      continue;
    }
    const created = await attempt(`access key ${key.name}`, () =>
      api.post(`/servers/${sid}/iam/access-keys`, {
        json: {
          userName: key.userName,
          name: key.name,
          expiresAt: key.expiresAt,
          policy: key.policy,
        },
      }),
    );
    if (created === undefined) continue;
    // `created.secretAccessKey` is the one-time secret. It is deliberately not
    // logged, stored or returned from this function.
    made(`access key ${key.name} for ${key.userName}${key.policy ? ' (restricted)' : ''}`);
  }

  // One disabled user, so the users list is not uniformly green.
  await attempt('disable demo-carol', () =>
    api.patch(`/servers/${sid}/iam/users/${encodeURIComponent('demo-carol')}`, {
      json: { status: 'disabled' },
    }),
  );
}

async function ensureSeaweedUsers(api, servers) {
  const server = servers.seaweedfs;
  if (server === undefined) return;
  step('S3 users (SeaweedFS)');
  const users = await attempt('list users', () =>
    api.get('/iam/users', { query: { serverId: server.id, pageSize: 200 } }),
  );
  if (users === undefined) return;
  const known = new Set((users.items ?? []).map((u) => u.name));

  for (const name of ['demo-edge-writer', 'demo-edge-reader']) {
    if (known.has(name)) {
      kept(`user ${name}`);
      continue;
    }
    const done = await attempt(`user ${name}`, () =>
      api.post(`/servers/${server.id}/iam/users`, {
        json: { name, secret: null, policies: [], groups: [], createAccessKey: true },
      }),
    );
    if (done !== undefined) made(`user ${name}`);
  }
}

async function ensureJobs(api, servers, buckets) {
  step('Bulk jobs');
  if (CONFIG.skipJobs) {
    kept('--skip-jobs');
    return;
  }

  const minio = servers.minio;
  if (minio === undefined) {
    warn('MinIO is not registered — skipping jobs');
    return;
  }

  const seen = new Set();
  for (const view of ['active', 'scheduled', 'history']) {
    const list = await attempt(`list ${view} jobs`, () => api.get('/jobs', { query: { view } }));
    for (const job of list?.items ?? []) seen.add(job.name);
  }

  const filters = {
    prefix: '',
    modifiedAfter: null,
    modifiedBefore: null,
    minSize: null,
    maxSize: null,
    glob: null,
    tags: {},
  };

  // 1. One that runs now and finishes — tagging is cheap and touches only
  //    metadata, so the demo data itself is unchanged.
  const tagJobName = 'Tag January photos as reviewed';
  if (seen.has(tagJobName)) {
    kept(tagJobName);
  } else if (buckets.has('media-assets')) {
    const job = await attempt('create the tag job', () =>
      api.post('/jobs', {
        json: {
          name: tagJobName,
          type: 'tag',
          source: {
            serverId: minio.id,
            bucket: 'media-assets',
            filters: { ...filters, prefix: 'photos/2026/01/' },
          },
          params: { tags: { reviewed: '2026-01', owner: 'design' } },
          options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
          schedule: { kind: 'now' },
        },
      }),
    );
    if (job !== undefined) {
      made(`${tagJobName} (${job.status})`);
      await waitForJob(api, job.id);
    }
  }

  // 2. One that stays scheduled, so the Scheduled tab and the run history have
  //    something. A cron schedule never runs itself — it spawns a child run.
  const backupJobName = 'Nightly backup copy to cold archive';
  if (seen.has(backupJobName)) {
    kept(backupJobName);
  } else if (buckets.has('db-backups') && buckets.has('archive-cold')) {
    const target = buckets.get('archive-cold');
    const job = await attempt('create the scheduled copy job', () =>
      api.post('/jobs', {
        json: {
          name: backupJobName,
          type: 'copy',
          source: {
            serverId: minio.id,
            bucket: 'db-backups',
            filters: { ...filters, prefix: 'nightly/' },
          },
          target: { serverId: target.serverId, bucket: 'archive-cold', prefix: 'db/' },
          params: {},
          options: { conflict: 'skip', concurrency: 2, dryRun: false },
          schedule: { kind: 'cron', cron: '0 3 * * *', timezone: 'UTC', enabled: true },
        },
      }),
    );
    if (job !== undefined)
      made(`${backupJobName} (${job.status}, next ${job.schedule?.nextRunAt ?? '—'})`);
  }
}

async function waitForJob(api, id, timeoutMs = 90_000) {
  const terminal = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await attempt(`poll job ${id}`, () => api.get(`/jobs/${id}`));
    if (job === undefined) return;
    if (terminal.has(job.status)) {
      say(`    \x1b[2m→ finished as ${job.status} (${job.progress.processed} processed)\x1b[0m`);
      return;
    }
  }
  warn(`job ${id} did not finish within ${timeoutMs / 1000}s — is JOB_ENGINE_ENABLED off?`);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main() {
  if (CONFIG.username === undefined || CONFIG.password === undefined) {
    console.error(
      [
        'Admin credentials not found.',
        '',
        'Set them in apps/api/.env (ADMIN_USERNAME / ADMIN_PASSWORD), export',
        'SIO_ADMIN_USERNAME and SIO_ADMIN_PASSWORD, or pass --username / --password.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const api = new Api(CONFIG.api);

  step(`storage-io demo seed → ${CONFIG.api}`);
  const health = await attempt('reach the API', () => api.get(`${CONFIG.api}/health`));
  if (health === undefined) {
    console.error(
      `\nThe API at ${CONFIG.api} did not answer /health. Start it with \`pnpm dev\` first.`,
    );
    process.exitCode = 1;
    return;
  }
  say(`  API ${health.status}, version ${health.version}`);

  try {
    await api.login(CONFIG.username, CONFIG.password);
  } catch (error) {
    console.error(`\nLogin failed as "${CONFIG.username}": ${error.message}`);
    process.exitCode = 1;
    return;
  }
  say(`  signed in as ${CONFIG.username}`);

  const servers = await ensureServers(api);
  if (Object.keys(servers).length === 0) {
    console.error(
      '\nNo storage server could be registered. Are the dev containers up?\n' +
        '  docker compose -f docker/docker-compose.dev.yml up -d',
    );
    process.exitCode = 1;
    return;
  }

  const buckets = await ensureBuckets(api, servers);
  await uploadObjects(api, buckets);
  await ensureIam(api, servers);
  await ensureSeaweedUsers(api, servers);
  await ensureJobs(api, servers, buckets);

  step('Done');
  say(`  ${counts.created} created, ${counts.skipped} already present, ${counts.warned} warnings`);
  if (counts.warned > 0) {
    say('  Warnings above are usually a capability the provider does not have.');
  }
  say(`\n  Open the console and look around: ${CONFIG.api.replace(':3000', ':5173')}\n`);
}

main().catch((error) => {
  console.error(`\nseed-demo failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
