import { sql, type Column, type SQL } from 'drizzle-orm';

/**
 * Substring search over a text column, with the wildcards in the needle treated
 * as text.
 *
 * `%` and `_` are LIKE's own wildcards and `\` is nothing at all unless an
 * `ESCAPE` clause names it — so escaping the needle without emitting that clause,
 * which is what the code here used to do, turned a search for `a_b` into a search
 * for `a\`-then-any-character-then-`b`. SQLite matches nothing for it, and a
 * search for `100%` quietly matched every row.
 *
 * Both halves therefore live in one place: the needle is escaped and the clause
 * that gives the escape character meaning is emitted with it.
 */
const ESCAPE_CHARACTER = '\\';

/** `%` and `_` are wildcards in LIKE; a search for "a_b" must mean "a_b". */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `${ESCAPE_CHARACTER}${character}`);
}

/**
 * `column LIKE '%needle%' ESCAPE '\'` with the needle escaped and parameterised.
 *
 * The needle is a bound parameter, never interpolated — the only thing written
 * into the statement text is the fixed escape clause.
 */
export function likeEscaped(column: Column, needle: string): SQL {
  const pattern = `%${escapeLike(needle)}%`;
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}
