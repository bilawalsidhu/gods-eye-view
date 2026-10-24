import test from 'node:test';
import assert from 'node:assert/strict';
import { createGravityLayer, gravityValueAt } from './index.js';
import { decodeLandMaskRuns, landMaskAt } from './landMask.js';
import { encodeLandMaskRuns } from '../../../server/providers/gravity/grid.js';

/**
 * A 0.25° mask that is land west of 0° longitude, plus the north-west
 * quarter of northern India's cell (28-29N, 77-78E), so one grid cell is
 * part land, part sea.
 */
function syntheticMask() {
  const mask = new Uint8Array(1440 * 720);
  for (let row = 0; row < 720; row++)
    mask.fill(1, row * 1440, row * 1440 + 720);
  for (let row = 61 * 4; row < 61 * 4 + 2; row++)
    mask.fill(1, row * 1440 + 257 * 4, row * 1440 + 257 * 4 + 2);
  return mask;
}
const MASK = syntheticMask();
import {
  createGravityRaster,
  createGravityRendering,
  gravityColor,
  GRAVITY_COLORS,
} from './rendering.js';
import { createGravitySource, validateGravityIndex } from './source.js';
import { gravityScalePosition } from './display.js';

const CELLS = 360 * 180;
const GRID = { nx: 360, ny: 180, lo1: -179.5, la1: 89.5, dx: 1, dy: 1 };
const INDEX = Object.freeze({
  schemaVersion: 1,
  grid: GRID,
  scaleCm: 0.5,
  noData: -32768,
  generatedAt: 1,
  solutions: [
    { id: '2026-06-01', start: '2026-06-01', end: '2026-07-01' },
    { id: '2026-07-01', start: '2026-07-01', end: '2026-08-01' },
    { id: '2026-08-01', start: '2026-08-01', end: '2026-09-01' },
  ],
});
// 28.5N 77.5E (northern India) is row 61, column 257.
const INDIA = 61 * 360 + 257;

function fieldFor(id) {
  const field = new Int16Array(CELLS);
  field[INDIA] = { '2026-06-01': -40, '2026-07-01': -50, '2026-08-01': -60 }[
    id
  ];
  field[0] = -32768;
  return field;
}

function harness() {
  const fetched = [];
  const cells = [];
  const feed = {
    getIndex: async () => INDEX,
    getField: async (id) => {
      fetched.push(id);
      return fieldFor(id);
    },
    getCell: async (lat, lon) => {
      cells.push([lat, lon]);
      return { lat: 28.5, lon: 77.5, values: [-20, -25, -30] };
    },
    getLandMask: async () => MASK,
  };
  const drawn = [];
  const filters = [];
  const timers = [];
  const rendering = {
    setField: (field, _format, include) => {
      drawn.push(field[INDIA]);
      filters.push(include);
    },
    setAlpha() {},
    rehome() {},
    clear: () => drawn.push('clear'),
    destroy() {},
    getDiagnostics: () => ({ imageryActive: drawn.length > 0, error: null }),
  };
  const layer = createGravityLayer({
    feed,
    createRendering: () => rendering,
    eventTarget: null,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => timers.splice(0),
  });
  layer.init({ scene: {} });
  return { layer, fetched, drawn, filters, timers, cells };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('colours run red for loss and blue for gain, clamp at the ends, and hide no-data', () => {
  assert.deepEqual(gravityColor(-1000), GRAVITY_COLORS[0][1]);
  assert.deepEqual(gravityColor(1000), GRAVITY_COLORS.at(-1)[1]);
  // Past 40 cm the colour keeps deepening instead of stopping, so ice loss
  // of a metre or more is not one flat patch.
  const deepen = [-40, -100, -250, -400].map((cm) => gravityColor(cm));
  for (let i = 1; i < deepen.length; i++)
    assert.ok(
      deepen[i][0] + deepen[i][1] + deepen[i][2] <
        deepen[i - 1][0] + deepen[i - 1][1] + deepen[i - 1][2],
      'loss darkens all the way to 400 cm',
    );
  assert.deepEqual(
    gravityColor(-40),
    [103, 0, 31, 225],
    'the core is as before',
  );
  assert.equal(gravityColor(0)[3], 0, 'zero change is transparent');
  const loss = gravityColor(-15);
  const gain = gravityColor(15);
  assert.ok(loss[0] > loss[2], 'loss is red');
  assert.ok(gain[2] > gain[0], 'gain is blue');
  assert.deepEqual(gravityColor(null), [0, 0, 0, 0]);
});

test('the raster is drawn at 0.25° and blends between cell centres', () => {
  const format = { nx: 360, ny: 180, scaleCm: 0.5, noData: -32768 };
  const field = new Int16Array(CELLS);
  // Column 100 is -40 cm from pole to pole; its neighbours are 0.
  for (let row = 0; row < 180; row++) field[row * 360 + 100] = -80;
  // Row 0: no data in column 0, -40 cm in column 1.
  field[0] = -32768;
  field[1] = -80;
  const raster = createGravityRaster(field, format);
  assert.equal(raster.width, 1440);
  assert.equal(raster.height, 720);
  const at = (x, y) => [
    ...raster.rgba.subarray((y * 1440 + x) * 4, (y * 1440 + x) * 4 + 4),
  ];
  // Pixel centres sit an eighth of a cell either side of the cell centres,
  // so the -40 cm column fades out over the pixels beside it.
  assert.deepEqual(at(402, 360), gravityColor(-35));
  assert.deepEqual(at(403, 360), gravityColor(-25));
  assert.deepEqual(at(405, 360), gravityColor(-5));
  // A no-data neighbour drops out of the blend instead of pulling towards 0.
  assert.deepEqual(at(2, 0), gravityColor(-40));
});

test('the land mask cuts the raster at 0.25° with a one-pixel soft coastline', () => {
  const format = { nx: 360, ny: 180, scaleCm: 0.5, noData: -32768 };
  const field = new Int16Array(CELLS).fill(-80);
  const mask = MASK;
  const raster = createGravityRaster(field, format, { mask });
  const full = gravityColor(-40)[3];
  const alpha = (x, y) => raster.rgba[(y * 1440 + x) * 4 + 3];
  // The synthetic coast runs down 0° longitude: column 719 is the last land
  // pixel and column 720 the first sea pixel.
  assert.equal(alpha(700, 360), full, 'inland draws in full');
  assert.equal(alpha(719, 360), Math.round(full * 0.75), 'the coast fades');
  assert.equal(alpha(720, 360), Math.round(full * 0.25), 'into the sea');
  assert.equal(alpha(722, 360), 0, 'open sea stays clear');
  let drawn = 0;
  let land = 0;
  for (let i = 0; i < mask.length; i++) {
    land += mask[i];
    if (raster.rgba[i * 4 + 3] === full) drawn++;
  }
  assert.ok(drawn < land && drawn > land * 0.99, 'all but the coast in full');
  // The edge falls inside a grid cell: India's cell is part land, part sea.
  const cell = [];
  for (let dy = 0; dy < 4; dy++)
    for (let dx = 0; dx < 4; dx++)
      cell.push(mask[(61 * 4 + dy) * 1440 + 257 * 4 + dx]);
  assert.ok(cell.includes(0) && cell.includes(1), 'a mixed cell');
  assert.throws(
    () => createGravityRaster(field, format, { mask: new Uint8Array(4) }),
    /mask/,
  );
});

test('the legend gives the ±40 cm core 60% of the ramp and the tails 20% each', () => {
  assert.equal(gravityScalePosition(0), 0.5);
  assert.ok(Math.abs(gravityScalePosition(-40) - 0.2) < 1e-9);
  assert.ok(Math.abs(gravityScalePosition(40) - 0.8) < 1e-9);
  assert.equal(gravityScalePosition(-400), 0);
  assert.equal(gravityScalePosition(400), 1);
  assert.equal(gravityScalePosition(-5000), 0, 'clamps past the end');
  // Logarithmic tails: 126 cm (40 × √10) sits halfway along its tail.
  assert.ok(Math.abs(gravityScalePosition(40 * Math.sqrt(10)) - 0.9) < 1e-9);
});

test('a position reads the one-degree cell that holds it', () => {
  const field = fieldFor('2026-08-01');
  assert.equal(gravityValueAt(field, INDEX, 28.2, 77.9), -30);
  assert.equal(gravityValueAt(field, INDEX, 28.2, 77.9 - 360), -30);
  assert.equal(gravityValueAt(field, INDEX, 89.9, -179.9), null, 'no-data');
  assert.equal(gravityValueAt(field, INDEX, 95, 0), null);
});

test('the layer shows the latest month, steps through months and returns to latest', async () => {
  const { layer, fetched, drawn } = harness();
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetched, ['2026-08-01']);
  assert.deepEqual(drawn, [-60]);
  let card = layer.getCardState();
  assert.equal(card.shownIndex, 2);
  assert.equal(card.latest, true);
  assert.deepEqual(
    layer.getRowControls().card,
    card,
    'the row carries the card',
  );

  layer.setParams({ step: -1 });
  await settle();
  assert.deepEqual(fetched, ['2026-08-01', '2026-07-01']);
  assert.deepEqual(layer.getParams(), {
    month: '2026-07-01',
    opacity: 'strong',
    area: 'land',
  });
  card = layer.getCardState();
  assert.equal(card.latest, false);
  assert.equal(card.shownIndex, 1);

  // A refresh keeps the chosen month and refetches nothing already drawn.
  await layer.update();
  assert.deepEqual(fetched, ['2026-08-01', '2026-07-01']);

  // Stepping onto the newest solution is the same as choosing Latest.
  layer.setParams({ step: 1 });
  await settle();
  assert.equal(layer.getParams().month, null);
  assert.deepEqual(drawn, [-60, -50, -60]);
  assert.deepEqual(fetched, ['2026-08-01', '2026-07-01'], 'cached fields');
});

test('land only is the default and hides ocean cells; land + ocean draws all', async () => {
  const { layer, filters } = harness();
  layer.enable();
  await layer.update();
  assert.equal(filters.at(-1), MASK, 'land only draws through the mask');
  layer.setParams({ area: 'all' });
  assert.equal(filters.at(-1), null);
  assert.equal(layer.getParams().area, 'all');
  const chips = layer.getRowControls().chips;
  assert.equal(chips.find(({ id }) => id === 'area-all').active, true);
});

test('playback starts over from the first solution and stops at the latest', async () => {
  const { layer, fetched, timers } = harness();
  layer.enable();
  await layer.update();
  layer.setParams({ playing: true });
  await settle();
  assert.equal(layer.getCardState().shownIndex, 0, 'restarted from the start');
  assert.equal(layer.getCardState().playing, true);
  await timers.shift()();
  assert.equal(layer.getCardState().shownIndex, 1);
  await timers.shift()();
  assert.equal(layer.getCardState().shownIndex, 2);
  await timers.shift()();
  assert.equal(layer.getCardState().playing, false, 'stops at the latest');
  assert.deepEqual(fetched, ['2026-08-01', '2026-06-01', '2026-07-01']);
});

test('choosing a month by hand ends a replay', async () => {
  const { layer, timers } = harness();
  layer.enable();
  await layer.update();
  layer.setParams({ playing: true });
  await settle();
  layer.setParams({ month: '2026-07-01' });
  assert.equal(layer.getCardState().playing, false);
  assert.equal(timers.length, 0);
});

test('a month missing from the record falls back to the latest', async () => {
  const { layer, fetched } = harness();
  layer.setParams({ month: '1999-01-01' });
  layer.enable();
  await layer.update();
  assert.deepEqual(fetched, ['2026-08-01']);
});

test('disable clears the field, and the next enable draws it again', async () => {
  const { layer, fetched, drawn } = harness();
  layer.enable();
  await layer.update();
  layer.disable();
  assert.equal(drawn.at(-1), 'clear');
  assert.equal(layer.getStats().count, 0);
  layer.enable();
  await layer.update();
  assert.deepEqual(fetched, ['2026-08-01', '2026-08-01']);
});

test('a record still being prepared is reported, not thrown', async () => {
  const feed = {
    getIndex: async () => {
      const error = new Error('Preparing the gravity record');
      error.code = 'GRAVITY_LOADING';
      throw error;
    },
    getField: async () => new Int16Array(CELLS),
  };
  const layer = createGravityLayer({
    feed,
    createRendering: () => ({
      setField() {},
      clear() {},
      destroy() {},
      rehome() {},
      setAlpha() {},
      getDiagnostics: () => ({}),
    }),
    eventTarget: null,
  });
  layer.init({ scene: {} });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.match(layer.getRowControls().info, /Preparing the gravity record/);
});

test('the rendering keeps one shell and alternates canvases so each month uploads', () => {
  const images = [];
  let created = 0;
  let destroyed = 0;
  const canvas = () => ({
    getContext: () => ({
      createImageData: (width, height) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData() {},
    }),
  });
  const rendering = createGravityRendering({
    viewer: { scene: { requestRender() {} } },
    cesium: { Rectangle: { MAX_VALUE: {} } },
    getHost: () => ({ kind: 'globe' }),
    createCanvas: canvas,
    createSurface: () => {
      created++;
      return {
        setImage: (image) => images.push(image),
        setAlpha() {},
        destroy: () => destroyed++,
      };
    },
  });
  const format = { nx: 360, ny: 180, scaleCm: 0.5, noData: -32768 };
  rendering.setField(fieldFor('2026-07-01'), format);
  rendering.setField(fieldFor('2026-08-01'), format);
  assert.equal(created, 1);
  assert.equal(images.length, 2);
  assert.notEqual(images[0], images[1]);
  rendering.clear();
  assert.equal(destroyed, 1);
});

test('the index is validated and a field decodes as little-endian int16', async () => {
  assert.throws(
    () => validateGravityIndex({ ...INDEX, grid: { ...GRID, nx: 720 } }),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateGravityIndex({
        ...INDEX,
        solutions: [...INDEX.solutions].reverse(),
      }),
    /Malformed/,
  );
  const bytes = new Uint8Array(CELLS * 2);
  new DataView(bytes.buffer).setInt16(INDIA * 2, -120, true);
  const urls = [];
  const source = createGravitySource({
    fetchImpl: async (url) => {
      urls.push(url);
      return url.endsWith('/index')
        ? Response.json(INDEX)
        : new Response(bytes, { status: 200 });
    },
  });
  assert.equal((await source.getIndex()).solutions.length, 3);
  const field = await source.getField('2026-08-01');
  assert.equal(field[INDIA], -120);
  assert.deepEqual(urls, [
    '/api/gravity/index',
    '/api/gravity/field?id=2026-08-01',
  ]);
  await assert.rejects(source.getField('../x'), /Unknown/);
});

test('a 503 from the proxy carries its code so the layer can say it is preparing', async () => {
  const source = createGravitySource({
    fetchImpl: async () =>
      Response.json(
        { code: 'GRAVITY_LOADING', error: 'Preparing the gravity record' },
        { status: 503 },
      ),
  });
  await assert.rejects(source.getIndex(), { code: 'GRAVITY_LOADING' });
});

test('the served land mask round-trips and answers by position', () => {
  const runs = encodeLandMaskRuns(MASK);
  const mask = decodeLandMaskRuns(runs);
  assert.deepEqual(mask, MASK);
  assert.equal(landMaskAt(mask, 10, -90), true, 'west of 0° is land here');
  assert.equal(landMaskAt(mask, 10, 90), false);
  assert.equal(
    landMaskAt(mask, 28.9, 77.1),
    true,
    'the land corner of the cell',
  );
  assert.equal(
    landMaskAt(mask, 28.1, 77.9),
    false,
    'the sea corner of the cell',
  );
  assert.equal(landMaskAt(mask, 10, 270), true, 'longitude wraps');
  assert.equal(landMaskAt(mask, 95, 0), null);
  assert.equal(landMaskAt(null, 10, 0), null);
  assert.throws(() => decodeLandMaskRuns(runs.subarray(0, 100)), /Malformed/);
  assert.throws(
    () => decodeLandMaskRuns(Uint8Array.from([...runs, 0])),
    /Malformed/,
  );
});

test('land only waits for the mask, and falls back to every cell without one', async () => {
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const drawn = [];
  const make = (getLandMask) => {
    const layer = createGravityLayer({
      feed: {
        getIndex: async () => INDEX,
        getField: async (id) => fieldFor(id),
        getLandMask,
      },
      createRendering: () => ({
        setField: (_field, _format, mask) => drawn.push(mask),
        clear() {},
        destroy() {},
        rehome() {},
        setAlpha() {},
        getDiagnostics: () => ({}),
      }),
      eventTarget: null,
    });
    layer.init({ scene: {} });
    layer.enable();
    return layer;
  };
  const waiting = make(() => pending);
  await waiting.update();
  assert.deepEqual(drawn, [], 'no ocean flash before the mask');
  release(MASK);
  await settle();
  assert.deepEqual(drawn, [MASK]);

  drawn.length = 0;
  const failing = make(async () => {
    throw new Error('offline');
  });
  await failing.update();
  await settle();
  assert.deepEqual(drawn, [null], 'every cell, rather than nothing');
  assert.match(failing.getRowControls().info, /Land mask unavailable/);
});

test('a click on open ground reads the month and charts that cell', async () => {
  let onClick = null;
  const cesium = {
    ScreenSpaceEventHandler: class {
      setInputAction(fn) {
        onClick = fn;
      }
      destroy() {}
    },
    ScreenSpaceEventType: { LEFT_CLICK: 'click' },
    Cartographic: { fromCartesian: (hit) => hit },
    Math: { toDegrees: (radians) => (radians * 180) / Math.PI },
  };
  const cells = [];
  let picked;
  const layer = createGravityLayer({
    feed: {
      getIndex: async () => INDEX,
      getField: async (id) => fieldFor(id),
      getCell: async (lat, lon) => {
        cells.push([lat, lon]);
        return { lat: 28.5, lon: 77.5, values: [-20, -25, -30] };
      },
      getLandMask: async () => MASK,
    },
    cesium,
    createRendering: () => ({
      setField() {},
      clear() {},
      destroy() {},
      rehome() {},
      setAlpha() {},
      getDiagnostics: () => ({}),
    }),
    eventTarget: null,
  });
  const radians = (degrees) => (degrees * Math.PI) / 180;
  layer.init({
    scene: { canvas: {}, pick: () => picked },
    camera: {
      pickEllipsoid: () => ({
        latitude: radians(28.2),
        longitude: radians(77.9),
      }),
    },
  });
  layer.enable();
  await layer.update();
  picked = { id: 'flight-123' };
  onClick({ position: { x: 1, y: 1 } });
  assert.equal(layer.getCardState().probe, null, 'another layer owns that');
  picked = undefined;
  onClick({ position: { x: 1, y: 1 } });
  await settle();
  const probe = layer.getCardState().probe;
  assert.equal(probe.cm, -30);
  assert.equal(probe.land, false, 'the sea corner of a part-land cell');
  assert.deepEqual(probe.history, [-20, -25, -30]);
  assert.equal(cells.length, 1);
  // Changing month rereads the value without refetching the history.
  layer.setParams({ step: -1 });
  await settle();
  assert.equal(layer.getCardState().probe.cm, -25);
  assert.equal(cells.length, 1);
  layer.setParams({ clearProbe: true });
  assert.equal(layer.getCardState().probe, null);
});
