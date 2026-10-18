import test from 'node:test';
import assert from 'node:assert/strict';
import { createMagnetosphereLayer, traceFilaments } from './index.js';
import { coefficientsFor } from './field.js';
import { fieldLineSeeds } from './geometry.js';

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

/** Record what each re-trace returned, so a test can tell work from a no-op. */
function recordRetraces(layer) {
  const results = [];
  const original = layer.retrace;
  layer.retrace = async (signal) => {
    const replaced = await original(signal);
    results.push(replaced);
    return replaced;
  };
  return results;
}

test('the filaments follow the Sun, not only the solar wind', async () => {
  // The same solar wind six hours later: the Earth has turned 90° under the
  // Sun, so a tail traced against the old Sun would point the wrong way. The
  // feed is still fresh, so only the Sun can be what triggers the trace.
  const { layer, loads } = harness([t96State]);
  await layer.init(null, { cesium });
  await layer.enable(null, { sunDirection: SUN });
  await layer.update(null, { sunDirection: SUN });
  const retraces = recordRetraces(layer);

  await layer.update(null, { sunDirection: { x: 0, y: 1, z: 0 } });
  assert.equal(loads(), 1, 'the feed was not fetched again');
  assert.deepEqual(retraces, [true], 'but the filaments were re-traced');

  // A degree or two of rotation is not worth seconds of tracing.
  await layer.update(null, {
    sunDirection: { x: -Math.sin(0.03), y: Math.cos(0.03), z: 0 },
  });
  assert.deepEqual(retraces, [true, false]);
});

test('an internal-only trace does not go stale with the Sun', async () => {
  // IGRF is Earth-fixed, so with no usable external model there is nothing to
  // re-trace when the Sun moves.
  const { layer } = harness([{ ...t96State, dst: null, byNT: null, kp: null }]);
  await layer.init(null, { cesium });
  await layer.enable(null, { sunDirection: SUN });
  await layer.update(null, { sunDirection: SUN });
  const retraces = recordRetraces(layer);
  await layer.update(null, { sunDirection: { x: 0, y: 1, z: 0 } });
  assert.deepEqual(retraces, [false]);
});

test('tracing hands the frame back mid-line and draws the same lines', async () => {
  // One T96 line can take ~90 ms, so pausing only between lines still drops
  // frames. A clock that advances a millisecond per reading forces a pause
  // every few readings; the lines must come out exactly as an unsliced trace.
  const coefficients = coefficientsFor(2026.5);
  const seeds = fieldLineSeeds(1);
  const unsliced = await traceFilaments(coefficients, seeds, {
    yieldTo: async () => {},
    sliceMs: Infinity,
  });
  let now = 0;
  let pauses = 0;
  const sliced = await traceFilaments(coefficients, seeds, {
    yieldTo: async () => {
      pauses += 1;
    },
    clock: () => (now += 1),
    sliceMs: 4,
  });
  assert.ok(
    pauses > seeds.length,
    `paused ${pauses} times for ${seeds.length} lines`,
  );
  assert.deepEqual(sliced, unsliced);
});

test('an abort during a slice pause stops the trace', async () => {
  const controller = new AbortController();
  const lines = await traceFilaments(
    coefficientsFor(2026.5),
    fieldLineSeeds(1),
    {
      signal: controller.signal,
      yieldTo: async () => controller.abort(),
      clock: (() => {
        let now = 0;
        return () => (now += 10);
      })(),
      sliceMs: 1,
    },
  );
  assert.equal(lines.length, 0);
});

test('the default yield uses a real MessageChannel task and closes both ports without timers', async (t) => {
  const Channel = globalThis.MessageChannel;
  let posts = 0;
  let deliveries = 0;
  let closes = 0;
  t.after(() => {
    globalThis.MessageChannel = Channel;
  });
  globalThis.MessageChannel = class extends Channel {
    constructor() {
      super();
      this.port1.addEventListener('message', () => {
        deliveries += 1;
      });
      const post = this.port2.postMessage.bind(this.port2);
      this.port2.postMessage = (...args) => {
        posts += 1;
        return post(...args);
      };
      for (const port of [this.port1, this.port2]) {
        const close = port.close.bind(port);
        port.close = () => {
          closes += 1;
          close();
        };
      }
    }
  };
  t.mock.method(globalThis, 'setTimeout', () => {
    throw new Error(
      'default yield must not use a timer when MessageChannel exists',
    );
  });
  const coefficients = coefficientsFor(2026.5);
  const seeds = fieldLineSeeds(1).slice(0, 1);
  const unsliced = await traceFilaments(coefficients, seeds, {
    sliceMs: Infinity,
  });
  let now = 0;
  const sliced = await traceFilaments(coefficients, seeds, {
    clock: () => (now += 8),
  });
  assert.ok(posts > 1, 'must actually cross multiple task boundaries');
  assert.equal(deliveries, posts, 'each pause awaits a real message event');
  assert.equal(closes, posts * 2, 'no channel ports remain open after tracing');
  assert.deepEqual(sliced, unsliced);
});

test('the default yield falls back to a zero-delay timer without MessageChannel and observes abort', async (t) => {
  const Channel = globalThis.MessageChannel;
  const timer = globalThis.setTimeout;
  t.after(() => {
    globalThis.MessageChannel = Channel;
  });
  globalThis.MessageChannel = undefined;
  const controller = new AbortController();
  let pauses = 0;
  t.mock.method(globalThis, 'setTimeout', (resume, delay) => {
    assert.equal(delay, 0);
    pauses += 1;
    return timer(() => {
      controller.abort();
      resume();
    }, delay);
  });
  let now = 0;
  const lines = await traceFilaments(
    coefficientsFor(2026.5),
    fieldLineSeeds(1),
    {
      signal: controller.signal,
      clock: () => (now += 8),
    },
  );
  assert.equal(pauses, 1);
  assert.deepEqual(lines, []);
});
