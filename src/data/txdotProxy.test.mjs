import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeTxdotSnapshotPayload,
  fetchCctvImageFromUpstream,
  normalizeTxdotDistrictPayload,
} from '../../vite.config.js';

/** Minimal valid JPEG head: SOI marker plus a byte of payload. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const JPEG_B64 = JPEG_BYTES.toString('base64');

/** One "Device Online" record in the shape GetCctvStatusListByDistrict returns. */
function cameraRow(overrides = {}) {
  return {
    icd_Id: 'FM-734 @ US-290 EB',
    name: 'FM-734 @ US-290 EB',
    latitude: 30.34396,
    longitude: -97.57988,
    statusDescription: 'Device Online',
    dirDescription: 'North',
    equipLoc: { roadway: 'FM-734', direction: 'North' },
    ...overrides,
  };
}

const districtPayload = (rows) => ({ roadwayCctvStatuses: { 'FM-734': rows } });

test('TxDOT catalog keeps only online cameras with finite coordinates', () => {
  const cameras = normalizeTxdotDistrictPayload(districtPayload([
    cameraRow({ icd_Id: 'a', name: 'a' }),
    cameraRow({ icd_Id: 'b', name: 'b', statusDescription: 'Device Offline' }),
    cameraRow({ icd_Id: 'c', name: 'c', statusDescription: 'Device Error' }),
    cameraRow({ icd_Id: 'd', name: 'd', latitude: null }),
    cameraRow({ icd_Id: 'e', name: 'e', longitude: 'not-a-number' }),
    cameraRow({ icd_Id: 'f', name: 'f', latitude: 0, longitude: 0 }),
    cameraRow({ icd_Id: 'g', name: 'g', latitude: '30.1', longitude: '-97.7' }),
  ]), 'AUS');

  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].name, 'a');
  assert.equal(cameras[0].provider, 'TxDOT');
  assert.equal(cameras[0].feedType, 'image');
  assert.equal(cameras[0].sourceKind, 'txdot-its');
});

test('TxDOT catalog dedupes a camera listed under two roadways', () => {
  // An interchange camera is grouped under both routes; icd_Id is the identity.
  const cameras = normalizeTxdotDistrictPayload({
    roadwayCctvStatuses: {
      'IH-35': [cameraRow({ icd_Id: 'shared', name: 'IH-35 @ SH-71' })],
      'SH-71': [cameraRow({ icd_Id: 'shared', name: 'IH-35 @ SH-71' })],
    },
  }, 'AUS');

  assert.equal(cameras.length, 1);
});

test('TxDOT heading comes from an explicit travel token, never the roadway direction', () => {
  // dirDescription is "North" on every row below, but it describes the ROADWAY.
  // Only the name's travel token may set a high-confidence heading.
  const [eastbound, westbound, plain] = normalizeTxdotDistrictPayload(districtPayload([
    cameraRow({ icd_Id: 'eb', name: 'FM-734 @ US-290 EB' }),
    cameraRow({ icd_Id: 'wb', name: 'FM-734 @ US-290 WB' }),
    cameraRow({ icd_Id: 'plain', name: 'FM-734 @ Bellingham Dr' }),
  ]), 'AUS');

  assert.equal(eastbound.headingDeg, 90);
  assert.equal(eastbound.headingConfidence, 'high');
  assert.equal(westbound.headingDeg, 270);
  assert.equal(westbound.headingConfidence, 'high');

  assert.equal(plain.headingConfidence, 'low');
  assert.ok(Number.isFinite(plain.headingDeg), 'headingless cameras still get a stable fallback');
});

test('TxDOT heading refuses bare cardinals in Texas route names', () => {
  // "N Lamar" / "West Ave" are street names, not facings. Reading them as a
  // heading would mis-orient the camera with high confidence.
  const cameras = normalizeTxdotDistrictPayload(districtPayload([
    cameraRow({ icd_Id: 'lamar', name: 'N Lamar Blvd @ Rundberg Ln' }),
    cameraRow({ icd_Id: 'west', name: 'West Ave @ 6th St' }),
  ]), 'AUS');

  for (const camera of cameras) {
    assert.equal(camera.headingConfidence, 'low', `${camera.name} must not claim a heading`);
  }
});

test('TxDOT camera ids are district-scoped and stable across runs', () => {
  const build = () => normalizeTxdotDistrictPayload(districtPayload([cameraRow()]), 'AUS')[0].id;
  const austin = build();
  const houston = normalizeTxdotDistrictPayload(districtPayload([cameraRow()]), 'HOU')[0].id;

  assert.equal(austin, build(), 'same input must produce the same id');
  assert.ok(austin.startsWith('txdot-aus-'));
  assert.ok(houston.startsWith('txdot-hou-'));
  assert.notEqual(austin, houston, 'district must scope the id');
});

test('TxDOT ground elevation uses a per-district prior', () => {
  const at = (district) => normalizeTxdotDistrictPayload(districtPayload([cameraRow()]), district)[0].groundElevationM;

  // The payload carries no elevation, and on a keyless stack the client's
  // ground snap never fires — so a sea-level district and a mountain district
  // must not share one prior.
  assert.equal(at('HOU'), 15);
  assert.equal(at('ELP'), 1140);
  assert.equal(at('AUS'), 149);
});

test('TxDOT catalog tolerates a malformed payload', () => {
  assert.deepEqual(normalizeTxdotDistrictPayload(null, 'AUS'), []);
  assert.deepEqual(normalizeTxdotDistrictPayload({}, 'AUS'), []);
  assert.deepEqual(normalizeTxdotDistrictPayload({ roadwayCctvStatuses: [] }, 'AUS'), []);
  assert.deepEqual(normalizeTxdotDistrictPayload({ roadwayCctvStatuses: { 'IH-35': null } }, 'AUS'), []);
});

test('TxDOT snapshot payload decodes to JPEG bytes', () => {
  const result = decodeTxdotSnapshotPayload(JSON.stringify({ snippet: JPEG_B64 }));

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, JPEG_BYTES);
});

test('TxDOT snapshot payload rejects misses and non-JPEG bodies', () => {
  // A registered camera with no current frame answers null or a null snippet.
  assert.equal(decodeTxdotSnapshotPayload('null'), null);
  assert.equal(decodeTxdotSnapshotPayload(JSON.stringify({ snippet: null })), null);
  assert.equal(decodeTxdotSnapshotPayload(JSON.stringify({ snippet: '' })), null);
  assert.equal(decodeTxdotSnapshotPayload('not json at all'), null);

  // Base64 never throws on junk, so the JPEG magic is what guards the response.
  const notJpeg = Buffer.from('<html>nope</html>').toString('base64');
  assert.equal(decodeTxdotSnapshotPayload(JSON.stringify({ snippet: notJpeg })), null);
});

test('frame fetch decodes TxDOT JSON only from the official origin', async () => {
  const jsonResponse = () => new Response(JSON.stringify({ snippet: JPEG_B64 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  const official = await fetchCctvImageFromUpstream(
    'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId?icdId=x&districtCode=AUS',
    { timeoutMs: 100, fetchImpl: async () => jsonResponse() },
  );
  assert.equal(official?.ok, true);
  assert.equal(official?.contentType, 'image/jpeg');

  // Any other host offering the same JSON shape must not be served as an image.
  const impostor = await fetchCctvImageFromUpstream('https://evil.example/frame.json', {
    timeoutMs: 100,
    fetchImpl: async () => jsonResponse(),
  });
  assert.equal(impostor, null);
});
