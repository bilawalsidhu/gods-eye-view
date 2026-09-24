/**
 * Contract: every root-absolute '/api/...' path in browser code must go through
 * withBase() so the app keeps working under a deployment base path (NADI serves
 * it at /gods-eye/). Mirrors the recorded B1 acceptance grep for the NADI embed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

/** Explicit exceptions: [relative-path suffix, unique substring, reason]. Keep empty unless justified. */
const ALLOW = [
  // Server-side request routing lives behind Vite's mount paths; Vite's preview
  // server strips the deployment base before middlewares run (verified live:
  // /gods-eye/api/transit/* routes correctly with no base awareness server-side).
  [
    'sources/transitService.js',
    "startsWith('/api/transit/')",
    'server-side pathname check',
  ],
  [
    'sources/transitService.js',
    "slice('/api/transit'.length)",
    'server-side pathname slice',
  ],
];

function* walk(dir, extensions = ['.js']) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full, extensions);
    else if (
      !full.endsWith('.test.mjs') &&
      extensions.some((ext) => full.endsWith(ext))
    )
      yield full;
  }
}

test('no root-absolute /api literal escapes withBase()', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      )
        return;
      // Mask comments before matching: block comments and trailing line comments
      // (a `//` directly after `:` is a URL scheme, not a comment).
      const code = line
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/, '$1');
      if (!/(?<!withBase\()(['"`])\/api\//.test(code)) return;
      if (
        ALLOW.some(
          ([suffix, needle]) => rel.endsWith(suffix) && line.includes(needle),
        )
      )
        return;
      offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `Unwrapped root-absolute /api paths:\n${offenders.join('\n')}`,
  );
});

test('no root-absolute public-asset reference escapes the deployment base', () => {
  // Vite rewrites the src/href attributes it knows and CSS url() references, so
  // those may stay root-absolute in the sources. What escapes the base is a
  // root-absolute path inside a JS string (runtime-built markup) or inside an
  // attribute Vite does not rewrite (data-*). Relative references resolve
  // against the document URL, which already carries the base.
  const jsAsset = /(['"`])\/([a-z0-9-]+)\.svg\1/;
  const htmlAsset = /\bdata-[a-z-]+="\/([a-z0-9-]+)\.svg"/;
  const offenders = [];
  for (const file of walk(ROOT, ['.js', '.html'])) {
    const rel = path.relative(ROOT, file);
    // .js files: only runtime-built markup escapes Vite. .html templates:
    // src/href are rewritten by Vite, so only attributes it ignores (data-*)
    // can escape.
    const pattern = file.endsWith('.html') ? htmlAsset : jsAsset;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (pattern.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `Root-absolute asset references:\n${offenders.join('\n')}`,
  );
});
