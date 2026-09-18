import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USGS_QUERY_URL,
  USGS_COUNT_URL,
  ALLOWED_PARAMS,
  validateQuery,
  normalizeFeature,
  fetchEarthquakes,
  countEarthquakes,
} from './usgs-earthquakes.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => text,
  };
}

function sampleFeatureCollection() {
  return {
    type: 'FeatureCollection',
    metadata: {
      generated: 1700000000000,
      url: USGS_QUERY_URL,
      title: 'USGS Earthquakes',
      api: '1.10.3',
      count: 2,
    },
    features: [
      {
        type: 'Feature',
        id: 'us1000abcd',
        properties: {
          mag: 4.5,
          magType: 'mb',
          place: '10km SE of Somewhere',
          time: 1700000000000,
          tsunami: 0,
          alert: null,
          url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us1000abcd',
        },
        geometry: { type: 'Point', coordinates: [-122.1, 37.5, 10.2] },
      },
      {
        type: 'Feature',
        id: 'us1000efgh',
        properties: {
          mag: 6.1,
          magType: 'mww',
          place: 'Offshore Somewhere',
          time: 1700000100000,
          tsunami: 1,
          alert: 'green',
          url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us1000efgh',
        },
        geometry: { type: 'Point', coordinates: [140.2, -5.6, 35.0] },
      },
    ],
  };
}

// --- validateQuery -----------------------------------------------------

test('validateQuery: accepts a full valid set (circle form) and forwards it', () => {
  const result = validateQuery({
    starttime: '2024-01-01',
    endtime: '2024-01-02T12:30:00Z',
    minmagnitude: '2.5',
    maxmagnitude: 7,
    latitude: 35,
    longitude: -120,
    maxradiuskm: 500,
    limit: 50,
    orderby: 'magnitude',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'query');
  assert.deepEqual(result.forwarded, {
    starttime: '2024-01-01T00:00:00Z',
    endtime: '2024-01-02T12:30:00Z',
    minmagnitude: 2.5,
    maxmagnitude: 7,
    latitude: 35,
    longitude: -120,
    maxradiuskm: 500,
    limit: 50,
    orderby: 'magnitude',
    format: 'geojson',
  });
});

test('validateQuery: rejects unknown params and lists their names', () => {
  const result = validateQuery({ foo: 'bar', minmagnitude: '5' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.deepEqual(result.unknown, ['foo']);
  assert.match(result.error, /foo/);
});

test('validateQuery: rejects mixed circle + bbox as mutually exclusive', () => {
  const result = validateQuery({
    latitude: 10,
    longitude: 20,
    maxradiuskm: 100,
    minlatitude: 1,
    maxlatitude: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /mutually exclusive/);
});

test('validateQuery: rejects an incomplete circle (missing maxradiuskm)', () => {
  const result = validateQuery({ latitude: 10, longitude: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /together/);
});

test('validateQuery: rejects bbox with min > max', () => {
  const result = validateQuery({ minlatitude: 10, maxlatitude: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error, /minlatitude/);
});

test('validateQuery: caps limit to 200 but does not error', () => {
  const result = validateQuery({ limit: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.forwarded.limit, 200);
});

test('validateQuery: rejects a non-integer / too-low limit', () => {
  assert.equal(validateQuery({ limit: 0 }).ok, false);
  assert.equal(validateQuery({ limit: 1.5 }).ok, false);
  assert.equal(validateQuery({ limit: 'abc' }).ok, false);
});

test('validateQuery: defaults orderby=time, limit=100 and adds format=geojson exactly once', () => {
  const result = validateQuery({});
  assert.equal(result.ok, true);
  assert.equal(result.forwarded.orderby, 'time');
  assert.equal(result.forwarded.limit, 100);
  assert.equal(result.forwarded.format, 'geojson');
  assert.equal(
    Object.keys(result.forwarded).filter((k) => k === 'format').length,
    1,
  );
});

test('validateQuery: rejects an invalid orderby value', () => {
  const result = validateQuery({ orderby: 'distance' });
  assert.equal(result.ok, false);
  assert.match(result.error, /orderby/);
});

test('validateQuery: rejects out-of-range magnitude/lat/lon/radius', () => {
  assert.equal(validateQuery({ minmagnitude: -3 }).ok, false);
  assert.equal(validateQuery({ maxmagnitude: 11 }).ok, false);
  assert.equal(
    validateQuery({ latitude: 91, longitude: 0, maxradiuskm: 1 }).ok,
    false,
  );
  assert.equal(
    validateQuery({ latitude: 0, longitude: -181, maxradiuskm: 1 }).ok,
    false,
  );
  assert.equal(
    validateQuery({ latitude: 0, longitude: 0, maxradiuskm: 20001.7 }).ok,
    false,
  );
  assert.equal(
    validateQuery({ latitude: 0, longitude: 0, maxradiuskm: 0 }).ok,
    false,
  );
});

test('validateQuery: rejects a malformed starttime/endtime', () => {
  assert.equal(validateQuery({ starttime: 'not-a-date' }).ok, false);
  assert.equal(validateQuery({ starttime: '2024-13-40' }).ok, false);
  assert.equal(validateQuery({ endtime: '2024-01-01T25:00:00Z' }).ok, false);
});

test('ALLOWED_PARAMS is frozen and matches the documented list', () => {
  assert.ok(Object.isFrozen(ALLOWED_PARAMS));
  assert.deepEqual(ALLOWED_PARAMS, [
    'starttime',
    'endtime',
    'minmagnitude',
    'maxmagnitude',
    'latitude',
    'longitude',
    'maxradiuskm',
    'minlatitude',
    'maxlatitude',
    'minlongitude',
    'maxlongitude',
    'limit',
    'orderby',
  ]);
});

// --- normalizeFeature ----------------------------------------------------

test('normalizeFeature: maps a GeoJSON feature to the flat event shape', () => {
  const feature = sampleFeatureCollection().features[0];
  const event = normalizeFeature(feature, '2024-06-01T00:00:00.000Z');
  assert.deepEqual(event, {
    id: 'us1000abcd',
    time_utc: new Date(1700000000000).toISOString(),
    magnitude: 4.5,
    mag_type: 'mb',
    depth_km: 10.2,
    lat: 37.5,
    lon: -122.1,
    place: '10km SE of Somewhere',
    tsunami: 0,
    alert: null,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us1000abcd',
    source: 'USGS',
    coverage: 'observed',
    retrieved_at_utc: '2024-06-01T00:00:00.000Z',
  });
});

// --- fetchEarthquakes ------------------------------------------------------

test('fetchEarthquakes: happy path normalises a 2-feature GeoJSON response', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = String(url);
    return jsonResponse(200, sampleFeatureCollection());
  };
  const result = await fetchEarthquakes(
    { minmagnitude: 4, starttime: '2024-01-01', endtime: '2024-01-02' },
    { fetchImpl, now: () => new Date('2024-06-01T00:00:00.000Z') },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.count, 2);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].depth_km, 10.2);
  assert.equal(result.events[0].lat, 37.5);
  assert.equal(result.events[0].lon, -122.1);
  assert.equal(
    result.events[0].time_utc,
    new Date(1700000000000).toISOString(),
  );
  assert.equal(result.events[0].source, 'USGS');
  assert.equal(result.events[0].coverage, 'observed');
  assert.equal(result.events[0].retrieved_at_utc, '2024-06-01T00:00:00.000Z');
  assert.equal(result.events[1].tsunami, 1);
  assert.equal(result.provenance.url, capturedUrl);
  assert.equal(
    result.provenance.generated,
    new Date(1700000000000).toISOString(),
  );
  assert.equal(result.provenance.source, 'USGS FDSN Event Web Service');

  const requested = new URL(capturedUrl);
  assert.equal(requested.origin + requested.pathname, USGS_QUERY_URL);
  assert.equal(requested.searchParams.get('format'), 'geojson');
  assert.equal(requested.searchParams.get('minmagnitude'), '4');
  assert.equal(requested.searchParams.get('starttime'), '2024-01-01T00:00:00Z');
  assert.equal(requested.searchParams.get('endtime'), '2024-01-02T00:00:00Z');
  assert.equal(requested.searchParams.getAll('format').length, 1);
});

test('fetchEarthquakes: empty feature list is still ok:true with count 0', async () => {
  const fetchImpl = async () =>
    jsonResponse(200, { metadata: { generated: Date.now() }, features: [] });
  const result = await fetchEarthquakes({}, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.deepEqual(result.events, []);
});

test('fetchEarthquakes: validation failure short-circuits before any fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { features: [] });
  };
  const result = await fetchEarthquakes({ foo: 'bar' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.deepEqual(result.unknown, ['foo']);
  assert.equal(calls, 0);
});

test('fetchEarthquakes: USGS 400 plain-text body is surfaced as usgs_rejected, no retry', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return textResponse(400, 'Bad Request: incorrect parameter combination.');
  };
  const result = await fetchEarthquakes({ minmagnitude: 5 }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'usgs_rejected');
  assert.match(result.detail, /Bad Request/);
  assert.equal(calls, 1);
});

test('fetchEarthquakes: a 500 followed by a 200 succeeds after exactly one retry', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return textResponse(500, 'Internal Server Error');
    return jsonResponse(200, sampleFeatureCollection());
  };
  const result = await fetchEarthquakes({}, { fetchImpl, retries: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(calls, 2);
});

test('fetchEarthquakes: a timeout on every attempt returns 504 usgs_timeout after one retry', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const error = new Error('The operation timed out.');
    error.name = 'TimeoutError';
    throw error;
  };
  const result = await fetchEarthquakes({}, { fetchImpl, retries: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 504);
  assert.equal(result.error, 'usgs_timeout');
  assert.equal(calls, 2);
});

test('fetchEarthquakes: a non-timeout network error maps to usgs_unavailable', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('getaddrinfo ENOTFOUND earthquake.usgs.gov');
  };
  const result = await fetchEarthquakes({}, { fetchImpl, retries: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 504);
  assert.equal(result.error, 'usgs_unavailable');
  assert.equal(calls, 2);
});

test('fetchEarthquakes: mode=count uses the count URL and returns the upstream count', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = String(url);
    return jsonResponse(200, { count: 42, maxAllowed: 20000 });
  };
  const result = await fetchEarthquakes(
    { mode: 'count', minmagnitude: 5 },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.equal(result.count, 42);
  assert.ok(capturedUrl.startsWith(USGS_COUNT_URL));
});

test('countEarthquakes: convenience wrapper forces mode=count', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = String(url);
    return jsonResponse(200, { count: 7 });
  };
  const result = await countEarthquakes({ minmagnitude: 6 }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.count, 7);
  assert.ok(capturedUrl.startsWith(USGS_COUNT_URL));
});
