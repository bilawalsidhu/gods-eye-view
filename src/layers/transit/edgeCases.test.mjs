// Edge cases for transit: a stop,
// a turn, a feed loss and its return keep the heading and the data age
// continuous, and the selection stays bound to the vehicle/trip identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createIngestion } from './ingestion.js';
import { applyDisplayCourse, updatePlayback } from './movement.js';
import { TRANSIT_POLL_MS, transitVehicleKey } from './policy.js';
import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';

const START_MS = 1_789_000_000_000;
const LAT = 42.3601;
const LON = -71.0589;
const M_PER_DEG = 111_320;
const LON_M_PER_DEG = M_PER_DEG * Math.cos((LAT * Math.PI) / 180);

/** Real state and ingestion; the scene parts are inert doubles. */
function harness(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START_MS });
  t.mock.method(performance, 'now', () => Date.now() - START_MS);
  t.mock.method(console, 'warn', () => {});
  const services = {
    overlays: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
    render: { governorRequestRender() {} },
    sprites: {},
  };
  const state = createState({ services });
  const parts = {};
  let answer = null;
  const source = {
    requestSnapshot: async () => answer(),
    getHistory: async () => ({ vehicles: [] }),
  };
  parts.rendering = {
    syncRenderHold() {},
    schedulePlayback() {},
    refreshEndpoints() {},
    addMarker: () => ({ show: true }),
    paintMode() {},
    paintSelected() {},
    cancelWake() {},
    requestVisibility() {},
  };
  parts.height = {
    requestHeight: () => ({ height: 10, cell: 'cell', prior: null }),
    releaseVehicle() {},
    anchorFloors() {},
  };
  parts.selection = {
    clearSelection() {
      state._selectedKey = null;
    },
    refreshSelectedCard() {},
  };
  parts.ingestion = createIngestion({ state, services, parts, source });
  const feed = getRegisteredTransitFeed('mbta');
  state._enabled = true;
  state._activeFeeds.set(feed.id, feed);
  return {
    state,
    feed,
    /** One poll: `report` is the vehicle the operator sends, or null for an outage. */
    async poll(report) {
      answer = () =>
        report
          ? {
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: async () => ({
                feedId: feed.id,
                fetchedAt: Date.now(),
                vehicles: [report],
              }),
            }
          : {
              ok: false,
              status: 504,
              headers: { get: () => null },
              json: async () => ({ error: 'Transit feed unavailable' }),
            };
      await parts.ingestion.pollFeed(feed, state._generation);
    },
  };
}

/** A vehicle `east`/`north` metres from the start, reported now. */
const report = (east, north, trip = 'trip-1') => ({
  id: 'bus-7',
  lat: LAT + north / M_PER_DEG,
  lon: LON + east / LON_M_PER_DEG,
  bearing: null,
  speedMps: null,
  timestamp: Date.now() / 1000,
  timestampSource: 'vehicle',
  routeId: '1',
  tripId: trip,
});

test('edge:transit: a stop, a turn, a feed loss and its return keep heading, data age and selection continuous', async (t) => {
  const h = harness(t);
  const key = transitVehicleKey(h.feed.id, 'bus-7');
  // East at 10 m/s, a stop, a turn north, an outage, then the feed returns.
  const script = [
    [0, 0],
    [150, 0],
    [300, 0],
    [450, 0],
    [450, 0],
    [450, 0],
    [450, 150],
    [450, 300],
    null,
    null,
    null,
    null,
    [450, 600],
    [450, 750],
  ];
  const courses = [];
  const ages = [];
  let entry = null;
  for (const position of script) {
    await h.poll(position && report(...position));
    entry ??= h.state._vehicles.get(key);
    if (h.state._selectedKey === null) h.state._selectedKey = key;
    assert.equal(h.state._vehicles.get(key), entry, 'one entry per vehicle');
    for (let s = 0; s < TRANSIT_POLL_MS / 1000; s += 1) {
      t.mock.timers.tick(1000);
      updatePlayback(entry, Date.now(), performance.now());
      applyDisplayCourse(entry, performance.now());
      courses.push(entry.courseDeg);
      ages.push(entry.sample.latestReportAgeMs);
    }
  }

  // The selection survives the outage on the same vehicle and trip.
  assert.equal(h.state._selectedKey, key);
  assert.equal(entry.record.tripId, 'trip-1');

  // Heading: once known it never drops out and never jumps (120 deg/s, 0.25 s
  // per evaluation), it holds through the stop and the outage, and it ends
  // pointing north after the turn.
  const first = courses.findIndex(Number.isFinite);
  assert.ok(first >= 0, 'the vehicle earns a heading');
  for (let i = first + 1; i < courses.length; i += 1) {
    assert.ok(Number.isFinite(courses[i]), `heading lost at second ${i}`);
    const step = Math.abs(((courses[i] - courses[i - 1] + 540) % 360) - 180);
    assert.ok(step <= 30 + 1e-9, `heading jumped ${step} deg at second ${i}`);
  }
  const atSecond = (poll, s = 14) => courses[poll * 15 + s];
  assert.equal(Math.round(atSecond(5)), 90, 'parked: still facing east');
  assert.equal(Math.round(atSecond(11)), 0, 'outage: still facing north');
  assert.equal(Math.round(atSecond(13)), 0, 'after the return: north');

  // Data age: grows second by second while nothing arrives and only falls
  // when a fresh report lands.
  for (let i = 1; i < ages.length; i += 1) {
    assert.ok(Number.isFinite(ages[i]), `age missing at second ${i}`);
    const freshPoll = i % 15 === 0 && script[i / 15] !== null;
    if (!freshPoll)
      assert.equal(ages[i] - ages[i - 1], 1000, `age jumped at second ${i}`);
  }
  assert.ok(ages[12 * 15 - 1] >= 75_000, 'the outage is visible in the age');
  assert.ok(ages[12 * 15] < ages[12 * 15 - 1], 'the return resets the age');
});

test('edge:transit: a new trip on the same vehicle keeps the selection on that vehicle', async (t) => {
  const h = harness(t);
  const key = transitVehicleKey(h.feed.id, 'bus-7');
  await h.poll(report(0, 0, 'trip-1'));
  h.state._selectedKey = key;
  const entry = h.state._vehicles.get(key);
  const firstEpoch = entry.currentEpoch;
  t.mock.timers.tick(TRANSIT_POLL_MS);
  await h.poll(report(100, 0, 'trip-2'));
  assert.equal(h.state._vehicles.get(key), entry);
  assert.equal(h.state._selectedKey, key);
  assert.equal(entry.record.tripId, 'trip-2');
  // The new trip opens its own history epoch rather than joining the old one.
  assert.ok(entry.currentEpoch > firstEpoch);
  assert.equal(entry.track.epochs.get(entry.currentEpoch).trip, 'trip-2');
});
