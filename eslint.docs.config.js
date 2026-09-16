// eslint.docs.config.js
/**
 * Documentation-coverage metric (Batch E tooling → Batch H worklist).
 *
 * NOT part of the merge gate (`npm run lint`). Run via `npm run lint:docs`
 * to list the authored-surface JSDoc gaps: every exported function, class,
 * and constructor in `src/` (excluding tests, workers, vendored and dormant
 * code) must carry a doc block, and documented signatures must declare
 * their params and returns.
 *
 * The rule set is intentionally identical in kind to the validation tier in
 * `eslint.config.js` — once a gap is closed it is held closed by both
 * configs. Promotion of the require tier into the gate is a Batch H exit
 * criterion (see docs/PLAN.md), not a default.
 *
 * @type {import('eslint').Linter.Config[]}
 */
import base from './eslint.config.js';

export default [
  ...base,
  {
    files: ['src/**/*.js'],
    ignores: [
      'src/**/*.test.mjs',
      'src/data/local_data/**',
      'src/react/**',
      'src/workers/**',
    ],
    rules: {
      'jsdoc/require-jsdoc': ['error', {
        require: { ClassDeclaration: true, MethodDefinition: false },
        contexts: [
          'ExportedFunctionDeclaration',
          'ExportedFunctionExpression',
          'ExportedClassDeclaration',
          'ExportedVariableDeclaration > ArrowFunctionExpression',
        ],
      }],
      'jsdoc/require-param': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-param-name': 'error',
      'jsdoc/require-param-type': 'error',
      'jsdoc/require-returns': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/require-returns-type': 'error',
    },
  },
];
