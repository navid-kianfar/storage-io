/**
 * CSV the operator opens in a spreadsheet.
 *
 * Two things this gets right that a `join(',')` does not:
 *
 * - quoting: a value containing a comma, a quote or a newline is quoted and its
 *   quotes doubled, which is what RFC 4180 asks for;
 * - formula injection: a cell starting with `=`, `+`, `-`, `@`, a tab or a
 *   carriage return is prefixed with an apostrophe. A bucket name is operator
 *   input, and `=HYPERLINK(...)` in a downloaded file is a real attack on whoever
 *   opens it in Excel.
 */

const RISKY_FIRST_CHARACTERS = ['=', '+', '-', '@', '\t', '\r'];
const NEEDS_QUOTING = /["\n\r,;]/;
/** Excel only reads UTF-8 correctly when the file starts with a byte-order mark. */
const BYTE_ORDER_MARK = '﻿';

function escapeCell(value: string): string {
  const guarded = RISKY_FIRST_CHARACTERS.includes(value.charAt(0)) ? `'${value}` : value;
  if (!NEEDS_QUOTING.test(guarded)) return guarded;
  const doubled = guarded.replaceAll('"', '""');
  return `"${doubled}"`;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  const lines = rows.map((row) => row.map(escapeCell).join(','));
  return BYTE_ORDER_MARK + lines.join('\r\n') + '\r\n';
}

/**
 * Hands the browser a file to save. The object URL is revoked on the next tick:
 * revoking it synchronously cancels the download in Safari.
 */
export function downloadTextFile(filename: string, text: string, mimeType = 'text/csv'): void {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `buckets-2026-09-28.csv` — a name that sorts and says when it was taken. */
export function timestampedFilename(base: string, extension: string, now = new Date()): string {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  return `${base}-${day}.${extension}`;
}
