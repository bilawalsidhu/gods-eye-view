import test from 'node:test';
import assert from 'node:assert/strict';
import { birdMigrationProxy } from '../../server/providers/birdMigration.js';
import { reduceStation } from '../../server/providers/birdMigration/vad.js';
import { parseMotion } from '../layers/birdMigration/wire.js';

const TICK = '2026-10-11T03:30:00.000Z';
const SCAN = '2026-10-11T03:27:00.000Z';
const MINUTE = 60_000;

/** A 0.5 degree, 0.25 km volume whose radial velocity is a sinusoid in azimuth. */
function volume(
  product,
  { towardDeg = 90, speedMs = 10, cc = 0.6, lat = 41.6, lon = -93.7 } = {},
) {
  const elevationDeg = 0.5;
  const cosE = Math.cos((elevationDeg * Math.PI) / 180);
  const toward = (towardDeg * Math.PI) / 180;
  const radials = [];
  for (let azimuthDeg = 0; azimuthDeg < 360; azimuthDeg++) {
    const az = ((azimuthDeg + 0.5) * Math.PI) / 180;
    const values = new Float32Array(280);
    for (let i = 0; i < values.length; i++)
      values[i] =
        product === 'N0U'
          ? speedMs * cosE * Math.cos(az - toward) + ((i % 5) - 2) * 0.3
          : cc;
    radials.push({ azimuthDeg, widthDeg: 1, values });
  }
  return {
    product,
    scanTime: SCAN,
    position: { lat, lon, elevM: 300 },
    elevationDeg,
    firstGateKm: 0,
    gateKm: 0.25,
    radials,
  };
}

test('a radial-velocity sinusoid peaking outbound due east reduces to a track toward 90 degrees', () => {
  const outcome = reduceStation('KDMX', {
    velocity: volume('N0U'),
    correlation: volume('N0C'),
  });
  assert.equal(outcome.kind, 'tracked');
  assert.ok(
    Math.abs(outcome.track.towardDeg - 90) <= 5,
    `towardDeg ${outcome.track.towardDeg}`,
  );
  assert.ok(Math.abs(outcome.track.speedMs - 10) < 0.5);
  assert.deepEqual(outcome.fit.annulusKm, [5, 60]);
  assert.equal(outcome.fit.velocityProduct, 'N0U');
  assert.equal(outcome.fit.maskProduct, 'N0C');
});

test('a radar whose annulus is mostly high correlation is precipitation with no track', () => {
  const outcome = reduceStation('KDMX', {
    velocity: volume('N0U'),
    correlation: volume('N0C', { cc: 0.99 }),
  });
  assert.equal(outcome.kind, 'precipitation');
  assert.equal(outcome.rainFraction, 1);
  assert.equal('track' in outcome, false);
  assert.equal('fit' in outcome, false);
});

const SITES = {
  KDMX: { lat: 41.6, lon: -93.7, cc: 0.6 },
  KDVN: { lat: 41.6, lon: -90.6, cc: 0.99 },
  PHKI: { lat: 21.9, lon: -159.5, cc: 0.6 },
};

function harness({
  holdMs = 5_000,
  sites = Object.keys(SITES),
  now = Date.parse(TICK) + 30 * MINUTE,
} = {}) {
  const clock = { now };
  const gate = { open: Promise.resolve(), fail: false };
  const upstream = {
    async compositeScans() {
      return ['2026-10-11T03:00:00.000Z', '2026-10-11T03:25:00.000Z', TICK];
    },
    async sites() {
      return sites;
    },
    async files() {
      await gate.open;
      if (gate.fail) throw new Error('down');
      return [{ file: 'sn.0007', arrivedAt: Date.parse(SCAN) + 2 * MINUTE }];
    },
    async bytes(site, product) {
      return { site, product };
    },
  };
  const decode = ({ site }, product) => volume(product, SITES[site]);
  let handler;
  birdMigrationProxy({
    upstream,
    decode,
    holdMs,
    now: () => clock.now,
  }).configureServer({
    middlewares: { use: (_path, h) => (handler = h) },
  });
  const get = (url) =>
    new Promise((resolve) => {
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      handler(
        {
          method: 'GET',
          url,
          headers: {},
          socket: { remoteAddress: '127.0.0.1' },
        },
        res,
      );
    });
  return { get, gate, clock };
}

test('the latest tick reduces to stations where only tracked radars carry a direction, each with its fit', async () => {
  const { get } = harness();
  const manifest = await get('/manifest');
  assert.equal(manifest.status, 200);
  assert.deepEqual(manifest.body.ticks, ['2026-10-11T03:00:00.000Z', TICK]);
  assert.equal(manifest.body.latest, TICK);
  const reply = await get(`/motion?time=${encodeURIComponent(TICK)}`);
  assert.equal(reply.status, 200);
  const motion = parseMotion(reply.body, TICK);
  assert.equal(motion.kind, 'reduced');
  assert.equal(motion.final, true);
  assert.deepEqual(
    motion.stations.map(({ site, kind }) => [site, kind]),
    [
      ['KDMX', 'tracked'],
      ['KDVN', 'precipitation'],
    ],
  );
  for (const station of reply.body.motion.stations) {
    if ('track' in station) {
      assert.equal(station.kind, 'tracked');
      assert.equal(typeof station.fit.gateCount, 'number');
    }
  }
  const [tracked] = motion.stations;
  assert.ok(Math.abs(tracked.track.towardDeg - 90) <= 5);
});

test('pending replies while reducing, and neither pending nor a failed re-reduction replaces a reduced tick', async () => {
  const { get, gate, clock } = harness({
    holdMs: 0,
    now: Date.parse(TICK) + 2 * MINUTE,
  });
  let release;
  gate.open = new Promise((resolve) => (release = resolve));
  const url = `/motion?time=${encodeURIComponent(TICK)}`;
  assert.deepEqual((await get(url)).body, {
    schemaVersion: 1,
    time: TICK,
    motion: { kind: 'pending' },
  });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reduced = (await get(url)).body.motion;
  assert.equal(reduced.kind, 'reduced');
  assert.equal(reduced.final, false);
  clock.now += 5 * MINUTE;
  gate.fail = true;
  gate.open = new Promise((resolve) => (release = resolve));
  const during = (await get(url)).body.motion;
  assert.equal(during.kind, 'reduced');
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = (await get(url)).body.motion;
  assert.equal(after.kind, 'reduced');
  assert.equal(after.stations[0].kind, 'tracked');
});

test('motion is refused for a time that is not an advertised tick', async () => {
  const { get } = harness();
  assert.equal(
    (await get('/motion?time=2026-10-11T03:25:00.000Z')).status,
    400,
  );
  assert.equal((await get('/motion?time=garbage')).status, 400);
});
