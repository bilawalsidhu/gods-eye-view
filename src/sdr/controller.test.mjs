import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRememberingWebUsb,
  SDR_RECEIVER_PRESETS,
  SdrController,
} from './controller.js';
import { RTL_SDR_USB_FILTERS } from './usbDevices.js';
import { SDR_GAIN_STORAGE_KEY } from './gain.js';

function replaceGlobal(name, value) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (prior) Object.defineProperty(globalThis, name, prior);
    else delete globalThis[name];
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

class FakeWorker {
  postMessage() {}
  terminate() {}
}

function fakeDevice(events = [], name = 'device') {
  return {
    setSampleRate: async (rate) => rate,
    setFrequencyCorrection: async () => {},
    setCenterFrequency: async (frequency) => {
      events.push(`${name}:tune:${frequency}`);
      return frequency;
    },
    setGain: async (gain) => {
      events.push(`${name}:gain:${gain}`);
    },
    _enableRtlAgc: async (enabled) => {
      events.push(`rtl-agc:${enabled}`);
    },
    resetBuffer: async () => {},
    // Resolve like hardware so queued USB work can run between blocks.
    readSamples: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ data: new ArrayBuffer(8) }), 2),
      ),
    close: async () => {
      events.push(`${name}:close`);
    },
  };
}

test('FM resumes audio before opening WebUSB and reports the running context', async (t) => {
  const events = [];
  class FakeAudioContext {
    constructor() {
      events.push('audio:create');
      this.state = 'suspended';
      this.destination = {};
      this.audioWorklet = {
        addModule: async () => {
          events.push('audio:module');
        },
      };
      this.onstatechange = null;
    }

    async resume() {
      events.push('audio:resume');
      this.state = 'running';
      this.onstatechange?.();
    }

    async close() {
      this.state = 'closed';
    }
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = { postMessage() {} };
    }

    connect() {}
  }
  const device = fakeDevice(events);
  const restore = [
    replaceGlobal('navigator', { usb: {} }),
    replaceGlobal('AudioContext', FakeAudioContext),
    replaceGlobal('AudioWorkletNode', FakeAudioWorkletNode),
    replaceGlobal('Worker', FakeWorker),
  ];
  t.after(() => restore.reverse().forEach((callback) => callback()));

  const controller = new SdrController({
    storage: memoryStorage(),
    providerFactory: () => ({
      async get() {
        events.push('usb:get');
        return device;
      },
    }),
  });
  t.after(() => controller.stop());

  assert.equal(await controller.connect('fm'), true);
  assert.ok(events.indexOf('audio:resume') < events.indexOf('usb:get'));
  assert.equal(controller.getState().audioState, 'running');
  assert.equal(controller.getState().connected, true);
  assert.ok(events.includes('rtl-agc:false'));
  assert.ok(events.includes('device:gain:null'), 'FM defaults to tuner AGC');
  assert.equal(controller.getState().gain, 'auto');
});

test('receiver presets keep the known-working tuning settings', () => {
  assert.deepEqual(SDR_RECEIVER_PRESETS.fm, {
    frequencyHz: 98_500_000,
    sampleRate: 2_048_000,
    ppm: 0,
    rtlAgc: false,
  });
  assert.deepEqual(SDR_RECEIVER_PRESETS.adsb, {
    frequencyHz: 1_090_000_000,
    sampleRate: 2_000_000,
    ppm: 0,
    rtlAgc: false,
  });
});

test('ADS-B opens at manual 20.7 dB and gain changes apply live without reconnecting', async (t) => {
  const events = [];
  let opens = 0;
  const storage = memoryStorage();
  t.after(replaceGlobal('Worker', FakeWorker));
  const controller = new SdrController({
    storage,
    webUsb: {},
    providerFactory: () => ({
      async get() {
        opens += 1;
        return fakeDevice(events);
      },
    }),
  });
  t.after(() => controller.stop());
  assert.equal(controller.getState().gain, 'auto');
  assert.equal(await controller.connect('adsb'), true);
  assert.ok(events.includes('device:gain:20.7'));
  assert.equal(controller.getState().gain, 20.7);

  assert.equal(await controller.setGain('36.4'), 36.4);
  assert.equal(events.at(-1), 'device:gain:36.4');
  assert.equal(await controller.setGain('auto'), 'auto');
  assert.equal(events.at(-1), 'device:gain:null');
  assert.equal(opens, 1, 'gain changes never reopen the receiver');
  assert.deepEqual(JSON.parse(storage.values.get(SDR_GAIN_STORAGE_KEY)), {
    fm: 'auto',
    adsb: 'auto',
  });

  const before = events.length;
  assert.equal(await controller.setGain(28, { mode: 'fm' }), 28);
  assert.equal(events.length, before, 'another mode is stored, not applied');
  assert.equal(controller.getGain('fm'), 28);
  assert.equal(controller.getState().gain, 'auto');
  assert.equal(await controller.setGain('very loud'), null);
});

test('stored per-mode gain is restored on the next session', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const controller = new SdrController({
    storage: memoryStorage({
      [SDR_GAIN_STORAGE_KEY]: JSON.stringify({ fm: 'auto', adsb: 12.5 }),
    }),
    webUsb: {},
    providerFactory: () => ({ get: async () => fakeDevice(events) }),
  });
  t.after(() => controller.stop());
  await controller.connect('adsb');
  assert.ok(events.includes('device:gain:12.5'));
});

test('ADS-B updates report CRC-valid messages per second, heard and positioned', () => {
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
  });
  const heardOnly = {
    icao: 'a15c54',
    lat: null,
    lon: null,
    lastPositionAt: null,
    lastMessageAt: 10_000,
  };
  const positioned = {
    icao: 'ae5d8a',
    lat: 30.27,
    lon: -97.79,
    lastPositionAt: 10_000,
    lastMessageAt: 10_000,
  };
  controller._applyAdsbUpdate(
    { aircraft: [heardOnly, positioned], decodedCount: 12 },
    10_000,
  );
  assert.equal(controller.getState().messagesPerSecond, null);
  controller._applyAdsbUpdate(
    { aircraft: [heardOnly, positioned], decodedCount: 13 },
    12_000,
  );
  const state = controller.getState();
  assert.equal(state.messagesPerSecond, 12.5);
  assert.equal(state.decodedMessages, 25);
  assert.equal(state.aircraftHeard, 2);
  assert.equal(state.aircraftPositioned, 1);
});

test('switching to ADS-B moves to the authorized 1090 MHz channel of a dual board', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const uat = {
    vendorId: 0x0bda,
    productId: 0x2838,
    productName: 'FlyCatcher_UAT',
    serialNumber: '00000001',
  };
  const adsb = { ...uat, productName: 'FlyCatcher_ADS_B' };
  const webUsb = {
    async getDevices() {
      return [uat, adsb];
    },
    async requestDevice() {
      throw new Error('picker should not open');
    },
  };
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb,
    providerFactory: (selectingUsb) => ({
      async get() {
        const chosen = await selectingUsb.requestDevice({
          filters: RTL_SDR_USB_FILTERS,
        });
        return fakeDevice(events, chosen.productName);
      },
    }),
  });
  t.after(() => controller.stop());
  // FM on a FlyCatcher has no preferred channel, so the first one opens.
  controller.state.mode = 'fm';
  controller._ensureAudio = async () => true;
  assert.equal(await controller.connect('fm'), true);
  assert.equal(controller.getState().deviceLabel, 'FlyCatcher_UAT');

  assert.equal(await controller.setMode('adsb'), true);
  assert.ok(events.includes('FlyCatcher_UAT:close'));
  assert.ok(events.includes('FlyCatcher_ADS_B:tune:1090000000'));
  assert.equal(controller.getState().deviceLabel, 'FlyCatcher_ADS_B');
  assert.equal(controller.getState().mode, 'adsb');
  assert.equal(controller.getState().connected, true);
});

test('CHANGE DEVICE reopens through the WebUSB picker', async (t) => {
  t.after(replaceGlobal('Worker', FakeWorker));
  let pickerCalls = 0;
  const device = {
    vendorId: 0x0bda,
    productId: 0x2838,
    productName: 'RTL2838UHIDIR',
    serialNumber: '1',
  };
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {
      async getDevices() {
        return [device];
      },
      async requestDevice() {
        pickerCalls += 1;
        return device;
      },
    },
    providerFactory: (selectingUsb) => ({
      async get() {
        await selectingUsb.requestDevice({ filters: RTL_SDR_USB_FILTERS });
        return fakeDevice();
      },
    }),
  });
  t.after(() => controller.stop());
  controller.state.mode = 'adsb';
  assert.equal(await controller.connect('adsb'), true);
  assert.equal(pickerCalls, 0, 'an authorized receiver opens without a picker');
  assert.equal(await controller.changeDevice(), true);
  assert.equal(pickerCalls, 1);
  assert.equal(controller.getState().connected, true);
});

test('remembered WebUSB receiver is reused without opening the picker', async () => {
  const remembered = {
    vendorId: 0x0bda,
    productId: 0x2838,
    serialNumber: 'known',
  };
  let pickerCalls = 0;
  const webUsb = createRememberingWebUsb({
    async getDevices() {
      return [remembered];
    },
    async requestDevice() {
      pickerCalls += 1;
      return null;
    },
  });

  const result = await webUsb.requestDevice({
    filters: [{ vendorId: 0x0bda, productId: 0x2838 }],
  });

  assert.equal(result, remembered);
  assert.equal(pickerCalls, 0);
});

test('WebUSB picker remains available when no authorized receiver matches', async () => {
  const selected = { vendorId: 0x0bda, productId: 0x2832 };
  let pickerCalls = 0;
  const webUsb = createRememberingWebUsb({
    async getDevices() {
      return [{ vendorId: 0x1234, productId: 0x5678 }];
    },
    async requestDevice() {
      pickerCalls += 1;
      return selected;
    },
  });

  const result = await webUsb.requestDevice({
    filters: [{ vendorId: 0x0bda, productId: 0x2832 }],
  });

  assert.equal(result, selected);
  assert.equal(pickerCalls, 1);
});
