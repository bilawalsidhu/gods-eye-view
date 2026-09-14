import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEol, readSource } from './readSource.js';

/**
 * The newline-agnostic source reader (issue #88): source-pin tests must see
 * the LF shape the repo stores even when a checkout or archive rewrites
 * line endings.
 */

test('normalizeEol folds CRLF and bare CR to LF', () => {
  assert.equal(normalizeEol('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(normalizeEol(''), '');
  assert.equal(normalizeEol('plain'), 'plain');
});

test('readSource reads a real file relative to the importer', () => {
  const self = readSource('./readSource.test.mjs', import.meta.url);
  assert.match(self, /normalizeEol folds CRLF and bare CR to LF/);
  assert.doesNotMatch(self, /\r/);
});
