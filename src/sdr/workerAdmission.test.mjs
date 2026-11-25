import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker as ThreadWorker } from 'node:worker_threads';

import { SdrController } from './controller.js';

const ADMISSION = {
  maxBlocks: 4,
  maxBytes: 4 * 64,
  maxAgeMs: 60,
  watchdogMs: 10,
  reportMs: 20,
  readyTimeoutMs: 150,
};

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait (bounded) until `check` holds. */
async function until(check, ms = 1_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await pause(2);
  }
}

/** A decoder stand-in that records blocks and acknowledges as told. */
function installWorker(t, { ack = 'auto', readyAfterMs = 0 } = {}) {
  const workers = [];
  class AckWorker {
    constructor() {
      this.blocks = [];
      this.messages = [];
      this.terminated = false;
      workers.push(this);
      // Like the real worker, report ready once the module has loaded.
      if (readyAfterMs !== null)
        setTimeout(() => this.emit({ type: 'ready' }), readyAfterMs);
    }
    postMessage(message) {
      this.messages.push(message);
      if (message?.type !== 'samples') return;
      this.blocks.push(message.id);
      if (ack === 'auto') queueMicrotask(() => this.ack(message.id));
    }
    ack(id) {
      this.onmessage?.({ data: { type: 'ack', id } });
    }
    emit(data) {
      this.onmessage?.({ data });
    }
    terminate() {
      this.terminated = true;
    }
  }
  const prior = globalThis.Worker;
  globalThis.Worker = AckWorker;
  t.after(() => {
    globalThis.Worker = prior;
  });
  return workers;
}

/** A streaming controller with a device that yields one block per read. */
function streaming(t, { reads = Infinity, admission = ADMISSION } = {}) {
  const controller = new SdrController({
    storage: { getItem: () => null, setItem() {} },
    webUsb: {},
    workerAdmission: admission,
  });
  const audio = [];
  controller._audioNode = {
    port: { postMessage: (message) => audio.push(message) },
  };
  let served = 0;
  const device = {
    readSamples: (count) =>
      served++ < reads
        ? new Promise((resolve) =>
            setTimeout(() => resolve({ data: new ArrayBuffer(64) }), 1),
          )
        : new Promise(() => {}),
    close: async () => {},
  };
  controller._device = device;
  controller._setState({ mode: 'fm', status: 'streaming', connected: true });
  controller._beginAudioSession();
  controller._readGeneration += 1;
  controller._startWatchdog();
  void controller._readLoop(controller._readGeneration);
  t.after(() => {
    controller._stopWatchdog();
    controller._readGeneration += 1;
    controller._device = null;
  });
  return { controller, audio, device };
}

test('a slow decoder startup is not an overload: no block is sent before ready', async (t) => {
  // Ready after 200 ms: longer than the 4 blocks the cap admits (and than the
  // 128 ms the production cap of 8 blocks covers).
  const workers = installWorker(t, { readyAfterMs: 200 });
  const admission = { ...ADMISSION, readyTimeoutMs: 1_000 };
  const { controller } = streaming(t, { reads: 10, admission });
  await pause(150);
  assert.equal(workers[0].blocks.length, 0, 'no block before ready');
  assert.equal(controller.getState().status, 'streaming');
  await until(() => workers[0].blocks.length >= 10);
  assert.equal(controller.getState().status, 'streaming');
  assert.equal(controller.getState().decoderOverload, undefined);
});

test('a decoder that never becomes ready stops the receiver at the startup bound', async (t) => {
  const workers = installWorker(t, { readyAfterMs: null });
  const { controller } = streaming(t, { reads: 10 });
  await until(() => controller.getState().status === 'error', 1_000);
  assert.equal(controller.getState().decoderOverload, 'startup');
  assert.equal(workers[0].blocks.length, 0);
  assert.equal(workers[0].terminated, true);
});

test('an acknowledging decoder streams with pending work bounded', async (t) => {
  const workers = installWorker(t);
  const { controller } = streaming(t, { reads: 40 });
  await until(() => workers[0]?.blocks.length >= 40);
  await pause(5);
  assert.equal(controller.getState().status, 'streaming');
  assert.equal(controller._pendingBlocks.size, 0);
  assert.equal(workers[0].terminated, false);
});

test('a decoder that falls behind stops the receiver at the block bound', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const { controller } = streaming(t);
  await until(() => controller.getState().status === 'error');
  const worker = workers[0];
  assert.equal(worker.blocks.length, ADMISSION.maxBlocks, 'never past the cap');
  assert.equal(worker.terminated, true, 'decoder terminated');
  assert.equal(controller.getState().decoderOverload, 'backlog');
  assert.equal(controller._pendingBlocks.size, 0);
  const posted = worker.blocks.length;
  await pause(20);
  assert.equal(worker.blocks.length, posted, 'nothing posted after overload');
});

test('a hung decoder is stopped by age even when no further USB block arrives', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const { controller } = streaming(t, { reads: 2 });
  await until(() => workers[0]?.blocks.length === 2);
  await until(() => controller.getState().status === 'error', 1_000);
  assert.equal(controller.getState().decoderOverload, 'stalled');
  assert.equal(workers[0].terminated, true);
});

test('pending diagnostics are published at low frequency, not per ack', async (t) => {
  const workers = installWorker(t);
  const { controller } = streaming(t, { reads: 30 });
  let reports = 0;
  controller.subscribe((state) => {
    if ('decoderPendingBlocks' in state) reports += 1;
  });
  await until(() => workers[0]?.blocks.length >= 30);
  const state = controller.getState();
  assert.ok(Number.isFinite(state.decoderPendingBlocks));
  assert.ok(Number.isFinite(state.decoderPendingBytes));
  assert.ok(Number.isFinite(state.decoderOldestPendingMs));
  assert.ok(reports < workers[0].blocks.length, 'fewer reports than acks');
});

test('duplicate, unknown and stale acknowledgements change nothing', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const { controller } = streaming(t, { reads: 2 });
  await until(() => workers[0]?.blocks.length === 2);
  const worker = workers[0];
  worker.ack(0);
  worker.ack(0); // duplicate
  worker.ack(99); // never sent
  assert.equal(controller._pendingBlocks.size, 1);
  assert.equal(controller._pendingBytes, 64);
  assert.equal(controller._ackAnomalies, 2);
  // A replaced worker's late acknowledgement cannot touch the new worker.
  const oldHandler = worker.onmessage;
  controller._discardWorker();
  controller._ensureWorker();
  const fresh = workers[1];
  controller._postSamples(new ArrayBuffer(64));
  assert.equal(fresh.blocks[0], 0, 'block numbers restart per worker');
  oldHandler?.({ data: { type: 'ack', id: 0 } });
  assert.equal(controller._pendingBlocks.size, 1, 'stale ack ignored');
  fresh.ack(0);
  assert.equal(controller._pendingBlocks.size, 0);
});

test('stop terminates the decoder before cleanup and fences its late output', async (t) => {
  const workers = installWorker(t);
  const { controller, audio, device } = streaming(t, { reads: 5 });
  await until(() => workers[0]?.blocks.length >= 3);
  const worker = workers[0];
  const handler = worker.onmessage;
  let closed = false;
  device.close = () =>
    new Promise((resolve) =>
      setTimeout(() => {
        closed = true;
        resolve();
      }, 30),
    );
  const stopping = controller.stop();
  assert.equal(worker.terminated, true, 'terminated synchronously');
  assert.equal(closed, false, 'before the device close settled');
  const disabled = audio.filter(
    (message) => message.type === 'session' && message.enabled === false,
  );
  assert.equal(disabled.length, 1, 'player session disabled');
  const before = audio.filter((message) => message.type === 'samples').length;
  handler?.({
    data: {
      type: 'fm',
      samples: new Float32Array(8),
      tune: controller._fmTune,
    },
  });
  await stopping;
  assert.equal(
    audio.filter((message) => message.type === 'samples').length,
    before,
    'no late audio after stop',
  );
});

test('audio reaches the player only for the live FM session and current tune', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const { controller, audio } = streaming(t, { reads: 1 });
  await until(() => workers[0]?.blocks.length === 1);
  const worker = workers[0];
  const samples = () => audio.filter((message) => message.type === 'samples');
  worker.emit({ type: 'fm', samples: new Float32Array(4), tune: 0 });
  assert.equal(samples().length, 1);
  assert.equal(samples()[0].sessionId, controller._audioSessionId);
  controller._fmTune = 3; // a retune is in flight
  worker.emit({ type: 'fm', samples: new Float32Array(4), tune: 0 });
  assert.equal(samples().length, 1, 'pre-retune audio dropped');
  worker.emit({ type: 'fm', samples: new Float32Array(4), tune: 3 });
  assert.equal(samples().length, 2);
  controller._setState({ mode: 'adsb' });
  worker.emit({ type: 'fm', samples: new Float32Array(4), tune: 3 });
  assert.equal(samples().length, 2, 'no FM audio outside FM mode');
  controller._setState({ mode: 'fm' });
  worker.emit({ type: 'fm', samples: new Float32Array(0), tune: 3 });
  assert.equal(samples().length, 2, 'empty audio is not forwarded');
});

test('an FM to ADS-B to FM round trip cannot relabel old output as current', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const { controller, audio } = streaming(t, { reads: 1 });
  await until(() => workers[0]?.blocks.length === 1);
  const worker = workers[0];
  const samples = () => audio.filter((message) => message.type === 'samples');
  controller._configureWorker();
  const fmEpoch = controller._fmTune;
  // Leave for ADS-B and come back, on the same worker, as _configureDevice does.
  controller._setState({ mode: 'adsb' });
  controller._configureWorker();
  controller._setState({ mode: 'fm' });
  controller._configureWorker();
  controller._beginAudioSession();
  const current = controller._fmTune;
  assert.ok(current > fmEpoch);
  worker.emit({ type: 'fm', samples: new Float32Array(4), tune: fmEpoch });
  assert.equal(
    samples().length,
    0,
    'old FM output dropped after the round trip',
  );
  worker.emit({ type: 'fm', samples: new Float32Array(4), tune: current });
  assert.equal(samples().length, 1);
});

test('old-epoch diagnostics, SNR and ADS-B output are ignored', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const { controller } = streaming(t, { reads: 1 });
  await until(() => workers[0]?.blocks.length === 1);
  const worker = workers[0];
  controller._configureWorker();
  const old = controller._fmTune - 1;
  const before = controller.getState();
  worker.emit({
    type: 'fm',
    tune: old,
    snr: 42,
    samples: new Float32Array(4),
    diagnostics: { workerBlocks: 999, iqLevelDbfs: -1, audioLevelDbfs: -1 },
  });
  worker.emit({ type: 'adsb', tune: old, aircraft: [{ icao: 'abc123' }] });
  const after = controller.getState();
  assert.equal(after.snr, before.snr);
  assert.equal(after.workerBlocks, before.workerBlocks);
  assert.deepEqual(after.aircraft, before.aircraft, 'old ADS-B output ignored');
  // Control: the same output in the current epoch is applied, so the checks
  // above are not vacuous.
  worker.emit({
    type: 'adsb',
    tune: controller._fmTune,
    aircraft: [{ icao: 'abc123' }],
  });
  assert.deepEqual(
    controller.getState().aircraft.map((entry) => entry.icao),
    ['abc123'],
  );
});

test('an overload publishes its error first and never overwrites a reconnect', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const { controller, device } = streaming(t);
  device.close = () => new Promise((resolve) => setTimeout(resolve, 40));
  await until(() => controller.getState().status === 'error');
  assert.equal(controller.getState().connected, false);
  assert.equal(workers[0].terminated, true);
  // A reconnect starts while the overloaded session is still tearing down.
  controller._sessionToken += 1;
  controller._setState({ status: 'streaming', connected: true });
  await pause(80);
  assert.equal(controller.getState().status, 'streaming');
  assert.equal(controller.getState().connected, true);
});

test('a reconnect gets a new decoder with fresh numbering and no carried backlog', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const first = streaming(t, { reads: 3 });
  await until(() => workers[0]?.blocks.length === 3);
  await first.controller.stop();
  assert.equal(first.controller._pendingBlocks.size, 0);
  first.controller._device = {
    readSamples: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ data: new ArrayBuffer(64) }), 1),
      ),
    close: async () => {},
  };
  first.controller._readGeneration += 1;
  first.controller._startWatchdog();
  void first.controller._readLoop(first.controller._readGeneration);
  await until(() => workers[1]?.blocks.length >= 1);
  assert.equal(workers[1].blocks[0], 0);
  assert.equal(
    workers[0].blocks.length,
    3,
    'old decoder receives nothing more',
  );
});

/** The real sdr.worker.js in a Node worker thread, with a browser-like `self`. */
function realWorker(t) {
  const module = new URL('./sdr.worker.js', import.meta.url).href;
  const thread = new ThreadWorker(
    `const { parentPort } = require('node:worker_threads');
     globalThis.self = globalThis;
     self.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
     parentPort.on('message', (data) => self.onmessage && self.onmessage({ data }));
     import(${JSON.stringify(module)}).then(() => parentPort.postMessage({ type: 'ready' }));`,
    { eval: true },
  );
  const inbox = [];
  thread.on('message', (message) => inbox.push(message));
  t.after(() => thread.terminate());
  return { thread, inbox };
}

function iqBlock(samples = 32_768) {
  const bytes = new Uint8Array(samples * 2);
  for (let n = 0; n < samples; n += 1) {
    const phase = (2 * Math.PI * 100_000 * n) / 2_048_000;
    bytes[2 * n] = Math.round(127.5 + 60 * Math.cos(phase));
    bytes[2 * n + 1] = Math.round(127.5 + 60 * Math.sin(phase));
  }
  return bytes.buffer;
}

test('the real decoder acknowledges every numbered block after its output, in every path', async (t) => {
  const { thread, inbox } = realWorker(t);
  await until(() => inbox.some((m) => m.type === 'ready'), 5_000);
  thread.postMessage({
    type: 'configure',
    mode: 'fm',
    sampleRate: 2_048_000,
    tune: 5,
  });
  for (const id of [0, 1, 2]) {
    const buffer = iqBlock();
    thread.postMessage({ type: 'samples', buffer, id }, [buffer]);
  }
  await until(() => inbox.filter((m) => m.type === 'ack').length === 3, 5_000);
  const fm = inbox.filter((m) => m.type === 'fm');
  assert.equal(fm.length, 3);
  assert.ok(
    fm.every((m) => m.tune === 5),
    'configure re-synced the tune tag',
  );
  const order = inbox.filter((m) => m.type === 'fm' || m.type === 'ack');
  assert.deepEqual(
    order.map((m) => m.type),
    ['fm', 'ack', 'fm', 'ack', 'fm', 'ack'],
    'each ack follows that block output',
  );
  // An invalid block produces no output and is still acknowledged.
  thread.postMessage({ type: 'samples', buffer: null, id: 3 });
  // ADS-B: output is rare, acknowledgement is not.
  thread.postMessage({
    type: 'configure',
    mode: 'adsb',
    sampleRate: 2_000_000,
  });
  const adsb = iqBlock(16_384);
  thread.postMessage({ type: 'samples', buffer: adsb, id: 4 }, [adsb]);
  await until(() => inbox.filter((m) => m.type === 'ack').length === 5, 5_000);
  assert.deepEqual(
    inbox.filter((m) => m.type === 'ack').map((m) => m.id),
    [0, 1, 2, 3, 4],
  );
});
