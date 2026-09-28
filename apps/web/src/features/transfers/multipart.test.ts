import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTransfers } from '@/stores/transfers';
import * as objectsApi from '@/features/objects/api';
import {
  cancelTransfer,
  configureEngine,
  enqueueUploads,
  multipartThresholdBytes,
  pauseTransfer,
  resumeTransfer,
} from './engine';

/**
 * The resumable upload, which is the part of the engine with real state.
 *
 * What is worth asserting: a file above the part size goes through the multipart
 * endpoints at all; a pause keeps the parts the server already holds instead of
 * throwing the object away; a resume asks the *server* which parts those are
 * rather than trusting this tab; and a cancel tells the server to discard them.
 */

const PART_SIZE = 5 * 1024 * 1024;
const SCOPE = { serverId: 's1', serverName: 'minio-prod-01', bucket: 'media-prod' };
const UPLOAD_ID = 'upload-1';

/** Part uploads never resolve on their own: each test finishes the ones it wants. */
class MockXhr {
  static readonly opened: MockXhr[] = [];
  static aborts = 0;

  status = 200;
  responseText = '{}';
  withCredentials = false;
  url = '';
  private readonly handlers = new Map<string, () => void>();
  readonly upload = { addEventListener: () => undefined };

  constructor() {
    MockXhr.opened.push(this);
  }
  addEventListener(name: string, handler: () => void) {
    this.handlers.set(name, handler);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {
    // Asserted through the request bodies the API layer receives, not here.
  }
  send() {
    // Inert: the test decides when a part finishes.
  }
  abort() {
    MockXhr.aborts += 1;
    this.handlers.get('abort')?.();
  }
  finishPart(partNumber: number) {
    this.status = 200;
    this.responseText = JSON.stringify({
      partNumber,
      etag: `etag-${String(partNumber)}`,
      size: PART_SIZE,
    });
    this.handlers.get('load')?.();
  }
}

function bigFile(bytes: number): File {
  // A sparse blob: the engine only ever slices it, so the contents are irrelevant.
  return new File([new Uint8Array(bytes)], 'big.bin', { type: 'application/octet-stream' });
}

function uploadBig(bytes: number): string {
  const [id] = enqueueUploads({
    scope: SCOPE,
    items: [{ file: bigFile(bytes), relativePath: 'big.bin' }],
    destPrefix: 'raw/',
    overwrite: true,
    detectContentType: false,
  });
  return id ?? '';
}

function transfer(id: string) {
  return useTransfers.getState().transfers.find((item) => item.id === id);
}

/** Lets the engine's own awaited promises settle between assertions. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

let create: ReturnType<typeof vi.spyOn>;
let listParts: ReturnType<typeof vi.spyOn>;
let complete: ReturnType<typeof vi.spyOn>;
let abort: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  MockXhr.opened.length = 0;
  MockXhr.aborts = 0;
  useTransfers.getState().reset();
  vi.stubGlobal('XMLHttpRequest', MockXhr);

  create = vi
    .spyOn(objectsApi, 'createMultipartUpload')
    .mockResolvedValue({ uploadId: UPLOAD_ID, key: 'raw/big.bin', partSizeBytes: PART_SIZE });
  listParts = vi.spyOn(objectsApi, 'listMultipartParts').mockResolvedValue({
    parts: [{ partNumber: 1, etag: 'etag-1', size: PART_SIZE }],
  });
  complete = vi.spyOn(objectsApi, 'completeMultipartUpload').mockResolvedValue({
    key: 'raw/big.bin',
    size: PART_SIZE * 2,
    lastModified: '2026-09-28T00:00:00.000Z',
    etag: 'final-etag-2',
    storageClass: null,
    versionId: null,
    isLatest: true,
    deleteMarker: false,
  });
  abort = vi.spyOn(objectsApi, 'abortMultipartUpload').mockResolvedValue(undefined);

  configureEngine({ parallel: 4, partSizeMb: 5, retries: 4, bandwidthLimitMbps: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useTransfers.getState().reset();
});

describe('the resumable upload', () => {
  it('leaves a file at or below the part size on the single-PUT path', async () => {
    uploadBig(multipartThresholdBytes());
    await settle();

    expect(create).not.toHaveBeenCalled();
    expect(MockXhr.opened[0]?.url).toContain('/objects/upload');
  });

  it('opens a multipart upload for a file above the part size and sends one part per request', async () => {
    uploadBig(PART_SIZE * 2);
    await settle();

    expect(create).toHaveBeenCalledTimes(1);
    expect(MockXhr.opened).toHaveLength(1);
    expect(MockXhr.opened[0]?.url).toContain(`/objects/multipart/${UPLOAD_ID}/parts/1`);

    MockXhr.opened[0]?.finishPart(1);
    await settle();

    expect(MockXhr.opened).toHaveLength(2);
    expect(MockXhr.opened[1]?.url).toContain('/parts/2');
  });

  it('completes with every part, sorted, once the last one is stored', async () => {
    const id = uploadBig(PART_SIZE * 2);
    await settle();
    MockXhr.opened[0]?.finishPart(1);
    await settle();
    MockXhr.opened[1]?.finishPart(2);
    await settle();

    expect(complete).toHaveBeenCalledWith(
      { serverId: 's1', bucket: 'media-prod' },
      UPLOAD_ID,
      'raw/big.bin',
      {
        parts: [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ],
      },
    );
    expect(transfer(id)?.status).toBe('completed');
  });

  it('keeps the stored parts when it is paused, rather than starting the object again', async () => {
    const id = uploadBig(PART_SIZE * 3);
    await settle();
    MockXhr.opened[0]?.finishPart(1);
    await settle();

    expect(transfer(id)?.transferredBytes).toBe(PART_SIZE);

    pauseTransfer(id);
    await settle();

    expect(transfer(id)?.status).toBe('paused');
    // The part in flight is gone; the one the server confirmed is not.
    expect(transfer(id)?.transferredBytes).toBe(PART_SIZE);
    expect(abort).not.toHaveBeenCalled();
  });

  it('asks the server which parts it holds when it resumes, and sends only the rest', async () => {
    const id = uploadBig(PART_SIZE * 3);
    await settle();
    MockXhr.opened[0]?.finishPart(1);
    await settle();
    pauseTransfer(id);
    await settle();

    const before = MockXhr.opened.length;
    resumeTransfer(id);
    await settle();

    expect(listParts).toHaveBeenCalledWith({ serverId: 's1', bucket: 'media-prod' }, UPLOAD_ID, 'raw/big.bin');
    // A second create would mean a restart, not a resume.
    expect(create).toHaveBeenCalledTimes(1);
    expect(MockXhr.opened[before]?.url).toContain('/parts/2');
  });

  it('discards the parts on the server when the operator cancels', async () => {
    const id = uploadBig(PART_SIZE * 3);
    await settle();
    MockXhr.opened[0]?.finishPart(1);
    await settle();

    cancelTransfer(id);
    await settle();

    expect(abort).toHaveBeenCalledWith({ serverId: 's1', bucket: 'media-prod' }, UPLOAD_ID, 'raw/big.bin');
    expect(transfer(id)?.status).toBe('cancelled');
  });
});
