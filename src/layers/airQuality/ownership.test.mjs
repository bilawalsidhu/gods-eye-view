import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { STALE_AFTER_MS } from './model.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { onAqiPeriods } from '../../testSupport/airQualityViewer.mjs';

/** One station network measuring PM2.5, the provider of these readings. */
const NETWORK = Object.freeze({
  id: 'regional',
  title: 'Regional',
  label: 'Air quality · Regional',
  network: 'Regional network',
  parameters: ['PM2.5'],
});

function harness(source, renderer = {}, panel = null) {
  const events = [];
  const viewer = {};
  const { draw } = bindFakeDraw(viewer, renderer);
  const layer = createAirQualityLayer({
    source: { definitions: [NETWORK], ...source },
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer, { panel });
  layer.enable(viewer);
  const markers = () => draw.find('air-quality:points:');
  return { layer, viewer, draw, markers, events };
}

/** A PM2.5 concentration (µg/m³) at a station of the network. */
const reading = (id, value, overrides = {}) => ({
  id: `regional:${id}:PM2.5`,
  provider: 'regional',
  stationId: id,
  name: id,
  zone: 'Ontario',
  lat: 43.65,
  lon: -79.38,
  parameter: 'PM2.5',
  scale: 'PM2.5',
  units: 'µg/m³',
  value,
  kind: 'observation',
  averagingMinutes: 60,
  // Recent: a reading older than six hours is not drawn.
  observedMs: Date.now() - 10 * 60_000,
  color: '#8cb4ce',
  label: String(value),
  ...overrides,
});

/** Rows in the AQI view on its averaging periods (`onAqiPeriods`). */
const staticSource = (rows) => ({
  getSnapshot: async (request) =>
    request?.mode === 'aqi' ? onAqiPeriods(rows) : rows,
});

test('a layer requires both a snapshot source and an overlay host', () => {
  assert.throws(() => createAirQualityLayer(), /snapshot source/);
  assert.throws(
    () => createAirQualityLayer({ source: staticSource([]) }),
    /overlay host/,
  );
});

test('a source that names no providers is one station network', async () => {
  // A plain source is asked as one station network in the AQI view.
  for (const definitions of [undefined]) {
    const calls = [];
    const viewer = {};
    const { draw } = bindFakeDraw(viewer);
    const layer = createAirQualityLayer({
      source: {
        definitions,
        getSnapshot: async (request) => {
          calls.push(request);
          return [reading('A', 12)];
        },
      },
      overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    });
    assert.equal(layer.getParams().view, 'aqi');

    layer.init(viewer);
    layer.enable();
    assert.equal(await layer.update(), true);
    assert.deepEqual(
      calls.map(({ provider, mode }) => [provider, mode]),
      [['air-quality', 'aqi']],
    );
    assert.deepEqual(
      [...draw.find('air-quality:points:').items.keys()],
      ['air-quality:regional:A:aqi'],
    );
    assert.equal(draw.find('air-quality:points:').items.size, 1);
    assert.equal(
      [...draw.sets.values()].some((set) => set.kind === 'shapes'),
      false,
    );
    assert.notEqual(layer.setParams({ view: 'NO2' }), false);
    layer.destroy();
  }
  // An explicit empty list names no network: refused, as the source
  // composition refuses it.
  assert.throws(
    () =>
      createAirQualityLayer({
        source: { definitions: [], getSnapshot: async () => [] },
        overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
      }),
    { name: 'TypeError', message: /requires providers/ },
  );
});

test('initialization is single-use and owns one point draw set', () => {
  const { layer, viewer, draw, markers } = harness(staticSource([]));
  const owned = markers();
  assert.equal(owned.kind, 'points');
  assert.equal(
    [...draw.sets.values()].filter((set) => !set.disposed).length,
    1,
  );
  assert.throws(() => layer.init(viewer), /already initialized/);
  layer.destroy(viewer);
  assert.equal(owned.disposed, true);
  assert.ok([...draw.sets.values()].every((set) => set.disposed));
});

test('stations are ground points in their US AQI colour, shown only while enabled', async () => {
  // Apart from each other: neither joins a group.
  const { layer, markers } = harness(
    staticSource([
      reading('A', 2),
      reading('B', 60, { lat: 49.28, lon: -123.12 }),
    ]),
  );
  assert.equal(await layer.update(), true);
  const set = markers();
  assert.equal(set.show, true);
  assert.deepEqual(
    [...set.items.keys()],
    ['air-quality:regional:A:aqi', 'air-quality:regional:B:aqi'],
  );
  const point = set.items.get('air-quality:regional:B:aqi');
  assert.deepEqual(point.pos, { lon: -123.12, lat: 49.28, height: 0 });
  assert.equal(point.height, 'clampGround');
  // PM2.5 60 µg/m³ is a US AQI of 154: Unhealthy.
  assert.equal(point.color, '#ff0000');
  assert.equal(point.meta.name, 'B');
  assert.equal(point.meta.value, 154);
  assert.equal(set.items.get('air-quality:regional:A:aqi').color, '#00e400');
  layer.disable();
  assert.equal(set.show, false);
  layer.enable();
  assert.equal(set.show, true);
  assert.equal(await layer.update(), true);
  assert.equal(set.items.size, 2, 'a refresh replaces, not appends');
});

test('the readout lists only readings inside the camera port view rectangle', async () => {
  const { layer } = harness(
    staticSource([
      reading('Toronto', 2),
      reading('Vancouver', 4, { lat: 49.28, lon: -123.12 }),
    ]),
    {
      camera: {
        on: () => () => {},
        viewRectangle: () => ({ west: -90, south: 40, east: -70, north: 50 }),
      },
    },
  );
  await layer.update();
  assert.deepEqual(
    layer.getRowControls().list.items.map((item) => item.text),
    ['Toronto'],
  );
});

test('a refresh renders readings and publishes an overlay cohort', async () => {
  const { layer, events } = harness(
    staticSource([reading('A', 2), reading('B', 7)]),
  );
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().error, null);
  assert.equal(events.at(-1)[0], 'air-quality');
});

// ── the abort + enabled guard ──────────────────────────────────────────────

test('a response landing after disable cannot redraw the scene', async () => {
  // The failure this prevents: disable() clears the overlay, then an in-flight
  // response resolves and repopulates it behind the user's back.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { layer, events } = harness({
    getSnapshot: async ({ signal } = {}) => {
      await gate;
      signal?.throwIfAborted();
      return [reading('A', 5)];
    },
  });
  const pending = layer.update();
  layer.disable();
  const publishedBefore = events.length;
  release();
  assert.equal(await pending, false, 'a late response must not be applied');
  assert.equal(
    events.length,
    publishedBefore,
    'no overlay write after disable',
  );
  assert.equal(layer.getStats().count, 0);
});

test('disable aborts the request in flight', async () => {
  let seenSignal = null;
  const { layer } = harness({
    getSnapshot: async ({ signal } = {}) => {
      seenSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 40));
      signal?.throwIfAborted();
      return [];
    },
  });
  const pending = layer.update();
  layer.disable();
  await pending;
  assert.ok(seenSignal, 'a signal was passed through to the source');
  assert.equal(seenSignal.aborted, true);
});

test('a superseded refresh does not clobber the newer one', async () => {
  let call = 0;
  const { layer } = harness({
    getSnapshot: async ({ signal } = {}) => {
      call += 1;
      const mine = call;
      await new Promise((resolve) => setTimeout(resolve, mine === 1 ? 40 : 1));
      signal?.throwIfAborted();
      return [reading(`call-${mine}`, mine)];
    },
  });
  const first = layer.update();
  const second = layer.update();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(
    firstResult,
    true,
    'supersession is not a failed lifecycle enable; the newer request owns data',
  );
  assert.equal(secondResult, true);
  assert.equal(layer.getAnalystRecords()[0].name, 'call-2');
});

test('update is a no-op while the layer is disabled', async () => {
  const { layer } = harness(staticSource([reading('A', 2)]));
  layer.disable();
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().count, 0);
});

// ── readout descriptor ─────────────────────────────────────────────────────

test('the readout descriptor carries the US AQI ramp and coverage', async () => {
  const { layer } = harness(
    staticSource([
      reading('A', 2),
      reading('B', 60, { lat: 43.7, lon: -79.4 }),
    ]),
  );
  await layer.update();
  const controls = layer.getRowControls();
  assert.equal(controls.readout, true);
  // The network's place, by its title.
  assert.equal(controls.summary.coverage, 'Regional');
  // The Weather panel's legend shape: one {color, label} per band, a ramp.
  assert.equal(controls.legendCategorical, false);
  assert.deepEqual(
    controls.legend.map((entry) => entry.label),
    ['0', '50', '100', '150', '200', '300+'],
  );
  assert.ok(
    controls.legend.every((entry) => /^#[0-9a-f]{6}$/i.test(entry.color)),
  );
  // Worst first, and every item keyed.
  assert.deepEqual(
    controls.list.items.map((i) => [i.lead, i.text]),
    [
      ['154', 'B'],
      ['11', 'A'],
    ],
  );
  assert.ok(controls.list.items.every((i) => i.id));
  assert.equal(controls.summary.status, '2 stations');
});

test('the readout reports an error rather than a silent empty card', async () => {
  const { layer } = harness({
    getSnapshot: async () => {
      throw new Error('Air quality provider unavailable');
    },
  });
  await layer.update();
  // The card names the network; the error itself stays the layer's.
  assert.deepEqual(layer.getRowControls().summary.lines, [
    {
      id: 'provider-regional',
      muted: true,
      text: 'Regional network unavailable',
    },
  ]);
  assert.equal(layer.getStats().error, 'Air quality provider unavailable');
});

test('a refresh invalidates the panel, and teardown lets the handle go', async () => {
  let calls = 0;
  const { layer, viewer } = harness(
    staticSource([reading('A', 2)]),
    {},
    { invalidate: () => (calls += 1) },
  );
  await layer.update();
  assert.ok(calls >= 1, 'a refresh notifies the card');
  layer.destroy(viewer);
  const after = calls;
  await layer.update().catch(() => {});
  assert.equal(calls, after, 'a destroyed layer never invalidates');
});

// ── feed-state honesty ─────────────────────────────────────────────────────

test('freshness is judged on observation time, not on when we last fetched', async () => {
  // lastUpdate stays current every time the network answers, even when it
  // answers with nothing new. Judging freshness on it would let the HUD and
  // voice describe hours-old air quality as live.
  const aged = Date.now() - STALE_AFTER_MS - 60_000;
  const { layer } = harness(
    staticSource([reading('A', 2, { observedMs: aged })]),
  );
  await layer.update();
  const stats = layer.getStats();
  assert.ok(
    stats.lastUpdate >= Date.now() - 5_000,
    'we did just receive a response',
  );
  assert.equal(stats.observedAt, aged, 'but the observation itself is old');
  assert.equal(stats.stale, true);
  assert.equal(
    layerFeedState(stats),
    'stale',
    'provenance must not read this as nominal',
  );
});

test('a current reading reports nominal', async () => {
  const { layer } = harness(
    staticSource([reading('A', 2, { observedMs: Date.now() - 10 * 60_000 })]),
  );
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.stale, false);
  assert.equal(layerFeedState(stats), 'nominal');
});

test('a refresh that kept no current observation reports stale, not nominal', async () => {
  // Every observation older than OBSERVATION_MAX_AGE_MS is dropped, so a feed
  // that only has hours-old rows yields an empty snapshot. That is the
  // stalest a feed can be; it must not read as a healthy empty layer.
  const { layer } = harness(staticSource([]));
  assert.equal(layer.getStats().stale, false, 'no refresh yet, no verdict');
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.observedAt, null);
  assert.equal(stats.stale, true);
  assert.equal(layerFeedState(stats), 'stale');
  assert.equal(layer.getRowControls().summary.status, '0 stations');
});

test('a failed refresh over good readings reports degraded, not nominal', async () => {
  let fail = false;
  const { layer } = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Air quality provider unavailable');
      return [reading('A', 2, { observedMs: Date.now() - 10 * 60_000 })];
    },
  });
  await layer.update();
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
  fail = true;
  await layer.update();
  const stats = layer.getStats();
  assert.ok(stats.count > 0, 'the previous readings are still displayed');
  assert.equal(
    layerFeedState(stats),
    'degraded',
    'showing old data after a failure is degraded',
  );
});

test('a pollutant view draws its observations as points and dispose lets go of them', async () => {
  const row = reading('sample', 12, {
    provider: 'custom',
    scale: 'PM2.5',
    assessment: { label: 'Good' },
  });
  const { layer, draw } = harness({
    definitions: [
      {
        id: 'custom',
        observation: true,
        parameters: ['PM2.5'],
        network: 'Test network',
      },
    ],
    getSnapshot: async () => [row],
  });
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  const points = [...draw.sets.values()].find((set) => set.kind === 'points');
  const point = points.items.get(`air-quality:${row.id}`);
  assert.deepEqual(point.pos, { lon: row.lon, lat: row.lat, height: 0 });
  assert.equal(point.color, row.color);
  assert.equal(point.height, 'clampGround');
  assert.equal(point.meta.assessment.label, 'Good');
  assert.equal(points.show, true);
  layer.disable();
  assert.equal(points.show, false);
  layer.destroy();
  assert.ok([...draw.sets.values()].every((set) => set.disposed));
});

test('viewport discovery takes degree bounds and map focus from renderer ports', async () => {
  const { fromDegrees } = await import('../../geo/ellipsoid.js');
  const requests = [];
  const picks = [];
  let removed = false;
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  bindFakeDraw(viewer, {
    camera: {
      viewRectangle: () => ({ west: 170, south: -20, east: -170, north: 20 }),
      on(event) {
        assert.equal(event, 'moveEnd');
        return () => {
          removed = true;
        };
      },
    },
    query: {
      pickEllipsoid(x, y) {
        picks.push([x, y]);
        return fromDegrees(178, -5);
      },
      isOccluded: () => false,
    },
  });
  const layer = createAirQualityLayer({
    source: {
      definitions: [
        {
          id: 'custom',
          observation: true,
          viewDriven: true,
          parameters: ['PM2.5'],
          network: 'Test',
        },
      ],
      getSnapshot: async (request) => {
        requests.push(request);
        return [];
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.deepEqual(requests[0].view, [170, -20, -170, 20, 178, -5]);
  assert.deepEqual(picks[0], [400, 300]);
  layer.destroy();
  assert.equal(removed, true);
});

// ── one station view across providers ──────────────────────────────────────

const definition = (id, extra = {}) => ({
  id,
  title: id,
  label: `Air quality · ${id}`,
  network: id.toUpperCase(),
  coverage: id,
  observation: true,
  direct: true,
  parameters: ['PM2.5', 'NO2'],
  ...extra,
});

const observed = (provider, id, lat, lon) =>
  reading(id, 12, {
    id: `${provider}:${id}`,
    provider,
    scale: 'PM2.5',
    parameter: 'PM2.5',
    kind: 'observation',
    units: 'µg/m³',
    lat,
    lon,
    observedMs: Date.now() - 10 * 60_000,
    color: '#50f0e6',
    assessment: { label: 'Good', severity: 0 },
  });

function multiProvider(answers) {
  const calls = [];
  const pending = new Map();
  const { layer, draw } = harness({
    definitions: [
      definition('openaq', { direct: false, requiresKeyId: 'openaq' }),
      definition('national'),
      definition('regional', { parameters: ['PM2.5'] }),
    ],
    getSnapshot: (request) => {
      calls.push(request);
      return new Promise((resolve, reject) =>
        pending.set(request.provider, () =>
          answers[request.provider] instanceof Error
            ? reject(answers[request.provider])
            : resolve(
                request.mode === 'aqi'
                  ? onAqiPeriods(answers[request.provider] ?? [])
                  : (answers[request.provider] ?? []),
              ),
        ),
      );
    },
  });
  const settle = () => {
    for (const [id, release] of pending) {
      pending.delete(id);
      release();
    }
  };
  const drawn = (kind) =>
    [...draw.sets.values()].find((set) => set.kind === kind && !set.disposed);
  return { layer, calls, settle, drawn };
}

test('every observation provider is asked in parallel and drawn as one de-duplicated set', async () => {
  const { layer, calls, settle, drawn } = multiProvider({
    openaq: [
      observed('openaq', 'copy', -33.9249, 18.4241),
      observed('openaq', 'paris', 48.85, 2.35),
    ],
    national: [observed('national', 'cape-town', -33.925, 18.4242)],
    regional: [observed('regional', 'durban', -29.86, 31.03)],
  });
  assert.equal(layer.getParams().view, 'aqi');
  const pending = layer.update();
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['openaq', 'national', 'regional'],
    'all asked before any answers',
  );
  settle();
  assert.equal(await pending, true);
  // The AQI view draws one reading per station.
  assert.deepEqual([...drawn('points').items.keys()].sort(), [
    'air-quality:national:cape-town:aqi',
    'air-quality:openaq:paris:aqi',
    'air-quality:regional:durban:aqi',
  ]);
  assert.equal(layer.getStats().count, 3);
  // PM2.5 12 µg/m³ is a US AQI of 56, Moderate, on its own scale.
  assert.ok(
    [...drawn('points').items.values()].every(
      (point) =>
        point.color === '#ffff00' &&
        point.meta.aqi.index === 56 &&
        !point.meta.assessment,
    ),
  );
});

test('a provider without its key, or failing, does not blank the others', async () => {
  const { layer, settle } = multiProvider({
    openaq: Object.assign(new Error('Provider API key required'), {
      code: 'no_key',
    }),
    national: [observed('national', 'cape-town', -33.925, 18.4242)],
    regional: new Error('Air quality provider unavailable'),
  });
  const pending = layer.update();
  settle();
  assert.equal(await pending, true);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);
  const states = Object.fromEntries(
    layer.getProviderStates().map((state) => [state.id, state]),
  );
  assert.equal(states.openaq.status, 'no-key');
  assert.match(states.openaq.error, /Provider Settings/);
  assert.equal(states.national.status, 'ok');
  assert.equal(states.national.count, 1);
  assert.equal(states.regional.status, 'failed');
  assert.equal(layer.getRowControls().summary.status, '1 station');
});

test('when every provider fails the layer reports the error', async () => {
  const failure = new Error('Air quality provider unavailable');
  const { layer, settle } = multiProvider({
    openaq: failure,
    national: failure,
    regional: failure,
  });
  const pending = layer.update();
  settle();
  // The US AQI asks every network: no other view is on offer.
  assert.equal(await pending, false);
  assert.equal(layer.getStats().error, 'Air quality provider unavailable');
});

test('a pollutant view asks only the networks measuring it', async () => {
  const { layer, calls, settle, drawn } = multiProvider({
    openaq: [observed('openaq', 'paris', 48.85, 2.35)],
    national: [observed('national', 'cape-town', -33.925, 18.4242)],
  });

  layer.setParams({ view: 'NO2' });
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => [call.provider, call.parameter]),
    [
      ['openaq', 'NO2'],
      ['national', 'NO2'],
    ],
  );
  assert.equal(drawn('points').items.size, 2);
  assert.deepEqual(layer.getParams(), {
    view: 'NO2',
  });
});

test('the stations switch hides and shows the station markers', async () => {
  const { layer, settle, drawn } = multiProvider({
    national: [observed('national', 'cape-town', -33.925, 18.4242)],
  });
  const pending = layer.update();
  settle();
  await pending;
  layer.setParams({ stations: false });
  assert.equal(drawn('points').show, false);
  assert.equal(layer.getRowControls().summary.toggles[0].on, false);
  layer.setParams({ stations: true });
  assert.equal(drawn('points').show, true);
});

test('a scene shot keeps the stations switch; saved and shared params keep only the view', async () => {
  const { layer, settle, drawn } = multiProvider({
    national: [observed('national', 'cape-town', -33.925, 18.4242)],
  });
  const pending = layer.update();
  settle();
  await pending;
  layer.setParams({ stations: false });
  const shot = layer.getSceneParams();
  assert.deepEqual(shot, { view: 'aqi', stations: false });
  assert.deepEqual(layer.getParams(), { view: 'aqi' });
  // Played back, the shot hides the stations again.
  layer.setParams({ stations: true });
  layer.setParams(shot);
  assert.equal(drawn('points').show, false);
});

// ── stations cluster at far zoom ───────────────────────────────────────────

const pm25 = (id, lat, lon, concentration) =>
  reading(id, concentration, {
    id: `national:${id}`,
    provider: 'national',
    scale: 'PM2.5',
    parameter: 'PM2.5',
    kind: 'observation',
    units: 'µg/m³',
    lat,
    lon,
    observedMs: Date.now() - 10 * 60_000,
    color: '#a3cf62',
    assessment: { label: 'Fair', severity: 1, concentration },
  });

/**
 * A layer over a camera that sees `degPerPx` degrees per pixel around Paris
 * (the view centre, 400 × 300 on an 800 × 600 canvas).
 */
async function zoomHarness(
  rows,
  { view, picking = null, pointer = null, viewRect = null } = {},
) {
  const { fromDegrees } = await import('../../geo/ellipsoid.js');
  const zoom = { degPerPx: 0.5 };
  const camera = {
    rect: viewRect ?? { west: -180, south: -85, east: 180, north: 85 },
  };
  const moveEnd = [];
  const flights = [];
  const clicks = [];
  const labels = [];
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      on(event, listener) {
        if (event === 'moveEnd') moveEnd.push(listener);
        return () => {};
      },
      viewRectangle: () => camera.rect,
      flyTo(destination, options) {
        flights.push({ destination, options });
      },
    },
    query: {
      pickEllipsoid: (x, y) =>
        fromDegrees(
          2.35 + (x - 400) * zoom.degPerPx,
          48.85 + (300 - y) * zoom.degPerPx,
        ),
      isOccluded: () => false,
    },
  });
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition('national', { parameters: ['PM2.5'] })],
      getSnapshot: async (request) =>
        request?.mode === 'aqi' ? onAqiPeriods(rows) : rows,
    },
    overlayHost: {
      setEntries(source, entries) {
        labels.push(entries.map((entry) => entry.id));
      },
      setVisible() {},
      clearSource() {},
    },
    input: () => ({
      onClick(fn) {
        clicks.push(fn);
        return () => clicks.splice(clicks.indexOf(fn), 1);
      },
    }),
    picking,
    pointer,
  });
  layer.init(viewer);
  if (view) layer.setParams({ view });
  layer.enable();
  await layer.update();
  const points = () => draw.find('air-quality:points:');
  /** A click on a drawn item by id, or (null) on open map at `at`. */
  const click = (id, extra = {}) => {
    for (const fn of [...clicks])
      fn({
        screenPosition: { x: 1, y: 1 },
        gesture: { travelPx: 0, durationMs: 40 },
        drawHit: id ? { set: points().spec.id, id, surface: false } : null,
        surface: !id,
        ...extra,
      });
  };
  const zoomTo = (degPerPx) => {
    zoom.degPerPx = degPerPx;
    for (const listener of moveEnd) listener();
  };
  const bubbles = () =>
    [...points().items.values()].filter((item) => item.outlineWidth === 1.5);
  return {
    layer,
    points,
    bubbles,
    click,
    zoomTo,
    flights,
    clicks,
    camera,
    labels,
  };
}

const parisAndCapeTown = () => [
  pm25('paris-1', 48.85, 2.35, 10),
  pm25('paris-2', 48.9, 2.4, 60),
  pm25('paris-3', 48.8, 2.3, 35),
  pm25('cape-town', -33.92, 18.42, 10),
];

test('a dense view draws groups, a close view draws singles', async () => {
  const { points, bubbles, zoomTo } = await zoomHarness(parisAndCapeTown(), {
    view: 'PM2.5',
  });
  // About 15 degrees in 46 px at Paris: its three stations are one bubble.
  assert.equal(points().items.size, 2);
  const [bubble] = bubbles();
  assert.equal(bubble.pixelSize, Math.round(12 + 6 * Math.log10(3)));
  assert.deepEqual(bubble.outlineColor, [1, 1, 1, 0.85]);
  assert.equal(bubble.outlineWidth, 1.5);
  // The mean, 35 µg/m³, is Moderate on the EEA hourly bands; no member is.
  assert.equal(bubble.color, '#f2d45c');
  assert.ok(Math.abs(bubble.pos.lat - 48.85) < 1e-9);
  const single = points().items.get('air-quality:national:cape-town');
  assert.equal(single.pixelSize, 7);
  assert.equal(single.meta.name, 'cape-town');
  // Close in, the camera's move draws every station on its own.
  zoomTo(0.0001);
  assert.deepEqual([...points().items.keys()].sort(), [
    'air-quality:national:cape-town',
    'air-quality:national:paris-1',
    'air-quality:national:paris-2',
    'air-quality:national:paris-3',
  ]);
  assert.ok([...points().items.values()].every((item) => item.pixelSize === 7));
  zoomTo(0.5);
  assert.equal(points().items.size, 2, 'groups follow the camera back out');
});

test('unrated stations group in the neutral colour; the AQI view colours by the mean index', async () => {
  const unrated = (id, lat, lon) => ({
    ...pm25(id, lat, lon, 10),
    color: '#8cb4ce',
    assessment: { reason: 'not rated' },
  });
  const grey = await zoomHarness(
    [unrated('a', 48.85, 2.35), unrated('b', 48.9, 2.4)],
    { view: 'PM2.5' },
  );
  assert.equal(grey.points().items.size, 1);
  assert.equal(grey.bubbles()[0].color, '#8cb4ce');
  // PM2.5 12 µg/m³ is a US AQI of 56 at each station: Moderate.
  const aqi = await zoomHarness([
    observed('national', 'a', 48.85, 2.35),
    observed('national', 'b', 48.9, 2.4),
  ]);
  const [aqiBubble] = aqi.bubbles();
  assert.equal(aqiBubble.pixelSize, Math.round(12 + 6 * Math.log10(2)));
  assert.equal(aqiBubble.color, '#ffff00');
});

test('only single and selected stations keep their labels', async () => {
  const { layer, labels, zoomTo } = await zoomHarness(parisAndCapeTown(), {
    view: 'PM2.5',
  });
  assert.deepEqual(labels.at(-1), ['national:cape-town']);
  layer.setParams({ station: 'national:paris-2' });
  assert.deepEqual(labels.at(-1).sort(), [
    'national:cape-town',
    'national:paris-2',
  ]);
  zoomTo(0.0001);
  assert.equal(labels.at(-1).length, 4);
});

test('a click on a group flies to its stations and selects nothing', async () => {
  const { layer, bubbles, click, flights } = await zoomHarness(
    parisAndCapeTown(),
    { view: 'PM2.5' },
  );
  click(bubbles()[0].id);
  assert.equal(flights.length, 1);
  const { rect } = flights[0].destination;
  // 2.3–2.4 and 48.8–48.9, padded by at least 0.15 degrees.
  assert.ok(Math.abs(rect.west - 2.15) < 1e-9);
  assert.ok(Math.abs(rect.east - 2.55) < 1e-9);
  assert.ok(Math.abs(rect.south - 48.65) < 1e-9);
  assert.ok(Math.abs(rect.north - 49.05) < 1e-9);
  assert.deepEqual(flights[0].options, { durationS: 1.4 });
  assert.equal(layer.getRowControls().summary.result?.key ?? null, null);
});

test('a group click keeps a station already selected', async () => {
  const { layer, bubbles, click, flights } = await zoomHarness(
    parisAndCapeTown(),
    { view: 'PM2.5' },
  );
  layer.setParams({ station: 'national:cape-town' });
  click(bubbles()[0].id);
  assert.equal(flights.length, 1);
  assert.equal(
    layer.getRowControls().summary.result?.key ?? null,
    'national:cape-town',
  );
});

test('stations that cannot come apart: a click selects the higher and the camera stays', async () => {
  // About 10 m apart: one bubble at every zoom.
  const { layer, bubbles, click, flights } = await zoomHarness(
    [pm25('low', 48.85, 2.35, 20), pm25('high', 48.8501, 2.35, 80)],
    { view: 'PM2.5' },
  );
  click(bubbles()[0].id);
  assert.equal(flights.length, 0);
  assert.equal(
    layer.getRowControls().summary.result?.key ?? null,
    'national:high',
  );
});

test('a group larger than the view is not flown out to', async () => {
  const { layer, bubbles, click, flights } = await zoomHarness(
    parisAndCapeTown(),
    {
      view: 'PM2.5',
      viewRect: { west: 2.3, south: 48.82, east: 2.4, north: 48.88 },
    },
  );
  click(bubbles()[0].id);
  assert.equal(flights.length, 0);
  assert.equal(
    layer.getRowControls().summary.result?.key ?? null,
    'national:paris-2',
  );
});

test('a click on a station selects it, drawn large and never grouped', async () => {
  const { layer, points, bubbles, click, flights, zoomTo } = await zoomHarness(
    parisAndCapeTown(),
    { view: 'PM2.5' },
  );
  click('air-quality:national:cape-town');
  assert.equal(
    layer.getRowControls().summary.result?.key ?? null,
    'national:cape-town',
  );
  assert.equal(flights.length, 0);
  const selected = points().items.get('air-quality:national:cape-town');
  assert.equal(selected.pixelSize, 13);
  // Not a group's white ring: the UI accent.
  assert.equal(selected.outlineColor, '#36dcff');
  assert.equal(selected.outlineWidth, 2);
  // A Paris station selected close in stays apart from its neighbours when
  // the camera goes back out.
  layer.setParams({ station: 'national:paris-2' });
  zoomTo(0.5);
  assert.equal(
    points().items.get('air-quality:national:paris-2').pixelSize,
    13,
  );
  assert.equal(
    points().items.get('air-quality:national:cape-town').pixelSize,
    7,
  );
  assert.equal(bubbles()[0].pixelSize, Math.round(12 + 6 * Math.log10(2)));
  // Empty map lets go of it.
  click(null);
  assert.equal(layer.getRowControls().summary.result?.key ?? null, null);
});

test('a click a few pixels off a station still selects it', async () => {
  const { layer, click, zoomTo } = await zoomHarness(parisAndCapeTown(), {
    view: 'PM2.5',
  });
  zoomTo(0.0001);
  // paris-1 is drawn at the centre, 400 × 300; 3 px to its right.
  click(null, { screenPosition: { x: 403, y: 300 } });
  assert.equal(
    layer.getRowControls().summary.result?.key ?? null,
    'national:paris-1',
  );
  // 30 px away is open map.
  click(null, { screenPosition: { x: 430, y: 300 } });
  assert.equal(layer.getRowControls().summary.result?.key ?? null, null);
});

test('a click is ignored while disabled, with stations hidden, under a card, or with the pointer held', async () => {
  const id = 'air-quality:national:cape-town';
  const card = { over: false };
  const pointer = { free: true, isPointerFree: () => pointer.free };
  const { layer, click } = await zoomHarness(parisAndCapeTown(), {
    view: 'PM2.5',
    pointer,
    picking: {
      clickCard: () => (card.over ? { sourceId: 'x', entryId: 'y' } : null),
    },
  });
  layer.disable();
  click(id);
  assert.equal(layer.getRowControls().summary.result?.key ?? null, null);
  layer.enable();
  layer.setParams({ stations: false });
  click(id);
  assert.equal(layer.getRowControls().summary.result?.key ?? null, null);
  layer.setParams({ stations: true });
  card.over = true;
  click(id);
  assert.equal(
    layer.getRowControls().summary.result?.key ?? null,
    null,
    'the card takes the click',
  );
  card.over = false;
  pointer.free = false;
  click(id);
  assert.equal(layer.getRowControls().summary.result?.key ?? null, null);
  pointer.free = true;
  click(id);
  assert.equal(
    layer.getRowControls().summary.result?.key ?? null,
    'national:cape-town',
  );
});

test('destroy removes the click subscription', async () => {
  const { layer, clicks } = await zoomHarness(parisAndCapeTown());
  assert.equal(clicks.length, 1);
  layer.destroy();
  assert.equal(clicks.length, 0);
});

test('stations and groups are air quality picks: other layers leave them alone, Context names nothing', async () => {
  const picking = await import('../../data/pickRegistry.js');
  const { resolvePickedContext } = await import('../../data/pickedContext.js');
  const { layer, points, bubbles } = await zoomHarness(parisAndCapeTown(), {
    view: 'PM2.5',
    picking,
  });
  const station = 'air-quality:national:cape-town';
  const group = bubbles()[0].id;
  assert.equal(picking.isOwnedByOtherLayer('flights', station), true);
  assert.equal(picking.isOwnedByOtherLayer('flights', group), true);
  assert.equal(picking.isOwnedByOtherLayer('air-quality', station), false);
  assert.equal(picking.isOwnedByOtherLayer('flights', 'something-else'), false);
  assert.equal(
    resolvePickedContext(
      { set: points().spec.id, id: station, surface: false },
      { dataManager: { isEnabled: () => true, layers: new Map() } },
    ),
    null,
  );
  layer.disable();
  assert.equal(picking.isOwnedByOtherLayer('flights', station), false);
  layer.enable();
  assert.equal(picking.isOwnedByOtherLayer('flights', station), true);
  layer.destroy();
  assert.equal(picking.isOwnedByOtherLayer('flights', station), false);
});

// ── an index without an upper limit ────────────────────────────────────────

/** A station reporting PM2.5 at `value` µg/m³, for the AQI view. */
const aqiSite = (id, lat, lon, value) => ({
  ...observed('national', id, lat, lon),
  value,
});

test('an index above 500 reads 500+ and adds at most 500 to its group mean', async () => {
  // Ten stations at 5.4 µg/m³ (US AQI 30) and a sensor stuck at 999 µg/m³:
  // its index is 1842; it may lift the mean by (500 − 30) / 11 at most, to
  // about 73 (Moderate) rather than about 195 (Unhealthy).
  const { layer, points, bubbles, zoomTo } = await zoomHarness([
    ...Array.from({ length: 10 }, (_, i) =>
      aqiSite(`calm-${i}`, 48.85 + i * 0.01, 2.35, 5.4),
    ),
    aqiSite('stuck', 48.86, 2.45, 999),
  ]);
  const [bubble] = bubbles();
  assert.equal(bubble.pixelSize, Math.round(12 + 6 * Math.log10(11)));
  assert.equal(bubble.color, '#ffff00');
  zoomTo(0.0001);
  const stuck = points().items.get('air-quality:national:stuck:aqi');
  // The computed value stays in the data; what is shown reads 500+.
  assert.equal(stuck.meta.aqi.index, 1842);
  assert.equal(stuck.meta.value, 1842);
  assert.equal(stuck.meta.label, '500+');
  const [row] = layer.getRowControls().list.items;
  assert.equal(row.text, 'stuck');
  assert.equal(row.lead, '500+');
  layer.setParams({ station: 'national:stuck:aqi' });
  const index = layer
    .getRowControls()
    .sublists.find((group) => group.id === 'index')
    .tiles.find((tile) => tile.id === 'aqi');
  assert.equal(index.value, '500+');
  // Exactly at the edge: four stations at 0 and one stuck average 100, still
  // Moderate; a contribution above 500 would make it 101.
  const edge = await zoomHarness([
    ...Array.from({ length: 4 }, (_, i) =>
      aqiSite(`zero-${i}`, 48.85 + i * 0.01, 2.35, 0),
    ),
    aqiSite('stuck', 48.86, 2.45, 999),
  ]);
  assert.equal(edge.bubbles()[0].color, '#ffff00');
});

test('a cluster click flies through the shell navigation handoff', async () => {
  const { layer, bubbles, click, flights } = await zoomHarness(
    parisAndCapeTown(),
    { view: 'PM2.5' },
  );
  let calls = 0;
  layer.attachShellServices({
    runNavigation: (navigate) => {
      calls++;
      navigate();
    },
  });
  click(bubbles()[0].id);
  assert.equal(calls, 1);
  assert.equal(flights.length, 1);
});
