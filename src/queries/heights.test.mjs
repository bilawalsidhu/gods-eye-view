import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Cesium from 'cesium';
import { heightsFor } from './heights.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const AUSTIN = { lon: -97.74, lat: 30.27 };

function scene(overrides = {}) {
  const calls = [];
  return {
    calls,
    sampleHeightSupported: true,
    clampToHeightSupported: true,
    sampleHeight(carto, exclude) {
      calls.push(['sampleHeight', carto, exclude]);
      return 150;
    },
    clampToHeight(position, exclude) {
      calls.push(['clampToHeight', position, exclude]);
      return Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 150);
    },
    globe: { getHeight: () => 140 },
    ...overrides,
  };
}

test('now reads the drawn surface, seeing through what the caller excludes', () => {
  const s = scene();
  const own = [{ name: 'own marker' }];
  assert.equal(heightsFor(s).now(AUSTIN, { exclude: own }), 150);
  const [[, carto, exclude]] = s.calls;
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(carto.longitude) - AUSTIN.lon) < 1e-9,
  );
  assert.equal(exclude, own);
});

test('now takes a Cartographic as it is', () => {
  const s = scene();
  const carto = Cesium.Cartographic.fromDegrees(AUSTIN.lon, AUSTIN.lat);
  heightsFor(s).now(carto);
  assert.equal(s.calls[0][1], carto);
});

test('a miss is null, whatever form it takes', () => {
  for (const sampleHeight of [
    () => undefined,
    () => Number.NaN,
    () => {
      throw new Error('depth textures unsupported');
    },
  ]) {
    assert.equal(heightsFor(scene({ sampleHeight })).now(AUSTIN), null);
  }
  assert.equal(
    heightsFor(scene({ sampleHeight: undefined })).now(AUSTIN),
    null,
  );
  assert.equal(heightsFor(scene()).now({ lon: 'x', lat: 1 }), null);
});

test('terrain reads the loaded terrain tiles only', () => {
  const s = scene();
  assert.equal(heightsFor(s).now(AUSTIN, { against: 'terrain' }), 140);
  assert.equal(s.calls.length, 0, 'the drawn surface is not sampled');
  assert.equal(
    heightsFor(scene({ globe: undefined })).now(AUSTIN, { against: 'terrain' }),
    null,
  );
});

test('clampNow moves a position onto the surface, or misses with null', () => {
  const s = scene();
  const own = [{}];
  const position = Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 0);
  const clamped = heightsFor(s).clampNow(position, { exclude: own });
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(clamped).height - 150) < 1e-6,
  );
  assert.equal(s.calls[0][2], own);
  assert.equal(
    heightsFor(scene({ clampToHeight: () => undefined })).clampNow(position),
    null,
  );
});

test('batch answers each point once the tiles stream, null per miss', async () => {
  let seen;
  const s = scene({
    async sampleHeightMostDetailed(cartos, exclude) {
      seen = exclude;
      cartos.forEach((c, i) => (c.height = i === 1 ? undefined : 100 + i));
      return cartos;
    },
  });
  const own = [{}];
  const heights = await heightsFor(s).batch(
    [
      AUSTIN,
      { lon: 0, lat: 0 },
      Cesium.Cartographic.fromDegrees(1, 1, 999),
      { lon: 'bad' },
    ],
    { exclude: own },
  );
  assert.deepEqual(heights, [100, null, 102, null]);
  assert.equal(seen, own);
});

test('batch leaves the caller’s Cartographics alone', async () => {
  const s = scene({
    async sampleHeightMostDetailed(cartos) {
      cartos.forEach((c) => (c.height = 5));
      return cartos;
    },
  });
  const carto = Cesium.Cartographic.fromDegrees(1, 1, 999);
  await heightsFor(s).batch([carto]);
  assert.equal(carto.height, 999);
});

test('batch misses everything when the scene cannot stream, and rejects when it fails', async () => {
  assert.deepEqual(await heightsFor(scene()).batch([AUSTIN]), [null]);
  const failing = scene({
    sampleHeightMostDetailed: async () => {
      throw new Error('scene destroyed');
    },
    clampToHeightMostDetailed: async () => {
      throw new Error('scene destroyed');
    },
  });
  await assert.rejects(heightsFor(failing).batch([AUSTIN]), /destroyed/);
  await assert.rejects(
    heightsFor(failing).clampBatch([Cesium.Cartesian3.UNIT_X]),
    /destroyed/,
  );
  assert.deepEqual(
    await heightsFor(scene()).batch([AUSTIN], { against: 'terrain' }),
    [null],
    'no terrain provider, no terrain heights',
  );
});

test('clampBatch clamps copies and misses per position', async () => {
  const s = scene({
    async clampToHeightMostDetailed(positions) {
      return positions.map((p, i) => (i === 0 ? p : undefined));
    },
  });
  const position = Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 0);
  const [first, second] = await heightsFor(s).clampBatch([position, position]);
  assert.notEqual(first, position, 'the caller’s position is not mutated');
  assert.equal(second, null);
});

test('supported reports whether the drawn surface can be queried', () => {
  assert.deepEqual(heightsFor(scene()).supported(), {
    surface: true,
    clamp: true,
  });
  assert.deepEqual(
    heightsFor(
      scene({
        sampleHeightSupported: false,
        clampToHeightSupported: undefined,
      }),
    ).supported(),
    { surface: false, clamp: false },
  );
});

test('supported answers without allocating', () => {
  const s = scene();
  assert.equal(heightsFor(s).supported(), heightsFor(s).supported());
});

test('one service per scene', () => {
  const s = scene();
  assert.equal(heightsFor(s), heightsFor(s));
  assert.notEqual(heightsFor(s), heightsFor(scene()));
});

test('height queries go through the service', () => {
  // A renderer that answers heights from a cache or asynchronously plugs in
  // at src/queries/heights.js; a site that asks Cesium directly bypasses it.
  const SERVICE = 'src/queries/heights.js';
  // The renderer contract's own height members, and the stub and suite that
  // implement and call them, are not Cesium.
  const CONTRACT = /^src\/render\/(contract|stub|conformance)\//;
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
