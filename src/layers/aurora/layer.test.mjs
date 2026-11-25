import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuroraLayer, createAuroraSource } from './index.js';
import { SWPC_ORIGIN, SWPC_PATHS } from './source.js';

function ovationPayload(valueAt = () => 0) {
  const coordinates = [];
  for (let lon = 0; lon < 360; lon++)
    for (let lat = -90; lat <= 90; lat++)
      coordinates.push([lon, lat, valueAt(lon, lat)]);
  return {
    'Observation Time': '2026-11-24T15:52:00Z',
    'Forecast Time': '2026-11-24T17:13:00Z',
    coordinates,
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function swpcFetch(overrides = {}) {
  const calls = [];
  const bodies = {
    ovation: () =>
      json(ovationPayload((lon, lat) => (lat >= 58 && lat <= 70 ? 45 : 0))),
    kp: () => json([{ time_tag: '2026-11-24T12:00:00', Kp: 5.33 }]),
    scales: () =>
      json({ 0: { R: { Scale: '0' }, S: { Scale: '0' }, G: { Scale: '1' } } }),
    speed: () =>
      json([{ proton_speed: 612, time_tag: '2026-11-24T15:55:00Z' }]),
    field: () =>
      json([{ bt: 11, bz_gsm: -8, time_tag: '2026-11-24T15:55:00Z' }]),
    ...overrides,
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    const name = Object.keys(SWPC_PATHS).find(
      (key) => url === `${SWPC_ORIGIN}${SWPC_PATHS[key]}`,
    );
    assert.ok(name, `unexpected request ${url}`);
    return bodies[name]();
  };
  return { fetchImpl, calls };
}

test('the source reads all five SWPC products and tolerates optional failures', async () => {
  const { fetchImpl, calls } = swpcFetch({
    kp: () => json({}, 503),
    field: () => {
      throw new TypeError('offline');
    },
  });
  const snapshot = await createAuroraSource({ fetchImpl }).getSnapshot();
  assert.equal(calls.length, 5);
  assert.equal(snapshot.kp, null);
  assert.deepEqual(snapshot.scales, { r: 0, s: 0, g: 1 });
  assert.equal(snapshot.solarWind.speedKms, 612);
  assert.equal(snapshot.solarWind.bzNt, null);
  assert.equal(snapshot.forecastAt, Date.parse('2026-11-24T17:13:00Z'));
});

test('an OVATION failure is the source failure, retryable when the server is', async () => {
  const unavailable = swpcFetch({ ovation: () => json({}, 503) });
  await assert.rejects(
    createAuroraSource(unavailable).getSnapshot(),
    (error) =>
      error.message === 'NOAA SWPC HTTP 503' && error.retryable === true,
  );
  const missing = swpcFetch({ ovation: () => json({}, 404) });
  await assert.rejects(
    createAuroraSource(missing).getSnapshot(),
    (error) => error.retryable === false,
  );
});

function fakeRenderer() {
  const fields = [];
  const renders = [];
  const viewer = {};
  const drawOf = () => ({
    field(spec) {
      const handle = {
        spec: { ...spec },
        updates: [],
        show: true,
        disposed: false,
        update(patch) {
          this.updates.push(patch);
          Object.assign(this.spec, patch);
        },
        dispose() {
          this.disposed = true;
        },
      };
      fields.push(handle);
      return handle;
    },
  });
  const frameOf = () => ({ requestRender: (reason) => renders.push(reason) });
  const createCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      painted: null,
      getContext: () => ({
        createImageData: (width, height) => ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData: (image) => {
          canvas.painted = image;
        },
      }),
    };
    return canvas;
  };
  return { viewer, drawOf, frameOf, createCanvas, fields, renders };
}

test('the layer draws one raised world shell and refreshes its image in place', async () => {
  const renderer = fakeRenderer();
  const { fetchImpl } = swpcFetch();
  const layer = createAuroraLayer({
    source: createAuroraSource({ fetchImpl }),
    now: () => Date.parse('2026-11-24T16:00:00Z'),
    ...renderer,
  });
  layer.init(renderer.viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(renderer.fields.length, 1);
  const [field] = renderer.fields;
  assert.equal(field.spec.kind, 'rasterShell');
  assert.deepEqual(field.spec.rectangle, {
    west: -180,
    south: -90,
    east: 180,
    north: 90,
  });
  assert.equal(field.spec.heightM, 110_000);
  const canvas = field.spec.image.canvas;
  assert.equal(canvas.width, 360);
  assert.equal(canvas.height, 180);
  // The oval is painted: 65°N has colour, the equator none.
  const alpha = (north) => canvas.painted.data[(90 - north) * 360 * 4 + 3];
  assert.ok(alpha(65) > 0);
  assert.equal(alpha(0), 0);
  assert.deepEqual(renderer.renders, ['aurora']);

  const stats = layer.getStats();
  assert.equal(stats.kp, 5.33);
  assert.deepEqual(stats.scales, { r: 0, s: 0, g: 1 });
  assert.deepEqual(stats.reach, { north: 58, south: null });
  assert.equal(stats.count, 13 * 360);
  assert.equal(stats.stale, false);
  assert.equal(stats.error, null);
  const row = layer.getRowControls();
  assert.match(row.info, /Kp 5\.3/);
  assert.match(row.info, /G1 R0 S0/);
  assert.match(row.info, /612 km\/s/);
  assert.match(row.info, /Bz −8 nT/);
  assert.match(row.info, /58°N/);
  assert.match(row.info, /17:13 UTC/);
  assert.equal(row.legend.length, 3);

  const firstKey = field.spec.image.key;
  assert.equal(await layer.update(), true);
  assert.equal(renderer.fields.length, 1, 'no second shell');
  assert.notEqual(field.spec.image.key, firstKey);

  layer.disable();
  assert.equal(field.show, false);
  layer.enable();
  assert.equal(field.show, true);
  layer.destroy();
  assert.equal(field.disposed, true);
});

test('a failed refresh keeps the last forecast and reports the error', async () => {
  const renderer = fakeRenderer();
  let fail = false;
  const { fetchImpl } = swpcFetch({
    ovation: () => (fail ? json({}, 502) : json(ovationPayload(() => 20))),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const layer = createAuroraLayer({
      source: createAuroraSource({ fetchImpl }),
      ...renderer,
    });
    layer.init(renderer.viewer);
    layer.enable();
    assert.equal(await layer.update(), true);
    fail = true;
    assert.equal(await layer.update(), true);
    assert.equal(renderer.fields.length, 1);
    assert.equal(renderer.fields[0].disposed, false);
    assert.equal(layer.getStats().error, 'NOAA SWPC HTTP 502');
    assert.equal(layer.getStats().count, 360 * 181);
    assert.match(layer.getRowControls().info, /HTTP 502/);
    fail = false;
    assert.equal(await layer.update(), true);
    assert.equal(layer.getStats().error, null);
  } finally {
    console.warn = warn;
  }
});

test('a permanent refusal with nothing drawn fails the enable', async () => {
  const renderer = fakeRenderer();
  const { fetchImpl } = swpcFetch({ ovation: () => json({}, 404) });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const layer = createAuroraLayer({
      source: createAuroraSource({ fetchImpl }),
      ...renderer,
    });
    layer.init(renderer.viewer);
    layer.enable();
    assert.equal(await layer.update(), false);
    assert.equal(renderer.fields.length, 0);
  } finally {
    console.warn = warn;
  }
});

test('the layer needs a snapshot source', () => {
  assert.throws(() => createAuroraLayer({}), /snapshot source/);
});
