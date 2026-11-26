import test from 'node:test';
import assert from 'node:assert/strict';
import { homeCountry, homeCountryView } from './homeCountry.js';
import { START_VIEW } from './camera.js';
import { COUNTRY_CENTRES, ZONE_COUNTRIES } from './data/homeCountries.js';

test('the time zone names the country, in its tzdata, ICU or older name', () => {
  assert.equal(homeCountry({ timeZone: 'Europe/Berlin', languages: [] }), 'DE');
  assert.equal(homeCountry({ timeZone: 'Asia/Kolkata', languages: [] }), 'IN');
  assert.equal(homeCountry({ timeZone: 'Asia/Calcutta', languages: [] }), 'IN');
  assert.equal(
    homeCountry({ timeZone: 'Asia/Choibalsan', languages: [] }),
    'MN',
  );
  assert.equal(
    homeCountry({ timeZone: 'Europe/Uzhgorod', languages: [] }),
    'UA',
  );
  assert.equal(homeCountry({ timeZone: 'Europe/Kiev', languages: [] }), 'UA');
  assert.equal(
    homeCountry({ timeZone: 'America/Chicago', languages: ['de-DE'] }),
    'US',
    'the zone outranks the language',
  );
});

test("a zone of no country falls back to a language's region", () => {
  assert.equal(
    homeCountry({ timeZone: 'UTC', languages: ['fr', 'en-GB'] }),
    'GB',
  );
  assert.equal(homeCountry({ timeZone: 'Etc/UTC', languages: ['ru'] }), null);
  assert.equal(homeCountry({ timeZone: null, languages: [] }), null);
});

test('the start view looks down on the country from the planet height', () => {
  const view = homeCountryView({ timeZone: 'Asia/Tokyo', languages: [] });
  assert.deepEqual(
    [view.lat, view.lon, view.height],
    [...COUNTRY_CENTRES.JP, START_VIEW.height],
  );
  assert.equal(
    homeCountryView({ timeZone: 'UTC', languages: [] }),
    START_VIEW,
    'unknown: the default start',
  );
});

test('every zone has a country with a centre on the globe', () => {
  for (const [zone, country] of Object.entries(ZONE_COUNTRIES)) {
    const centre = COUNTRY_CENTRES[country];
    assert.ok(centre, `${zone} → ${country}`);
    const [lat, lon] = centre;
    assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180, country);
  }
  // Countries whose largest part is not where their centroid would be.
  const [usLat, usLon] = COUNTRY_CENTRES.US;
  assert.ok(usLat > 30 && usLat < 45 && usLon > -110 && usLon < -85);
  const [frLat, frLon] = COUNTRY_CENTRES.FR;
  assert.ok(frLat > 42 && frLat < 50 && frLon > -2 && frLon < 8);
});
