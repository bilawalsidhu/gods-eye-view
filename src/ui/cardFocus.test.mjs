import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { focusInCard } from './cardFocus.js';

test('delayed card focus respects later keyboard focus and card navigation', async (t) => {
  const host = document.createElement('div');
  host.innerHTML =
    '<button>Search</button><section id="entity-card"><h2 class="entity-card__title">Airport</h2></section>';
  document.body.append(host);
  t.after(() => host.remove());
  const store = { card: { key: 'airport:A' } };
  const search = host.querySelector('button');
  const title = host.querySelector('h2');
  const pending = focusInCard(['.missing'], store, { turns: 3 });
  await nextTick();
  search.focus();
  assert.equal(await pending, null);
  assert.equal(document.activeElement, search);

  const oldCard = focusInCard(['.missing'], store, { turns: 3 });
  await nextTick();
  store.card = { key: 'airport:B' };
  assert.equal(await oldCard, null);
  assert.equal(document.activeElement, search);

  const immediate = focusInCard([], store);
  await nextTick();
  assert.equal(document.activeElement, title);
  assert.equal(await immediate, title);
});
