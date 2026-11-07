import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import { bindRenderer } from '../render/rendererOf.js';
import { heightsOf } from './heights.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const AUSTIN = { lon: -97.74, lat: 30.27 };

/**
 * A viewer double with a fake renderer whose query port answers `height` (a
 * number, or a function of the point and options) and records each call.
 */
function bound({
  height = 150,
  capabilities = ['sampleHeight'],
  ...query
} = {}) {
  const calls = [];
  const viewer = {};
  const answer = (point, options) =>
    typeof height === 'function' ? height(point, options) : height;
  const port = {
    sampleHeightNow(point, options) {
      calls.push(['now', { ...point }, options]);
      return answer(point, options);
    },
    async sampleHeight(points, options) {
      calls.push(['sample', points, options]);
      return points.map((point) => {
        const h = answer(point, options);
        return h === null
          ? null
          : { height: h, confidence: 1, source: 'tiles', lod: 'finest' };
      });
    },
    async clampToSurface(positions, options) {
      calls.push(['clamp', positions, options]);
      return positions.map((p) => {
        const { lon, lat } = toLonLatH(p);
        const h = answer({ lon, lat }, options);
        return h === null ? null : fromDegrees(lon, lat, h);
      });
    },
    ...query,
  };
  bindRenderer(viewer, { query: port, capabilities: new Set(capabilities) });
  return { viewer, calls, port };
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('now asks the query port, seeing through the sets the caller excludes', () => {
  const { viewer, calls } = bound();
  assert.equal(heightsOf(viewer).now(AUSTIN, { exclude: ['own:1'] }), 150);
  assert.deepEqual(calls, [['now', AUSTIN, { exclude: ['own:1'] }]]);
});

test('now takes radians as a cartographic gives them', () => {
  const { viewer, calls } = bound();
  heightsOf(viewer).now({
    longitude: (AUSTIN.lon * Math.PI) / 180,
    latitude: (AUSTIN.lat * Math.PI) / 180,
  });
  const [[, point, options]] = calls;
  assert.ok(near(point.lon, AUSTIN.lon) && near(point.lat, AUSTIN.lat));
  assert.deepEqual(options, {});
});

test('a miss is null, whatever form it takes', () => {
  for (const height of [
    null,
    () => undefined,
    Number.NaN,
    () => {
      throw new Error('lost context');
    },
  ]) {
    const { viewer } = bound({ height });
    assert.equal(heightsOf(viewer).now(AUSTIN), null);
  }
  const { viewer, calls } = bound();
  assert.equal(heightsOf(viewer).now({ lon: 'x', lat: 1 }), null);
  assert.equal(calls.length, 0, 'a bad point is not asked');
  assert.equal(heightsOf({}).now(AUSTIN), null, 'no renderer, no height');
});

test('against picks the surface the port samples', () => {
  const { viewer, calls } = bound({
    height: (_, { against }) => (against === 'terrain' ? 140 : 150),
  });
  assert.equal(heightsOf(viewer).now(AUSTIN, { against: 'terrain' }), 140);
  assert.deepEqual(calls[0][2], { against: 'terrain' });
});

test('clampNow moves a position onto the surface, or misses with null', () => {
  const { viewer, calls } = bound();
  const position = fromDegrees(AUSTIN.lon, AUSTIN.lat, 0);
  const clamped = heightsOf(viewer).clampNow(position, { exclude: ['own:1'] });
  const at = toLonLatH(clamped);
  assert.ok(near(at.height, 150) && near(at.lon, AUSTIN.lon, 1e-9));
  assert.deepEqual(calls[0][2], { exclude: ['own:1'] });
  assert.equal(
    heightsOf(bound({ height: null }).viewer).clampNow(position),
    null,
  );
  assert.equal(heightsOf(viewer).clampNow({ x: Number.NaN, y: 0, z: 0 }), null);
  assert.equal(heightsOf(viewer).clampNow({ x: 0, y: 0, z: 0 }), null);
});

test('batch asks for the finest heights, null per miss and per bad point', async () => {
  const { viewer, calls } = bound({
    height: (point) => (point.lon === 0 ? null : 100),
  });
  const heights = await heightsOf(viewer).batch(
    [
      AUSTIN,
      { lon: 0, lat: 0 },
      { lon: 'bad' },
      { longitude: 0.1, latitude: 0.1 },
    ],
    { exclude: ['own:1'] },
  );
  assert.deepEqual(heights, [100, null, null, 100]);
  const [[, points, options]] = calls;
  assert.equal(points.length, 3, 'only valid points are asked');
  assert.deepEqual(options, { exclude: ['own:1'], mostDetailed: true });
});

test('batch misses everything without a renderer, and rejects when the query fails', async () => {
  assert.deepEqual(await heightsOf({}).batch([AUSTIN]), [null]);
  assert.deepEqual(await heightsOf({}).clampBatch([{ x: 1, y: 0, z: 0 }]), [
    null,
  ]);
  const { viewer } = bound({
    sampleHeight: async () => {
      throw new Error('scene destroyed');
    },
    clampToSurface: async () => {
      throw new Error('scene destroyed');
    },
  });
  await assert.rejects(heightsOf(viewer).batch([AUSTIN]), /destroyed/);
  await assert.rejects(
    heightsOf(viewer).clampBatch([{ x: 1, y: 0, z: 0 }]),
    /destroyed/,
  );
});

test('a destroyed scene fails the asynchronous queries', async () => {
  const viewer = { isDestroyed: () => true };
  await assert.rejects(heightsOf(viewer).batch([AUSTIN]), /destroyed/);
  await assert.rejects(
    heightsOf(viewer).clampBatch([{ x: 1, y: 0, z: 0 }]),
    /destroyed/,
  );
  assert.equal(heightsOf(viewer).now(AUSTIN), null);
});

test('clampBatch clamps copies and misses per position', async () => {
  const { viewer, calls } = bound({
    height: (point) => (point.lon > 0 ? null : 150),
  });
  const position = fromDegrees(AUSTIN.lon, AUSTIN.lat, 0);
  const [first, second] = await heightsOf(viewer).clampBatch([
    position,
    fromDegrees(10, 10, 0),
  ]);
  assert.ok(near(toLonLatH(first).height, 150));
  assert.equal(second, null);
  assert.notEqual(
    calls[0][1][0],
    position,
    'the caller’s position is not passed on',
  );
});

test('supported reports the renderer’s sampleHeight capability', () => {
  assert.deepEqual(heightsOf(bound().viewer).supported(), {
    surface: true,
    clamp: true,
  });
  assert.deepEqual(heightsOf(bound({ capabilities: [] }).viewer).supported(), {
    surface: false,
    clamp: false,
  });
  assert.deepEqual(heightsOf({}).supported(), { surface: false, clamp: false });
});

test('supported answers without allocating', () => {
  const { viewer } = bound();
  assert.equal(heightsOf(viewer).supported(), heightsOf(viewer).supported());
});

test('one service per host', () => {
  const { viewer } = bound();
  assert.equal(heightsOf(viewer), heightsOf(viewer));
  assert.notEqual(heightsOf(viewer), heightsOf(bound().viewer));
});

test('height queries go through the service', () => {
  // The app asks the query port through src/queries/heights.js; a site that
  // asks the port's height members itself, or Cesium directly, bypasses it.
  const SERVICE = 'src/queries/heights.js';
  // The renderer contract's own height members, and the renderer, stub and suite
  // that implement and call them: the Cesium adapter answers them through
  // this service.
  const CONTRACT = /^src\/render\/(contract|stub|conformance|cesium)\//;
  const NAMES =
    'sampleHeight|clampToHeight|sampleHeightMostDetailed|clampToHeightMostDetailed|getHeight';
  const direct = new RegExp(
    `\\.(${NAMES})\\b|\\[\\s*['"\`](${NAMES})['"\`]\\s*\\]|\\bsampleTerrain(MostDetailed)?\\b`,
  );
  const walk = (dir) =>
    fs
      .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap((entry) => {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(rel);
        return /\.(js|vue)$/.test(entry.name) ? [rel] : [];
      });
  const offenders = walk('src').filter((file) => {
    if (file === SERVICE || CONTRACT.test(file.split(path.sep).join('/')))
      return false;
    const code = fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return direct.test(code);
  });
  assert.deepEqual(offenders, []);
});
