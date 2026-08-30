import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRememberingWebUsb,
  SDR_RECEIVER_PRESETS,
  SdrController,
} from './controller.js';

function replaceGlobal(name, value) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (prior) Object.defineProperty(globalThis, name, prior);
    else delete globalThis[name];
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
        addModule: async () => { events.push('audio:module'); },
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
  class FakeWorker {
    postMessage() {}
    terminate() {}
  }
  const device = {
    setSampleRate: async (rate) => rate,
    setFrequencyCorrection: async () => {},
    setCenterFrequency: async (frequency) => frequency,
    setGain: async () => {},
    _enableRtlAgc: async (enabled) => { events.push(`rtl-agc:${enabled}`); },
    resetBuffer: async () => {},
    readSamples: () => new Promise(() => {}),
    close: async () => {},
  };
  const restore = [
    replaceGlobal('navigator', { usb: {} }),
    replaceGlobal('AudioContext', FakeAudioContext),
    replaceGlobal('AudioWorkletNode', FakeAudioWorkletNode),
    replaceGlobal('Worker', FakeWorker),
  ];
  t.after(() => restore.reverse().forEach((callback) => callback()));

  const controller = new SdrController({
    providerFactory: () => ({
      async get() {
        events.push('usb:get');
        return device;
      },
    }),
  });

  assert.equal(await controller.connect('fm'), true);
  assert.ok(events.indexOf('audio:resume') < events.indexOf('usb:get'));
  assert.equal(controller.getState().audioState, 'running');
  assert.equal(controller.getState().connected, true);
  assert.ok(events.includes('rtl-agc:false'));
});

test('receiver presets match the known-working OpenSignal settings', () => {
  assert.deepEqual(SDR_RECEIVER_PRESETS.fm, {
    frequencyHz: 98_500_000,
    sampleRate: 2_048_000,
    ppm: 0,
    gain: null,
    rtlAgc: false,
  });
  assert.deepEqual(SDR_RECEIVER_PRESETS.adsb, {
    frequencyHz: 1_090_000_000,
    sampleRate: 2_000_000,
    ppm: 0,
    gain: null,
    rtlAgc: false,
  });
});

test('remembered WebUSB receiver is reused without opening the picker', async () => {
  const remembered = { vendorId: 0x0bda, productId: 0x2838, serialNumber: 'known' };
  let pickerCalls = 0;
  const webUsb = createRememberingWebUsb({
    async getDevices() { return [remembered]; },
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
    async getDevices() { return [{ vendorId: 0x1234, productId: 0x5678 }]; },
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
