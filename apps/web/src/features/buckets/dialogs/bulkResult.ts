import type { BucketBulkResponse } from '@storage-io/contracts';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';

const MAX_LISTED_FAILURES = 5;

/**
 * `POST /buckets/bulk` answers per bucket, so "it worked" and "it failed" are not
 * the only two outcomes. This reports the third one honestly: how many succeeded,
 * and which ones did not and why.
 *
 * `keyPrefix` is the page's key group (`buckets.bulk`), so the same reporting
 * serves quota, tags, access and delete without four copies of it.
 */
export function reportBulkResult(
  response: BucketBulkResponse,
  t: TFunction,
  keyPrefix: string,
): void {
  const failures = response.results.filter((result) => !result.ok);
  const okCount = response.results.length - failures.length;

  if (failures.length === 0) {
    toast.success(t(`${keyPrefix}.applied`, { count: okCount }));
    return;
  }

  const listed = failures.slice(0, MAX_LISTED_FAILURES);
  const description = listed
    .map((failure) => `${failure.bucket}: ${failure.message ?? ''}`.trim())
    .join('\n');

  if (okCount === 0) {
    toast.error(t(`${keyPrefix}.noneApplied`), { description });
    return;
  }

  toast.warning(t(`${keyPrefix}.partial`, { ok: okCount, total: response.results.length }), {
    description,
  });
}
