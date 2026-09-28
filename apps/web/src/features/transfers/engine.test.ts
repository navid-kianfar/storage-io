import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTransfers } from '@/stores/transfers';
import {
  cancelTransfer,
  configureEngine,
  enqueueUploads,
  encodeTagHeader,
  pauseTransfer,
  resumeTransfer,
} from './engine';

/**
 * The engine drives real XHRs, so the tests drive a fake one. What matters is the
 * queue's behaviour: the concurrency ceiling, what pause and resume do to a
 * transfer that cannot be resumed mid-stream, and that a cancel really aborts.
 */

interface FakeXhr {
  readonly upload: { addEventListener: (name: string, handler: (event: unknown) => void) => void };
  addEventListener: (name: string, handler: () => void) => void;
  open: () => void;
  send: () => void;
  abort: () => void;
  setRequestHeader: (name: string, value: string) => void;
  withCredentials: boolean;
  status: number;
  responseText: string;
}

const opened: FakeXhr[] = [];
let aborts = 0;

class MockXhr implements FakeXhr {
  status = 200;
  responseText = '{}';
  withCredentials = false;
  private readonly handlers = new Map<string, () => void>();
  readonly upload = { addEventListener: () => undefined };

  constructor() {
    opened.push(this);
  }
  addEventListener(name: string, handler: () => void) {
    this.handlers.set(name, handler);
  }
  open() {
    // The URL is asserted through the request the store records, not here.
  }
  setRequestHeader() {
    // Header assertions live in `encodeTagHeader`'s own test.
  }
  send() {
    // Deliberately inert: the test decides when (and whether) a request finishes.
  }
  abort() {
    aborts += 1;
    this.handlers.get('abort')?.();
  }
  finish(status = 200) {
    this.status = status;
    this.handlers.get('load')?.();
  }
}

function fileOf(name: string): File {
  return new File([new Uint8Array(8)], name, { type: 'text/plain' });
}

const SCOPE = {
  serverId: 's1',
  serverName: 'minio-prod-01',
  bucket: 'media-prod',
  bucketId: 'bucket-media-prod',
};

function upload(names: readonly string[]) {
  return enqueueUploads({
    scope: SCOPE,
    items: names.map((name) => ({ file: fileOf(name), relativePath: name })),
    destPrefix: 'raw/',
    overwrite: true,
    detectContentType: false,
  });
}

beforeEach(() => {
  opened.length = 0;
  aborts = 0;
  useTransfers.getState().reset();
  vi.stubGlobal('XMLHttpRequest', MockXhr);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useTransfers.getState().reset();
});

describe('the transfer engine', () => {
  it('starts only as many uploads as the configured concurrency allows', () => {
    configureEngine({ parallel: 2 });
    upload(['a.txt', 'b.txt', 'c.txt', 'd.txt']);

    expect(opened).toHaveLength(2);
    const statuses = useTransfers.getState().transfers.map((transfer) => transfer.status);
    expect(statuses).toEqual(['running', 'running', 'queued', 'queued']);
  });

  it('starts the next queued upload when one finishes', () => {
    configureEngine({ parallel: 1 });
    upload(['a.txt', 'b.txt']);
    expect(opened).toHaveLength(1);

    (opened[0] as unknown as MockXhr).finish();

    expect(opened).toHaveLength(2);
    const [first, second] = useTransfers.getState().transfers;
    expect(first?.status).toBe('completed');
    expect(second?.status).toBe('running');
  });

  it('counts a finished upload towards the session total', () => {
    configureEngine({ parallel: 1 });
    upload(['a.txt']);
    (opened[0] as unknown as MockXhr).finish();

    expect(useTransfers.getState().totals).toEqual({
      uploadedBytes: 8,
      downloadedBytes: 0,
      completed: 1,
    });
  });

  it('builds the key from the destination prefix and the relative path', () => {
    configureEngine({ parallel: 1 });
    enqueueUploads({
      scope: SCOPE,
      items: [{ file: fileOf('shot.cr3'), relativePath: 'session-4/shot.cr3' }],
      destPrefix: '2026/09/',
      overwrite: true,
      detectContentType: false,
    });

    // A dropped folder keeps its shape rather than flattening into one prefix.
    expect(useTransfers.getState().transfers[0]?.key).toBe('2026/09/session-4/shot.cr3');
  });

  it('aborts the request on pause, and restarts from zero on resume', () => {
    configureEngine({ parallel: 1 });
    const [id] = upload(['a.txt']);
    if (id === undefined) throw new Error('no transfer was queued');

    useTransfers.getState().update(id, { transferredBytes: 5 });
    pauseTransfer(id);

    expect(aborts).toBe(1);
    expect(useTransfers.getState().transfers[0]?.status).toBe('paused');

    resumeTransfer(id);

    // A single PUT has no resume point, so the progress honestly goes back to 0.
    const resumed = useTransfers.getState().transfers[0];
    expect(resumed?.transferredBytes).toBe(0);
    expect(resumed?.status).toBe('running');
    expect(opened).toHaveLength(2);
  });

  it('does not start a paused transfer when a slot frees up', () => {
    configureEngine({ parallel: 1 });
    const ids = upload(['a.txt', 'b.txt']);
    const second = ids[1];
    if (second === undefined) throw new Error('no second transfer');

    pauseTransfer(second);
    (opened[0] as unknown as MockXhr).finish();

    expect(opened).toHaveLength(1);
    expect(useTransfers.getState().transfers[1]?.status).toBe('paused');
  });

  it('marks a 4xx failed without retrying, because a retry cannot help', () => {
    configureEngine({ parallel: 1 });
    upload(['a.txt']);
    (opened[0] as unknown as MockXhr).finish(409);

    const transfer = useTransfers.getState().transfers[0];
    expect(transfer?.status).toBe('failed');
    expect(transfer?.attempt).toBe(1);
    expect(opened).toHaveLength(1);
  });

  it('retries a 5xx with backoff', () => {
    configureEngine({ parallel: 1 });
    upload(['a.txt']);
    (opened[0] as unknown as MockXhr).finish(503);

    expect(useTransfers.getState().transfers[0]?.status).toBe('queued');
    vi.advanceTimersByTime(1000);
    expect(opened).toHaveLength(2);
  });

  it('cancels a transfer and stops it being restarted', () => {
    configureEngine({ parallel: 1 });
    const [id] = upload(['a.txt', 'b.txt']);
    if (id === undefined) throw new Error('no transfer was queued');

    cancelTransfer(id);

    expect(aborts).toBe(1);
    expect(useTransfers.getState().transfers[0]?.status).toBe('cancelled');
    // The slot it held goes to the next one in the queue.
    expect(useTransfers.getState().transfers[1]?.status).toBe('running');
  });
});

describe('encodeTagHeader', () => {
  it('sends tags as a urlencoded query string, as S3 tagging does', () => {
    expect(encodeTagHeader({ env: 'prod', 'cost center': 'mkt 204' })).toBe(
      'env=prod&cost+center=mkt+204',
    );
  });
});
