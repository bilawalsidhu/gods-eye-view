import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  MESHCORE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  _clearMeshcoreSelectionForTest,
  _selectMeshcoreNodeForTest,
  _setMeshcoreSelectionStateForTest,
  createMeshcoreSelectedOverlayEntry,
  getNodeUpdateStatus,
  statusToColor,
  typeToPixelSize,
} from './meshcore.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRecord(overrides = {}) {
  return {
    id: '01000001536ea2117cf0050aace872f1cce17c4c06c55582fa0b67c87c31b993',
    type: 2,
    name: 'Kakadu 1 apolut net',
    status: 'recent',
    updatedAt: Date.parse('2026-09-12T21:42:29.000Z'),
    source: 'uploader',
    freq: 869.618,
    bandwidth: 62.5,
    spreadingFactor: 8,
    codingRate: 8,
    point: {
      position: Cesium.Cartesian3.fromDegrees(11.521, 48.0559, 15),
      show: true,
    },
    ...overrides,
  };
}

test('getNodeUpdateStatus buckets by freshness, only for uploader-sourced nodes', () => {
  const now = Date.parse('2026-09-13T00:00:00.000Z');
  assert.equal(
    getNodeUpdateStatus({ source: 'uploader', updatedAt: now - DAY_MS }, now),
    'recent',
  );
  assert.equal(
    getNodeUpdateStatus(
      { source: 'uploader', updatedAt: now - 7 * DAY_MS },
      now,
    ),
    'stale',
  );
  assert.equal(
    getNodeUpdateStatus(
      { source: 'uploader', updatedAt: now - 15 * DAY_MS },
      now,
    ),
    'old',
  );
  assert.equal(
    getNodeUpdateStatus(
      { source: 'uploader', updatedAt: now - 25 * DAY_MS },
      now,
    ),
    'extinct',
  );
  // Manually added (app-sourced) nodes never get a freshness color, regardless of age.
  assert.equal(
    getNodeUpdateStatus({ source: 'app', updatedAt: now - DAY_MS }, now),
    'none',
  );
  // Missing/invalid updatedAt also falls back to 'none'.
  assert.equal(
    getNodeUpdateStatus({ source: 'uploader', updatedAt: null }, now),
    'none',
  );
});

test('statusToColor and typeToPixelSize cover every known bucket', () => {
  for (const status of [
    'recent',
    'stale',
    'old',
    'extinct',
    'none',
    'unknown',
  ]) {
    assert.ok(statusToColor(status) instanceof Cesium.Color);
  }
  assert.equal(
    typeToPixelSize(2),
    6,
    'repeaters render larger (infrastructure)',
  );
  assert.equal(typeToPixelSize(1), 4, 'clients render smaller');
  assert.equal(
    typeToPixelSize(999),
    4,
    'unknown type falls back to the default size',
  );
});

test('selected meshcore entry preserves source copy and protected-lane policy', () => {
  const record = makeRecord();
  const entry = createMeshcoreSelectedOverlayEntry(record.id, record);
  assert.equal(entry.position, record.point.position);
  assert.equal(entry.title, 'Kakadu 1 apolut net');
  assert.deepEqual(entry.details, [
    '📡 Repeater · Recent (<5d)',
    '869.618 MHz · 62.5 kHz BW · SF8 · CR8',
    `Last seen ${new Date(record.updatedAt).toLocaleString()}`,
    `Key ${record.id.slice(0, 16)}…`,
  ]);
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
});

test('unnamed nodes fall back to a type + truncated-key label', () => {
  const record = makeRecord({ name: null, id: 'abcdef0123456789fedcba' });
  const entry = createMeshcoreSelectedOverlayEntry(record.id, record);
  assert.equal(entry.title, 'Repeater abcdef01');
});

test('real node select/clear path publishes one card and creates no native label graphic', () => {
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const record = makeRecord();
  const viewer = { entities: new Cesium.EntityCollection() };
  _setMeshcoreSelectionStateForTest({
    viewer,
    key: record.id,
    record,
    overlayHost,
  });
  try {
    _selectMeshcoreNodeForTest(record.id);
    assert.equal(
      record.point.show,
      false,
      'base point primitive is hidden while selected',
    );
    assert.equal(
      viewer.entities.values.length,
      1,
      'runtime guard requires a real selected entity',
    );
    assert.equal(viewer.entities.values[0].label, undefined);
    assert.ok(
      viewer.entities.values[0].point,
      'selected point highlight remains native',
    );

    const publication = calls.find(([type]) => type === 'entries');
    assert.ok(publication);
    assert.equal(publication[1], 'meshcore-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].position, record.point.position);
    assert.deepEqual(publication[3], MESHCORE_SELECTED_OVERLAY_SOURCE_OPTIONS);

    _clearMeshcoreSelectionForTest();
    assert.equal(record.point.show, true);
    assert.equal(viewer.entities.values.length, 0);
    assert.deepEqual(calls.at(-1), ['clear', 'meshcore-selected']);
  } finally {
    _clearMeshcoreSelectionForTest();
  }
});
