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
const ALLOW = [];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith('.js') && !full.endsWith('.test.mjs')) yield full;
  }
}

test('no root-absolute /api literal escapes withBase()', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      // Mask comments before matching: block comments and trailing line comments
      // (a `//` directly after `:` is a URL scheme, not a comment).
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/, '$1');
      if (!/(?<!withBase\()(['"`])\/api\//.test(code)) return;
      if (ALLOW.some(([suffix, needle]) => rel.endsWith(suffix) && line.includes(needle))) return;
      offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `Unwrapped root-absolute /api paths:\n${offenders.join('\n')}`);
});
