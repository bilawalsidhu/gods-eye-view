import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDeg,
  segmentDistanceSqM,
  nearestRoadAxis,
  resolveAxisDirection,
  buildRoadQuery,
} from '../../server/providers/cctv/roadHeadings.js';

/** ne511-148, "I-80: 42nd St in Omaha". */
const CAMERA = { lat: 41.22445, lon: -95.9759 };
/** I-80 through that point, as OSM draws it. */
const I80 = {
  geometry: [
    { lat: 41.2242, lon: -95.9785 },
    { lat: 41.2246, lon: -95.9745 },
  ],
};

test('bearings are great-circle and wrap into [0,360)', () => {
  assert.equal(
    Math.round(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })),
    90,
  );
  assert.equal(
    Math.round(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })),
    0,
  );
  assert.equal(
    Math.round(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })),
    270,
  );
});

test('point-to-segment distance clamps to the segment ends', () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0, lon: 0.001 };
  // Straight out from the middle of the segment.
  const mid = Math.sqrt(segmentDistanceSqM({ lat: 0.0005, lon: 0.0005 }, a, b));
  assert.ok(mid > 50 && mid < 60, `perpendicular ~55 m, got ${mid}`);
  // Past the end: distance is to the endpoint, not to the infinite line.
  const past = Math.sqrt(segmentDistanceSqM({ lat: 0, lon: 0.002 }, a, b));
  assert.ok(past > 100 && past < 120, `beyond-end ~111 m, got ${past}`);
  // A degenerate segment is just its start point.
  assert.ok(segmentDistanceSqM({ lat: 0, lon: 0 }, a, a) === 0);
});

test('a camera aligns to the real road axis, not its hash prior', () => {
  const axis = nearestRoadAxis(CAMERA, [I80]);
  assert.ok(axis !== null, 'expected a road within the match radius');
  // I-80 runs ~77°/257° here; the hash prior was 157.5°.
  const onAxis = Math.min(
    Math.abs(axis - 77),
    Math.abs(((axis + 180) % 360) - 77),
  );
  assert.ok(onAxis < 12, `expected ~77/257°, got ${axis.toFixed(1)}°`);
});

test('a road beyond the match radius yields no axis', () => {
  const far = { lat: 41.5, lon: -96.5 };
  assert.equal(nearestRoadAxis(far, [I80]), null);
  assert.equal(nearestRoadAxis(CAMERA, []), null);
  assert.equal(nearestRoadAxis(CAMERA, [{ geometry: [] }]), null);
});

test('the nearest SEGMENT wins, not the way as a whole', () => {
  // A way that runs east then turns hard north. A camera by the eastward leg
  // must get ~90°, not the endpoint-to-endpoint diagonal.
  const elbow = {
    geometry: [
      { lat: 41.0, lon: -96.002 },
      { lat: 41.0, lon: -96.0 },
      { lat: 41.02, lon: -96.0 },
    ],
  };
  const axis = nearestRoadAxis({ lat: 41.0005, lon: -96.001 }, [elbow]);
  assert.ok(Math.abs(axis - 90) < 5, `expected ~90°, got ${axis.toFixed(1)}°`);
});

test('a true EB/WB token picks which way down the axis', () => {
  // Axis 77°/257°: westbound must take 257°, eastbound 77°.
  assert.ok(
    Math.abs(resolveAxisDirection(77, 'I-80: Kearney WB DMS', 0) - 257) < 1,
  );
  assert.ok(
    Math.abs(resolveAxisDirection(77, 'I-80: Grand Island EB DMS', 0) - 77) < 1,
  );
});

test('positional titles never steer the direction; the prior breaks the tie', () => {
  // "E of Lincoln" is where the camera sits, so it must not act like
  // eastbound; the prior decides, and here it is nearer the 257° end.
  const picked = resolveAxisDirection(77, 'I-80: Scale E of Lincoln', 250);
  assert.ok(Math.abs(picked - 257) < 1, `got ${picked}`);
  // Same title, a prior near the other end, and the other end is chosen.
  assert.ok(
    Math.abs(resolveAxisDirection(77, 'I-80: Scale E of Lincoln', 70) - 77) < 1,
  );
  // Both choices always stay on the road axis.
  for (const prior of [0, 90, 180, 270]) {
    const out = resolveAxisDirection(77, 'I-80: Overton Exit', prior);
    assert.ok(Math.abs(out - 77) < 1 || Math.abs(out - 257) < 1);
  }
});

test('the query is a union of independent arounds, never a polyline list', () => {
  const body = buildRoadQuery([
    { lat: 41.22445, lon: -95.9759 },
    { lat: 41.1428, lon: -102.9783 },
  ]);
  const ql = decodeURIComponent(body.replace(/^data=/, ''));
  // Two separate clauses, each with its own coordinate pair.
  assert.equal((ql.match(/way\(around:/g) || []).length, 2);
  assert.match(ql, /^\[out:json\]\[timeout:\d+\];\(.*\);out geom;$/);
  // Guards the polyline form — one `around` carrying every coordinate —
  // which Overpass reads as "within r of the path joining them".
  assert.doesNotMatch(ql, /around:\d+(,-?\d+\.\d+){4,}/);
});
