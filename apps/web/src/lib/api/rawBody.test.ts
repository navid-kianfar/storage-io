import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './client';

/**
 * The in-place object editor sends the file's text as the request body. It used
 * to arrive JSON-encoded — wrapped in quotes, every newline replaced by a literal
 * `\n` — because the client treated every non-FormData body as a DTO. Saving a
 * README in the console rewrote it as a JSON string literal, and the stored
 * content type became `application/json`. Both are data loss, not cosmetics.
 *
 * So: a string body goes out byte for byte, a caller's own Content-Type wins,
 * and an object is still encoded as JSON.
 */

function lastFetchCall(fetchSpy: ReturnType<typeof vi.fn>) {
  const call = fetchSpy.mock.calls.at(-1);
  if (call === undefined) throw new Error('fetch was not called');
  return call[1] as RequestInit;
}

function okResponse(): Response {
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request body encoding', () => {
  it('sends a string body untouched, with the newlines it was given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const text = '# Title\n\n- one\n- two\n';
    await request('/objects/content', {
      method: 'PUT',
      body: text,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });

    const init = lastFetchCall(fetchSpy);
    expect(init.body).toBe(text);
    expect(init.body).not.toContain('\\n');
  });

  it("keeps the caller's own content type instead of forcing JSON", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    await request('/objects/content', {
      method: 'PUT',
      body: 'plain text',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });

    const headers = lastFetchCall(fetchSpy).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/plain; charset=utf-8');
  });

  it('still encodes a DTO as JSON and labels it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    await request('/buckets', { method: 'POST', body: { name: 'a-bucket', quota: null } });

    const init = lastFetchCall(fetchSpy);
    expect(init.body).toBe('{"name":"a-bucket","quota":null}');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('passes FormData through without a content type, so the boundary is set by the browser', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const form = new FormData();
    form.append('passphrase', 'not-a-real-one');
    await request('/settings/import', { method: 'POST', body: form });

    const init = lastFetchCall(fetchSpy);
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});
