import type { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
  type ListPartsCommandOutput,
  type StorageClass,
} from '@aws-sdk/client-s3';
import {
  MULTIPART_MAX_PARTS,
  MULTIPART_MIN_PART_SIZE,
  type CompleteMultipartUploadRequest,
  type CreateMultipartUploadRequest,
  type CreateMultipartUploadResponse,
  type MultipartPart,
  type ObjectItem,
  type UploadPartResponse,
} from '@storage-io/contracts';
import { ProviderError, ValidationError } from '../../common/errors/domain.exception';
import { SettingsService } from '../../settings/settings.service';
import type { StorageContext } from '../storage/storage-context.service';
import { encodeTagging, stripQuotes } from './object-stream.service';

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const LIST_PARTS_PAGE = 1000;

/**
 * The client-driven multipart upload, for a browser that has to survive a dropped
 * connection.
 *
 * `POST …/objects/upload` already streams a whole body through
 * `@aws-sdk/lib-storage`, and it is the right call when the upload either finishes
 * or is retried from the start. It cannot be resumed: the bytes arrive on one HTTP
 * request, and when that request dies the upload dies with it.
 *
 * These endpoints hand the parts back to the client instead. It creates an upload,
 * PUTs each part as its own request, asks which parts the server already holds when
 * it comes back, and completes. Nothing about the session is stored here — S3 is
 * the record, through `ListParts` — so a resume works after an API restart too.
 *
 * The part size the client should use comes from `Settings.transfers.partSizeMb`,
 * floored at S3's 5 MiB minimum: a client that picked its own smaller size would
 * have every part but the last rejected at completion, which is a confusing place
 * to discover it.
 */
@Injectable()
export class MultipartService {
  private readonly logger = new Logger(MultipartService.name);

  constructor(private readonly settings: SettingsService) {}

  async create(
    context: StorageContext,
    bucket: string,
    request: CreateMultipartUploadRequest,
  ): Promise<CreateMultipartUploadResponse> {
    const created = await context.client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: request.key,
        ContentType: request.contentType ?? DEFAULT_CONTENT_TYPE,
        ...(Object.keys(request.metadata).length === 0
          ? {}
          : { Metadata: { ...request.metadata } }),
        ...(Object.keys(request.tags).length === 0 ? {} : { Tagging: encodeTagging(request.tags) }),
        ...(request.storageClass === null
          ? {}
          : { StorageClass: request.storageClass as StorageClass }),
      }),
    );

    const uploadId = created.UploadId;
    if (uploadId === undefined) {
      throw new ProviderError('The storage server did not return an upload id.');
    }

    return { uploadId, key: request.key, partSizeBytes: this.partSizeBytes() };
  }

  /**
   * One part, streamed. `ContentLength` is required rather than inferred: S3 signs
   * the part against a declared length, and a chunked body with no length is
   * rejected by the provider with a message that says nothing about the cause.
   */
  async uploadPart(
    context: StorageContext,
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    contentLength: number | null,
  ): Promise<UploadPartResponse> {
    if (partNumber < 1 || partNumber > MULTIPART_MAX_PARTS) {
      throw new ValidationError(`The part number must be between 1 and ${MULTIPART_MAX_PARTS}.`);
    }
    if (contentLength === null) {
      throw new ValidationError(
        'A part upload must declare Content-Length; a chunked body cannot be signed as a part.',
      );
    }

    const uploaded = await context.client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: contentLength,
      }),
    );

    const etag = uploaded.ETag;
    if (etag === undefined) throw new ProviderError('The storage server returned no part ETag.');
    return { partNumber, etag: stripQuotes(etag), size: contentLength };
  }

  /** The parts already stored, which is what a resuming client needs. */
  async listParts(
    context: StorageContext,
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<readonly MultipartPart[]> {
    const parts: MultipartPart[] = [];
    let marker: number | undefined = undefined;

    do {
      const response: ListPartsCommandOutput = await context.client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MaxParts: LIST_PARTS_PAGE,
          ...(marker === undefined ? {} : { PartNumberMarker: String(marker) }),
        }),
      );

      for (const part of response.Parts ?? []) {
        if (part.PartNumber === undefined || part.ETag === undefined) continue;
        parts.push({
          partNumber: part.PartNumber,
          etag: stripQuotes(part.ETag),
          size: part.Size ?? 0,
        });
      }

      marker =
        response.IsTruncated === true && response.NextPartNumberMarker !== undefined
          ? Number(response.NextPartNumberMarker)
          : undefined;
    } while (marker !== undefined && Number.isFinite(marker));

    return parts;
  }

  /**
   * Completes the upload. The parts are sorted by number before they are sent: S3
   * requires ascending order and rejects the whole upload otherwise, and a client
   * that uploaded in parallel has no reason to have kept them in order.
   */
  async complete(
    context: StorageContext,
    bucket: string,
    key: string,
    uploadId: string,
    request: CompleteMultipartUploadRequest,
  ): Promise<ObjectItem> {
    const seen = new Set<number>();
    for (const part of request.parts) {
      if (seen.has(part.partNumber)) {
        throw new ValidationError(`Part ${part.partNumber} was listed more than once.`);
      }
      seen.add(part.partNumber);
    }

    const ordered = [...request.parts].sort((left, right) => left.partNumber - right.partNumber);

    await context.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );

    const head = await context.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      key,
      size: head.ContentLength ?? 0,
      lastModified: (head.LastModified ?? new Date()).toISOString(),
      etag: stripQuotes(head.ETag ?? ''),
      storageClass: head.StorageClass ?? null,
      versionId: head.VersionId ?? null,
      isLatest: true,
      deleteMarker: false,
    };
  }

  /**
   * Aborts the upload and its parts. A client that walked away leaves parts the
   * operator pays for, so this is the endpoint the browser calls on cancel — and
   * `Settings.transfers.keepIncompleteDays` is the backstop for the ones it never
   * gets to call.
   */
  async abort(
    context: StorageContext,
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await context.client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
    );
    this.logger.log({ bucket, key, uploadId }, 'Multipart upload aborted');
  }

  /** Never below S3's minimum, whatever the operator configured. */
  private partSizeBytes(): number {
    const configured = this.settings.getInternal().transfers.partSizeMb * BYTES_PER_MB;
    return Math.max(configured, MULTIPART_MIN_PART_SIZE);
  }
}
