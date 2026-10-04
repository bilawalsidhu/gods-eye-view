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

function createCaptureHarness() {
  let Processor;
  const messages = [];
  vm.runInNewContext(
    fs.readFileSync(
      new URL('./geminiCaptureWorklet.js', import.meta.url),
      'utf8',
    ),
    {
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
  capture.port.onmessage({ data: { enabled: true } });
  capture.process([[new Float32Array([-1, 0, 1])]]);
  capture.port.onmessage({ data: { enabled: false } });
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
  const enable = (enabled) => capture.port.onmessage({ data: { enabled } });
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
  let drains = 0;
  let context;
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  class Context {
    constructor() {
      context = this;
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
      return { ...node(), stream: {} };
    }
    createBuffer(_channels, length, rate) {
      return { duration: length / rate, copyToChannel() {} };
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
      this.port = { postMessage() {}, close() {} };
    }
  }
  const audio = createGeminiAudio({
    AudioContextClass: Context,
    AudioWorkletNodeClass: Worklet,
    onAudioStart: () => order.push('start'),
    onAudio: (chunk) => {
      emitted.push(chunk);
      order.push('audio');
    },
    onAudioEnd: () => order.push('end'),
  });
  await audio.initialize();
  audio.connectMicrophone({}, true);
  const deliver = capture.port.onmessage;
  deliver({ data: { type: 'start' } });
  capture.port.onmessage({
    data: { type: 'audio', buffer: new ArrayBuffer(4) },
  });
  const spoken = new ArrayBuffer(4);
  new DataView(spoken).setInt16(0, 16384, true);
  capture.port.onmessage({ data: { type: 'audio', buffer: spoken } });
  deliver({ data: { type: 'end' } });
  assert.deepEqual(order, ['start', 'audio', 'audio', 'end']);
  assert.equal(audio.diagnostics().inputChunks, 2);
  assert.equal(audio.diagnostics().nonSilentInputChunks, 1);
  assert.equal(audio.diagnostics().inputPeak, 0.5);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].mimeType, 'audio/pcm;rate=16000');
  assert.equal(await audio.close(), true);
  assert.equal(audio.diagnostics().contextState, 'closed');
  deliver({ data: { type: 'start' } });
  deliver({ data: { type: 'audio', buffer: spoken } });
  deliver({ data: { type: 'end' } });
  assert.deepEqual(order, ['start', 'audio', 'audio', 'end']);
});
