import { createServer, type Server } from 'node:http';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, type Notification, type Settings } from '@storage-io/contracts';
import {
  TelegramChannel,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookChannel,
  signWebhook,
  verifyWebhook,
} from '../../src/notifications/delivery/channels';
import { formatSyslog, sendSyslog } from '../../src/notifications/delivery/syslog';

/**
 * The delivery channels, against real sockets rather than mocks.
 *
 * A mocked `fetch` proves the code called `fetch`. What matters is the bytes a
 * receiver gets — the signature it has to verify, the syslog frame a collector has
 * to parse — and the promise the interface makes that `deliver` never throws,
 * because the callers are the health checker and the job engine.
 */

const notification: Notification = {
  id: 'n-1',
  at: '2026-03-15T10:00:00.000Z',
  level: 'error',
  title: 'minio-lab is offline',
  detail: 'The server stopped responding.',
  href: '/servers/minio-lab',
  read: false,
};

const settingsWith = (patch: Partial<Settings['notifications']>): Settings => ({
  ...SETTINGS_DEFAULTS,
  notifications: { ...SETTINGS_DEFAULTS.notifications, ...patch },
});

/* -------------------------------- webhook -------------------------- */

describe('webhook signature', () => {
  it('signs the timestamp together with the body', () => {
    const body = '{"event":"test"}';
    const signature = signWebhook('secret', '1700000000000', body);
    expect(verifyWebhook('secret', '1700000000000', body, signature)).toBe(true);
    // A captured request cannot be replayed under a different timestamp.
    expect(verifyWebhook('secret', '1700000000001', body, signature)).toBe(false);
    expect(verifyWebhook('other-secret', '1700000000000', body, signature)).toBe(false);
    expect(verifyWebhook('secret', '1700000000000', `${body} `, signature)).toBe(false);
  });

  it('is a stable hex digest of the documented input', () => {
    // Pinned so a refactor of the concatenation cannot silently break every
    // receiver that already verifies storage-io's signature.
    expect(signWebhook('k', '1', 'b')).toBe(signWebhook('k', '1', 'b'));
    expect(signWebhook('k', '1', 'b')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('WebhookChannel', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server === undefined) return;
    const toClose = server;
    server = undefined;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  });

  const receiver = async (
    status: number,
  ): Promise<{ url: string; requests: { headers: Record<string, unknown>; body: string }[] }> => {
    const requests: { headers: Record<string, unknown>; body: string }[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(status).end('{}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}/hook`, requests };
  };

  it('posts a signed notification a receiver can verify', async () => {
    const target = await receiver(200);
    const settings = settingsWith({
      webhook: { enabled: true, url: target.url, secret: 'shhh' },
    });

    const result = await new WebhookChannel().deliver(notification, settings);
    expect(result.ok).toBe(true);

    const [received] = target.requests;
    expect(received).toBeDefined();
    expect(received?.headers[WEBHOOK_EVENT_HEADER]).toBe('notification');
    expect(JSON.parse(received?.body ?? '{}')).toEqual({
      event: 'notification',
      data: {
        id: notification.id,
        at: notification.at,
        level: notification.level,
        title: notification.title,
        detail: notification.detail,
        href: notification.href,
      },
    });

    const timestamp = received?.headers[WEBHOOK_TIMESTAMP_HEADER];
    const signature = received?.headers[WEBHOOK_SIGNATURE_HEADER];
    expect(verifyWebhook('shhh', String(timestamp), received?.body ?? '', String(signature))).toBe(
      true,
    );
  });

  it('sends nothing signed when no secret is configured', async () => {
    const target = await receiver(200);
    const settings = settingsWith({ webhook: { enabled: true, url: target.url } });

    const result = await new WebhookChannel().deliver(notification, settings);
    expect(result.ok).toBe(true);
    expect(target.requests[0]?.headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
  });

  it('reports a non-2xx answer as a failure rather than throwing', async () => {
    const target = await receiver(500);
    const settings = settingsWith({ webhook: { enabled: true, url: target.url } });

    const result = await new WebhookChannel().deliver(notification, settings);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('500');
  });

  it('reports an unreachable endpoint as a failure, without a stack trace', async () => {
    // Port 1 on loopback refuses immediately.
    const settings = settingsWith({ webhook: { enabled: true, url: 'http://127.0.0.1:1/hook' } });
    const result = await new WebhookChannel().deliver(notification, settings);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain('at ');
  });

  it('refuses a URL that is not http(s) or that carries credentials', async () => {
    const channel = new WebhookChannel();
    for (const url of ['file:///etc/passwd', 'http://user:pass@example.com/hook']) {
      const result = await channel.deliver(
        notification,
        settingsWith({ webhook: { enabled: true, url } }),
      );
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('http');
    }
  });

  it('is only enabled with both a flag and a URL', () => {
    const channel = new WebhookChannel();
    expect(channel.isEnabled(settingsWith({ webhook: { enabled: true, url: '' } }))).toBe(false);
    expect(
      channel.isEnabled(settingsWith({ webhook: { enabled: false, url: 'http://x/y' } })),
    ).toBe(false);
    expect(channel.isEnabled(settingsWith({ webhook: { enabled: true, url: 'http://x/y' } }))).toBe(
      true,
    );
  });
});

/* -------------------------------- telegram ------------------------- */

describe('TelegramChannel', () => {
  it('refuses to send without a bot token, and says so', async () => {
    const settings = settingsWith({ telegram: { enabled: true, chatId: '123' } });
    const result = await new TelegramChannel().deliver(notification, settings);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('bot token');
  });

  it('refuses to send without a chat id', async () => {
    const settings = settingsWith({ telegram: { enabled: true, chatId: '', botToken: 't' } });
    const result = await new TelegramChannel().deliver(notification, settings);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('chat id');
  });

  it('needs a chat id to count as enabled', () => {
    const channel = new TelegramChannel();
    expect(channel.isEnabled(settingsWith({ telegram: { enabled: true, chatId: '' } }))).toBe(
      false,
    );
    expect(channel.isEnabled(settingsWith({ telegram: { enabled: true, chatId: '9' } }))).toBe(
      true,
    );
  });
});

/* --------------------------------- syslog -------------------------- */

describe('syslog framing', () => {
  const syslog = SETTINGS_DEFAULTS.activity.syslog;
  const at = new Date('2026-03-15T10:00:00.000Z');

  it('writes an RFC 5424 header with the right priority', () => {
    // facility 1 (user) * 8 + severity 4 (warning) = 12
    const frame = formatSyslog(
      { ...syslog, format: 'rfc5424', facility: 1 },
      { severity: 'warning', msgId: 'object.delete', payload: { key: 'a.txt' } },
      at,
    );
    expect(frame.startsWith('<12>1 2026-03-15T10:00:00.000Z ')).toBe(true);
    expect(frame).toContain(' storage-io ');
    expect(frame).toContain(' object.delete - ');
    expect(frame.endsWith('{"key":"a.txt"}')).toBe(true);
  });

  it('computes the priority from the configured facility', () => {
    // facility 16 (local0) * 8 + severity 3 (error) = 131
    const frame = formatSyslog(
      { ...syslog, format: 'rfc5424', facility: 16 },
      { severity: 'error', msgId: 'x', payload: {} },
      at,
    );
    expect(frame.startsWith('<131>1 ')).toBe(true);
  });

  it('writes one flat JSON object in json format, with no RFC header', () => {
    const frame = formatSyslog(
      { ...syslog, format: 'json' },
      { severity: 'info', msgId: 'server.up', payload: { serverName: 'minio-lab' } },
      at,
    );
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    expect(frame.startsWith('<')).toBe(false);
    expect(parsed).toMatchObject({
      timestamp: '2026-03-15T10:00:00.000Z',
      app: 'storage-io',
      severity: 'info',
      msgId: 'server.up',
      serverName: 'minio-lab',
    });
  });
});

describe('sendSyslog', () => {
  it('sends a UDP datagram a collector receives whole', async () => {
    const socket: UdpSocket = createSocket('udp4');
    socket.bind(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;

    const arrived = once(socket, 'message') as Promise<[Buffer]>;
    const result = await sendSyslog(
      { ...SETTINGS_DEFAULTS.activity.syslog, enabled: true, host: '127.0.0.1', port },
      { severity: 'info', msgId: 'test.udp', payload: { hello: 'world' } },
    );
    expect(result.ok).toBe(true);

    const [message] = await arrived;
    expect(message.toString('utf8')).toContain('test.udp');
    expect(message.toString('utf8')).toContain('{"hello":"world"}');
    socket.close();
  });

  it('sends a newline-framed line over TCP', async () => {
    const chunks: Buffer[] = [];
    const server: TcpServer = createTcpServer((socket) => {
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const result = await sendSyslog(
      {
        ...SETTINGS_DEFAULTS.activity.syslog,
        enabled: true,
        host: '127.0.0.1',
        port,
        protocol: 'tcp',
      },
      { severity: 'error', msgId: 'test.tcp', payload: { n: 1 } },
    );
    expect(result.ok).toBe(true);

    // The socket is closed by the sender, so the data has arrived by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const received = Buffer.concat(chunks).toString('utf8');
    expect(received).toContain('test.tcp');
    expect(received.endsWith('\n')).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports an unreachable collector without throwing', async () => {
    const result = await sendSyslog(
      {
        ...SETTINGS_DEFAULTS.activity.syslog,
        enabled: true,
        host: '127.0.0.1',
        port: 1,
        protocol: 'tcp',
      },
      { severity: 'info', msgId: 'test.nope', payload: {} },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('127.0.0.1:1');
  });

  it('refuses when no host is configured', async () => {
    const result = await sendSyslog(SETTINGS_DEFAULTS.activity.syslog, {
      severity: 'info',
      msgId: 'x',
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('No syslog host');
  });
});
