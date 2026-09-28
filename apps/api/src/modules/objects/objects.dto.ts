import {
  archiveEntriesQuerySchema,
  completeMultipartUploadRequestSchema,
  copyObjectsRequestSchema,
  createMultipartUploadRequestSchema,
  createFolderRequestSchema,
  deleteObjectsRequestSchema,
  downloadObjectQuerySchema,
  downloadZipRequestSchema,
  importObjectFromUrlRequestSchema,
  listObjectsQuerySchema,
  multipartKeyQuerySchema,
  objectKeyQuerySchema,
  objectMetadataBodySchema,
  objectTagsBodySchema,
  presignRequestSchema,
  putObjectContentQuerySchema,
  renameObjectRequestSchema,
  restoreVersionRequestSchema,
  setObjectStorageClassRequestSchema,
  uploadObjectQuerySchema,
} from '@storage-io/contracts';
import { dtoFrom } from '../../common/dto';

/**
 * Nest DTOs generated from the contract schemas — no field is restated here, so a
 * schema and a DTO cannot drift apart. The global `ZodValidationPipe` validates
 * against them and Swagger reads its shapes from the same source.
 *
 * `objectRetentionBodySchema` and `objectBatchRequestSchema` have no DTO: both are
 * unions, and `createZodDto` builds a class, which cannot extend a union type. Those
 * bodies get an explicit pipe on the parameter — see the controller.
 */

export class ListObjectsQueryDto extends dtoFrom(listObjectsQuerySchema) {}
export class ObjectKeyQueryDto extends dtoFrom(objectKeyQuerySchema) {}
export class DownloadObjectQueryDto extends dtoFrom(downloadObjectQuerySchema) {}
export class DownloadZipDto extends dtoFrom(downloadZipRequestSchema) {}
export class UploadObjectQueryDto extends dtoFrom(uploadObjectQuerySchema) {}
export class PutObjectContentQueryDto extends dtoFrom(putObjectContentQuerySchema) {}
export class CreateFolderDto extends dtoFrom(createFolderRequestSchema) {}
export class DeleteObjectsDto extends dtoFrom(deleteObjectsRequestSchema) {}
export class CopyObjectsDto extends dtoFrom(copyObjectsRequestSchema) {}
export class RenameObjectDto extends dtoFrom(renameObjectRequestSchema) {}
export class RestoreVersionDto extends dtoFrom(restoreVersionRequestSchema) {}
export class ObjectTagsDto extends dtoFrom(objectTagsBodySchema) {}
export class ObjectMetadataDto extends dtoFrom(objectMetadataBodySchema) {}
export class PresignDto extends dtoFrom(presignRequestSchema) {}
export class ImportUrlDto extends dtoFrom(importObjectFromUrlRequestSchema) {}
export class SetStorageClassDto extends dtoFrom(setObjectStorageClassRequestSchema) {}
export class CreateMultipartUploadDto extends dtoFrom(createMultipartUploadRequestSchema) {}
export class MultipartKeyQueryDto extends dtoFrom(multipartKeyQuerySchema) {}
export class CompleteMultipartUploadDto extends dtoFrom(completeMultipartUploadRequestSchema) {}
export class ArchiveEntriesQueryDto extends dtoFrom(archiveEntriesQuerySchema) {}
