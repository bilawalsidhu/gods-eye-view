import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalSdrControls } from './localSdrControls.js';
import { createOwners } from './stores/owners.js';

function stubDocument() {
  const elements = new Map();
  const doc = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          id,
          value: '',
          hidden: false,
          disabled: false,
          textContent: '',
          ownerDocument: doc,
          classList: { toggle() {} },
          setAttribute() {},
          closest: () => null,
        });
      }
      return elements.get(id);
    },
  };
  return doc;
}

function stubReceiver() {
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
      listener({ ...state });
      return () => listeners.delete(listener);
    },
    emit(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener({ ...state });
    },
    async stop(options) {
      calls.push(['stop', options]);
      this.emit({ connected: false, status: 'idle' });
      return true;
    },
    async setMode(mode) {
      calls.push(['setMode', mode]);
      this.emit({ mode });
      return true;
    },
    async setGain(value) {
      calls.push(['setGain', value]);
      return value;
    },
    async tuneFm(hz) {
      calls.push(['tuneFm', hz]);
      return true;
    },
    async tuneAtcChannel(channel) {
      calls.push(['tuneAtcChannel', channel]);
      this.emit({ atcChannel: channel });
      return true;
    },
  };
}

// The radio store as the card's owner sees it: published views and the
// card's controls, which act() calls.
function stubStore(onPublish = () => {}) {
  return { ...createOwners(), publishSdr: onPublish };
}

function stubRadio() {
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    subscribe(listener) {
      listeners.add(listener);
      listener({ audioState: 'idle' });
      return () => listeners.delete(listener);
    },
    emit(state) {
      for (const listener of listeners) listener(state);
    },
    stopPlayback(options) {
      calls.push(options);
      this.emit({ audioState: 'idle' });
    },
  };
}

test('starting internet radio stops local FM, and local FM stops internet radio', async (t) => {
  const receiver = stubReceiver();
  const radio = stubRadio();
  const controls = new LocalSdrControls({
    document: stubDocument(),
    receiver,
    radio,
  });
  t.after(() => controls.destroy());

  receiver.emit({ connected: true, status: 'streaming', mode: 'fm' });
  assert.equal(radio.calls.length, 0, 'nothing to stop while radio is silent');
  radio.emit({ audioState: 'loading' });
  assert.deepEqual(receiver.calls.at(-1), [
    'stop',
    { message: 'Local FM stopped: internet radio started' },
  ]);

  radio.emit({ audioState: 'playing' });
  receiver.emit({ connected: true, status: 'streaming', mode: 'fm' });
  assert.deepEqual(radio.calls, [{ origin: 'user' }]);
});

test('ADS-B reception and internet radio play together', async (t) => {
  const receiver = stubReceiver();
  const radio = stubRadio();
  const controls = new LocalSdrControls({
    document: stubDocument(),
    receiver,
    radio,
  });
  t.after(() => controls.destroy());
  receiver.emit({ connected: true, status: 'streaming', mode: 'adsb' });
  radio.emit({ audioState: 'playing' });
  assert.equal(receiver.calls.length, 0);
  assert.equal(radio.calls.length, 0);
});

test('card controls drive gain, FM mode and the Local ADS-B layer', async (t) => {
  const doc = stubDocument();
  const receiver = stubReceiver();
  const layerCalls = [];
  const store = stubStore();
  const controls = new LocalSdrControls({
    document: doc,
    receiver,
    store,
    actions: {
      isLocalAdsbEnabled: () => true,
      setLocalAdsbEnabled: async (enabled) => layerCalls.push(enabled),
    },
  });
  t.after(() => controls.destroy());
  store.act('setSdrGain', '20.7');
  assert.deepEqual(receiver.calls.at(-1), ['setGain', '20.7']);

  receiver.emit({ connected: true, status: 'streaming', mode: 'adsb' });
  store.act('setSdrMode', 'fm');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(layerCalls, [false]);
  assert.deepEqual(receiver.calls.at(-1), ['setMode', 'fm']);

  store.act('setSdrMode', 'adsb');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(layerCalls, [false, true]);
  assert.equal(controls.isActive(), true);

  store.act('tuneSdr', '101.1');
  assert.deepEqual(receiver.calls.at(-1), ['tuneFm', 101_100_000]);
  store.act('tuneSdr', 'abc');
  assert.deepEqual(
    receiver.calls.at(-1),
    ['tuneFm', 101_100_000],
    'not a number',
  );

  controls.destroy();
  store.act('setSdrGain', '0.0');
  assert.deepEqual(receiver.calls.at(-1), ['tuneFm', 101_100_000], 'destroyed');
});

test('ATC tunes valid designators and leaves the decoder feed layer enabled', async (t) => {
  const receiver = stubReceiver();
  const radio = stubRadio();
  const layerCalls = [];
  let view;
  const store = stubStore((next) => (view = next));
  const controls = new LocalSdrControls({
    document: stubDocument(),
    receiver,
    radio,
    store,
    actions: {
      isLocalAdsbEnabled: () => true,
      setLocalAdsbEnabled: async (enabled) => layerCalls.push(enabled),
    },
  });
  t.after(() => controls.destroy());
  receiver.emit({ connected: true, status: 'streaming', mode: 'adsb' });
  await store.act('setSdrMode', 'atc');
  assert.deepEqual(layerCalls, []);
  assert.deepEqual(receiver.calls.at(-1), ['setMode', 'atc']);

  store.act('tuneSdr', '118.020');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(view.invalidAtcChannel, true);
  assert.deepEqual(receiver.calls.at(-1), ['setMode', 'atc']);
  store.act('tuneSdr', '118,010');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(view.invalidAtcChannel, false);
  assert.equal(view.frequency, '118.010');
  assert.deepEqual(receiver.calls.at(-1), ['tuneAtcChannel', '118.010']);
  radio.emit({ audioState: 'playing' });
  assert.deepEqual(receiver.calls.at(-1), [
    'stop',
    { message: 'Local ATC stopped: internet radio started' },
  ]);
});

test('the aircraft shortcut reveals local SDR and presets tune without scrolling', async (t) => {
  const receiver = stubReceiver();
  const store = stubStore();
  let revealed = 0;
  const controls = new LocalSdrControls({
    document: stubDocument(),
    receiver,
    store,
    actions: { revealAtc: () => (revealed += 1) },
  });
  t.after(() => controls.destroy());
  await store.act('openManualAtc');
  assert.deepEqual(receiver.calls.at(-1), ['setMode', 'atc']);
  assert.equal(revealed, 1);
  assert.equal(await store.act('tuneAirportAtc', '119.900'), true);
  assert.deepEqual(receiver.calls.at(-1), ['tuneAtcChannel', '119.900']);
  assert.equal(revealed, 1);
});

test('a page without the card connects nothing', (t) => {
  const store = stubStore();
  const receiver = stubReceiver();
  const controls = new LocalSdrControls({
    document: { getElementById: () => null },
    receiver,
    store,
  });
  t.after(() => controls.destroy());
  store.act('setSdrGain', '0.0');
  assert.equal(receiver.calls.length, 0);
});

test('the card shows one read-only decoder-feed line after a single probe', async (t) => {
  const doc = stubDocument();
  const listeners = new Set();
  let probes = 0;
  let state = { configured: null, polling: false, feeds: [] };
  const feeds = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async probe() {
      probes += 1;
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
  };
  let shown = null;
  const controls = new LocalSdrControls({
    document: doc,
    receiver: stubReceiver(),
    feeds,
    store: stubStore((view) => (shown = view)),
  });
  t.after(() => controls.destroy());
  assert.equal(probes, 1);
  assert.equal(shown.feedLine, null);
  feeds.set({
    configured: true,
    polling: true,
    feeds: [
      { band: '1090', status: 'live' },
      { band: '978', status: 'live' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(shown.feedLine, 'Decoder feeds: 1090 live · 978 live');
});
