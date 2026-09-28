import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, csvRow } from '../../src/common/csv';

describe('csvCell', () => {
  it('passes a plain value through', () => {
    expect(csvCell('reports')).toBe('reports');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(true)).toBe('true');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a value containing a comma, a quote or a newline', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('neutralises a value a spreadsheet would run as a formula', () => {
    // The activity log holds attacker-influenced strings — object keys, bucket
    // names, S3 user names — and a leading =, +, - or @ is executed on open.
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('=cmd|"/c calc"!A1')).toBe('"\'=cmd|""/c calc""!A1"');
  });

  it('does not guard a value that merely contains those characters', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('user@example.com')).toBe('user@example.com');
  });

  it('serialises an object as JSON in one quoted cell', () => {
    expect(csvCell({ a: 1, b: 'x' })).toBe('"{""a"":1,""b"":""x""}"');
  });
});

describe('csvRow', () => {
  it('joins cells with commas and ends with CRLF, as RFC 4180 says', () => {
    expect(csvRow(['a', 'b,c', null])).toBe('a,"b,c",\r\n');
  });

  it('CSV_BOM is a single UTF-8 BOM, so Excel reads non-ASCII names', () => {
    expect(CSV_BOM).toBe('\uFEFF');
    expect(CSV_BOM).toHaveLength(1);
  });
});
