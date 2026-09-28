import type {
  Event as S3Event,
  FilterRuleName,
  LambdaFunctionConfiguration,
  NotificationConfiguration,
  NotificationConfigurationFilter,
  QueueConfiguration,
  TopicConfiguration,
} from '@aws-sdk/client-s3';
import type { NotificationTarget, NotificationTargetKind } from '@storage-io/contracts';

/**
 * `NotificationTarget` ⇄ S3 `NotificationConfiguration`.
 *
 * S3 splits destinations into three parallel arrays by kind and names the ARN
 * field differently in each; the contract has one list with a `kind`. The
 * prefix/suffix pair is S3's `Filter.Key.FilterRules`, whose `Name` is the
 * lowercase word `prefix` or `suffix` — not a header-style name, and not
 * capitalised, which some providers are strict about.
 */

const FILTER_PREFIX = 'prefix';
const FILTER_SUFFIX = 'suffix';

export function toS3Notifications(
  targets: readonly NotificationTarget[],
): NotificationConfiguration {
  const queues: QueueConfiguration[] = [];
  const topics: TopicConfiguration[] = [];
  const lambdas: LambdaFunctionConfiguration[] = [];

  for (const target of targets) {
    const shared = {
      Id: target.id,
      Events: target.events as S3Event[],
      Filter: toS3Filter(target),
    };

    switch (target.kind) {
      case 'queue':
        queues.push({ ...shared, QueueArn: target.arn });
        break;
      case 'topic':
        topics.push({ ...shared, TopicArn: target.arn });
        break;
      case 'lambda':
        lambdas.push({ ...shared, LambdaFunctionArn: target.arn });
        break;
    }
  }

  // Empty arrays rather than omitted keys: an omitted key leaves the provider's
  // existing configuration of that kind in place on some implementations, which
  // would make "remove the last queue target" silently do nothing.
  return {
    QueueConfigurations: queues,
    TopicConfigurations: topics,
    LambdaFunctionConfigurations: lambdas,
  };
}

export function fromS3Notifications(
  configuration: NotificationConfiguration | undefined,
): readonly NotificationTarget[] {
  if (configuration === undefined) return [];

  return [
    ...(configuration.QueueConfigurations ?? []).map((entry, index) =>
      toTarget('queue', entry.Id, entry.QueueArn, entry.Events, entry.Filter, index),
    ),
    ...(configuration.TopicConfigurations ?? []).map((entry, index) =>
      toTarget('topic', entry.Id, entry.TopicArn, entry.Events, entry.Filter, index),
    ),
    ...(configuration.LambdaFunctionConfigurations ?? []).map((entry, index) =>
      toTarget('lambda', entry.Id, entry.LambdaFunctionArn, entry.Events, entry.Filter, index),
    ),
  ];
}

/* ------------------------------ internals ------------------------- */

function toS3Filter(target: NotificationTarget): NotificationConfigurationFilter | undefined {
  const rules = [
    ...(target.prefix.length > 0
      ? [{ Name: FILTER_PREFIX as FilterRuleName, Value: target.prefix }]
      : []),
    ...(target.suffix.length > 0
      ? [{ Name: FILTER_SUFFIX as FilterRuleName, Value: target.suffix }]
      : []),
  ];
  if (rules.length === 0) return undefined;
  return { Key: { FilterRules: rules } };
}

function toTarget(
  kind: NotificationTargetKind,
  id: string | undefined,
  arn: string | undefined,
  events: readonly S3Event[] | undefined,
  filter: NotificationConfigurationFilter | undefined,
  index: number,
): NotificationTarget {
  const rules = filter?.Key?.FilterRules ?? [];
  const valueOf = (name: string): string =>
    rules.find((rule) => rule.Name?.toLowerCase() === name)?.Value ?? '';

  return {
    id: id ?? `${kind}-${index + 1}`,
    arn: arn ?? '',
    kind,
    events: [...(events ?? [])],
    prefix: valueOf(FILTER_PREFIX),
    suffix: valueOf(FILTER_SUFFIX),
  };
}
