import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../geo/index.js';
import { createFakeGroundHarness } from '../../testSupport/groundDisplayEngines.mjs';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import {
  createRendering,
  WILDLIFE_BADGE_ORDER,
  WILDLIFE_BADGE_SET_ID,
  WILDLIFE_CELL_SET_ID,
} from './rendering.js';
import { WILDLIFE_DENSITY_SET_ID } from './density.js';
import { wildlifeNearFarValue } from './display.js';
import { wildlifeGridCellId } from './gridViewport.js';
import { WILDLIFE_ATLAS_CELLS } from './sprites.js';
import { WILDLIFE_SCALE_BY_DISTANCE, ICONIC_TINTS } from './policy.js';

const NOW = Date.parse('2026-11-04T18:00:00Z');
const base = {
  stableId: 'synthetic:1',
  origin: 'inaturalist',
  lat: 47.6,
  lon: -122.3,
  iconic: 'Aves',
  observedAt: NOW - 60_000,
  quality: 'research',
  count: null,
  obscured: false,
  cell: null,
};
const degrees = (value) => (value * Math.PI) / 180;
const lonOf = (position) =>
  (geo.cartographic.fromCartesian(position).longitude * 180) / Math.PI;
const latOf = (position) =>
  (geo.cartographic.fromCartesian(position).latitude * 180) / Math.PI;

/** The real rendering on a fake engine above the fixture, 100 px a degree. */
function harness(rows = [base], { project, groundHarness, ...extra } = {}) {
  const engine = groundHarness?.engine ?? createFakeEngine();
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(base.lon, base.lat, 30_000),
  });
  engine.fake?.setPose({
    longitude: degrees(base.lon),
    latitude: degrees(base.lat),
    height: 30_000,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  let projections = 0;
  engine.projector.worldToWindow = (position) => {
    projections++;
    return project
      ? project(position)
      : {
          x: 100 + (lonOf(position) - base.lon) * 100,
          y: 100 - (latOf(position) - base.lat) * 100,
        };
  };
  let visible = true;
  engine.projector.horizonVisible = () => visible;
  const counts = { created: 0, removed: 0, cleared: 0, writes: [] };
  const state = {
    enabled: true,
    engine,
    rows: new Map(rows.map((row) => [row.stableId, row])),
    renderedRows: [],
    rowById: new Map(),
    pointById: new Map(),
    positions: new Map(),
    cells: [],
    taxa: 'all',
    selectedId: null,
    query: { visibleBoxes: [{ south: -90, west: -180, north: 90, east: 180 }] },
    band: 'cards',
  };
  const renders = [];
  const rendering = createRendering({
    state,
    services: {
      now: () => NOW,
      render: { governorRequestRender: (reason) => renders.push(reason) },
      ...extra,
    },
    parts: {
      selection: {
        clear() {
          state.selectedId = null;
        },
        refreshAmbient() {},
        publishSelected() {},
        refreshContexts() {},
      },
    },
  });
  rendering.init();
  // Count badge allocations and property writes as the bank makes them.
  const bank = state.badges;
  const { add, remove, removeAll, write } = bank;
  bank.add = (fields) => {
    counts.created += 1;
    return add.call(bank, fields);
  };
  bank.remove = (handle) => {
    counts.removed += 1;
    return remove.call(bank, handle);
  };
  bank.removeAll = () => {
    counts.cleared += 1;
    return removeAll.call(bank);
  };
  bank.write = (handle, fields) => {
    counts.writes.push(...Object.keys(fields));
    return write.call(bank, handle, fields);
  };
  rendering.activate();
  return {
    engine,
    state,
    rendering,
    counts,
    renders,
    badges: () => engine.fake.moverSet(WILDLIFE_BADGE_SET_ID),
    glow: () => engine.fake.moverSet(WILDLIFE_DENSITY_SET_ID),
    projections: () => projections,
    visible(value) {
      visible = value;
    },
    rows(next) {
      state.rows = new Map(next.map((row) => [row.stableId, row]));
    },
  };
}

test('badge sprites update in place, and unchanged refreshes write nothing', () => {
  const second = { ...base, stableId: 'synthetic:2', lon: -120 };
  const h = harness([base, second]);
  h.rendering.rebuild();
  const set = h.badges();
  const incumbent = h.state.pointById.get(base.stableId);
  assert.equal(h.counts.created, 2);
  assert.equal(set.options.kind, 'sprite');
  assert.equal(set.options.pickable, true);
  assert.equal(set.options.depthTest, 'always');
  assert.equal(set.options.order, WILDLIFE_BADGE_ORDER);
  assert.equal(set.store.count, 2);
  assert.equal(
    set.options.sprite.sizePx * set.options.sprite.scaleByDistance[3],
    12,
  );
  assert.deepEqual(
    [...set.options.sprite.scaleByDistance],
    WILDLIFE_SCALE_BY_DISTANCE,
  );
  assert.deepEqual(incumbent.color, [1, 1, 1, 1]);
  assert.equal(set.store.pickIds[incumbent.index], `wildlife:${base.stableId}`);
  assert.equal(
    set.store.cellKeys[set.store.cells[incumbent.index]],
    'bird',
    'the taxon picks its atlas cell',
  );
  h.counts.writes.length = 0;
  h.renders.length = 0;
  const commits = h.badges().commits;
  h.rows([{ ...second }, { ...base }]);
  assert.equal(h.rendering.rebuild(), false);
  assert.equal(h.rendering.cull(), false);
  assert.deepEqual(h.counts.writes, []);
  assert.deepEqual(h.renders, []);
  assert.equal(h.badges().commits, commits, 'nothing uploads');
  h.rows([{ ...base, lat: base.lat + 0.01 }, second]);
  assert.equal(h.rendering.rebuild(), true);
  assert.deepEqual(h.counts.writes, ['position']);
  assert.equal(h.badges().commits, commits + 1, 'one upload per rebuild');
  assert.equal(h.state.pointById.get(base.stableId), incumbent);
  const at = 3 * incumbent.index;
  assert.deepEqual(
    [...set.store.positions.subarray(at, at + 3)],
    [incumbent.position.x, incumbent.position.y, incumbent.position.z],
  );
  h.rows([
    { ...base, lat: base.lat + 0.01 },
    { ...second, stableId: 'synthetic:3' },
  ]);
  h.rendering.rebuild();
  assert.equal(h.counts.created, 3);
  assert.equal(h.counts.removed, 1);
  assert.equal(h.counts.cleared, 0);
  assert.equal(h.engine.frames.preRender.numberOfListeners, 1);
  h.rendering.destroy();
  assert.equal(h.badges(), undefined);
  assert.deepEqual(h.engine.movers.list(), []);
  assert.equal(h.state.pointById.size, 0);
  assert.equal(h.engine.frames.preRender.numberOfListeners, 0);
});

test('horizon changes write only changed visibility, with one governor request per batch', () => {
  const h = harness();
  h.rendering.rebuild();
  h.counts.writes.length = 0;
  h.renders.length = 0;
  h.visible(false);
  h.rendering.beginBatch();
  h.rendering.cull();
  h.rendering.requestRender('labels');
  h.rendering.endBatch();
  assert.deepEqual(h.counts.writes, ['show']);
  assert.equal(h.renders.length, 1);
  assert.equal(h.badges().store.shows[0], 0);
  h.rendering.cull();
  assert.deepEqual(h.counts.writes, ['show']);
  assert.equal(h.renders.length, 1);
  h.rendering.destroy();
});

test('badge pixels stay between 12 and 22 at near, mid and far heights, including selection', () => {
  const h = harness();
  h.rendering.rebuild();
  const wildlife = h.state.pointById.get(base.stableId);
  const { sizePx, scaleByDistance } = h.badges().options.sprite;
  for (const selectedId of [null, base.stableId]) {
    h.state.selectedId = selectedId;
    h.rendering.refreshSelection();
    for (const heightM of [
      0, 1000, 9000, 120_000, 400_000, 1_500_000, 8_000_000, 10_000_000,
    ]) {
      const pixels =
        sizePx *
        wildlife.scale *
        wildlifeNearFarValue(scaleByDistance, heightM);
      assert.ok(
        pixels >= 12 && pixels <= 22,
        `${heightM}m, selected=${!!selectedId}: ${pixels}px`,
      );
    }
  }
  assert.deepEqual(
    [...h.badges().store.colors.subarray(0, 4)],
    [1, 1, 1, 1],
    'keep the baked white glyph white',
  );
  h.rendering.destroy();
});

test('adjacent 28px bucket edges never overlap badges or erase sighting counts', () => {
  const rows = [27, 29, 56, 84].map((x, i) => ({
    ...base,
    stableId: `edge:${i}`,
    lon: base.lon + i * 0.01,
    x,
  }));
  const h = harness(rows, {
    project: (anchor) => ({
      x: rows.find((row) => Math.abs(row.lon - lonOf(anchor)) < 1e-7).x,
      y: 100,
    }),
  });
  h.rendering.rebuild();
  assert.equal(h.state.sightingCount, 4);
  assert.equal(
    h.state.pointById.size,
    4,
    'all occupied buckets retain their identities',
  );
  const visible = rows.filter(
    (row) => h.state.pointById.get(row.stableId).show,
  );
  assert.equal(visible.length, 3);
  for (let i = 0; i < visible.length; i++)
    for (let j = i + 1; j < visible.length; j++)
      assert.ok(Math.abs(visible[i].x - visible[j].x) >= 22);
  const shows = h.badges().store.shows;
  assert.equal(
    [...shows.subarray(0, 4)].filter(Boolean).length,
    3,
    'the engine draws the same three',
  );
  h.counts.writes.length = 0;
  h.renders.length = 0;
  h.rendering.rebuild();
  h.rendering.cull();
  assert.deepEqual(h.counts.writes, []);
  assert.deepEqual(h.renders, []);
  h.rendering.destroy();
});

test('only painted photo cards hide their anchored badges, with zero repeated visibility writes', () => {
  const h = harness();
  h.rendering.rebuild();
  const point = h.state.pointById.get(base.stableId);
  assert.equal(
    point.show,
    true,
    'a requested or loading card does not hide its badge',
  );
  h.counts.writes.length = 0;
  h.renders.length = 0;
  h.rendering.setPhotoCardVisibility(new Set([`sighting:${base.stableId}`]));
  assert.equal(point.show, false);
  assert.equal(h.badges().store.shows[point.index], 0);
  assert.deepEqual(h.counts.writes, ['show']);
  h.rendering.rebuild();
  h.rendering.cull();
  h.rendering.setPhotoCardVisibility(new Set([`sighting:${base.stableId}`]));
  assert.deepEqual(h.counts.writes, ['show']);
  assert.equal(h.renders.length, 1);
  h.rendering.setPhotoCardVisibility(new Set());
  assert.equal(
    point.show,
    true,
    'a card that no longer paints restores its badge',
  );
  assert.deepEqual(h.counts.writes, ['show', 'show']);
  h.rendering.destroy();
});

test('sampled fallback buckets allocate only representatives at every height, with zero idle writes', () => {
  for (const heightM of [1000, 7_000_000]) {
    const rows = ['a', 'b', 'c'].map((id, index) => ({
      ...base,
      stableId: `synthetic:${id}`,
      lon: base.lon + index * 0.01,
    }));
    const screens = new Map(
      rows.map((row) => [row.lon.toFixed(6), { x: 100, y: 100 }]),
    );
    const h = harness(rows, {
      project: (anchor) => screens.get(lonOf(anchor).toFixed(6)),
    });
    h.engine.fake.setPose({
      position: geo.cartesian3.fromDegrees(base.lon, base.lat, heightM),
    });
    h.rendering.rebuild();
    assert.equal(
      h.state.pointById.size,
      1,
      'same bucket reduction near and far',
    );
    assert.equal(h.counts.created, 1);
    screens.set(rows[2].lon.toFixed(6), { x: 200, y: 100 });
    assert.equal(h.rendering.cull(), false);
    h.rendering.rebuild(); // moveEnd recomputes buckets, never an idle frame.
    assert.equal(h.state.pointById.size, 2);
    assert.equal(h.counts.created, 2);
    h.counts.writes.length = 0;
    assert.equal(h.rendering.cull(), false);
    assert.equal(h.rendering.rebuild(), false);
    assert.deepEqual(h.counts.writes, []);
    assert.equal(
      h.engine.frames.preRender.numberOfListeners,
      1,
      'one shared surface observer',
    );
    h.rendering.destroy();
  }
});

test('UTFGrid creates a dedicated unpickable glow and observations alone create badges', () => {
  const h = harness([base], { project: () => ({ x: 100, y: 100 }) });
  h.engine.fake.setSize(280, 200);
  h.state.gridAvailable = true;
  h.state.gridCells = [1, 50, 2].map((cellCount, index) => ({
    id: wildlifeGridCellId(base.lat, base.lon + index * 0.01, 16),
    lat: base.lat,
    lon: base.lon + index * 0.01,
    cellCount,
  }));
  const before = h.projections();
  h.rendering.rebuild();
  const glow = h.glow();
  assert.ok(glow);
  assert.equal(glow.options.pickable, false);
  assert.ok(glow.options.order < WILDLIFE_BADGE_ORDER, 'glow under badges');
  assert.equal(glow.store.count, 3);
  assert.equal(h.engine.movers.list().length, 2);
  assert.deepEqual([...h.state.pointById.keys()], [base.stableId]);
  assert.deepEqual(h.state.renderedRows, [base]);
  assert.equal(h.state.sightingCount, 53);
  assert.equal(
    h.projections() - before,
    1,
    'only observations require screen projections',
  );
  assert.equal(
    h.engine.frames.preRender.numberOfListeners,
    2,
    'glow and the shared surface observer follow the camera',
  );
  const glowSet = h.rendering.density.collection.set;
  h.state.gridCells = [...h.state.gridCells].reverse();
  h.counts.writes.length = 0;
  assert.equal(h.rendering.rebuild(), false);
  assert.equal(h.rendering.density.collection.set, glowSet);
  assert.deepEqual(h.counts.writes, []);
  h.rendering.clear();
  assert.equal(glowSet.isDestroyed(), true);
  assert.equal(h.glow(), undefined);
  assert.equal(h.engine.frames.preRender.numberOfListeners, 1);
  assert.equal(h.badges().store.count, 0);
  h.rendering.destroy();
  assert.deepEqual(h.engine.movers.list(), []);
});

test('tile arrival or loss cannot replace a real observation with a grid badge', () => {
  const h = harness();
  // High enough that the continental kernel stays in front of the limb.
  h.engine.fake.setPose({
    position: geo.cartesian3.fromDegrees(base.lon, base.lat, 2_000_000),
  });
  h.rendering.rebuild();
  const badge = h.state.pointById.get(base.stableId);
  h.state.gridAvailable = true;
  h.state.gridCells = [
    {
      id: wildlifeGridCellId(base.lat, base.lon, 2),
      lat: base.lat,
      lon: base.lon,
      cellCount: 10_000,
    },
  ];
  h.rendering.rebuild();
  const glow = h.rendering.density.collection.set;
  assert.equal(h.state.sightingCount, 10_000);
  assert.equal(h.state.pointById.get(base.stableId), badge);
  h.state.gridAvailable = false;
  h.rendering.rebuild();
  assert.equal(h.state.pointById.get(base.stableId), badge);
  assert.equal(h.state.sightingCount, 1);
  assert.equal(glow.isDestroyed(), true);
  h.rendering.destroy();
});

test('a selected observation remains rendered outside the viewport and observation window after a zoom', () => {
  const selected = { ...base, observedAt: NOW - 49 * 3_600_000 };
  const h = harness([]);
  h.state.selectedId = selected.stableId;
  h.state.selectedRow = selected;
  h.state.query.visibleBoxes = [{ south: 0, west: 0, north: 1, east: 1 }];
  h.rendering.rebuild();
  assert.deepEqual(h.state.renderedRows, [selected]);
  assert.equal(h.state.rowById.get(selected.stableId), selected);
  assert.equal(h.state.pointById.has(selected.stableId), true);
  h.state.band = 'regional';
  h.engine.fake.setPose({
    position: geo.cartesian3.fromDegrees(base.lon, base.lat, 1_500_000),
  });
  h.rendering.rebuild();
  assert.equal(h.state.selectedId, selected.stableId);
  assert.equal(h.state.rowById.get(selected.stableId), selected);
  h.rendering.destroy();
});

for (const make of [createFakeGroundHarness]) {
  test(`privacy cells drape accent fills and outlines and release them (${make.name})`, () => {
    const cell = { south: 47.6, west: -122.4, north: 47.8, east: -122.2 };
    const groundHarness = make();
    const h = harness(
      [
        { ...base, obscured: true, cell },
        { ...base, stableId: 'duplicate', obscured: true, cell },
      ],
      { groundHarness, groundFloor: { cachedGroundFloor: () => 250 } },
    );
    h.rendering.rebuild();
    const set = groundHarness.set(WILDLIFE_CELL_SET_ID);
    assert.equal(set.options.kind, 'cell');
    assert.equal(set.options.drape, 'both');
    assert.equal(set.options.pickable, false);
    assert.equal(set.items.length, 1, 'same bounds and taxon share a cell');
    const item = set.items[0];
    assert.deepEqual(
      {
        south: item.south,
        west: item.west,
        north: item.north,
        east: item.east,
      },
      cell,
    );
    const tint = ICONIC_TINTS.Aves;
    const rgb = [1, 3, 5].map((offset) =>
      parseInt(tint.slice(offset, offset + 2), 16),
    );
    assert.deepEqual(
      item.fill.map((v) => Math.round(v * 255)),
      [...rgb, Math.round(0.25 * 255)],
    );
    assert.deepEqual(
      item.outline.color.map((v) => Math.round(v * 255)),
      [...rgb, Math.round(0.8 * 255)],
    );
    assert.equal(item.outline.widthPx, 2);
    assert.equal(item.pickId, undefined, 'picks pass through the cell');
    assert.equal(set.shown, true);
    assert.deepEqual(h.engine.lines.list(), [], 'ground owns the outline');
    if (groundHarness.cesium) {
      const { fills, lines } = groundHarness.primitives(WILDLIFE_CELL_SET_ID);
      assert.equal(fills.length, 1);
      assert.equal(lines.length, 1);
      assert.equal(fills[0].options.allowPicking, false);
      assert.equal(lines[0].options.allowPicking, false);
    }
    h.rendering.rebuild();
    assert.equal(
      groundHarness.set(WILDLIFE_CELL_SET_ID).commits,
      1,
      'unchanged cells keep their geometry',
    );
    h.visible(false);
    h.rendering.cull();
    assert.equal(
      groundHarness.set(WILDLIFE_CELL_SET_ID).shown,
      true,
      'ground handles horizon occlusion',
    );
    h.visible(true);
    h.state.band = 'regional';
    h.rendering.rebuild();
    assert.deepEqual(h.engine.ground.list(), [], 'wide views draw no cells');
    h.state.band = 'cards';
    h.rendering.rebuild();
    assert.equal(h.engine.ground.list().length, 1);
    h.rendering.destroy();
    assert.deepEqual(h.engine.ground.list(), []);
    groundHarness.destroy();
  });
}

test('font readiness swaps the atlas in place without badge recreation or position work', () => {
  const listeners = new Set();
  let ready = false;
  const plain = {
    url: 'data:image/svg+xml,plain',
    cells: WILDLIFE_ATLAS_CELLS,
  };
  const glyphs = {
    url: 'data:image/svg+xml,glyphs',
    cells: WILDLIFE_ATLAS_CELLS,
  };
  const badgeSprites = {
    atlas: () => (ready ? glyphs : plain),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const rows = [
    base,
    { ...base, stableId: 'synthetic:mammal', iconic: 'Mammalia', lon: -120 },
  ];
  const h = harness(rows, { badgeSprites });
  h.rendering.rebuild();
  assert.equal(h.badges().options.sprite.atlas, plain);
  const points = new Map(h.state.pointById);
  const cells = [...h.badges().store.cells.subarray(0, 2)];
  h.counts.writes.length = 0;
  h.renders.length = 0;
  ready = true;
  for (const listener of listeners) listener();
  assert.equal(h.badges().options.sprite.atlas, glyphs);
  assert.equal(h.badges().store.count, 2);
  assert.deepEqual([...h.badges().store.cells.subarray(0, 2)], cells);
  assert.equal(h.counts.created, 2);
  assert.equal(h.counts.removed, 0);
  assert.equal(h.counts.cleared, 0);
  assert.deepEqual(h.counts.writes, []);
  assert.equal(h.renders.length, 1);
  for (const [id, point] of points)
    assert.equal(h.state.pointById.get(id), point);
  h.counts.writes.length = 0;
  h.rows(rows.map((row) => ({ ...row, lat: row.lat + 0.01 })));
  h.rendering.rebuild();
  assert.deepEqual(h.counts.writes, ['position', 'position']);
  h.rendering.destroy();
  assert.equal(listeners.size, 0);
});

test('badges resample when the surface finishes loading, on the frame after', () => {
  let floor = 0;
  const h = harness([base], {
    groundFloor: { cachedGroundFloor: () => floor },
  });
  let loaded = false;
  h.engine.fake.script('tilesLoaded', () => loaded);
  h.rendering.activate();
  h.rendering.rebuild();
  const point = h.state.pointById.get(base.stableId);
  floor = 600;
  h.engine.fake.frame();
  assert.ok(
    Math.abs(geo.cartographic.fromCartesian(point.position).height) < 1e-3,
  );
  loaded = true;
  h.engine.fake.frame();
  assert.ok(
    Math.abs(geo.cartographic.fromCartesian(point.position).height - 600) <
      1e-3,
  );
  assert.equal(h.state.pointById.get(base.stableId), point);
  h.rendering.destroy();
});
