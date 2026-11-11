// src/voice/panel/preferencesView.test.mjs — the rendered minutes field keeps
// a draft across renders and shows a refused edit's applied value again.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindPreferenceControls,
  createVoicePreferences,
  VOICE_TIMEOUT_STORAGE_KEY as T,
} from './preferences.js';
import { createTestVoiceUi } from '../../testSupport/voiceUi.mjs';
import { mountVoiceView } from '../../testSupport/voiceView.mjs';

test('a minutes draft survives unrelated renders; a refused edit is written back', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const ui = createTestVoiceUi({ panel: true, pinia });
  ui.update('preferences', { timeoutMinutes: '17' });
  const prefs = createVoicePreferences({
    storage: { getItem: (key) => (key === T ? '17' : null), setItem() {} },
  });
  bindPreferenceControls({
    ui,
    preferences: prefs,
    copy: { previewNote: '', timeoutNote: 'Local', notSaved: 'Not saved' },
  });
  await settle();
  const input = document.getElementById('gev-voice-timeout-input');
  assert.equal(input.value, '17');
  // Typing, before the field commits: the waveform renders every frame.
  input.value = '2';
  ui.update('status', { text: 'LISTENING' });
  await settle();
  assert.equal(input.value, '2');
  input.value = '0';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  assert.equal(input.value, '17');
});
