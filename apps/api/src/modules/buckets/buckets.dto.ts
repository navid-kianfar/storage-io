import {
  bucketAccessBodySchema,
  bucketCorsBodySchema,
  bucketLifecycleBodySchema,
  bucketNotificationsBodySchema,
  bucketObjectLockBodySchema,
  bucketPolicyBodySchema,
  bucketQuotaBodySchema,
  bucketReplicationBodySchema,
  bucketTagsBodySchema,
  bucketVersioningBodySchema,
  createBucketRequestSchema,
  deleteBucketQuerySchema,
  emptyBucketRequestSchema,
  listBucketsQuerySchema,
  paginationQuerySchema,
} from '@storage-io/contracts';
import { dtoFrom } from '../../common/dto';

/**
 * Nest DTOs from the contract schemas; no field is restated.
 *
 * `bucketBulkRequestSchema` has no DTO here: it is a discriminated union, and
 * `createZodDto` builds a class, which cannot extend a union type. That body is
 * validated with an explicit `ZodValidationPipe` on the parameter instead — see
 * `buckets.controller.ts`.
 */

export class ListBucketsQueryDto extends dtoFrom(
  listBucketsQuerySchema.merge(paginationQuerySchema),
) {}
export class ExportBucketsQueryDto extends dtoFrom(listBucketsQuerySchema) {}
export class CreateBucketDto extends dtoFrom(createBucketRequestSchema) {}
export class DeleteBucketQueryDto extends dtoFrom(deleteBucketQuerySchema) {}
export class EmptyBucketDto extends dtoFrom(emptyBucketRequestSchema) {}
export class BucketAccessDto extends dtoFrom(bucketAccessBodySchema) {}
export class BucketPolicyDto extends dtoFrom(bucketPolicyBodySchema) {}
export class BucketVersioningDto extends dtoFrom(bucketVersioningBodySchema) {}
export class BucketObjectLockDto extends dtoFrom(bucketObjectLockBodySchema) {}
export class BucketLifecycleDto extends dtoFrom(bucketLifecycleBodySchema) {}
export class BucketCorsDto extends dtoFrom(bucketCorsBodySchema) {}
export class BucketTagsDto extends dtoFrom(bucketTagsBodySchema) {}
export class BucketReplicationDto extends dtoFrom(bucketReplicationBodySchema) {}
export class BucketNotificationsDto extends dtoFrom(bucketNotificationsBodySchema) {}
export class BucketQuotaDto extends dtoFrom(bucketQuotaBodySchema) {}
