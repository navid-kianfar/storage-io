/**
 * Paging an aggregated list.
 *
 * An aggregated list cannot be paged in the database: the rows come from several
 * storage servers over the network, and `total` has to describe the whole filtered
 * set for the pager to be right. So the page is cut here, after filtering, and
 * `total` is the count before the cut.
 *
 * This is bounded by the drivers themselves — each one caps how much it will fetch
 * — so "list it all and slice" is a page of an already-limited set, not an
 * unbounded read.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length };
}

/** Case-insensitive "contains", for the `q` parameter every IAM list takes. */
export function matchesQuery(needle: string | undefined, ...fields: (string | null)[]): boolean {
  if (needle === undefined || needle.length === 0) return true;
  const wanted = needle.toLowerCase();
  return fields.some((field) => field !== null && field.toLowerCase().includes(wanted));
}
