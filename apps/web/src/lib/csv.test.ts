import { describe, expect, it } from 'vitest';
import { timestampedFilename, toCsv } from './csv';

describe('toCsv', () => {
  it('quotes a cell that contains a comma, a quote or a newline', () => {
    const csv = toCsv([['plain', 'has,comma', 'has"quote', 'has\nnewline']]);
    expect(csv).toContain('plain,"has,comma","has""quote","has\nnewline"');
  });

  it('neutralises a formula, because a bucket name is operator input', () => {
    // `=HYPERLINK(...)` in a downloaded CSV runs in the spreadsheet that opens it.
    const csv = toCsv([['=HYPERLINK("http://evil","click")']]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
  });

  it('starts with a byte-order mark, or Excel misreads UTF-8', () => {
    expect(toCsv([['a']]).startsWith('﻿')).toBe(true);
  });

  it('separates rows with CRLF, as RFC 4180 asks', () => {
    expect(toCsv([['a'], ['b']])).toBe('﻿a\r\nb\r\n');
  });
});

describe('timestampedFilename', () => {
  it('names the file after the day it was taken, so downloads sort', () => {
    expect(timestampedFilename('buckets', 'csv', new Date('2026-09-28T22:15:00Z'))).toBe(
      'buckets-2026-09-28.csv',
    );
  });
});
