import type { CORSRule } from '@aws-sdk/client-s3';
import type { CorsRule } from '@storage-io/contracts';

/**
 * `CorsRule` ⇄ S3 `CORSRule`. Nearly one to one; the work is in the nulls.
 *
 * `maxAgeSeconds: null` is "let the browser decide", so the field is omitted
 * rather than sent as `0` — `0` tells the browser not to cache the preflight at
 * all, which is a different instruction.
 */

export function toS3CorsRule(rule: CorsRule): CORSRule {
  return {
    AllowedOrigins: [...rule.allowedOrigins],
    AllowedMethods: [...rule.allowedMethods],
    AllowedHeaders: rule.allowedHeaders.length === 0 ? undefined : [...rule.allowedHeaders],
    ExposeHeaders: rule.exposeHeaders.length === 0 ? undefined : [...rule.exposeHeaders],
    MaxAgeSeconds: rule.maxAgeSeconds ?? undefined,
  };
}

export function fromS3CorsRule(rule: CORSRule): CorsRule {
  return {
    allowedOrigins: [...(rule.AllowedOrigins ?? [])],
    allowedMethods: [...(rule.AllowedMethods ?? [])],
    allowedHeaders: [...(rule.AllowedHeaders ?? [])],
    exposeHeaders: [...(rule.ExposeHeaders ?? [])],
    maxAgeSeconds: rule.MaxAgeSeconds ?? null,
  };
}

export const toS3Cors = (rules: readonly CorsRule[]): readonly CORSRule[] =>
  rules.map(toS3CorsRule);

export const fromS3Cors = (rules: readonly CORSRule[]): readonly CorsRule[] =>
  rules.map(fromS3CorsRule);
