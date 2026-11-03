import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  createGeminiAudio,
  decodeGeminiPcm,
  pcmBytesToBase64,
} from './geminiAudio.js';

test('PCM decoding preserves little-endian signed samples and rejects malformed audio', () => {
  const data = new Uint8Array([0, 128, 0, 0, 255, 127]);
  const decoded = decodeGeminiPcm(pcmBytesToBase64(data.buffer));
  assert.equal(decoded.sampleRate, 24000);
  assert.deepEqual([...decoded.samples], [-1, 0, 32767 / 32768]);
  assert.throws(() => decodeGeminiPcm('AA=='), /incomplete/);
  assert.throws(() => decodeGeminiPcm('AAAA', 'audio/mp3'), /unsupported/);
  assert.throws(
    () => decodeGeminiPcm('AAAA', 'audio/pcm;rate=1'),
    /sample rate/,
  );
});

test('PCM decoding accepts both rate endpoints and the exact decoded chunk limit', () => {
  for (const rate of [8000, 96000]) {
    const decoded = decodeGeminiPcm('AAA=', `audio/pcm;rate=${rate}`);
    assert.equal(decoded.sampleRate, rate);
    assert.deepEqual([...decoded.samples], [0]);
  }
  const limit = 2 * 1024 * 1024;
  const maximum = decodeGeminiPcm(
    pcmBytesToBase64(new ArrayBuffer(limit)),
    'audio/pcm;rate=96000',
  );
  assert.equal(maximum.samples.length, limit / 2);
  for (const size of [limit + 1, limit + 2])
    assert.throws(
      () => decodeGeminiPcm(pcmBytesToBase64(new ArrayBuffer(size))),
      /oversized audio chunk/,
    );
});

function createCaptureHarness(sampleRate = 16000) {
  let Processor;
  const messages = [];
  vm.runInNewContext(
    fs.readFileSync(
      new URL('./geminiCaptureWorklet.js', import.meta.url),
      'utf8',
    ),
    {
      sampleRate,
      AudioWorkletProcessor: class {
        constructor() {
          this.port = { postMessage: (message) => messages.push(message) };
        }
      },
      registerProcessor: (_name, Class) => {
        Processor = Class;
      },
    },
  );
  return { capture: new Processor(), messages };
}

test('worklet orders start, bounded PCM and the final partial chunk before end', () => {
  const { capture, messages } = createCaptureHarness();
  capture.process([[new Float32Array([-1, 0, 1])]]);
  assert.equal(messages.length, 0);
  capture.port.onmessage({ data: { enabled: true, captureId: 1 } });
  capture.process([[new Float32Array([-1, 0, 1])]]);
  capture.port.onmessage({ data: { enabled: false, captureId: 1 } });
  assert.deepEqual(
    messages.map((message) => message.type),
    ['start', 'audio', 'end'],
  );
  const view = new DataView(messages[1].buffer);
  assert.deepEqual(
    [view.getInt16(0, true), view.getInt16(2, true), view.getInt16(4, true)],
    [-32768, 0, 32767],
  );
  capture.process([[new Float32Array(2048)]]);
  assert.equal(messages.length, 3);
});

test('worklet serializes rapid re-holds and ignores repeated enable or release', () => {
  const { capture, messages } = createCaptureHarness();
  let captureId = 0;
  let gate = false;
  const enable = (enabled) => {
    if (enabled && !gate) captureId++;
    gate = enabled;
    capture.port.onmessage({ data: { enabled, captureId } });
  };
  enable(false);
  enable(true);
  enable(true);
  capture.process([[new Float32Array(1025).fill(0.5)]]);
  enable(false);
  enable(false);
  capture.process([[new Float32Array(2048).fill(1)]]);
  enable(true);
  capture.process([[new Float32Array([0.25])]]);
  enable(false);
  assert.deepEqual(
    messages.map((message) => message.type),
    ['start', 'audio', 'audio', 'end', 'start', 'audio', 'end'],
  );
  assert.deepEqual(
    messages
      .filter((message) => message.type === 'audio')
      .map((message) => message.buffer.byteLength),
    [2048, 2, 2],
  );
  assert.equal(new DataView(messages[5].buffer).getInt16(0, true), 8192);
  assert.deepEqual(
    messages.map((message) => message.captureId),
    [1, 1, 1, 1, 2, 2, 2],
  );
  enable(true);
  enable(false);
  assert.deepEqual(
    messages.slice(-2).map((message) => message.type),
    ['start', 'end'],
  );
  assert.equal(capture.length, 0);
  assert.equal(capture.enabled, false);
});

function createPlaybackHarness() {
  const sources = [];
  const buffers = [];
  let drains = 0;
  let context;
  const contexts = [];
  const node = () => ({
    connect() {},
    disconnect() {
      this.disconnected = true;
    },
    gain: { value: 1 },
  });
  class Context {
    constructor(options) {
      context = this;
      contexts.push(this);
      this.options = options;
      this.currentTime = 0;
      this.sampleRate = options?.sampleRate ?? 48000;
      this.state = 'running';
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() {}
    async close() {
      this.state = 'closed';
    }
    createGain() {
      return node();
    }
    createMediaStreamDestination() {
      return { ...node(), stream: {} };
    }
    createBuffer(_channels, length, rate) {
      const buffer = { duration: length / rate, copyToChannel() {} };
      buffers.push(buffer);
      return buffer;
    }
    createBufferSource() {
      const source = {
        ...node(),
        start(at) {
          this.at = at;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    }
  }
  const audio = createGeminiAudio({
    AudioContextClass: Context,
    AudioWorkletNodeClass: class {},
    onDrain: () => {
      drains++;
    },
  });
  return {
    audio,
    sources,
    buffers,
    contexts,
    get drains() {
      return drains;
    },
    get context() {
      return context;
    },
  };
}

function outputDiagnostics(audio) {
  const { outputSamples, completedOutputSamples, discardedOutputSamples } =
    audio.diagnostics();
  return { outputSamples, completedOutputSamples, discardedOutputSamples };
}

test('pending sources are capped before decoding or allocating and natural completion frees a slot', async (t) => {
  const playback = createPlaybackHarness();
  const { audio, sources, buffers } = playback;
  t.after(() => audio.close());
  const decode = t.mock.method(globalThis, 'atob', globalThis.atob);
  await audio.initialize();
  for (let index = 0; index < 256; index++)
    audio.play('AAA=', 'audio/pcm;rate=96000');
  assert.equal(audio.pending, true);
  assert.ok(audio.diagnostics().queuedSeconds < 0.023);
  assert.equal(decode.mock.calls.length, 256);
  assert.equal(buffers.length, 256);
  assert.equal(sources.length, 256);
  const before = audio.diagnostics();
  assert.throws(
    () => audio.play('AAA=', 'audio/pcm;rate=96000'),
    /Gemini audio playback fell behind\. Reconnect to continue\./,
  );
  assert.equal(decode.mock.calls.length, 256);
  assert.equal(buffers.length, 256);
  assert.equal(sources.length, 256);
  assert.deepEqual(audio.diagnostics(), before);

  const ended = sources[0].onended;
  ended();
  assert.equal(sources[0].disconnected, true);
  assert.equal(playback.drains, 0);
  audio.play('AAA=', 'audio/pcm;rate=96000');
  assert.equal(decode.mock.calls.length, 257);
  assert.equal(buffers.length, 257);
  assert.equal(sources.length, 257);
  ended();
  assert.equal(audio.diagnostics().completedOutputSamples, 1);
  assert.throws(() => audio.play('AAA='), /playback fell behind/);
  assert.equal(decode.mock.calls.length, 257);
});

test('clearing and closing a full queue release every source and ignore late completion', async (t) => {
  const playback = createPlaybackHarness();
  const { audio, sources, buffers } = playback;
  t.after(() => audio.close());
  const decode = t.mock.method(globalThis, 'atob', globalThis.atob);
  await audio.initialize();
  for (let index = 0; index < 256; index++) audio.play('AAA=');
  const staleEnded = sources.map((source) => source.onended);
  audio.clearPlayback();
  assert.equal(audio.pending, false);
  assert.equal(audio.diagnostics().queuedSeconds, 0);
  for (const source of sources) {
    assert.equal(source.stopped, true);
    assert.equal(source.disconnected, true);
    assert.equal(source.onended, null);
  }
  for (let index = 0; index < 256; index++) audio.play('AAA=');
  for (const ended of staleEnded) ended();
  assert.equal(audio.pending, true);
  assert.throws(() => audio.play('AAA='), /playback fell behind/);
  assert.equal(decode.mock.calls.length, 512);
  assert.equal(buffers.length, 512);
  assert.equal(sources.length, 512);
  const lateEnded = sources.slice(256).map((source) => source.onended);
  await audio.close();
  for (const source of sources) {
    assert.equal(source.stopped, true);
    assert.equal(source.disconnected, true);
    assert.equal(source.onended, null);
  }
  for (const ended of [...staleEnded, ...lateEnded]) ended();
  audio.play('not base64');
  assert.equal(decode.mock.calls.length, 512);
  assert.equal(buffers.length, 512);
  assert.equal(sources.length, 512);
  assert.equal(audio.pending, false);
  assert.equal(playback.drains, 0);
  assert.equal(playback.context.state, 'closed');
  assert.deepEqual(outputDiagnostics(audio), {
    outputSamples: 512,
    completedOutputSamples: 0,
    discardedOutputSamples: 512,
  });
});

test('the duration limit still rejects long chunks below the source cap', async (t) => {
  const playback = createPlaybackHarness();
  const { audio, sources, buffers } = playback;
  t.after(() => audio.close());
  await audio.initialize();
  const second = pcmBytesToBase64(new ArrayBuffer(16000));
  for (let index = 0; index < 59; index++)
    audio.play(second, 'audio/pcm;rate=8000');
  assert.ok(Math.abs(audio.diagnostics().queuedSeconds - 59.02) < 1e-9);
  assert.throws(
    () => audio.play(second, 'audio/pcm;rate=8000'),
    /playback fell behind/,
  );
  assert.equal(buffers.length, 59);
  assert.equal(sources.length, 59);
});

test('audio playback records completed samples only as sources naturally end', async () => {
  const playback = createPlaybackHarness();
  const { audio, sources } = playback;
  await audio.initialize();
  audio.play('AAA=');
  audio.play('AAA=');
  assert.ok(sources[1].at > sources[0].at);
  assert.deepEqual(outputDiagnostics(audio), {
    outputSamples: 2,
    completedOutputSamples: 0,
    discardedOutputSamples: 0,
  });
  sources[0].onended();
  assert.equal(playback.drains, 0);
  assert.equal(audio.diagnostics().completedOutputSamples, 1);
  sources[1].onended();
  assert.equal(playback.drains, 1);
  assert.equal(audio.pending, false);
  assert.deepEqual(outputDiagnostics(audio), {
    outputSamples: 2,
    completedOutputSamples: 2,
    discardedOutputSamples: 0,
  });
  await audio.close();
  assert.equal(playback.context.state, 'closed');
  assert.deepEqual(outputDiagnostics(audio), {
    outputSamples: 2,
    completedOutputSamples: 2,
    discardedOutputSamples: 0,
  });
});

test('interruption records queued samples as discarded and rejects stale ended callbacks', async () => {
  const playback = createPlaybackHarness();
  const { audio, sources } = playback;
  await audio.initialize();
  audio.play('AAA=');
  audio.play(pcmBytesToBase64(new ArrayBuffer(4)));
  sources[0].onended();
  const staleEnded = sources[1].onended;
  audio.clearPlayback();
  assert.equal(sources[1].stopped, true);
  assert.equal(sources[1].onended, null);
  assert.equal(audio.pending, false);
  assert.equal(audio.diagnostics().queuedSeconds, 0);
  staleEnded();
  audio.clearPlayback();
  assert.equal(playback.drains, 0);
  assert.deepEqual(outputDiagnostics(audio), {
    outputSamples: 3,
    completedOutputSamples: 1,
    discardedOutputSamples: 2,
  });
  await audio.close();
  assert.deepEqual(outputDiagnostics(audio), {
    outputSamples: 3,
    completedOutputSamples: 1,
    discardedOutputSamples: 2,
  });
});

test('closing queued playback cannot count stopped sources as completed audio', async () => {
  const playback = createPlaybackHarness();
  const { audio, sources } = playback;
  await audio.initialize();
  audio.play('AAA=');
  audio.play(pcmBytesToBase64(new ArrayBuffer(4)));
  const staleEnded = sources.map((source) => source.onended);
  await audio.close();
  for (const source of sources) {
    assert.equal(source.stopped, true);
    assert.equal(source.onended, null);
  }
  for (const ended of staleEnded) ended();
  audio.play('AAA=');
  await audio.close();
  assert.equal(audio.pending, false);
  assert.equal(playback.drains, 0);
  assert.equal(audio.diagnostics().contextState, 'closed');
  assert.equal(audio.diagnostics().queuedSeconds, 0);
  assert.deepEqual(outputDiagnostics(audio), {
    outputSamples: 3,
    completedOutputSamples: 0,
    discardedOutputSamples: 3,
  });
});

test('capture diagnostics distinguish speech energy from silence without retaining audio', async () => {
  let capture;
  const emitted = [];
  const order = [];
  const identities = [];
  const gates = [];
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  class Context {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 16000;
      this.state = 'running';
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() {}
    async close() {
      this.state = 'closed';
    }
    createGain() {
      return node();
    }
    createMediaStreamDestination() {
      return { ...node(), stream: { getTracks: () => [] } };
    }
    createMediaStreamSource() {
      return node();
    }
  }
  class Worklet {
    constructor() {
      capture = this;
      Object.assign(this, node());
      this.port = {
        postMessage(message) {
          gates.push(message);
        },
        close() {},
      };
    }
  }
  const audio = createGeminiAudio({
    AudioContextClass: Context,
    AudioWorkletNodeClass: Worklet,
    onAudioStart: (metadata) => {
      identities.push(metadata.captureId);
      order.push('start');
    },
    onAudio: (chunk, metadata) => {
      identities.push(metadata.captureId);
      emitted.push(chunk);
      order.push('audio');
    },
    onAudioEnd: (metadata) => {
      identities.push(metadata.captureId);
      order.push('end');
    },
  });
  await audio.initialize();
  audio.connectMicrophone({}, true, { captureId: 11 });
  const deliver = capture.port.onmessage;
  deliver({ data: { type: 'start', captureId: 11 } });
  capture.port.onmessage({
    data: { type: 'audio', captureId: 11, buffer: new ArrayBuffer(4) },
  });
  const spoken = new ArrayBuffer(4);
  new DataView(spoken).setInt16(0, 16384, true);
  capture.port.onmessage({
    data: { type: 'audio', captureId: 11, buffer: spoken },
  });
  deliver({ data: { type: 'end', captureId: 11 } });
  assert.deepEqual(order, ['start', 'audio', 'audio', 'end']);
  assert.deepEqual(identities, [11, 11, 11, 11]);
  assert.deepEqual(gates, [{ enabled: true, captureId: 11 }]);
  // Gate D does not relabel delayed B port messages.
  audio.setMicrophoneEnabled(false, { captureId: 11 });
  audio.setMicrophoneEnabled(true, { captureId: 12 });
  deliver({ data: { type: 'start', captureId: 11 } });
  deliver({ data: { type: 'audio', captureId: 11, buffer: spoken } });
  deliver({ data: { type: 'end', captureId: 11 } });
  assert.deepEqual(identities.slice(-3), [11, 11, 11]);
  const count = order.length;
  for (const captureId of [undefined, null, 0, -1, 1.5, '12', Infinity]) {
    deliver({ data: { type: 'start', captureId } });
    deliver({ data: { type: 'audio', captureId, buffer: spoken } });
    deliver({ data: { type: 'end', captureId } });
  }
  assert.equal(order.length, count);
  assert.equal(audio.diagnostics().inputChunks, 3);
  assert.equal(audio.diagnostics().nonSilentInputChunks, 2);
  assert.equal(audio.diagnostics().inputPeak, 0.5);
  assert.equal(emitted.length, 3);
  assert.equal(emitted[1].mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual(Object.keys(emitted[1]).sort(), ['data', 'mimeType']);
  assert.equal(await audio.close(), true);
  assert.equal(audio.diagnostics().contextState, 'closed');
  deliver({ data: { type: 'start', captureId: 11 } });
  deliver({ data: { type: 'audio', captureId: 11, buffer: spoken } });
  deliver({ data: { type: 'end', captureId: 11 } });
  assert.deepEqual(order, [
    'start',
    'audio',
    'audio',
    'end',
    'start',
    'audio',
    'end',
  ]);
});

test('worklet rejects missing identity and stale release without changing the active capture', () => {
  const { capture, messages } = createCaptureHarness();
  for (const captureId of [undefined, null, 0, -1, 1.5, '1', Infinity])
    capture.port.onmessage({ data: { enabled: true, captureId } });
  capture.process([[new Float32Array([0.5])]]);
  assert.equal(messages.length, 0);
  capture.port.onmessage({ data: { enabled: true, captureId: 20 } });
  capture.process([[new Float32Array([0.5])]]);
  capture.port.onmessage({ data: { enabled: true, captureId: 21 } });
  capture.port.onmessage({ data: { enabled: false, captureId: 19 } });
  assert.equal(messages.length, 1);
  capture.port.onmessage({ data: { enabled: false, captureId: 20 } });
  assert.deepEqual(
    messages.map((message) => [message.type, message.captureId]),
    [
      ['start', 20],
      ['audio', 20],
      ['end', 20],
    ],
  );
  capture.port.onmessage({ data: { enabled: true, captureId: 21 } });
  capture.port.onmessage({ data: { enabled: false, captureId: 20 } });
  capture.process([[new Float32Array([0.25])]]);
  capture.port.onmessage({ data: { enabled: false, captureId: 21 } });
  assert.deepEqual(
    messages.slice(3).map((message) => [message.type, message.captureId]),
    [
      ['start', 21],
      ['audio', 21],
      ['end', 21],
    ],
  );
});

function capturedPcm(messages, captureId) {
  const samples = [];
  for (const message of messages) {
    if (message.type !== 'audio' || message.captureId !== captureId) continue;
    const view = new DataView(message.buffer);
    for (let index = 0; index < view.byteLength; index += 2)
      samples.push(view.getInt16(index, true));
  }
  return samples;
}

function captureSignal(rate, signal, blockSizes = [128]) {
  const harness = createCaptureHarness(rate);
  harness.capture.port.onmessage({ data: { enabled: true, captureId: 1 } });
  let block = 0;
  for (let offset = 0; offset < signal.length;) {
    const size = blockSizes[block++ % blockSizes.length];
    harness.capture.process([[signal.subarray(offset, offset + size)]]);
    offset += size;
  }
  harness.capture.port.onmessage({ data: { enabled: false, captureId: 1 } });
  return { ...harness, pcm: capturedPcm(harness.messages, 1) };
}

for (const rate of [44100, 48000, 96000]) {
  test(`worklet resamples ${rate} Hz to bounded 16 kHz PCM independently of block boundaries`, () => {
    const signal = Float32Array.from(
      { length: rate },
      (_, index) => 0.5 * Math.sin((2 * Math.PI * 1000 * index) / rate),
    );
    const fragmented = captureSignal(rate, signal, [1, 127, 257, 3, 128]);
    const contiguous = captureSignal(rate, signal, [rate]);
    assert.equal(fragmented.pcm.length, 16000);
    assert.deepEqual(fragmented.pcm, contiguous.pcm);
    assert.deepEqual(
      fragmented.messages.map((message) => message.type).slice(0, 2),
      ['start', 'audio'],
    );
    assert.equal(fragmented.messages.at(-1).type, 'end');
    assert.ok(fragmented.messages.every((message) => message.captureId === 1));
    assert.ok(
      fragmented.messages
        .filter((message) => message.type === 'audio')
        .every((message) => message.buffer.byteLength <= 2048),
    );
    const rms = Math.sqrt(
      fragmented.pcm
        .slice(256)
        .reduce((total, sample) => total + (sample / 32768) ** 2, 0) /
        (fragmented.pcm.length - 256),
    );
    assert.ok(
      Math.abs(rms - Math.SQRT1_2 * 0.5) < 0.01,
      `speech-band RMS ${rms}`,
    );
    // Check the actual waveform against its expected frequency and causal
    // filter delay, rather than accepting any signal with the same energy.
    const error = Math.sqrt(
      fragmented.pcm.slice(256).reduce((total, sample, index) => {
        const time = (index + 257) / 16000 - 32.5 / rate;
        const expected = 0.5 * Math.sin(2 * Math.PI * 1000 * time);
        return total + (sample / 32768 - expected) ** 2;
      }, 0) /
        (fragmented.pcm.length - 256),
    );
    assert.ok(error < 0.005, `resampled waveform error ${error}`);
  });
}

for (const rate of [44100, 48000]) {
  test(`worklet suppresses 12 kHz aliasing from a ${rate} Hz microphone`, () => {
    const signal = Float32Array.from(
      { length: rate },
      (_, index) => 0.5 * Math.sin((2 * Math.PI * 12000 * index) / rate),
    );
    const { pcm } = captureSignal(rate, signal);
    const rms = Math.sqrt(
      pcm
        .slice(256)
        .reduce((total, sample) => total + (sample / 32768) ** 2, 0) /
        (pcm.length - 256),
    );
    assert.ok(rms < 0.005, `out-of-band RMS ${rms}`);
  });
}

test('resampler release flushes only owned PCM and clears phase/history before a successor', () => {
  const { capture, messages } = createCaptureHarness(44100);
  const gate = (enabled, captureId) =>
    capture.port.onmessage({ data: { enabled, captureId } });
  gate(true, 10);
  capture.process([[new Float32Array(442).fill(1)]]);
  gate(false, 9); // A stale release cannot clear the active filter or phase.
  capture.process([[new Float32Array(441).fill(1)]]);
  gate(false, 10);
  assert.equal(
    capturedPcm(messages, 10).length,
    Math.floor((883 * 16000) / 44100),
  );
  gate(true, 11);
  gate(false, 10);
  capture.process([[new Float32Array(441)]]);
  gate(false, 11);
  const successor = capturedPcm(messages, 11);
  assert.equal(successor.length, 160);
  assert.ok(successor.every((sample) => sample === 0));
  assert.deepEqual(
    messages.slice(-3).map((message) => [message.type, message.captureId]),
    [
      ['start', 11],
      ['audio', 11],
      ['end', 11],
    ],
  );
  // A sub-output-sample hold has no residual PCM or phase to transfer.
  gate(true, 12);
  capture.process([[new Float32Array([1])]]);
  gate(false, 12);
  gate(true, 13);
  capture.process([[new Float32Array(441)]]);
  gate(false, 13);
  assert.deepEqual(capturedPcm(messages, 13), successor);
  assert.deepEqual(
    messages
      .filter((message) => message.captureId === 12)
      .map((message) => message.type),
    ['start', 'end'],
  );
});

function createContextLifecycleHarness({
  resumeFailure,
  moduleFailure = false,
  closeFailure,
  constructorFailure,
  actualPlaybackRate = 24000,
} = {}) {
  const contexts = [];
  const worklets = [];
  const events = [];
  let stoppedTracks = 0;
  const node = (context) => ({
    context,
    gain: { value: 1 },
    connections: [],
    connect(target) {
      this.connections.push(target);
    },
    disconnect() {
      this.disconnected = true;
    },
  });
  class Context {
    constructor(options) {
      const index = contexts.length;
      if (constructorFailure === index)
        throw new Error('context creation failed');
      this.index = index;
      this.options = options;
      this.sampleRate = index === 0 ? 44100 : actualPlaybackRate;
      this.currentTime = index === 0 ? 99 : 7;
      this.state = 'suspended';
      this.destination = { context: this };
      this.nodes = [];
      this.closeCalls = 0;
      this.audioWorklet = {
        addModule: async () => {
          events.push(`module:${index}`);
          if (moduleFailure) throw new Error('module failed');
        },
      };
      contexts.push(this);
    }
    resume() {
      events.push(`resume:${this.index}`);
      if (resumeFailure === this.index) throw new Error('resume failed');
      this.state = 'running';
      return Promise.resolve();
    }
    close() {
      this.closeCalls++;
      events.push(`close:${this.index}`);
      if (closeFailure === this.index) throw new Error('close failed');
      this.state = 'closed';
      return Promise.resolve();
    }
    createGain() {
      const result = node(this);
      this.nodes.push(result);
      return result;
    }
    createMediaStreamDestination() {
      const result = {
        ...node(this),
        stream: {
          getTracks: () => [
            {
              stop: () => {
                stoppedTracks++;
              },
            },
          ],
        },
      };
      this.nodes.push(result);
      return result;
    }
    createMediaStreamSource() {
      const result = node(this);
      this.nodes.push(result);
      return result;
    }
    createBuffer(_channels, length, rate) {
      return {
        context: this,
        rate,
        duration: length / rate,
        copyToChannel() {},
      };
    }
    createBufferSource() {
      const result = {
        ...node(this),
        start(at) {
          this.at = at;
        },
        stop() {
          this.stopped = true;
        },
      };
      this.nodes.push(result);
      return result;
    }
  }
  class Worklet {
    constructor(context) {
      Object.assign(this, node(context));
      this.gates = [];
      this.port = {
        postMessage: (message) => this.gates.push(message),
        close: () => {
          this.portClosed = true;
        },
      };
      worklets.push(this);
    }
  }
  return {
    contexts,
    worklets,
    events,
    create: (callbacks = {}) =>
      createGeminiAudio({
        AudioContextClass: Context,
        AudioWorkletNodeClass: Worklet,
        ...callbacks,
      }),
    get stoppedTracks() {
      return stoppedTracks;
    },
  };
}

test('capture uses the device context while playback owns its clock, stream and actual rate diagnostics', async () => {
  const harness = createContextLifecycleHarness({ actualPlaybackRate: 48000 });
  const chunks = [];
  const errors = [];
  const audio = harness.create({
    onAudio: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(harness.events, ['resume:0', 'resume:1']);
  assert.equal(harness.contexts[0].options, undefined);
  assert.deepEqual(harness.contexts[1].options, { sampleRate: 24000 });
  await audio.initialize();
  assert.deepEqual(harness.events, ['resume:0', 'resume:1', 'module:0']);
  audio.connectMicrophone({}, true, { captureId: 5 });
  const capture = harness.worklets[0];
  assert.equal(capture.context, harness.contexts[0]);
  assert.deepEqual(capture.gates, [{ enabled: true, captureId: 5 }]);
  const staleError = capture.onprocessorerror;
  capture.port.onmessage({
    data: { type: 'audio', captureId: 5, buffer: new ArrayBuffer(4) },
  });
  assert.equal(chunks[0].mimeType, 'audio/pcm;rate=16000');
  audio.play('AAA=');
  const source = harness.contexts[1].nodes.find((item) => item.buffer);
  assert.equal(source.context, harness.contexts[1]);
  assert.equal(source.buffer.context, harness.contexts[1]);
  assert.equal(source.buffer.rate, 24000);
  assert.equal(source.at, 7.02);
  assert.ok(audio.diagnostics().queuedSeconds < 0.021);
  assert.equal(audio.diagnostics().captureSampleRate, 44100);
  assert.equal(audio.diagnostics().playbackSampleRate, 48000);
  assert.equal(audio.diagnostics().inputSampleRate, 16000);
  assert.equal(audio.diagnostics().contextState, 'running');
  harness.contexts[0].state = 'suspended';
  assert.equal(audio.diagnostics().contextState, 'suspended');
  const closing = audio.close();
  assert.equal(audio.close(), closing);
  assert.equal(await closing, true);
  assert.ok(
    harness.contexts.every(
      (context) => context.state === 'closed' && context.closeCalls === 1,
    ),
  );
  assert.equal(harness.stoppedTracks, 1);
  assert.equal(capture.portClosed, true);
  assert.equal(capture.disconnected, true);
  assert.equal(capture.onprocessorerror, null);
  assert.equal(source.stopped, true);
  staleError();
  audio.setMicrophoneEnabled(true, { captureId: 6 });
  assert.equal(capture.gates.length, 1);
  assert.deepEqual(errors, []);
});

for (const resumeFailure of [0, 1]) {
  test(`resume failure in context ${resumeFailure} releases both contexts`, async () => {
    const harness = createContextLifecycleHarness({ resumeFailure });
    const audio = harness.create();
    assert.deepEqual(harness.events, ['resume:0', 'resume:1']);
    await assert.rejects(audio.initialize(), /resume failed/);
    assert.ok(
      harness.contexts.every(
        (context) => context.state === 'closed' && context.closeCalls === 1,
      ),
    );
    assert.equal(harness.stoppedTracks, 1);
    assert.equal(await audio.close(), true);
  });
}

test('module failure and aborted initialization release both capture and playback', async () => {
  for (const moduleFailure of [true, false]) {
    const harness = createContextLifecycleHarness({ moduleFailure });
    const audio = harness.create();
    const signal = moduleFailure ? undefined : AbortSignal.abort();
    await assert.rejects(
      audio.initialize(signal),
      moduleFailure ? /module failed/ : { name: 'AbortError' },
    );
    assert.ok(
      harness.contexts.every(
        (context) => context.state === 'closed' && context.closeCalls === 1,
      ),
    );
    assert.equal(harness.stoppedTracks, 1);
  }
});

for (const closeFailure of [0, 1]) {
  test(`context ${closeFailure} close failure does not prevent closing the other context`, async () => {
    const harness = createContextLifecycleHarness({ closeFailure });
    const audio = harness.create();
    await audio.initialize();
    const closing = audio.close();
    assert.equal(audio.close(), closing);
    assert.equal(await closing, false);
    assert.ok(harness.contexts.every((context) => context.closeCalls === 1));
    assert.equal(harness.contexts[1 - closeFailure].state, 'closed');
    assert.equal(harness.stoppedTracks, 1);
  });
}

test('partial context construction failure closes the previously acquired capture context', async () => {
  const harness = createContextLifecycleHarness({ constructorFailure: 1 });
  assert.throws(() => harness.create(), /context creation failed/);
  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.contexts[0].state, 'closed');
});

function admissionHarness({ pushToTalk = true, callbacks = {} } = {}) {
  const events = [];
  const worklets = [];
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  class Context {
    constructor() {
      this.sampleRate = 16000;
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() {}
    async close() {
      this.state = 'closed';
    }
    createGain() {
      return node();
    }
    createMediaStreamDestination() {
      return { ...node(), stream: { getTracks: () => [] } };
    }
    createMediaStreamSource() {
      return node();
    }
    createBuffer(_channels, samples, rate) {
      return { duration: samples / rate, copyToChannel() {} };
    }
    createBufferSource() {
      return { ...node(), start() {}, stop() {} };
    }
  }
  class Worklet {
    constructor() {
      Object.assign(this, node());
      worklets.push(this);
      const { capture, messages } = createCaptureHarness();
      this.processor = capture;
      this.flush = () => {
        for (const data of messages.splice(0)) {
          // MessagePort structured cloning moves VM buffers into this realm.
          if (data.buffer)
            data.buffer = new Uint8Array(data.buffer).slice().buffer;
          this.port.onmessage?.({ data });
        }
      };
      this.port = {
        postMessage: (data) => {
          capture.port.onmessage({ data });
          this.flush();
        },
        close() {},
      };
    }
    feed(samples) {
      this.processor.process([[samples]]);
      this.flush();
    }
  }
  const createAudio = (options) =>
    createGeminiAudio({
      ...options,
      AudioContextClass: Context,
      AudioWorkletNodeClass: Worklet,
    });
  const audio = createAudio({
    pushToTalk,
    onAudioStart: (metadata) => {
      events.push({ type: 'start', ...metadata });
      callbacks.onAudioStart?.(metadata);
    },
    onAudio: (chunk, metadata) => {
      events.push({ type: 'audio', ...metadata, chunk });
      callbacks.onAudio?.(chunk, metadata);
    },
    onAudioEnd: (metadata) => {
      events.push({ type: 'end', ...metadata });
      callbacks.onAudioEnd?.(metadata);
    },
    onAudioDiscard: (metadata) => {
      events.push({ type: 'discard', ...metadata });
      callbacks.onAudioDiscard?.(metadata);
    },
    onError: (error) => {
      throw error;
    },
  });
  return { audio, events, worklets, createAudio };
}
function tone(length, amplitude = 0.04) {
  return Float32Array.from(
    { length },
    (_, i) => amplitude * Math.sin((i * 2 * Math.PI * 220) / 16000),
  );
}
function emittedPcm(events) {
  return events
    .filter((e) => e.type === 'audio')
    .flatMap((e) => {
      const bytes = Uint8Array.from(atob(e.chunk.data), (c) => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      return Array.from({ length: bytes.length / 2 }, (_, i) =>
        view.getInt16(i * 2, true),
      );
    });
}

test('PTT admission suppresses zero and near-silent captures without protocol callbacks', async (t) => {
  const h = admissionHarness();
  t.after(() => h.audio.close());
  await h.audio.initialize();
  h.audio.connectMicrophone({}, true, { captureId: 1 });
  h.worklets[0].feed(new Float32Array(1024));
  h.worklets[0].feed(tone(320, 0.00018));
  h.audio.setMicrophoneEnabled(false, { captureId: 1 });
  assert.deepEqual(h.events, [{ type: 'discard', captureId: 1 }]);
  assert.equal(h.audio.diagnostics().suppressedPttCaptures, 1);
  assert.equal(h.audio.diagnostics().pttBufferedBytes, 0);
});

test('PTT admission rejects isolated high-peak clicks across packet boundaries', async (t) => {
  const h = admissionHarness();
  t.after(() => h.audio.close());
  await h.audio.initialize();
  h.audio.connectMicrophone({}, true, { captureId: 1 });
  const click = new Float32Array(1024);
  click[159] = 1;
  click[160] = -1;
  h.worklets[0].feed(click);
  h.audio.setMicrophoneEnabled(false, { captureId: 1 });
  assert.deepEqual(
    h.events.map((e) => e.type),
    ['discard'],
  );
});

test('PTT admission preserves quiet short speech and final partial release in exact order', async (t) => {
  const h = admissionHarness();
  t.after(() => h.audio.close());
  await h.audio.initialize();
  h.audio.connectMicrophone({}, true, { captureId: 1 });
  const prefix = new Float32Array(73);
  const speech = tone(640, 0.005);
  const tail = new Float32Array(57);
  h.worklets[0].feed(prefix);
  h.worklets[0].feed(speech);
  h.worklets[0].feed(tail);
  assert.equal(h.events.length, 0, 'worklet still owns its incomplete packet');
  h.audio.setMicrophoneEnabled(false, { captureId: 1 });
  assert.deepEqual(
    h.events.map((e) => e.type),
    ['start', 'audio', 'end'],
  );
  const expected = [...prefix, ...speech, ...tail].map(
    (v) => Math.round(v * (v < 0 ? 32768 : 32767)) || 0,
  );
  assert.deepEqual(emittedPcm(h.events), expected);
});

test('PTT admission bounds a long silent preroll and never regates voiced tails', async (t) => {
  const h = admissionHarness();
  t.after(() => h.audio.close());
  await h.audio.initialize();
  h.audio.connectMicrophone({}, true, { captureId: 1 });
  for (let i = 0; i < 200; i++) {
    h.worklets[0].feed(new Float32Array(1024));
    assert.ok(h.audio.diagnostics().pttBufferedBytes <= 12800);
  }
  assert.equal(h.events.length, 0);
  h.worklets[0].feed(tone(1024));
  h.worklets[0].feed(new Float32Array(1024));
  h.audio.setMicrophoneEnabled(false, { captureId: 1 });
  assert.equal(h.events[0].type, 'start');
  assert.equal(h.events.at(-1).type, 'end');
  assert.equal(h.events.filter((e) => e.type === 'start').length, 1);
  const pcm = emittedPcm(h.events);
  assert.ok(pcm.length <= 9 * 1024);
  assert.deepEqual(pcm.slice(-1024), new Array(1024).fill(0));
  assert.equal(h.audio.diagnostics().admittedPttCaptures, 1);
});

test('PTT admission isolates repeated holds, stale identities and close callbacks', async (t) => {
  const h = admissionHarness();
  t.after(() => h.audio.close());
  await h.audio.initialize();
  h.audio.connectMicrophone({}, true, { captureId: 1 });
  h.worklets[0].feed(tone(160));
  h.audio.setMicrophoneEnabled(false, { captureId: 1 });
  h.audio.setMicrophoneEnabled(true, { captureId: 2 });
  const deliver = h.worklets[0].port.onmessage;
  deliver({
    data: { type: 'audio', captureId: 1, buffer: new ArrayBuffer(2048) },
  });
  deliver({ data: { type: 'end', captureId: 1 } });
  h.worklets[0].feed(tone(160));
  h.audio.setMicrophoneEnabled(false, { captureId: 2 });
  assert.deepEqual(
    h.events.map((e) => e.type),
    ['discard', 'discard'],
  );
  h.audio.setMicrophoneEnabled(true, { captureId: 3 });
  h.worklets[0].feed(new Float32Array(1024));
  await h.audio.close();
  deliver({ data: { type: 'audio', captureId: 3, buffer: tone(1024).buffer } });
  deliver({ data: { type: 'end', captureId: 3 } });
  assert.equal(h.events.length, 2);
  assert.equal(h.audio.diagnostics().pttBufferedBytes, 0);
});

test('PTT admission leaves open-mic start, silence, PCM and end unchanged', async (t) => {
  const h = admissionHarness({ pushToTalk: false });
  t.after(() => h.audio.close());
  await h.audio.initialize();
  h.audio.connectMicrophone({}, true, { captureId: 1 });
  h.worklets[0].feed(new Float32Array(1024));
  h.audio.setMicrophoneEnabled(false, { captureId: 1 });
  assert.deepEqual(
    h.events.map((e) => e.type),
    ['start', 'audio', 'end'],
  );
  assert.deepEqual(emittedPcm(h.events), new Array(1024).fill(0));
});
