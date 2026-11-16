import test from 'node:test';
import assert from 'node:assert/strict';
import { circumstancesAt, fromGeodetic, penumbralSpan } from './besselian.js';
import { createEclipseElementsSource } from './source.js';
import {
  VISIBILITY_LEVEL,
  contourLines,
  smoothLine,
  visibilityGrid,
  visibilityLimit,
} from './visibility.js';

const catalog = await createEclipseElementsSource().getCatalog();
const byId = (id) => catalog.find((eclipse) => eclipse.id === id);
const eclipse = byId('2027-08-02');

/** Whether a place sees any of an eclipse, worked out the long way. */
function sees(target, lat, lon, margin = 0) {
  const span = penumbralSpan(target);
  const point = fromGeodetic(lat, lon);
  for (let ms = span.startMs; ms <= span.endMs; ms += 60_000) {
    const seen = circumstancesAt(target, ms, point);
    if (seen.sunUp && seen.magnitude > VISIBILITY_LEVEL + margin) return true;
  }
  return false;
}

/** Whether a point lies inside closed lines, by counting crossings eastward. */
function inside(lines, lat, lon) {
  let crossings = 0;
  for (const line of lines)
    for (let index = 0; index < line.length - 1; index += 1) {
      const a = line[index];
      const b = line[index + 1];
      if (a.lat > lat === b.lat > lat) continue;
      const at = a.lon + ((lat - a.lat) / (b.lat - a.lat)) * (b.lon - a.lon);
      if (at > lon) crossings += 1;
    }
  return crossings % 2 === 1;
}

test('a contour round one high node is a closed loop through the four edges beside it', () => {
  const values = new Float32Array(9);
  values[4] = 1;
  const lines = contourLines({ values, rows: 3, columns: 3, stepDeg: 90 }, 0.5);
  assert.equal(lines.length, 1);
  const [loop] = lines;
  assert.equal(loop.length, 5);
  assert.deepEqual(loop[0], loop.at(-1));
  // Halfway along each edge from the centre node (0°, 90°W).
  assert.deepEqual(
    loop
      .slice(0, 4)
      .map(({ lat, lon }) => `${lat},${lon}`)
      .sort(),
    ['-45,-90', '0,-135', '0,-45', '45,-90'],
  );
});

test("smoothing rounds corners, keeps an open line's ends and a closed line closed", () => {
  const corner = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 10 },
    { lat: 10, lon: 10 },
  ];
  const open = smoothLine(corner, 1);
  assert.deepEqual(open[0], corner[0]);
  assert.deepEqual(open.at(-1), corner.at(-1));
  // The corner itself is cut off.
  assert.ok(!open.some(({ lat, lon }) => lat === 0 && lon === 10));
  const square = [...corner, { lat: 10, lon: 0 }, { lat: 0, lon: 0 }];
  const closed = smoothLine(square, 2);
  assert.deepEqual(closed[0], closed.at(-1));
  assert.ok(closed.length > square.length);
  // No point leaves the square.
  assert.ok(
    closed.every(
      ({ lat, lon }) => lat >= 0 && lat <= 10 && lon >= 0 && lon <= 10,
    ),
  );
});

test('the grid is above zero where the eclipse is seen and below where it is not', () => {
  const grid = visibilityGrid(eclipse, 5);
  assert.equal(grid.rows, 37);
  assert.equal(grid.columns, 73);
  const at = (lat, lon) =>
    grid.values[((lat + 90) / 5) * grid.columns + (lon + 180) / 5];
  // Near Luxor and in Rome it is seen; in São Paulo and Tokyo it is not.
  assert.ok(at(25, 35) > 0.5);
  assert.ok(at(40, 10) > 0.3);
  assert.ok(at(-25, -45) < 0);
  assert.ok(at(35, 140) < 0);
  // The first and last columns are the same meridian.
  for (let row = 0; row < grid.rows; row += 1)
    assert.ok(
      Math.abs(
        grid.values[row * grid.columns] -
          grid.values[row * grid.columns + grid.columns - 1],
      ) < 1e-6,
    );
});

// (Eclipses whose region wraps a pole or the date line are left to the grid
// test above: counting crossings on a flat map does not hold there.)
for (const id of ['2027-08-02', '2024-04-08', '2029-01-14']) {
  test(`the limit of ${id} divides places that see it from places that do not`, () => {
    const target = byId(id);
    const lines = visibilityLimit(target);
    assert.ok(lines.length >= 1);
    for (const line of lines)
      for (const { lat, lon } of line)
        assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
    // Sample the globe: away from the limit by a margin, the side of the
    // line a place falls on agrees with whether it sees the eclipse.
    let checked = 0;
    for (let lat = -80; lat <= 80; lat += 10)
      for (let lon = -175; lon <= 175; lon += 10) {
        const clearlySees = sees(target, lat, lon, 0.08);
        const clearlyNot = !sees(target, lat, lon, -0.009);
        if (!clearlySees && !clearlyNot) continue;
        // Places whose only view is with the Sun within a few degrees of
        // the horizon sit on the limit itself: leave them out.
        const nearby = [
          [lat + 3, lon],
          [lat - 3, lon],
          [lat, lon + 3],
          [lat, lon - 3],
        ];
        if (
          nearby.some(([a, b]) => sees(target, a, b, 0.08) !== clearlySees) &&
          clearlySees
        )
          continue;
        if (clearlyNot && nearby.some(([a, b]) => sees(target, a, b, -0.009)))
          continue;
        checked += 1;
        assert.equal(
          inside(lines, lat, lon),
          clearlySees,
          `${lat}, ${lon} is on the wrong side of the limit`,
        );
      }
    assert.ok(checked > 300);
  });
}

test('the limit is smooth: no sharp turns from one step to the next', () => {
  for (const line of visibilityLimit(eclipse)) {
    let sharp = 0;
    for (let index = 1; index < line.length - 1; index += 1) {
      const a = line[index - 1];
      const b = line[index];
      const c = line[index + 1];
      const before = Math.atan2(b.lat - a.lat, b.lon - a.lon);
      const after = Math.atan2(c.lat - b.lat, c.lon - b.lon);
      let turn = Math.abs(after - before);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn > Math.PI / 4) sharp += 1;
    }
    assert.ok(sharp <= 4, `${sharp} sharp turns in a line of ${line.length}`);
  }
});
