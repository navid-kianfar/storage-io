import { lookup } from 'node:dns/promises';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect, type PeerCertificate } from 'node:tls';
import { Injectable, Logger } from '@nestjs/common';
import type { CapabilityMap, CheckResult, TestServerResponse } from '@storage-io/contracts';
import { S3ProbeService } from './s3/s3-probe.service';
import { ProviderRegistryService } from './provider-registry.service';
import type { ServerConnection } from './provider-driver';

const TCP_TIMEOUT_MS = 4_000;
const TLS_TIMEOUT_MS = 6_000;
/** Warn when a certificate expires within this window. */
const CERT_EXPIRY_WARN_DAYS = 30;

/**
 * The connection test behind `POST /servers/test` and `POST /servers/:id/test`.
 *
 * It runs the checks in dependency order and **stops running the dependent ones**
 * once a prerequisite fails: an unresolvable hostname makes every later check
 * meaningless, and nine identical timeouts tell an operator nothing that the
 * first one did not. Skipped checks come back as `skipped` rather than
 * disappearing, so the UI shows the same nine rows every time.
 *
 * The checks, in order:
 *
 * | id           | asks                                                    |
 * |--------------|---------------------------------------------------------|
 * | dns          | does the endpoint host resolve?                         |
 * | tcp          | does the port accept a connection?                      |
 * | tls          | is the certificate valid, and how long until it expires? |
 * | auth         | do the credentials sign a request the server accepts?    |
 * | listBuckets  | can we enumerate buckets?                                |
 * | admin        | is the provider's admin API reachable? (per driver)      |
 * | versioning   | does the server implement bucket versioning?             |
 * | objectLock   | does it implement object lock?                            |
 * | replication  | does it implement replication?                            |
 */
@Injectable()
export class ConnectionTesterService {
  private readonly logger = new Logger(ConnectionTesterService.name);

  constructor(
    private readonly registry: ProviderRegistryService,
    private readonly probes: S3ProbeService,
  ) {}

  async test(connection: ServerConnection, transient: boolean): Promise<TestServerResponse> {
    const driver = this.registry.driverFor(connection.provider);
    const url = new URL(connection.endpoint);
    const isTls = url.protocol === 'https:';
    const port = portOf(url);

    const checks: CheckResult[] = [];

    const dns = await timed('dns', 'DNS resolution', async () => {
      const resolved = await lookup(url.hostname);
      return `${url.hostname} → ${resolved.address}`;
    });
    checks.push(dns);

    if (dns.status === 'fail') {
      checks.push(
        ...skipRest([
          'tcp',
          'tls',
          'auth',
          'listBuckets',
          'admin',
          'versioning',
          'objectLock',
          'replication',
        ]),
      );
      return this.assemble(checks, driver.baseCapabilities, null, null);
    }

    const tcp = await timed('tcp', `TCP connect to ${url.hostname}:${port}`, async () => {
      await tcpReachable(url.hostname, port);
      return 'Connection accepted';
    });
    checks.push(tcp);

    if (tcp.status === 'fail') {
      checks.push(
        ...skipRest([
          'tls',
          'auth',
          'listBuckets',
          'admin',
          'versioning',
          'objectLock',
          'replication',
        ]),
      );
      return this.assemble(checks, driver.baseCapabilities, null, null);
    }

    checks.push(
      isTls
        ? await this.checkCertificate(url.hostname, port, connection)
        : skipped('tls', 'TLS certificate', 'The endpoint is plain HTTP'),
    );

    // Authentication and bucket listing are the same call: a signed request that
    // comes back with a bucket list has proved both.
    const client = transient
      ? this.registry.transientClient(connection)
      : driver.createS3Client(connection);

    let buckets: readonly string[] | null = null;
    const auth = await timed('auth', 'Authenticate (SigV4)', async () => {
      buckets = await this.probes.listBuckets(client);
      return 'Credentials accepted';
    });
    checks.push(auth);

    if (auth.status === 'fail') {
      checks.push(...skipRest(['listBuckets', 'admin', 'versioning', 'objectLock', 'replication']));
      return this.assemble(checks, driver.baseCapabilities, null, null);
    }

    const bucketNames = buckets ?? [];
    checks.push({
      id: 'listBuckets',
      label: 'List buckets',
      status: 'ok',
      detail: `${bucketNames.length} bucket(s)`,
      durationMs: 0,
    });

    const probeBucket = this.probes.pickProbeBucket(bucketNames);

    // The driver's own checks (MinIO's admin API, Garage's admin token, …).
    const driverChecks =
      driver.additionalChecks === undefined ? [] : await driver.additionalChecks(connection);
    checks.push(
      ...(driverChecks.length > 0
        ? driverChecks
        : [skipped('admin', 'Admin API', 'This provider has no admin API')]),
    );

    if (probeBucket === null) {
      // Honest: with no bucket there is nothing to ask these questions about.
      checks.push(
        skipped('versioning', 'Versioning support', 'No bucket to probe'),
        skipped('objectLock', 'Object lock support', 'No bucket to probe'),
        skipped('replication', 'Replication support', 'No bucket to probe'),
      );
      const capabilities = await driver.detectCapabilities(connection, {
        client,
        probeBucket: null,
      });
      return this.assemble(
        checks,
        capabilities,
        await this.version(connection),
        bucketNames.length,
      );
    }

    const [versioning, objectLock, replication] = await Promise.all([
      this.probes.probeVersioning(client, probeBucket),
      this.probes.probeObjectLock(client, probeBucket),
      this.probes.probeReplication(client, probeBucket),
    ]);

    checks.push(
      probeCheck('versioning', 'Versioning support', versioning.state, versioning.detail),
      probeCheck('objectLock', 'Object lock support', objectLock.state, objectLock.detail),
      probeCheck('replication', 'Replication support', replication.state, replication.detail),
    );

    const capabilities = await driver.detectCapabilities(connection, { client, probeBucket });
    return this.assemble(checks, capabilities, await this.version(connection), bucketNames.length);
  }

  /**
   * TLS is checked with its own handshake rather than inferred from an S3 call,
   * because the certificate's expiry date is the useful part and the SDK does not
   * surface it. `rejectUnauthorized` follows the server's own setting, so a
   * deliberately self-signed lab certificate warns instead of failing.
   */
  private async checkCertificate(
    hostname: string,
    port: number,
    connection: ServerConnection,
  ): Promise<CheckResult> {
    const started = Date.now();
    try {
      const certificate = await peerCertificate(hostname, port, connection);
      const durationMs = Date.now() - started;

      if (certificate === null) {
        return {
          id: 'tls',
          label: 'TLS certificate',
          status: 'warn',
          detail: 'The server presented no certificate details',
          durationMs,
        };
      }

      const expiresAt = Date.parse(certificate.valid_to);
      if (Number.isNaN(expiresAt)) {
        return {
          id: 'tls',
          label: 'TLS certificate',
          status: 'warn',
          detail: 'The certificate has an unreadable expiry date',
          durationMs,
        };
      }

      const daysLeft = Math.floor((expiresAt - Date.now()) / 86_400_000);
      // Node types the certificate subject's fields as `string | string[]`,
      // because a DN may repeat an attribute.
      const subject = firstOf(certificate.subject?.CN) ?? hostname;

      if (daysLeft < 0) {
        return {
          id: 'tls',
          label: 'TLS certificate',
          status: 'fail',
          detail: `Certificate for ${subject} expired ${Math.abs(daysLeft)} day(s) ago`,
          durationMs,
        };
      }
      if (daysLeft <= CERT_EXPIRY_WARN_DAYS) {
        return {
          id: 'tls',
          label: 'TLS certificate',
          status: 'warn',
          detail: `Certificate for ${subject} expires in ${daysLeft} day(s)`,
          durationMs,
        };
      }
      return {
        id: 'tls',
        label: 'TLS certificate',
        status: connection.options.tlsVerify ? 'ok' : 'warn',
        detail: connection.options.tlsVerify
          ? `Valid for ${daysLeft} more day(s) (${subject})`
          : `Valid for ${daysLeft} more day(s), but verification is disabled for this server`,
        durationMs,
      };
    } catch (error) {
      return {
        id: 'tls',
        label: 'TLS certificate',
        status: 'fail',
        detail: messageOf(error),
        durationMs: Date.now() - started,
      };
    }
  }

  private async version(connection: ServerConnection): Promise<string | null> {
    const driver = this.registry.driverFor(connection.provider);
    if (driver.serverInfo === undefined) return null;
    try {
      const info = await driver.serverInfo(connection);
      return info.version;
    } catch (error) {
      this.logger.debug({ err: messageOf(error) }, 'Version lookup failed');
      return null;
    }
  }

  private assemble(
    checks: readonly CheckResult[],
    capabilities: CapabilityMap,
    version: string | null,
    bucketCount: number | null,
  ): TestServerResponse {
    return { checks: [...checks], capabilities, version, bucketCount };
  }
}

/* ------------------------------ helpers --------------------------- */

async function timed(id: string, label: string, run: () => Promise<string>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const detail = await run();
    return { id, label, status: 'ok', detail, durationMs: Date.now() - started };
  } catch (error) {
    return {
      id,
      label,
      status: 'fail',
      detail: messageOf(error),
      durationMs: Date.now() - started,
    };
  }
}

const LABELS: Readonly<Record<string, string>> = {
  tcp: 'TCP connect',
  tls: 'TLS certificate',
  auth: 'Authenticate (SigV4)',
  listBuckets: 'List buckets',
  admin: 'Admin API',
  versioning: 'Versioning support',
  objectLock: 'Object lock support',
  replication: 'Replication support',
};

const skipped = (id: string, label: string, detail: string): CheckResult => ({
  id,
  label,
  status: 'skipped',
  detail,
  durationMs: 0,
});

const skipRest = (ids: readonly string[]): readonly CheckResult[] =>
  ids.map((id) => skipped(id, LABELS[id] ?? id, 'Skipped: an earlier check failed'));

function probeCheck(
  id: string,
  label: string,
  state: CapabilityMap[keyof CapabilityMap],
  detail: string | null,
): CheckResult {
  switch (state) {
    case 'supported':
      return { id, label, status: 'ok', detail: 'Supported', durationMs: 0 };
    case 'not_supported':
      return { id, label, status: 'warn', detail: detail ?? 'Not supported', durationMs: 0 };
    case 'not_configured':
      return {
        id,
        label,
        status: 'warn',
        detail: detail === null ? 'Could not determine' : `Could not determine (${detail})`,
        durationMs: 0,
      };
    default:
      return { id, label, status: 'skipped', detail: null, durationMs: 0 };
  }
}

const portOf = (url: URL): number => {
  if (url.port.length > 0) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
};

function tcpReachable(hostname: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: hostname, port, timeout: TCP_TIMEOUT_MS });
    const finish = (error?: Error): void => {
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error(`Timed out after ${TCP_TIMEOUT_MS} ms`)));
    socket.once('error', (error: Error) => finish(error));
  });
}

function peerCertificate(
  hostname: string,
  port: number,
  connection: ServerConnection,
): Promise<PeerCertificate | null> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: hostname,
      port,
      servername: hostname,
      timeout: TLS_TIMEOUT_MS,
      rejectUnauthorized: connection.options.tlsVerify,
      ...(connection.options.caPem === null ? {} : { ca: connection.options.caPem }),
    });

    const finish = (error: Error | null, certificate: PeerCertificate | null): void => {
      socket.destroy();
      if (error !== null) reject(error);
      else resolve(certificate);
    };

    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const hasFields = Object.keys(certificate).length > 0;
      finish(null, hasFields ? certificate : null);
    });
    socket.once('timeout', () =>
      finish(new Error(`TLS handshake timed out after ${TLS_TIMEOUT_MS} ms`), null),
    );
    socket.once('error', (error: Error) => finish(error, null));
  });
}

const firstOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const [first] = value as unknown[];
  return typeof first === 'string' ? first : undefined;
};

/** Keeps a raw SDK message out of a check detail an operator reads. */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return `${code}: ${error.message}`;
  return error.message;
}
