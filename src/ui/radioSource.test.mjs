// src/ui/radioSource.test.mjs — Radio's row lends the local receiver's card
// (the RTL-SDR controls, which live in a hidden home in Context, never in
// Radio's fold) while Local receiver is
// chosen: the same element moves onto the row, its controls still work there,
// and it goes back home when the row lets it go.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationPinia } from './vueRuntime.js';
import { createApp, h, nextTick, render, watch } from 'vue';
import RadioFold from './views/panels/RadioFold.vue';
import SdrCard from './views/panels/SdrCard.vue';
import LayerRows from './layerPanel/LayerRows.vue';
import { LocalSdrControls } from './localSdrControls.js';
import { useRadioStore } from './stores/radio.js';

function receiver() {
  const listeners = new Set();
  const calls = [];
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
    calls,
    getState: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener({ ...state });
    },
    async connect(mode) {
      calls.push(['connect', mode]);
      return true;
    },
    async stop() {
      calls.push(['stop']);
      this.emit({ connected: false, status: 'idle' });
    },
    setVolume(value) {
      calls.push(['volume', value]);
    },
  };
}

const radioRow = (controls) => ({
  key: 'radio',
  id: 'radio',
  englishName: 'Radio',
  icon: '◉',
  name: 'Radio',
  meta: '',
  toggle: {
    classes: [],
    text: 'ON',
    ariaLabel: 'Radio',
    title: '',
    ariaBusy: 'false',
    ariaDisabled: 'false',
    feedState: '',
  },
  count: null,
  controls,
});
const sourceSwitch = (local) => ({
  id: 'radio-source',
  ariaLabel: 'Radio source',
  options: [
    { id: 'radio-source-internet', label: 'Internet stations', active: !local },
    { id: 'radio-source-local', label: 'Local receiver', active: local },
  ],
});
const controlsFor = (local) => ({
  hidden: false,
  chips: [],
  segmented: sourceSwitch(local),
  slider: null,
  range: null,
  legend: [],
  info: null,
  list: null,
  panel: local ? 'sdr-radio-card' : null,
});

test('Local receiver shows the RTL-SDR card on Radio’s row, working, and its home gets it back', async (t) => {
  document.body.replaceChildren();
  const pinia = applicationPinia();
  const foldHost = document.body.appendChild(document.createElement('div'));
  // Context's hidden homes: Radio's fold, and the card's own.
  const app = createApp({
    render: () => [
      h(RadioFold),
      h('div', { class: 'sdr-card-home', hidden: true }, [h(SdrCard)]),
    ],
  }).use(pinia);
  app.mount(foldHost);
  const rows = document.body.appendChild(document.createElement('div'));
  const usb = receiver();
  const store = useRadioStore(pinia);
  const controls = new LocalSdrControls({
    document,
    receiver: usb,
    store,
  });
  t.after(() => {
    controls.destroy();
    render(null, rows);
    app.unmount();
  });
  const card = document.getElementById('sdr-radio-card');
  const fold = document.getElementById('radio-panel');
  const home = document.querySelector('.sdr-card-home');
  assert.ok(home.contains(card), 'the card starts in its home');
  assert.equal(fold.querySelector('#sdr-radio-card'), null, 'not in the fold');

  const chosen = [];
  const paint = (local, enabled = true) =>
    render(
      h(LayerRows, {
        items: [radioRow(enabled ? controlsFor(local) : { hidden: true })],
        onChip: (_id, chipId) => chosen.push(chipId),
      }),
      rows,
    );
  paint(false);
  const segments = [...rows.querySelectorAll('[data-chip-id]')];
  assert.deepEqual(
    segments.map((segment) => segment.textContent.trim()),
    ['Internet stations', 'Local receiver'],
    'the switch on the row',
  );
  assert.equal(rows.querySelector('[data-row-panel]'), null);
  segments[1].click();
  assert.deepEqual(chosen, ['radio-source-local']);

  paint(true);
  await nextTick();
  const slot = rows.querySelector('[data-row-panel="sdr-radio-card"]');
  assert.ok(slot, 'a slot on the row');
  assert.equal(document.getElementById('sdr-radio-card'), card);
  assert.ok(slot.contains(card), 'the same card, on the row');
  assert.equal(document.querySelectorAll('#sdr-radio-card').length, 1);
  document.getElementById('sdr-connect-btn').click();
  await nextTick();
  assert.deepEqual(usb.calls.at(-1), ['connect', 'fm'], 'its controls work');

  const connectionChanged = () =>
    new Promise((resolve) =>
      watch(() => store.sdr?.connectionActive, resolve, { once: true }),
    );
  const connected = connectionChanged();
  usb.emit({ connected: true, status: 'streaming' });
  await connected;

  paint(true, false);
  await nextTick();
  assert.ok(
    slot.contains(card),
    'the live receiver stays on the Radio row when off',
  );
  assert.equal(usb.getState().status, 'streaming');
  const disconnect = document.getElementById('sdr-connect-btn');
  assert.equal(disconnect.textContent.trim(), 'DISCONNECT');
  const disconnected = connectionChanged();
  disconnect.click();
  await disconnected;
  await nextTick();
  assert.deepEqual(usb.calls.at(-1), ['stop']);
  assert.equal(rows.querySelector('[data-row-panel]'), null);
  assert.equal(card.parentElement, home);

  paint(false);
  await nextTick();
  assert.equal(rows.querySelector('[data-row-panel]'), null);
  assert.equal(card.parentElement, home, 'back home');
  assert.equal(fold.querySelector('#sdr-radio-card'), null, 'never the fold');
});
