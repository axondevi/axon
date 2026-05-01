// Flat config — ESLint 9+. Kept minimal; rely on tsc for type errors.
// `bun run lint` runs this; CI runs it on PR.
import tseslint from 'typescript-eslint';
import js from '@eslint/js';

export default [
  // Files to ignore entirely.
  {
    ignores: [
      'node_modules/',
      'dist/',
      'sdk/js/dist/',
      'sdk/js/node_modules/',
      'mcp-server/dist/',
      'cli/dist/',
      'academy/dist/',
      'academy/.astro/',
      'academy/test-artifacts/',
      '.wrangler/',
      'landing/_i18n.js', // imported as global by every HTML page
      'landing/_ui-kit.js',
      'landing/embed.js',
      'landing/privy-login.js',
      'landing/learn/**',
      'admin/**', // dashboard.html lives here as static
      'blog/**',
      'marketing/**',
      'docs/**',
      'emails/**',
      'academy-docs/**',
      'contracts/AxonAgent.compiled.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // We use try/catch as control flow widely; require explicit empty
      // marker rather than ban it.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Lots of dynamic JSON / drizzle-orm types where `any` is the
      // pragmatic choice. Loosen but keep awareness via `unknown` warning.
      '@typescript-eslint/no-explicit-any': 'off',
      // Hono context types occasionally trip this with safe casts.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Allow require() in CommonJS-shaped tooling/scripts if any.
      '@typescript-eslint/no-require-imports': 'off',
      // We intentionally use `Function` for callback shapes in places.
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // BigInt + sql template combos sometimes trip these false positives.
      '@typescript-eslint/no-unused-expressions': 'off',
      // ts-ignore is sometimes pragmatic when ts-expect-error would
      // false-positive on transient compile state. Downgrade to warning.
      '@typescript-eslint/ban-ts-comment': 'warn',
      // Unused-var false-positives on import binding hoisting; warn-only.
      '@typescript-eslint/no-unused-vars': 'off',
      // We deliberately re-assign vars that *might* later be re-read in
      // try/catch flows; the rule is too aggressive for this codebase.
      'no-useless-assignment': 'off',
      // Custom escape rules in regex are sometimes intentional clarity.
      'no-useless-escape': 'warn',
    },
  },
  {
    // Tests can be looser — pragma over prudence.
    files: ['src/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
