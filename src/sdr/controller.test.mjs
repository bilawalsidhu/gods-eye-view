import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRememberingWebUsb,
  SDR_RECEIVER_PRESETS,
  SdrController,
} from './controller.js';
import { RTL2832U_Provider } from '@jtarrio/webrtlsdr/rtlsdr.js';
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
  constructor() {
    // Like the real worker, report ready once loaded.
    queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
  }

  // Like the real worker, every numbered samples block is acknowledged.
  postMessage(message) {
    if (message?.type === 'samples' && Number.isSafeInteger(message.id))
      queueMicrotask(() =>
        this.onmessage?.({ data: { type: 'ack', id: message.id } }),
      );
  }
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

test('ADS-B opens at manual 28.0 dB and gain changes apply live without reconnecting', async (t) => {
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
  assert.ok(events.includes('device:gain:28'));
  assert.equal(controller.getState().gain, 28);

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

/** Resolve with the promise's value, or 'timed out' after `ms`. */
function within(promise, ms = 1_000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timed out'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A device whose bulk reads hang until the raw WebUSB device is closed,
 * the way a stalled `transferIn` behaves: `USBDevice.close()` aborts it.
 */
function stallingDevice(events, name = 'stalled') {
  const pendingReads = new Set();
  const usb = {
    opened: true,
    async close() {
      events.push(`${name}:usb-close`);
      usb.opened = false;
      for (const reject of pendingReads) reject(new Error('AbortError'));
      pendingReads.clear();
    },
  };
  const base = fakeDevice(events, name);
  return {
    ...base,
    com: { device: usb },
    readSamples: () =>
      new Promise((_, reject) => {
        events.push(`${name}:read`);
        pendingReads.add(reject);
      }),
    // The graceful close needs the bus, which the stalled transfer holds.
    close: () => new Promise(() => events.push(`${name}:graceful-close`)),
  };
}

test('a stalled USB read cannot wedge stop(): the raw device is closed and the queue replaced', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const devices = [stallingDevice(events), fakeDevice(events, 'fresh')];
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
    readStallMs: 60_000,
    closeTimeoutMs: 50,
    providerFactory: () => ({ get: async () => devices.shift() }),
  });
  t.after(() => controller.destroy());
  assert.equal(await controller.connect('adsb'), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(events.includes('stalled:read'), 'a read is in flight');

  assert.equal(await within(controller.stop()), true, 'stop() returns');
  assert.ok(events.includes('stalled:usb-close'), 'raw USB device closed');
  assert.equal(controller.getState().connected, false);

  // The next session is not queued behind the abandoned transfer.
  assert.equal(await within(controller.connect('adsb')), true);
  assert.ok(events.includes('fresh:tune:1090000000'));
});

test('a stalled USB read times out and tears the session down on its own', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
    readStallMs: 30,
    closeTimeoutMs: 30,
    providerFactory: () => ({ get: async () => stallingDevice(events) }),
  });
  t.after(() => controller.destroy());
  assert.equal(await controller.connect('adsb'), true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = controller.getState();
  assert.equal(state.connected, false);
  assert.equal(state.status, 'error');
  assert.equal(state.message, 'RTL-SDR sample stream stopped');
  assert.ok(events.includes('stalled:usb-close'));
  // Mode changes work again instead of queuing behind the dead read.
  assert.equal(await within(controller.setMode('fm')), true);
});

test('destroy() during a pending connect closes the late device instead of resuming the session', async (t) => {
  const events = [];
  const workers = [];
  class CountingWorker extends FakeWorker {
    constructor() {
      super();
      workers.push(this);
    }
  }
  t.after(replaceGlobal('Worker', CountingWorker));
  let deliver = null;
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
    providerFactory: () => ({
      get: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    }),
  });
  const connecting = controller.connect('adsb');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof deliver, 'function', 'device acquisition is pending');
  await controller.destroy();
  deliver(fakeDevice(events, 'late'));
  assert.equal(await within(connecting), false);
  assert.ok(events.includes('late:close'), 'late device is closed');
  assert.ok(!events.includes('late:tune:1090000000'), 'never configured');
  assert.equal(controller.getState().connected, false);
  assert.notEqual(controller.getState().status, 'streaming');
  assert.equal(workers.length, 0, 'no decoder worker is created');
});

test('a failed decoder worker is discarded and reconnect builds a fresh one', async (t) => {
  const events = [];
  const workers = [];
  class RecordingWorker {
    constructor() {
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }

    postMessage(message) {
      this.messages.push(message.type);
    }

    terminate() {
      this.terminated = true;
    }
  }
  t.after(replaceGlobal('Worker', RecordingWorker));
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
    providerFactory: () => ({ get: async () => fakeDevice(events) }),
  });
  t.after(() => controller.destroy());
  assert.equal(await controller.connect('adsb'), true);
  assert.equal(workers.length, 1);
  workers[0].onerror?.({ message: 'module failed to load' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.getState().status, 'error');
  assert.equal(workers[0].terminated, true, 'failed worker terminated');

  await controller.stop();
  assert.equal(await controller.connect('adsb'), true);
  assert.equal(workers.length, 2, 'reconnect creates a fresh worker');
  assert.ok(workers[1].messages.includes('configure'));
  assert.equal(controller.getState().status, 'streaming');
});

/**
 * One WebUSB device shared by every session: WebUSB hands a reopened
 * receiver back as the SAME `USBDevice` object. Like the real one, close()
 * aborts pending transfers at once and resolves a little later.
 */
function sharedUsb(events, { closeNeverSettles = false } = {}) {
  const usb = {
    opened: false,
    pendingReads: new Set(),
    async open() {
      events.push('usb-open');
      usb.opened = true;
    },
    close() {
      events.push('usb-close');
      usb.opened = false;
      for (const reject of usb.pendingReads) reject(new Error('AbortError'));
      usb.pendingReads.clear();
      if (closeNeverSettles) return new Promise(() => {});
      return new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
  return usb;
}

/**
 * An RTL2832U over `usb` that, like the library, reaches the hardware
 * through `com.device`; its graceful close can be held open by `closeGate`.
 */
function rtlOver(usb, events, name, { stallReads = false, closeGate } = {}) {
  const device = {
    ...fakeDevice(events, name),
    com: { device: usb },
    readSamples() {
      if (stallReads)
        return new Promise((_, reject) => {
          events.push(`${name}:read`);
          usb.pendingReads.add(reject);
        });
      return new Promise((resolve, reject) =>
        setTimeout(
          () =>
            usb.opened
              ? resolve({ data: new ArrayBuffer(8) })
              : reject(new Error('device closed')),
          2,
        ),
      );
    },
    async close() {
      events.push(`${name}:graceful-close`);
      if (closeGate) await closeGate;
      await device.com.device.close();
    },
  };
  return device;
}

function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sharedUsbController(usb, devices) {
  return new SdrController({
    storage: memoryStorage(),
    webUsb: {},
    readStallMs: 60_000,
    closeTimeoutMs: 30,
    providerFactory: () => ({
      async get() {
        await usb.open();
        return devices.shift();
      },
    }),
  });
}

test('a graceful close queued behind a stalled read never runs once the raw device is closed', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = sharedUsb(events);
  const held = gate();
  const controller = sharedUsbController(usb, [
    rtlOver(usb, events, 'old', { stallReads: true, closeGate: held.promise }),
    rtlOver(usb, events, 'new'),
  ]);
  t.after(() => controller.destroy());
  assert.equal(await controller.connect('adsb'), true);
  await pause(5);
  assert.equal(await within(controller.stop()), true);
  assert.equal(await within(controller.connect('adsb')), true);
  // Whatever the old session still had queued is released now.
  held.open();
  await pause(30);
  assert.ok(
    !events.includes('old:graceful-close'),
    'queued close abandoned before the raw close',
  );
  assert.equal(usb.opened, true, 'the reopened device stays open');
  const state = controller.getState();
  assert.equal(state.status, 'streaming');
  assert.equal(state.connected, true);
});

test('a graceful close already running when abandoned cannot close the reopened device', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = sharedUsb(events);
  const held = gate();
  const controller = sharedUsbController(usb, [
    rtlOver(usb, events, 'old', { closeGate: held.promise }),
    rtlOver(usb, events, 'new'),
  ]);
  t.after(() => controller.destroy());
  assert.equal(await controller.connect('adsb'), true);
  await pause(5);
  assert.equal(await within(controller.stop()), true);
  assert.ok(events.includes('old:graceful-close'), 'graceful close started');
  assert.equal(await within(controller.connect('adsb')), true);
  // The old close resumes, as a stuck control transfer finally completes.
  held.open();
  await pause(30);
  assert.equal(usb.opened, true, 'the reopened device stays open');
  const state = controller.getState();
  assert.equal(state.status, 'streaming');
  assert.equal(state.connected, true);
});

test('teardown is single-flight: a second stop() and a connect() wait for the device close', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = sharedUsb(events);
  const controller = sharedUsbController(usb, [
    // The graceful close never finishes: only the raw close ends it.
    rtlOver(usb, events, 'old', { closeGate: new Promise(() => {}) }),
    rtlOver(usb, events, 'new'),
  ]);
  t.after(() => controller.destroy());
  assert.equal(await controller.connect('adsb'), true);
  const first = controller.stop();
  let secondDone = false;
  const second = controller.stop().then(() => {
    secondDone = true;
    events.push('second-stop-done');
  });
  const reconnect = controller.connect('adsb');
  await pause(5);
  assert.equal(secondDone, false, 'the second stop joins the teardown');
  await within(Promise.all([first, second]));
  assert.equal(await within(reconnect), true);
  assert.ok(
    events.indexOf('usb-close') < events.indexOf('second-stop-done'),
    'second stop returns after the device is closed',
  );
  assert.ok(
    events.indexOf('usb-close') < events.lastIndexOf('usb-open'),
    'the device is reopened only after the old session closed it',
  );
  await pause(30);
  assert.equal(usb.opened, true);
  assert.equal(controller.getState().status, 'streaming');
  assert.equal(controller.getState().connected, true);
});

test('stop() settles within its deadline even when the raw USB close never settles', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = sharedUsb(events, { closeNeverSettles: true });
  const controller = sharedUsbController(usb, [
    rtlOver(usb, events, 'old', { stallReads: true }),
  ]);
  t.after(() => controller.destroy());
  assert.equal(await controller.connect('adsb'), true);
  await pause(5);
  const startedAt = Date.now();
  assert.equal(await within(controller.stop(), 500), true);
  // Graceful close deadline plus raw close deadline, with scheduling slack.
  assert.ok(Date.now() - startedAt < 250, `${Date.now() - startedAt} ms`);
  assert.ok(events.includes('usb-close'), 'raw close attempted');
  assert.equal(controller.getState().connected, false);
});

test('a mode change queued behind a stalled read never reports streaming after the stall teardown', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
    readStallMs: 30,
    closeTimeoutMs: 30,
    providerFactory: () => ({ get: async () => stallingDevice(events) }),
  });
  t.after(() => controller.destroy());
  assert.equal(await controller.connect('adsb'), true);
  const switched = await within(controller.setMode('adsb'));
  assert.equal(switched, false, 'the superseded switch fails');
  await pause(100);
  const state = controller.getState();
  assert.notEqual(state.status, 'streaming');
  assert.equal(state.connected, false);
  assert.equal(controller._device, null);
});

/**
 * A raw WebUSB RTL-SDR for the installed `RTL2832U_Provider`: open and claim
 * succeed, and the first initialization transfer fails, either at once or
 * (with `hold`) only when the device is closed, like a stuck control transfer.
 */
function failingInitUsb(events, { hold = false } = {}) {
  const pending = new Set();
  const usb = {
    vendorId: 0x0bda,
    productId: 0x2838,
    productName: 'RTL2838UHIDIR',
    serialNumber: 'init-fails',
    opened: false,
    async open() {
      events.push('open');
      usb.opened = true;
    },
    async claimInterface() {
      events.push('claim');
    },
    async releaseInterface() {},
    controlTransferOut() {
      events.push('init-transfer');
      if (!hold) return Promise.reject(new Error('transfer error'));
      return new Promise((_, reject) => pending.add(reject));
    },
    controlTransferIn() {
      return Promise.reject(new Error('transfer error'));
    },
    async close() {
      events.push('close');
      usb.opened = false;
      for (const reject of pending) reject(new Error('AbortError'));
      pending.clear();
    },
  };
  return usb;
}

function failingInitController(usb) {
  return new SdrController({
    storage: memoryStorage(),
    closeTimeoutMs: 30,
    // No providerFactory: the installed RTL2832U_Provider opens the device.
    webUsb: {
      async getDevices() {
        return [usb];
      },
      async requestDevice() {
        return usb;
      },
    },
  });
}

test('a receiver whose initialization fails is closed and destroy() settles', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = failingInitUsb(events);
  const controller = failingInitController(usb);
  assert.equal(await within(controller.connect('adsb')), false);
  assert.deepEqual(events, ['open', 'claim', 'init-transfer', 'close']);
  assert.equal(usb.opened, false, 'the raw device is not left open');
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().connected, false);
  assert.notEqual(await within(controller.destroy()), 'timed out');
  assert.equal(controller._acquisitions.size, 0);
});

test('a superseded receiver initialization that then fails still closes the device', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = failingInitUsb(events, { hold: true });
  const controller = failingInitController(usb);
  const connecting = controller.connect('adsb');
  await pause(5);
  assert.ok(events.includes('init-transfer'), 'initialization is in flight');
  assert.notEqual(await within(controller.destroy()), 'timed out');
  assert.equal(await within(connecting), false);
  assert.ok(events.includes('close'));
  assert.equal(usb.opened, false, 'the raw device is not left open');
  assert.notEqual(controller.getState().status, 'streaming');
  assert.equal(controller._acquisitions.size, 0);
});

/**
 * A provider shaped like the library's: it records the raw device before
 * opening it, and its initialization can be held open by `initGate`.
 */
function heldProvider(usb, events, name, initGate) {
  return {
    device: undefined,
    async get() {
      this.device = usb;
      await usb.open();
      events.push(`${name}:init`);
      if (initGate) await initGate;
      return rtlOver(usb, events, name);
    },
  };
}

function acquisitionController(providers, closeTimeoutMs = 30) {
  return new SdrController({
    storage: memoryStorage(),
    webUsb: {},
    readStallMs: 60_000,
    closeTimeoutMs,
    providerFactory: () => providers.shift(),
  });
}

test('a newer connect waits for an older acquisition to finish closing its device', async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = sharedUsb(events);
  const heldA = gate();
  const controller = acquisitionController(
    [
      heldProvider(usb, events, 'A', heldA.promise),
      heldProvider(usb, events, 'B'),
    ],
    // Long enough that B does not give up on A while it is held.
    1_000,
  );
  t.after(() => controller.destroy());
  const connectA = controller.connect('adsb');
  await pause(5);
  const connectB = controller.connect('adsb');
  await pause(5);
  assert.ok(!events.includes('B:init'), 'B waits for A');
  heldA.open();
  assert.equal(await within(connectA), false, 'A was superseded');
  assert.equal(await within(connectB), true);
  assert.ok(
    events.lastIndexOf('usb-close') < events.indexOf('B:init'),
    'A closed its device before B opened it',
  );
  await pause(30);
  assert.equal(usb.opened, true, "B's device stays open");
  assert.equal(controller.getState().status, 'streaming');
  assert.equal(controller.getState().connected, true);
});

test("a held older acquisition released after a newer session starts never closes that session's device", async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = sharedUsb(events);
  const heldA = gate();
  const controller = acquisitionController([
    heldProvider(usb, events, 'A', heldA.promise),
    heldProvider(usb, events, 'B'),
  ]);
  t.after(() => controller.destroy());
  const connectA = controller.connect('adsb');
  await pause(5);
  // B gives up waiting on the stuck acquisition A and completes.
  assert.equal(await within(controller.connect('adsb')), true);
  assert.equal(controller.getState().status, 'streaming');
  const closes = () => events.filter((event) => event === 'usb-close').length;
  const closesBeforeRelease = closes();
  heldA.open();
  assert.equal(await within(connectA), false);
  await pause(30);
  assert.equal(
    closes(),
    closesBeforeRelease,
    "A's cleanup does not close the device B reopened",
  );
  assert.ok(!events.includes('A:graceful-close'));
  assert.equal(usb.opened, true);
  const state = controller.getState();
  assert.equal(state.status, 'streaming');
  assert.equal(state.connected, true);
  assert.equal(controller._acquisitions.size, 0);
});

test("an older acquisition's cleanup that outlives the wait never closes the newer session's device", async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = sharedUsb(events);
  const heldA = gate();
  // A's graceful close never finishes: only its fallback raw close ends it.
  const providerA = {
    device: undefined,
    async get() {
      this.device = usb;
      await usb.open();
      events.push('A:init');
      await heldA.promise;
      return rtlOver(usb, events, 'A', { closeGate: new Promise(() => {}) });
    },
  };
  const controller = acquisitionController(
    [providerA, heldProvider(usb, events, 'B')],
    40,
  );
  t.after(() => controller.destroy());
  const connectA = controller.connect('adsb');
  await pause(5);
  const connectB = controller.connect('adsb');
  // A's cleanup starts shortly before B stops waiting for it (3 x 40 ms), so
  // its fallback raw close comes due after B is already streaming.
  await pause(100);
  heldA.open();
  assert.equal(await within(connectA), false, 'A was superseded');
  assert.ok(events.includes('A:graceful-close'), "A's cleanup is running");
  assert.equal(await within(connectB), true);
  const closesAfterB = events.filter((event) => event === 'usb-close').length;
  await pause(80);
  assert.equal(
    events.filter((event) => event === 'usb-close').length,
    closesAfterB,
    "A's fallback close does not close B's device",
  );
  assert.equal(usb.opened, true, "B's device stays open");
  const state = controller.getState();
  assert.equal(state.status, 'streaming');
  assert.equal(state.connected, true);
});

test("a device selection that resolves after its acquisition was superseded cannot touch the newer session's device", async (t) => {
  const events = [];
  t.after(replaceGlobal('Worker', FakeWorker));
  const usb = Object.assign(sharedUsb(events), {
    vendorId: 0x0bda,
    productId: 0x2838,
    productName: 'RTL2838UHIDIR',
    serialNumber: 'shared',
    async claimInterface() {
      events.push('usb-claim');
    },
    async releaseInterface() {
      events.push('usb-release');
    },
    async controlTransferOut() {
      events.push('usb-write');
      throw new Error('transfer error');
    },
    async controlTransferIn() {
      events.push('usb-read');
      throw new Error('transfer error');
    },
  });
  const heldSelection = gate();
  let getDevicesCalls = 0;
  const webUsb = {
    async getDevices() {
      getDevicesCalls += 1;
      // A's selection is held; B's resolves at once.
      if (getDevicesCalls === 1) await heldSelection.promise;
      return [usb];
    },
    async requestDevice() {
      return usb;
    },
  };
  let providers = 0;
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb,
    readStallMs: 60_000,
    closeTimeoutMs: 20,
    providerFactory: (webusb) => {
      providers += 1;
      // A is the installed library provider; B opens the same device
      // through the same selecting wrapper and streams.
      if (providers === 1) return new RTL2832U_Provider({ webusb });
      return {
        device: undefined,
        async get() {
          this.device = await webusb.requestDevice({
            filters: RTL_SDR_USB_FILTERS,
          });
          await this.device.open();
          return rtlOver(this.device, events, 'B');
        },
      };
    },
  });
  t.after(() => controller.destroy());
  const connectA = controller.connect('adsb');
  await pause(5);
  assert.equal(await within(controller.connect('adsb')), true);
  assert.equal(controller.getState().status, 'streaming');
  const eventsBeforeRelease = events.length;
  heldSelection.open();
  assert.equal(await within(connectA), false, 'A was superseded');
  await pause(30);
  const late = events
    .slice(eventsBeforeRelease)
    .filter((event) => event.startsWith('usb-'));
  assert.deepEqual(late, [], "A's late selection never reaches the device");
  assert.equal(usb.opened, true, "B's device stays open");
  const state = controller.getState();
  assert.equal(state.status, 'streaming');
  assert.equal(state.connected, true);
});

/** An FM spectrum frame centred on `center` with carriers at `stations`. */
function fmSpectrum(stations, center, sampleRate) {
  const bins = new Float32Array(512).fill(-80);
  for (const station of stations) {
    const index = Math.round(
      (station - center) / (sampleRate / bins.length) + bins.length / 2,
    );
    for (let bin = index - 5; bin <= index + 5; bin += 1) {
      if (bin >= 0 && bin < bins.length) bins[bin] = -10;
    }
  }
  return bins;
}

/**
 * An open FM receiver hearing `stations`. Like the real worker, spectra of
 * samples read before a retune keep arriving after it: one during the retune
 * and one after the worker's reset, each drawn at the previous centre and
 * tagged with the previous tune, before the first spectrum at the new centre.
 */
function fmSeekController(stations) {
  const events = [];
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
  });
  const { sampleRate } = controller.getState();
  let center = null;
  let workerTune = 0;
  const deliver = (tune, at) =>
    controller._handleWorkerMessage({
      type: 'fm',
      bins: fmSpectrum(stations, at, sampleRate),
      tune,
    });
  let previous = null;
  controller._worker = {
    postMessage(message) {
      if (message.type !== 'reset') return;
      const stale = [workerTune, previous];
      const fresh = [message.tune, center];
      workerTune = message.tune;
      if (stale[1] !== null) setTimeout(() => deliver(...stale), 0);
      setTimeout(() => deliver(...fresh), 1);
    },
    terminate() {},
  };
  const device = fakeDevice(events);
  const setCenterFrequency = device.setCenterFrequency;
  device.setCenterFrequency = async (frequency) => {
    if (center !== null) deliver(workerTune, center);
    previous = center;
    center = frequency;
    return setCenterFrequency(frequency);
  };
  controller._device = device;
  return { controller, events };
}

async function seekFrom(origin, direction, stations, prepare = () => {}) {
  const { controller, events } = fmSeekController(stations);
  await controller.tuneFm(origin);
  await new Promise((resolve) => setTimeout(resolve, 0));
  prepare(controller);
  events.length = 0;
  const scanned = new Set();
  controller.subscribe(({ seekMessage }) => {
    const match = /^Scanning ([\d.]+) MHz/.exec(seekMessage);
    if (match) scanned.add(Number(match[1]));
  });
  const peak = await controller.seekFm(direction);
  const tuned = events.filter((event) => event.startsWith('device:tune:'));
  return { peak, state: controller.getState(), tuned, scanned };
}

test('FM seek wraps past either band edge and finds the next station', async () => {
  const cases = [
    // [origin, direction, stations, expected]
    [107_500_000, 1, [88_500_000], 88_500_000],
    [107_500_000, 1, [106_000_000, 88_500_000, 87_900_000], 87_900_000],
    [107_900_000, 1, [87_500_000], 87_500_000],
    [88_000_000, -1, [107_000_000], 107_000_000],
    [88_000_000, -1, [89_000_000, 107_000_000, 107_600_000], 107_600_000],
    [87_600_000, -1, [108_000_000], 108_000_000],
  ];
  for (const [origin, direction, stations, expected] of cases) {
    const { peak, state } = await seekFrom(origin, direction, stations);
    const label = `${direction > 0 ? 'up' : 'down'} from ${origin}`;
    assert.equal(peak?.frequency, expected, label);
    assert.equal(state.frequencyHz, expected, label);
    assert.equal(state.seeking, false, label);
  }
});

test('FM seek reaches both band-edge channels from anywhere in the band', async () => {
  for (let origin = 87_600_000; origin < 108_000_000; origin += 1_300_000) {
    for (const direction of [1, -1]) {
      for (const station of [87_500_000, 108_000_000]) {
        const { peak } = await seekFrom(origin, direction, [station]);
        assert.equal(
          peak?.frequency,
          station,
          `${direction > 0 ? 'up' : 'down'} from ${origin} to ${station}`,
        );
      }
    }
  }
});

test('FM seek laps the band to a station just behind the origin', async () => {
  assert.equal(
    (await seekFrom(98_500_000, 1, [98_200_000])).peak?.frequency,
    98_200_000,
  );
  assert.equal(
    (await seekFrom(98_500_000, -1, [98_800_000])).peak?.frequency,
    98_800_000,
  );
});

test('FM seek with no other station stops after one lap and returns to the origin', async () => {
  for (const stations of [[], [98_500_000]]) {
    for (const direction of [1, -1]) {
      const { peak, state, tuned, scanned } = await seekFrom(
        98_500_000,
        direction,
        stations,
      );
      const label = `${stations.length} station(s), direction ${direction}`;
      assert.equal(peak, null, label);
      assert.equal(state.seeking, false, label);
      assert.equal(state.seekMessage, 'No FM signal found', label);
      assert.equal(state.frequencyHz, 98_500_000, label);
      // 19 frames, then the retune to the origin.
      assert.equal(tuned.length, 20, label);
      for (const mhz of scanned) {
        assert.ok(mhz >= 87.5 && mhz <= 108, `${label}: scanning ${mhz} MHz`);
      }
    }
  }
});

test('FM seek passes over its own station to the next one in the same frame', async () => {
  // The first frame's spectrum never arrives, so 98.7 is first seen in the
  // last frame of the lap, behind the origin's own carrier.
  const { peak } = await seekFrom(
    98_500_000,
    1,
    [98_500_000, 98_700_000],
    (controller) => {
      const wait = controller._waitForSpectrum.bind(controller);
      let first = true;
      controller._waitForSpectrum = async (...args) => {
        if (!first) return wait(...args);
        first = false;
        return false;
      };
    },
  );
  assert.equal(peak?.frequency, 98_700_000);
});

test('FM seek stops when a retune fails instead of reading the old frame', async () => {
  const { peak, state, tuned } = await seekFrom(
    98_500_000,
    1,
    [102_100_000],
    (controller) => {
      const device = controller._device;
      const setCenterFrequency = device.setCenterFrequency;
      let calls = 0;
      device.setCenterFrequency = async (frequency) => {
        calls += 1;
        if (calls === 2) throw new Error('transfer error');
        return setCenterFrequency(frequency);
      };
    },
  );
  assert.equal(peak, null);
  assert.equal(state.seeking, false);
  assert.equal(state.seekMessage, 'Seek stopped');
  assert.equal(state.status, 'error');
  assert.equal(tuned.length, 1, 'no frame is tuned after the failure');
});

test('a retune that fails part-way drops spectra until a retune succeeds', async () => {
  const resets = [];
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
  });
  const device = fakeDevice();
  controller._device = device;
  controller._worker = {
    postMessage: (message) => {
      if (message.type === 'reset') resets.push(message.tune);
    },
    terminate() {},
  };
  const spectrum = (tune) =>
    controller._handleWorkerMessage({
      type: 'fm',
      bins: new Float32Array(512),
      tune,
    });
  assert.equal(await controller.tuneFm(98_500_000), true);
  const workerTune = resets.at(-1);
  spectrum(workerTune);
  const accepted = controller._spectrumSequence;
  assert.equal(accepted, 1);
  // The tuner moves, then the buffer reset fails: the worker is never reset,
  // so samples at the new frequency still carry its old tag.
  device.resetBuffer = async () => {
    throw new Error('transfer error');
  };
  assert.equal(await controller.tuneFm(99_700_000), false);
  assert.deepEqual(resets, [workerTune]);
  spectrum(workerTune);
  assert.equal(controller._spectrumSequence, accepted);
  device.resetBuffer = async () => {};
  assert.equal(await controller.tuneFm(99_700_000), true);
  spectrum(resets.at(-1));
  assert.equal(controller._spectrumSequence, accepted + 1);
});

test("a rebuilt decoder worker's spectra are accepted before its first reset", async (t) => {
  const workers = [];
  class TaggedWorker {
    constructor() {
      workers.push(this);
    }

    postMessage() {}

    terminate() {}
  }
  t.after(replaceGlobal('Worker', TaggedWorker));
  const controller = new SdrController({
    storage: memoryStorage(),
    webUsb: {},
  });
  controller._device = fakeDevice();
  controller._ensureWorker();
  await controller.tuneFm(98_500_000);
  await controller.tuneFm(99_700_000);
  controller._discardWorker();
  controller._ensureWorker();
  assert.equal(workers.length, 2);
  const before = controller._spectrumSequence;
  // Like sdr.worker.js, a fresh worker tags its spectra 0 until a reset.
  workers[1].onmessage({
    data: { type: 'fm', bins: new Float32Array(512), tune: 0 },
  });
  assert.equal(controller._spectrumSequence, before + 1);
});
