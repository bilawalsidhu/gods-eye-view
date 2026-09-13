import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTxdotSourcesFromOpenData,
  normalizeTxdotDistrictPayload,
} from '../../server/providers/cctv/sources.js';
import { fetchTxdotSnapshot } from '../../server/providers/cctv/media.js';
import { TXDOT_CCTV_STATUS_URL } from '../../server/providers/cctv/constants.js';

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
    hasSnapshot: true,
    dirDescription: 'North',
    equipLoc: { roadway: 'FM-734', direction: 'North' },
    ...overrides,
  };
}

const districtPayload = (rows) => ({
  roadwayCctvStatuses: { 'FM-734': rows },
});

function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

test('TxDOT catalog keeps only online cameras with finite coordinates', () => {
  const cameras = normalizeTxdotDistrictPayload(
    districtPayload([
      cameraRow({ icd_Id: 'a', name: 'a' }),
      cameraRow({
        icd_Id: 'b',
        name: 'b',
        statusDescription: 'Device Offline',
      }),
      cameraRow({ icd_Id: 'c', name: 'c', statusDescription: 'Device Error' }),
      cameraRow({ icd_Id: 'd', name: 'd', latitude: null }),
      cameraRow({ icd_Id: 'e', name: 'e', longitude: 'not-a-number' }),
      cameraRow({ icd_Id: 'f', name: 'f', latitude: 0, longitude: 0 }),
      cameraRow({
        icd_Id: 'g',
        name: 'g',
        latitude: '30.1',
        longitude: '-97.7',
      }),
      cameraRow({ icd_Id: 'h', name: 'h', hasSnapshot: false }),
    ]),
    'AUS',
  );

  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].name, 'a');
  assert.equal(cameras[0].provider, 'TxDOT');
  assert.equal(cameras[0].feedType, 'image');
  assert.equal(cameras[0].sourceKind, 'txdot-its');
  assert.equal(cameras[0].license, 'Public TxDOT traffic camera data');
  assert.equal(
    cameras[0].url,
    'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId?icdId=a&districtCode=AUS',
  );
});

test('TxDOT catalog dedupes a camera listed under two roadways', () => {
  const cameras = normalizeTxdotDistrictPayload(
    {
      roadwayCctvStatuses: {
        'IH-35': [cameraRow({ icd_Id: 'shared', name: 'IH-35 @ SH-71' })],
        'SH-71': [cameraRow({ icd_Id: 'shared', name: 'IH-35 @ SH-71' })],
      },
    },
    'AUS',
  );
  assert.equal(cameras.length, 1);
});

test('TxDOT heading comes from an explicit travel token, never the roadway direction', () => {
  const [eastbound, westbound, plain] = normalizeTxdotDistrictPayload(
    districtPayload([
      cameraRow({ icd_Id: 'eb', name: 'FM-734 @ US-290 EB' }),
      cameraRow({ icd_Id: 'wb', name: 'FM-734 @ US-290 WB' }),
      cameraRow({ icd_Id: 'plain', name: 'FM-734 @ Bellingham Dr' }),
    ]),
    'AUS',
  );
  assert.equal(eastbound.headingDeg, 90);
  assert.equal(eastbound.headingConfidence, 'high');
  assert.equal(westbound.headingDeg, 270);
  assert.equal(westbound.headingConfidence, 'high');
  assert.equal(plain.headingConfidence, 'low');
  assert.ok(Number.isFinite(plain.headingDeg));
});

test('TxDOT heading refuses bare cardinals in Texas route names', () => {
  const cameras = normalizeTxdotDistrictPayload(
    districtPayload([
      cameraRow({ icd_Id: 'lamar', name: 'N Lamar Blvd @ Rundberg Ln' }),
      cameraRow({ icd_Id: 'west', name: 'West Ave @ 6th St' }),
    ]),
    'AUS',
  );
  for (const camera of cameras) {
    assert.equal(
      camera.headingConfidence,
      'low',
      `${camera.name} must not claim a heading`,
    );
  }
});

test('TxDOT camera ids are district-scoped and stable across runs', () => {
  const build = (district) =>
    normalizeTxdotDistrictPayload(districtPayload([cameraRow()]), district)[0]
      .id;
  assert.equal(build('AUS'), build('AUS'));
  assert.ok(build('AUS').startsWith('txdot-aus-'));
  assert.ok(build('HOU').startsWith('txdot-hou-'));
  assert.notEqual(build('AUS'), build('HOU'));
});

test('TxDOT ground elevation uses a per-district prior', () => {
  const at = (district) =>
    normalizeTxdotDistrictPayload(districtPayload([cameraRow()]), district)[0]
      .groundElevationM;
  assert.equal(at('HOU'), 15);
  assert.equal(at('ELP'), 1140);
  assert.equal(at('AUS'), 149);
  assert.equal(at('SAT'), 198);
});

test('TxDOT catalog tolerates a malformed payload', () => {
  assert.deepEqual(normalizeTxdotDistrictPayload(null, 'AUS'), []);
  assert.deepEqual(normalizeTxdotDistrictPayload({}, 'AUS'), []);
  assert.deepEqual(
    normalizeTxdotDistrictPayload({ roadwayCctvStatuses: [] }, 'AUS'),
    [],
  );
  assert.deepEqual(
    normalizeTxdotDistrictPayload(
      { roadwayCctvStatuses: { 'IH-35': null } },
      'AUS',
    ),
    [],
  );
});

test('TxDOT loader fetches each configured district and ignores unknown codes', async (t) => {
  quiet(t);
  const saved = process.env.CCTV_TXDOT_DISTRICTS;
  process.env.CCTV_TXDOT_DISTRICTS = 'aus, SAT, NOPE, aus';
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    const district = new URL(String(url)).searchParams.get('districtCode');
    return Response.json(
      districtPayload([
        cameraRow({ icd_Id: `${district}-1`, name: `${district}-1` }),
      ]),
    );
  });
  try {
    const cameras = await loadTxdotSourcesFromOpenData();
    assert.deepEqual(requested, [
      TXDOT_CCTV_STATUS_URL('AUS'),
      TXDOT_CCTV_STATUS_URL('SAT'),
    ]);
    assert.deepEqual(cameras.map((camera) => camera.cityId).sort(), [
      'tx-aus',
      'tx-sat',
    ]);
  } finally {
    if (saved === undefined) delete process.env.CCTV_TXDOT_DISTRICTS;
    else process.env.CCTV_TXDOT_DISTRICTS = saved;
  }
});

test('TxDOT snapshot decodes JSON only from the official origin and only as JPEG', async () => {
  const jsonResponse = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  const official =
    'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId?icdId=x&districtCode=AUS';

  const frame = await fetchTxdotSnapshot(official, {
    timeoutMs: 100,
    fetchImpl: async () => jsonResponse({ snippet: JPEG_B64 }),
  });
  assert.equal(frame?.ok, true);
  assert.equal(frame?.contentType, 'image/jpeg');
  assert.deepEqual(frame?.body, JPEG_BYTES);

  assert.equal(
    await fetchTxdotSnapshot('https://evil.example/frame.json', {
      timeoutMs: 100,
      fetchImpl: async () => jsonResponse({ snippet: JPEG_B64 }),
    }),
    null,
  );
  const notJpeg = Buffer.from('<html>nope</html>').toString('base64');
  for (const body of [
    null,
    { snippet: null },
    { snippet: '' },
    { snippet: notJpeg },
  ]) {
    assert.equal(
      await fetchTxdotSnapshot(official, {
        timeoutMs: 100,
        fetchImpl: async () => jsonResponse(body),
      }),
      null,
    );
  }
});
