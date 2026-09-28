/**
 * Minimal RFC 4180 CSV writing, used by the activity, IAM user and access-key
 * exports.
 *
 * The leading-character guard is not cosmetic: a value starting `=`, `+`, `-` or
 * `@` is executed as a formula when the file is opened in a spreadsheet, and the
 * activity log contains attacker-influenced strings (object keys, user names).
 */

const FORMULA_STARTERS = new Set(['=', '+', '-', '@', '\t', '\r']);
const NEEDS_QUOTING = /[",\n\r]/;

/** Every case named, so nothing reaches a cell as `[object Object]`. */
function textOf(value: NonNullable<unknown>): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = textOf(value);

  const first = text.slice(0, 1);
  const guarded = FORMULA_STARTERS.has(first) ? `'${text}` : text;

  if (!NEEDS_QUOTING.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function csvRow(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** A UTF-8 BOM, so Excel opens non-ASCII names correctly. */
export const CSV_BOM = '\uFEFF';

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

export const csvFilenameHeader = (filename: string): string =>
  `attachment; filename="${filename.replace(/["\\]/g, '')}"`;
