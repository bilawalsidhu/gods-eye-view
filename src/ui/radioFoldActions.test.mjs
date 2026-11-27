// The Radio fold's rendered controls dispatch through RadioControls to the layer.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useRadioStore } from './stores/radio.js';
import { RadioControls } from './radioControls.js';
import RadioFold from './views/panels/RadioFold.vue';

test('the fold’s transport and volume send user actions to Radio', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(RadioFold).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const $ = (id) => document.getElementById(id);
  const stations = [
    { id: 'one', name: 'One' },
    { id: 'two', name: 'Two' },
  ];
  const state = {
    enabled: true,
    filter: 'all',
    selected: stations[0],
    stationCount: 2,
    filteredCount: 2,
    audioState: 'playing',
    volume: 0.8,
  };
  const calls = [];
  const controls = new RadioControls({
    elements: { _radioPanel: $('radio-panel') },
    store: useRadioStore(pinia),
    radio: {
      subscribe(fn) {
        fn(state);
        return () => {};
      },
      getUIState: () => state,
      getTunerStations: () => stations,
      cycleStation(direction, options) {
        calls.push(['cycle', direction, options]);
        return true;
      },
      togglePlayback: (options) => calls.push(['toggle', options]),
      stopPlayback: (options) => calls.push(['stop', options]),
      endTuning() {},
    },
    actions: {
      getLifecycle: () => null,
      scheduleLayout() {},
      setParams: (params, options) => calls.push(['params', params, options]),
    },
  });
  t.after(() => {
    controls.destroy();
    app.unmount();
  });
  controls.connect();
  await nextTick();
  $('radio-panel').open = true;
  for (const id of [
    'radio-prev-btn',
    'radio-play-btn',
    'radio-next-btn',
    'radio-stop-btn',
  ]) {
    assert.equal($(id).disabled, false, id);
    $(id).click();
  }
  assert.equal($('radio-volume').disabled, false);
  $('radio-volume').value = '35';
  $('radio-volume').dispatchEvent(new Event('input', { bubbles: true }));
  const cycle = {
    rotate: true,
    stationIds: ['one', 'two'],
    autoplay: true,
    origin: 'user',
  };
  assert.deepEqual(calls, [
    ['cycle', -1, cycle],
    ['toggle', { origin: 'user' }],
    ['cycle', 1, cycle],
    ['stop', { origin: 'user' }],
    ['params', { volume: 0.35 }, { origin: 'user' }],
  ]);
});
