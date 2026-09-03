// CITY PRESETS — the destination table itself, checked as data.
//
// CITY_POIS is the only place in the app where a landmark's position is written
// by hand, and nothing else validates it. Every other test here exercises code;
// this one exercises the table, because the failures it catches look like
// working software: a camera that flies somewhere plausible and wrong.
//
// The invariant that pays for the file is the first one. `viewBounds` is what
// "fly to <city>" opens on, so a POI outside that rectangle is a landmark the
// destination advertises but its own overview never shows — the pill lights up,
// the camera frames a region, and the place is off-screen.
//
// These pass clean on the current eight destinations; this is a guard for the
// next entry, not a fix for an existing one. It was written while adding
// destinations to a fork, where it immediately caught one: a landmark sitting
// 15 km outside its destination's western edge, added by hand a fortnight
// earlier and never noticed, because the camera still flew somewhere that
// looked reasonable.
//
// The bounds here are structural, not stylistic: a pitch must point downward to
// be a camera angle at all. Nothing asserts a house style, so an entry framed
// unusually is still free to be added.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_POIS, LOCATIONS } from './locations.js';

const DESTINATIONS = Object.entries(CITY_POIS);
const REQUIRED_POI_KEYS = ['name', 'lat', 'lon', 'alt', 'pitch', 'heading'];

/** `id · POI name`, so a failure names the row instead of an index. */
const where = (id, poi) => `${id} · ${poi.name}`;

test('the table is not empty, and every destination offers at least one place', () => {
  assert.ok(DESTINATIONS.length > 0);
  for (const [id, city] of DESTINATIONS) {
    assert.ok(city.name, `${id} has no name`);
    assert.ok(Array.isArray(city.pois) && city.pois.length > 0, `${id} has no POIs`);
  }
});

test('every POI carries the keys the camera reads', () => {
  for (const [id, city] of DESTINATIONS) {
    for (const poi of city.pois) {
      for (const key of REQUIRED_POI_KEYS) {
        assert.notEqual(poi[key], undefined, `${where(id, poi)} is missing ${key}`);
      }
    }
  }
});

test('every coordinate is a finite point on Earth', () => {
  for (const [id, city] of DESTINATIONS) {
    for (const poi of city.pois) {
      assert.ok(Number.isFinite(poi.lat) && Math.abs(poi.lat) <= 90, `${where(id, poi)} lat ${poi.lat}`);
      assert.ok(Number.isFinite(poi.lon) && Math.abs(poi.lon) <= 180, `${where(id, poi)} lon ${poi.lon}`);
    }
  }
});

test('every camera angle is one a camera can hold', () => {
  for (const [id, city] of DESTINATIONS) {
    for (const poi of city.pois) {
      // Looking down, not up and not along the horizon: these are aerial frames.
      assert.ok(poi.pitch < 0 && poi.pitch >= -90, `${where(id, poi)} pitch ${poi.pitch}`);
      assert.ok(poi.heading >= 0 && poi.heading < 360, `${where(id, poi)} heading ${poi.heading}`);
      assert.ok(poi.alt > 0, `${where(id, poi)} alt ${poi.alt}`);
    }
  }
});

test('every viewBounds is a rectangle with its corners the right way round', () => {
  for (const [id, city] of DESTINATIONS) {
    assert.ok(city.viewBounds, `${id} has no viewBounds`);
    const { southwest: sw, northeast: ne } = city.viewBounds;
    // Swapped corners produce an inverted-but-plausible box: the framing code
    // still runs, and the camera frames nothing.
    assert.ok(sw.lat < ne.lat, `${id} viewBounds latitudes are inverted`);
    assert.ok(sw.lng < ne.lng, `${id} viewBounds longitudes are inverted`);
  }
});

test('every POI lies inside the frame its own destination opens on', () => {
  // The failure this exists for: a landmark the destination lists but its
  // overview never shows.
  for (const [id, city] of DESTINATIONS) {
    const { southwest: sw, northeast: ne } = city.viewBounds;
    for (const poi of city.pois) {
      assert.ok(
        poi.lat >= sw.lat && poi.lat <= ne.lat && poi.lon >= sw.lng && poi.lon <= ne.lng,
        `${where(id, poi)} at ${poi.lat}, ${poi.lon} is outside ${id}'s viewBounds`,
      );
    }
  }
});

test('LOCATIONS stays derived from the table rather than kept alongside it', () => {
  assert.equal(LOCATIONS.length, DESTINATIONS.length);
  for (const [index, [id, city]] of DESTINATIONS.entries()) {
    assert.deepEqual(LOCATIONS[index], {
      id,
      name: city.name,
      lat: city.pois[0].lat,
      lon: city.pois[0].lon,
    });
  }
});
