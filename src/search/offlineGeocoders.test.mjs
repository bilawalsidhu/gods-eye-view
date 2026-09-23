// OFFLINE GEOCODERS — the two providers that answer with no key and no request,
// and their place in the chain. What matters here is that they answer only what
// they are certain of, hand everything else on, and produce the box shape the
// camera framing actually reads.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinateGeocoder } from './coordinateGeocoder.js';
import { createPresetGeocoder } from './presetGeocoder.js';
import { createPlaceSearch } from './placeSearch.js';

const PRESETS = {
  austin: {
    name: 'Austin',
    viewBounds: {
      southwest: { lat: 30.1, lng: -97.95 },
      northeast: { lat: 30.52, lng: -97.55 },
    },
    pois: [
      { name: 'Texas State Capitol', lat: 30.2747, lon: -97.7403 },
      { name: 'Pennybacker Bridge', lat: 30.3451, lon: -97.7951 },
    ],
  },
  sf: {
    name: 'San Francisco',
    viewBounds: {
      southwest: { lat: 37.7, lng: -122.52 },
      northeast: { lat: 37.84, lng: -122.35 },
    },
    pois: [{ name: 'Golden Gate Bridge', lat: 37.8199, lon: -122.4783 }],
  },
};

test('a coordinate answers with the point, a framing box, and no request', async () => {
  const geocoder = createCoordinateGeocoder();
  const { place, answered } = await geocoder.geocode('43.1731, -79.0384');
  assert.equal(answered, true);
  assert.equal(place.lat, 43.1731);
  assert.equal(place.lng, -79.0384);
  assert.deepEqual(place.types, ['coordinate']);
  assert.equal(place.exact, true, 'nothing nearby may replace a typed point');
  // The framing code reads southwest/northeast with lat/lng — any other shape
  // is silently ignored and the place is framed as if it had no box at all.
  assert.ok(place.viewport.southwest.lat < place.lat);
  assert.ok(place.viewport.northeast.lat > place.lat);
  assert.ok(place.viewport.southwest.lng < place.lng);
  assert.ok(place.viewport.northeast.lng > place.lng);
});

test('a coordinate box stays inside the poles and wraps at the dateline', async () => {
  const geocoder = createCoordinateGeocoder();
  const pole = (await geocoder.geocode('90, 0')).place;
  assert.equal(
    pole.viewport.northeast.lat,
    90,
    'latitude cannot pass the pole',
  );
  assert.ok(pole.viewport.southwest.lat < 90);

  const dateline = (await geocoder.geocode('0, 179.995')).place;
  assert.ok(
    dateline.viewport.northeast.lng <= 180 &&
      dateline.viewport.northeast.lng >= -180,
    `east edge ${dateline.viewport.northeast.lng} must be a real longitude`,
  );
  assert.ok(
    dateline.viewport.northeast.lng < 0,
    'the east edge wraps past 180',
  );
});

test('a query that is not a coordinate is passed on, not declined', async () => {
  const geocoder = createCoordinateGeocoder();
  for (const query of ['paris', '12junk, 34oops', '']) {
    const outcome = await geocoder.geocode(query);
    assert.equal(outcome.place, null);
    assert.equal(
      outcome.answered,
      true,
      'having nothing to say is not a verdict on the query',
    );
  }
});

test('bundled names match exactly: city id, city name, or landmark', async () => {
  const geocoder = createPresetGeocoder({ presets: PRESETS });
  const city = (await geocoder.geocode('austin')).place;
  assert.equal(city.label, 'Austin');
  assert.deepEqual(city.types, ['locality']);
  assert.deepEqual(city.viewport, PRESETS.austin.viewBounds);
  assert.equal(city.lat, 30.2747, 'a city anchors on its first landmark');

  assert.equal((await geocoder.geocode('SF')).place.label, 'San Francisco');
  assert.equal(
    (await geocoder.geocode('san francisco')).place.label,
    'San Francisco',
  );
  assert.equal((await geocoder.geocode('  AUSTIN  ')).place.label, 'Austin');

  const landmark = (await geocoder.geocode('pennybacker bridge')).place;
  assert.equal(landmark.label, 'Pennybacker Bridge, Austin');
  assert.deepEqual(landmark.types, ['point_of_interest']);
  assert.equal(landmark.lat, 30.3451);
  assert.equal(landmark.exact, true);
});

test('a near miss is handed on rather than answered from the bundle', async () => {
  const geocoder = createPresetGeocoder({ presets: PRESETS });
  for (const query of [
    'austin texas',
    'austin, tx',
    'aus',
    'new austin',
    'golden gate',
    'bridge',
    '',
    'a',
  ]) {
    const outcome = await geocoder.geocode(query);
    assert.equal(outcome.place, null, `${query} must not match a bundled name`);
    assert.equal(outcome.answered, true);
  }
});

test('an empty or malformed preset set answers nothing and throws nothing', async () => {
  for (const presets of [
    undefined,
    {},
    { broken: {} },
    { broken: { name: 'Broken', pois: [{ name: 'No place' }] } },
  ]) {
    const geocoder = createPresetGeocoder({ presets });
    assert.equal((await geocoder.geocode('broken')).place, null);
    assert.equal((await geocoder.geocode('no place')).place, null);
  }
});

test('the offline providers answer ahead of the network ones, which stay in order', async () => {
  const asked = [];
  const network = (name) => ({
    async geocode(query) {
      asked.push(`${name}:${query}`);
      return name === 'google'
        ? { place: null, answered: true }
        : {
            place: { lat: 1, lng: 2, label: 'photon hit', types: [] },
            answered: true,
          };
    },
  });
  const search = createPlaceSearch({
    providers: [
      createCoordinateGeocoder(),
      createPresetGeocoder({ presets: PRESETS }),
      network('google'),
      network('photon'),
    ],
  });

  const coordinate = await search.geocode('43.1731, -79.0384');
  assert.equal(coordinate.place.lat, 43.1731);
  assert.deepEqual(asked, [], 'a coordinate reaches no network provider');

  const preset = await search.geocode('paris');
  assert.equal(preset.place.label, 'photon hit');
  assert.deepEqual(
    asked,
    ['google:paris', 'photon:paris'],
    'an unknown name still walks Google then Photon',
  );

  asked.length = 0;
  const bundled = await search.geocode('Golden Gate Bridge');
  assert.equal(bundled.place.label, 'Golden Gate Bridge, San Francisco');
  assert.deepEqual(asked, [], 'a bundled name reaches no network provider');
});

test('a cancelled search stops the offline providers too', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const geocoder of [
    createCoordinateGeocoder(),
    createPresetGeocoder({ presets: PRESETS }),
  ]) {
    await assert.rejects(
      geocoder.geocode('austin', { signal: controller.signal }),
      (error) => error.name === 'AbortError',
    );
  }
});
