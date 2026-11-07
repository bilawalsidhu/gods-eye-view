import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDegrees } from '../geo/ellipsoid.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  _clearBikeshareSelectionForTest,
  _selectBikeshareStationForTest,
  _setBikeshareSelectionStateForTest,
  createBikeshareSelectedOverlayEntry,
} from './bikeshare.js';

function makeRecord() {
  return {
    stationId: '3790',
    stationName: 'Congress & 6th',
    bikesAvailable: 7,
    docksAvailable: 4,
    capacity: 11,
    isInstalled: true,
    isRenting: false,
    isReturning: true,
    key: 'austin-capmetro:3790',
    position: fromDegrees(-97.7431, 30.2672, 2),
    pixelSize: 8,
    color: [0, 1, 0, 1],
  };
}

test('selected bikeshare entry preserves source copy and protected-lane policy', () => {
  const record = makeRecord();
  const entry = createBikeshareSelectedOverlayEntry('austin-capmetro:3790', record);
  assert.equal(entry.position, record.position);
  assert.equal(entry.title, 'Congress & 6th');
  assert.deepEqual(entry.details, [
    '🚲 7 avail · 4 docks · 11 cap',
    '⚠️ Not renting',
  ]);
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
});

test('real station select/clear path publishes one card and draws no native label', () => {
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const key = 'austin-capmetro:3790';
  const record = makeRecord();
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  _setBikeshareSelectionStateForTest({ viewer, key, record, overlayHost });
  const live = (suffix) =>
    [...draw.sets.values()].find((set) => !set.disposed && set.spec.id.endsWith(suffix));
  const stations = live(':stations');
  const selected = live(':selected');
  try {
    _selectBikeshareStationForTest(key);
    assert.equal(stations.items.get(key).show, false, 'the station’s own dot is hidden');
    assert.equal(selected.items.size, 1, 'one highlight dot replaces it');
    const [highlight] = selected.items.values();
    assert.equal(highlight.pos, record.position);
    assert.deepEqual(highlight.color, [0, 1, 1, 1], 'cyan');
    assert.equal(highlight.pixelSize, 14);
    assert.equal(highlight.disableDepthTest, Infinity);

    const publication = calls.find(([type]) => type === 'entries');
    assert.ok(publication);
    assert.equal(publication[1], 'bikeshare-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].position, record.position);
    assert.deepEqual(publication[3], BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS);

    _clearBikeshareSelectionForTest();
    assert.equal(stations.items.get(key).show, true);
    assert.equal(selected.items.size, 0);
    assert.deepEqual(calls.at(-1), ['clear', 'bikeshare-selected']);
  } finally {
    _clearBikeshareSelectionForTest();
    unbind();
  }
});
