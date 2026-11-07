import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTrafikverketSourcesFromOpenData,
  normalizeTrafikverketPhotoUrl,
  trafikverketCameraToSource,
  _resetTrafikverketKeyWarningForTest,
} from '../../server/providers/cctv/sources.js';
import { isLikelySwedenCoordinate } from '../../server/providers/cctv/normalize.js';
import { fetchWithinHost } from '../../server/providers/cctv/media.js';

const IMAGES = 'https://api.trafikinfo.trafikverket.se/v2/Images/';
const KEY = '0123456789abcdef0123456789abcdef';

/** A Trafikverket Camera object shaped like the live feed. */
function camera(
  id,
  {
    name = `Camera ${id}`,
    lat = 59.3293,
    lon = 18.0686,
    photoUrl = `${IMAGES}TrafficFlowCamera_${1000 + Number(id) || 1}.Jpeg`,
    type = 'Trafikflödeskamera',
    direction = 90,
    photoTime = new Date().toISOString(),
  } = {},
) {
  return {
    Id: `SE_STA_CAMERA_${id}`,
    Name: name,
    Geometry: { WGS84: `POINT (${lon} ${lat})` },
    PhotoUrl: photoUrl,
    PhotoTime: photoTime,
    Type: type,
    Direction: direction,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Run the loader with a stubbed fetch and console, restoring both after. */
async function run({ env = {}, respond, cameras = [] } = {}) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const logs = [];
  const calls = [];
  console.warn = (...args) => logs.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond
      ? respond(url, init)
      : jsonResponse({ RESPONSE: { RESULT: [{ Camera: cameras }] } });
  };
  try {
    const result = await loadTrafikverketSourcesFromOpenData(
      {},
      { CCTV_TRAFIKVERKET_API_KEY: KEY, ...env },
    );
    return { result, logs, calls };
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

test('Trafikverket loader normalizes camera records', async () => {
  const { result } = await run({
    cameras: [
      camera('123', {
        name: 'Stockholm North',
        lat: 59.4,
        lon: 18.0,
        direction: 180,
      }),
      camera('456', {
        name: 'VViS Station',
        type: 'Väglagskamera',
        lat: 60.0,
        lon: 15.0,
        direction: null,
        photoUrl: `${IMAGES}RoadConditionCamera_39635739.Jpeg`,
      }),
    ],
  });

  assert.equal(result.length, 2);
  const byId = new Map(result.map((c) => [c.id, c]));
  const c1 = byId.get('se-trafikverket-se_sta_camera_123');
  assert.equal(c1.name, 'Stockholm North');
  assert.equal(c1.provider, 'Trafikverket');
  assert.equal(c1.city, 'Sweden');
  assert.equal(c1.lat, 59.4);
  assert.equal(c1.lon, 18.0);
  assert.equal(c1.headingDeg, 180);
  assert.equal(c1.headingConfidence, 'high');
  assert.equal(c1.poseSource, undefined);
  assert.equal(c1.code, 'STOCKHOLM NORTH');
  assert.equal(c1.url, `${IMAGES}TrafficFlowCamera_1123.Jpeg`);
  assert.equal(c1.snapshotUrl, c1.url);

  const c2 = byId.get('se-trafikverket-se_sta_camera_456');
  assert.equal(c2.provider, 'Trafikverket VViS');
  assert.equal(c2.headingConfidence, 'low');
  assert.ok(Number.isFinite(c2.headingDeg));
  assert.equal(c2.url, `${IMAGES}RoadConditionCamera_39635739.Jpeg`);
});

test('Trafikverket loader drops bad coordinates, missing URLs and frozen cameras', async () => {
  const { result } = await run({
    cameras: [
      camera('1', { lat: 59, lon: 18 }),
      camera('2', { lat: 0, lon: 0 }),
      camera('3', { photoUrl: null }),
      camera('4', { lat: NaN, lon: NaN }),
      camera('5', { photoTime: '2024-06-12T14:54:50+02:00' }),
    ],
  });
  assert.deepEqual(
    result.map((c) => c.id),
    ['se-trafikverket-se_sta_camera_1'],
  );
});

test('PhotoUrl is pinned to the official Trafikverket image directory', () => {
  const ok = `${IMAGES}TrafficFlowCamera_39627248.Jpeg`;
  assert.equal(normalizeTrafikverketPhotoUrl(ok), ok);
  for (const bad of [
    'http://api.trafikinfo.trafikverket.se/v2/Images/TrafficFlowCamera_1.Jpeg',
    'https://127.0.0.1/v2/Images/TrafficFlowCamera_1.Jpeg',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/v2/Images/TrafficFlowCamera_1.Jpeg',
    'https://localhost/v2/Images/TrafficFlowCamera_1.Jpeg',
    'https://api.trafikinfo.trafikverket.se.evil.example/v2/Images/TrafficFlowCamera_1.Jpeg',
    'https://evil.example/api.trafikinfo.trafikverket.se/v2/Images/TrafficFlowCamera_1.Jpeg',
    'https://user:pw@api.trafikinfo.trafikverket.se/v2/Images/TrafficFlowCamera_1.Jpeg',
    'https://api.trafikinfo.trafikverket.se:8443/v2/Images/TrafficFlowCamera_1.Jpeg',
    'https://api.trafikinfo.trafikverket.se/v2/data.json',
    'https://api.trafikinfo.trafikverket.se/v2/Images/../data.json',
    'https://api.trafikinfo.trafikverket.se/v2/Images/x%2F..%2Fdata.json',
    'https://api.trafikinfo.trafikverket.se/v2/Images/TrafficFlowCamera_1.Jpeg?type=x',
    'https://api.trafikinfo.trafikverket.se/v2/Images/sub/TrafficFlowCamera_1.Jpeg',
    'https://x/3.jpg',
    '',
    null,
  ]) {
    assert.equal(normalizeTrafikverketPhotoUrl(bad), '', String(bad));
  }
  assert.equal(
    trafikverketCameraToSource(camera('7', { photoUrl: 'https://x/3.jpg' })),
    null,
  );
});

test('Trafikverket loader skips without a key, warning once, and never fetches', async () => {
  _resetTrafikverketKeyWarningForTest();
  const first = await run({ env: { CCTV_TRAFIKVERKET_API_KEY: '' } });
  const second = await run({ env: { CCTV_TRAFIKVERKET_API_KEY: '' } });
  assert.deepEqual(first.result, []);
  assert.deepEqual(second.result, []);
  assert.equal(first.calls.length + second.calls.length, 0);
  assert.equal(first.logs.length, 1);
  assert.match(first.logs[0], /CCTV_TRAFIKVERKET_API_KEY/);
  assert.equal(second.logs.length, 0);
});

test('a key that could break out of the XML attribute is refused, not sent', async () => {
  _resetTrafikverketKeyWarningForTest();
  const { result, calls, logs } = await run({
    env: { CCTV_TRAFIKVERKET_API_KEY: 'abc"/><QUERY objecttype="x' },
  });
  assert.deepEqual(result, []);
  assert.equal(calls.length, 0);
  assert.equal(
    logs.some((l) => l.includes('abc"')),
    false,
    'the rejected key is not logged',
  );
});

test('Trafikverket loader POSTs the query without following redirects and never logs the key', async () => {
  const { result, calls, logs } = await run({ cameras: [camera('999')] });
  assert.equal(result.length, 1);
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.trafikinfo.trafikverket.se/v2/data.json');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.ok(init.body.includes(`<LOGIN authenticationkey="${KEY}"/>`));
  assert.ok(
    init.body.includes('<QUERY objecttype="Camera" schemaversion="1">'),
  );
  assert.ok(init.body.includes('<EQ name="Active" value="true" />'));
  for (const msg of logs) assert.equal(msg.includes(KEY), false);
});

test('a redirect on the keyed POST is refused and its body released', async () => {
  let cancelled = false;
  const { result } = await run({
    respond: () => {
      const resp = new Response('moved', {
        status: 307,
        headers: { Location: 'https://evil.example/collect' },
      });
      const original = resp.body.cancel.bind(resp.body);
      resp.body.cancel = (...a) => {
        cancelled = true;
        return original(...a);
      };
      return resp;
    },
  });
  assert.deepEqual(result, []);
  assert.equal(cancelled, true);
});

test('upstream failures and in-band API errors yield an empty pack', async () => {
  const http500 = await run({
    respond: () => new Response('Internal Server Error', { status: 500 }),
  });
  assert.deepEqual(http500.result, []);

  const unauthorized = await run({
    respond: () =>
      jsonResponse(
        {
          RESPONSE: {
            RESULT: [
              {
                ERROR: {
                  SOURCE: 'Security',
                  MESSAGE: 'Invalid authentication',
                },
              },
            ],
          },
        },
        401,
      ),
  });
  assert.deepEqual(unauthorized.result, []);
  assert.ok(unauthorized.logs.some((l) => l.includes('401')));

  const inBand = await run({
    respond: () =>
      jsonResponse({
        RESPONSE: {
          RESULT: [{ ERROR: { SOURCE: 'Query', MESSAGE: 'Bad filter' } }],
        },
      }),
  });
  assert.deepEqual(inBand.result, []);
  assert.ok(inBand.logs.some((l) => l.includes('Bad filter')));
  assert.equal(
    inBand.logs.some((l) => l.includes('Loaded')),
    false,
  );
});

test('an oversized catalog body is refused', async () => {
  const { result } = await run({
    respond: () =>
      new Response('x'.repeat(9 * 1024 * 1024), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  assert.deepEqual(result, []);
});

test('Trafikverket loader honors the max source cap, clamped to 8..1000', async () => {
  const many = Array.from({ length: 20 }, (_, i) => camera(String(i)));
  const capped = await run({
    cameras: many,
    env: { CCTV_TRAFIKVERKET_MAX_SOURCES: '8' },
  });
  assert.equal(capped.result.length, 8);
  const floor = await run({
    cameras: many,
    env: { CCTV_TRAFIKVERKET_MAX_SOURCES: '2' },
  });
  assert.equal(floor.result.length, 8);
});

test('frame redirects on the image host stay inside the image directory', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(null, {
      status: 302,
      headers: { Location: '/v2/data.json' },
    });
  };
  const resp = await fetchWithinHost(
    `${IMAGES}TrafficFlowCamera_1.Jpeg`,
    {},
    fetchImpl,
  );
  assert.equal(resp, null);
  assert.equal(seen.length, 1);
});

test('isLikelySwedenCoordinate spans Sweden and rejects elsewhere', () => {
  assert.equal(isLikelySwedenCoordinate(59.3293, 18.0686), true); // Stockholm
  assert.equal(isLikelySwedenCoordinate(67.8557, 20.2251), true); // Kiruna
  assert.equal(isLikelySwedenCoordinate(55.605, 13.0038), true); // Malmö
  assert.equal(isLikelySwedenCoordinate(58.9365, 11.1711), true); // Strömstad
  assert.equal(isLikelySwedenCoordinate(59.9139, 10.7522), false); // Oslo
  assert.equal(isLikelySwedenCoordinate(51.5074, -0.1278), false); // London
  assert.equal(isLikelySwedenCoordinate(0, 0), false); // Null Island
});
