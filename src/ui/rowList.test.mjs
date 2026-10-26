import assert from 'node:assert/strict';
import test from 'node:test';
import { railFixture } from './railTestFixture.mjs';
import { syncRowList } from './rowList.js';

test('a later page of a list numbers on from its first item', () => {
  const { document } = railFixture();
  const list = document.createElement('ol');
  const page = (first) => ({
    items: [first, first + 1].map((ordinal) => ({
      id: `item-${ordinal}`,
      ordinal,
      text: `Item ${ordinal}`,
      params: {},
    })),
  });
  syncRowList(list, page(41));
  assert.equal(list.start, 41);
  assert.equal(list.style.counterReset, 'gev-step 40');
  syncRowList(list, page(1));
  assert.equal(list.start, 1);
  assert.equal(list.style.counterReset, '');
});
