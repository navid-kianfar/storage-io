import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * The frames a second tab depends on: `activity.created` when a row is recorded,
 * and `server.created` / `server.deleted` when the server list changes.
 *
 * The unit spec covers the activity throttle's arithmetic; what these prove is
 * the wiring an operator depends on — a request changes something and a client
 * already on `GET /events` is told, without polling. They read the socket
 * directly, because supertest would wait for a stream that never ends.
 */

const STREAM_TIMEOUT_MS = 8_000;

describe('the SSE stream (e2e)', () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('pushes a frame naming the row a mutating request just recorded', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

    try {
      const response = await fetch(`${harness.origin}/api/v1/events`, {
        headers: { Cookie: cookie, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);

      const body = response.body;
      if (body === null) throw new Error('The event stream had no body.');
      const reader = body.getReader();

      // The mutation happens after the stream is open, so the frame cannot have
      // been missed before the client arrived.
      await harness
        .http()
        .post('/api/v1/auth/tokens')
        .set({ Cookie: cookie, Origin: harness.origin })
        .send({ name: 'sse-probe', expiresInDays: null })
        .expect(201);

      const frame = await readFrame(reader, 'activity.created');
      const payload = JSON.parse(frame) as {
        event: { action: string; result: string };
        suppressed: number;
      };

      expect(payload.event.action).toBe('auth.token.create');
      expect(payload.event.result).toBe('success');
      expect(payload.suppressed).toBe(0);
      // The stream carries no secret: the token itself is in the response body
      // of the request that created it and nowhere else.
      expect(frame).not.toContain('sio_');

      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  it('announces a server being added and removed', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

    try {
      const response = await fetch(`${harness.origin}/api/v1/events`, {
        headers: { Cookie: cookie, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      const body = response.body;
      if (body === null) throw new Error('The event stream had no body.');
      const reader = body.getReader();

      const created = await harness
        .http()
        .post('/api/v1/servers')
        .set({ Cookie: cookie, Origin: harness.origin })
        .send({
          name: 'sse-lab',
          provider: 'generic',
          // A closed port: the connection is refused at once.
          endpoint: 'http://127.0.0.1:9',
          region: 'us-east-1',
          accessKeyId: 'unused',
          secretAccessKey: 'unused-secret',
          options: { pathStyle: true, healthIntervalSec: 3600 },
        })
        .expect(201);
      const serverId = created.body.id as string;

      const addedFrame = await readFrame(reader, 'server.created');
      expect(JSON.parse(addedFrame)).toMatchObject({ serverId, serverName: 'sse-lab' });

      await harness
        .http()
        .delete(`/api/v1/servers/${serverId}`)
        .set({ Cookie: cookie, Origin: harness.origin })
        .expect(204);

      const removedFrame = await readFrame(reader, 'server.deleted');
      expect(JSON.parse(removedFrame)).toMatchObject({ serverId, serverName: 'sse-lab' });

      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });
});

/* ------------------------------ helpers --------------------------- */

/**
 * Reads the stream until a frame with the given `event:` name arrives and
 * returns its `data:` line. Keepalives and other events are skipped rather than
 * failing the test, because the stream is shared by every module.
 */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wanted: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffered = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`The stream ended before a "${wanted}" frame arrived.`);
    buffered += decoder.decode(chunk.value, { stream: true });

    let boundary = buffered.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);

      const name = lineValue(frame, 'event:');
      if (name === wanted) {
        const data = lineValue(frame, 'data:');
        if (data === null) throw new Error(`The "${wanted}" frame carried no data.`);
        return data;
      }
      boundary = buffered.indexOf('\n\n');
    }
  }
}

function lineValue(frame: string, prefix: string): string | null {
  for (const line of frame.split('\n')) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}
