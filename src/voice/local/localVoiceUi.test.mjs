import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { railFixture } from '../../ui/railTestFixture.mjs';
import { VoiceEngineControls } from '../voiceEngineControls.js';
import { LocalVoiceControls } from './localVoiceControls.js';
import { naturalVoiceAvailable } from './naturalVoiceSetting.js';
import {
  localVoiceTrayView,
  shortModelLabel,
} from './localVoicePresentation.js';
import {
  LOCAL_VOICE_MODEL_STORAGE_KEY,
  LOCAL_VOICE_STT_STORAGE_KEY,
  LOCAL_VOICE_TTS_STORAGE_KEY,
  localWebVoiceRequested,
  readLocalVoiceSettings,
  writeLocalVoiceModel,
  writeLocalVoiceStt,
  writeLocalVoiceTts,
} from './localVoicePreferences.js';
import { createLocalVoiceStore } from './localVoiceStore.js';
import { LLM_MODELS, findLlmModel } from './modelCatalog.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

test('the provider flag is opt-in through the URL', () => {
  assert.equal(localWebVoiceRequested('?voice=local-web'), true);
  assert.equal(localWebVoiceRequested('?voice=openai'), false);
  assert.equal(localWebVoiceRequested(''), false);
});

test('settings resolve URL, then stored choice, then device recommendation', () => {
  const storage = memoryStorage({
    [LOCAL_VOICE_MODEL_STORAGE_KEY]: 'gemma-4-e4b',
    [LOCAL_VOICE_STT_STORAGE_KEY]: 'whisper-base',
  });
  assert.deepEqual(
    readLocalVoiceSettings({ search: '', storage, deviceMemoryGB: 32 }),
    {
      llm: 'gemma-4-e4b',
      stt: 'whisper-base',
      tts: 'kokoro',
      naturalVoice: true,
    },
  );
  assert.equal(
    readLocalVoiceSettings({
      search: '?voiceModel=gemma-4-12b',
      storage,
    }).llm,
    'gemma-4-12b',
  );
  const empty = memoryStorage({ [LOCAL_VOICE_MODEL_STORAGE_KEY]: 'retired' });
  assert.deepEqual(
    readLocalVoiceSettings({ search: '', storage: empty, deviceMemoryGB: 32 }),
    {
      llm: 'gemma-4-12b',
      stt: 'moonshine-base',
      tts: 'kokoro',
      naturalVoice: true,
    },
  );
  assert.equal(
    readLocalVoiceSettings({ search: '', storage: null, deviceMemoryGB: 8 })
      .llm,
    'gemma-4-e4b',
  );
});

test('only known models are persisted', () => {
  const storage = memoryStorage();
  assert.equal(writeLocalVoiceModel('gemma-4-12b', storage), 'gemma-4-12b');
  assert.equal(writeLocalVoiceModel('nope', storage), null);
  assert.equal(writeLocalVoiceStt('whisper-base', storage), 'whisper-base');
  assert.equal(
    storage.values.get(LOCAL_VOICE_MODEL_STORAGE_KEY),
    'gemma-4-12b',
  );
  assert.equal(storage.values.get(LOCAL_VOICE_STT_STORAGE_KEY), 'whisper-base');
  const throwing = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(writeLocalVoiceModel('gemma-4-e4b', throwing), 'gemma-4-e4b');
  assert.equal(
    readLocalVoiceSettings({ search: '', storage: throwing }).stt,
    'moonshine-base',
  );
});

test('the store publishes changes and progress per component', () => {
  const store = createLocalVoiceStore({ llm: 'gemma-4-e4b' });
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state.phase));
  store.update({ phase: 'loading' });
  store.update({ phase: 'loading' });
  store.progress('llm', { loaded: 1, total: 2, phase: 'download' });
  store.progress('stt', { loaded: 1, total: 1, phase: 'download' });
  store.progress('llm', null);
  assert.deepEqual(Object.keys(store.getState().progress), ['stt']);
  unsubscribe();
  store.update({ phase: 'ready' });
  assert.deepEqual(seen, ['idle', 'loading', 'loading', 'loading', 'loading']);
});

test('the tray view reports download progress and device problems', () => {
  assert.equal(shortModelLabel(findLlmModel('gemma-4-26b-a4b')), '26B A4B');
  const loading = localVoiceTrayView({
    phase: 'loading',
    llm: 'gemma-4-12b',
    stt: 'moonshine-base',
    progress: {
      llm: { loaded: 3e9, total: 6e9, phase: 'download' },
      tts: { loaded: 1, total: 1, phase: 'download' },
    },
  });
  assert.equal(loading.open, true);
  assert.equal(loading.progressHidden, false);
  assert.equal(loading.progressPercent, 50);
  assert.match(
    loading.progressLabel,
    /^DOWNLOADING GEMMA 4 12B · 3\.0 GB \/ 6\.0 GB$/,
  );
  assert.ok(loading.modelChips.every((chip) => chip.disabled));
  assert.equal(loading.modelChips.find((chip) => chip.active).state, 'loading');
  assert.equal(loading.badge, 'ON-DEVICE 12B');

  const unsupported = localVoiceTrayView({
    phase: 'error',
    llm: 'gemma-4-12b',
    support: { ok: false, reason: 'Local voice needs WebGPU.' },
  });
  assert.equal(unsupported.open, true);
  assert.equal(unsupported.statusError, true);
  assert.equal(unsupported.status, 'Local voice needs WebGPU.');

  const ready = localVoiceTrayView({
    phase: 'ready',
    llm: 'gemma-4-12b',
    loadedLlm: 'gemma-4-e4b',
    stt: 'moonshine-base',
    loadedStt: 'moonshine-base',
    lastUser: 'Take me to Tokyo',
    lastReply: 'Flying to Tokyo.',
  });
  assert.equal(ready.open, false);
  assert.equal(ready.progressHidden, true);
  assert.equal(ready.note, 'Model change applies when voice restarts');
  assert.equal('lastReply' in ready, false, 'captions live in the voice card');
  assert.equal(ready.modelChips.length, LLM_MODELS.length);
});

function mountControls({ engine = 'on-device' } = {}) {
  const fixture = railFixture();
  const { document } = fixture;
  const root = document.createElement('div');
  root.id = 'gev-voice-control';
  const cost = document.createElement('div');
  cost.className = 'gev-voice-cost';
  root.appendChild(cost);
  const selected = [];
  const engineControls = new VoiceEngineControls({
    root,
    engine,
    onSelect: (id) => selected.push(id),
    probe: async () => ({
      secure: true,
      webgpu: true,
      adapter: true,
      vendor: 'apple',
      architecture: 'metal-3',
      maxBufferSize: 4 * 1024 ** 3,
      deviceMemoryGB: 16,
    }),
  });
  const store = createLocalVoiceStore({
    llm: 'gemma-4-e4b',
    stt: 'moonshine-base',
  });
  const calls = [];
  const controls = new LocalVoiceControls({
    root,
    store,
    engineControls,
    actions: {
      selectModel: (id) => {
        calls.push(['model', id]);
        store.update({ llm: id });
      },
      selectStt: (id) => calls.push(['stt', id]),
    },
  });
  return {
    fixture,
    root,
    cost,
    store,
    controls,
    engineControls,
    calls,
    selected,
  };
}

test('the model settings mount in the engine tray and follow the store', () => {
  const { root, cost, store, controls, engineControls, calls } =
    mountControls();
  assert.equal(cost.children[0], engineControls.toggle);
  assert.equal(controls.section.parent, engineControls.slot);
  assert.equal(root.dataset.voiceProvider, 'local-web');
  assert.equal(engineControls.toggle.textContent, 'ON-DEVICE E4B');
  assert.equal(root.dataset.localTray, undefined);

  store.update({
    phase: 'loading',
    progress: { llm: { loaded: 1e9, total: 4e9, phase: 'download' } },
  });
  assert.equal(root.dataset.localTray, 'open', 'loading opens the tray');
  assert.equal(controls.elements.progress.hidden, false);
  assert.equal(controls.elements.progressBar.style.width, '25%');

  store.update({ phase: 'ready', progress: {} });
  assert.equal(root.dataset.localTray, undefined);
  engineControls.toggle.click();
  assert.equal(root.dataset.voiceTray, 'open');
  assert.equal(engineControls.toggle.getAttribute('aria-expanded'), 'true');

  const chip = controls.elements.models.children.find(
    (node) => node.dataset.chipId === 'gemma-4-12b',
  );
  chip.click();
  assert.deepEqual(calls, [['model', 'gemma-4-12b']]);
  assert.equal(engineControls.toggle.textContent, 'ON-DEVICE 12B');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
});

test('the natural voice notice shows until natural voice first starts', () => {
  const { store, controls } = mountControls();
  store.update({ tts: 'kokoro', naturalNotice: true });
  assert.equal(controls.elements.notice.hidden, false);
  assert.match(
    controls.elements.notice.textContent,
    /open-source speech component \(GPL\)/,
  );
  store.update({ naturalNotice: false });
  assert.equal(controls.elements.notice.hidden, true);
  store.update({ tts: 'system', naturalNotice: true });
  assert.equal(controls.elements.notice.hidden, true, 'only for natural voice');
});

test('a build without natural voice offers system voices and text only', () => {
  const view = localVoiceTrayView({
    phase: 'idle',
    llm: 'gemma-4-e4b',
    stt: 'moonshine-base',
    tts: 'system',
    naturalVoice: false,
    naturalNotice: true,
  });
  assert.deepEqual(
    view.ttsChips.map((chip) => chip.id),
    ['system', 'none'],
  );
  assert.equal(view.notice, null);
  const storage = memoryStorage({ [LOCAL_VOICE_TTS_STORAGE_KEY]: 'kokoro' });
  assert.equal(
    readLocalVoiceSettings({ search: '', storage, naturalVoice: false }).tts,
    'system',
  );
  assert.equal(
    readLocalVoiceSettings({
      search: '?voiceTts=kokoro',
      storage: null,
      naturalVoice: false,
    }).tts,
    'system',
  );
  assert.equal(writeLocalVoiceTts('kokoro', storage, false), null);
  assert.equal(naturalVoiceAvailable('off'), false);
  assert.equal(naturalVoiceAvailable('0'), false);
  assert.equal(naturalVoiceAvailable(''), true);
  assert.equal(naturalVoiceAvailable(undefined), true);
});

test('natural voice falls back to a system voice when it cannot load', async () => {
  const { createLocalWebSession } = await import('./localWebSession.js');
  const storage = memoryStorage();
  const session = createLocalWebSession({
    emit: () => {},
    runAction: async () => ({ ok: true }),
    ui: null,
    storage,
    runtime: {
      createEngine: () => ({
        prepared: true,
        kokoroReady: false,
        async ensure() {
          return {
            kokoroReady: false,
            loads: [
              {
                timings: {
                  ttsError:
                    'Natural voice component failed its integrity check',
                },
              },
            ],
          };
        },
        terminate() {},
      }),
      probeSupport: async () => ({ ok: true }),
      checkStorage: async () => ({ note: null }),
      openMicrophone: async () => {
        throw new Error('no microphone in tests');
      },
    },
  });
  // No system voices in Node: the fallback ends at text only.
  await session.start();
  const state = session.local.store.getState();
  assert.equal(state.tts, 'kokoro');
  assert.match(state.speechNote, /integrity check.*system voice/);
  assert.equal(storage.values.size, 0, 'the notice stays until it succeeds');
  assert.equal(state.phase, 'ready');
  session.stop({ removeUi: true });
});

test('destroying the settings removes their nodes, listeners and subscription', () => {
  const { root, store, controls, engineControls, calls } = mountControls();
  const chip = controls.elements.models.children[0];
  controls.destroy();
  assert.equal(engineControls.slot.children.length, 0);
  assert.equal(root.dataset.voiceProvider, undefined);
  assert.equal(engineControls.toggle.textContent, 'ON-DEVICE');
  chip.click();
  store.update({ phase: 'loading' });
  assert.deepEqual(calls, []);
  assert.equal(root.dataset.localTray, undefined);
  controls.destroy();
  engineControls.destroy();
  assert.equal(root.dataset.voiceEngine, undefined);
});

test('model styles load with the provider; the engine tray with every page', () => {
  const styles = readFileSync(
    new URL('../../../style.css', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(styles, /local-voice\.css/);
  assert.match(styles, /voice-engine\.css/);
  const provider = readFileSync(
    new URL('./localWebProvider.js', import.meta.url),
    'utf8',
  );
  assert.match(
    provider,
    /import\('\.\.\/\.\.\/ui\/styles\/local-voice\.css'\)/,
  );
  const css = readFileSync(
    new URL('../../ui/styles/voice-engine.css', import.meta.url),
    'utf8',
  );
  assert.match(
    css,
    /#gev-voice-control\[data-voice-tray='open'\] \.gev-voice-engine-tray/,
  );
  assert.match(
    css,
    /#gev-voice-control\[data-local-tray='open'\] \.gev-voice-engine-tray/,
  );
  assert.match(css, /dock-has-pinned-tray \.gev-voice-engine-tray/);
  assert.match(
    css,
    /\[data-local-tray='open'\] \.gev-voice-card \{\s*display: none;/,
  );
});

test('URL speech override and load verbs', () => {
  assert.equal(
    readLocalVoiceSettings({ search: '?voiceStt=whisper-base', storage: null })
      .stt,
    'whisper-base',
  );
  const base = { phase: 'loading', llm: 'gemma-4-e4b', stt: 'moonshine-base' };
  assert.match(
    localVoiceTrayView({
      ...base,
      progress: { llm: { loaded: 1, total: 4, phase: 'cache' } },
    }).progressLabel,
    /^LOADING GEMMA 4 E4B/,
  );
  assert.equal(
    localVoiceTrayView({
      ...base,
      progress: { llm: { loaded: 0, total: 4, phase: 'compile' } },
    }).progressLabel,
    'COMPILING GEMMA 4 E4B',
  );
  assert.equal(
    localVoiceTrayView({ ...base, phase: 'ready', storageNote: 'Low space' })
      .note,
    'Low space',
  );
});
