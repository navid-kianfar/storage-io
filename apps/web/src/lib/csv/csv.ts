/**
 * CSV building and downloading, for the pages that offer "Export CSV" without a
 * server-side `export.csv` endpoint — and for saving the ones that have it.
 *
 * Values are escaped the RFC 4180 way (double the quote, wrap when the cell holds
 * a comma, a quote or a newline). Numbers and dates are formatted by the caller
 * through `useFormat()`, never here: a CSV cell follows the installation's region
 * settings like every other value in the app.
 */

const CSV_MIME = 'text/csv;charset=utf-8';
const NEEDS_QUOTING = /[",\n\r]/;

export type CsvCell = string | number | boolean | null | undefined;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\n');
}

/** `activity-2026-09-28.csv` — a stable, sortable name the operator can find again. */
export function csvFileName(prefix: string, date = new Date()): string {
  return `${prefix}-${date.toISOString().slice(0, 10)}.csv`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv(csv: string, fileName: string): void {
  downloadBlob(new Blob([csv], { type: CSV_MIME }), fileName);
}

export function downloadText(text: string, fileName: string, mime: string): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), fileName);
}
