import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./app/tools.js', import.meta.url), 'utf8');

test('Place Peek is composed with current providers and camera authority', () => {
  assert.match(source, /initPlacePeek\(\{/);
  assert.match(source, /placeSearch,/);
  assert.match(source, /navigation: styleManager/);
  assert.match(source, /fetchRegionalBrief: operations\.requests\.regional\.getBrief/);
  assert.match(source, /pointerFree: isPointerFree/);
});
