/**
 * An explicit set of keys as a job filter.
 *
 * A bulk job describes its work with `JobFilters`, which has a prefix, dates,
 * sizes, tags and a glob — but no "these exact keys" field. The glob dialect in
 * `@storage-io/contracts` supports `{a,b}` alternation and `\` escaping, so a
 * selection is expressible: `{raw/a.jpg,raw/b.png}` matches those two keys and
 * nothing else, and the API evaluates it with the same helper the browser previews
 * it with.
 *
 * This is what "run the selection as a bulk job" sends, and it is the reason the
 * browser never loops per object to tag, re-class or retain a selection: one
 * request describes the whole set.
 */

const GLOB_SPECIAL = ['\\', '{', '}', ',', '*', '?', '[', ']'];

export function escapeGlobLiteral(value: string): string {
  let escaped = '';
  for (const char of value) {
    escaped += GLOB_SPECIAL.includes(char) ? `\\${char}` : char;
  }
  return escaped;
}

export function keysToGlob(keys: readonly string[]): string {
  if (keys.length === 0) return '';
  const escaped = keys.map(escapeGlobLiteral);
  if (escaped.length === 1) return escaped[0] ?? '';
  return `{${escaped.join(',')}}`;
}
