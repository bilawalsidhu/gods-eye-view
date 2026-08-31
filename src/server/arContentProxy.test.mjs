import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArProviderCatalog,
  buildArpoiseRequestUrl,
  createArContentProxyPlugin,
  filterExperiencesByTime,
  normalizeArpoiseExperiences,
  normalizeGeoverseExperiences,
  normalizeMeshmapExperiences,
  normalizeOscpExperiences,
} from './arContentProxy.js';

const QUERY = Object.freeze({ lat: 48.158662, lon: 11.580377, radiusM: 1500 });

function arProxyHandler(plugin) {
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use(path, candidate) {
        assert.equal(path, '/api/ar-content');
        handler = candidate;
      },
    },
  });
  assert.equal(typeof handler, 'function');
  return handler;
}

async function invokeArProxy(handler, query) {
  let body = '';
  const headers = new Map();
  const response = {
    statusCode: 0,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    end(value = '') { body = String(value); },
  };
  await handler({
    method: 'GET',
    url: `/?${new URLSearchParams(query)}`,
    socket: { remoteAddress: '127.0.0.1' },
  }, response);
  return { statusCode: response.statusCode, headers, body, payload: JSON.parse(body) };
}

test('provider catalog keeps OSCP operators distinct and ARpoise production-gated', () => {
  const providers = buildArProviderCatalog({
    GEOVERSE_API_URL: 'http://localhost:8787',
    GEOVERSE_WEB_URL: 'http://localhost:3000',
    MESHMAP_API_URL: 'https://api.meshmap.example',
    MESHMAP_API_KEY: 'secret',
    OSCP_INSTANCES_JSON: JSON.stringify([
      {
        id: 'city-lab',
        name: 'City Lab AR',
        baseUrl: 'https://oscp.city.example',
        apiKey: 'test-key',
      },
      {
        id: 'museum',
        name: 'Museum Spatial Catalog',
        baseUrl: 'https://oscp.museum.example',
      },
    ]),
  });

  assert.deepEqual(providers.map(({ id }) => id), [
    'geoverse',
    'meshmap',
    'arpoise',
    'oscp:city-lab',
    'oscp:museum',
  ]);
  assert.equal(providers.find(({ id }) => id === 'arpoise').enabled, false);
  assert.match(providers.find(({ id }) => id === 'arpoise').reason, /maintainer/i);
  assert.deepEqual(
    providers.filter(({ protocol }) => protocol === 'oscp').map(({ label }) => ({ label })),
    [{ label: 'City Lab AR' }, { label: 'Museum Spatial Catalog' }],
  );
});

test('provider catalog requires a Geoverse launch origin and caps OSCP operators', () => {
  const oscpInstances = Array.from({ length: 30 }, (_, index) => ({
    id: `operator-${index}`,
    name: `Operator ${index}`,
    baseUrl: `https://oscp-${index}.example`,
  }));
  const providers = buildArProviderCatalog({
    GEOVERSE_API_URL: 'https://api.geoverse.example',
    OSCP_INSTANCES_JSON: JSON.stringify(oscpInstances),
  });

  const geoverse = providers.find(({ id }) => id === 'geoverse');
  assert.equal(geoverse.configured, false);
  assert.equal(geoverse.enabled, false);
  assert.match(geoverse.reason, /launch URL/i);
  assert.equal(providers.filter(({ protocol }) => protocol === 'oscp').length, 24);
});

test('configured nearby paths cannot change the trusted provider origin', async () => {
  const providers = buildArProviderCatalog({
    MESHMAP_API_URL: 'https://api.meshmap.example',
    MESHMAP_API_KEY: 'mesh-secret',
    MESHMAP_NEARBY_PATH: 'https://evil.example/collect',
    OSCP_INSTANCES_JSON: JSON.stringify([{
      id: 'city-lab',
      baseUrl: 'https://oscp.city.example',
      nearbyPath: '//evil.example/collect',
    }]),
  });
  assert.equal(providers.find(({ id }) => id === 'meshmap')._nearbyPath, '/api/location/pins');
  assert.equal(providers.find(({ id }) => id === 'oscp:city-lab')._nearbyPath, '/search/nearby');

  const upstreamUrls = [];
  const plugin = createArContentProxyPlugin({
    env: {
      MESHMAP_API_URL: 'https://api.meshmap.example',
      MESHMAP_API_KEY: 'mesh-secret',
      MESHMAP_NEARBY_PATH: '//evil.example/collect',
      GEV_RATELIMIT_AR_PER_MIN: '0',
    },
    fetchImpl: async (url, options) => {
      upstreamUrls.push(String(url));
      assert.equal(url.hostname, 'api.meshmap.example');
      assert.equal(url.pathname, '/api/location/pins');
      assert.equal(options.headers['x-app-api-key'], 'mesh-secret');
      return new Response(JSON.stringify({ pins: [] }), { status: 200 });
    },
  });
  const response = await invokeArProxy(arProxyHandler(plugin), {
    ...QUERY,
    providers: 'meshmap',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamUrls.length, 1);
  assert.doesNotMatch(upstreamUrls[0], /evil\.example/);
});

test('ARpoise requests use the raw directory backend and normalize microdegrees', () => {
  const provider = buildArProviderCatalog({ ARPOISE_ENABLED: 'true' })
    .find(({ id }) => id === 'arpoise');
  const url = buildArpoiseRequestUrl(provider, QUERY);

  assert.equal(url.pathname, '/php/dir/web/porpoise.php');
  assert.doesNotMatch(url.href, /cgi-bin/i);
  assert.equal(url.searchParams.get('lat'), String(QUERY.lat));
  assert.equal(url.searchParams.get('lon'), String(QUERY.lon));

  const experiences = normalizeArpoiseExperiences({
    errorCode: 0,
    hotspots: [
      {
        id: '73',
        lat: 48158540,
        lon: 11578610,
        title: 'Default-ParadoQc2Extern',
        line1: 'ParadoQc2 Extern',
        line2: 'by Tamiko Thiel and /p',
        attribution: 'Tamiko Thiel and /p',
        distance: 131.7,
        type: 0,
      },
      {
        id: 'near-origin',
        lat: 120000,
        lon: -50000,
        title: 'Near Origin',
      },
    ],
  }, provider, QUERY);

  assert.equal(experiences.length, 2);
  assert.equal(experiences[0].lat, 48.15854);
  assert.equal(experiences[0].lon, 11.57861);
  assert.equal(experiences[0].title, 'ParadoQc2 Extern');
  assert.equal(experiences[0].creator, 'by Tamiko Thiel and /p');
  assert.equal(
    experiences[0].launchUrl,
    'arpoisedeeplink://DeeplinkLayer?Default-ParadoQc2Extern',
  );
  assert.equal(experiences[1].lat, 0.12);
  assert.equal(experiences[1].lon, -0.05);
});

test('Geoverse nearby results become launchable normalized experiences', () => {
  const provider = buildArProviderCatalog({
    GEOVERSE_API_URL: 'https://api.geoverse.example',
    GEOVERSE_WEB_URL: 'https://geoverse.example',
  }).find(({ id }) => id === 'geoverse');

  const experiences = normalizeGeoverseExperiences({
    experiences: [{
      id: 'a9dfbd1d-603a-48ef-b34d-207917d0bd61',
      name: 'Valencia Mural',
      creatorId: 'creator-42',
      lat: 37.7599,
      lng: -122.4148,
      h3Cell: '872830828ffffff',
      distanceM: 42.5,
    }],
  }, provider, QUERY);

  assert.equal(experiences[0].providerId, 'geoverse');
  assert.equal(experiences[0].protocol, 'geoverse');
  assert.equal(experiences[0].title, 'Valencia Mural');
  assert.equal(experiences[0].creator, 'creator-42');
  assert.equal(experiences[0].lat, 37.7599);
  assert.equal(experiences[0].lon, -122.4148);
  assert.equal(experiences[0].distanceM, 42.5);
  assert.equal(
    experiences[0].launchUrl,
    'https://geoverse.example/e/a9dfbd1d-603a-48ef-b34d-207917d0bd61',
  );
});

test('MeshMap nearby pins retain public AR content and source timestamps', () => {
  const provider = buildArProviderCatalog({
    MESHMAP_API_URL: 'https://api.meshmap.example',
  }).find(({ id }) => id === 'meshmap');

  const experiences = normalizeMeshmapExperiences({
    pins: [
      {
        id: 12,
        title: 'Wilderlands Portal',
        latitude: 37.3318,
        longitude: -121.8913,
        contentType: 'URL',
        contentUrl: 'https://play.meshmap.example/wilderlands',
        visibility: 'public',
        updatedAt: '2026-08-01T12:00:00.000Z',
        distance: 95,
      },
      {
        id: 13,
        title: 'Private prototype',
        latitude: 37.33,
        longitude: -121.89,
        contentType: 'GLB',
        contentUrl: 'https://assets.meshmap.example/private.glb',
        visibility: 'private',
      },
      {
        id: 14,
        title: 'Unclassified prototype',
        latitude: 37.34,
        longitude: -121.88,
        contentUrl: 'https://assets.meshmap.example/unclassified.glb',
      },
    ],
  }, provider, QUERY);

  assert.equal(experiences.length, 1);
  assert.equal(experiences[0].id, '12');
  assert.equal(experiences[0].providerId, 'meshmap');
  assert.equal(experiences[0].title, 'Wilderlands Portal');
  assert.equal(experiences[0].contentType, 'URL');
  assert.equal(experiences[0].launchUrl, 'https://play.meshmap.example/wilderlands');
  assert.equal(experiences[0].updatedAt, '2026-08-01T12:00:00.000Z');
});

test('OSCP content is attributed to the configured operator rather than OSCP', () => {
  const provider = buildArProviderCatalog({
    OSCP_INSTANCES_JSON: JSON.stringify([{
      id: 'city-lab',
      name: 'City Lab AR',
      baseUrl: 'https://oscp.city.example',
    }]),
  }).find(({ id }) => id === 'oscp:city-lab');

  const experiences = normalizeOscpExperiences({
    data: [{
      distance: 214,
      id: 'uuid1',
      object: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-1.47276, 50.93965] },
        properties: {
          id: 'uuid1',
          content: [{
            geopose: {
              position: { lat: 50.93965, lon: -1.47276, h: 12 },
              quaternion: { x: 0, y: 0, z: 0, w: 1 },
            },
            metatype: 'model3D',
            contenttype: 'model/gltf+json',
            description: 'Harbor sculpture',
            url: 'https://content.city.example/harbor.gltf',
            tags: { name: 'Harbor Sculpture', artist: 'City Lab' },
          }],
        },
      },
    }],
  }, provider, QUERY);

  assert.equal(experiences.length, 1);
  assert.equal(experiences[0].id, 'uuid1:0');
  assert.equal(experiences[0].providerId, 'oscp:city-lab');
  assert.equal(experiences[0].providerLabel, 'City Lab AR');
  assert.equal(experiences[0].protocol, 'oscp');
  assert.equal(experiences[0].title, 'Harbor Sculpture');
  assert.equal(experiences[0].creator, 'City Lab');
  assert.equal(experiences[0].altitudeM, 12);
});

test('expired experiences are hidden unless the past filter is enabled', () => {
  const experiences = [
    { id: 'past', endsAt: '2025-01-01T00:00:00.000Z' },
    { id: 'current', startsAt: '2025-01-01T00:00:00.000Z', endsAt: null },
    { id: 'future', startsAt: '2027-01-01T00:00:00.000Z', endsAt: null },
  ];
  const now = Date.parse('2026-08-29T00:00:00.000Z');

  assert.deepEqual(
    filterExperiencesByTime(experiences, { includePast: false, now }).map(({ id }) => id),
    ['current', 'future'],
  );
  assert.deepEqual(
    filterExperiencesByTime(experiences, { includePast: true, now }).map(({ id }) => id),
    ['past', 'current', 'future'],
  );
});

test('AR proxy fetches only selected providers, keeps keys private, and caches viewport results', async () => {
  const upstreamCalls = [];
  const plugin = createArContentProxyPlugin({
    env: {
      MESHMAP_API_URL: 'https://api.meshmap.example',
      MESHMAP_API_KEY: 'mesh-secret',
      OSCP_INSTANCES_JSON: JSON.stringify([{
        id: 'city-lab',
        name: 'City Lab AR',
        baseUrl: 'https://oscp.city.example',
        apiKey: 'oscp-secret',
      }]),
      GEV_RATELIMIT_AR_PER_MIN: '0',
    },
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url: String(url), headers: options.headers });
      assert.equal(url.hostname, 'api.meshmap.example');
      assert.equal(options.headers['x-app-api-key'], 'mesh-secret');
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({
        pins: [{
          id: 'mesh-1',
          title: 'Map Portal',
          latitude: QUERY.lat,
          longitude: QUERY.lon,
          visibility: 'public',
          contentType: 'URL',
          contentUrl: 'https://play.meshmap.example/map-portal',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const handler = arProxyHandler(plugin);
  const query = {
    lat: String(QUERY.lat),
    lon: String(QUERY.lon),
    radiusM: String(QUERY.radiusM),
    providers: 'meshmap',
  };

  const [first, concurrent] = await Promise.all([
    invokeArProxy(handler, query),
    invokeArProxy(handler, query),
  ]);
  const cached = await invokeArProxy(handler, query);

  assert.equal(first.statusCode, 200);
  assert.equal(concurrent.statusCode, 200);
  assert.equal(cached.statusCode, 200);
  assert.equal(upstreamCalls.length, 1);
  assert.deepEqual(first.payload.experiences.map(({ providerId }) => providerId), ['meshmap']);
  assert.equal(first.payload.providers.find(({ id }) => id === 'oscp:city-lab').status, 'filtered');
  assert.doesNotMatch(first.body, /mesh-secret|oscp-secret/);
});

test('AR proxy exposes Geoverse effective radius when upstream coverage is limited', async () => {
  const requestedRadiusM = 10_000;
  const plugin = createArContentProxyPlugin({
    env: {
      GEOVERSE_API_URL: 'https://api.geoverse.example',
      GEOVERSE_WEB_URL: 'https://geoverse.example',
      GEV_RATELIMIT_AR_PER_MIN: '0',
    },
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('radiusM'), '5000');
      return new Response(JSON.stringify({ experiences: [] }), { status: 200 });
    },
  });
  const response = await invokeArProxy(arProxyHandler(plugin), {
    lat: String(QUERY.lat),
    lon: String(QUERY.lon),
    radiusM: String(requestedRadiusM),
    providers: 'geoverse',
  });

  const geoverse = response.payload.providers.find(({ id }) => id === 'geoverse');
  assert.equal(response.payload.query.radiusM, requestedRadiusM);
  assert.equal(geoverse.maxRadiusM, 5_000);
  assert.equal(geoverse.effectiveRadiusM, 5_000);
  assert.equal(geoverse.coverageLimited, true);
});

test('AR proxy cache keys use exact validated viewport values', async () => {
  const upstreamUrls = [];
  const plugin = createArContentProxyPlugin({
    env: {
      MESHMAP_API_URL: 'https://api.meshmap.example',
      GEV_RATELIMIT_AR_PER_MIN: '0',
    },
    fetchImpl: async (url) => {
      upstreamUrls.push(String(url));
      return new Response(JSON.stringify({ pins: [] }), { status: 200 });
    },
  });
  const handler = arProxyHandler(plugin);
  const base = {
    lat: '48.158662',
    lon: '11.580377',
    providers: 'meshmap',
  };

  await invokeArProxy(handler, { ...base, radiusM: '1500' });
  await invokeArProxy(handler, { ...base, radiusM: '1501' });
  await invokeArProxy(handler, { ...base, lat: '48.158663', radiusM: '1500' });
  await invokeArProxy(handler, { ...base, radiusM: '1500' });

  assert.equal(upstreamUrls.length, 3);
  assert.deepEqual(
    upstreamUrls.map((value) => new URL(value).searchParams.get('radius')),
    ['1500', '1501', '1500'],
  );
});

test('AR proxy serves stale cache on transient failure and expires it after fifteen minutes', async () => {
  let timestamp = 0;
  let upstreamCalls = 0;
  const plugin = createArContentProxyPlugin({
    env: {
      MESHMAP_API_URL: 'https://api.meshmap.example',
      GEV_RATELIMIT_AR_PER_MIN: '0',
    },
    now: () => timestamp,
    fetchImpl: async () => {
      upstreamCalls += 1;
      if (upstreamCalls > 1) throw new Error('temporary provider outage');
      return new Response(JSON.stringify({
        pins: [{
          id: 'cached-pin',
          title: 'Cached Portal',
          latitude: QUERY.lat,
          longitude: QUERY.lon,
          visibility: 'public',
        }],
      }), { status: 200 });
    },
  });
  const handler = arProxyHandler(plugin);
  const query = { ...QUERY, providers: 'meshmap' };

  const fresh = await invokeArProxy(handler, query);
  timestamp = 61_000;
  const stale = await invokeArProxy(handler, query);
  timestamp = (15 * 60_000) + 1;
  const expired = await invokeArProxy(handler, query);

  assert.equal(fresh.payload.providers.find(({ id }) => id === 'meshmap').status, 'ok');
  assert.deepEqual(stale.payload.experiences.map(({ id }) => id), ['cached-pin']);
  assert.equal(stale.payload.providers.find(({ id }) => id === 'meshmap').status, 'stale');
  assert.match(stale.payload.providers.find(({ id }) => id === 'meshmap').error, /temporary provider outage/);
  assert.deepEqual(expired.payload.experiences, []);
  assert.equal(expired.payload.providers.find(({ id }) => id === 'meshmap').status, 'error');
  assert.equal(upstreamCalls, 3);
});

test('AR proxy enforces the per-client request rate limit', async () => {
  const plugin = createArContentProxyPlugin({
    env: { GEV_RATELIMIT_AR_PER_MIN: '1' },
    now: () => 10_000,
  });
  const handler = arProxyHandler(plugin);
  const query = { ...QUERY, providers: 'none' };

  const first = await invokeArProxy(handler, query);
  const limited = await invokeArProxy(handler, query);

  assert.equal(first.statusCode, 200);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.payload.error, 'Rate limit exceeded');
  assert.equal(limited.headers.get('retry-after'), '5');
});

test('AR proxy fetches providers with at most four concurrent upstream requests', async () => {
  const instances = Array.from({ length: 7 }, (_, index) => ({
    id: `operator-${index}`,
    baseUrl: `https://oscp-${index}.example`,
  }));
  let active = 0;
  let maxActive = 0;
  const plugin = createArContentProxyPlugin({
    env: {
      OSCP_INSTANCES_JSON: JSON.stringify(instances),
      GEV_RATELIMIT_AR_PER_MIN: '0',
    },
    fetchImpl: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  const response = await invokeArProxy(arProxyHandler(plugin), {
    ...QUERY,
    providers: 'all',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(maxActive, 4);
  assert.equal(response.payload.providers.filter(({ protocol }) => protocol === 'oscp').length, 7);
});
