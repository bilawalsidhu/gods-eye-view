import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWakeWordListener,
  readWakeWordSettings,
  WAKE_WORD_STORAGE,
} from './wakeWord.js';

function fakes() {
  const calls = [];
  let detect;
  const worker = {
    release: async () => calls.push('release'),
    terminate: () => calls.push('terminate'),
  };
  const PorcupineWorker = {
    create: async (key, keywords, callback, model) => {
      calls.push(['create', key, keywords, model.publicPath]);
      detect = callback;
      return worker;
    },
  };
  const WebVoiceProcessor = {
    subscribe: async () => calls.push('subscribe'),
    unsubscribe: async () => calls.push('unsubscribe'),
  };
  return {
    calls,
    fire: (label) => detect?.({ label }),
    loadPorcupine: async () => ({
      PorcupineWorker,
      BuiltInKeyword: { Computer: 'Computer', Jarvis: 'Jarvis' },
    }),
    loadProcessor: async () => ({ WebVoiceProcessor }),
  };
}

test('settings come from localStorage first, then server config, and can be disabled', () => {
  const storage = new Map();
  const fakeStorage = {
    getItem: (k) => storage.get(k) ?? null,
  };
  assert.deepEqual(readWakeWordSettings({ storage: fakeStorage }), {
    accessKey: '',
    keyword: 'Computer',
    enabled: false,
  });
  assert.equal(
    readWakeWordSettings({
      storage: fakeStorage,
      config: { accessKey: 'srv', keyword: 'Jarvis' },
    }).enabled,
    true,
  );
  storage.set(WAKE_WORD_STORAGE.accessKey, 'local');
  storage.set(WAKE_WORD_STORAGE.keyword, 'Porcupine');
  const settings = readWakeWordSettings({
    storage: fakeStorage,
    config: { accessKey: 'srv', keyword: 'Jarvis' },
  });
  assert.deepEqual(settings, {
    accessKey: 'local',
    keyword: 'Porcupine',
    enabled: true,
  });
  storage.set(WAKE_WORD_STORAGE.enabled, '0');
  assert.equal(readWakeWordSettings({ storage: fakeStorage }).enabled, false);
});

test('the listener arms, detects only while armed, pauses for a session and releases on destroy', async () => {
  const f = fakes();
  const detections = [];
  const listener = createWakeWordListener({
    accessKey: 'k',
    keyword: 'computer',
    onDetect: (d) => detections.push(d.label),
    loadPorcupine: f.loadPorcupine,
    loadProcessor: f.loadProcessor,
  });
  assert.equal(await listener.start(), true);
  assert.deepEqual(f.calls[0], [
    'create',
    'k',
    ['Computer'],
    '/wakeword/porcupine_params.pv',
  ]);
  assert.equal(listener.listening, true);
  f.fire('Computer');
  assert.deepEqual(detections, ['Computer']);
  await listener.pause();
  assert.equal(listener.listening, false);
  f.fire('Computer');
  assert.deepEqual(detections, ['Computer'], 'ignored while paused');
  assert.equal(await listener.start(), true);
  assert.equal(
    f.calls.filter((c) => c === 'subscribe').length,
    2,
    'resubscribes without recreating the worker',
  );
  assert.equal(f.calls.filter((c) => Array.isArray(c)).length, 1);
  await listener.destroy();
  assert.ok(f.calls.includes('release') && f.calls.includes('terminate'));
  assert.equal(await listener.start(), false);
});

test('engine failures are reported, never thrown', async () => {
  const errors = [];
  const listener = createWakeWordListener({
    accessKey: 'bad',
    onDetect: () => {},
    onError: (e) => errors.push(e.message),
    loadPorcupine: async () => ({
      PorcupineWorker: {
        create: async () => {
          throw new Error('Invalid AccessKey');
        },
      },
      BuiltInKeyword: {},
    }),
    loadProcessor: async () => ({ WebVoiceProcessor: {} }),
  });
  assert.equal(await listener.start(), false);
  assert.deepEqual(errors, ['Invalid AccessKey']);
});
