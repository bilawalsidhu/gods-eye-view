import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherClock } from '../weather/clock.js';
import { createBirdMigrationLayer } from './index.js';

const TICKS = [
  '2026-10-11T02:30:00.000Z',
  '2026-10-11T03:00:00.000Z',
  '2026-10-11T03:25:00.000Z',
];
const LATEST = TICKS.at(-1);
const reduced = (final) =>
  Object.freeze({
    kind: 'reduced',
    reducedAt: '2026-10-11T03:31:00.000Z',
    final,
    sampleRadiusKm: 60,
    stations: Object.freeze([
      {
        kind: 'tracked',
        site: 'KTLX',
        position: { lat: 35.3, lon: -97.3, elevM: 389 },
        scanTime: '2026-10-11T03:22:00.000Z',
        track: { towardDeg: 200, speedMs: 11 },
        fit: {
          velocityProduct: 'N0U',
          maskProduct: 'N0C',
          gateCount: 900,
          azimuthCoverageDeg: 350,
          residualMs: 2,
          annulusKm: [5, 60],
          beamHeightM: [45, 735],
        },
      },
    ]),
  });

function harness() {
  const replies = [];
  const requested = [];
  const source = {
    async getManifest() {
      return {
        ticks: TICKS,
        latest: LATEST,
        bounds: { west: -126, south: 23, east: -65, north: 50 },
        stale: false,
      };
    },
    getMotion(time) {
      requested.push(time);
      return new Promise((resolve) => replies.push({ time, resolve }));
    },
  };
  const frames = [];
  const timers = [];
  const clock = createWeatherClock();
  const layer = createBirdMigrationLayer({
    source,
    clock,
    documentRef: { hidden: false },
    eventTarget: null,
    setTimeoutImpl: (fn) => timers.push(fn),
    clearTimeoutImpl: () => {},
    createRendering: () => ({
      show: (frame) => frames.push([frame.time, frame.motion.kind]),
      setHidden() {},
      rehome() {},
      clear() {},
      destroy() {},
      getDiagnostics: () => ({ error: null }),
    }),
  });
  layer.init({ imageryLayers: {}, camera: {}, scene: { requestRender() {} } });
  layer.enable();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { layer, clock, requested, replies, frames, timers, settle };
}

test('enable reduces only the latest tick; the frame is pending until its motion arrives', async () => {
  const { layer, requested, replies, frames, settle } = harness();
  await layer.update();
  assert.deepEqual(requested, [LATEST]);
  assert.deepEqual(frames, [[LATEST, 'pending']]);
  replies[0].resolve(reduced(true));
  await settle();
  assert.deepEqual(frames.at(-1), [LATEST, 'reduced']);
  const lines = layer.getRowControls().summary.lines.map(({ id }) => id);
  assert.deepEqual(lines, ['direction', 'arrows', 'pattern', 'attribution']);
});

test('an older tick is fetched only when the clock selects it', async () => {
  const { layer, clock, requested, settle } = harness();
  await layer.update();
  await clock.setTarget('2026-10-11T03:10:00.000Z');
  await settle();
  assert.deepEqual(requested, [LATEST, '2026-10-11T03:00:00.000Z']);
  assert.equal(layer.getDiagnostics().shown, '2026-10-11T03:00:00.000Z');
});

test('a pending retry never replaces a provisional reduced frame', async () => {
  const { layer, replies, frames, timers, settle } = harness();
  await layer.update();
  replies[0].resolve(reduced(false));
  await settle();
  assert.deepEqual(frames.at(-1), [LATEST, 'reduced']);
  timers.shift()();
  replies[1].resolve({ kind: 'pending' });
  await settle();
  assert.deepEqual(frames.at(-1), [LATEST, 'reduced']);
  assert.equal(layer.getDiagnostics().motion, 'reduced');
});
