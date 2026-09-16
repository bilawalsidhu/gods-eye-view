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
import jsdoc from 'eslint-plugin-jsdoc';
import unicorn from 'eslint-plugin-unicorn';

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
      // 'latest': the codebase targets Node 24 + evergreen browsers and uses
      // syntax newer than a pinned year — e.g. dynamic import attributes
      // (`import(x, { with: { type: 'json' } })`) in the data loaders.
      ecmaVersion: 'latest',
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

  // ---------------------------------------------------------------------
  // JSDoc hygiene (Batch E). Two tiers:
  //   1. VALIDATION everywhere (this file, part of the merge gate) — where
  //      JSDoc exists it must be correct: types resolve, param names/types
  //      match the signature, tags are canonical. This costs nothing on
  //      undocumented code.
  //   2. REQUIREMENT on the public surface (eslint.docs.config.js, run via
  //      `npm run lint:docs`, NOT part of the merge gate) — exported
  //      functions/classes need doc blocks. This is the docs-coverage
  //      metric feeding Batch H; closing the gap list is tracked there
  //      rather than blocked here.
  // ---------------------------------------------------------------------
  {
    plugins: { jsdoc },
    rules: {
      'jsdoc/check-alignment': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/implements-on-classes': 'error',
      'jsdoc/no-undefined-types': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // unicorn (Batch E) — curated correctness set, NOT the stylistic
  // blanket: rules that catch real bugs or unsafe idioms in this
  // codebase's shape (event-driven rendering, worker messaging, fetch
  // wrappers). Opinionated style rules are deliberately left off to keep
  // the diff a lint pass, not a rewrite. eslint-plugin-unicorn is pinned
  // to the newest release that still supports ESLint 9 (60.x wants 10).
  // ---------------------------------------------------------------------
  {
    plugins: { unicorn },
    rules: {
      'unicorn/no-array-push-push': 'error',
      'unicorn/no-empty-file': 'error',
      'unicorn/no-instanceof-array': 'error',
      'unicorn/no-lonely-if': 'error',
      'unicorn/no-negated-condition': 'off', // early-guard style is idiomatic here
      'unicorn/no-new-array': 'error',
      'unicorn/no-object-as-default-parameter': 'error',
      'unicorn/no-useless-fallback-in-spread': 'error',
      'unicorn/no-useless-promise-resolve-reject': 'error',
      // OFF: its autofix strips the `[...set]` snapshot in listener/emitter
      // loops (`for (const fn of [...handlers]) fn()` → `of handlers`),
      // which changes semantics the moment a handler adds/removes listeners
      // mid-fire — proven 2026-09-15 when the autofix OOM'd
      // scopeMask.test.mjs (sampler rebinds its preRender listener on each
      // fire; live Set iteration visits the replacement, unbounded). The
      // snapshot spread is deliberate defensive style here.
      'unicorn/no-useless-spread': 'off',
      'unicorn/no-zero-fractions': 'off', // 0.0 literals document float intent
      'unicorn/prefer-add-event-listener': 'error',
      'unicorn/prefer-array-flat': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-at': 'error',
      'unicorn/prefer-code-point': 'error',
      'unicorn/prefer-date-now': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-math-trunc': 'error',
      'unicorn/prefer-negative-index': 'error',
      'unicorn/prefer-number-properties': 'error',
      'unicorn/prefer-object-from-entries': 'error',
      'unicorn/prefer-string-raw': 'error',
      'unicorn/prefer-string-replace-all': 'error',
      'unicorn/prefer-string-slice': 'error',
      'unicorn/prefer-string-starts-ends-with': 'error',
      'unicorn/prefer-string-trim-start-end': 'error',
      'unicorn/prefer-structured-clone': 'off', // structuredClone availability is per-realm here
      'unicorn/prefer-ternary': 'off', // if/return reads clearer in render code
      'unicorn/throw-new-error': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // no-await-expression-member, production files only. `(await
  // ask()).source` inside test assertions is the ecosystem-standard
  // one-shot idiom (97% of violations were in *.test.mjs / QA scripts);
  // splitting those would obscure what's being asserted. In shipped code
  // the hidden sequencing risk is real, so it stays enforced there.
  // ---------------------------------------------------------------------
  {
    files: [
      'src/**/*.js',
      'vite/**/*.js',
      'functions/**/*.js',
    ],
    ignores: ['**/*.test.mjs', 'src/data/local_data/**'],
    rules: {
      'unicorn/no-await-expression-member': 'error',
    },
  },
];
