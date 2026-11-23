import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { STALE_AFTER_MS } from './model.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

function harness(source, renderer = {}) {
  const events = [];
  const viewer = {};
  const { draw } = bindFakeDraw(viewer, renderer);
  const layer = createAirQualityLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  const markers = () => draw.find('air-quality:');
  return { layer, viewer, draw, markers, events };
}

const reading = (id, value, overrides = {}) => ({
  id: `eccc:${id}`,
  provider: 'eccc',
  scale: 'AQHI',
  value,
  band: 'low',
  stationId: id,
  name: id,
  zone: 'ont',
  lat: 43.65,
  lon: -79.38,
  observedMs: 1_700_000_000_000,
  color: '#4cc9f0',
  label: String(value),
  risk: 'Low health risk',
  note: null,
  ...overrides,
});

const staticSource = (rows) => ({ getSnapshot: async () => rows });

test('a layer requires both a snapshot source and an overlay host', () => {
  assert.throws(() => createAirQualityLayer(), /snapshot source/);
  assert.throws(
    () => createAirQualityLayer({ source: staticSource([]) }),
    /overlay host/,
  );
});

test('initialization is single-use and owns separate shape and point draw sets', () => {
  const { layer, viewer, draw, markers } = harness(staticSource([]));
  const owned = markers();
  assert.equal(owned.kind, 'shapes');
  assert.equal(
    [...draw.sets.values()].filter((set) => !set.disposed).length,
    2,
  );
  assert.throws(() => layer.init(viewer), /already initialized/);
  layer.destroy(viewer);
  assert.equal(owned.disposed, true);
  assert.ok([...draw.sets.values()].every((set) => set.disposed));
});

test('stations are ground discs in their band colour, shown only while enabled', async () => {
  const { layer, markers } = harness(
    staticSource([reading('A', 2), reading('B', 7, { color: '#c1121f' })]),
  );
  assert.equal(await layer.update(), true);
  const set = markers();
  assert.equal(set.show, true);
  assert.deepEqual(
    [...set.items.keys()],
    ['air-quality:eccc:A', 'air-quality:eccc:B'],
  );
  const disc = set.items.get('air-quality:eccc:B');
  assert.deepEqual(disc.geometry, {
    kind: 'ellipse',
    center: { lon: -79.38, lat: 43.65 },
    semiMajor: 6_000,
    semiMinor: 6_000,
  });
  assert.equal(disc.height, 'clampGround');
  assert.equal(disc.clampTo, 'both');
  assert.deepEqual(disc.fill, [0xc1 / 255, 0x12 / 255, 0x1f / 255, 0.35]);
  assert.equal(disc.outline, undefined);
  assert.equal(disc.meta.name, 'B');
  assert.equal(disc.meta.value, 7);
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
    ['Toronto · Low health risk'],
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

test('the readout descriptor carries the band legend and coverage', async () => {
  const { layer } = harness(staticSource([reading('A', 2), reading('B', 9)]));
  await layer.update();
  const controls = layer.getRowControls();
  assert.equal(controls.readout, true);
  assert.match(controls.summary.coverage, /Canada only/);
  // The Weather panel's legend shape: one {color, label} per band.
  assert.equal(controls.legendCategorical, true);
  assert.deepEqual(
    controls.legend.map((entry) => entry.label),
    ['Low', 'Moderate', 'High', 'Very High'],
  );
  assert.ok(
    controls.legend.every((entry) => /^#[0-9a-f]{6}$/i.test(entry.color)),
  );
  // Worst first, and every item keyed.
  assert.deepEqual(
    controls.list.items.map((i) => i.text),
    ['B · Low health risk', 'A · Low health risk'],
  );
  assert.ok(controls.list.items.every((i) => i.id));
  assert.match(controls.summary.status, /2 stations reporting/);
});

test('the readout reports an error rather than a silent empty card', async () => {
  const { layer } = harness({
    getSnapshot: async () => {
      throw new Error('ECCC HTTP 503');
    },
  });
  await layer.update();
  assert.match(layer.getRowControls().summary.status, /503/);
});

test('row-control listeners are notified on refresh and teardown-safe', async () => {
  const { layer, viewer } = harness(staticSource([reading('A', 2)]));
  let calls = 0;
  layer.setRowControlsListener(() => {
    calls += 1;
  });
  await layer.update();
  assert.ok(calls >= 1, 'a refresh notifies the card');
  layer.destroy(viewer);
  const after = calls;
  layer.setRowControlsListener(() => {
    calls += 1;
  });
  assert.equal(calls, after);
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
  assert.equal(layer.getRowControls().summary.status, 'No current readings');
});

test('a failed refresh over good readings reports degraded, not nominal', async () => {
  let fail = false;
  const { layer } = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('ECCC HTTP 503');
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

test('injected observations use point markers and dispose both render sets', async () => {
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
  const shapes = [...draw.sets.values()].find((set) => set.kind === 'shapes');
  assert.equal(shapes.items.size, 0);
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
      definition('saaqis'),
      definition('regional', { parameters: ['PM2.5'] }),
      { ...definition('eccc'), observation: false, parameters: [] },
    ],
    getSnapshot: (request) => {
      calls.push(request);
      return new Promise((resolve, reject) =>
        pending.set(request.provider, () =>
          answers[request.provider] instanceof Error
            ? reject(answers[request.provider])
            : resolve(answers[request.provider] ?? []),
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
    saaqis: [observed('saaqis', 'cape-town', -33.925, 18.4242)],
    regional: [observed('regional', 'durban', -29.86, 31.03)],
  });
  assert.equal(layer.getParams().view, 'aqi');
  const pending = layer.update();
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['openaq', 'saaqis', 'regional'],
    'all asked before any answers; Canada is not a station provider',
  );
  settle();
  assert.equal(await pending, true);
  // The AQI view draws one reading per station.
  assert.deepEqual([...drawn('points').items.keys()].sort(), [
    'air-quality:openaq:paris:aqi',
    'air-quality:regional:durban:aqi',
    'air-quality:saaqis:cape-town:aqi',
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
    saaqis: [observed('saaqis', 'cape-town', -33.925, 18.4242)],
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
  assert.equal(states.saaqis.status, 'ok');
  assert.equal(states.saaqis.count, 1);
  assert.equal(states.regional.status, 'failed');
  assert.equal(layer.getRowControls().summary.status, 'US AQI · Moderate');
});

test('when every provider fails the layer reports the error', async () => {
  const failure = new Error('Air quality provider unavailable');
  const { layer, settle } = multiProvider({
    openaq: failure,
    saaqis: failure,
    regional: failure,
  });
  const pending = layer.update();
  settle();
  assert.equal(await pending, false);
  assert.equal(layer.getStats().error, 'Air quality provider unavailable');
});

test('the AQHI view asks only Canada, and a pollutant view only its networks', async () => {
  const { layer, calls, settle, drawn } = multiProvider({
    eccc: [reading('A', 2)],
    openaq: [observed('openaq', 'paris', 48.85, 2.35)],
    saaqis: [observed('saaqis', 'cape-town', -33.925, 18.4242)],
  });
  layer.setParams({ view: 'aqhi' });
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['eccc'],
  );
  assert.deepEqual([...drawn('shapes').items.keys()], ['air-quality:eccc:A']);
  assert.equal(drawn('points').items.size, 0);
  calls.length = 0;
  layer.setParams({ view: 'NO2' });
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => [call.provider, call.parameter]),
    [
      ['openaq', 'NO2'],
      ['saaqis', 'NO2'],
    ],
  );
  assert.equal(drawn('shapes').items.size, 0);
  assert.equal(drawn('points').items.size, 2);
  assert.deepEqual(layer.getParams(), {
    view: 'NO2',
    stations: true,
    station: null,
  });
});

test('the stations switch hides and shows the station markers', async () => {
  const { layer, settle, drawn } = multiProvider({
    saaqis: [observed('saaqis', 'cape-town', -33.925, 18.4242)],
  });
  const pending = layer.update();
  settle();
  await pending;
  layer.setParams({ stations: false });
  assert.equal(drawn('points').show, false);
  assert.equal(layer.getParams().stations, false);
  layer.setParams({ stations: true });
  assert.equal(drawn('points').show, true);
});
