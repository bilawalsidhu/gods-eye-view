import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  createLocalPcmRecorder,
  hasLocalSpeech,
  localSpeechSamples,
} from './localAudioCapture.js';

const worklet = readFileSync(
  new URL('./localAudioWorklet.js', import.meta.url),
  'utf8',
);
function processor(rate = 16000) {
  let Processor;
  const messages = [];
  runInNewContext(worklet, {
    sampleRate: rate,
    Float32Array,
    AudioWorkletProcessor: class {
      port = {
        postMessage: (data, transfers) => messages.push({ data, transfers }),
      };
    },
    registerProcessor: (_name, implementation) => {
      Processor = implementation;
    },
  });
  const instance = new Processor();
  return {
    messages,
    command: (type, id) => instance.port.onmessage({ data: { type, id } }),
    input: (samples) => instance.process([[Float32Array.from(samples)]]),
  };
}

test('PCM recordings preserve samples across blocks and isolate consecutive takes', () => {
  const mic = processor();
  mic.input([1]);
  mic.command('start', 1);
  mic.input([0.25, -0.5]);
  mic.input([0.75]);
  mic.command('stop', 1);
  mic.command('stop', 1);
  assert.equal(mic.messages.length, 1);
  assert.deepEqual([...mic.messages[0].data.samples], [0.25, -0.5, 0.75]);
  assert.equal(mic.messages[0].data.sampleRate, 16000);
  assert.equal(
    mic.messages[0].transfers[0],
    mic.messages[0].data.samples.buffer,
  );
  mic.input([1]);
  mic.command('start', 2);
  mic.input([-0.25]);
  mic.command('stop', 2);
  assert.deepEqual([...mic.messages[1].data.samples], [-0.25]);
});

test('cancelled capture and stale stop commands cannot submit or stop a later take', () => {
  const mic = processor();
  mic.command('start', 1);
  mic.input([1]);
  mic.command('cancel', 1);
  mic.command('start', 2);
  mic.command('stop', 1);
  mic.command('cancel', 1);
  assert.equal(mic.messages.length, 0);
  mic.input([0.25]);
  mic.command('stop', 2);
  assert.equal(mic.messages.length, 1);
  assert.equal(mic.messages[0].data.id, 2);
  assert.deepEqual([...mic.messages[0].data.samples], [0.25]);
});

test('capture stops at twenty seconds even if the main thread does not send stop', () => {
  const mic = processor(44100);
  mic.command('start', 1);
  const block = new Float32Array(128).fill(0.25);
  for (let i = 0; i < 7000; i++) mic.input(block);
  mic.command('stop', 1);
  assert.equal(mic.messages.length, 1);
  assert.equal(mic.messages[0].data.samples.length, 44100 * 20);
  assert.equal(mic.messages[0].data.samples.at(-1), 0.25);
});

test('empty, short, silent or invalid audio never qualifies for transcription', () => {
  for (const samples of [
    new Float32Array(),
    new Float32Array(3199).fill(0.5),
    new Float32Array(16000),
    new Float32Array(16000).fill(0.001),
    new Float32Array(16000).fill(NaN),
  ])
    assert.equal(hasLocalSpeech(samples, 16000), false);
  const spoken = Float32Array.from(
    { length: 16000 },
    (_, i) => 0.1 * Math.sin(i),
  );
  assert.equal(hasLocalSpeech(spoken, 16000), true);
  assert.equal(hasLocalSpeech(spoken, 0), false);
  assert.equal(hasLocalSpeech(spoken, NaN), false);
});

test('16 kHz PCM reaches Whisper unchanged and never needs an encoded audio decoder', async () => {
  const samples = new Float32Array([0.25, -0.5, 0.75]);
  assert.equal(await localSpeechSamples(samples, 16000), samples);
});

test('pending stop cannot start a second take; cancellation ignores late worklet replies', async (t) => {
  const original = globalThis.AudioWorkletNode;
  t.after(() => {
    if (original === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = original;
  });
  let node,
    closed = 0,
    disconnected = 0;
  const commands = [];
  globalThis.AudioWorkletNode = class {
    constructor() {
      node = this;
    }
    port = {
      postMessage: (data) => commands.push(data),
      close: () => closed++,
    };
    connect() {}
    disconnect() {
      disconnected++;
    }
  };
  const source = {
    connect() {},
    disconnect() {
      disconnected++;
    },
  };
  const context = {
    audioWorklet: { addModule: async () => {} },
    destination: {},
  };
  const capture = await createLocalPcmRecorder(context, source, assert.fail);
  t.after(() => capture.close());
  const results = [];
  capture.start((samples) => results.push(samples));
  capture.stop();
  capture.start(assert.fail);
  assert.equal(capture.state, 'stopping');
  assert.deepEqual(
    commands.map((item) => item.type),
    ['start', 'stop'],
  );
  capture.cancel();
  capture.start((samples) => results.push(samples));
  node.port.onmessage({ data: { id: 1, samples: 'stale', sampleRate: 16000 } });
  assert.deepEqual(results, []);
  node.port.onmessage({
    data: { id: 2, samples: 'current', sampleRate: 16000 },
  });
  assert.deepEqual(results, ['current']);
  assert.equal(capture.state, 'inactive');
  capture.close();
  capture.close();
  assert.equal(closed, 1);
  assert.equal(disconnected, 2);
  assert.equal(node.port.onmessage, null);
});
