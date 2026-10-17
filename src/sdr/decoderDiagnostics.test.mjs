import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker as ThreadWorker } from 'node:worker_threads';

import { SdrController } from './controller.js';

const ADMISSION = {
  maxBlocks: 4,
  maxBytes: 4 * 64,
  maxAgeMs: 200,
  watchdogMs: 10,
  reportMs: 20,
  readyTimeoutMs: 500,
};

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 1_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await pause(2);
  }
}

/** Decoder stand-in; with `timings` it answers like the real worker in diagnostic mode. */
function installWorker(t, { ack = 'auto', timings = true } = {}) {
  const workers = [];
  class TimedWorker {
    constructor() {
      this.messages = [];
      this.terminated = false;
      workers.push(this);
      setTimeout(() => this.emit({ type: 'ready' }), 0);
    }
    postMessage(message) {
      this.messages.push(message);
      if (message?.type !== 'samples') return;
      if (ack === 'auto') queueMicrotask(() => this.ack(message));
    }
    ack(message) {
      const now = performance.timeOrigin + performance.now();
      this.emit(
        timings && Number.isFinite(message.postedAt)
          ? {
              type: 'ack',
              id: message.id,
              receivedAt: now,
              computeMs: 0.5,
              ackPostedAt: now,
            }
          : { type: 'ack', id: message.id },
      );
    }
    emit(data) {
      this.onmessage?.({ data });
    }
    terminate() {
      this.terminated = true;
    }
  }
  const prior = globalThis.Worker;
  globalThis.Worker = TimedWorker;
  t.after(() => {
    globalThis.Worker = prior;
  });
  return workers;
}

function streaming(t, { reads = Infinity, diagnostics = false } = {}) {
  const controller = new SdrController({
    storage: { getItem: () => null, setItem() {} },
    webUsb: {},
    workerAdmission: ADMISSION,
    decoderDiagnostics: diagnostics,
  });
  const audio = [];
  controller._audioNode = {
    port: { postMessage: (message) => audio.push(message) },
  };
  let served = 0;
  const device = {
    readSamples: () =>
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
  return { controller, audio };
}

test('FM SNR and levels publish at most every 250 ms, while audio and spectrum stay immediate', async (t) => {
  // Acknowledging decoder, so the 200 ms age bound does not stop the session.
  const workers = installWorker(t);
  const { controller, audio } = streaming(t, { reads: 1 });
  await until(() => workers[0]?.messages.some((m) => m.type === 'samples'));
  const worker = workers[0];
  const tune = controller._fmTune;
  // subscribe() reports the full state now and on every change, so count
  // actual changes of the published SNR value.
  let snrUpdates = 0;
  let lastSnr;
  let first = true;
  controller.subscribe((state) => {
    if (first) {
      first = false;
      lastSnr = state.snr;
      return;
    }
    if (state.snr !== lastSnr) {
      snrUpdates += 1;
      lastSnr = state.snr;
    }
  });
  const spectrumBefore = controller._spectrumSequence;
  for (let index = 0; index < 20; index += 1) {
    worker.emit({
      type: 'fm',
      tune,
      snr: index,
      samples: new Float32Array(4),
      bins: new Float32Array(16),
      diagnostics:
        index === 7
          ? { workerBlocks: 700, iqLevelDbfs: -9, audioLevelDbfs: -12 }
          : null,
    });
  }
  const forwarded = audio.filter((m) => m.type === 'samples').length;
  assert.equal(forwarded, 20, 'every block of audio forwarded immediately');
  assert.equal(
    controller._spectrumSequence - spectrumBefore,
    20,
    'spectrum immediate',
  );
  assert.equal(snrUpdates, 1, 'one display update for 20 blocks');
  assert.equal(controller.getState().snr, 0);
  await pause(260);
  worker.emit({ type: 'fm', tune, snr: 99, samples: new Float32Array(4) });
  assert.equal(snrUpdates, 2);
  const state = controller.getState();
  assert.equal(state.snr, 99, 'latest value published');
  assert.equal(state.workerBlocks, 700, 'a level update held back is not lost');
  assert.equal(state.iqLevelDbfs, -9);
});

test('diagnostics are off by default: no timestamps, no timing state', async (t) => {
  const workers = installWorker(t);
  const { controller } = streaming(t, { reads: 30 });
  await until(
    () => workers[0]?.messages.filter((m) => m.type === 'samples').length >= 30,
  );
  await pause(40);
  const samples = workers[0].messages.filter((m) => m.type === 'samples');
  assert.ok(samples.every((m) => !('postedAt' in m)));
  assert.equal(controller.getState().decoderTimings, undefined);
  assert.equal(controller._timingRing.length, 0);
});

test('diagnostic timings: fixed-size per-second summaries; the 256-record ring stays internal', async (t) => {
  const workers = installWorker(t);
  const { controller } = streaming(t, { reads: 300, diagnostics: true });
  const published = [];
  controller.subscribe((state) => {
    if (state.decoderTimings) published.push(state.decoderTimings);
  });
  await until(
    () =>
      workers[0]?.messages.filter((m) => m.type === 'samples').length >= 300,
    5_000,
  );
  await pause(40);
  assert.equal(controller._timingRing.length, 256, 'ring capped at 256');
  assert.ok(published.length > 0);
  for (const summary of published) {
    assert.deepEqual(Object.keys(summary).sort(), [
      'ackDelayMs',
      'audioDelayMs',
      'computeMs',
      'oldestPendingPeakMs',
      'pendingPeak',
      'queueMs',
      'rttMs',
    ]);
    assert.ok(!('timings' in summary) && !Array.isArray(summary.queueMs));
    if (summary.computeMs) {
      assert.ok(summary.computeMs.count <= 256);
      assert.equal(summary.computeMs.max, 0.5);
    }
    assert.ok(summary.pendingPeak <= ADMISSION.maxBlocks);
  }
});

test('an overload freezes one snapshot before pending work is cleared', async (t) => {
  const workers = installWorker(t, { ack: 'manual' });
  const { controller } = streaming(t, { diagnostics: true });
  await until(() => controller.getState().status === 'error');
  const snapshot = controller.getState().decoderOverloadSnapshot;
  assert.equal(snapshot.reason, 'backlog');
  assert.equal(snapshot.pendingBlocks, ADMISSION.maxBlocks);
  assert.equal(snapshot.pendingBytes, ADMISSION.maxBytes);
  assert.equal(snapshot.pending.length, ADMISSION.maxBlocks);
  assert.ok(snapshot.pending.every((entry) => entry.bytes === 64));
  assert.ok(Number.isFinite(snapshot.inflightReads));
  assert.ok(Array.isArray(snapshot.timings) && snapshot.timings.length <= 256);
  assert.equal(controller._pendingBlocks.size, 0, 'cleared after the snapshot');
  assert.equal(workers[0].terminated, true);
});

test('without diagnostics the overload snapshot keeps counts only', async (t) => {
  installWorker(t, { ack: 'manual' });
  const { controller } = streaming(t);
  await until(() => controller.getState().status === 'error');
  const snapshot = controller.getState().decoderOverloadSnapshot;
  assert.equal(snapshot.pendingBlocks, ADMISSION.maxBlocks);
  assert.equal(snapshot.pending, undefined);
  assert.equal(snapshot.timings, undefined);
});

test('the real decoder returns timings only for stamped blocks', async (t) => {
  const module = new URL('./sdr.worker.js', import.meta.url).href;
  const thread = new ThreadWorker(
    `const { parentPort } = require('node:worker_threads');
     globalThis.self = globalThis;
     self.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
     parentPort.on('message', (data) => self.onmessage && self.onmessage({ data }));
     import(${JSON.stringify(module)});`,
    { eval: true },
  );
  t.after(() => thread.terminate());
  const inbox = [];
  thread.on('message', (message) => inbox.push(message));
  await until(() => inbox.some((m) => m.type === 'ready'), 5_000);
  thread.postMessage({
    type: 'configure',
    mode: 'fm',
    sampleRate: 2_048_000,
    tune: 1,
  });
  const block = () => {
    const bytes = new Uint8Array(32_768 * 2).fill(128);
    return bytes.buffer;
  };
  const stamped = block();
  const postedAt = performance.timeOrigin + performance.now();
  thread.postMessage({ type: 'samples', buffer: stamped, id: 0, postedAt }, [
    stamped,
  ]);
  const plain = block();
  thread.postMessage({ type: 'samples', buffer: plain, id: 1 }, [plain]);
  await until(() => inbox.filter((m) => m.type === 'ack').length === 2, 5_000);
  const [timed, untimed] = inbox.filter((m) => m.type === 'ack');
  assert.ok(
    timed.receivedAt >= postedAt - 5,
    'receipt after posting (clock skew tolerance)',
  );
  assert.ok(timed.computeMs >= 0 && timed.computeMs < 5_000);
  assert.ok(timed.ackPostedAt >= timed.receivedAt);
  assert.deepEqual(Object.keys(untimed).sort(), ['id', 'type']);
  const fm = inbox.filter((m) => m.type === 'fm');
  assert.ok(Number.isFinite(fm[0].workerPostedAt));
  assert.equal(fm[1].workerPostedAt, undefined);
});

test('blocks request a spectrum only while seeking', (t) => {
  // Deterministic: the _postSamples contract directly, no read loop or polling.
  const workers = installWorker(t, { ack: 'manual' });
  const controller = new SdrController({
    storage: { getItem: () => null, setItem() {} },
    webUsb: {},
    workerAdmission: ADMISSION,
  });
  const post = () => {
    assert.equal(controller._postSamples(new ArrayBuffer(64)), true);
    const sent = workers[0].messages.filter((m) => m.type === 'samples');
    return sent[sent.length - 1];
  };
  controller._setState({ seeking: false });
  assert.equal(post().spectrum, false, 'listening: no spectrum');
  controller._setState({ seeking: true });
  assert.equal(post().spectrum, true, 'seeking: spectrum requested');
  controller._setState({ seeking: false });
  assert.equal(post().spectrum, false, 'after seek: no spectrum');
  // The diagnostic branch carries the same flag.
  controller._decoderDiagnostics = true;
  controller._setState({ seeking: true });
  const stamped = post();
  assert.equal(stamped.spectrum, true);
  assert.ok(Number.isFinite(stamped.postedAt));
});

test('the real decoder computes spectra only when requested, with audio unchanged', async (t) => {
  const module = new URL('./sdr.worker.js', import.meta.url).href;
  const thread = new ThreadWorker(
    `const { parentPort } = require('node:worker_threads');
     globalThis.self = globalThis;
     self.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
     parentPort.on('message', (data) => self.onmessage && self.onmessage({ data }));
     import(${JSON.stringify(module)});`,
    { eval: true },
  );
  t.after(() => thread.terminate());
  const inbox = [];
  thread.on('message', (message) => inbox.push(message));
  await until(() => inbox.some((m) => m.type === 'ready'), 5_000);
  const tone = () => {
    const bytes = new Uint8Array(32_768 * 2);
    for (let n = 0; n < 32_768; n += 1) {
      const phase = (2 * Math.PI * 100_000 * n) / 2_048_000;
      bytes[2 * n] = Math.round(127.5 + 60 * Math.cos(phase));
      bytes[2 * n + 1] = Math.round(127.5 + 60 * Math.sin(phase));
    }
    return bytes.buffer;
  };
  const run = async (spectrum, firstId) => {
    // A reset starts each run at block 0 with identical decoder state.
    thread.postMessage({ type: 'reset', tune: 1 });
    thread.postMessage({
      type: 'configure',
      mode: 'fm',
      sampleRate: 2_048_000,
      tune: 1,
    });
    for (let index = 0; index < 6; index += 1) {
      const buffer = tone();
      thread.postMessage(
        { type: 'samples', buffer, id: firstId + index, spectrum },
        [buffer],
      );
    }
    await until(
      () =>
        inbox.filter((m) => m.type === 'ack' && m.id >= firstId).length === 6,
      5_000,
    );
    return inbox.filter((m) => m.type === 'fm').splice(-6);
  };
  const listening = await run(false, 0);
  const seeking = await run(true, 100);
  assert.ok(
    listening.every((m) => m.bins === null),
    'no FFT while listening',
  );
  assert.equal(
    seeking.filter((m) => m.bins instanceof Float32Array).length,
    2,
    'every third block',
  );
  assert.deepEqual(
    listening.map((m) => m.samples.length),
    seeking.map((m) => m.samples.length),
    'audio output unchanged',
  );
  assert.deepEqual(
    Array.from(listening[5].samples),
    Array.from(seeking[5].samples),
  );
});
