// src/ui/altitudeGraph.test.mjs — a flight card's altitude trace: a slim row
// shown only once the altitude has a history to draw.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, reactive } from 'vue';
import AltitudeGraph from './views/panels/AltitudeGraph.vue';

function mount(t, props) {
  document.body.replaceChildren();
  const state = reactive(props);
  const app = createApp({ render: () => h(AltitudeGraph, { ...state }) });
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return state;
}

const $ = (selector) => document.querySelector(selector);

test('compact: nothing while the altitude holds level, then one slim row once it moves', async (t) => {
  const state = mount(t, { altitudeM: 3050, tick: 0, compact: true });
  await nextTick();
  assert.equal(
    Boolean($('.altitude-graph')),
    false,
    'one reading: no history yet',
  );
  state.tick++;
  state.altitudeM = 3060;
  await nextTick();
  assert.equal(
    Boolean($('.altitude-graph')),
    false,
    'within the same 100 ft step: still level',
  );
  state.tick++;
  state.altitudeM = 3200;
  await nextTick();
  assert.equal(
    Boolean($('.altitude-graph--compact')),
    true,
    'a climb: the trace shows, compact',
  );
  assert.equal(Boolean($('.altitude-graph__scale')), false, 'no scale');
  assert.equal(Boolean($('.altitude-graph__foot')), false, 'no change line');
  assert.match($('.altitude-graph__now').textContent, /10,500 ft/);
});

test('the full graph draws from the first reading', async (t) => {
  mount(t, { altitudeM: 3000, tick: 0 });
  await nextTick();
  assert.equal(Boolean($('.altitude-graph__foot')), true);
});
