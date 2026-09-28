/**
 * IAM policy evaluation, shared by `POST /iam/policies/simulate` (the API runs
 * it) and the policy editor in the web app (live preview while typing).
 *
 * The model is the AWS/MinIO one, reduced to what a single-policy simulation can
 * answer:
 *
 * - An explicit `Deny` from any matching statement wins outright.
 * - Otherwise a matching `Allow` grants the request.
 * - With neither, the answer is `implicit-deny`.
 *
 * Matching rules, deliberately following AWS:
 *
 * - `Action` is matched case-insensitively; `Resource` (an ARN) case-sensitively.
 * - `*` matches any run of characters, `?` exactly one. No other glob syntax —
 *   IAM has none, and accepting more would make the preview lie.
 * - `NotAction` / `NotResource` invert their side of the match.
 * - A statement with no `Action`/`NotAction` matches no action; a statement with
 *   no `Resource`/`NotResource` matches no resource. (Trust policies, where
 *   `Resource` is implicit, are out of scope here.)
 */

export const POLICY_DECISIONS = ['allow', 'deny', 'implicit-deny'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const CONDITION_OPERATORS = ['StringEquals', 'StringLike', 'IpAddress', 'Bool'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** `{ StringEquals: { 's3:prefix': ['home/', 'shared/'] } }` */
export type ConditionBlock = Record<
  string,
  Record<string, string | boolean | readonly (string | boolean)[]>
>;

export interface PolicyStatement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Action?: string | readonly string[];
  readonly NotAction?: string | readonly string[];
  readonly Resource?: string | readonly string[];
  readonly NotResource?: string | readonly string[];
  readonly Condition?: ConditionBlock;
  readonly Principal?: unknown;
  readonly NotPrincipal?: unknown;
}

export interface PolicyDocument {
  readonly Version?: string;
  readonly Id?: string;
  readonly Statement?: PolicyStatement | readonly PolicyStatement[];
}

export interface SimulateInput {
  readonly action: string;
  readonly resource: string;
  /** Condition keys, e.g. `{ 's3:prefix': 'home/', 'aws:SourceIp': '10.0.0.7' }`. */
  readonly context?: Readonly<Record<string, string>>;
}

export interface PolicyEvaluation {
  readonly decision: PolicyDecision;
  readonly statementSid: string | null;
  readonly statementIndex: number | null;
  /**
   * Condition operators the evaluator does not implement, encountered while
   * deciding. A statement carrying one never matches, so the caller can warn
   * that the answer may be narrower than the real service's.
   */
  readonly unsupportedOperators: readonly string[];
}

const EFFECT_ALLOW = 'allow';
const EFFECT_DENY = 'deny';
const CONDITION_IF_EXISTS_SUFFIX = 'IfExists';

const toArray = <T>(value: T | readonly T[] | undefined): readonly T[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
};

/** IAM wildcards only: `*` and `?`. Everything else is a literal. */
function iamPatternToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  source += '$';
  return new RegExp(source, caseInsensitive ? 'i' : '');
}

function patternMatches(pattern: string, value: string, caseInsensitive: boolean): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return caseInsensitive ? pattern.toLowerCase() === value.toLowerCase() : pattern === value;
  }
  const expression = iamPatternToRegExp(pattern, caseInsensitive);
  return expression.test(value);
}

const anyPatternMatches = (
  patterns: readonly string[],
  value: string,
  caseInsensitive: boolean,
): boolean => patterns.some((pattern) => patternMatches(pattern, value, caseInsensitive));

/* ------------------------------------------------------------------ *
 * Conditions
 * ------------------------------------------------------------------ */

interface ConditionOutcome {
  readonly matched: boolean;
  readonly unsupported: readonly string[];
}

const CONDITION_MATCHED: ConditionOutcome = { matched: true, unsupported: [] };

function parseOperator(rawOperator: string): { operator: string; ifExists: boolean } {
  if (rawOperator.endsWith(CONDITION_IF_EXISTS_SUFFIX)) {
    return {
      operator: rawOperator.slice(0, -CONDITION_IF_EXISTS_SUFFIX.length),
      ifExists: true,
    };
  }
  return { operator: rawOperator, ifExists: false };
}

const asStrings = (value: string | boolean | readonly (string | boolean)[]): readonly string[] => {
  const values = Array.isArray(value) ? value : [value as string | boolean];
  return values.map((entry) => String(entry));
};

function ipMatches(cidrOrIp: string, address: string): boolean {
  const slash = cidrOrIp.indexOf('/');
  if (slash === -1) return cidrOrIp === address;

  const network = cidrOrIp.slice(0, slash);
  const prefixLength = Number.parseInt(cidrOrIp.slice(slash + 1), 10);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return false;

  const networkValue = ipv4ToInt(network);
  const addressValue = ipv4ToInt(address);
  if (networkValue === null || addressValue === null) return false;
  if (prefixLength === 0) return true;

  // `>>> 0` keeps the mask unsigned; a signed shift would break /1.
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return (networkValue & mask) === (addressValue & mask);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

function operatorMatches(
  operator: string,
  expected: readonly string[],
  actual: string,
): boolean | 'unsupported' {
  switch (operator) {
    case 'StringEquals':
      return expected.includes(actual);
    case 'StringLike':
      return anyPatternMatches(expected, actual, false);
    case 'IpAddress':
      return expected.some((cidr) => ipMatches(cidr, actual));
    case 'Bool': {
      const actualBool = actual.toLowerCase();
      return expected.some((entry) => entry.toLowerCase() === actualBool);
    }
    default:
      return 'unsupported';
  }
}

/** One condition key's verdict, so the caller does not need a third loop level. */
type KeyOutcome = 'matched' | 'not-matched' | 'unsupported';

function evaluateConditionKey(
  operator: string,
  ifExists: boolean,
  expectedRaw: string | boolean | readonly (string | boolean)[],
  key: string,
  context: Readonly<Record<string, string>>,
): KeyOutcome {
  const actual = lookupContextKey(context, key);
  if (actual === undefined) {
    // `…IfExists` passes when the key is absent; a plain operator does not.
    return ifExists ? 'matched' : 'not-matched';
  }

  const outcome = operatorMatches(operator, asStrings(expectedRaw), actual);
  if (outcome === 'unsupported') return 'unsupported';
  return outcome ? 'matched' : 'not-matched';
}

/** Every operator and every key in the block must match for the statement to apply. */
function evaluateConditions(
  block: ConditionBlock | undefined,
  context: Readonly<Record<string, string>>,
): ConditionOutcome {
  if (block === undefined) return CONDITION_MATCHED;

  const unsupported: string[] = [];
  let matched = true;

  for (const [rawOperator, keys] of Object.entries(block)) {
    const { operator, ifExists } = parseOperator(rawOperator);

    for (const [key, expectedRaw] of Object.entries(keys)) {
      const outcome = evaluateConditionKey(operator, ifExists, expectedRaw, key, context);
      if (outcome === 'matched') continue;

      matched = false;
      if (outcome === 'unsupported' && !unsupported.includes(rawOperator)) {
        unsupported.push(rawOperator);
      }
    }
  }

  return { matched, unsupported };
}

/** Condition keys are case-insensitive in IAM. */
function lookupContextKey(
  context: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  const direct = context[key];
  if (direct !== undefined) return direct;
  const wanted = key.toLowerCase();
  for (const [candidate, value] of Object.entries(context)) {
    if (candidate.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Statement matching
 * ------------------------------------------------------------------ */

function statementMatchesAction(statement: PolicyStatement, action: string): boolean {
  const actions = toArray(statement.Action);
  if (actions.length > 0) return anyPatternMatches(actions, action, true);

  const notActions = toArray(statement.NotAction);
  if (notActions.length > 0) return !anyPatternMatches(notActions, action, true);

  return false;
}

function statementMatchesResource(statement: PolicyStatement, resource: string): boolean {
  const resources = toArray(statement.Resource);
  if (resources.length > 0) return anyPatternMatches(resources, resource, false);

  const notResources = toArray(statement.NotResource);
  if (notResources.length > 0) return !anyPatternMatches(notResources, resource, false);

  return false;
}

/**
 * Evaluate one policy document against one action/resource pair.
 *
 * The returned `statementIndex` is the index in the document's `Statement`
 * array, so the editor can highlight the line that decided.
 */
export function evaluatePolicy(
  document: PolicyDocument | null | undefined,
  input: SimulateInput,
): PolicyEvaluation {
  const statements = toArray(document?.Statement);
  const context = input.context ?? {};
  const unsupported: string[] = [];

  let firstAllowIndex: number | null = null;

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement === undefined) continue;
    const effect = String(statement.Effect ?? '').toLowerCase();
    if (effect !== EFFECT_ALLOW && effect !== EFFECT_DENY) continue;

    if (!statementMatchesAction(statement, input.action)) continue;
    if (!statementMatchesResource(statement, input.resource)) continue;

    const conditions = evaluateConditions(statement.Condition, context);
    for (const operator of conditions.unsupported) {
      if (!unsupported.includes(operator)) unsupported.push(operator);
    }
    if (!conditions.matched) continue;

    // An explicit Deny is final, so return as soon as one matches.
    if (effect === EFFECT_DENY) {
      return {
        decision: 'deny',
        statementSid: statement.Sid ?? null,
        statementIndex: index,
        unsupportedOperators: unsupported,
      };
    }

    if (firstAllowIndex === null) firstAllowIndex = index;
  }

  if (firstAllowIndex === null) {
    return {
      decision: 'implicit-deny',
      statementSid: null,
      statementIndex: null,
      unsupportedOperators: unsupported,
    };
  }

  const allowing = statements[firstAllowIndex];
  return {
    decision: 'allow',
    statementSid: allowing?.Sid ?? null,
    statementIndex: firstAllowIndex,
    unsupportedOperators: unsupported,
  };
}

/* ------------------------------------------------------------------ *
 * Structural validation (POST /iam/policies/validate)
 * ------------------------------------------------------------------ */

export interface PolicyProblem {
  readonly path: string;
  readonly message: string;
}

export interface PolicyValidation {
  readonly valid: boolean;
  readonly errors: readonly PolicyProblem[];
  readonly warnings: readonly string[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringOrStringArray = (value: unknown): boolean =>
  typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));

/**
 * Structural checks only — it does not know any provider's action namespace.
 * Warnings carry the things worth a second look rather than a rejection.
 */
export function validatePolicyDocument(document: unknown): PolicyValidation {
  const errors: PolicyProblem[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(document)) {
    return {
      valid: false,
      errors: [{ path: '', message: 'Policy must be a JSON object.' }],
      warnings,
    };
  }

  if (document.Version !== undefined && typeof document.Version !== 'string') {
    errors.push({ path: 'Version', message: 'Version must be a string.' });
  } else if (document.Version === undefined) {
    warnings.push('No Version; providers assume the oldest policy language. Use "2012-10-17".');
  }

  const rawStatements = document.Statement;
  if (rawStatements === undefined) {
    errors.push({ path: 'Statement', message: 'Statement is required.' });
    return { valid: false, errors, warnings };
  }

  const statements = Array.isArray(rawStatements) ? rawStatements : [rawStatements];
  if (statements.length === 0) {
    errors.push({ path: 'Statement', message: 'Statement must contain at least one statement.' });
  }

  const seenSids = new Set<string>();
  statements.forEach((raw, index) => {
    validateStatement(raw, `Statement[${index}]`, seenSids, errors, warnings);
  });

  return { valid: errors.length === 0, errors, warnings };
}

/** One statement, so `validatePolicyDocument` stays readable. */
function validateStatement(
  raw: unknown,
  path: string,
  seenSids: Set<string>,
  errors: PolicyProblem[],
  warnings: string[],
): void {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'Statement must be an object.' });
    return;
  }

  const effect = raw.Effect;
  if (typeof effect !== 'string' || !['Allow', 'Deny'].includes(effect)) {
    errors.push({ path: `${path}.Effect`, message: 'Effect must be "Allow" or "Deny".' });
  }

  validateSid(raw.Sid, path, seenSids, errors);
  validateExclusivePair(raw, 'Action', 'NotAction', path, errors);
  validateExclusivePair(raw, 'Resource', 'NotResource', path, errors);

  for (const field of ['Action', 'NotAction', 'Resource', 'NotResource'] as const) {
    const value = raw[field];
    if (value !== undefined && !isStringOrStringArray(value)) {
      errors.push({
        path: `${path}.${field}`,
        message: `${field} must be a string or array of strings.`,
      });
    }
  }

  validateCondition(raw.Condition, path, errors, warnings);

  if (effect !== 'Allow') return;
  if (toArray(raw.Action as string | string[] | undefined).includes('*')) {
    warnings.push(`${path}: allows every action ("*").`);
  }
  if (toArray(raw.Resource as string | string[] | undefined).includes('*')) {
    warnings.push(`${path}: allows every resource ("*").`);
  }
}

function validateSid(
  sid: unknown,
  path: string,
  seenSids: Set<string>,
  errors: PolicyProblem[],
): void {
  if (sid === undefined) return;
  if (typeof sid !== 'string') {
    errors.push({ path: `${path}.Sid`, message: 'Sid must be a string.' });
    return;
  }
  if (seenSids.has(sid)) {
    errors.push({ path: `${path}.Sid`, message: `Duplicate Sid "${sid}".` });
    return;
  }
  seenSids.add(sid);
}

/** IAM forbids both halves of `Action`/`NotAction` and requires one of them. */
function validateExclusivePair(
  raw: Record<string, unknown>,
  positive: string,
  negative: string,
  path: string,
  errors: PolicyProblem[],
): void {
  const hasPositive = raw[positive] !== undefined;
  const hasNegative = raw[negative] !== undefined;

  if (hasPositive && hasNegative) {
    errors.push({ path, message: `A statement cannot have both ${positive} and ${negative}.` });
  }
  if (!hasPositive && !hasNegative) {
    errors.push({ path, message: `A statement needs ${positive} or ${negative}.` });
  }
}

function validateCondition(
  condition: unknown,
  path: string,
  errors: PolicyProblem[],
  warnings: string[],
): void {
  if (condition === undefined) return;
  if (!isPlainObject(condition)) {
    errors.push({ path: `${path}.Condition`, message: 'Condition must be an object.' });
    return;
  }

  for (const [rawOperator, keys] of Object.entries(condition)) {
    const { operator } = parseOperator(rawOperator);
    if (!(CONDITION_OPERATORS as readonly string[]).includes(operator)) {
      warnings.push(
        `${path}.Condition.${rawOperator}: the simulator does not evaluate this operator, so its statement never matches there.`,
      );
    }
    if (!isPlainObject(keys)) {
      errors.push({
        path: `${path}.Condition.${rawOperator}`,
        message: 'A condition operator must map condition keys to values.',
      });
    }
  }
}
