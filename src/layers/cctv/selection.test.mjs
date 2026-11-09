import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CCTV_ACTIVATION_RESULT } from '../../cctvFocusRequest.js';
import { createSelection } from './selection.js';

function makeSelection(sourceKind) {
  const camera = { id: 'same-camera', sourceKind };
  const record = { camera };
  const state = {
    _activeCameraId: camera.id,
    _activeCameraReselection: 0,
    _recordById: new Map([[camera.id, record]]),
  };
  let notifications = 0;
  const selection = createSelection({
    state,
    services: {
      activation: { CCTV_ACTIVATION_RESULT },
      picking: { resolvePickId: () => null },
    },
    parts: {
      model: {
        cctvRecordNeedsActivation: () => false,
        isBrowserOverlayCamera: (value) =>
          String(value?.sourceKind || '').startsWith('quebec-'),
      },
      presentation: { notifyListeners: () => notifications++ },
    },
    source: {},
  });
  return { selection, state, notifications: () => notifications };
}

test('same-camera selection does not notify or mutate snapshot-feed state', () => {
  const fixture = makeSelection('tripcheck-odot');

  assert.equal(
    fixture.selection.setActiveCamera('same-camera'),
    CCTV_ACTIVATION_RESULT.UNCHANGED,
  );
  assert.equal(fixture.state._activeCameraReselection, 0);
  assert.equal(fixture.notifications(), 0);
});

test('same-camera selection notifies browser-overlay feeds so playback can retry', () => {
  const fixture = makeSelection('quebec-511-browser');

  assert.equal(
    fixture.selection.setActiveCamera('same-camera'),
    CCTV_ACTIVATION_RESULT.UNCHANGED,
  );
  assert.equal(fixture.state._activeCameraReselection, 1);
  assert.equal(fixture.notifications(), 1);
});
