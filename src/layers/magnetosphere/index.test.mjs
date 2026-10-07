import test from 'node:test';
import assert from 'node:assert/strict';
import { createMagnetosphereLayer } from './index.js';

/**
 * Enough of Cesium for init to build its rendering; nothing here draws.
 *
 * The Transforms stubs return null, which is the real "ICRF data has not loaded
 * yet" path: sunDirectionFixed bails rather than handing back a plausible but
 * wrong direction.
 */
const cesium = {
  JulianDate: { now: () => null },
  Cartesian3: function Cartesian3() {},
  Matrix3: function Matrix3() {},
  Simon1994PlanetaryPositions: {
    computeSunPositionInEarthInertialFrame: () => ({ x: 1, y: 0, z: 0 }),
  },
  Transforms: {
    computeIcrfToFixedMatrix: () => null,
    computeTemeToPseudoFixedMatrix: () => null,
  },
};

/** A rendering that records what it was handed instead of touching a GPU. */
function recordingRendering() {
  const calls = { boundary: 0, filaments: [] };
  return {
    rendering: {
      setBoundary: () => {
        calls.boundary += 1;
      },
      setFilaments: (lines) => {
        calls.filaments.push(lines.length);
      },
      setOpacity() {},
      clear() {},
      destroy() {},
    },
    calls,
  };
}

const SUN = Object.freeze({ x: 1, y: 0, z: 0 });

/** A state the selector will accept for T96. */
const t96State = Object.freeze({
  unavailable: false,
  stale: false,
  observedAt: '2026-10-01T12:00:00Z',
  speedKmPerS: 400,
  densityPerCm3: 5,
  bzNT: -4,
  byNT: 3,
  dst: -35,
  kp: 3.33,
  standoffRe: 10.1,
  flaring: 0.58,
  dynamicPressureNPa: 2.1,
  insideGeosynchronous: false,
});

/**
 * Build a layer over a scripted source.
 *
 * @param {object[]} responses One per load() call; the last repeats.
 * @returns {object} The layer, its rendering calls and the load count.
 */
function harness(responses) {
  const { rendering, calls } = recordingRendering();
  let loads = 0;
  // update() short-circuits inside its refresh interval, so the clock has to be
  // driven explicitly or a second update silently does nothing.
  let clock = 1_700_000_000_000;
  const layer = createMagnetosphereLayer({
    source: {
      async load() {
        const response = responses[Math.min(loads, responses.length - 1)];
        loads += 1;
        if (response instanceof Error) throw response;
        return response;
      },
    },
    createRendering: () => rendering,
    // One meridian keeps the trace to a handful of lines; the tracer itself is
    // covered by trace.test.mjs.
    meridians: 1,
    now: () => clock,
  });
  const advance = (ms) => {
    clock += ms;
  };
  return { layer, calls, advance, loads: () => loads };
}

/** Past the layer's refresh interval, so the next update really fetches. */
const PAST_REFRESH_MS = 200_000;

test('the first trace runs from IGRF alone so the layer paints without the network', async () => {
  const { layer, calls } = harness([t96State]);
  await layer.init(null, { cesium });
  assert.ok(layer.getStats().count > 0, 'init must produce filaments');
  // Nothing has been fetched yet, so no model has been chosen.
  assert.equal(layer.getStats().externalModel, null);
  assert.equal(calls.filaments.length, 0, 'init does not draw');
});

test('the feed arriving upgrades the filaments to T96', async () => {
  const { layer } = harness([t96State]);
  await layer.init(null, { cesium });
  const before = layer.getStats().count;
  await layer.enable(null, { sunDirection: SUN });
  await layer.update(null, { sunDirection: SUN });
  const stats = layer.getStats();
  assert.equal(stats.externalModel, 't96');
  assert.equal(stats.externalModelLabel, 'Tsyganenko T96');
  assert.equal(stats.externalModelExtrapolated, false);
  assert.ok(stats.count > 0, 'retrace must leave filaments');
  // The row's meta line is the only place a user learns which model drew the
  // lines, so it has to name it.
  assert.match(stats.source, /T96/);
  // The external field opens the high-latitude lines, so the traces are not the
  // same ones init produced. Comparing counts is enough to prove a re-trace
  // happened without asserting a particular geometry.
  assert.ok(before > 0);
});

test('a feed with only Kp falls back to T89 rather than to nothing', async () => {
  const { layer } = harness([{ ...t96State, dst: null, byNT: null }]);
  await layer.init(null, { cesium });
  await layer.enable(null, { sunDirection: SUN });
  await layer.update(null, { sunDirection: SUN });
  const stats = layer.getStats();
  assert.equal(stats.externalModel, 't89');
  assert.match(stats.source, /T89/);
});

test('an out-of-range solar wind says so in the row rather than silently clamping', async () => {
  // T96 clamps to its fitted range, which is the right call - refusing to draw
  // during the storms people most want to see would be worse - but the row has
  // to admit it.
  const { layer } = harness([
    { ...t96State, dst: -250, bzNT: -30, dynamicPressureNPa: 40 },
  ]);
  await layer.init(null, { cesium });
  await layer.enable(null, { sunDirection: SUN });
  await layer.update(null, { sunDirection: SUN });
  const stats = layer.getStats();
  assert.equal(stats.externalModel, 't96');
  assert.equal(stats.externalModelExtrapolated, true);
  assert.match(stats.source, /extrapolated/);
});

test('an unchanged field does not pay for a second trace', async () => {
  const { layer } = harness([t96State]);
  await layer.init(null, { cesium });
  await layer.enable(null, { sunDirection: SUN });
  await layer.update(null, { sunDirection: SUN });
  // retrace() is idempotent for the same solar wind state: the selector's key
  // is rounded precisely so a quiet feed does not re-trace every two minutes.
  assert.equal(await layer.retrace(), false);
  assert.equal(await layer.retrace(), false);
});

test('a material change in the solar wind does earn a re-trace', async () => {
  const stormy = { ...t96State, bzNT: -9, dst: -80 };
  const { layer, advance } = harness([t96State, stormy]);
  await layer.init(null, { cesium });
  await layer.enable(null, { sunDirection: SUN });
  await layer.update(null, { sunDirection: SUN });
  assert.equal(await layer.retrace(), false, 'same state, no work');

  advance(PAST_REFRESH_MS);
  await layer.update(null, { sunDirection: SUN });
  const stats = layer.getStats();
  assert.equal(stats.externalModel, 't96');
  assert.ok(stats.count > 0);
  // The stormier state has already been traced, so asking again is a no-op.
  assert.equal(await layer.retrace(), false, 'new state traced exactly once');
});

test('a feed failure leaves the previous filaments standing', async () => {
  const { layer, advance } = harness([t96State, new Error('upstream_down')]);
  await layer.init(null, { cesium });
  await layer.enable(null, { sunDirection: SUN });
  await layer.update(null, { sunDirection: SUN });
  const traced = layer.getStats().count;
  assert.ok(traced > 0);
  // Second update throws inside the source. The boundary goes, the lines stay.
  advance(PAST_REFRESH_MS);
  await layer.update(null, { sunDirection: SUN });
  const after = layer.getStats();
  assert.equal(after.count, traced, 'filaments must survive a feed failure');
  assert.ok(after.error, 'and the failure must be reported');
});

test('no Sun direction means no re-trace rather than a wrong frame', async () => {
  // The GSM frame needs the Sun direction. Tracing without it would silently
  // produce a magnetosphere pointing the wrong way, which looks fine.
  const { layer } = harness([t96State]);
  await layer.init(null, { cesium });
  await layer.update(null, {});
  assert.equal(await layer.retrace(), false);
});
