import * as picking from '../../data/pickRegistry.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelection } from './selection.js';

function setup() {
  let zooms = 0,
    clicks = 0;
  const selection = createSelection({
    services: { activation: {}, picking },
    state: {
      _enabled: true,
      _counts: { pickedCell: () => ({}) },
      _cctvOverlayHost: { hitTest: () => null },
    },
    parts: {
      navigation: { zoomToCell: () => zooms++ },
      rendering: { extractPickedCameraId: () => null },
    },
  });
  const click = selection.bindCctvWorldClickGesture(
    { onClick: (fn) => fn },
    () => clicks++,
  );
  return { click, counts: () => [zooms, clicks] };
}

test('a click a painted overlay target took (Space Missions label) does not fly to the count', () => {
  const { click, counts } = setup();
  // What the dispatcher hands subscribers after an onOverlayClick handler returned true.
  click({
    screenPosition: { x: 20, y: 26 },
    overlay: true,
    topHit: { set: '', id: null, surface: false },
    drawHit: null,
    gesture: { travelPx: 0, durationMs: 20 },
  });
  assert.equal(
    counts()[0],
    0,
    'count flight ran although an overlay target handled the click',
  );
});

test("another layer's world-overlay card on top (clickCard) takes the click from the count", () => {
  const { click, counts } = setup();
  picking.setClickCardHitTest(() => ({
    sourceId: 'earthquakes',
    entryId: 'eq-1',
  }));
  try {
    click({
      screenPosition: { x: 20, y: 26 },
      topHit: null,
      drawHit: null,
      gesture: { travelPx: 0, durationMs: 20 },
    });
    assert.ok(
      picking.isUnderOtherCard({ screenPosition: { x: 1, y: 1 } }, ['cctv']),
    );
    assert.equal(counts()[0], 0, 'count flight ran under another layer card');
  } finally {
    picking.setClickCardHitTest(null);
  }
});
