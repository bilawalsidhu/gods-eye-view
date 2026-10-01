// City of Amsterdam public traffic/ANPR camera register — the POSITION-ONLY
// pack. Amsterdam publishes where its cameras stand, not what they see, so
// these pin the normalizer's contract (including the media-availability
// declaration that keeps the proxy from dressing a Street View still up as a
// degraded feed) and the two wire details that fail silently without them.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAmsterdamCameraRecords,
  amsterdamCameraTypeLabel,
  loadAmsterdamSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { isPositionOnlySource } from '../sources/cctvTypes.js';
import { staticFrameRefreshMs } from './cctvLod.js';

/** One register row, shaped exactly as the DSO-API returns it. */
function row(overrides = {}) {
  return {
    id: '015F28B1-667A-4276-9AE1-2BF96952A61F',
    objectSoort: 'Camera',
    objecttypeVisKaart: 'Verkeerscamera',
    geometrie: { type: 'Point', coordinates: [4.877958, 52.378661] },
    objectnummer: 'ANPR-06005-A',
    standplaats: 'Nassaukade',
    type: 'Verkeerscamera',
    typeGedetailleerd: 'ANPR camera S100',
    ...overrides,
  };
}

test('a register row becomes a position-only source with no media URLs', () => {
  const [camera] = normalizeAmsterdamCameraRecords([row()]);

  assert.equal(camera.id, 'ams-anpr-06005-a');
  assert.equal(camera.name, 'Nassaukade (ANPR — S100 ring)');
  assert.equal(camera.city, 'Amsterdam');
  assert.equal(camera.cityId, 'amsterdam');
  assert.equal(camera.provider, 'Gemeente Amsterdam');
  assert.equal(camera.sourceKind, 'amsterdam-open-data');
  assert.equal(camera.lat, 52.378661);
  assert.equal(camera.lon, 4.877958);

  // The load-bearing half: the pack DECLARES that no public imagery exists,
  // rather than shipping url:'' and letting the fallback chain discover it.
  assert.equal(camera.mediaAvailability, 'position-only');
  assert.equal(camera.url, '');
  assert.equal(camera.snapshotUrl, '');
  assert.match(camera.license, /positions only/);
});

test('the position-only declaration survives normalizeSourceItem', () => {
  // The catalog passes every pack row through this before it reaches the
  // routes; a field it drops would silently re-enable the fallback chain.
  const [camera] = normalizeAmsterdamCameraRecords([row()]);
  const normalized = normalizeSourceItem(camera);
  assert.equal(normalized.mediaAvailability, 'position-only');
  assert.equal(isPositionOnlySource(normalized), true);
});

test('every row takes the headingless low-confidence RAW PRIOR pose', () => {
  // The register carries no bearing for ANY camera, so no row may claim a
  // measured heading. Same personality as the headingless TfL rows.
  const cameras = normalizeAmsterdamCameraRecords([
    row(),
    row({ objectnummer: '153TVK016', typeGedetailleerd: 'TV camera' }),
  ]);
  assert.equal(cameras.length, 2);
  for (const camera of cameras) {
    assert.equal(camera.headingConfidence, 'low');
    assert.ok(Number.isFinite(camera.headingDeg));
    assert.equal(camera.pitchDeg, -18);
    assert.equal(camera.fovDeg, 44);
    assert.equal(camera.rangeM, 145);
    assert.equal(camera.mountHeightM, 8);
  }
});

test('ground elevation is ORTHOMETRIC metres, not the ellipsoidal number', () => {
  // ~45 m is the ellipsoid/geoid separation at this latitude; shipping it
  // would bury every camera under the mesh. NAP is ~mean sea level, and the
  // polder city sits within a metre or two of it.
  const [camera] = normalizeAmsterdamCameraRecords([row()]);
  assert.equal(camera.groundElevationM, 2);
  assert.ok(camera.groundElevationM < 10, 'an ellipsoidal height leaked in');
});

test('raw Rijksdriehoek coordinates are rejected rather than scattered', () => {
  // EPSG:28992 values are six-figure metres. If the Accept-Crs negotiation
  // ever breaks, the bbox guard must empty the pack — NOT place cameras off
  // the Gulf of Guinea.
  const cameras = normalizeAmsterdamCameraRecords([
    row({ geometrie: { type: 'Point', coordinates: [120997, 485841] } }),
    row({
      objectnummer: 'RD-2',
      geometrie: { type: 'Point', coordinates: [121553, 487339] },
    }),
  ]);
  assert.deepEqual(cameras, []);
});

test('non-camera assets, bad geometry and duplicate asset numbers are dropped', () => {
  const cameras = normalizeAmsterdamCameraRecords([
    row(),
    // Same asset number twice — the register's own key must stay unique.
    row({ standplaats: 'Elsewhere' }),
    // Not a camera at all (the register holds every traffic-system asset).
    row({ objectnummer: 'VRI-1', objectSoort: 'Verkeersregelinstallatie' }),
    row({ objectnummer: 'NOGEO-1', geometrie: null }),
    row({
      objectnummer: 'LINE-1',
      geometrie: { type: 'LineString', coordinates: [[4.9, 52.37]] },
    }),
    row({ objectnummer: '' }),
    // Outside the municipal bbox (Rotterdam).
    row({
      objectnummer: 'RDAM-1',
      geometrie: { type: 'Point', coordinates: [4.47, 51.92] },
    }),
  ]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['ams-anpr-06005-a'],
  );
});

test('malformed payloads yield an empty pack instead of throwing', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, [null], [undefined], ['x']]) {
    assert.deepEqual(normalizeAmsterdamCameraRecords(bad), []);
  }
});

test('camera type labels are translated, and an unknown type fails OPEN', () => {
  assert.equal(amsterdamCameraTypeLabel('TV camera'), 'Traffic camera');
  assert.equal(amsterdamCameraTypeLabel('ANPR camera Reistijd'), 'ANPR — travel time');
  // Reproduces the upstream's own typo for "Milieuzone": matching the WIRE
  // value is the point, so fixing the spelling here would break the mapping.
  assert.equal(
    amsterdamCameraTypeLabel('ANPR camera Mileuzone'),
    'ANPR — environmental zone',
  );
  assert.equal(amsterdamCameraTypeLabel('ANPR camera S100'), 'ANPR — S100 ring');
  // A type the city introduces later still gets a name.
  assert.equal(amsterdamCameraTypeLabel('Nieuwe cameratype'), 'Nieuwe cameratype');
  assert.equal(amsterdamCameraTypeLabel(''), '');
  assert.equal(amsterdamCameraTypeLabel(null), '');
});

test('a row with no street name still gets a usable label', () => {
  const [camera] = normalizeAmsterdamCameraRecords([
    row({ objectnummer: 'CAM-9', standplaats: '', typeGedetailleerd: 'TV camera' }),
  ]);
  assert.equal(camera.name, 'Traffic camera CAM-9');
});

// ---------------------------------------------------------------------------
// The loader's wire contract, with the upstream injected through globalThis.fetch.
// ---------------------------------------------------------------------------

/** Run the loader against a stubbed upstream, recording every request. */
function withUpstream(t, respond) {
  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers || {} });
    return respond({ url: String(url), init, call: requests.length });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });
  return requests;
}

/** A HAL envelope, as the DSO-API returns it. */
function halPage(rows, nextHref = null) {
  return new Response(
    JSON.stringify({
      _embedded: { verkeersinformatiesystemen: rows },
      _links: nextHref ? { next: { href: nextHref } } : {},
    }),
    { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
  );
}

test('the loader asks for HAL and for WGS84, and filters to cameras upstream', async (t) => {
  // Both headers fail SILENTLY if dropped: DSO-API answers 406 to a plain
  // application/json (even with _format=json), and without Accept-Crs the
  // register replies in EPSG:28992 and every row fails the bbox guard.
  const requests = withUpstream(t, () => halPage([row()]));
  const cameras = await loadAmsterdamSourcesFromOpenData();

  assert.equal(cameras.length, 1);
  const sent = requests.at(0);
  assert.equal(sent.headers.Accept, 'application/hal+json');
  assert.equal(sent.headers['Accept-Crs'], 'EPSG:4326');
  assert.ok(!('X-Api-Key' in sent.headers), 'the pack is keyless by default');
  assert.match(sent.url, /objectSoort=Camera/);
});

test('an optional API key rides as X-Api-Key', async (t) => {
  // The DSO platform has announced keys become mandatory on a date still TBD.
  const before = process.env.AMSTERDAM_DATA_API_KEY;
  process.env.AMSTERDAM_DATA_API_KEY = 'test-key';
  t.after(() => {
    if (before === undefined) delete process.env.AMSTERDAM_DATA_API_KEY;
    else process.env.AMSTERDAM_DATA_API_KEY = before;
  });
  const requests = withUpstream(t, () => halPage([row()]));
  await loadAmsterdamSourcesFromOpenData();
  assert.equal(requests.at(0).headers['X-Api-Key'], 'test-key');
});

test('paging follows _links.next only while it stays on the official origin', async (t) => {
  const official =
    'https://api.data.amsterdam.nl/v1/verkeersinformatiesystemen/verkeersinformatiesystemen/?page=2';
  const requests = withUpstream(t, ({ call }) => {
    if (call === 1) return halPage([row()], official);
    // Page 2 points off-origin; the loader must stop rather than follow.
    return halPage([row({ objectnummer: 'CAM-2' })], 'https://evil.invalid/page3');
  });
  const cameras = await loadAmsterdamSourcesFromOpenData();

  assert.equal(requests.length, 2, 'the off-origin third page is never fetched');
  assert.equal(requests.at(1).url, official);
  assert.equal(cameras.length, 2);
});

test('an upstream failure yields an empty pack, never a throw', async (t) => {
  withUpstream(t, () => new Response('nope', { status: 503 }));
  assert.deepEqual(await loadAmsterdamSourcesFromOpenData(), []);

  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  assert.deepEqual(await loadAmsterdamSourcesFromOpenData(), []);
});

test('the pack is capped and ordered nearest-to-Dam-square', async (t) => {
  const before = process.env.CCTV_AMSTERDAM_MAX_SOURCES;
  process.env.CCTV_AMSTERDAM_MAX_SOURCES = '8';
  t.after(() => {
    if (before === undefined) delete process.env.CCTV_AMSTERDAM_MAX_SOURCES;
    else process.env.CCTV_AMSTERDAM_MAX_SOURCES = before;
  });
  // Dam square is 52.373/4.8926; the far row sits out by the A10 ring.
  const near = row({ objectnummer: 'NEAR-1', geometrie: { type: 'Point', coordinates: [4.8926, 52.373] } });
  const far = row({ objectnummer: 'FAR-1', geometrie: { type: 'Point', coordinates: [4.78, 52.33] } });
  withUpstream(t, () => halPage([far, near]));

  const cameras = await loadAmsterdamSourcesFromOpenData();
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['ams-near-1', 'ams-far-1'],
  );
});

test('the provider string matches the LOD cadence lookup key', () => {
  // Drift here fails silently back to the default cadence. The pack fetches
  // no frames at all, so the only correct answer is the shared default.
  const [camera] = normalizeAmsterdamCameraRecords([row()]);
  assert.equal(
    staticFrameRefreshMs(camera),
    staticFrameRefreshMs({ provider: 'some-unlisted-provider' }),
  );
});
