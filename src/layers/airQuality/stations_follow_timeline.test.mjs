import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { createWorldClock } from '../../time/worldClock.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const HOUR = 3600_000;
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const NATIONAL = {
  id: 'national',
  title: 'National',
  label: 'Air quality · National',
  network: 'NATIONAL',
  direct: true,
  parameters: ['PM2.5', 'PM10', 'O3', 'NO2', 'SO2', 'CO'],
};
/** Cape Town's PM2.5 hourly mean, observed at `observedMs`. */
const capeTown = (observedMs = Date.now() - 10 * 60_000, value = 12) => [
  {
    id: 'national:cape-town:PM2.5',
    provider: 'national',
    stationId: 'cape-town',
    name: 'Cape Town',
    zone: 'WC',
    lat: -33.92,
    lon: 18.42,
    parameter: 'PM2.5',
    scale: 'PM2.5',
    units: 'µg/m³',
    value,
    label: String(value),
    kind: 'observation',
    averagingMinutes: 60,
    observedMs,
    color: '#8cb4ce',
  },
];
function harness({
  fieldSource = null,
  clock = createWorldClock(),
  definitions = [NATIONAL],
  getSnapshot = async () => capeTown(),
  getCoverage,
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
        fromDegrees(18.42 + (x - 400) * 0.001, -33.92 + (300 - y) * 0.001),
      isOccluded: () => false,
    },
    globe: {
      isSettled: () => true,
      imagery: { add: (spec) => ({ spec, remove() {} }) },
    },
  });
  const layer = createAirQualityLayer({
    source: { definitions, getSnapshot, getCoverage },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    fieldSource,
    clock,
    registerCredit: () => true,
  });
  layer.init(viewer);
  layer.enable();
  return { layer, clock, points: () => draw.find('air-quality:points:') };
}

const followed = () => createWorldClock({ follow: ['air-quality'] });
/** The start of the hour `hours` before the current one. */
const hourAgo = (hours) => Math.floor(Date.now() / HOUR) * HOUR - hours * HOUR;

/**
 * A source answering any time asked: the hour's mean, or now's, and saying
 * which time it answered for, as the snapshot source does.
 */
function timedSource({ answersTime = true, rows } = {}) {
  const asked = [];
  let answered = null;
  return {
    asked,
    getSnapshot: async (request) => {
      asked.push(request);
      answered = answersTime ? (request.atMs ?? null) : null;
      return rows
        ? rows(request)
        : capeTown(
            request.atMs ?? Date.now() - 10 * 60_000,
            request.atMs ? 30 : 12,
          );
    },
    getCoverage: () => ({ stale: false, partial: false, atMs: answered }),
  };
}

test('stations follow the timeline to a past hour and back', async () => {
  const source = timedSource();
  const h = harness({ clock: followed(), ...source });
  await h.layer.update();
  await settle();
  assert.equal(h.points().show, true);
  assert.equal(source.asked.at(-1).atMs, undefined);

  // Seeking three and a half hours back asks for the start of that hour.
  const hour = hourAgo(3);
  h.clock.seek(hour + 30 * 60_000);
  await settle();
  assert.equal(source.asked.at(-1).atMs, hour);
  assert.equal(h.points().show, true);
  assert.equal(h.points().items.size, 1);
  assert.equal(h.layer.getRowControls().summary.status, '1 station');
  assert.equal(
    h.layer.getRowControls().summary.validTime,
    new Date(hour).toISOString(),
  );

  // Within the same hour nothing more is asked.
  const asks = source.asked.length;
  h.clock.seek(hour + 50 * 60_000);
  await settle();
  assert.equal(source.asked.length, asks);

  // Back at now the stations are now's again.
  h.clock.goLive();
  await settle();
  assert.equal(source.asked.at(-1).atMs, undefined);
  assert.equal(h.points().show, true);
  assert.notEqual(
    h.layer.getRowControls().summary.validTime,
    new Date(hour).toISOString(),
  );
});

test('a source that answers only now draws no stations in the past', async () => {
  const source = timedSource({ answersTime: false });
  const h = harness({ clock: followed(), ...source });
  await h.layer.update();
  await settle();
  h.clock.seek(hourAgo(5));
  await settle();
  assert.equal(source.asked.at(-1).atMs, hourAgo(5));
  assert.equal(h.points().show, false);
  assert.equal(h.layer.getRowControls().summary.status, '');
});

test('past readings are aged against the hour asked', async () => {
  const hour = hourAgo(10);
  const source = timedSource({
    rows: ({ atMs }) =>
      atMs === undefined
        ? capeTown()
        : [
            // Two hours before the hour asked: drawn at it, though ten
            // hours old now.
            ...capeTown(atMs - 2 * HOUR),
            // Seven hours before it, and after it: neither is drawn.
            ...capeTown(atMs - 7 * HOUR).map((r) => ({
              ...r,
              id: 'old',
              stationId: 'old',
              lon: 20,
            })),
            ...capeTown(atMs + HOUR).map((r) => ({
              ...r,
              id: 'late',
              stationId: 'late',
              lon: 22,
            })),
          ],
  });
  const h = harness({ clock: followed(), ...source });
  await h.layer.update();
  await settle();
  h.clock.seek(hour);
  await settle();
  assert.equal(h.points().show, true);
  assert.equal(h.points().items.size, 1);
  assert.equal(
    h.layer.getRowControls().summary.validTime,
    new Date(hour - 2 * HOUR).toISOString(),
  );
});

test('ahead of now no station is drawn and none is asked for', async () => {
  const source = timedSource();
  const h = harness({ clock: followed(), ...source });
  await h.layer.update();
  await settle();
  const asks = source.asked.length;
  h.clock.seek(Date.now() + 5 * HOUR);
  await settle();
  assert.equal(source.asked.length, asks);
  assert.equal(h.points().show, false);
});

test('a layer the clock does not follow stays at now', async () => {
  const source = timedSource();
  const h = harness({ ...source });
  await h.layer.update();
  await settle();
  h.clock.seek(hourAgo(4));
  await settle();
  assert.ok(source.asked.every((r) => r.atMs === undefined));
  assert.equal(h.points().show, true);
});

test('a past hour shown arms no age-out on the wall clock', async (t) => {
  const source = timedSource({
    rows: ({ atMs }) =>
      atMs === undefined ? capeTown() : capeTown(atMs - 2 * HOUR),
  });
  const h = harness({ clock: followed(), ...source });
  await h.layer.update();
  await settle();
  h.clock.seek(hourAgo(30));
  await settle();
  assert.equal(h.points().show, true);
  // Each age-out merges again: none is armed while the hour is shown.
  const armed = [];
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    armed.push(ms);
    return real(fn, ms, ...rest);
  });
  h.layer.setParams({ stations: false });
  h.layer.setParams({ stations: true });
  await h.layer.update();
  await settle();
  await new Promise((r) => real(r, 1200));
  assert.ok(
    armed.every((ms) => ms > 2000),
    `armed ${JSON.stringify(armed)}`,
  );
});
