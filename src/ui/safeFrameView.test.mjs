// src/ui/safeFrameView.test.mjs — the recording safe frame renders what
// RecordingControls publishes to the recording store.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useRecordingStore } from './stores/recording.js';
import { RecordingControls } from './recordingControls.js';
import SceneChromeView from './views/SceneChromeView.vue';

test('the safe frame shows while a recording composes in it', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(SceneChromeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const store = useRecordingStore(pinia);
  const recording = new RecordingControls({
    syncShareState() {},
    syncHudControls() {},
    publishSafeFrame: (frame) => store.publishSafeFrame(frame),
  });
  recording.hud = {
    getMode: () => 'auto',
    getVariant: () => 'tactical',
    setMode() {},
    setVariant() {},
  };
  t.after(() => recording.destroy());
  const overlay = document.getElementById('safe-frame-overlay');
  const classes = () =>
    ['active', 'ratio-16-9', 'ratio-9-16'].filter((name) =>
      overlay.classList.contains(name),
    );
  recording._initRecordingOverlay();
  await nextTick();
  assert.deepEqual(classes(), []);
  recording.setRecordingMode(true, { safeFrame: '9:16' });
  await nextTick();
  assert.deepEqual(classes(), ['active', 'ratio-9-16']);
  recording.setRecordingMode(true);
  await nextTick();
  assert.deepEqual(classes(), ['active', 'ratio-16-9']);
  recording.setRecordingMode(false);
  await nextTick();
  assert.deepEqual(classes(), []);
  // Any frame but 9:16, even none named, records in 16:9.
  recording.setRecordingMode(true, { safeFrame: null });
  await nextTick();
  assert.deepEqual(classes(), ['active', 'ratio-16-9']);
  recording.setRecordingMode(true, { safeFrame: '4:3' });
  await nextTick();
  assert.deepEqual(classes(), ['active', 'ratio-16-9']);
  // A recording that ends with its controls takes its frame with it.
  recording.destroy();
  await nextTick();
  assert.deepEqual(classes(), []);
});
