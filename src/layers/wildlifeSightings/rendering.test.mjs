import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createRendering } from './rendering.js';
import { nearFarScalarValueAtDistance } from '../../data/focusDeemphasis.js';
import { wildlifeGridCellId } from './gridViewport.js';
import {
  WILDLIFE_GROUND_READY_MAX_CHECKS,
  WILDLIFE_SCALE_BY_DISTANCE,
} from './policy.js';

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

function event() {
  const listeners = new Set();
  return {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}

function harness(rows = [base], extra = {}) {
  const counts = {
    collections: 0,
    created: 0,
    removed: 0,
    cleared: 0,
    writes: [],
  };
  const tracked = new Set([
    'position',
    'image',
    'color',
    'scale',
    'show',
    'width',
    'height',
    'scaleByDistance',
  ]);
  class BillboardCollection extends Cesium.BillboardCollection {
    constructor() {
      super();
      counts.collections += 1;
    }
    add(options) {
      counts.created += 1;
      const point = super.add(options);
      return new Proxy(point, {
        get: (target, key) => Reflect.get(target, key, target),
        set(target, key, value) {
          if (tracked.has(key)) counts.writes.push(key);
          return Reflect.set(target, key, value, target);
        },
      });
    }
    remove(point) {
      counts.removed += 1;
      return super.remove(point);
    }
    removeAll() {
      counts.cleared += 1;
      return super.removeAll();
    }
  }
  class GroundBatch {
    constructor(options) {
      Object.assign(this, options);
      this.ready = false;
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed === true;
    }
  }
  function primitives() {
    const values = [];
    return {
      values,
      get length() {
        return values.length;
      },
      get: (i) => values[i],
      add(primitive) {
        values.push(primitive);
        return primitive;
      },
      remove(primitive) {
        const i = values.indexOf(primitive);
        if (i < 0) return false;
        values.splice(i, 1);
        primitive.destroy();
        return true;
      },
    };
  }
  const postRender = event();
  const terrain = event();
  const tileProgress = event();
  const scene = {
    primitives: primitives(),
    groundPrimitives: primitives(),
    postRender,
    terrainProviderChanged: terrain,
    globe: {
      terrainProviderChanged: terrain,
      tileLoadProgressEvent: tileProgress,
    },
  };
  const state = {
    enabled: true,
    viewer: { scene, camera: { positionWC: {} } },
    rows: new Map(rows.map((row) => [row.stableId, row])),
    renderedRows: [],
    rowById: new Map(),
    pointById: new Map(),
    positions: new Map(),
    cells: [],
    staging: null,
    taxa: 'all',
    selectedId: null,
    query: { visibleBoxes: [{ south: -90, west: -180, north: 90, east: 180 }] },
    band: 'cards',
  };
  const renders = [];
  let visible = true;
  const registration = new Set();
  const rendering = createRendering({
    state,
    services: {
      now: () => NOW,
      cesium: {
        ...Cesium,
        BillboardCollection,
        GroundPrimitive: GroundBatch,
        GroundPolylinePrimitive: GroundBatch,
      },
      occluderFactory: () => ({ isPointVisible: () => visible }),
      render: { governorRequestRender: (reason) => renders.push(reason) },
      sprites: {
        registerSpriteCollection: (_id, value) => registration.add(value),
        unregisterSpriteCollection: (_id, value) => registration.delete(value),
      },
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
  rendering.activate();
  return {
    state,
    scene,
    rendering,
    counts,
    renders,
    postRender,
    terrain,
    tileProgress,
    registration,
    visible(value) {
      visible = value;
    },
    rows(next) {
      state.rows = new Map(next.map((row) => [row.stableId, row]));
    },
  };
}

test('real Cesium billboard values update in place, and unchanged refreshes write nothing', () => {
  const second = { ...base, stableId: 'synthetic:2', lon: -120 };
  const h = harness([base, second]);
  h.rendering.rebuild();
  const collection = h.state.points;
  const incumbent = h.state.pointById.get(base.stableId);
  assert.equal(h.counts.collections, 1);
  assert.equal(h.counts.created, 2);
  assert.equal(incumbent.width * incumbent.scaleByDistance.farValue, 12);
  assert.deepEqual(
    incumbent.scaleByDistance,
    new Cesium.NearFarScalar(...WILDLIFE_SCALE_BY_DISTANCE),
  );
  assert.equal(incumbent.color.alpha, 1);
  h.counts.writes.length = 0;
  h.renders.length = 0;
  h.rows([{ ...second }, { ...base }]);
  assert.equal(h.rendering.rebuild(), false);
  assert.equal(h.rendering.cull(), false);
  assert.deepEqual(h.counts.writes, []);
  assert.deepEqual(h.renders, []);
  h.rows([{ ...base, lat: base.lat + 0.01 }, second]);
  assert.equal(h.rendering.rebuild(), true);
  assert.deepEqual(h.counts.writes, ['position']);
  assert.equal(h.state.pointById.get(base.stableId), incumbent);
  assert.equal(h.state.points, collection);
  h.rows([
    { ...base, lat: base.lat + 0.01 },
    { ...second, stableId: 'synthetic:3' },
  ]);
  h.rendering.rebuild();
  assert.equal(h.counts.created, 3);
  assert.equal(h.counts.removed, 1);
  assert.equal(h.counts.cleared, 0);
  h.rendering.destroy();
  assert.equal(h.registration.size, 0);
  assert.equal(h.scene.primitives.length, 0);
  assert.equal(h.state.pointById.size, 0);
  assert.equal(h.terrain.size, 0);
  assert.equal(h.tileProgress.size, 0);
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
  h.rendering.cull();
  assert.deepEqual(h.counts.writes, ['show']);
  assert.equal(h.renders.length, 1);
  h.rendering.destroy();
});

test('badge pixels stay between 12 and 22 at near, mid and far heights, including selection', () => {
  const h = harness();
  h.rendering.rebuild();
  const wildlife = h.state.pointById.get(base.stableId);
  for (const selectedId of [null, base.stableId]) {
    h.state.selectedId = selectedId;
    h.rendering.refreshSelection();
    for (const heightM of [
      0, 1000, 9000, 120_000, 400_000, 1_500_000, 8_000_000, 10_000_000,
    ]) {
      const pixels =
        wildlife.width *
        wildlife.scale *
        nearFarScalarValueAtDistance(wildlife.scaleByDistance, heightM);
      assert.ok(
        pixels >= 12 && pixels <= 22,
        `${heightM}m, selected=${!!selectedId}: ${pixels}px`,
      );
    }
  }
  assert.deepEqual(
    wildlife.color,
    Cesium.Color.WHITE,
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
    project: (_scene, anchor) => {
      const lon = Cesium.Math.toDegrees(
        Cesium.Cartographic.fromCartesian(anchor).longitude,
      );
      return {
        x: rows.find((row) => Math.abs(row.lon - lon) < 1e-7).x,
        y: 100,
      };
    },
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
      project: (_scene, anchor) => {
        const lon = Cesium.Math.toDegrees(
          Cesium.Cartographic.fromCartesian(anchor).longitude,
        );
        return screens.get(lon.toFixed(6));
      },
    });
    h.state.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      base.lon,
      base.lat,
      heightM,
    );
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
    assert.equal(h.postRender.size, 0);
    h.rendering.destroy();
  }
});

test('UTFGrid creates a dedicated unpickable glow and observations alone create badges', () => {
  let projections = 0;
  const h = harness([base], {
    project() {
      projections++;
      return { x: 100, y: 100 };
    },
  });
  h.scene.canvas = { clientWidth: 280, clientHeight: 200 };
  h.state.gridAvailable = true;
  h.state.gridCells = [1, 50, 2].map((cellCount, index) => ({
    id: wildlifeGridCellId(base.lat, base.lon + index * 0.01, 16),
    lat: base.lat,
    lon: base.lon + index * 0.01,
    cellCount,
  }));
  h.rendering.rebuild();
  const glow = h.rendering.density.collection;
  assert.ok(glow);
  assert.equal(glow.allowPicking, false);
  assert.equal(glow.length, 3);
  assert.equal(h.scene.primitives.length, 2);
  assert.deepEqual([...h.state.pointById.keys()], [base.stableId]);
  assert.deepEqual(h.state.renderedRows, [base]);
  assert.equal(h.state.sightingCount, 53);
  assert.equal(projections, 1, 'only observations require screen projections');
  assert.equal(h.postRender.size, 0, 'density installs no frame listener');
  h.state.gridCells = [...h.state.gridCells].reverse();
  h.counts.writes.length = 0;
  assert.equal(h.rendering.rebuild(), false);
  assert.equal(h.rendering.density.collection, glow);
  assert.deepEqual(h.counts.writes, []);
  h.rendering.clear();
  assert.equal(glow.isDestroyed(), true);
  assert.equal(h.scene.primitives.length, 1);
  assert.equal(h.state.points.length, 0);
  h.rendering.destroy();
  assert.equal(h.scene.primitives.length, 0);
});

test('tile arrival or loss cannot replace a real observation with a grid badge', () => {
  const h = harness();
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
  const glow = h.rendering.density.collection;
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
  h.state.viewer.camera.positionCartographic = { height: 1_500_000 };
  h.rendering.rebuild();
  assert.equal(h.state.selectedId, selected.stableId);
  assert.equal(h.state.rowById.get(selected.stableId), selected);
  h.rendering.destroy();
});

test('privacy ground staging has a bounded readiness listener and complete teardown', () => {
  const h = harness([
    {
      ...base,
      obscured: true,
      cell: { south: 47.6, west: -122.4, north: 47.8, east: -122.2 },
    },
  ]);
  h.rendering.rebuild();
  assert.equal(h.postRender.size, 1);
  assert.equal(h.scene.groundPrimitives.length, 2);
  for (let i = 0; i < WILDLIFE_GROUND_READY_MAX_CHECKS; i++)
    h.postRender.emit();
  assert.equal(h.postRender.size, 0);
  assert.equal(h.state.staging, null);
  assert.equal(h.scene.groundPrimitives.length, 0);
  h.rendering.destroy();
  assert.equal(h.postRender.size, 0);
});

test('font readiness swaps images in place without billboard recreation or position work', () => {
  const listeners = new Set();
  let ready = false;
  const badgeSprites = {
    get: (group) =>
      `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"><circle r="${ready ? 9 : 8}" data-group="${group}"/></svg>`)}`,
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
  const collection = h.state.points;
  const points = new Map(h.state.pointById);
  const before = new Map([...points].map(([id, point]) => [id, point.image]));
  h.counts.writes.length = 0;
  h.renders.length = 0;
  ready = true;
  for (const listener of listeners) listener();
  assert.equal(h.state.points, collection);
  assert.equal(h.counts.created, 2);
  assert.equal(h.counts.removed, 0);
  assert.equal(h.counts.cleared, 0);
  assert.deepEqual(h.counts.writes, ['image', 'image']);
  assert.equal(h.renders.length, 1);
  for (const [id, point] of points) {
    assert.equal(h.state.pointById.get(id), point);
    assert.notEqual(point.image, before.get(id));
  }
  h.counts.writes.length = 0;
  h.rows(rows.map((row) => ({ ...row, lat: row.lat + 0.01 })));
  h.rendering.rebuild();
  assert.deepEqual(h.counts.writes, ['position', 'position']);
  h.rendering.destroy();
  assert.equal(listeners.size, 0);
});
