import assert from 'node:assert/strict';
import test from 'node:test';
import { hexColor } from './color.js';

test('hex colours become renderer colours at the given alpha', () => {
  assert.deepEqual(hexColor('#ff8000'), [1, 128 / 255, 0, 1]);
  assert.deepEqual(hexColor('#000000', 0.25), [0, 0, 0, 0.25]);
});
