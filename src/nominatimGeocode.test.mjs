import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nominatimToGeocodeResult,
  nominatimViewboxFromBounds,
  typesFromNominatim,
} from './nominatimGeocode.js';
import { geocodeNavigationMode } from './locations.js';

test('Nominatim city and country hits frame as overviews', () => {
  assert.equal(
    geocodeNavigationMode(typesFromNominatim({ addresstype: 'city', type: 'city', class: 'place' })),
    'city-overview',
  );
  assert.equal(
    geocodeNavigationMode(typesFromNominatim({ addresstype: 'country', type: 'administrative', class: 'boundary' })),
    'region-overview',
  );
});

test('Nominatim parks, roads, and peaks keep their camera modes', () => {
  assert.equal(
    geocodeNavigationMode(typesFromNominatim({ addresstype: 'park', type: 'park', class: 'leisure' })),
    'area-overview',
  );
  assert.equal(
    geocodeNavigationMode(typesFromNominatim({ class: 'highway', type: 'residential' })),
    'street-corridor',
  );
  assert.equal(
    geocodeNavigationMode(typesFromNominatim({ class: 'natural', type: 'peak' })),
    'area-overview',
  );
});

test('nominatimToGeocodeResult copies the bounding box into a Google viewport', () => {
  const result = nominatimToGeocodeResult({
    lat: '30.2672',
    lon: '-97.7431',
    display_name: 'Austin, Texas, United States',
    addresstype: 'city',
    boundingbox: ['30.10', '30.52', '-97.95', '-97.55'],
  });
  assert.equal(result.geometry.location.lat, 30.2672);
  assert.equal(result.geometry.location.lng, -97.7431);
  assert.deepEqual(result.geometry.viewport, {
    southwest: { lat: 30.10, lng: -97.95 },
    northeast: { lat: 30.52, lng: -97.55 },
  });
  assert.equal(result.formatted_address, 'Austin, Texas, United States');
});

test('nominatimToGeocodeResult rejects hits without coordinates', () => {
  assert.equal(nominatimToGeocodeResult({ display_name: 'Nowhere' }), null);
});

test('Nominatim viewbox converts GEV bounds without forcing a clip', () => {
  assert.equal(
    nominatimViewboxFromBounds('30.10,-97.95|30.52,-97.55'),
    '-97.95,30.52,-97.55,30.1',
  );
  assert.equal(nominatimViewboxFromBounds('not-a-box'), null);
  assert.equal(nominatimViewboxFromBounds(''), null);
});
