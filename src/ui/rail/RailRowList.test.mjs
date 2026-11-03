import '../../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, h, nextTick, reactive } from 'vue';
import RailRowList from './RailRowList.vue';

test('a later page of a list numbers on from its first item', async (t) => {
  const state = reactive({ list: null });
  const page = (first) => ({
    items: [first, first + 1].map((ordinal) => ({
      id: `item-${ordinal}`,
      ordinal,
      text: `Item ${ordinal}`,
    })),
  });
  const app = createApp({ render: () => h(RailRowList, { list: state.list }) });
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  state.list = page(41);
  await nextTick();
  const list = document.querySelector('ol.data-row-list');
  assert.equal(list.start, 41);
  assert.equal(list.style.counterReset, 'gev-step 40');
  state.list = page(1);
  await nextTick();
  assert.equal(list.start, 1);
  assert.equal(list.hasAttribute('start'), false);
  assert.equal(list.style.counterReset, '');
});
