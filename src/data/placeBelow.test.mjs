// src/data/placeBelow.test.mjs — what the ground track is over, offline:
// division and country on land (with the populated place in view from 8x),
// the smallest named sea, else the ocean; and the tracker that keeps it
// current without a lookup per frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NEAR_PLACE_MIN_ZOOM,
  PLACE_LOOKUP_MIN_MOVE_KM,
  PLACE_LOOKUP_MIN_MS,
  createPlaceTracker,
  nearPlaceRadiusKm,
  placeBelow,
  placePackLoads,
} from './placeBelow.js';

const PLACES_PACK = new URL(
  './local_data/natural_earth/populated_places.json',
  import.meta.url,
);

// Runs first: the counters are module-wide.
test('the division and place packs load only when a lookup needs them', async () => {
  assert.deepEqual(placePackLoads, { divisions: 0, places: 0 });
  await placeBelow(42, 51, { nearKm: 50 });
  assert.deepEqual(placePackLoads, { divisions: 0, places: 0 }, 'at sea');
  await placeBelow(30.9, 104.2);
  assert.deepEqual(placePackLoads, { divisions: 1, places: 0 }, 'at 1x');
  await placeBelow(30.9, 104.2, { nearKm: 60 });
  await placeBelow(31.2, 104.5, { nearKm: 30 });
  assert.deepEqual(placePackLoads, { divisions: 1, places: 1 }, 'kept');
});

test('the populated-place pack is compact rows of name, position and rank', () => {
  const bytes = readFileSync(PLACES_PACK);
  assert.ok(bytes.length < 300_000, `${bytes.length} bytes`);
  const pack = JSON.parse(bytes);
  assert.match(pack.meta.url, /nvkelso\/natural-earth-vector/);
  assert.match(pack.meta.license, /^Public domain/);
  assert.ok(pack.places.length > 7000);
  for (const [name, lat, lon, scalerank, rankMax] of pack.places) {
    assert.equal(typeof name, 'string');
    assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180, name);
    assert.ok(Number.isInteger(scalerank) && Number.isInteger(rankMax), name);
  }
});

test('over land the place is the division and country, with its ISO code', async () => {
  assert.deepEqual(await placeBelow(48.85, 2.35), {
    kind: 'country',
    name: 'France',
    countryCode: 'FR',
    division: 'Paris',
    near: null,
  });
  // Across the antimeridian, and with a wrapped longitude.
  assert.equal((await placeBelow(66, -175)).countryCode, 'RU');
  assert.equal((await placeBelow(-17.8, 178)).countryCode, 'FJ');
  assert.equal((await placeBelow(48.85, 362.35)).countryCode, 'FR');
});

test('at 1x a point in Sichuan reads Sichuan, China, with no city', async () => {
  assert.deepEqual(await placeBelow(30.9, 104.2), {
    kind: 'country',
    name: 'China',
    countryCode: 'CN',
    division: 'Sichuan',
    near: null,
  });
  assert.equal(nearPlaceRadiusKm(1, 1400), null);
  assert.equal(nearPlaceRadiusKm(NEAR_PLACE_MIN_ZOOM / 2, 300), null);
});

test('from 8x the most prominent populated place in view is named', async () => {
  assert.equal(NEAR_PLACE_MIN_ZOOM, 8);
  // An 8x view ~120 km wide: Chengdu lies ~30 km off, inside half of it.
  const nearKm = nearPlaceRadiusKm(8, 120);
  assert.equal(nearKm, 60);
  const place = await placeBelow(30.9, 104.2, { nearKm });
  assert.equal(place.division, 'Sichuan');
  assert.equal(place.near, 'Chengdu');
  // Deyang lies nearer this point; Chengdu still outranks it.
  assert.equal(
    (await placeBelow(31.1, 104.35, { nearKm: 60 })).near,
    'Chengdu',
  );
});

test('no city is named when none lies within half the view', async () => {
  // ~100 km west of Chengdu, in the mountains.
  const place = await placeBelow(30.67, 103.0, { nearKm: 30 });
  assert.equal(place.division, 'Sichuan');
  assert.equal(place.near, null);
  assert.equal(nearPlaceRadiusKm(8, Number.NaN), null);
});

test('at sea the smallest named sea wins over its ocean', async () => {
  assert.deepEqual(await placeBelow(42, 51), {
    kind: 'sea',
    name: 'Caspian Sea',
    countryCode: null,
  });
  // A radius changes nothing at sea.
  assert.deepEqual(await placeBelow(42, 51, { nearKm: 60 }), {
    kind: 'sea',
    name: 'Caspian Sea',
    countryCode: null,
  });
  assert.equal((await placeBelow(15, 88)).name, 'Bay of Bengal');
  assert.equal((await placeBelow(35, 18)).name, 'Mediterranean Sea');
});

test('open water far from any sea is the ocean', async () => {
  assert.deepEqual(await placeBelow(0, -150), {
    kind: 'ocean',
    name: 'South Pacific Ocean',
    countryCode: null,
  });
  assert.equal((await placeBelow(40, 179.9)).name, 'North Pacific Ocean');
  assert.equal((await placeBelow(40, -179.9)).name, 'North Pacific Ocean');
  assert.equal((await placeBelow(40, -40)).name, 'North Atlantic Ocean');
});

test('an invalid point has no place', async () => {
  assert.equal(await placeBelow(Number.NaN, 0), null);
  assert.equal(await placeBelow(91, 0), null);
});

/** A lookup whose answers the test releases by hand. */
function manualLookup() {
  const calls = [];
  const lookup = (lat, lon, options) =>
    new Promise((resolve) => calls.push({ lat, lon, options, resolve }));
  return { calls, lookup };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the tracker looks up again only after both time and distance', async () => {
  const { calls, lookup } = manualLookup();
  const places = [];
  const tracker = createPlaceTracker({
    lookup,
    onPlace: (place) => places.push(place),
  });
  assert.equal(tracker.update(0, 0, 1000), true, 'the first point');
  await flush();
  assert.equal(tracker.update(5, 5, 1100), false, 'one lookup at a time');
  calls[0].resolve({ kind: 'ocean', name: 'A' });
  await flush();
  assert.deepEqual(places, [{ kind: 'ocean', name: 'A' }]);
  // Far enough, but too soon.
  assert.equal(tracker.update(5, 5, 1000 + PLACE_LOOKUP_MIN_MS - 1), false);
  // Long enough, but barely moved (a geostationary satellite).
  assert.equal(tracker.update(0.01, 0, 1000 + PLACE_LOOKUP_MIN_MS * 5), false);
  // Both: a low orbit ~2.6 s on.
  const movedDeg = (PLACE_LOOKUP_MIN_MOVE_KM + 1) / 111.2;
  assert.equal(
    tracker.update(movedDeg, 0, 1000 + PLACE_LOOKUP_MIN_MS * 5),
    true,
  );
  await flush();
  calls[1].resolve(null);
  await flush();
  assert.deepEqual(places.at(-1), null, 'nothing named there is reported');
});

test('a new radius (a zoom step) looks up again at once', async () => {
  const { calls, lookup } = manualLookup();
  const tracker = createPlaceTracker({ lookup, onPlace: () => {} });
  assert.equal(tracker.update(0, 0, 1000), true);
  await flush();
  assert.deepEqual(calls[0].lat, 0);
  calls[0].resolve(null);
  await flush();
  // Same point, a moment later: only the zoom changed.
  assert.equal(tracker.update(0, 0, 1100, 60), true, 'into 8x');
  await flush();
  calls[1].resolve(null);
  await flush();
  // Altitude drift barely moves the radius: the gate holds.
  assert.equal(tracker.update(0, 0, 1200, 62), false);
  assert.equal(tracker.update(0, 0, 1300, 30), true, 'to 16x');
  await flush();
  calls[2].resolve(null);
  await flush();
  assert.equal(tracker.update(0, 0, 1400, null), true, 'back below 8x');
  await flush();
  assert.deepEqual(
    calls.map((call) => call.options),
    [{ nearKm: null }, { nearKm: 60 }, { nearKm: 30 }, { nearKm: null }],
  );
});

test('a lookup that lands after reset is dropped', async () => {
  const { calls, lookup } = manualLookup();
  const places = [];
  const tracker = createPlaceTracker({
    lookup,
    onPlace: (place) => places.push(place),
  });
  tracker.update(0, 0, 0);
  await flush();
  tracker.reset();
  // A new session looks up at once.
  assert.equal(tracker.update(10, 10, 1), true);
  await flush();
  calls[0].resolve({ name: 'stale' });
  calls[1].resolve({ name: 'fresh' });
  await flush();
  assert.deepEqual(places, [{ name: 'fresh' }]);
});

test('a failed lookup frees the tracker for the next point', async () => {
  let fail = true;
  const places = [];
  const tracker = createPlaceTracker({
    lookup: async () => {
      if (fail) throw new Error('pack failed');
      return { name: 'ok' };
    },
    onPlace: (place) => places.push(place),
    minIntervalMs: 0,
    minMoveKm: 0,
  });
  tracker.update(0, 0, 0);
  await flush();
  assert.deepEqual(places, [null]);
  fail = false;
  assert.equal(tracker.update(0, 0, 1), true);
  await flush();
  assert.deepEqual(places, [null, { name: 'ok' }]);
});

test('the near-place radius is half the smaller side of the view', () => {
  assert.equal(nearPlaceRadiusKm(8, 120, 60), 30, 'landscape');
  assert.equal(nearPlaceRadiusKm(8, 60, 120), 30, 'portrait');
  assert.equal(nearPlaceRadiusKm(8, 120), 60, 'square without a height');
  assert.equal(nearPlaceRadiusKm(8, 120, Number.NaN), null);
});

test('a failed division or place pack still names the country', async () => {
  const fail = async () => {
    throw new Error('pack failed');
  };
  const place = await placeBelow(30.9, 104.2, {
    nearKm: 60,
    detail: { division: fail, near: fail },
  });
  assert.equal(place.kind, 'country');
  assert.equal(place.countryCode, 'CN');
  assert.equal(place.division, null);
  assert.equal(place.near, null);
});

test('a failed lookup hides the old place and looks again on the next update', async () => {
  let fail = false;
  const places = [];
  const tracker = createPlaceTracker({
    lookup: async () => {
      if (fail) throw new Error('pack failed');
      return { kind: 'sea', name: 'Bay of Biscay' };
    },
    onPlace: (place) => places.push(place),
  });
  assert.equal(tracker.update(45, -5, 0), true);
  await flush();
  assert.deepEqual(places, [{ kind: 'sea', name: 'Bay of Biscay' }]);
  // Over France the lookup fails: the bay must not stay on the band.
  fail = true;
  const movedDeg = (PLACE_LOOKUP_MIN_MOVE_KM + 1) / 111.2;
  assert.equal(tracker.update(45 + movedDeg, 0, PLACE_LOOKUP_MIN_MS), true);
  await flush();
  assert.equal(places.at(-1), null, 'the band hides');
  // The next tick tries again at once, even without moving (a GEO view).
  fail = false;
  assert.equal(tracker.update(45 + movedDeg, 0, PLACE_LOOKUP_MIN_MS + 1), true);
  await flush();
  assert.deepEqual(places.at(-1), { kind: 'sea', name: 'Bay of Biscay' });
});
