import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { densifyRhumb, rhumbLine } from './rhumb.js';

const d = Math.PI / 180;

test('a rhumb line is the default renderer’s, length and points', () => {
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cases = [
    [
      [-40, 35],
      [-30, 40],
    ],
    [
      [170, -10],
      [-170, 12],
    ],
    [
      [10, 20],
      [60, 20],
    ],
    [
      [5, -60],
      [5, 70],
    ],
  ];
  for (let i = 0; i < 40; i++)
    cases.push([
      [random() * 360 - 180, random() * 160 - 80],
      [random() * 360 - 180, random() * 160 - 80],
    ]);
  for (const [[lonA, latA], [lonB, latB]] of cases) {
    const start = { lon: lonA * d, lat: latA * d };
    const end = { lon: lonB * d, lat: latB * d };
    let cesium;
    try {
      cesium = new Cesium.EllipsoidRhumbLine(
        new Cesium.Cartographic(start.lon, start.lat),
        new Cesium.Cartographic(end.lon, end.lat),
      );
    } catch {
      continue; // antipodal: the renderer refuses it too
    }
    const line = rhumbLine(start, end);
    assert.ok(
      Math.abs(line.distance - cesium.surfaceDistance) <=
        1e-9 * cesium.surfaceDistance + 1e-6,
      `${lonA},${latA} → ${lonB},${latB}`,
    );
    assert.ok(Math.abs(line.heading - cesium.heading) < 1e-12);
    for (const f of [0.1, 0.5, 0.9]) {
      const ours = line.at(line.distance * f);
      const theirs = cesium.interpolateUsingSurfaceDistance(
        cesium.surfaceDistance * f,
      );
      assert.ok(Math.abs(ours.lon - theirs.longitude) < 1e-12);
      assert.ok(Math.abs(ours.lat - theirs.latitude) < 1e-12);
    }
  }
});

test('a densified path keeps its points and spaces the rest under the granularity', () => {
  const path = [
    { lon: -40 * d, lat: 35 * d },
    { lon: -39.95 * d, lat: 35 * d },
    { lon: -30 * d, lat: 40 * d },
  ];
  const dense = densifyRhumb(path, 9999);
  assert.equal(dense[0], path[0]);
  assert.equal(dense[1], path[1], 'a short leg adds nothing');
  assert.equal(dense.at(-1), path[2]);
  const leg = rhumbLine(path[1], path[2]);
  assert.equal(dense.length, 2 + Math.ceil(leg.distance / 9999));
  for (let i = 2; i < dense.length; i++)
    assert.ok(rhumbLine(dense[i - 1], dense[i]).distance < 9999);
  assert.deepEqual(densifyRhumb([path[0]]), [path[0]]);
});
