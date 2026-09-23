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

/** Resolve with the promise's value, or 'timed out' after `ms`. */
function within(promise, ms = 1_000) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve('timed out'), ms)),
  ]);
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
