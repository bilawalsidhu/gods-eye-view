import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultMapSources } from '../maps/defaultSources.js';
import { photorealUnavailableReason } from '../maps/availability.js';
import { keySetupStatus } from '../keySetupCore.mjs';
import { GevRealtimeController } from '../voice/realtimeController.js';

/**
 * Review Focus 3+4 gates at stub level (Task 3 Step 5b).
 *
 * Everything asserted here runs in plain Node with stubbed platform seams —
 * no Android SDK, emulator, microphone, or GPU required. What genuinely needs
 * a real device (native Preferences round-trip, live getUserMedia denial,
 * on-device tile billing UI, globe render) is deferred to Task 4; see the
 * Task 3 fix report for the explicit split.
 */

test('Google 3D stays off by default with a key-guided notice', () => {
  const keyless = createDefaultMapSources({});
  assert.notEqual(
    keyless.defaultId,
    'photoreal',
    'keyless mobile boot must not default to metered tiles',
  );
  const photoreal = keyless.sources.find(
    (source) => source.descriptor.kind === 'photoreal',
  );
  assert.equal(photoreal.available, false);
  assert.match(photoreal.unavailableReason, /GOOGLE_MAPS_API_KEY/);
  assert.equal(
    photorealUnavailableReason(false),
    photoreal.unavailableReason,
    'enabling copy points at the key, not a dead end',
  );
});

test('the Google key carries the metered-cost notice', () => {
  const status = keySetupStatus({});
  const google = status.keys.find((key) => key.id === 'google-maps');
  assert.equal(
    google.tier,
    'metered',
    'metered tier drives the red cost dot in Provider Settings',
  );
});

test('mic denial surfaces an error state with the denial message', () => {
  const ui = {
    root: { dataset: {}, classList: { remove() {} } },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    errorDetail: { textContent: '' },
  };
  const session = {
    ui,
    status: 'idle',
    pushToTalkMode: false,
    pushToTalkKeyHeld: false,
    emitSessionEvent(event) {
      this.lastEvent = event;
    },
    updateVoiceButtonLabel() {},
    setVoiceSpeaker() {},
    pauseRadioForVoice() {},
  };
  GevRealtimeController.prototype.setStatus.call(
    session,
    'error',
    'Permission denied by user',
  );
  assert.equal(ui.root.dataset.status, 'error');
  assert.equal(ui.detail.textContent, 'VOICE UNAVAILABLE');
  assert.equal(ui.errorDetail.textContent, 'Permission denied by user');
  assert.deepEqual(session.lastEvent, {
    type: 'state',
    state: 'error',
    detail: 'Permission denied by user',
  });
});
