import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CCTV_ACTIVATION_RESULT } from '../../cctvFocusRequest.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { createNavigation } from './navigation.js';
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

test('a count click preserves the provisional opening pick until the view settles', () => {
  const viewer = {};
  const flights = [];
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ fovy: Math.PI / 3, aspectRatio: 1 }),
      flyToBounds: (bounds) => flights.push(bounds),
    },
    canvas: { height: 600 },
  });
  try {
    const cell = { west: 1, east: 2, south: 0, north: 0, low: 0, high: 0 };
    const state = {
      _enabled: true,
      _viewer: viewer,
      _openingCameraProvisional: true,
      _activeCameraId: 'opening',
      _counts: {
        pickedCell: (point) => (point?.x === 14 && point.y === 26 ? cell : null),
      },
    };
    const parts = {};
    parts.navigation = createNavigation({ state, parts });
    const selection = createSelection({
      state,
      parts,
      services: { activation: {}, picking: {} },
    });
    const click = selection.bindCctvWorldClickGesture(
      { onClick: (fn) => fn },
      () => {
        assert.fail('a count click reached activation or deselection');
      },
    );
    click({
      screenPosition: { x: 14, y: 26 },
      get drawHit() {
        assert.fail('the camera underneath was picked');
      },
      gesture: { travelPx: 0, durationMs: 20 },
    });
    assert.equal(flights.length, 1);
    assert.equal(state._activeCameraId, 'opening');
    assert.equal(state._openingCameraProvisional, true);
  } finally {
    unbind();
  }
});
