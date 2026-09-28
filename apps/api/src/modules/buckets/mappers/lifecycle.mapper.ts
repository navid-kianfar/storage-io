import type {
  LifecycleRule as S3LifecycleRule,
  LifecycleRuleFilter,
  Tag,
  TransitionStorageClass,
} from '@aws-sdk/client-s3';
import type { LifecycleRule } from '@storage-io/contracts';

/**
 * `LifecycleRule` ⇄ the S3 lifecycle configuration, both directions.
 *
 * The contract is a flat rule because that is what the dialog edits; S3's shape is
 * a tree with three ways to spell a filter and a handful of mutually exclusive
 * fields. Two decisions are worth knowing:
 *
 * - **`Filter` is always sent, never the deprecated top-level `Prefix`.** Reading
 *   still accepts `Prefix`, because a rule written years ago by another tool uses
 *   it and silently dropping the prefix would widen the rule to the whole bucket.
 * - **`Days` and `ExpiredObjectDeleteMarker` cannot both be set** — S3 rejects the
 *   configuration. A rule that asks for both is sent as a day-based expiry, which
 *   is the stronger of the two and already removes delete markers as it goes.
 *
 * **Known provider gap.** MinIO (verified on DEVELOPMENT.2025-05-24T17-08-30Z)
 * accepts `AbortIncompleteMultipartUpload` alongside an expiry and then omits it
 * from `GetBucketLifecycleConfiguration`, and rejects a rule that carries only that
 * action as schema-invalid. So `abortMultipartDays` is sent faithfully but reads
 * back as `null` on MinIO. It is not dropped here, because the providers that do
 * keep it — AWS, Ceph — should get it.
 */

const STATUS_ENABLED = 'Enabled';
const STATUS_DISABLED = 'Disabled';

export function toS3LifecycleRule(rule: LifecycleRule): S3LifecycleRule {
  const transition =
    rule.transition === null
      ? undefined
      : [
          {
            Days: rule.transition.days,
            // The SDK types this as its own enum of known classes; a provider's own
            // class name (MinIO and Ceph both allow custom ones) is a valid value
            // the union does not list, so the contract keeps it a string.
            StorageClass: rule.transition.storageClass as TransitionStorageClass,
          },
        ];

  return {
    ID: rule.id,
    Status: rule.enabled ? STATUS_ENABLED : STATUS_DISABLED,
    Filter: toS3Filter(rule.prefix, rule.tags),
    Expiration: toS3Expiration(rule),
    NoncurrentVersionExpiration:
      rule.noncurrentExpireDays === null
        ? undefined
        : { NoncurrentDays: rule.noncurrentExpireDays },
    AbortIncompleteMultipartUpload:
      rule.abortMultipartDays === null
        ? undefined
        : { DaysAfterInitiation: rule.abortMultipartDays },
    Transitions: transition,
  };
}

export function fromS3LifecycleRule(rule: S3LifecycleRule, index: number): LifecycleRule {
  const filter = readFilter(rule);
  const transition = (rule.Transitions ?? [])[0];

  return {
    // A rule with no ID is legal in S3 but not in the contract, and the UI needs a
    // stable key; its position is the only stable thing left.
    id: rule.ID ?? `rule-${index + 1}`,
    enabled: rule.Status === STATUS_ENABLED,
    prefix: filter.prefix,
    tags: filter.tags,
    expireDays: rule.Expiration?.Days ?? null,
    noncurrentExpireDays: rule.NoncurrentVersionExpiration?.NoncurrentDays ?? null,
    abortMultipartDays: rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
    transition:
      transition === undefined || transition.StorageClass === undefined
        ? null
        : { days: transition.Days ?? 0, storageClass: transition.StorageClass },
    expiredDeleteMarkers: rule.Expiration?.ExpiredObjectDeleteMarker === true,
  };
}

export const toS3Lifecycle = (rules: readonly LifecycleRule[]): readonly S3LifecycleRule[] =>
  rules.map(toS3LifecycleRule);

export const fromS3Lifecycle = (rules: readonly S3LifecycleRule[]): readonly LifecycleRule[] =>
  rules.map(fromS3LifecycleRule);

/* ------------------------------ internals ------------------------- */

function toS3Expiration(rule: LifecycleRule): S3LifecycleRule['Expiration'] {
  if (rule.expireDays !== null) return { Days: rule.expireDays };
  if (rule.expiredDeleteMarkers) return { ExpiredObjectDeleteMarker: true };
  return undefined;
}

/**
 * S3 has three filter shapes and picks by how many conditions there are: a bare
 * `Prefix`, a bare `Tag`, or `And` for a combination. Sending `And` with one
 * member is rejected, which is why this is a decision tree rather than one shape.
 */
function toS3Filter(prefix: string, tags: Readonly<Record<string, string>>): LifecycleRuleFilter {
  const tagList: readonly Tag[] = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  const hasPrefix = prefix.length > 0;

  if (tagList.length === 0) return { Prefix: prefix };
  if (tagList.length === 1 && !hasPrefix) return { Tag: tagList[0] };
  if (tagList.length === 1 && hasPrefix) {
    return { And: { Prefix: prefix, Tags: [...tagList] } };
  }
  return { And: { ...(hasPrefix ? { Prefix: prefix } : {}), Tags: [...tagList] } };
}

interface ReadFilter {
  readonly prefix: string;
  readonly tags: Record<string, string>;
}

function readFilter(rule: S3LifecycleRule): ReadFilter {
  // The deprecated top-level Prefix, still written by older tools.
  const legacyPrefix = (rule as { Prefix?: string }).Prefix;
  const filter = rule.Filter;

  if (filter === undefined) return { prefix: legacyPrefix ?? '', tags: {} };

  if (filter.And !== undefined) {
    return { prefix: filter.And.Prefix ?? legacyPrefix ?? '', tags: tagsOf(filter.And.Tags) };
  }
  if (filter.Tag !== undefined) {
    return { prefix: legacyPrefix ?? '', tags: tagsOf([filter.Tag]) };
  }
  return { prefix: filter.Prefix ?? legacyPrefix ?? '', tags: {} };
}

function tagsOf(tags: readonly Tag[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (tag.Key === undefined) continue;
    result[tag.Key] = tag.Value ?? '';
  }
  return result;
}
