import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wildlifeIconicGroup,
  rowInWildlifeBoxes,
  buildWildlifeIconModel,
} from './model.js';
import { ICONIC_TINTS, ICONIC_LEGEND_ORDER, TAXA_PRESETS } from './policy.js';

const row = {
  stableId: 'inat:1',
  lat: 47.6,
  lon: -122.3,
  cell: null,
  iconic: 'Aves',
  quality: 'research',
  count: null,
  obscured: false,
};

test('unknown groups are slate and molluscs fold into other animals', () => {
  assert.equal(wildlifeIconicGroup('Mollusca'), 'Animalia');
  for (const iconic of ['Unknown', 'Protozoa', 'Chromista', undefined])
    assert.equal(wildlifeIconicGroup(iconic), 'Unknown');
  assert.equal(ICONIC_TINTS.Unknown, '#9aa7b3');
  assert.equal(ICONIC_LEGEND_ORDER.at(-1), 'Unknown');
  assert.equal(ICONIC_LEGEND_ORDER.length, 11);
  assert.equal(TAXA_PRESETS.length, 6);
  assert.equal(TAXA_PRESETS.filter((item) => item.label === 'ALL').length, 1);
  assert.equal(Object.isFrozen(ICONIC_TINTS), true);
  assert.equal(Object.isFrozen(TAXA_PRESETS[0]), true);
});

test('view filtering includes padding and both sides of the antimeridian', () => {
  const boxes = [{ south: 47, west: -123, north: 48, east: -122 }];
  assert.equal(rowInWildlifeBoxes(row, boxes), true);
  assert.equal(rowInWildlifeBoxes({ ...row, lat: 48.2 }, boxes), true);
  assert.equal(rowInWildlifeBoxes({ ...row, lat: 48.4 }, boxes), false);
  assert.equal(
    rowInWildlifeBoxes({ ...row, lat: 10.5, lon: -179.9 }, [
      { south: 10, west: 179, north: 11, east: 180 },
    ]),
    true,
  );
  assert.equal(rowInWildlifeBoxes(row, null), true);
  assert.equal(rowInWildlifeBoxes(row, []), false);
});

test('grid cells never enter the observation icon model', () => {
  const cells = [
    { id: 'grid:2/0/0:1:1', lat: 47.6, lon: -122.3, cellCount: 999 },
  ];
  assert.deepEqual(buildWildlifeIconModel({ rows: cells }).rows, []);
  assert.deepEqual(buildWildlifeIconModel({ rows: [...cells, row] }).rows, [
    row,
  ]);
});

test('screen buckets retain incumbent photos at their real sighting positions', () => {
  const incumbent = {
    ...row,
    commonName: 'Incumbent',
    photo: { square: 'synthetic.jpg' },
  };
  const challenger = {
    ...row,
    stableId: 'inat:2',
    commonName: 'Challenger',
    observedAt: Date.UTC(2026, 10, 4),
  };
  const distant = { ...row, stableId: 'inat:3', lon: row.lon + 1 };
  const model = buildWildlifeIconModel({
    rows: [challenger, incumbent, distant],
    preferredIds: [incumbent.stableId],
    projectRow: (item) => ({ x: (item.lon - row.lon) * 28 + 14, y: 14 }),
  });
  assert.deepEqual(model.rows, [incumbent, distant]);
  assert.equal(model.sightingCount, 3);
  assert.equal(model.rows[0].photo, incumbent.photo);
});

test('visible observation counts precede per-area and global caps', () => {
  const rows = Array.from({ length: 6000 }, (_, i) => ({
    ...row,
    stableId: `inat:${i}`,
    lon: -160 + i * 0.01,
  }));
  let projections = 0;
  const model = buildWildlifeIconModel({
    rows,
    projectRow(item) {
      projections++;
      return { x: (item.lon + 160) * 5600 + 14, y: 14 };
    },
  });
  assert.equal(projections, 6000);
  assert.equal(model.rows.length, 5000);
  assert.equal(model.totalPoints, 6000);
  assert.equal(model.saturated, true);
  assert.equal(model.sightingCount, 6000);
});

test('selected observations win their bucket and survive a sample, viewport and projection change', () => {
  const selected = { ...row, commonName: 'Selected sighting' };
  const challenger = {
    ...row,
    stableId: 'inat:2',
    commonName: 'Newer',
    observedAt: Date.UTC(2026, 10, 4),
  };
  const input = {
    selectedId: row.stableId,
    selectedRow: selected,
    rows: [challenger],
    limit: 1,
  };
  assert.deepEqual(
    buildWildlifeIconModel({ ...input, projectRow: () => ({ x: 14, y: 14 }) })
      .rows,
    [selected],
  );
  const offscreen = buildWildlifeIconModel({
    ...input,
    boxes: [{ south: 0, west: 0, north: 1, east: 1 }],
    projectRow: () => null,
  });
  assert.deepEqual(offscreen.rows, [selected]);
  assert.equal(
    offscreen.sightingCount,
    0,
    'an offscreen pin is not a visible observation',
  );
});

test('observation reduction is stable under input order, selected priority and visible filtering', () => {
  const named = { ...row, stableId: 'inat:2', commonName: 'Known bird' };
  const outside = { ...row, stableId: 'inat:3', lat: 0 };
  const input = {
    boxes: [{ south: 47, west: -123, north: 48, east: -122 }],
    limit: 1,
  };
  const model = buildWildlifeIconModel({
    ...input,
    rows: [row, named, outside],
  });
  assert.equal(model.saturated, true);
  assert.equal(model.totalPoints, 2);
  assert.equal(model.sightingCount, 2);
  assert.deepEqual(model.rows, [named]);
  assert.deepEqual(
    buildWildlifeIconModel({ ...input, rows: [outside, named, row] }),
    model,
  );
  assert.deepEqual(
    buildWildlifeIconModel({
      ...input,
      rows: [named, row],
      selectedId: row.stableId,
    }).rows,
    [row],
  );
});
