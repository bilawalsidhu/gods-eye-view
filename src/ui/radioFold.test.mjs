// src/ui/radioFold.test.mjs — Radio's own controls, folded under Context's
// station list (the standalone Radio panel is retired), render what
// RadioControls presents (`renderRadioState()`), over happy-dom. The local
// receiver's card is not in the fold (it shows on Radio's Data Layers row);
// it is mounted beside it here and renders what LocalSdrControls presents.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { useRadioStore } from './stores/radio.js';
import RadioFold from './views/panels/RadioFold.vue';
import SdrCard from './views/panels/SdrCard.vue';
import { renderRadioState, showRadioVolume } from './radioPresentation.js';
import { LocalSdrControls } from './localSdrControls.js';
// Core's classes on an element, without the kit's `ui-` classes.
const coreClasses = (el) =>
  [...el.classList].filter((name) => !name.startsWith('ui-')).join(' ');

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp({ render: () => [h(RadioFold), h(SdrCard)] }).use(
    pinia,
  );
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

test('before RadioControls renders, the fold shows its initial markup', (t) => {
  const { $ } = fixture(t);
  assert.equal($('radio-panel').tagName, 'DETAILS', 'a fold, not a rail panel');
  assert.equal($('radio-panel').open, false, 'it starts closed');
  for (const gone of [
    'radio-enable-btn',
    'radio-filter',
    'radio-station-card',
    'radio-layer-state',
  ])
    assert.equal(
      $(gone),
      null,
      `${gone} moved to Data Layers or the station list`,
    );
  assert.equal(coreClasses($('radio-play-btn')), '');
  assert.equal($('radio-play-btn').disabled, true);
  assert.equal($('radio-volume').value, '80');
  assert.equal($('radio-volume-value').textContent, '80%');
  assert.equal($('radio-playback-state').textContent, 'Radio off');
  assert.equal($('radio-station-homepage').getAttribute('href'), '#');
  assert.equal($('radio-station-homepage').hidden, true);
});

test('the fold renders the presented transport, links and playback', async (t) => {
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
  assert.equal(
    $('radio-station-homepage').getAttribute('href'),
    'https://example.org/',
  );
  assert.equal($('radio-station-homepage').hidden, false);
  const play = $('radio-play-btn');
  assert.equal(coreClasses(play), 'active');
  assert.equal(play.textContent, 'PAUSE');
  assert.equal(play.getAttribute('aria-label'), 'Pause selected radio station');
  assert.equal($('radio-prev-btn').disabled, false);
  assert.equal($('radio-stop-btn').disabled, false);
  assert.equal($('radio-playback-state').textContent, 'Playing KJAZ');

  await render({ audioState: 'error', filter: 'all' });
  assert.equal(coreClasses(play), '');
  assert.equal(
    $('radio-playback-state').className,
    'radio-playback-state error',
  );
  assert.equal($('radio-station-homepage').hasAttribute('href'), false);
  assert.equal($('radio-station-homepage').hidden, true);
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

test('a Radio lifecycle in transition shows on the playback line', async (t) => {
  const { $, render, setLifecycle } = fixture(t);
  setLifecycle({
    lifecycleState: 'enabling',
    enabled: false,
    uncertain: false,
  });
  await render({});
  assert.equal($('radio-playback-state').textContent, 'Radio is enabling…');
  setLifecycle({ lifecycleState: 'enabled', enabled: true, uncertain: true });
  await render({});
  assert.equal(
    $('radio-panel').classList.contains('lifecycle-uncertain'),
    true,
  );
  assert.equal(
    $('radio-playback-state').className,
    'radio-playback-state error',
  );
});

function sdrReceiver() {
  const listeners = new Set();
  let state = {
    webUsbSupported: true,
    connected: false,
    status: 'idle',
    message: 'Connect an RTL-SDR to begin.',
    mode: 'fm',
    frequencyHz: 98_500_000,
    volume: 0.8,
    gain: 'auto',
    locationStatus: 'unknown',
  };
  return {
    volumes: [],
    getState: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener({ ...state });
    },
    setVolume(value) {
      this.volumes.push(value);
    },
  };
}

test('the fold holds the tuner, transport and volume, and no RTL-SDR card', (t) => {
  const { $ } = fixture(t);
  const fold = $('radio-panel');
  assert.equal(
    fold.querySelector('.radio-fold__summary').textContent,
    'Tuner and volume',
  );
  for (const id of ['radio-play-btn', 'radio-volume', 'radio-playback-state'])
    assert.ok(fold.contains($(id)), `${id} in the fold`);
  assert.equal(fold.querySelector('#sdr-radio-card'), null);
});

test('the RTL-SDR card renders what LocalSdrControls presents', async (t) => {
  const { $, owner } = fixture(t);
  const receiver = sdrReceiver();
  const controls = new LocalSdrControls({
    document,
    receiver,
    store: owner.store,
  });
  t.after(() => controls.destroy());
  const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
  await nextTick();
  assert.equal($('sdr-connection-state').getAttribute('class'), null);
  assert.equal($('sdr-connect-btn').textContent, 'CONNECT');
  assert.equal($('sdr-connect-btn').disabled, false);
  assert.equal(coreClasses($('sdr-mode-fm-btn')), 'active');
  assert.equal($('sdr-mode-adsb-btn').getAttribute('aria-pressed'), 'false');
  assert.equal($('sdr-adsb-stats').hidden, true);
  assert.equal($('sdr-frequency-input').value, '98.5');
  assert.equal($('sdr-feed-status').hidden, true);

  receiver.emit({
    connected: true,
    status: 'streaming',
    mode: 'adsb',
    gain: 20.7,
    aircraftHeard: 3,
    aircraftPositioned: 2,
    messagesPerSecond: 41.25,
  });
  await frame();
  assert.equal($('sdr-connection-state').className, 'active');
  assert.equal($('sdr-connect-btn').textContent, 'DISCONNECT');
  assert.equal(coreClasses($('sdr-connect-btn')), 'panel-layer-toggle active');
  assert.equal(coreClasses($('sdr-mode-fm-btn')), '');
  assert.equal(coreClasses($('sdr-mode-adsb-btn')), 'active');
  assert.equal($('sdr-adsb-stats').hidden, false);
  assert.equal($('sdr-stat-heard').textContent, '3');
  assert.equal($('sdr-stat-positioned').textContent, '2');
  assert.equal($('sdr-gain-select').value, '20.7');
  assert.equal($('sdr-frequency-input').disabled, true);

  // A focused field keeps the value the person is setting (FM volume).
  receiver.emit({ mode: 'fm' });
  await frame();
  const volume = $('sdr-volume');
  assert.equal(volume.disabled, false);
  volume.focus();
  volume.value = '35';
  volume.dispatchEvent(new Event('input'));
  await nextTick();
  assert.deepEqual(receiver.volumes, [0.35]);
  assert.equal($('sdr-volume-value').textContent, '35%');
  receiver.emit({ volume: 0.6 });
  await frame();
  assert.equal(volume.value, '35');
  volume.blur();
  receiver.emit({ volume: 0.6, connected: false, status: 'idle' });
  await frame();
  assert.equal(volume.value, '60');
  assert.equal($('sdr-volume-value').textContent, '60%');
});

test('focused RTL-SDR fields keep what the person typed or picked', async (t) => {
  const { $, owner, render } = fixture(t);
  const receiver = sdrReceiver();
  let feeds = { configured: null, polling: false, feeds: [] };
  const feedListeners = new Set();
  const controls = new LocalSdrControls({
    document,
    receiver,
    store: owner.store,
    feeds: {
      getState: () => feeds,
      subscribe(listener) {
        feedListeners.add(listener);
        return () => feedListeners.delete(listener);
      },
      probe: async () => {},
    },
  });
  t.after(() => controls.destroy());
  const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
  receiver.emit({ connected: true, status: 'streaming' });
  await frame();
  const frequency = $('sdr-frequency-input');
  frequency.focus();
  frequency.value = '101.1';
  receiver.emit({ frequencyHz: 98_700_000 });
  await frame();
  assert.equal(frequency.value, '101.1', 'typing is not undone');
  await render({});
  assert.equal(frequency.value, '101.1', 'nor by a Radio render');
  frequency.blur();
  receiver.emit({ frequencyHz: 98_700_000 });
  await frame();
  assert.equal(frequency.value, '98.7');

  const gain = $('sdr-gain-select');
  gain.focus();
  gain.value = '20.7';
  receiver.emit({ gain: 'auto' });
  await frame();
  assert.equal(gain.value, '20.7', 'the pick stands while focused');

  feeds = {
    configured: true,
    polling: true,
    feeds: [{ band: '1090', status: 'live' }],
  };
  for (const listener of feedListeners) listener(feeds);
  await frame();
  assert.equal($('sdr-feed-status').hidden, false);
  assert.equal($('sdr-feed-status').textContent, 'Decoder feeds: 1090 live');
});
