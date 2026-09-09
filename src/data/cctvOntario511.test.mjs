// normalizeOntario511Camera — the pure record→source mapping for the Ontario
// 511 (MTO) CCTV pack. The feed reports no heading (Direction is "Unknown"
// province-wide), so poses fall back to the low-confidence id-hash prior; only
// enabled views whose still-image URL is on the official 511on.ca host are kept
// (defense-in-depth origin pin). Fixture below is a real live-sampled record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOntario511Camera } from '../../vite.config.js';

const TORONTO_CAMERA = Object.freeze({
  Id: 806,
  Source: 'City of Toronto',
  SourceId: 'Camera 9303',
  Roadway: 'Lake Shore Boulevard',
  Direction: 'Unknown',
  Latitude: 43.644334,
  Longitude: -79.375966,
  Location: 'Lake Shore Boulevard near Yonge Street',
  Views: [
    { Id: 1457, Url: 'https://511on.ca/map/Cctv/1457', Status: 'Enabled', Description: '' },
  ],
});

test('normalizeOntario511Camera maps a live camera record to a canonical source', () => {
  const s = normalizeOntario511Camera(TORONTO_CAMERA);
  assert.ok(s, 'expected a normalized source');
  assert.equal(s.id, 'on-806');
  assert.equal(s.name, 'Lake Shore Boulevard near Yonge Street');
  assert.equal(s.city, 'Ontario');
  assert.equal(s.cityId, 'ontario');
  assert.equal(s.provider, 'Ontario 511 (MTO)');
  assert.equal(s.lat, 43.644334);
  assert.equal(s.lon, -79.375966);
  assert.equal(s.feedType, 'image');
  assert.equal(s.sourceKind, 'ontario511-open-data');
  assert.equal(s.url, 'https://511on.ca/map/Cctv/1457');
  assert.equal(s.snapshotUrl, 'https://511on.ca/map/Cctv/1457');
  assert.match(s.license, /Open Government Licence . Ontario/);
  // No heading signal in the feed → low-confidence id-hash prior in [0, 360).
  assert.equal(s.headingConfidence, 'low');
  assert.ok(Number.isFinite(s.headingDeg) && s.headingDeg >= 0 && s.headingDeg < 360);
});

test('normalizeOntario511Camera skips records without finite coordinates', () => {
  assert.equal(normalizeOntario511Camera({ ...TORONTO_CAMERA, Latitude: null }), null);
  assert.equal(normalizeOntario511Camera({ ...TORONTO_CAMERA, Longitude: 'n/a' }), null);
  assert.equal(normalizeOntario511Camera(undefined), null);
});

test('normalizeOntario511Camera requires an enabled, official-host view (origin pin)', () => {
  // Disabled view → skip.
  assert.equal(normalizeOntario511Camera({
    ...TORONTO_CAMERA,
    Views: [{ Id: 1, Url: 'https://511on.ca/map/Cctv/1', Status: 'Disabled' }],
  }), null);
  // Enabled but off-host URL → skip (defense-in-depth against a spoofed catalog).
  assert.equal(normalizeOntario511Camera({
    ...TORONTO_CAMERA,
    Views: [{ Id: 1, Url: 'https://evil.example.com/map/Cctv/1', Status: 'Enabled' }],
  }), null);
  // No views at all → skip.
  assert.equal(normalizeOntario511Camera({ ...TORONTO_CAMERA, Views: [] }), null);
});

test('normalizeOntario511Camera prefers the first enabled official view among several', () => {
  const s = normalizeOntario511Camera({
    ...TORONTO_CAMERA,
    Views: [
      { Id: 1, Url: 'https://511on.ca/map/Cctv/1', Status: 'Disabled' },
      { Id: 2, Url: 'https://evil.example.com/x', Status: 'Enabled' },
      { Id: 3, Url: 'https://511on.ca/map/Cctv/3', Status: 'Enabled' },
    ],
  });
  assert.equal(s.snapshotUrl, 'https://511on.ca/map/Cctv/3');
});

test('normalizeOntario511Camera derives a name when Location is absent', () => {
  const roadwayOnly = normalizeOntario511Camera({ ...TORONTO_CAMERA, Location: '' });
  assert.equal(roadwayOnly.name, 'Lake Shore Boulevard — Ontario 511');
  const idOnly = normalizeOntario511Camera({ ...TORONTO_CAMERA, Location: '', Roadway: '' });
  assert.equal(idOnly.name, 'Ontario 511 Camera 806');
});
