import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { wildlifeGridCellBounds } from './gridViewport.js';
import {
  createWildlifeDensity,
  wildlifeDensityIntensity,
  wildlifeDensityRanks,
  wildlifeDensityKernel,
  WILDLIFE_DENSITY_MAX_ALPHA,
  WILDLIFE_DENSITY_NEAR_FADE,
  WILDLIFE_DENSITY_OVERLAP,
} from './density.js';
import { WILDLIFE_WORK_UNIT } from './performance.js';

function cell(column, count = 1, options = {}) {
  const id = `grid:3/4/2:31:${column * 2 + 1}`;
  const bounds = wildlifeGridCellBounds(id);
  return {
    id,
    lat: (bounds.south + bounds.north) / 2,
    lon: (bounds.west + bounds.east) / 2,
    cellCount: count,
    ...options,
  };
}

function harness({ documentStyle = 'normal', camera = {} } = {}) {
  const counts = { positions: 0, writes: 0, created: 0, updates: 0 };
  class BillboardCollection extends Cesium.BillboardCollection {
    add(options) {
      counts.created++;
      const point = super.add(options);
      return new Proxy(point, {
        get: (target, key) => Reflect.get(target, key, target),
        set(target, key, value) {
          counts.writes++;
          return Reflect.set(target, key, value, target);
        },
      });
    }
    update() {
      counts.updates++;
    }
  }
  const primitives = new Cesium.PrimitiveCollection();
  let handle = 0;
  const timers = new Map();
  const idle = new Map();
  const renders = [];
  const listeners = new Map();
  const eventTarget = {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    emit(name, detail) {
      for (const listener of listeners.get(name) || []) listener({ detail });
    },
  };
  const density = createWildlifeDensity({
    cesium: { ...Cesium, BillboardCollection },
    viewer: { scene: { primitives }, camera },
    positionForCell(row) {
      counts.positions++;
      return Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
    },
    requestRender: (reason) => renders.push(reason),
    setTimer(fn) {
      timers.set(++handle, fn);
      return handle;
    },
    clearTimer: (id) => timers.delete(id),
    requestIdle(fn) {
      idle.set(++handle, fn);
      return handle;
    },
    cancelIdle: (id) => idle.delete(id),
    eventTarget,
    documentRef: { documentElement: { dataset: { gevStyle: documentStyle } } },
  });
  function flushIdle() {
    while (idle.size) {
      const [id, fn] = idle.entries().next().value;
      idle.delete(id);
      fn();
    }
  }
  function fadeStep() {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
    flushIdle();
  }
  return {
    density,
    primitives,
    counts,
    renders,
    timers,
    idle,
    listeners,
    eventTarget,
    flushIdle,
    fadeStep,
    settle() {
      while (timers.size || idle.size) {
        fadeStep();
        flushIdle();
      }
    },
  };
}

test('density intensity rises with view rank, is bounded, and leaves no background for zero data', () => {
  for (const empty of [0, -1, null, undefined, NaN, Infinity])
    assert.equal(wildlifeDensityIntensity(empty), 0);
  const ranks = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const values = ranks.map(wildlifeDensityIntensity);
  assert.ok(values[0] > 0, 'the sparsest cell still leaves a trace');
  assert.ok(values[0] < 0.02, 'sparse cells stay a trace, not a haze');
  for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1]);
  assert.equal(values.at(-1), WILDLIFE_DENSITY_MAX_ALPHA);
  assert.ok(
    values[3] < WILDLIFE_DENSITY_MAX_ALPHA / 3,
    'a median cell is well below a hotspot',
  );
});

test('density ranks are relative to the view, so hotspots stay distinct at any zoom', () => {
  const cells = (counts) => counts.map((cellCount) => ({ cellCount }));
  const near = wildlifeDensityRanks(cells([1, 2, 3, 40]));
  const far = wildlifeDensityRanks(cells([100, 200, 300, 4000]));
  assert.equal(near(40), 1);
  assert.equal(far(4000), 1, 'the top cell is brightest whatever its count');
  assert.equal(near(1), far(100), 'the same position ranks the same');
  assert.equal(wildlifeDensityRanks(cells([0, -1]))(5), 0);
  assert.equal(wildlifeDensityRanks([])(5), 0);
});

test('an empty density snapshot creates no glow', () => {
  const h = harness();
  assert.deepEqual(h.density.update([]), {
    sightingCount: 0,
    changed: false,
    size: 0,
  });
  h.density.update([
    cell(0, 0),
    cell(1, -1),
    cell(2, 0.5),
    cell(3, 1, { id: 'invalid' }),
  ]);
  assert.equal(h.density.collection, null);
  assert.equal(h.primitives.length, 0);
  assert.equal(h.timers.size, 0);
  h.density.destroy();
});

test('uniform occupied cells make a continuous field with no visible lattice', () => {
  assert.ok(WILDLIFE_DENSITY_OVERLAP >= 1.5);
  assert.equal(wildlifeDensityKernel(0), 1);
  assert.equal(wildlifeDensityKernel(WILDLIFE_DENSITY_OVERLAP / 2), 0);
  const samples = [];
  for (let x = 0; x < 1; x += 0.1)
    for (let y = 0; y < 1; y += 0.1) {
      let value = 0;
      for (let dx = -3; dx <= 3; dx++)
        for (let dy = -3; dy <= 3; dy++)
          value += wildlifeDensityKernel(Math.hypot(x - dx, y - dy));
      samples.push(value);
    }
  const modulation =
    (Math.max(...samples) - Math.min(...samples)) / Math.max(...samples);
  assert.ok(modulation < 0.007, `${(100 * modulation).toFixed(3)}% modulation`);
});

test('each glow kernel fades on the GPU as the camera comes inside it, scaled to its own width', () => {
  const h = harness();
  h.density.update([cell(0, 4), cell(1, 9)]);
  const collection = h.density.collection;
  assert.equal(collection.length, 2);
  for (let i = 0; i < collection.length; i++) {
    const point = collection.get(i);
    const width = point.scale * point.width;
    const fade = point.translucencyByDistance;
    assert.ok(fade, 'no screen-filling kernel when zoomed inside it');
    assert.ok(
      Math.abs(fade.near - width * WILDLIFE_DENSITY_NEAR_FADE.near) < 1e-6,
    );
    assert.equal(fade.nearValue, 0);
    assert.ok(
      Math.abs(fade.far - width * WILDLIFE_DENSITY_NEAR_FADE.far) < 1e-6,
    );
    assert.equal(fade.farValue, 1);
  }
  h.density.destroy();
});

test('occupied grid counts produce unlabelled world-sized glow billboards that never enter Cesium picking', () => {
  const h = harness();
  const rows = [cell(0, 1), cell(1, 100), cell(2, 1000000)];
  const result = h.density.update(rows);
  assert.equal(result.sightingCount, 1000101);
  assert.equal(h.primitives.length, 1);
  const collection = h.density.collection;
  assert.equal(collection.allowPicking, false);
  assert.equal(collection.length, 3);
  const first = collection.get(0);
  assert.equal(
    first.id,
    undefined,
    'density has no sighting identity or pick payload',
  );
  assert.equal(first.sizeInMeters, true);
  assert.equal(first.scaleByDistance, undefined);
  assert.match(decodeURIComponent(first.image), /radialGradient/);
  assert.doesNotMatch(decodeURIComponent(first.image), /text|badge|raven/);
  const bounds = wildlifeGridCellBounds(rows[0].id);
  const logicalHeight =
    (((bounds.north - bounds.south) * Math.PI) / 180) * 6378137;
  assert.ok(first.width * first.scale >= 1.5 * logicalHeight);
  assert.equal(first.width, first.height);
  assert.ok(
    first.width <= 65536,
    'encoded dimensions fit Cesium width packing',
  );
  assert.ok(
    first.width * first.scale > 65536,
    'continental splats retain their true footprint through scale',
  );
  collection.update({ passes: { pick: true } });
  assert.equal(
    h.counts.updates,
    0,
    'the real public pick update is suppressed',
  );
  collection.update({ passes: { render: true } });
  assert.equal(h.counts.updates, 1);
  h.settle();
  const rankOf = wildlifeDensityRanks(rows);
  for (let i = 0; i < collection.length; i++)
    assert.ok(
      Math.abs(
        collection.get(i).color.alpha -
          wildlifeDensityIntensity(rankOf(rows[i].cellCount)),
      ) < 1e-12,
    );
  h.density.destroy();
});

test('progressive tile arrival fades only new cells and reuses existing glow without flashing', () => {
  const h = harness();
  const one = cell(0, 4);
  const two = cell(1, 10);
  h.density.update([one]);
  const first = h.density.collection.get(0);
  const starting = first.color.alpha;
  h.fadeStep();
  assert.ok(first.color.alpha > starting);
  const middle = first.color.alpha;
  h.density.update([one, two]);
  // The arriving tile re-ranks the incumbent (alone it was the hotspot; now
  // it is the median) but its fade progress is kept, not restarted.
  const progress = middle / wildlifeDensityIntensity(1);
  assert.ok(
    Math.abs(first.color.alpha - wildlifeDensityIntensity(0.5) * progress) <
      1e-12,
    'a streamed tile re-ranks but does not restart incumbents',
  );
  assert.equal(h.density.collection.get(0), first);
  assert.equal(h.density.size, 2);
  h.settle();
  const settled = first.color.alpha;
  h.density.update([one, two]);
  assert.equal(first.color.alpha, settled);
  h.density.update([two]);
  assert.equal(h.density.size, 1);
  assert.equal(h.density.collection.length, 1);
  h.density.update([]);
  assert.equal(h.density.size, 0);
  assert.equal(
    h.density.collection,
    null,
    'empty data releases the atlas and collection',
  );
  assert.equal(
    h.primitives.length,
    0,
    'no full-view fill remains over empty data',
  );
  h.density.destroy();
});

test('visibility and antimeridian padding are applied on data/moveEnd work only', () => {
  const h = harness();
  const west = cell(1);
  const east = cell(28);
  const box = { ...wildlifeGridCellBounds(west.id) };
  assert.equal(h.density.update([west, east], { boxes: [box] }).size, 1);
  assert.equal(
    h.density.update([west], { boxes: [box], isPointVisible: () => false })
      .size,
    0,
  );
  const id = 'grid:3/0/2:31:1';
  const bounds = wildlifeGridCellBounds(id);
  const wrapped = {
    ...west,
    id,
    lat: (bounds.south + bounds.north) / 2,
    lon: -179.3,
  };
  const crossed = {
    south: bounds.south,
    north: bounds.north,
    west: 179,
    east: -179,
  };
  assert.equal(h.density.update([wrapped], { boxes: [crossed] }).size, 1);
  h.density.destroy();
});

test('density culls far-side cells and front-side kernels that would spill over the limb', () => {
  const camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 5_000_000),
    positionCartographic: { height: 5_000_000 },
  };
  const h = harness({ camera });
  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    camera.positionWC,
  );
  const cells = [
    cell(0, 1, { lat: 0, lon: 0 }),
    cell(1, 2, { lat: 0, lon: 54 }),
    cell(2, 4, { lat: 0, lon: 110 }),
  ];
  assert.equal(
    occluder.isPointVisible(Cesium.Cartesian3.fromDegrees(54, 0)),
    true,
    'the limb fixture has a visible centre but an overflowing footprint',
  );
  const result = h.density.update(cells, {
    isPointVisible: (anchor) => occluder.isPointVisible(anchor),
  });
  assert.equal(result.size, 1, 'only the fully front-side kernel can glow');
  assert.equal(
    result.sightingCount,
    3,
    'visual limb padding never removes visible counts',
  );
  h.density.destroy();
});

test('density fades from regional detail to a clear whole-globe view without frame work or count loss', () => {
  const camera = { positionCartographic: { height: 3_000_000 } };
  const h = harness({ camera });
  const cells = [cell(0, 12)];
  h.density.update(cells);
  h.settle();
  const point = h.density.collection.get(0);
  const fullAlpha = point.color.alpha;
  camera.positionCartographic.height = 5_500_000;
  h.density.update(cells);
  assert.equal(h.density.collection.get(0), point);
  assert.ok(Math.abs(point.color.alpha - fullAlpha / 2) < 1e-12);
  const writes = h.counts.writes;
  h.density.update(cells);
  assert.equal(h.counts.writes, writes, 'unchanged height writes nothing');
  camera.positionCartographic.height = 8_000_000;
  assert.equal(h.density.update(cells).sightingCount, 12);
  assert.equal(h.density.collection, null);
  assert.equal(h.timers.size, 0, 'no invisible fade or frame loop');
  const positions = h.counts.positions;
  camera.positionCartographic.height = 3_000_000;
  h.density.update(cells);
  h.settle();
  assert.equal(
    h.counts.positions,
    positions,
    'altitude changes reuse decoded positions',
  );
  assert.equal(h.density.collection.get(0).color.alpha, fullAlpha);
  h.density.destroy();
});

test('styles follow persisted mono/CRT and cockpit vision overrides, without adding a second ramp', () => {
  const h = harness({ documentStyle: 'thermal' });
  h.density.update([cell(0)]);
  h.settle();
  const point = h.density.collection.get(0);
  assert.equal(point.color.red, point.color.green);
  assert.equal(point.color.green, point.color.blue);
  const alpha = point.color.alpha;
  h.eventTarget.emit('gev:style-change', { style: 'retro' });
  h.flushIdle();
  assert.ok(point.color.green > point.color.red);
  h.eventTarget.emit('gev:vision-change', { cockpit: true, style: 'nvg' });
  h.flushIdle();
  assert.equal(point.color.red, point.color.green);
  h.eventTarget.emit('gev:style-change', { style: 'normal' });
  h.flushIdle();
  assert.equal(
    point.color.red,
    point.color.green,
    'cockpit vision wins while active',
  );
  h.eventTarget.emit('gev:vision-change', { cockpit: false, style: 'normal' });
  h.flushIdle();
  assert.notEqual(point.color.red, point.color.green);
  assert.equal(point.color.alpha, alpha);
  h.density.destroy();
});

test('clear/disable and destroy release the atlas, primitives, coordinates, timers and listeners', () => {
  const h = harness();
  const row = cell(0);
  h.density.update([row]);
  const old = h.density.collection;
  assert.equal(h.timers.size, 1);
  h.fadeStep();
  h.density.clear();
  assert.equal(old.isDestroyed(), true);
  assert.equal(h.density.collection, null);
  assert.equal(h.density.size, 0);
  assert.equal(h.primitives.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.idle.size, 0);
  for (const values of h.listeners.values()) assert.equal(values.size, 0);
  const priorPositions = h.counts.positions;
  h.density.update([row]);
  assert.equal(
    h.counts.positions,
    priorPositions + 1,
    'disable released cached coordinates',
  );
  const work = h.density.updateWork([cell(2)]);
  work.next();
  h.density.destroy();
  assert.equal(
    work.next().done,
    true,
    'obsolete data work cannot resurrect a destroyed layer',
  );
  assert.equal(h.density.collection, null);
  assert.equal(h.primitives.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.idle.size, 0);
});

test('dense six-tile updates have a deterministic linear operation budget and no warmed writes/projections', (t) => {
  const h = harness();
  const cells = [];
  for (let x = 1; x < 3; x++)
    for (let y = 1; y < 4; y++)
      for (let row = 1; row < 64; row += 2)
        for (let column = 1; column < 64; column += 2) {
          const id = `grid:3/${x}/${y}:${row}:${column}`;
          const box = wildlifeGridCellBounds(id);
          cells.push({
            id,
            lat: (box.south + box.north) / 2,
            lon: (box.west + box.east) / 2,
            cellCount: row * 64 + column,
          });
        }
  let operations;
  h.density.update(cells, {
    onOperations: (value) => {
      operations = value;
    },
  });
  h.settle();
  assert.equal(operations.densityVisits, 6144);
  assert.equal(operations.densityMetadataBuilds, 6144);
  assert.equal(operations.densityPositionBuilds, 6144);
  assert.equal(operations.densityCreated, 6144);
  const positions = h.counts.positions;
  const writes = h.counts.writes;
  let units = 0;
  const work = h.density.updateWork(cells, {
    onOperations: (value) => {
      operations = value;
    },
  });
  while (!work.next().done) units++;
  assert.deepEqual(operations, {
    densityVisits: 6144,
    densityRetirementVisits: 6144,
    densityMetadataBuilds: 0,
    densityPositionBuilds: 0,
    densityWrites: 0,
    densityCreated: 0,
    densityRemoved: 0,
  });
  assert.equal(units, Math.ceil(6144 / WILDLIFE_WORK_UNIT) * 2);
  assert.equal(h.counts.positions, positions);
  assert.equal(h.counts.writes, writes);
  t.diagnostic(
    `6,144 occupied cells: ${units} bounded units, 12,288 linear visits, zero warmed metadata/Cartesian builds, projections or billboard writes`,
  );
  h.density.destroy();
});
