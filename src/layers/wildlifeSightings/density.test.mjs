import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { horizonFrom } from '../../geo/horizon.js';
import { wildlifeGridCellBounds } from './gridViewport.js';
import {
  createWildlifeDensity,
  wildlifeDensityIntensity,
  wildlifeDensityRanks,
  wildlifeDensityKernel,
  WILDLIFE_DENSITY_MAX_ALPHA,
  WILDLIFE_DENSITY_OVERLAP,
  WILDLIFE_DENSITY_SPLAT_PX,
} from './density.js';
import { bindFakeCesiumCamera } from '../../testSupport/fakeCameraPort.mjs';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';
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

function harness({
  documentStyle = 'normal',
  camera = { positionCartographic: { height: 0 } },
} = {}) {
  const counts = { positions: 0, writes: 0, created: 0, updates: 0 };
  const draw = fakeDrawPort();
  const viewer = { camera, scene: {} };
  bindFakeCesiumCamera(viewer, { draw });
  const glowSets = () =>
    [...draw.sets.values()].filter(
      (record) => !record.disposed && record.spec.id.endsWith(':density'),
    );
  // Each splat reads its item live, by id, with its colour by channel.
  const views = new Map();
  const view = (record, id) => {
    if (!views.has(id))
      views.set(
        id,
        new Proxy(
          {},
          {
            get(_target, key) {
              const item = glowSets()[0]?.items.get(id);
              if (key === 'color') {
                const [red, green, blue, alpha] = item.color;
                return { red, green, blue, alpha };
              }
              return item?.[key];
            },
          },
        ),
      );
    return views.get(id);
  };
  const glow = () => {
    const record = glowSets()[0];
    if (!record) return null;
    const ids = [...record.items.keys()];
    return {
      spec: record.spec,
      length: ids.length,
      get: (index) => view(record, ids[index]),
    };
  };
  // The draw port's writes to the glow, every batch counted once.
  Object.defineProperty(counts, 'writes', {
    get: () =>
      [...draw.sets.values()]
        .filter((record) => record.spec.id.endsWith(':density'))
        .reduce((sum, record) => sum + record.writes, 0),
  });
  const primitives = {
    get length() {
      return glowSets().length;
    },
  };
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
    viewer,
    positionForCell(row) {
      counts.positions++;
      return fromDegrees(row.lon, row.lat);
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
    glow,
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

test('each glow kernel is a pixel-sized splat drawn over depth at its cell', () => {
  const h = harness();
  const rows = [cell(0, 4), cell(1, 9)];
  h.density.update(rows);
  const collection = h.glow();
  assert.equal(collection.length, 2);
  for (let i = 0; i < collection.length; i++) {
    const point = collection.get(i);
    assert.deepEqual(point.size, [
      WILDLIFE_DENSITY_SPLAT_PX,
      WILDLIFE_DENSITY_SPLAT_PX,
    ]);
    assert.equal(point.disableDepthTest, Infinity);
    assert.ok(Math.abs(toLonLatH(point.pos).lon - rows[i].lon) < 1e-9);
  }
  h.density.destroy();
});

test('occupied grid counts produce unlabelled glow icons that never enter picking', () => {
  const h = harness();
  const rows = [cell(0, 1), cell(1, 100), cell(2, 1000000)];
  const result = h.density.update(rows);
  assert.equal(result.sightingCount, 1000101);
  assert.equal(h.primitives.length, 1);
  const collection = h.glow();
  assert.equal(collection.spec.pickable, false);
  assert.equal(
    collection.spec.blend,
    undefined,
    'the default blend, so translucent glow writes no depth over badges',
  );
  assert.equal(collection.length, 3);
  const first = collection.get(0);
  assert.equal(first.pickable, false, 'density has no pick payload');
  assert.doesNotMatch(first.id, /wildlife:/, 'nor a sighting identity');
  assert.match(decodeURIComponent(first.image), /radialGradient/);
  assert.doesNotMatch(decodeURIComponent(first.image), /text|badge|raven/);
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
  const first = h.glow().get(0);
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
  assert.equal(h.glow().get(0), first);
  assert.equal(h.density.size, 2);
  h.settle();
  const settled = first.color.alpha;
  h.density.update([one, two]);
  assert.equal(first.color.alpha, settled);
  h.density.update([two]);
  assert.equal(h.density.size, 1);
  assert.equal(h.glow().length, 1);
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
    positionWC: fromDegrees(0, 0, 5_000_000),
    positionCartographic: { height: 5_000_000 },
  };
  const h = harness({ camera });
  const occluder = horizonFrom(camera.positionWC);
  const cells = [
    cell(0, 1, { lat: 0, lon: 0 }),
    cell(1, 2, { lat: 0, lon: 54 }),
    cell(2, 4, { lat: 0, lon: 110 }),
  ];
  assert.equal(
    occluder.isPointVisible(fromDegrees(54, 0)),
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
  const point = h.glow().get(0);
  const fullAlpha = point.color.alpha;
  camera.positionCartographic.height = 5_500_000;
  h.density.update(cells);
  assert.equal(h.glow().get(0), point);
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
  assert.equal(h.glow().get(0).color.alpha, fullAlpha);
  h.density.destroy();
});

test('styles follow persisted mono/CRT and cockpit vision overrides, without adding a second ramp', () => {
  const h = harness({ documentStyle: 'thermal' });
  h.density.update([cell(0)]);
  h.settle();
  const point = h.glow().get(0);
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

test('clear/disable and destroy release the glow set, coordinates, timers and listeners', () => {
  const h = harness();
  const row = cell(0);
  h.density.update([row]);
  assert.equal(h.timers.size, 1);
  h.fadeStep();
  h.density.clear();
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

test('destroy mid-update drops the glow writes still batched', async () => {
  const h = harness();
  const work = h.density.updateWork([cell(0), cell(1)]);
  while (!h.primitives.length && !work.next().done);
  assert.equal(h.primitives.length, 1, 'a splat is batched, not yet sent');
  h.density.destroy();
  // A batched write reaching the disposed set would throw here.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.primitives.length, 0);
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
