// City of Amsterdam CCTV source pack: record mapping, coordinate-datum guard,
// and the headingless pose personality. Pure mapping tests, no network — the
// loader's fetch/paging wrapper is deliberately not exported.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAmsterdamCameraRecords } from '../../vite.config.js';

/** Record shape copied from a live api.data.amsterdam.nl camera response. */
function amsterdamRecord(overrides = {}) {
  return {
    id: '046B7838-F010-4AE9-89C2-59812E00C15B',
    objectSoort: 'Camera',
    objecttypeVisKaart: 'Verkeerscamera',
    geometrie: { type: 'Point', coordinates: [4.863105862368371, 52.38522256952035] },
    beheerderGedetailleerd: 'R&E_VOR_VIS',
    objectnummer: '978TVK075',
    standplaats: 'Haarlemmerweg',
    type: 'Verkeerscamera',
    typeGedetailleerd: 'TV camera',
    ...overrides,
  };
}

test('Amsterdam pack maps a register row onto the CCTV source contract', () => {
  const [camera] = normalizeAmsterdamCameraRecords([amsterdamRecord()]);

  assert.equal(camera.id, 'ams-978tvk075');
  assert.equal(camera.name, 'Haarlemmerweg (Traffic camera)');
  assert.equal(camera.cityId, 'amsterdam');
  assert.equal(camera.sourceKind, 'amsterdam-open-data');
  assert.equal(camera.lat, 52.38522256952035);
  assert.equal(camera.lon, 4.863105862368371);
  // The register publishes positions, not imagery: no frame URL may be
  // invented, so the proxy's Street View / synthetic fallback owns the frame.
  assert.equal(camera.url, '');
  assert.equal(camera.snapshotUrl, '');
});

test('Amsterdam pack provider matches its cctvLod refresh-cadence key', () => {
  const [camera] = normalizeAmsterdamCameraRecords([amsterdamRecord()]);
  // staticFrameRefreshMs() looks the provider up lowercased. A drift between
  // this string and the PROVIDER_STATIC_REFRESH_MS key silently drops the
  // pack back to the 5-minute default, which re-bills a Street View request
  // per camera for a frame that never changes.
  assert.equal(camera.provider, 'Gemeente Amsterdam');
});

test('Amsterdam pack takes the headingless low-confidence pose personality', () => {
  const [camera] = normalizeAmsterdamCameraRecords([amsterdamRecord()]);

  // The register carries no bearing for any camera, so a claimed high
  // confidence here would promote a hashed guess to a surveyed facing.
  assert.equal(camera.headingConfidence, 'low');
  assert.ok(Number.isFinite(camera.headingDeg));
  assert.ok(camera.headingDeg >= 0 && camera.headingDeg < 360);
  assert.deepEqual(
    { pitchDeg: camera.pitchDeg, fovDeg: camera.fovDeg, rangeM: camera.rangeM, mountHeightM: camera.mountHeightM },
    { pitchDeg: -18, fovDeg: 44, rangeM: 145, mountHeightM: 8 }
  );
  // Orthometric metres (h = H + N, see src/data/geoid.js) — NOT ellipsoidal.
  // At 52.4°N the geoid sits ~43 m above the ellipsoid, so shipping an
  // ellipsoidal number here would bury every camera under the mesh.
  assert.equal(camera.groundElevationM, 2);
});

test('Amsterdam pack rejects Rijksdriehoek coordinates instead of scattering cameras', () => {
  // What the register answers when Accept-Crs: EPSG:4326 is not honoured:
  // EPSG:28992 metres, which would otherwise be read as degrees.
  const rd = normalizeAmsterdamCameraRecords([
    amsterdamRecord({ geometrie: { type: 'Point', coordinates: [120997, 485841] } }),
  ]);
  assert.deepEqual(rd, []);

  // Same guard rejects a null geometry (one live row has one) and anything
  // outside the metro bounding box.
  assert.deepEqual(normalizeAmsterdamCameraRecords([amsterdamRecord({ geometrie: null })]), []);
  assert.deepEqual(
    normalizeAmsterdamCameraRecords([
      amsterdamRecord({ geometrie: { type: 'Point', coordinates: [-97.7431, 30.2672] } }),
    ]),
    []
  );
});

test('Amsterdam pack keeps only camera rows, unique by asset number', () => {
  const cameras = normalizeAmsterdamCameraRecords([
    amsterdamRecord(),
    // Same register, other object kinds — DRIPs, pollers, parking displays.
    amsterdamRecord({ objectSoort: 'Poller', objectnummer: 'PL001' }),
    amsterdamRecord({ objectSoort: 'Informatiepaneel', objectnummer: 'SD162' }),
    // A duplicate asset number must not produce a second camera with the
    // same id (ids collide in the proxy's dedupe Map otherwise).
    amsterdamRecord({ id: 'other-guid' }),
    // Rows with no asset number have no stable id to build from.
    amsterdamRecord({ objectnummer: '   ' }),
  ]);

  assert.deepEqual(cameras.map((camera) => camera.id), ['ams-978tvk075']);
});

test('Amsterdam pack names ANPR types in English and passes unknown types through', () => {
  const named = (overrides) => normalizeAmsterdamCameraRecords([amsterdamRecord(overrides)])[0].name;

  assert.equal(
    named({ objectnummer: 'ANPR-06005-A', standplaats: 'Nassaukade', typeGedetailleerd: 'ANPR camera S100' }),
    'Nassaukade (ANPR — S100 ring)'
  );
  // Upstream spells it "Mileuzone"; the map keys off the wire value.
  assert.equal(
    named({ standplaats: 'Zeeburgerpad', typeGedetailleerd: 'ANPR camera Mileuzone' }),
    'Zeeburgerpad (ANPR — environmental zone)'
  );
  // Fails open: an unmapped type is still named, never dropped or blanked.
  assert.equal(
    named({ standplaats: 'Basisweg', typeGedetailleerd: 'Nieuwe cameravorm' }),
    'Basisweg (Nieuwe cameravorm)'
  );
  // 65 live rows have no standplaats, and 36 have no type.
  assert.equal(named({ standplaats: null }), 'Traffic camera 978TVK075');
  assert.equal(named({ typeGedetailleerd: null }), 'Haarlemmerweg');
  assert.equal(named({ standplaats: null, typeGedetailleerd: null }), 'Traffic camera 978TVK075');
});

test('Amsterdam pack tolerates a malformed payload without throwing', () => {
  assert.deepEqual(normalizeAmsterdamCameraRecords(undefined), []);
  assert.deepEqual(normalizeAmsterdamCameraRecords(null), []);
  assert.deepEqual(normalizeAmsterdamCameraRecords([null, 'nope', 42, {}]), []);
});
