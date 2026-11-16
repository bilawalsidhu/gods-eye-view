// BIKESHARE REGISTRY — a city entry is only useful if the proxy will serve it.
//
// A registry entry and the GBFS proxy allowlist are edited in different files,
// so a city can look correctly registered while every one of its requests is
// rejected at the proxy. These cases hold the two together: each entry is
// checked against the same host and path predicates the proxy enforces, so a
// new city that the proxy would refuse fails here rather than silently
// rendering an empty layer.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GBFS_CITY_REGISTRY, CITY_BY_ID } from './registry.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';

test('every registered city is reachable through the GBFS proxy allowlist', () => {
  for (const city of GBFS_CITY_REGISTRY) {
    for (const raw of [city.stationInformationUrl, city.stationStatusUrl]) {
      const url = new URL(raw);
      assert.equal(
        isAllowedGbfsHost(url.hostname),
        true,
        `${city.id}: host ${url.hostname} is not allowlisted`,
      );
      assert.equal(
        isAllowedGbfsPath(url.pathname, url.hostname),
        true,
        `${city.id}: path ${url.pathname} is not allowlisted`,
      );
    }
  }
});

test('Bike Share Toronto is registered against the PBSC v2 feeds', () => {
  const toronto = CITY_BY_ID.get('toronto-bike-share');
  assert.ok(toronto, 'toronto-bike-share is missing from the registry');
  assert.equal(toronto.city, 'Toronto, ON');
  assert.equal(toronto.provider, 'Bike Share Toronto');
  assert.equal(
    toronto.stationInformationUrl,
    'https://toronto.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
  );
  assert.equal(
    toronto.stationStatusUrl,
    'https://toronto.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
  );
});

test('the Toronto center sits inside the system service area', () => {
  const toronto = CITY_BY_ID.get('toronto-bike-share');
  // Bounding box of the 1,069 live stations, sampled from the published
  // station_information feed: 43.588..43.813 N, -79.603..-79.123 W.
  assert.ok(toronto.centerLat > 43.588 && toronto.centerLat < 43.813);
  assert.ok(toronto.centerLon > -79.603 && toronto.centerLon < -79.123);
  // The system spans roughly 37 km east-west, so the load radius has to clear
  // half that from the center or downtown pans lose the outer stations.
  assert.ok(toronto.loadRadiusKm >= 25);
});

test("Vélib' Métropole is registered as the Paris city entry", () => {
  const paris = CITY_BY_ID.get('paris-velib');
  assert.ok(paris, 'paris-velib is missing from the registry');
  assert.equal(paris.city, 'Paris, France');
  assert.equal(paris.provider, "Vélib' Métropole");
  assert.equal(
    paris.stationInformationUrl,
    'https://velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/station_information.json',
  );
  assert.equal(
    paris.stationStatusUrl,
    'https://velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/station_status.json',
  );
});

test('the Paris centre and radius cover the Vélib network', () => {
  const paris = CITY_BY_ID.get('paris-velib');
  // The published network runs from the Paris proper stations out to the
  // surrounding communes (Versailles, Saint-Germain-en-Laye, Marne-la-Vallée),
  // so the centre sits on Paris and the radius reaches the conurbation.
  assert.ok(paris.centerLat > 48.8 && paris.centerLat < 48.9);
  assert.ok(paris.centerLon > 2.2 && paris.centerLon < 2.5);
  assert.ok(
    paris.loadRadiusKm >= 40,
    'the Paris conurbation needs the metropolitan radius',
  );
});
