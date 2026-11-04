import { readLayerSource } from '../testSupport/readLayerSource.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingClickGesture.js';
import { FAKE_EVENT_TYPES as TYPES, fakeInput } from '../input/testDoubles.mjs';
import { TRACKED_MODEL_MAX_PX as CIVIL_TRACKED_MODEL_MAX_PX } from './flights.js';
import { TRACKED_MODEL_MAX_PX as MILITARY_TRACKED_MODEL_MAX_PX } from './militaryFlights.js';

/** A dispatcher on a fake handler, with `onClick(click, gesture)` as the layers read it. */
function gestureInput(now, onClick) {
  const { input, handler } = fakeInput({ scene: {} }, { now });
  input.onClick((event) => onClick(event.screenPosition, event.gesture));
  return { input, handler };
}

test('tracking click discrimination pins the travel/duration boundary matrix', () => {
  const matrix = [
    [{ travelPx: 0, durationMs: 0 }, true],
    [{ travelPx: 6, durationMs: 400 }, true],
    [{ travelPx: 6.001, durationMs: 400 }, false],
    [{ travelPx: 6, durationMs: 400.001 }, false],
    [{ travelPx: 20, durationMs: 50 }, false],
    [{ travelPx: 0, durationMs: 1000 }, false],
  ];
  for (const [gesture, expected] of matrix) {
    assert.equal(isTrackingClickGesture(gesture), expected, JSON.stringify(gesture));
  }
  assert.equal(isTrackingSelectionGesture({ travelPx: 0, durationMs: 1000 }), true);
  assert.equal(isTrackingSelectionGesture({ travelPx: 6.001, durationMs: 10 }), false);
});

test('synthetic drag-then-click sequence does not reach the untrack callback', () => {
  let timeMs = 0;
  let untrackCalls = 0;
  const { input, handler } = gestureInput(() => timeMs, (_click, gesture) => {
    if (isTrackingClickGesture(gesture)) untrackCalls += 1;
  });

  handler.fire(TYPES.LEFT_DOWN, { position: { x: 10, y: 10 } });
  timeMs = 20;
  handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 14, y: 10 } });
  timeMs = 40;
  handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 10, y: 10 } });
  timeMs = 60;
  handler.fire(TYPES.LEFT_UP, { position: { x: 10, y: 10 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });

  assert.equal(untrackCalls, 0, '8 px accumulated travel must suppress the click despite zero displacement');

  handler.fire(TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });
  assert.equal(untrackCalls, 1, 'suppression is consumed and cannot poison the next click');
  input.destroy();
});

test('slow clean sprite clicks select, while long presses and orbit nudges cannot untrack', () => {
  let timeMs = 0;
  let selections = 0;
  let untracks = 0;
  // A click at x 0 lands on a sprite; anywhere else is empty space.
  const { input, handler } = gestureInput(() => timeMs, (click, gesture) => {
    if (!isTrackingSelectionGesture(gesture)) return;
    if (click.x === 0 && click.y === 0) {
      selections += 1;
      return;
    }
    if (isTrackingClickGesture(gesture)) untracks += 1;
  });

  handler.fire(TYPES.LEFT_DOWN, { position: { x: 0, y: 0 } });
  timeMs = 401;
  handler.fire(TYPES.LEFT_UP, { position: { x: 0, y: 0 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 0, y: 0 } });
  assert.equal(selections, 1, 'duration alone must not suppress entity selection');
  assert.equal(untracks, 0);

  timeMs = 500;
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 10, y: 10 } });
  timeMs = 520;
  handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 14, y: 10 } });
  timeMs = 540;
  handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 10, y: 10 } });
  handler.fire(TYPES.LEFT_UP, { position: { x: 10, y: 10 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });
  assert.equal(untracks, 0, 'return-to-origin orbit travel must not untrack');

  timeMs = 600;
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 0, y: 0 } });
  timeMs = 750;
  handler.fire(TYPES.LEFT_UP, { position: { x: 3, y: 4 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 3, y: 4 } });
  assert.equal(untracks, 1, 'a short clean empty-space tap still untracks');
  input.destroy();
});

test('civilian and military click handlers apply duration only at the deselect branch', () => {
  const sources = [
    readLayerSource(new URL('./flights.js', import.meta.url)),
    readLayerSource(new URL('./militaryFlights.js', import.meta.url)),
  ];
  for (const source of sources) {
    assert.match(source, /isTrackingSelectionGesture\(gesture\)[\s\S]+event\.hit/);
    assert.match(source, /isTrackingClickGesture\(gesture\)[\s\S]+(?:parts\.\w+\.)?_clearTracking\([^)]*\{ origin: 'user' \}\)/);
  }
  assert.doesNotMatch(
    sources[0],
    /(?:flightState\.)?_trackedEntity = (?:flightState\.)?_viewer\.entities\.add\(\{\s*id:/,
    'civilian tracked entities must retain Cesium-generated GUIDs',
  );
});

test('civilian and military tracked model caps both expose the owner-selected 200 px feel', () => {
  assert.equal(CIVIL_TRACKED_MODEL_MAX_PX, 200);
  assert.equal(MILITARY_TRACKED_MODEL_MAX_PX, 200);
});
