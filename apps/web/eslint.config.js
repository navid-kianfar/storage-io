import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Project rule (set by the user, 2026-09): feature code never uses a
 * browser-native form primitive or a native modal. Every primitive is a shadcn
 * component, wrapped once under src/components/ui and re-exported through the
 * app kit in src/components/app. The two blocks below are what makes that a
 * build failure instead of a review comment.
 */
const NATIVE_PRIMITIVE_TYPES =
  'checkbox|radio|file|date|datetime-local|month|week|time|range|number|color';

const noNativePrimitives = [
  {
    selector: 'JSXOpeningElement[name.name="select"]',
    message: 'Use the Select / Combobox kit component instead of a native <select>.',
  },
  {
    selector: 'JSXOpeningElement[name.name="textarea"]',
    message: 'Use the Textarea or CodeEditor kit component instead of a native <textarea>.',
  },
  {
    selector: 'JSXOpeningElement[name.name="table"]',
    message: 'Use the DataTable or the Table kit components instead of a native <table>.',
  },
  {
    selector: `JSXOpeningElement[name.name="input"] > JSXAttribute[name.name="type"][value.value=/^(${NATIVE_PRIMITIVE_TYPES})$/]`,
    message:
      'Use the matching kit component (Checkbox, RadioGroup, FileDropzone, DatePicker, Slider, Input) instead of a native <input type="…">.',
  },
  {
    selector:
      'CallExpression[callee.object.name="window"][callee.property.name=/^(confirm|alert|prompt)$/]',
    message: 'Use ConfirmDialog / AlertDialog / toast instead of window.confirm, alert or prompt.',
  },
  {
    selector: 'CallExpression[callee.type="Identifier"][callee.name=/^(confirm|alert|prompt)$/]',
    message: 'Use ConfirmDialog / AlertDialog / toast instead of confirm, alert or prompt.',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'public/mockServiceWorker.js', 'src/components/ui/**/*.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Nothing in feature code may reach past the kit into a shadcn primitive:
      // that is what "wrap each primitive once" means in practice.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/components/ui/*'],
              message:
                'Import the wrapper from @/components/app instead. If the primitive has no wrapper yet, add one there first.',
            },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      'no-restricted-syntax': [
        'error',
        ...noNativePrimitives,
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a `as const` array plus a union type; TS enums do not erase cleanly.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'confirm', message: 'Use ConfirmDialog instead.' },
        { name: 'alert', message: 'Use a toast or an Alert instead.' },
        { name: 'prompt', message: 'Use a Dialog with a form instead.' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      /*
       * The team's code standard, as the root `eslint.config.mjs` states it. This
       * package is ignored there — flat configs replace rather than extend — so
       * the standard is repeated here instead of silently not applying.
       */
      // No fire-and-forget async: a rejected promise nobody observes is a
      // silent failure the operator sees as "nothing happened".
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      // Never swallow an exception.
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Immutable by default.
      'prefer-const': 'error',
      'no-var': 'error',
      // Guard clauses and early returns, not nesting.
      'max-depth': ['error', 3],
      complexity: ['warn', 20],
      // Match exhaustively on closed types.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    /**
     * The shadcn primitives are vendored: they are generated by `shadcn add` and
     * re-generated when a component is updated, so they are linted for *our*
     * rules (the native-element ban is off here — this is the wrapper the ban
     * points everyone at) and not for the type-strictness we hold our own code
     * to. Keeping the strict rules on here would mean editing upstream code on
     * every regeneration.
     *
     * Deliberate exception: the app-specific patches in these files
     * (RTL-logical utilities, token-derived sizes, the 1024px breakpoint) are
     * re-applied by `pnpm run normalize:ui` after any `shadcn add --overwrite`.
     */
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
      'react-refresh/only-export-components': 'off',
      eqeqeq: 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    /**
     * The kit and the shell ARE the wrappers, so they import the primitives
     * directly. They also export a hook or a constant beside their component
     * (`meterToneFor` next to `Meter`, `useStepper` next to `StepList`), which the
     * HMR heuristic dislikes and which is the right way to organise them.
     */
    files: [
      'src/app/**/*.{ts,tsx}',
      'src/components/app/**/*.{ts,tsx}',
      'src/components/shell/**/*.{ts,tsx}',
      'src/features/**/*.{ts,tsx}',
      'src/pages/**/*.{ts,tsx}',
      'src/lib/**/*.{ts,tsx}',
      'src/test/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // The two places the kit hides a native element the primitives cannot cover:
    // the file input inside FileDropzone and the <table> inside DataTable.
    files: ['src/components/app/FileDropzone.tsx', 'src/components/app/DataTable.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}', 'src/mocks/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    // Config and tooling files are outside the app's tsconfig `include`, so the
    // type-aware rules have no program for them.
    files: ['vite.config.ts', 'eslint.config.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    extends: [tseslint.configs.disableTypeChecked],
  },
);
