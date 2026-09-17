import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTrafikverketSourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import { isLikelySwedenCoordinate } from '../../server/providers/cctv/normalize.js';
import { DEFAULT_TRAFIKVERKET_MAX_SOURCES } from '../../server/providers/cctv/constants.js';

/** A mock Trafikverket Camera object. */
function camera(id, {
  name = `Camera ${id}`,
  lat = 59.3293,
  lon = 18.0686,
  photoUrl = `https://camera.example/cam${id}.jpg`,
  type = 'Trafikkamera',
  direction = 90,
  active = true,
} = {}) {
  return {
    Id: id,
    Name: name,
    Geometry: { WGS84: `POINT (${lon} ${lat})` },
    PhotoUrl: photoUrl,
    Type: type,
    Direction: direction,
    Active: active,
  };
}

/** Run the loader against a canned response, restoring global fetch after. */
async function loadWith(cameras, { env = {}, status = 200 } = {}) {
  const originalFetch = globalThis.fetch;
  const originalEnv = {};
  const mockEnv = {
    CCTV_TRAFIKVERKET_API_KEY: 'test-key',
    ...env,
  };
  
  for (const [key, value] of Object.entries(mockEnv)) {
    originalEnv[key] = process.env[key];
    process.env[key] = value;
  }

  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        RESPONSE: {
          RESULT: [{ Camera: cameras }]
        }
      }),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  };

  try {
    return await loadTrafikverketSourcesFromOpenData();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Trafikverket loader normalizes camera records', async () => {
  const result = await loadWith([
    camera('123', { name: 'Stockholm North', lat: 59.4, lon: 18.0, direction: 180 }),
    camera('456', { name: 'VViS Station', type: 'Väglagskamera', lat: 60.0, lon: 15.0, direction: null }),
  ]);

  assert.equal(result.length, 2);
  
  const [c1, c2] = result;
  assert.equal(c1.id, 'se-trafikverket-123');
  assert.equal(c1.name, 'Stockholm North');
  assert.equal(c1.provider, 'Trafikverket');
  assert.equal(c1.city, 'Sweden');
  assert.equal(c1.lat, 59.4);
  assert.equal(c1.lon, 18.0);
  assert.equal(c1.headingDeg, 180);
  assert.equal(c1.headingConfidence, 'high');
  assert.equal(c1.url, 'https://camera.example/cam123.jpg');

  assert.equal(c2.id, 'se-trafikverket-456');
  assert.equal(c2.provider, 'Trafikverket VViS');
  assert.equal(c2.headingConfidence, 'low');
  assert.ok(Number.isFinite(c2.headingDeg)); // fallback heading
});

test('Trafikverket loader filters out malformed coordinates and missing URLs', async () => {
  const result = await loadWith([
    camera('good', { lat: 59, lon: 18 }),
    camera('bad-coords', { lat: 0, lon: 0 }),
    camera('no-url', { photoUrl: null }),
    camera('bad-string-coords', { lat: NaN, lon: NaN }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'se-trafikverket-good');
});

test('Trafikverket loader requires an API key', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CCTV_TRAFIKVERKET_API_KEY;
  delete process.env.CCTV_TRAFIKVERKET_API_KEY;
  
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{}');
  };

  try {
    const result = await loadTrafikverketSourcesFromOpenData();
    assert.deepEqual(result, []);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.CCTV_TRAFIKVERKET_API_KEY = originalKey;
  }
});

test('Trafikverket loader handles upstream failures gracefully', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response('Internal Server Error', { status: 500 });
  };
  
  const originalKey = process.env.CCTV_TRAFIKVERKET_API_KEY;
  process.env.CCTV_TRAFIKVERKET_API_KEY = 'test-key';

  try {
    const result = await loadTrafikverketSourcesFromOpenData();
    assert.deepEqual(result, []);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.CCTV_TRAFIKVERKET_API_KEY = originalKey;
  }
});

test('Trafikverket loader makes correct POST request with valid XML syntax and avoids logging API key', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let requestedUrl = null;
  let requestedOptions = null;
  const loggedMessages = [];

  console.warn = (...args) => {
    loggedMessages.push(args.join(' '));
  };

  globalThis.fetch = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return new Response(
      JSON.stringify({
        RESPONSE: {
          RESULT: [{ Camera: [camera('999')] }]
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const originalKey = process.env.CCTV_TRAFIKVERKET_API_KEY;
  process.env.CCTV_TRAFIKVERKET_API_KEY = 'secret-api-key-123';

  try {
    const result = await loadTrafikverketSourcesFromOpenData();
    assert.equal(result.length, 1);
    
    // 1. Verify request URL
    assert.equal(requestedUrl, 'https://api.trafikinfo.trafikverket.se/v2/data.json');
    
    // 2. Verify POST method
    assert.equal(requestedOptions.method, 'POST');
    
    // 3. Verify XML body syntax
    const body = requestedOptions.body;
    assert.ok(body.includes('<REQUEST>'), 'body should have REQUEST tag');
    assert.ok(body.includes('<LOGIN authenticationkey="secret-api-key-123"/>'), 'body should include LOGIN with authenticationkey');
    assert.ok(body.includes('<QUERY objecttype="Camera" schemaversion="1">'), 'body should include QUERY with objecttype and schemaversion');
    assert.ok(body.includes('<EQ name="Active" value="true" />'), 'body should include Active filter');

    // 4. Verify API key is never logged
    for (const msg of loggedMessages) {
      assert.equal(msg.includes('secret-api-key-123'), false, 'API key must not appear in any log');
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalKey === undefined) delete process.env.CCTV_TRAFIKVERKET_API_KEY;
    else process.env.CCTV_TRAFIKVERKET_API_KEY = originalKey;
  }
test('Trafikverket loader honors max source cap', async () => {
  const manyCameras = Array.from({ length: 20 }, (_, i) => camera(String(i)));
  const result = await loadWith(manyCameras, {
    env: { CCTV_TRAFIKVERKET_MAX_SOURCES: '8' }
  });

  assert.equal(result.length, 8);
});

});

test('isLikelySwedenCoordinate spans Sweden and rejects elsewhere', () => {
  assert.equal(isLikelySwedenCoordinate(59.3293, 18.0686), true); // Stockholm
  assert.equal(isLikelySwedenCoordinate(67.8557, 20.2251), true); // Kiruna
  assert.equal(isLikelySwedenCoordinate(55.6050, 13.0038), true); // Malmö
  assert.equal(isLikelySwedenCoordinate(51.5074, -0.1278), false); // London
  assert.equal(isLikelySwedenCoordinate(0, 0), false); // Null Island
});
