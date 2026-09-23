import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalSdrControls } from './localSdrControls.js';

function stubDocument() {
  const elements = new Map();
  const doc = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const listeners = new Map();
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
          addEventListener(type, handler) {
            listeners.set(type, handler);
          },
          fire: (type, event = {}) => listeners.get(type)?.(event),
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
  };
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
  const controls = new LocalSdrControls({
    document: doc,
    receiver,
    actions: {
      isLocalAdsbEnabled: () => true,
      setLocalAdsbEnabled: async (enabled) => layerCalls.push(enabled),
    },
  });
  t.after(() => controls.destroy());
  const gain = doc.getElementById('sdr-gain-select');
  gain.value = '20.7';
  gain.fire('change');
  assert.deepEqual(receiver.calls.at(-1), ['setGain', '20.7']);

  receiver.emit({ connected: true, status: 'streaming', mode: 'adsb' });
  await doc.getElementById('sdr-mode-fm-btn').fire('click');
  assert.deepEqual(layerCalls, [false]);
  assert.deepEqual(receiver.calls.at(-1), ['setMode', 'fm']);

  await doc.getElementById('sdr-mode-adsb-btn').fire('click');
  assert.deepEqual(layerCalls, [false, true]);
  assert.equal(controls.isActive(), true);
});
