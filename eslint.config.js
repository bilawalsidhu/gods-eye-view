// eslint.config.js
/**
 * Strict lint policy for God's Eye View (ESLint 9, flat config).
 *
 * The codebase is vanilla ES2022 browser + worker JavaScript (plus plain-ESM
 * Cloudflare Pages Functions and Node test/tooling scripts). Policy decisions:
 *
 *   - `js.configs.recommended` as the floor, then the correctness/discipline
 *     rules this repo actually cares about at ERROR level: `==` bans, `var`
 *     bans, brace requirements, floating promises off (they're everywhere in
 *     fire-and-forget render code — enforced by review instead), unused
 *     expressions, shadowed globals off (huge file, low value).
 *   - `no-console` is OFF for `scripts/` and `functions/` (they are CLIs and
 *     log sinks) and ON for `src/` ONLY as `warn` — the app legitimately logs
 *     telemetry to the console today; banning it outright is a migration, not
 *     a lint pass.
 *   - Browser + worker + Node globals come from `globals`; the app's own
 *     exposed surface (`__godsEyeView`, `__GEV_*` QA hooks) is declared
 *     rather than sprinkled with disables.
 *   - `no-console` is OFF everywhere: this codebase's telemetry channel IS the
 *     console (field debugging relies on `[Data:*]` / `[Voice]` prefixes in the
 *     browser, Pages Functions log via console, `scripts/` are CLIs). Banning
 *     it here would be a migration, not a lint pass.
 *   - Intentionally-unused params/vars are marked with a leading `_` rather
 *     than per-line disables.
 *   - `--max-warnings 0` in the `lint` script: anything that earns a warning
 *     must be fixed or narrowly re-scoped here, never left to rot.
 *
 * @type {import('eslint').Linter.Config[]}
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'coverage/**',
      'rust/target/**',
      '.wrangler/**',
      // Separate sub-project with its own toolchain (TS + vitest + prettier);
      // wrangler tmp/ build output lives under its .wrangler/.
      'cloudflare-workers/**',
      // Third-party bundles checked into the repo.
      'src/data/local_data/**',
      // Vendored/bundled artifacts, not authored source.
      '**/*.min.js',
      // Unmounted React overlay scaffold (TSX). The runtime ships the vanilla
      // UI only; this scaffold is dormant pending an adopt-or-delete decision
      // (docs/PLAN.md). ESLint would need typescript-eslint, whose current
      // release does not accept the repo's TypeScript 7 toolchain.
      'src/react/**',
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker,
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
      'no-unused-expressions': 'error',
      'no-implicit-coercion': 'error',
      'prefer-template': 'error',
      'object-shorthand': ['error', 'always'],
      'no-console': 'off',
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          caughtErrors: 'all',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    // Test files may assert via expressions and keep extra fixtures.
    files: ['**/*.test.mjs'],
    rules: {
      'no-unused-expressions': 'off',
    },
  },
];
