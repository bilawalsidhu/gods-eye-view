import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIELD_IDS,
  europeWeight,
  fieldColor,
  fieldCoverage,
  fieldStepAt,
  paintField,
  readFieldManifest,
  sampleField,
} from './field.js';
import { EEA_HOURLY_BANDS, EEA_HOURLY_LIMITS } from './interpretation.js';
import { createAirQualityLayer } from './index.js';
import { createWorldClock } from '../../time/worldClock.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { formatUtcDayMonth } from '../../i18n/index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { WEATHER_IMAGERY_Z } from '../weather/imageryOrder.js';

const HOUR = 3600_000;
const SCALE = Object.freeze({
  pm25: 20,
  pm10: 10,
  o3: 50,
  no2: 50,
  so2: 20,
  co: 500,
  aqi: 10,
});
const PM25 = {
  bands: EEA_HOURLY_BANDS,
  limits: EEA_HOURLY_LIMITS['PM2.5'],
};

/** A manifest around `global` (and `europe`), checked as a host's would be. */
const manifestOf = (global, europe = null, extra = {}) =>
  readFieldManifest({
    source: 'CAMS',
    run: '2026-11-20T00:00:00Z',
    scale: SCALE,
    global: { steps: [0], ...global },
    ...(europe ? { europe: { steps: [0], ...europe } } : {}),
    ...extra,
  });
/** Grids for `region`: every id from `valueAt(x, y, id)`, or one value. */
const gridsOf = (region, valueAt) =>
  Object.fromEntries(
    FIELD_IDS.map((id) => {
      const values = new Uint16Array(region.width * region.height);
      for (let y = 0; y < region.height; y++)
        for (let x = 0; x < region.width; x++) {
          const value =
            typeof valueAt === 'function' ? valueAt(x, y, id) : valueAt;
          values[y * region.width + x] =
            value === null ? 65535 : Math.round(value * SCALE[id]);
        }
      return [id, values];
    }),
  );

// ── sampling ───────────────────────────────────────────────────────────────

test('sampleField reads a grid value bilinearly', () => {
  // 3 × 3 points one degree apart from (0° E, 2° N), north first: 0 … 80.
  const global = { width: 3, height: 3, lon0: 0, lat0: 2, step: 1 };
  const manifest = manifestOf(global);
  const grids = { global: gridsOf(global, (x, y) => (y * 3 + x) * 10) };
  assert.equal(sampleField(manifest, grids, 'pm25', 0, 2), 0);
  assert.equal(sampleField(manifest, grids, 'pm25', 2, 0), 80);
  // Midway between the first four points: their mean.
  assert.equal(sampleField(manifest, grids, 'pm25', 0.5, 1.5), 20);
  // A quarter of the way east, half way south, between 40, 50, 70 and 80.
  assert.equal(sampleField(manifest, grids, 'pm25', 1.25, 0.5), 57.5);
  // Outside a region that does not wrap: no value.
  assert.equal(sampleField(manifest, grids, 'pm25', 2.5, 1), null);
  assert.equal(sampleField(manifest, grids, 'pm25', 1, 2.5), null);

  // A wrapping region reads across the dateline, at any longitude.
  const world = {
    width: 4,
    height: 3,
    lon0: 0,
    lat0: 90,
    step: 90,
    wrap: true,
  };
  const round = manifestOf(world);
  const ring = { global: gridsOf(world, (x) => [0, 10, 20, 30][x]) };
  assert.equal(sampleField(round, ring, 'pm25', 315, 0), 15);
  assert.equal(sampleField(round, ring, 'pm25', -45, 0), 15);
  assert.equal(sampleField(round, ring, 'pm25', 45, 0), 5);
});

test("inside Europe's edge band the value blends from global to Europe", () => {
  const world = { width: 4, height: 3, lon0: 0, lat0: 90, step: 90 };
  // The inset: 20° by 20°, its points the middles of one-degree cells.
  const europe = {
    width: 20,
    height: 20,
    lon0: 0.5,
    lat0: 19.5,
    step: 1,
    rectangle: { west: 0, south: 0, east: 20, north: 20 },
    blendDeg: 3,
  };
  const manifest = manifestOf({ ...world, wrap: true }, europe);
  const grids = { global: gridsOf(world, 10), europe: gridsOf(europe, 50) };
  const region = manifest.europe;
  // Weight 0 at the edge and outside it, 1 from blendDeg in, smoothstep
  // between: 3t² − 2t³ at t = inside / blendDeg.
  assert.equal(europeWeight(region, 0, 10), 0);
  assert.equal(europeWeight(region, -1, 10), 0);
  assert.equal(europeWeight(region, 10, 20), 0);
  assert.equal(europeWeight(region, 1.5, 10), 0.5);
  assert.equal(europeWeight(region, 3, 10), 1);
  assert.equal(europeWeight(region, 10, 10), 1);
  assert.ok(Math.abs(europeWeight(region, 0.75, 10) - 0.15625) < 1e-12);
  assert.ok(Math.abs(europeWeight(region, 10, 19.25) - 0.15625) < 1e-12);
  // The value: global + (europe − global) · w.
  assert.equal(sampleField(manifest, grids, 'pm25', 10, 10), 50);
  assert.equal(sampleField(manifest, grids, 'pm25', 1.5, 10), 30);
  assert.ok(
    Math.abs(sampleField(manifest, grids, 'pm25', 0.75, 10) - 16.25) < 1e-9,
  );
  // Between the edge and the inset's first point Europe has no value.
  assert.equal(sampleField(manifest, grids, 'pm25', 0.2, 10), 10);
  // Outside it, the global field alone.
  assert.equal(sampleField(manifest, grids, 'pm25', 30, 10), 10);
  // A manifest without blendDeg takes the default 3°.
  const { blendDeg, ...unbanded } = europe;
  assert.equal(blendDeg, 3);
  assert.equal(
    manifestOf({ ...world, wrap: true }, unbanded).europe.blendDeg,
    3,
  );
});

test('a missing cell gives null', () => {
  const global = { width: 2, height: 2, lon0: 0, lat0: 1, step: 1 };
  const manifest = manifestOf(global);
  const grids = {
    global: gridsOf(global, (x, y) => (x === 1 && y === 1 ? null : 10)),
  };
  assert.equal(sampleField(manifest, grids, 'pm25', 0.5, 0.5), null);
  assert.equal(sampleField(manifest, grids, 'pm25', 0, 1), 10);
  // Europe missing there: the global value; global missing: Europe's.
  const europe = {
    width: 2,
    height: 2,
    lon0: 0,
    lat0: 1,
    step: 1,
    rectangle: { west: -0.5, south: -0.5, east: 1.5, north: 1.5 },
    blendDeg: 0.1,
  };
  const both = manifestOf(global, europe);
  assert.equal(
    sampleField(
      both,
      { global: gridsOf(global, 10), europe: gridsOf(europe, null) },
      'pm25',
      0.5,
      0.5,
    ),
    10,
  );
  assert.equal(
    sampleField(
      both,
      { global: gridsOf(global, null), europe: gridsOf(europe, 30) },
      'pm25',
      0.5,
      0.5,
    ),
    30,
  );
});

// ── painting ───────────────────────────────────────────────────────────────

/** The pixel of `image` at grid point (x, y): `[r, g, b, a]`. */
const pixel = (image, x, y) => [
  ...image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];
const rgbOf = (hex) =>
  hex
    .slice(1)
    .match(/\w\w/g)
    .map((pair) => parseInt(pair, 16));

test('the field paints each band at its middle, opacity min(0.82, 0.05 + 0.26·p)', () => {
  // PM2.5 10 µg/m³ is the middle of Fair (5–15): p = 1.5.
  const global = { width: 3, height: 2, lon0: 0, lat0: 1, step: 1 };
  const values = [
    [0, 10, 300],
    [null, 2.5, 32.5],
  ];
  const [image, ...rest] = paintField(
    manifestOf(global),
    { global: gridsOf(global, (x, y) => values[y][x]) },
    'pm25',
    PM25,
  );
  assert.equal(rest.length, 0);
  assert.equal(image.name, 'global');
  assert.deepEqual(image.rectangle, {
    west: -0.5,
    east: 2.5,
    north: 1.5,
    south: -0.5,
  });
  assert.deepEqual(pixel(image, 1, 0), [
    ...rgbOf(EEA_HOURLY_BANDS[1].color),
    Math.round(255 * 0.44),
  ]);
  // No concentration: the first band's colour, nearly clear.
  assert.deepEqual(pixel(image, 0, 0), [
    ...rgbOf(EEA_HOURLY_BANDS[0].color),
    Math.round(255 * 0.05),
  ]);
  // Far above the top limit: the top band's colour at most 0.82.
  assert.deepEqual(pixel(image, 2, 0), [
    ...rgbOf(EEA_HOURLY_BANDS[5].color),
    Math.round(255 * 0.82),
  ]);
  // No data: nothing drawn.
  assert.deepEqual(pixel(image, 0, 1), [0, 0, 0, 0]);
  // Below the first band's middle it keeps that colour.
  assert.deepEqual(pixel(image, 1, 1).slice(0, 3), [
    ...rgbOf(EEA_HOURLY_BANDS[0].color),
  ]);
  // Between two middles the colours run into each other: 32.5 µg/m³ is the
  // middle of Moderate (15–50); half way to Fair's middle is 2.0.
  assert.deepEqual(pixel(image, 2, 1).slice(0, 3), [
    ...rgbOf(EEA_HOURLY_BANDS[2].color),
  ]);
  const halfway = fieldColor(PM25.bands, PM25.limits, 15);
  const [fair, moderate] = [1, 2].map((i) => rgbOf(EEA_HOURLY_BANDS[i].color));
  assert.deepEqual(
    halfway.slice(0, 3),
    fair.map((c, i) => Math.round(c + (moderate[i] - c) * 0.5)),
  );
  assert.equal(halfway[3], 0.05 + 0.26 * 2);

  // A wrapping global field is resampled onto the world from 180° W.
  const world = {
    width: 4,
    height: 3,
    lon0: 0,
    lat0: 90,
    step: 90,
    wrap: true,
  };
  const [round] = paintField(
    manifestOf(world),
    { global: gridsOf(world, 10) },
    'pm25',
    PM25,
  );
  assert.deepEqual(
    [round.width, round.height, round.rectangle],
    [4, 2, { west: -180, south: -90, east: 180, north: 90 }],
  );
});

test('where Europe is drawn the two images cross-fade, as opaque as one', () => {
  const global = { width: 21, height: 21, lon0: 0, lat0: 20, step: 1 };
  const europe = {
    width: 10,
    height: 10,
    lon0: 5,
    lat0: 14,
    step: 1,
    rectangle: { west: 4.5, south: 4.5, east: 14.5, north: 14.5 },
    blendDeg: 3,
  };
  const manifest = manifestOf(global, europe);
  // At 6° E, 10° N the inset's share is 0.5 (1.5° inside a 3° band).
  assert.equal(europeWeight(manifest.europe, 6, 10), 0.5);
  const a = 0.44; // 10 µg/m³ is p = 1.5

  // The same value in both: the pair is as opaque as one image of it.
  const [wide, fine] = paintField(
    manifest,
    { global: gridsOf(global, 10), europe: gridsOf(europe, 10) },
    'pm25',
    PM25,
  );
  assert.equal(fine.name, 'europe');
  assert.deepEqual(fine.rectangle, europe.rectangle);
  const under = pixel(wide, 6, 10);
  const over = pixel(fine, 1, 4);
  assert.equal(under[3], Math.round((255 * (0.5 * a)) / (1 - 0.5 * a)));
  assert.equal(over[3], Math.round(255 * 0.5 * a));
  const together = over[3] / 255 + (under[3] / 255) * (1 - over[3] / 255);
  assert.ok(Math.abs(together - a) < 2 / 255);
  // Deep inside, the inset alone shows: the global image is clear there.
  assert.equal(pixel(wide, 10, 10)[3], 0);
  assert.equal(pixel(fine, 5, 4)[3], Math.round(255 * a));
  // Outside the inset the global image is as it would be alone.
  assert.equal(pixel(wide, 1, 1)[3], Math.round(255 * a));

  // Different values: the inset paints the blended one, 25 µg/m³ half way
  // between 10 and 40, at half its own opacity.
  const [, mixed] = paintField(
    manifest,
    { global: gridsOf(global, 10), europe: gridsOf(europe, 40) },
    'pm25',
    PM25,
  );
  const blended = fieldColor(PM25.bands, PM25.limits, 25);
  assert.deepEqual(pixel(mixed, 1, 4).slice(0, 3), blended.slice(0, 3));
  assert.equal(pixel(mixed, 1, 4)[3], Math.round(255 * 0.5 * blended[3]));
});

// ── time ───────────────────────────────────────────────────────────────────

test('a field covers its first step to its last; the step shown is the nearest', () => {
  const manifest = manifestOf({
    width: 2,
    height: 2,
    lon0: 0,
    lat0: 1,
    step: 1,
    steps: [0, 3, 6, 24],
  });
  const run = Date.parse('2026-11-20T00:00:00Z');
  assert.deepEqual(fieldCoverage(manifest), {
    start: run,
    end: run + 24 * HOUR,
  });
  assert.equal(fieldStepAt(manifest, run + 1 * HOUR), 0);
  assert.equal(fieldStepAt(manifest, run + 2 * HOUR), 3);
  assert.equal(fieldStepAt(manifest, run + 14 * HOUR), 6);
  assert.equal(fieldStepAt(manifest, run + 16 * HOUR), 24);
  // Half a step past either end is still the end; further is no step.
  assert.equal(fieldStepAt(manifest, run - 1 * HOUR), 0);
  assert.equal(fieldStepAt(manifest, run - 2 * HOUR), null);
  assert.equal(fieldStepAt(manifest, run + 33 * HOUR), 24);
  assert.equal(fieldStepAt(manifest, run + 43 * HOUR), null);
});

test('a manifest that is not one is refused', () => {
  const good = {
    run: '2026-11-20T00:00:00Z',
    scale: SCALE,
    global: { width: 2, height: 2, lon0: 0, lat0: 1, step: 1, steps: [0] },
  };
  assert.equal(readFieldManifest(good).source, '');
  for (const bad of [
    null,
    { ...good, run: 'yesterday' },
    { ...good, scale: { ...SCALE, aqi: 0 } },
    { ...good, global: { ...good.global, steps: [3, 0] } },
    { ...good, global: { ...good.global, width: 1e5, height: 1e5 } },
    { ...good, europe: { ...good.global } },
  ])
    assert.throws(() => readFieldManifest(bad), /Malformed air-quality field/);
});

// ── the layer with a field ─────────────────────────────────────────────────

const ALL = ['PM2.5', 'PM10', 'O3', 'NO2', 'SO2', 'CO'];
const SAAQIS = {
  id: 'saaqis',
  title: 'South Africa',
  label: 'Air quality · South Africa',
  network: 'SAAQIS',
  coverage: 'South Africa',
  observation: true,
  direct: true,
  parameters: ALL,
};
const CAPE_TOWN = { lat: -33.92, lon: 18.42 };
const VALUES = { 'PM2.5': 12, PM10: 30, O3: 80, NO2: 20, SO2: 5, CO: 0.4 };
const capeTown = () =>
  Object.entries(VALUES).map(([parameter, value]) => ({
    id: `saaqis:cape-town:${parameter}`,
    provider: 'saaqis',
    stationId: 'cape-town',
    name: 'Cape Town',
    zone: 'Western Cape',
    ...CAPE_TOWN,
    parameter,
    scale: parameter,
    units: parameter === 'CO' ? 'mg/m³' : 'µg/m³',
    value,
    label: `${value}`,
    kind: 'observation',
    averagingMinutes: 60,
    observedMs: Date.now() - 10 * 60_000,
    color: '#8cb4ce',
  }));

/** The field the fake host gives at each step: the model's values. */
const NOW_VALUES = {
  pm25: 8,
  pm10: 20,
  o3: 70,
  no2: 15,
  so2: 4,
  co: 0.3,
  aqi: 44,
};
const LATER_VALUES = {
  pm25: 40,
  pm10: 60,
  o3: 130,
  no2: 70,
  so2: 50,
  co: 2,
  aqi: 112,
};
const WORLD = { width: 4, height: 3, lon0: 0, lat0: 90, step: 90, wrap: true };

/**
 * A host's field: a run six hours old with steps 0, 3, 6 (now) and 24, the
 * same values everywhere at each step.
 */
function hostField({ run = Date.now() - 6 * HOUR, europe = false } = {}) {
  const calls = { manifest: [], step: [] };
  const inset = {
    width: 10,
    height: 10,
    lon0: 10.5,
    lat0: -29.5,
    step: 1,
    wrap: false,
    steps: [0, 3, 6, 24],
    rectangle: { west: 10, south: -40, east: 20, north: -29 },
    blendDeg: 3,
  };
  const manifest = {
    source: 'CAMS',
    run: new Date(run).toISOString(),
    scale: SCALE,
    global: { ...WORLD, steps: [0, 3, 6, 24] },
    ...(europe ? { europe: inset } : {}),
  };
  const at = (step) => (step === 24 ? LATER_VALUES : NOW_VALUES);
  return {
    run,
    calls,
    source: {
      async getManifest(options = {}) {
        calls.manifest.push(options);
        return manifest;
      },
      async getStep(step, options = {}) {
        calls.step.push({ step, run: options.run });
        const grids = (region) => gridsOf(region, (x, y, id) => at(step)[id]);
        return {
          global: grids(WORLD),
          ...(europe ? { europe: grids(inset) } : {}),
        };
      },
    },
  };
}

/** Let every pending answer land. */
const settle = async () => {
  for (let turn = 0; turn < 8; turn++)
    await new Promise((resolve) => setImmediate(resolve));
};

/** A layer over Cape Town with a SAAQIS station there and `fieldSource`. */
function fieldHarness({
  fieldSource = null,
  clock = createWorldClock(),
  renderer = {},
} = {}) {
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 10, south: -40, east: 30, north: -25 }),
      pose: () => ({ height: 2_000_000 }),
    },
    query: {
      pickEllipsoid: (x, y) =>
        fromDegrees(
          CAPE_TOWN.lon + (x - 400) * 0.001,
          CAPE_TOWN.lat + (300 - y) * 0.001,
        ),
      isOccluded: () => false,
    },
    ...renderer,
  });
  const layer = createAirQualityLayer({
    source: {
      definitions: [SAAQIS],
      getSnapshot: async () => capeTown(),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    fieldSource,
    clock,
  });
  layer.init(viewer);
  layer.enable();
  const points = () => draw.find('air-quality:points:');
  return { layer, clock, draw, points, viewer };
}

const tileOf = (controls, group, id) =>
  controls.sublists
    .find((entry) => entry.id === group)
    .tiles.find((entry) => entry.id === id);
/** "MM-DD HH:MM UTC", as the card writes a time in English. */
const utcText = (ms) =>
  `${formatUtcDayMonth(ms)} ${new Date(ms).toISOString().slice(11, 16)} UTC`;

test('with a field the layer registers its span with the world clock', async () => {
  const host = hostField();
  const { layer, clock } = fieldHarness({ fieldSource: host.source });
  await layer.update();
  await settle();
  const span = clock.coverage();
  assert.equal(span.start, host.run);
  assert.equal(span.end, host.run + 24 * HOUR);
  // It follows the clock while the field is on the map.
  assert.equal(clock.follows('air-quality'), true);
  assert.equal(clock.getState().supported, true);
  // The step shown is the one nearest now, from the run the manifest names.
  assert.deepEqual(host.calls.step, [
    { step: 6, run: new Date(host.run).toISOString() },
  ]);
  // Off, the layer lets the clock go; on again, it follows it again.
  layer.disable();
  assert.equal(clock.coverage(), null);
  assert.equal(clock.follows('air-quality'), false);
  layer.enable();
  await layer.update();
  await settle();
  assert.equal(clock.follows('air-quality'), true);
  layer.destroy();
  assert.equal(clock.coverage(), null);
  assert.equal(clock.follows('air-quality'), false);
});

test('without a field the layer registers nothing', async () => {
  for (const fieldSource of [
    null,
    {
      getManifest: async () => {
        throw Object.assign(new Error('Model field not configured'), {
          code: 'not_configured',
        });
      },
      getStep: async () => assert.fail('no step without a manifest'),
    },
  ]) {
    const real = createWorldClock();
    const registered = [];
    const clock = {
      ...real,
      register(source) {
        registered.push(source);
        return real.register(source);
      },
    };
    const { layer } = fieldHarness({ fieldSource, clock });
    await layer.update();
    await settle();
    await layer.update();
    await settle();
    assert.deepEqual(registered, []);
    assert.equal(real.coverage(), null);
    assert.equal(real.follows('air-quality'), false);
    // The card is the stations' card: the nearest station, no model line.
    const controls = layer.getRowControls();
    assert.equal(controls.sublists[0].subtitle, 'nearest station · Cape Town');
    assert.match(controls.summary.detail, /^SAAQIS · updated /);
    assert.equal(
      controls.summary.lines.some((line) => /Model field/.test(line.text)),
      false,
    );
  }
});

test('away from now stations are hidden', async () => {
  const host = hostField();
  const { layer, clock, points } = fieldHarness({ fieldSource: host.source });
  await layer.update();
  await settle();
  assert.equal(points().show, true);
  assert.equal(layer.getRowControls().summary.status, '1 station');
  // A forecast time: no station has measured it.
  clock.seek(host.run + 24 * HOUR);
  await settle();
  assert.equal(points().show, false);
  let controls = layer.getRowControls();
  assert.equal(controls.summary.status, '');
  assert.deepEqual(controls.list.items, []);
  // A past time: neither.
  clock.seek(host.run);
  await settle();
  assert.equal(points().show, false);
  // A station selected away from now does not head the card.
  layer.setParams({ station: 'saaqis:cape-town:aqi' });
  clock.seek(host.run + 24 * HOUR);
  await settle();
  controls = layer.getRowControls();
  assert.equal(controls.summary.result, null);
  assert.equal(controls.sublists[0].subtitle, 'model at view centre');
  // Back at now they are shown again, the selection with them.
  clock.goLive();
  await settle();
  assert.equal(points().show, true);
  assert.equal(
    layer.getRowControls().sublists[0].subtitle,
    'measured at the station',
  );
});

test('with a field the tiles read the model at the view centre, and the time line names the model', async () => {
  const host = hostField();
  const { layer, clock } = fieldHarness({ fieldSource: host.source });
  await layer.update();
  await settle();
  let controls = layer.getRowControls();
  // Modelled values, said so, never as a station's.
  assert.equal(controls.sublists[0].subtitle, 'model at view centre');
  assert.equal(tileOf(controls, 'index', 'aqi').value, '44');
  assert.equal(tileOf(controls, 'index', 'aqi').note, 'Good');
  assert.equal(tileOf(controls, 'pollutants', 'PM2.5').value, '8.0');
  assert.equal(tileOf(controls, 'pollutants', 'CO').value, '0.30');
  // At now: the model and how old its run is.
  assert.equal(controls.summary.detail, 'CAMS · updated 6h ago');
  // Scrubbing on to +24 h draws that step: the tiles change.
  const later = host.run + 24 * HOUR;
  clock.seek(later);
  await settle();
  controls = layer.getRowControls();
  assert.equal(tileOf(controls, 'index', 'aqi').value, '112');
  assert.equal(tileOf(controls, 'pollutants', 'PM2.5').value, '40');
  assert.equal(tileOf(controls, 'pollutants', 'PM2.5').note, 'Moderate');
  assert.equal(
    controls.summary.detail,
    `CAMS · forecast for ${utcText(later)}`,
  );
  // A past step of the run: its time.
  clock.seek(host.run);
  await settle();
  controls = layer.getRowControls();
  assert.equal(controls.summary.detail, `CAMS · ${utcText(host.run)}`);
  assert.equal(tileOf(controls, 'index', 'aqi').value, '44');
  // A selected station at now: its own measured values.
  clock.goLive();
  await settle();
  layer.setParams({ station: 'saaqis:cape-town:aqi' });
  controls = layer.getRowControls();
  assert.equal(controls.sublists[0].subtitle, 'measured at the station');
  assert.equal(tileOf(controls, 'pollutants', 'PM2.5').value, '12');
});

test('the field draws through the imagery host: images on the globe, raised shells on 3D tiles', async (t) => {
  // The page's canvas, as far as painting needs one.
  const canvases = [];
  const previous = globalThis.document;
  globalThis.document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (width, height) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData(image) {
            canvas.painted = image.data;
          },
        }),
        toDataURL: () => `data:image/png;base64,${canvases.length}`,
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  t.after(() => {
    globalThis.document = previous;
  });
  const imagery = [];
  const shells = [];
  const host = hostField({ europe: true });
  const { layer, clock, draw } = fieldHarness({
    fieldSource: host.source,
    renderer: {
      globe: {
        imagery: {
          add(spec) {
            const entry = {
              spec,
              alpha: 1,
              show: true,
              removed: false,
              remove() {
                entry.removed = true;
              },
            };
            imagery.push(entry);
            return entry;
          },
        },
      },
    },
  });
  draw.field = (spec) => {
    const entry = {
      spec,
      show: true,
      updates: [],
      disposed: false,
      update(patch) {
        entry.updates.push(patch);
      },
      on: () => () => {},
      dispose() {
        entry.disposed = true;
      },
    };
    shells.push(entry);
    return entry;
  };
  await layer.update();
  await settle();
  // On the globe: the global image, then the Europe inset over it, with the
  // weather imagery's scalar field order.
  const live = () => imagery.filter((entry) => !entry.removed);
  assert.deepEqual(
    live().map((entry) => [
      entry.spec.kind,
      entry.spec.zOrder,
      entry.spec.rectangle,
    ]),
    [
      [
        'single-image',
        WEATHER_IMAGERY_Z.wind,
        { west: -180, south: -90, east: 180, north: 90 },
      ],
      [
        'single-image',
        WEATHER_IMAGERY_Z.wind,
        { west: 10, south: -40, east: 20, north: -29 },
      ],
    ],
  );
  assert.ok(live().every((entry) => entry.drapeOn === 'surface'));
  // A new step replaces them; the stations' view (AQHI) has no field.
  clock.seek(host.run + 24 * HOUR);
  await settle();
  assert.equal(live().length, 2);
  assert.equal(imagery.length, 4);
  // On 3D tiles the same images are raised shells that rise with the camera.
  layer.attachShellServices({
    imageryHost: () => ({ collection: {}, kind: 'tileset' }),
  });
  await settle();
  assert.equal(live().length, 0);
  assert.deepEqual(
    shells.map((entry) => [entry.spec.kind, entry.spec.rectangle]),
    [
      ['rasterShell', { west: -180, south: -90, east: 180, north: 90 }],
      ['rasterShell', { west: 10, south: -40, east: 20, north: -29 }],
    ],
  );
  assert.ok(shells.every((entry) => entry.updates.some((u) => 'liftM' in u)));
  layer.disable();
  assert.ok(shells.every((entry) => entry.disposed));
  assert.equal(live().length, 0);
});
