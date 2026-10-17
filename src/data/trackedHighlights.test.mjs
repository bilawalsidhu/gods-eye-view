import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createSelectionHighlights,
  SELECTION_HIGHLIGHT_COLOR,
} from './trackedHighlights.js';

function fakeViewer() {
  const entities = [];
  entities.add = (graphics) => {
    const entity = { ...graphics };
    entities.push(entity);
    return entity;
  };
  entities.remove = (entity) => {
    const index = entities.indexOf(entity);
    if (index !== -1) entities.splice(index, 1);
    return index !== -1;
  };
  return { isDestroyed: () => false, entities };
}

function makeFlightState(viewer = fakeViewer(), entries = {}) {
  const billboards = new Map(
    Object.entries(entries).map(([id, position]) => [id, { position }]),
  );
  return { _viewer: viewer, _billboards: billboards };
}

function fixture() {
  const viewer = fakeViewer();
  const flightState = makeFlightState(viewer, {
    abc123: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 10_000),
    def456: Cesium.Cartesian3.fromDegrees(35.939, 31.953, 20_000),
  });
  return { viewer, flightState };
}

test('add marks a tracked aircraft with a namespaced ring entity on the billboard position', () => {
  const { viewer, flightState } = fixture();
  const highlights = createSelectionHighlights(flightState, 'flights');
  assert.equal(highlights.add('abc123'), true);
  assert.equal(highlights.has('abc123'), true);
  const entity = viewer.entities[0];
  assert.equal(entity.id, 'gev-track-highlight:flights:abc123');
  assert.equal(typeof entity.position.getValue, 'function');
  const ring = entity.point;
  assert.equal(ring.color, Cesium.Color.TRANSPARENT);
  assert.equal(ring.outlineColor, SELECTION_HIGHLIGHT_COLOR);
  assert.equal(ring.outlineWidth, 3);
  assert.equal(ring.pixelSize, 26);
  assert.equal(ring.disableDepthTestDistance, Number.POSITIVE_INFINITY);
});

test('the ring tracks the fleet billboard position live and falls back to its initial fix', () => {
  const { flightState } = fixture();
  const highlights = createSelectionHighlights(flightState, 'flights');
  highlights.add('abc123');
  const callback = highlightsMapper(flightState);
  const initial = Cesium.Cartesian3.clone(flightState._billboards.get('abc123').position);
  assert.ok(callback('abc123').equals(initial));
  const moved = Cesium.Cartesian3.fromDegrees(35.939, 31.953, 35_000);
  flightState._billboards.get('abc123').position = moved;
  assert.ok(callback('abc123').equals(moved));
});

test('a missing billboard or viewer makes add a no-op', () => {
  const { viewer } = fixture();
  const highlights = createSelectionHighlights(makeFlightState(viewer), 'military');
  assert.equal(highlights.add('ghost123'), false);
  assert.equal(highlights.has('ghost123'), false);

  const flightState = makeFlightState(viewer, {
    abc123: Cesium.Cartesian3.fromDegrees(0, 0, 0),
  });
  flightState._viewer = null;
  const noViewer = createSelectionHighlights(flightState, 'military');
  assert.equal(noViewer.add('abc123'), false);
});

test('add is idempotent and namespaces keep layers from colliding', () => {
  const { viewer, flightState } = fixture();
  const flights = createSelectionHighlights(flightState, 'flights');
  const military = createSelectionHighlights(flightState, 'military');
  flights.add('abc123');
  flights.add('abc123');
  military.add('abc123');
  assert.equal(viewer.entities.length, 2);
  assert.equal(viewer.entities[0].id, 'gev-track-highlight:flights:abc123');
  assert.equal(viewer.entities[1].id, 'gev-track-highlight:military:abc123');
});

test('remove drops the entity and clear empties every ring', () => {
  const { viewer, flightState } = fixture();
  const highlights = createSelectionHighlights(flightState, 'flights');
  highlights.add('abc123');
  highlights.add('def456');
  assert.equal(highlights.remove('abc123'), true);
  assert.equal(highlights.has('abc123'), false);
  assert.equal(highlights.has('def456'), true);
  assert.equal(viewer.entities.length, 1);
  assert.equal(highlights.remove('abc123'), false);
  highlights.clear();
  assert.equal(viewer.entities.length, 0);
  assert.equal(highlights.has('def456'), false);
});

test('hasAny reports whether any ring is live, so deselect paths can clear them', () => {
  const { flightState } = fixture();
  const highlights = createSelectionHighlights(flightState, 'flights');
  assert.equal(highlights.hasAny(), false);
  highlights.add('abc123');
  assert.equal(highlights.hasAny(), true);
  highlights.remove('abc123');
  assert.equal(highlights.hasAny(), false);
  highlights.add('abc123');
  highlights.clear();
  assert.equal(highlights.hasAny(), false);
});

/** Maps a highlight set back to its entities so tests can read position callbacks. */
function highlightsMapper(flightState) {
  const viewer = flightState._viewer;
  return (id) =>
    viewer.entities
      .find((entity) => entity.id.endsWith(`:${id}`))
      .position.getValue();
}

test('a destroyed viewer renders remove harmless', () => {
  const { flightState } = fixture();
  const highlights = createSelectionHighlights(flightState, 'flights');
  highlights.add('abc123');
  flightState._viewer.isDestroyed = () => true;
  assert.equal(highlights.remove('abc123'), true);
  assert.equal(highlights.has('abc123'), false);
});