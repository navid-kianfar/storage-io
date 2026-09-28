import type {
  ReplicationConfiguration,
  ReplicationRule as S3ReplicationRule,
  StorageClass,
} from '@aws-sdk/client-s3';
import type { ReplicationRule } from '@storage-io/contracts';

/**
 * `ReplicationRule` ⇄ S3 replication configuration.
 *
 * **`Role` is sent empty.** The contract has no role field, because the providers
 * in scope that actually replicate (MinIO, Ceph) authenticate the destination
 * through their own configured remote target rather than an assumed IAM role. On
 * AWS S3 a replication configuration without a role ARN is rejected, so
 * replication there is not something this endpoint can set up today — that needs a
 * contract field, which is a decision for whoever adds AWS replication rather than
 * a value to invent here.
 */

const STATUS_ENABLED = 'Enabled';
const STATUS_DISABLED = 'Disabled';
const NO_ROLE = '';

export function toS3ReplicationRule(rule: ReplicationRule): S3ReplicationRule {
  return {
    ID: rule.id,
    Status: rule.enabled ? STATUS_ENABLED : STATUS_DISABLED,
    Priority: rule.priority,
    Filter: { Prefix: rule.prefix },
    // Required alongside Filter: without it S3 applies the v1 schema, where
    // Prefix was top-level, and rejects the request.
    DeleteMarkerReplication: { Status: rule.deleteMarkers ? STATUS_ENABLED : STATUS_DISABLED },
    Destination: {
      Bucket: rule.destination.bucketArn,
      // Cast for the same reason as the lifecycle transition: providers allow
      // storage-class names the SDK's union does not enumerate.
      StorageClass: (rule.destination.storageClass ?? undefined) as StorageClass | undefined,
    },
  };
}

export function fromS3ReplicationRule(rule: S3ReplicationRule, index: number): ReplicationRule {
  return {
    id: rule.ID ?? `rule-${index + 1}`,
    enabled: rule.Status === STATUS_ENABLED,
    prefix: prefixOf(rule),
    destination: {
      bucketArn: rule.Destination?.Bucket ?? '',
      storageClass: rule.Destination?.StorageClass ?? null,
    },
    deleteMarkers: rule.DeleteMarkerReplication?.Status === STATUS_ENABLED,
    priority: rule.Priority ?? index,
  };
}

export const toS3Replication = (rules: readonly ReplicationRule[]): ReplicationConfiguration => ({
  Role: NO_ROLE,
  Rules: rules.map(toS3ReplicationRule),
});

export const fromS3Replication = (
  configuration: ReplicationConfiguration | undefined,
): readonly ReplicationRule[] => (configuration?.Rules ?? []).map(fromS3ReplicationRule);

/* ------------------------------ internals ------------------------- */

function prefixOf(rule: S3ReplicationRule): string {
  const filter = rule.Filter;
  if (filter?.And?.Prefix !== undefined) return filter.And.Prefix;
  if (filter?.Prefix !== undefined) return filter.Prefix;
  // The v1 schema put Prefix on the rule itself.
  return (rule as { Prefix?: string }).Prefix ?? '';
}
