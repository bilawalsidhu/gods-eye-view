import * as picking from '../../data/pickRegistry.js';
import { CCTV_COUNT_CARD_SOURCE_ID } from '../../data/cctvCards.js';
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

test("a count click yields to a card above it and to another layer's object, not to a CCTV icon", () => {
  let zooms = 0,
    clicks = 0;
  const selection = createSelection({
    services: { activation: {}, picking },
    state: {
      _enabled: true,
      _counts: { pickedCell: () => ({}) },
      _cctvOverlayHost: {
        hitTest: (x) => (x === 14 ? { entryId: 'cam-1' } : null),
      },
    },
    parts: {
      navigation: { zoomToCell: () => zooms++ },
      rendering: {
        extractPickedCameraId: (hit) =>
          hit?.set === 'cctv-icons' ? hit.id : null,
      },
    },
  });
  const click = selection.bindCctvWorldClickGesture(
    { onClick: (fn) => fn },
    () => clicks++,
  );
  picking.registerPickOwner('cctv', (id) => id.startsWith('cam-'));
  picking.registerPickOwner('flights', (id) => id === 'abc' || id === 'cam-2');
  try {
    for (const [x, topHit, expected] of [
      [14, null, [0, 1]],
      [20, { set: 'flights', id: 'abc' }, [0, 2]],
      [20, { set: 'cctv-icons', id: 'cam-2' }, [1, 2]],
      [20, null, [2, 2]],
      [20, { set: 'flights', id: 'cam-2' }, [2, 3]],
    ]) {
      click({
        screenPosition: { x, y: 26 },
        topHit,
        drawHit: topHit,
        gesture: { travelPx: 0, durationMs: 20 },
      });
      assert.deepEqual([zooms, clicks], expected);
    }
  } finally {
    picking.unregisterPickOwner('cctv');
    picking.unregisterPickOwner('flights');
  }
});

test('a count click is the card on top for every layer, unless the count yields', () => {
  let zooms = 0;
  let clicks = 0;
  const selection = createSelection({
    services: { activation: {}, picking },
    state: {
      _enabled: true,
      _counts: { pickedCell: (p) => (p?.x === 20 ? { key: 'g' } : null) },
      _cctvOverlayHost: { hitTest: () => null },
    },
    parts: {
      navigation: { zoomToCell: () => zooms++ },
      rendering: {
        extractPickedCameraId: (hit) =>
          hit?.set === 'cctv-icons' ? hit.id : null,
      },
    },
  });
  const click = selection.bindCctvWorldClickGesture(
    { onClick: (fn) => fn },
    () => clicks++,
  );
  const event = (topHit = null, x = 20, durationMs = 20) => ({
    screenPosition: { x, y: 26 },
    topHit,
    drawHit: topHit,
    gesture: { travelPx: 0, durationMs },
  });
  picking.registerClickClaim('cctv', selection.countClickCard);
  picking.registerPickOwner('flights', (id) => id === 'abc');
  try {
    const aircraftFirst = event();
    assert.equal(picking.isUnderOtherCard(aircraftFirst), true);
    assert.deepEqual(picking.clickCard(aircraftFirst), {
      sourceId: CCTV_COUNT_CARD_SOURCE_ID,
      entryId: 'g',
    });
    click(aircraftFirst);
    assert.deepEqual([zooms, clicks], [1, 0]);

    const cctvFirst = event();
    click(cctvFirst);
    assert.equal(picking.isUnderOtherCard(cctvFirst), true);
    assert.deepEqual([zooms, clicks], [2, 0]);

    for (const [e, claimed, expected] of [
      [event({ set: 'flights', id: 'abc' }), false, [2, 1]],
      [event({ set: 'cctv-icons', id: 'cam-2' }), true, [3, 1]],
      [event(null, 20, 1000), false, [3, 1]],
      [event(null, 60), false, [3, 2]],
      [{ ...event(), overlay: true }, false, [3, 3]],
    ]) {
      assert.equal(picking.isUnderOtherCard(e), claimed);
      click(e);
      assert.deepEqual([zooms, clicks], expected);
    }
  } finally {
    picking.unregisterClickClaim('cctv');
    picking.unregisterPickOwner('flights');
  }
});

test('same-camera selection ends the opening pick without notifying snapshot feeds', () => {
  const fixture = makeSelection('tripcheck-odot');
  fixture.state._openingCameraProvisional = true;

  assert.equal(
    fixture.selection.setActiveCamera('same-camera'),
    CCTV_ACTIVATION_RESULT.UNCHANGED,
  );
  assert.equal(fixture.state._openingCameraProvisional, false);
  assert.equal(fixture.state._activeCameraReselection, 0);
  assert.equal(fixture.notifications(), 0);
});
