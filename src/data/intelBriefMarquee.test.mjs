import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsFromCartographics,
  isReliableMarqueeBounds,
  marqueeLargeEnough,
  normalizeScreenRect,
  recordInGeoBounds,
  recordMatchesSelection,
} from './intelBriefMarquee.js';
import {
  buildRegionBriefPayload,
  metaChipsFromRegion,
} from './entityBriefContext.js';

test('normalizeScreenRect keeps positive width and height', () => {
  const rect = normalizeScreenRect(120, 80, 40, 20);
  assert.deepEqual(rect, { left: 40, top: 20, width: 80, height: 60 });
});

test('marqueeLargeEnough rejects tiny drags', () => {
  assert.equal(marqueeLargeEnough({ width: 10, height: 30 }), false);
  assert.equal(marqueeLargeEnough({ width: 20, height: 20 }), true);
});

test('recordInGeoBounds respects simple bbox', () => {
  const bounds = { south: 30, north: 32, west: -98, east: -96, crossesAntimeridian: false };
  assert.equal(recordInGeoBounds({ lat: 31, lon: -97 }, bounds), true);
  assert.equal(recordInGeoBounds({ lat: 29, lon: -97 }, bounds), false);
});

test('recordMatchesSelection uses geo when no screen rect', () => {
  const bounds = { south: -27, north: -25, west: 27, east: 29, crossesAntimeridian: false };
  const record = { lat: -26.27, lon: 28.06 };
  assert.equal(recordMatchesSelection(null, record, bounds, null), true);
  assert.equal(recordMatchesSelection(null, record, null, null), false);
});

test('recordMatchesSelection ignores absurd geo bounds without screen hit', () => {
  const bounds = { south: 10, north: 30, west: -55, east: 58, crossesAntimeridian: false };
  const europe = { lat: 56.26, lon: 15.26 };
  assert.equal(recordMatchesSelection(null, europe, bounds, null, { geoReliable: false }), false);
});

test('isReliableMarqueeBounds rejects oblique huge boxes', () => {
  assert.equal(isReliableMarqueeBounds({
    south: 10,
    north: 30,
    west: -55,
    east: 58,
    crossesAntimeridian: false,
  }, 46_000), false);
});

test('boundsFromCartographics computes center', () => {
  const bounds = boundsFromCartographics([
    { latitude: 0.008726646, longitude: -0.017453293 },
    { latitude: 0.010472, longitude: -0.013962 },
  ]);
  assert.ok(bounds);
  assert.equal(bounds.center.lat.toFixed(2), '0.55');
});

test('buildRegionBriefPayload marks marquee selections', () => {
  const payload = buildRegionBriefPayload({
    bounds: { south: 1, north: 2, west: 3, east: 4, center: { lat: 1.5, lon: 3.5 } },
    contacts: [{ name: 'TEST', layerName: 'Aircraft' }],
    enabledLayers: [{ id: 'flights', name: 'Flights', count: 10 }],
  });
  assert.equal(payload.kind, 'marquee');
  assert.equal(payload.selection.contactCount, 1);
});

test('metaChipsFromRegion summarizes asset-first chips', () => {
  const chips = metaChipsFromRegion({
    weather: { weatherCode: 0, temperatureC: 20 },
    contacts: [
      { layerId: 'flights', layerName: 'Aircraft' },
      { layerId: 'ais-live-vessels', layerName: 'Vessel' },
    ],
  });
  assert.match(chips.join(' '), /1 aircraft/);
  assert.match(chips.join(' '), /1 vessel/);
});
