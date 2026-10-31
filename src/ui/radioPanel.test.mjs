// src/ui/radioPanel.test.mjs — the Radio panel renders what RadioControls
// presents (`renderRadioState()`), over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useRadioStore } from './stores/radio.js';
import RadioPanel from './views/panels/RadioPanel.vue';
import {
  renderRadioState,
  showRadioEnableBusy,
  showRadioVolume,
} from './radioPresentation.js';
import { setLocale } from '../i18n/index.js';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(RadioPanel).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const $ = (id) => document.getElementById(id);
  let lifecycle = null;
  const owner = {
    destroyed: false,
    store: useRadioStore(pinia),
    _radioPanel: $('radio-panel'),
    _radioVolume: $('radio-volume'),
    actions: {
      getLifecycle: () => lifecycle,
      preservePanelStateDuringClear: () => true,
      setPanelCollapsed() {},
      scheduleLayout() {},
    },
  };
  const render = async (state) => {
    renderRadioState.call(owner, {
      enabled: true,
      categories: [
        { id: 'all', label: 'All', count: 3, color: '' },
        { id: 'jazz', label: 'Jazz', count: 1, color: '#ffb547' },
      ],
      filter: 'all',
      filteredCount: 3,
      stationCount: 3,
      volume: 0.8,
      audioState: 'stopped',
      ...state,
    });
    await nextTick();
  };
  const setLifecycle = (next) => (lifecycle = next);
  return { $, owner, render, setLifecycle };
}

test('before RadioControls renders, the panel shows its initial markup', (t) => {
  const { $ } = fixture(t);
  assert.equal($('radio-layer-state').textContent, 'OFF');
  assert.equal($('radio-enable-btn').textContent, 'ENABLE');
  assert.equal($('radio-enable-btn').hasAttribute('aria-busy'), false);
  assert.equal($('radio-filter').disabled, true);
  assert.equal($('radio-filter').options.length, 1);
  assert.equal($('radio-filter').options[0].value, 'all');
  assert.equal($('radio-filter').options[0].textContent, 'All');
  assert.equal($('radio-play-btn').getAttribute('class'), null);
  assert.equal($('radio-play-btn').disabled, true);
  assert.equal($('radio-volume').value, '80');
  assert.equal($('radio-volume-value').textContent, '80%');
  assert.equal($('radio-playback-state').textContent, 'Radio off');
  assert.equal($('radio-station-homepage').getAttribute('href'), '#');
  assert.equal($('radio-station-homepage').hidden, true);
});

test('the panel renders the presented directory, station, transport and playback', async (t) => {
  const { $, render } = fixture(t);
  const panel = $('radio-panel');
  await render({
    selected: {
      name: 'KJAZ',
      state: 'Texas',
      countryCode: 'US',
      codec: 'MP3',
      bitrate: 128,
      tags: ['jazz', 'blues'],
      homepage: 'https://example.org/',
    },
    selectedIndex: 0,
    audioState: 'playing',
    filter: 'jazz',
  });
  assert.equal(panel.classList.contains('radio-enabled'), true);
  assert.equal(panel.classList.contains('collapsed'), true, 'chrome keeps its class');
  assert.equal($('radio-layer-state').className, 'radio-layer-state active');
  assert.equal($('radio-layer-state').textContent, '3/3');
  const enable = $('radio-enable-btn');
  assert.equal(enable.className, 'panel-layer-toggle active');
  assert.equal(enable.textContent, 'DISABLE');
  assert.equal(enable.getAttribute('aria-pressed'), 'true');
  assert.equal(enable.getAttribute('aria-label'), 'Disable Radio');
  assert.equal(enable.getAttribute('aria-busy'), 'false');
  const filter = $('radio-filter');
  const [all, jazz] = filter.options;
  assert.equal(filter.options.length, 2);
  assert.equal(jazz.textContent, '● Jazz (1)');
  assert.equal(jazz.getAttribute('aria-label'), 'Jazz (1)');
  assert.equal(jazz.dataset.radioColor, '#ffb547');
  assert.equal(all.getAttribute('aria-label'), 'All (3)');
  assert.equal(filter.value, 'jazz');
  assert.equal(filter.disabled, false);
  assert.ok(filter.style.color);
  assert.equal($('radio-station-name').textContent, 'KJAZ');
  assert.equal($('radio-station-meta').textContent, 'Texas · US  /  MP3 · 128 kbps');
  assert.equal($('radio-station-tags').textContent, 'TAGS · jazz · blues');
  assert.equal($('radio-station-homepage').getAttribute('href'), 'https://example.org/');
  assert.equal($('radio-station-homepage').hidden, false);
  const play = $('radio-play-btn');
  assert.equal(play.className, 'active');
  assert.equal(play.textContent, 'PAUSE');
  assert.equal(play.getAttribute('aria-label'), 'Pause selected radio station');
  assert.equal($('radio-prev-btn').disabled, false);
  assert.equal($('radio-stop-btn').disabled, false);
  assert.equal($('radio-playback-state').textContent, 'Playing KJAZ');

  await render({ audioState: 'error', filter: 'all' });
  assert.equal(play.className, '');
  assert.equal($('radio-playback-state').className, 'radio-playback-state error');
  assert.equal($('radio-station-homepage').hasAttribute('href'), false);
  assert.equal($('radio-station-homepage').hidden, true);
  assert.equal(filter.getAttribute('style'), null);
});

test('the markup’s tag option stands until the categories first change', async (t) => {
  const { $, render } = fixture(t);
  await render({ enabled: false, categories: [], filteredCount: 0, stationCount: 0 });
  const filter = $('radio-filter');
  assert.equal(filter.options.length, 1);
  assert.equal(filter.options[0].textContent, 'All');
  await render({});
  assert.equal(filter.options.length, 2);
  await render({ categories: [] });
  assert.equal(filter.options.length, 0, 'categories that empty clear the list');
});

test('a render puts back the published tag after a refused pick', async (t) => {
  const { $, render } = fixture(t);
  await render({});
  const filter = $('radio-filter');
  filter.value = 'jazz';
  await render({});
  assert.equal(filter.value, 'all');
});

test('a volume the person is dragging is not rewritten; its readout follows the drag', async (t) => {
  const { $, owner, render } = fixture(t);
  await render({ volume: 0.5 });
  const volume = $('radio-volume');
  assert.equal(volume.value, '50');
  volume.focus();
  volume.value = '30';
  showRadioVolume.call(owner, 30);
  await nextTick();
  assert.equal($('radio-volume-value').textContent, '30%');
  await render({ volume: 0.9 });
  assert.equal(volume.value, '30');
  assert.equal($('radio-volume-value').textContent, '30%');
  volume.blur();
  await render({ volume: 0.9 });
  assert.equal(volume.value, '90');
  assert.equal($('radio-volume-value').textContent, '90%');
});

test('a Radio lifecycle in transition marks Enable busy without disabling it', async (t) => {
  const { $, render, setLifecycle } = fixture(t);
  setLifecycle({ lifecycleState: 'enabling', enabled: false, uncertain: false });
  await render({});
  const enable = $('radio-enable-btn');
  assert.equal(enable.textContent, 'ENABLING');
  assert.equal(enable.getAttribute('aria-busy'), 'true');
  assert.equal(enable.getAttribute('aria-disabled'), 'true');
  assert.equal(enable.disabled, false);
  assert.equal($('radio-layer-state').textContent, 'ENABLING');
  assert.equal($('radio-playback-state').textContent, 'Radio is enabling…');
  setLifecycle({ lifecycleState: 'enabled', enabled: true, uncertain: true });
  await render({});
  assert.equal(enable.textContent, 'RECONCILE');
  assert.equal(enable.getAttribute('aria-busy'), 'false');
  assert.equal($('radio-panel').classList.contains('lifecycle-uncertain'), true);
  assert.equal($('radio-playback-state').className, 'radio-playback-state error');
});

test('tag options show localized text and names', async (t) => {
  const { $, render } = fixture(t);
  setLocale('zh-CN');
  t.after(() => setLocale('en'));
  await render({ categories: [{ id: 'all', label: '全部', count: 750, color: '' }] });
  const [option] = $('radio-filter').options;
  assert.equal(option.textContent, '● 全部（750）');
  assert.equal(option.getAttribute('aria-label'), '全部（750）');
});

test('a toggle that ends mid-transition does not leave Enable marked idle', async (t) => {
  const { $, owner, render, setLifecycle } = fixture(t);
  await render({});
  const enable = $('radio-enable-btn');
  showRadioEnableBusy.call(owner, true);
  await nextTick();
  assert.equal(enable.getAttribute('aria-busy'), 'true');
  setLifecycle({ lifecycleState: 'enabling', enabled: false, uncertain: false });
  await render({});
  // The toggle was refused while the lifecycle is still enabling.
  showRadioEnableBusy.call(owner, false);
  await nextTick();
  assert.equal(enable.getAttribute('aria-busy'), 'false');
  await render({});
  assert.equal(enable.getAttribute('aria-busy'), 'true', 'the next render reports it');
  assert.equal(enable.getAttribute('aria-disabled'), 'true');
});
