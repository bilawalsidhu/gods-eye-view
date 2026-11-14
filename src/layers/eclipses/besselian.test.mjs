import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EARTH_RADIUS_M,
  centralDurationSeconds,
  centralPath,
  centralPoint,
  centralSpan,
  circumstancesAt,
  eclipseAt,
  fromGeodetic,
  nextEclipseIndex,
  penumbralSpan,
  shadowEdgePoint,
  shadowFrame,
  shadowMotion,
  toGeodetic,
} from './besselian.js';
import { createEclipseElementsSource } from './source.js';

const catalog = await createEclipseElementsSource().getCatalog();
const byId = (id) => catalog.find((eclipse) => eclipse.id === id);
const utc = (ms) => new Date(ms).toISOString().slice(11, 19);

/** Degrees between two geodetic points, near enough for small gaps. */
function gapDegrees(a, b) {
  const lon = ((a.lon - b.lon + 540) % 360) - 180;
  return Math.hypot(a.lat - b.lat, lon * Math.cos((a.lat * Math.PI) / 180));
}

test('the catalogue holds every solar eclipse from 1583 to 3000, in time order, none overlapping', () => {
  assert.equal(catalog.length, 3397);
  assert.equal(catalog[0].year, 1583);
  assert.equal(catalog.at(-1).year, 3000);
  for (let index = 1; index < catalog.length; index += 1)
    assert.ok(catalog[index].startMs > catalog[index - 1].endMs);
  const kinds = Object.groupBy(catalog, ({ kind }) => kind);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(kinds).map(([kind, list]) => [kind, list.length]),
    ),
    { total: 919, annular: 1149, hybrid: 123, partial: 1206 },
  );
});

test('the axis meets the ground at greatest eclipse where the catalogue says, for every central eclipse', () => {
  let checked = 0;
  for (const eclipse of catalog) {
    const point = centralPoint(eclipse, eclipse.greatestMs);
    if (eclipse.kind === 'partial' || !point) continue;
    checked += 1;
    assert.ok(
      gapDegrees(toGeodetic(point), eclipse.greatest) < 0.01,
      `${eclipse.id} is off the catalogue's greatest eclipse`,
    );
    if (eclipse.centralDurationSeconds > 0)
      assert.ok(
        Math.abs(
          centralDurationSeconds(eclipse, eclipse.greatestMs) -
            eclipse.centralDurationSeconds,
        ) < 1,
        `${eclipse.id} lasts a different time from the catalogue`,
      );
  }
  assert.ok(checked > 2100);
});

test('the total eclipse of 2 August 2027 matches the published circumstances', () => {
  const eclipse = byId('2027-08-02');
  assert.equal(eclipse.kind, 'total');
  assert.equal(utc(eclipse.greatestMs), '10:06:34');
  const span = penumbralSpan(eclipse);
  // NASA: the partial eclipse begins 07:30:10 and ends 12:43:01 UT.
  assert.ok(Math.abs(span.startMs - Date.UTC(2027, 7, 2, 7, 30, 10)) < 15_000);
  assert.ok(Math.abs(span.endMs - Date.UTC(2027, 7, 2, 12, 43, 1)) < 15_000);
  const central = centralSpan(eclipse);
  assert.equal(utc(central.startMs).slice(0, 5), '08:24');
  assert.equal(utc(central.endMs).slice(0, 5), '11:48');

  // The path's width at greatest eclipse, across the direction of travel.
  const frame = shadowFrame(eclipse, eclipse.greatestMs);
  const point = centralPoint(eclipse, eclipse.greatestMs, frame);
  const { angle } = shadowMotion(eclipse, eclipse.greatestMs, point);
  const a = shadowEdgePoint(frame, 'umbra', angle + Math.PI / 2);
  const b = shadowEdgePoint(frame, 'umbra', angle - Math.PI / 2);
  const widthKm =
    (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * EARTH_RADIUS_M) / 1000;
  assert.ok(Math.abs(widthKm - eclipse.pathWidthKm) < 1);
});

test('an observer in the path sees totality; one outside sees a partial eclipse or none', () => {
  const eclipse = byId('2027-08-02');
  // Luxor, inside the path at greatest eclipse.
  const luxor = circumstancesAt(
    eclipse,
    eclipse.greatestMs,
    fromGeodetic(25.69, 32.64),
  );
  assert.equal(luxor.central, true);
  assert.equal(luxor.total, true);
  assert.ok(luxor.magnitude > 1);
  // Rome: a deep partial eclipse.
  const rome = circumstancesAt(
    eclipse,
    Date.UTC(2027, 7, 2, 9, 10),
    fromGeodetic(41.9, 12.5),
  );
  assert.equal(rome.central, false);
  assert.ok(rome.magnitude > 0.6 && rome.magnitude < 0.9);
  // São Paulo: far outside the penumbra.
  const saoPaulo = circumstancesAt(
    eclipse,
    eclipse.greatestMs,
    fromGeodetic(-23.5, -46.6),
  );
  assert.equal(saoPaulo.magnitude, 0);
});

test('the central path runs in time order between two edges, the ground between them', () => {
  const eclipse = byId('2024-04-08');
  const path = centralPath(eclipse);
  assert.ok(path.center.length > 200);
  assert.equal(path.left.length, path.right.length);
  for (let index = 1; index < path.center.length; index += 1)
    assert.ok(path.center[index].ms > path.center[index - 1].ms);
  // Dallas saw totality; the edges pass either side of it.
  const dallas = { lat: 32.78, lon: -96.8 };
  const nearest = (points) =>
    Math.min(...points.map((point) => gapDegrees(point, dallas)));
  assert.ok(nearest(path.center) < 1);
  assert.ok(nearest(path.left) < 2 && nearest(path.right) < 2);
  // The band's outline is closed, runs round both edges and both rounded
  // ends, and never strays far from the central line.
  assert.deepEqual(path.outline[0], path.outline.at(-1));
  assert.equal(path.outline.length, path.left.length + path.right.length + 19);
  const farthest = Math.max(
    ...path.outline.map((point) =>
      Math.min(...path.center.map((centre) => gapDegrees(point, centre))),
    ),
  );
  assert.ok(farthest < 2, `an outline point is ${farthest}° from the path`);
  // Its ends are as wide as the band beside them: no pinch, no flare.
  const width = (index) => gapDegrees(path.left[index], path.right[index]);
  assert.ok(width(0) > 0.5 * width(5) && width(0) < 1.5 * width(5));
  assert.ok(width(path.left.length - 1) > 0.5 * width(path.left.length - 6));
});

test('a partial eclipse has no central path; an annular one has a positive umbra radius on the plane', () => {
  const partial = catalog.find(({ kind }) => kind === 'partial');
  assert.equal(centralSpan(partial), null);
  assert.equal(centralPath(partial), null);
  const annular = byId('2023-10-14');
  assert.ok(shadowFrame(annular, annular.greatestMs).l2 > 0);
  assert.equal(
    circumstancesAt(
      annular,
      annular.greatestMs,
      centralPoint(annular, annular.greatestMs),
    ).total,
    false,
  );
});

test('the eclipse under way is found by time; between eclipses there is none', () => {
  assert.equal(eclipseAt(catalog, Date.UTC(2027, 7, 2, 10)).id, '2027-08-02');
  assert.equal(eclipseAt(catalog, Date.UTC(2027, 7, 20)), null);
  assert.equal(
    catalog[nextEclipseIndex(catalog, Date.UTC(2027, 1, 7))].id,
    '2027-08-02',
  );
  assert.equal(
    nextEclipseIndex(catalog, Date.UTC(3200, 0, 1)),
    catalog.length - 1,
  );
});

test('geodetic points survive the trip to Earth-fixed coordinates and back', () => {
  for (const [lat, lon] of [
    [0, 0],
    [45, 100],
    [-33.9, 18.4],
    [89, -170],
  ]) {
    const back = toGeodetic(fromGeodetic(lat, lon));
    assert.ok(Math.abs(back.lat - lat) < 1e-9);
    assert.ok(Math.abs(back.lon - lon) < 1e-9);
  }
});
