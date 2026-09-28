import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * One flat config for the workspace's Node packages. Formatting is Prettier's job
 * — every stylistic rule is off — so what is left here is correctness and the
 * team's code standard.
 *
 * `apps/web` is **ignored** here and linted by its own `apps/web/eslint.config.js`
 * (`pnpm lint` at the root runs both). Flat configs do not cascade: a nested
 * config replaces this one for its own files rather than extending it, so the two
 * cannot be merged from here. The web config needs the React plugins, which are
 * that package's dependencies and are not resolvable from the root, and it needs
 * its own `tsconfigRootDir` for the type-aware rules. It carries this file's code
 * standard — `max-depth`, no floating promises, exhaustive switches — as its own
 * rules, so nothing here is lost by the split.
 */
export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/drizzle/**',
      '**/*.d.ts',
      // Its own flat config; see the note above.
      'apps/web/**',
    ],
  },

  js.configs.recommended,

  // Type-aware linting: the rules that catch real bugs — a forgotten await, a
  // promise nobody observes — need the type checker.
  //
  // `recommendedTypeChecked` rather than `strictTypeChecked` on purpose. The
  // strict preset adds house style (dot notation, `!` over a cast, Record over an
  // index signature) that Prettier does not cover and that this config has no
  // business imposing on every package in the workspace. The team's actual
  // standard is spelled out as explicit rules below.
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          // Config files that belong to no package tsconfig. `scripts/*.mjs` is
          // deliberately absent: those files turn type-aware linting off
          // entirely in their own block near the end of this file.
          allowDefaultProject: [
            '*.js',
            '*.mjs',
            '*.config.ts',
            '*.config.mts',
            'apps/*/vite.config.ts',
            'apps/*/vitest.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* --- the team's code standard, as rules ----------------------- */

      // No `any` in feature code.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // No fire-and-forget async: a rejected promise nobody observes is a
      // process-level crash in Node.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // Never swallow an exception.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Immutable by default.
      'prefer-const': 'error',
      'no-var': 'error',

      // Dead code is deleted. `_`-prefixed parameters stay, because an interface
      // method sometimes has to accept an argument it does not use.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all' },
      ],

      // No commented-out code smell that a TODO without a task becomes.
      'no-warning-comments': ['warn', { terms: ['fixme', 'xxx'], location: 'start' }],

      // Guard clauses and early returns, not nesting.
      'max-depth': ['error', 3],
      complexity: ['warn', 20],

      // Match exhaustively on closed types.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Names are words.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a `as const` array plus a union type; TS enums do not erase cleanly.',
        },
      ],

      /* --- turned off with a reason -------------------------------- */

      // Nest constructors are `constructor(private readonly x: X) {}` throughout;
      // this rule wants a body statement instead.
      '@typescript-eslint/no-useless-constructor': 'off',
      // Decorator metadata needs the class to be a class, not an object literal.
      '@typescript-eslint/no-extraneous-class': 'off',
      // `?? ''` on a `string | undefined` from a header is not unnecessary.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Nest's own types use `{}`-ish shapes in places we pass through.
      '@typescript-eslint/no-empty-object-type': 'off',
      // `HttpStatus` is one of Nest's numeric enums and the framework hands us
      // plain `number` status codes everywhere, so every comparison against it
      // trips this rule. The comparison is correct; the rule cannot see that.
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
    },
  },

  // Config and build files run in Node with looser expectations.
  {
    files: ['**/*.config.{ts,mts,mjs,js}', 'eslint.config.mjs'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  // Tests: `expect(x.body.thing)` on an untyped response body is the point of a
  // test, not a type hole worth fixing.
  {
    files: ['**/test/**/*.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'max-depth': 'off',
    },
  },

  // Repo scripts (`scripts/*.mjs`): plain Node, dependency-light, outside every
  // package tsconfig. They talk to the running API over HTTP, so every response
  // is `any` by construction and the type-aware rules have nothing real to say
  // about them — they would just demand a second copy of the contract. The
  // syntactic rules still apply.
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The callbacks passed to Playwright's `page.evaluate` are serialised and
    // run inside the browser, so `document` and `navigator` are real there even
    // though the file itself is Node.
    files: ['scripts/screenshots.mjs'],
    languageOptions: { globals: { ...globals.browser } },
  },

  prettier,
);
