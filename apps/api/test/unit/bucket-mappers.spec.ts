import { describe, expect, it } from 'vitest';
import type { FilterRuleName } from '@aws-sdk/client-s3';
import type { CorsRule, NotificationTarget, ReplicationRule } from '@storage-io/contracts';
import { fromS3Cors, toS3Cors, toS3CorsRule } from '../../src/modules/buckets/mappers/cors.mapper';
import {
  fromS3Notifications,
  toS3Notifications,
} from '../../src/modules/buckets/mappers/notifications.mapper';
import {
  fromS3Replication,
  toS3Replication,
} from '../../src/modules/buckets/mappers/replication.mapper';

describe('CORS mapper', () => {
  const rule: CorsRule = {
    allowedOrigins: ['https://app.example.com'],
    allowedMethods: ['GET', 'PUT'],
    allowedHeaders: ['*'],
    exposeHeaders: ['ETag'],
    maxAgeSeconds: 3600,
  };

  it('round-trips a full rule', () => {
    expect(fromS3Cors(toS3Cors([rule]))).toEqual([rule]);
  });

  it('round-trips a rule with no optional lists and no max age', () => {
    const minimal: CorsRule = {
      allowedOrigins: ['*'],
      allowedMethods: ['GET'],
      allowedHeaders: [],
      exposeHeaders: [],
      maxAgeSeconds: null,
    };
    expect(fromS3Cors(toS3Cors([minimal]))).toEqual([minimal]);
  });

  it('omits MaxAgeSeconds rather than sending zero', () => {
    // `0` tells the browser not to cache the preflight at all, which is a
    // different instruction from "you decide".
    const sent = toS3CorsRule({ ...rule, maxAgeSeconds: null });
    expect(sent.MaxAgeSeconds).toBeUndefined();
    expect('MaxAgeSeconds' in sent && sent.MaxAgeSeconds === 0).toBe(false);
  });

  it('omits empty header lists rather than sending empty arrays', () => {
    const sent = toS3CorsRule({ ...rule, allowedHeaders: [], exposeHeaders: [] });
    expect(sent.AllowedHeaders).toBeUndefined();
    expect(sent.ExposeHeaders).toBeUndefined();
  });
});

describe('replication mapper', () => {
  const rule: ReplicationRule = {
    id: 'to-dr',
    enabled: true,
    prefix: 'critical/',
    destination: { bucketArn: 'arn:aws:s3:::dr-bucket', storageClass: 'STANDARD_IA' },
    deleteMarkers: true,
    priority: 1,
  };

  it('round-trips a rule', () => {
    expect(fromS3Replication(toS3Replication([rule]))).toEqual([rule]);
  });

  it('round-trips a disabled rule without a storage class', () => {
    const plain: ReplicationRule = {
      ...rule,
      enabled: false,
      deleteMarkers: false,
      destination: { bucketArn: 'arn:aws:s3:::dr-bucket', storageClass: null },
    };
    expect(fromS3Replication(toS3Replication([plain]))).toEqual([plain]);
  });

  it('always sends DeleteMarkerReplication, which S3 requires alongside Filter', () => {
    const configuration = toS3Replication([{ ...rule, deleteMarkers: false }]);
    expect(configuration.Rules?.[0]?.DeleteMarkerReplication).toEqual({ Status: 'Disabled' });
  });

  it('reads the v1 schema, where Prefix sat on the rule itself', () => {
    const read = fromS3Replication({
      Role: '',
      Rules: [{ ID: 'legacy', Status: 'Enabled', Prefix: 'old/', Destination: { Bucket: 'b' } }],
    });
    expect(read[0]?.prefix).toBe('old/');
  });

  it('reports no rules for an absent configuration', () => {
    expect(fromS3Replication(undefined)).toEqual([]);
  });
});

describe('notifications mapper', () => {
  const targets: readonly NotificationTarget[] = [
    {
      id: 'queue-1',
      arn: 'arn:minio:sqs::primary:webhook',
      kind: 'queue',
      events: ['s3:ObjectCreated:*'],
      prefix: 'incoming/',
      suffix: '.csv',
    },
    {
      id: 'topic-1',
      arn: 'arn:aws:sns:us-east-1:123456789012:alerts',
      kind: 'topic',
      events: ['s3:ObjectRemoved:*'],
      prefix: '',
      suffix: '',
    },
    {
      id: 'lambda-1',
      arn: 'arn:aws:lambda:us-east-1:123456789012:function:thumb',
      kind: 'lambda',
      events: ['s3:ObjectCreated:Put'],
      prefix: 'images/',
      suffix: '',
    },
  ];

  it('round-trips all three destination kinds', () => {
    expect(fromS3Notifications(toS3Notifications(targets))).toEqual(targets);
  });

  it('writes the prefix and suffix as lowercase filter rule names', () => {
    const configuration = toS3Notifications([targets[0] as NotificationTarget]);
    expect(configuration.QueueConfigurations?.[0]?.Filter?.Key?.FilterRules).toEqual([
      { Name: 'prefix', Value: 'incoming/' },
      { Name: 'suffix', Value: '.csv' },
    ]);
  });

  it('sends empty arrays for the kinds with no targets, so a removal takes effect', () => {
    // An omitted key leaves the provider's existing configuration of that kind in
    // place on some implementations, which makes "remove the last target" a no-op.
    const configuration = toS3Notifications([]);
    expect(configuration.QueueConfigurations).toEqual([]);
    expect(configuration.TopicConfigurations).toEqual([]);
    expect(configuration.LambdaFunctionConfigurations).toEqual([]);
  });

  it('reads a capitalised filter rule name, which some providers write', () => {
    const read = fromS3Notifications({
      QueueConfigurations: [
        {
          Id: 'q',
          QueueArn: 'arn:x',
          Events: ['s3:ObjectCreated:*'],
          // The SDK's union only lists the lowercase names, but a provider can and
          // does send "Prefix"; tolerating it is the point of this test.
          Filter: { Key: { FilterRules: [{ Name: 'Prefix' as FilterRuleName, Value: 'a/' }] } },
        },
      ],
    });
    expect(read[0]?.prefix).toBe('a/');
  });

  it('reports no targets for an absent configuration', () => {
    expect(fromS3Notifications(undefined)).toEqual([]);
  });
});
