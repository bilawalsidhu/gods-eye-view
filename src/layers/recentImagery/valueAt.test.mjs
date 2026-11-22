import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentImageryLayer } from './index.js';
import { boxContains, candidateAtPoint, groupGranulesByDay } from './model.js';
import {
  BOX,
  candidate,
  fakeCatalog,
  fakeRenderer,
  fakeThumbnails,
  manualTimers,
  settle,
} from './testDoubles.mjs';

// Quantities keep number and unit together with a no-break space.
const plain = (text) => text.replace(/\s/gu, ' ');
const NOW = new Date('2026-09-21T15:00:00Z');

function fixture() {
  const catalog = fakeCatalog();
  const thumbnails = fakeThumbnails();
  const timers = manualTimers();
  const layer = createRecentImageryLayer({
    catalog,
    renderer: fakeRenderer(),
    thumbnails,
    host: () => ({ collection: {}, kind: 'globe' }),
    now: () => NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  layer.init({ camera: {} });
  return { layer, catalog, thumbnails };
}

test('boxContains and candidateAtPoint read degrees boxes and footprints', () => {
  assert.equal(boxContains(BOX, -97.75, 30.25), true);
  assert.equal(boxContains(BOX, -97.6, 30.25), false);
  assert.equal(
    boxContains({ west: 179, south: -1, east: -179, north: 1 }, -179.5, 0),
    true,
  );
  const footprinted = candidate('S30', '2026-09-18');
  assert.equal(candidateAtPoint(footprinted, -97.75, 30.25), null);
  footprinted.granules[0].footprint = [
    [-97.8, 30.2],
    [-97.75, 30.2],
    [-97.75, 30.3],
    [-97.8, 30.3],
  ];
  assert.ok(candidateAtPoint(footprinted, -97.78, 30.25));
  assert.equal(candidateAtPoint(footprinted, -97.72, 30.25), null);
});

test('getValueAt names the newest day covering a point inside the box', async () => {
  const { layer, catalog } = fixture();
  assert.equal(layer.getValueAt(30.25, -97.75), null, 'off');
  layer.enable();
  assert.deepEqual(layer.getValueAt(30.25, -97.75), {
    value: null,
    reason: 'No area chosen',
  });
  layer.setBox(BOX);
  assert.equal(layer.getValueAt(30.25, -97.75), null, 'still searching');
  // The newer Sentinel-2 day covers only the west half of the box.
  const west = candidate('S30', '2026-09-18', 12);
  west.granules[0].footprint = [
    [-97.8, 30.2],
    [-97.75, 30.2],
    [-97.75, 30.3],
    [-97.8, 30.3],
  ];
  const landsat = candidate('L30', '2026-09-16', 60);
  landsat.granules[0].footprint = [
    [-97.8, 30.2],
    [-97.7, 30.2],
    [-97.7, 30.3],
    [-97.8, 30.3],
  ];
  const unlocated = candidate('S30', '2026-09-20', 0);
  catalog.resolveLast([unlocated, west, landsat]);
  await settle();
  const inWest = layer.getValueAt(30.25, -97.78);
  assert.equal(inWest.value, 'Sep 18, 2026');
  assert.equal(plain(inWest.detail), 'Sentinel-2 · 30 m · 12% scene cloud');
  assert.equal(inWest.at, Date.parse('2026-09-18T17:14:00Z'));
  const inEast = layer.getValueAt(30.25, -97.72);
  assert.equal(inEast.value, 'Sep 16, 2026');
  assert.match(plain(inEast.detail), /^Landsat 8\/9 · 30 m · 60% scene cloud$/);
  assert.deepEqual(
    layer.getValueAt(31, -97.75),
    { value: null, reason: 'Outside the chosen area' },
    'outside the box',
  );
  layer.disable();
  assert.equal(layer.getValueAt(30.25, -97.78), null);
  layer.destroy();
});

test('getValueAt falls back to a daily overview only once it has pixels', async () => {
  const { layer, catalog, thumbnails } = fixture();
  layer.setSources({ viirs: true });
  layer.enable();
  layer.setBox(BOX);
  const unlocated = candidate('S30', '2026-09-21', 0);
  catalog.resolveLast([unlocated, candidate('VIIRS', '2026-09-21')]);
  await settle();
  assert.equal(layer.getValueAt(30.25, -97.75), null, 'availability unknown');
  thumbnails.setStatus('VIIRS:2026-09-21', 'present');
  const overview = layer.getValueAt(30.25, -97.75);
  assert.equal(overview.value, 'Sep 21, 2026');
  assert.equal(plain(overview.detail), 'Daily overview · 250 m');
  assert.equal(overview.at, Date.parse('2026-09-21T00:00:00Z'));
  layer.destroy();
});

test('getValueAt reports the acquisition and cloud of the granules at the point', async () => {
  const { layer, catalog } = fixture();
  const day = '2026-09-18';
  const [west, east] = [
    [-97.8, -97.75, 4, '10:14'],
    [-97.75, -97.7, 90, '14:14'],
  ].map(([left, right, cloud, end]) => ({
    product: 'S30',
    id: end,
    cloud,
    footprint: [
      [left, 30.2],
      [right, 30.2],
      [right, 30.3],
      [left, 30.3],
    ],
    timeStart: `${day}T${end.slice(0, 2)}:00:00Z`,
    timeEnd: `${day}T${end}:00Z`,
  }));
  layer.enable();
  layer.setBox(BOX);
  catalog.resolveLast(groupGranulesByDay([west, east]));
  await settle();
  const left = layer.getValueAt(30.25, -97.78);
  const right = layer.getValueAt(30.25, -97.72);
  assert.match(left.detail, /\b4% scene cloud/);
  assert.equal(left.at, Date.parse(west.timeEnd));
  assert.match(right.detail, /\b90% scene cloud/);
  assert.equal(right.at, Date.parse(east.timeEnd));
  layer.destroy();
});

test('getValueAt finds a dateline-crossing granule from either side', async () => {
  const { layer, catalog } = fixture();
  const crossing = candidate('S30', '2026-09-18');
  crossing.granules[0].footprint = [
    [179.7, 51.7],
    [-179.7, 51.7],
    [-179.7, 52.1],
    [179.7, 52.1],
  ];
  layer.enable();
  for (const lon of [179.85, -179.85]) {
    layer.setBox({ west: lon - 0.1, south: 51.8, east: lon + 0.1, north: 52 });
    catalog.resolveLast([crossing]);
    await settle();
    assert.equal(
      layer.getValueAt(51.9, lon)?.at,
      Date.parse(crossing.timeRange.end),
    );
  }
  assert.equal(candidateAtPoint(crossing, 0, 51.9), null);
  layer.destroy();
});
