// Cloud / On-device choice in the voice control: preference, hardware check
// and guidance, and the tray that switches engines.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { railFixture } from '../ui/railTestFixture.mjs';
import {
  DEFAULT_VOICE_ENGINE,
  VOICE_ENGINE_STORAGE_KEY,
  readVoiceEngine,
  writeVoiceEngine,
} from './voiceEngine.js';
import { VoiceEngineControls } from './voiceEngineControls.js';
import {
  ON_DEVICE_GUIDANCE,
  deviceCheckView,
  probeDevice,
  voiceEngineView,
} from './voiceEnginePresentation.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

const appleProbe = {
  secure: true,
  webgpu: true,
  adapter: true,
  vendor: 'apple',
  architecture: 'metal-3',
  maxBufferSize: 4 * 1024 ** 3,
  deviceMemoryGB: 16,
};

test('the engine choice persists; the URL flag stays a shortcut', () => {
  const storage = memoryStorage();
  assert.equal(readVoiceEngine({ search: '', storage }), DEFAULT_VOICE_ENGINE);
  assert.equal(DEFAULT_VOICE_ENGINE, 'cloud');
  assert.equal(writeVoiceEngine('on-device', storage), 'on-device');
  assert.equal(storage.values.get(VOICE_ENGINE_STORAGE_KEY), 'on-device');
  assert.equal(readVoiceEngine({ search: '', storage }), 'on-device');
  assert.equal(readVoiceEngine({ search: '?voice=cloud', storage }), 'cloud');
  assert.equal(
    readVoiceEngine({ search: '?voice=local-web', storage: memoryStorage() }),
    'on-device',
  );
  assert.equal(writeVoiceEngine('elsewhere', storage), null);
  const corrupt = memoryStorage({ [VOICE_ENGINE_STORAGE_KEY]: 'nope' });
  assert.equal(readVoiceEngine({ search: '', storage: corrupt }), 'cloud');
  const throwing = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readVoiceEngine({ search: '', storage: throwing }), 'cloud');
  assert.equal(writeVoiceEngine('cloud', throwing), 'cloud');
});

test('hardware guidance names the model and download for each tier', () => {
  assert.deepEqual(ON_DEVICE_GUIDANCE, [
    'Works best on 16 GB+ Apple Silicon: Gemma 4 12B (6 GB download)',
    '8–16 GB: Gemma 4 E4B (3 GB download)',
    'Under 8 GB or no WebGPU: use Cloud',
  ]);
  const apple = deviceCheckView(appleProbe);
  assert.equal(apple.state, 'supported');
  assert.equal(apple.gpu, 'WebGPU: available (apple metal-3)');
  assert.equal(apple.memory, 'Memory: browser reports at least 16 GB');
  assert.equal(apple.suggested, 'gemma-4-12b');
  assert.match(apple.verdict, /Suggested: Gemma 4 12B \(6 GB download\)/);
  const eight = deviceCheckView({ ...appleProbe, deviceMemoryGB: 8 });
  assert.equal(eight.suggested, 'gemma-4-e4b');
  assert.equal(deviceCheckView(null).state, 'checking');
});

test('an unsupported device is explained and pointed to Cloud', () => {
  const noGpu = deviceCheckView({ ...appleProbe, webgpu: false });
  assert.equal(noGpu.state, 'unsupported');
  assert.equal(noGpu.gpu, 'WebGPU: not available');
  assert.match(noGpu.verdict, /needs WebGPU.*Use Cloud\.$/);
  const small = deviceCheckView({ ...appleProbe, deviceMemoryGB: 4 });
  assert.equal(small.state, 'unsupported');
  assert.match(small.verdict, /needs about 8 GB/);
  const view = voiceEngineView({
    engine: 'cloud',
    probe: { ...appleProbe, webgpu: false },
  });
  assert.equal(
    view.chips.find((chip) => chip.id === 'on-device').disabled,
    true,
  );
  // An on-device choice can always be undone, even when refused.
  const chosen = voiceEngineView({
    engine: 'on-device',
    probe: { ...appleProbe, webgpu: false },
  });
  assert.equal(
    chosen.chips.find((chip) => chip.id === 'on-device').disabled,
    false,
  );
  assert.equal(
    chosen.chips.find((chip) => chip.id === 'cloud').disabled,
    undefined,
  );
});

test('the probe reads WebGPU adapter facts and the memory estimate', async () => {
  const probe = await probeDevice({
    navigator: {
      deviceMemory: 8,
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: 'apple', architecture: 'metal-3' },
          limits: { maxBufferSize: 2 ** 32 },
        }),
      },
    },
    secure: true,
  });
  assert.deepEqual(probe, {
    secure: true,
    webgpu: true,
    adapter: true,
    vendor: 'apple',
    architecture: 'metal-3',
    maxBufferSize: 2 ** 32,
    deviceMemoryGB: 8,
  });
  const failing = await probeDevice({
    navigator: {
      gpu: {
        requestAdapter: async () => {
          throw new Error('blocked');
        },
      },
    },
  });
  assert.equal(failing.adapter, false);
  assert.equal((await probeDevice({ navigator: {} })).webgpu, false);
});

test('the engine tray nests in the voice control and switches engines', async () => {
  const { document } = railFixture();
  const root = document.createElement('div');
  const cost = document.createElement('div');
  cost.className = 'gev-voice-cost';
  root.appendChild(cost);
  const selected = [];
  let probes = 0;
  const controls = new VoiceEngineControls({
    root,
    engine: 'cloud',
    onSelect: (id) => selected.push(id),
    probe: async () => {
      probes++;
      return appleProbe;
    },
  });
  assert.equal(cost.children[0], controls.toggle);
  assert.equal(controls.toggle.textContent, 'CLOUD');
  assert.equal(root.dataset.voiceEngine, 'cloud');
  assert.equal(probes, 0, 'a Cloud user is not probed until the tray opens');

  controls.toggle.click();
  assert.equal(root.dataset.voiceTray, 'open');
  await controls.probing;
  assert.equal(probes, 1);
  assert.match(controls.elements.verdict.textContent, /Gemma 4 12B/);
  assert.equal(controls.elements.guidance.children.length, 3);

  const chip = (id) =>
    controls.elements.chips.children.find((node) => node.dataset.chipId === id);
  chip('cloud').click();
  assert.deepEqual(selected, [], 'the running engine is not re-selected');
  chip('on-device').click();
  assert.deepEqual(selected, ['on-device']);

  controls.toggle.click();
  assert.equal(root.dataset.voiceTray, undefined);
  controls.destroy();
  assert.equal(cost.children.length, 0);
  assert.equal(root.dataset.voiceEngine, undefined);
});

test('a saved on-device choice checks the hardware at once', async () => {
  const { document } = railFixture();
  const root = document.createElement('div');
  const controls = new VoiceEngineControls({
    root,
    engine: 'on-device',
    probe: async () => ({ ...appleProbe, webgpu: false }),
  });
  await controls.probing;
  assert.equal(controls.toggle.textContent, 'ON-DEVICE');
  assert.match(controls.elements.verdict.textContent, /Use Cloud\.$/);
  assert.ok(controls.elements.verdict.className.includes('error'));
  controls.setBadge('ON-DEVICE E4B');
  assert.equal(controls.toggle.textContent, 'ON-DEVICE E4B');
  controls.destroy();
});
