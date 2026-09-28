/**
 * Glob matching for job filters (`JobFilters.glob`) and IAM `StringLike`
 * conditions. Both sides need the same answer: the web app previews which keys
 * a job would touch, the API decides which keys it actually touches.
 *
 * Supported: `*` (any run of characters), `?` (one character), `[abc]` /
 * `[a-z]` / `[!abc]` character classes, `{a,b}` alternation. `/` is an ordinary
 * character — object keys are not paths, so `*` crosses separators, which is
 * what S3 prefix semantics imply.
 */

const REGEX_SPECIAL = /[.+^$()|\\]/;

const escapeLiteral = (char: string): string => (REGEX_SPECIAL.test(char) ? `\\${char}` : char);

/** Translate a glob into an anchored regular expression source. */
export function globToRegExpSource(glob: string): string {
  let source = '^';
  let index = 0;
  // Depth of open `{…}` groups, so a `,` only alternates inside one.
  let braceDepth = 0;

  while (index < glob.length) {
    const char = glob.charAt(index);

    if (char === '\\' && index + 1 < glob.length) {
      source += escapeLiteral(glob.charAt(index + 1));
      index += 2;
      continue;
    }

    switch (char) {
      case '*':
        source += '.*';
        index += 1;
        break;
      case '?':
        source += '.';
        index += 1;
        break;
      case '[': {
        const closing = findClosingBracket(glob, index);
        if (closing === -1) {
          source += '\\[';
          index += 1;
          break;
        }
        const body = glob.slice(index + 1, closing);
        const negated = body.startsWith('!') || body.startsWith('^');
        const set = negated ? body.slice(1) : body;
        source += `[${negated ? '^' : ''}${set.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
        index = closing + 1;
        break;
      }
      case '{':
        braceDepth += 1;
        source += '(?:';
        index += 1;
        break;
      case '}':
        if (braceDepth > 0) {
          braceDepth -= 1;
          source += ')';
        } else {
          source += '\\}';
        }
        index += 1;
        break;
      case ',':
        source += braceDepth > 0 ? '|' : ',';
        index += 1;
        break;
      default:
        source += escapeLiteral(char);
        index += 1;
        break;
    }
  }

  // An unterminated `{` would produce an invalid group; close what is left open.
  source += ')'.repeat(braceDepth);
  return `${source}$`;
}

function findClosingBracket(glob: string, openIndex: number): number {
  // A `]` immediately after `[` or `[!` is a literal, so start past it.
  let index = openIndex + 1;
  if (glob[index] === '!' || glob[index] === '^') index += 1;
  if (glob[index] === ']') index += 1;
  for (; index < glob.length; index += 1) {
    if (glob[index] === ']') return index;
  }
  return -1;
}

export interface GlobOptions {
  /** Case-insensitive matching. Off by default: S3 keys are case-sensitive. */
  readonly caseInsensitive?: boolean;
}

/** Compile a glob once when it will be tested against many candidates. */
export function compileGlob(glob: string, options: GlobOptions = {}): RegExp {
  return new RegExp(globToRegExpSource(glob), options.caseInsensitive === true ? 'i' : '');
}

export function matchesGlob(glob: string, value: string, options: GlobOptions = {}): boolean {
  const pattern = compileGlob(glob, options);
  return pattern.test(value);
}

/** True when any of the globs matches. An empty list matches nothing. */
export function matchesAnyGlob(
  globs: readonly string[],
  value: string,
  options: GlobOptions = {},
): boolean {
  return globs.some((glob) => matchesGlob(glob, value, options));
}
