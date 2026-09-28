import type { CapabilityMap, Provider } from '@storage-io/contracts';
import { capabilityMap } from './provider-driver';

/**
 * What each provider supports before anything is probed. `not_configured` means
 * "the provider can do this, but this server has not been given the admin
 * endpoint or token it needs" — the UI shows that differently from
 * `not_supported`, which is a permanent no.
 *
 * Everything here is refined by `detectCapabilities`; these are the honest
 * starting points, not guesses the UI is stuck with.
 *
 * Adding a provider: add a profile here, then a driver, then register it in
 * `ProviderRegistryService`.
 */

/** Bucket and object features every S3 implementation in scope supports. */
const S3_CORE = {
  objects: 'supported',
  bucketPolicy: 'supported',
  tagging: 'supported',
} as const;

export const PROVIDER_CAPABILITY_PROFILES: Readonly<Record<Provider, CapabilityMap>> = {
  minio: capabilityMap({
    ...S3_CORE,
    versioning: 'supported',
    objectLock: 'supported',
    lifecycle: 'supported',
    cors: 'not_supported', // MinIO applies a fixed CORS policy, not a per-bucket one
    replication: 'supported',
    notifications: 'supported',
    encryption: 'supported',
    storageClasses: 'supported',
    iamUsers: 'supported',
    iamGroups: 'supported',
    iamPolicies: 'supported',
    accessKeys: 'supported',
    accessKeyExpiry: 'supported',
    bucketQuota: 'supported',
    usageStats: 'supported',
    nodes: 'supported',
    // The Prometheus cluster endpoint; see minio/minio-metrics.client.ts.
    traffic: 'supported',
  }),

  seaweedfs: capabilityMap({
    ...S3_CORE,
    versioning: 'supported',
    // Verified against SeaweedFS 3.97: object-lock and retention calls are
    // accepted but not enforced (a GOVERNANCE-locked object deletes fine), so
    // offering the feature would promise protection that does not exist.
    objectLock: 'not_supported',
    lifecycle: 'supported',
    // Verified against SeaweedFS 3.97: PutBucketCors is accepted, unlike MinIO,
    // which answers NotImplemented.
    cors: 'supported',
    // Its IAM API is AWS-shaped but needs -iam enabled and its endpoint set.
    // Verified against chrislusf/seaweedfs:3.97: users and access keys answer,
    // every group call plus ListPolicies/GetPolicy/DeletePolicy/AttachUserPolicy
    // and UpdateAccessKey answer HTTP 501 — so groups, named policies and a key
    // status change are a permanent no, not a missing endpoint.
    iamUsers: 'not_configured',
    iamGroups: 'not_supported',
    iamPolicies: 'not_supported',
    accessKeys: 'not_configured',
    accessKeyExpiry: 'not_supported',
    usageStats: 'supported',
  }),

  aws: capabilityMap({
    ...S3_CORE,
    versioning: 'supported',
    objectLock: 'supported',
    lifecycle: 'supported',
    cors: 'supported',
    replication: 'supported',
    notifications: 'supported',
    encryption: 'supported',
    storageClasses: 'supported',
    iamUsers: 'supported',
    iamGroups: 'supported',
    iamPolicies: 'supported',
    accessKeys: 'supported',
    // IAM keys never expire on their own; storage-io tracks the expiry itself
    // and the scheduler deactivates the key, which is a real capability.
    accessKeyExpiry: 'supported',
    // AWS has no bucket quota; storage-io stores an alert-only one instead.
    bucketQuota: 'not_supported',
    usageStats: 'supported',
  }),

  ceph: capabilityMap({
    ...S3_CORE,
    versioning: 'supported',
    objectLock: 'supported',
    lifecycle: 'supported',
    cors: 'supported',
    replication: 'supported',
    notifications: 'supported',
    encryption: 'supported',
    storageClasses: 'supported',
    // The RGW Admin Ops API needs its own endpoint and a capable user. RGW has
    // no groups, and its IAM-compatible policy endpoint is not implemented in
    // storage-io — see ceph-iam.driver.ts. A key cannot be deactivated, only
    // removed, so an app-tracked expiry has nothing to act on.
    iamUsers: 'not_configured',
    iamGroups: 'not_supported',
    iamPolicies: 'not_supported',
    accessKeys: 'not_configured',
    accessKeyExpiry: 'not_supported',
    bucketQuota: 'not_configured',
    usageStats: 'not_configured',
  }),

  garage: capabilityMap({
    ...S3_CORE,
    versioning: 'not_supported',
    lifecycle: 'supported',
    cors: 'supported',
    // The Garage admin API needs its endpoint and a bearer token. Garage has no
    // users of its own: a key *is* the identity, which is what iamUsers maps to
    // here. No groups, no named policies, and a key cannot be deactivated.
    iamUsers: 'not_configured',
    iamGroups: 'not_supported',
    iamPolicies: 'not_supported',
    accessKeys: 'not_configured',
    accessKeyExpiry: 'not_supported',
    bucketQuota: 'not_configured',
    usageStats: 'not_configured',
    nodes: 'not_configured',
  }),

  r2: capabilityMap({
    ...S3_CORE,
    versioning: 'not_supported',
    lifecycle: 'supported',
    cors: 'supported',
    // R2 keys are managed in the Cloudflare dashboard, not over S3.
  }),

  wasabi: capabilityMap({
    ...S3_CORE,
    versioning: 'supported',
    objectLock: 'supported',
    lifecycle: 'supported',
    cors: 'supported',
    encryption: 'supported',
    // Wasabi's IAM API is AWS-shaped, on iam.wasabisys.com.
    iamUsers: 'not_configured',
    iamGroups: 'not_configured',
    iamPolicies: 'not_configured',
    accessKeys: 'not_configured',
    accessKeyExpiry: 'not_configured',
    usageStats: 'not_configured',
  }),

  /**
   * An unknown S3 implementation. Everything beyond the core starts unknown and
   * is settled by probing, which is the only honest default.
   */
  generic: capabilityMap({
    ...S3_CORE,
    versioning: 'not_configured',
    objectLock: 'not_configured',
    lifecycle: 'not_configured',
    cors: 'not_configured',
    replication: 'not_configured',
    notifications: 'not_configured',
    storageClasses: 'not_configured',
  }),
};
