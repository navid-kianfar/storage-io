import { createSocket } from 'node:dgram';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { hostname } from 'node:os';
import type { SyslogSettings } from '@storage-io/contracts';

/**
 * Syslog transport, shared by the activity forwarder and the channel test.
 *
 * It is a function rather than a class because there is nothing to keep: a
 * connection per message is the right trade here. Activity lines arrive a few per
 * minute on a busy install, and a pooled TCP socket to a collector that restarts
 * is a silent hole — messages written into a half-open socket that nobody notices
 * until someone goes looking for a month of audit trail.
 *
 * ## RFC 5424
 *
 * ```
 * <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD] MSG
 * ```
 *
 * `PRI` is `facility * 8 + severity`. Structured data is `-` (absent): the
 * interesting fields go in the JSON message, where a collector can index them
 * without an enterprise number. The framing is newline-delimited on TCP and TLS,
 * which is what almost every collector expects by default; RFC 6587 octet
 * counting is not used, and a collector configured for it will need
 * `format: 'json'` over UDP instead.
 *
 * **Unverified against a real collector.** It is tested against a local UDP and
 * TCP listener (`test/unit/syslog.spec.ts` asserts the exact bytes), not against
 * rsyslog or syslog-ng.
 */

const SYSLOG_VERSION = 1;
const APP_NAME = 'storage-io';
const NILVALUE = '-';
const CONNECT_TIMEOUT_MS = 5_000;
/** Most collectors truncate past 2 KiB on UDP; keeping under it avoids silent loss. */
const MAX_MESSAGE_BYTES = 2000;

/** RFC 5424 severities, the ones storage-io uses. */
export const SYSLOG_SEVERITIES = {
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
} as const;
export type SyslogSeverity = keyof typeof SYSLOG_SEVERITIES;

export interface SyslogMessage {
  readonly severity: SyslogSeverity;
  /** `MSGID` — the dotted action, e.g. `object.delete`. */
  readonly msgId: string;
  /** The payload. Serialised as JSON in both formats; `format` decides the frame. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SyslogResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Sends one message. It never throws: both callers are best-effort paths (the
 * activity interceptor and a test endpoint), and a collector being down must not
 * fail the request that produced the audit line.
 */
export async function sendSyslog(
  settings: SyslogSettings,
  message: SyslogMessage,
  at: Date = new Date(),
): Promise<SyslogResult> {
  if (settings.host.length === 0) {
    return { ok: false, detail: 'No syslog host is configured.' };
  }

  const frame = formatSyslog(settings, message, at);
  try {
    switch (settings.protocol) {
      case 'udp':
        await sendUdp(settings.host, settings.port, frame);
        return { ok: true, detail: `Sent ${frame.length} bytes over UDP.` };
      case 'tcp':
        await sendStream(settings.host, settings.port, `${frame}\n`, false);
        return { ok: true, detail: `Sent ${frame.length} bytes over TCP.` };
      case 'tls':
        await sendStream(settings.host, settings.port, `${frame}\n`, true);
        return { ok: true, detail: `Sent ${frame.length} bytes over TLS.` };
    }
  } catch (error) {
    // The host and port are the operator's own configuration, so naming them is
    // useful rather than a leak; the underlying error's text is not passed on.
    return {
      ok: false,
      detail: `Could not reach ${settings.host}:${settings.port} over ${settings.protocol.toUpperCase()} (${reasonOf(error)}).`,
    };
  }
}

/**
 * The bytes on the wire. Exported so the unit test asserts the frame rather than
 * mocking a socket and proving nothing.
 */
export function formatSyslog(
  settings: SyslogSettings,
  message: SyslogMessage,
  at: Date = new Date(),
): string {
  const body = truncate(JSON.stringify(message.payload), MAX_MESSAGE_BYTES);
  if (settings.format === 'json') {
    // A collector reading JSON wants the whole record as one object, including the
    // fields the RFC header would otherwise carry.
    return truncate(
      JSON.stringify({
        timestamp: at.toISOString(),
        host: hostname(),
        app: APP_NAME,
        severity: message.severity,
        msgId: message.msgId,
        ...message.payload,
      }),
      MAX_MESSAGE_BYTES,
    );
  }

  const priority = settings.facility * 8 + SYSLOG_SEVERITIES[message.severity];
  const header = [
    `<${priority}>${SYSLOG_VERSION}`,
    at.toISOString(),
    sanitizeField(hostname()),
    APP_NAME,
    String(process.pid),
    sanitizeField(message.msgId),
    NILVALUE,
  ].join(' ');
  return `${header} ${body}`;
}

/* ------------------------------ transports ------------------------ */

function sendUdp(host: string, port: number, frame: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const done = (error?: Error): void => {
      socket.close();
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.once('error', done);
    socket.send(Buffer.from(frame, 'utf8'), port, host, (error) => {
      done(error ?? undefined);
    });
  });
}

function sendStream(host: string, port: number, frame: string, secure: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket: Socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });

    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      finish(new Error('timed out'));
    });
    socket.once('error', finish);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.end(frame, () => {
        finish();
      });
    });
  });
}

/* ------------------------------ helpers --------------------------- */

/** RFC 5424 header fields are printable ASCII without spaces. */
function sanitizeField(value: string): string {
  const cleaned = value.replace(/[^\x21-\x7e]/g, '');
  return cleaned.length === 0 ? NILVALUE : cleaned.slice(0, 48);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

const reasonOf = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const shape = error as { code?: unknown; message?: unknown };
  if (typeof shape.code === 'string') return shape.code;
  if (typeof shape.message === 'string') return shape.message.slice(0, 120);
  return 'unknown error';
};
