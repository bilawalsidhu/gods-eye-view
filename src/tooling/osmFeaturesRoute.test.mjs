// THE BOUNDED OSM FEATURE SEARCH — `/api/osm/features`.
//
// A request names a curated preset, a box, a mode and a limit; the server
// writes the Overpass query and sends it only to an operator-configured
// Overpass (OVERPASS_UPSTREAMS). These cases pin what can never reach Overpass:
// unknown kinds, raw tags, oversized boxes, boundary-area scans, and a second
// upstream query while one is running. The generic `/api/overpass` guard is
// covered by its own tests and is not loosened here.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  compileOsmFeatureQuery,
  OSM_FEATURE_LIMITS,
  summarizeOsmFeatures,
} from '../../server/providers/overpass/osmFeatures.js';
import { installOsmFeaturesRoute } from '../../server/providers/overpass/osmFeaturesRoute.js';
import { sanitizeOverpassBody } from '../../server/providers/overpass/query.js';

test('a preset and a small box compile to a bounded query', () => {
  const compiled = compileOsmFeatureQuery({
    preset: 'hospital',
    bbox: '85.2,27.6,85.4,27.8',
    limit: '50',
  });
  assert.equal(compiled.ok, true);
  assert.equal(
    compiled.ql,
    '[out:json][timeout:25][maxsize:67108864];(nwr["amenity"="hospital"](27.6,85.2,27.8,85.4););out center tags 50;',
  );
  assert.doesNotMatch(compiled.ql, /area/, 'no boundary-area scan');
  const count = compileOsmFeatureQuery({
    preset: 'bar',
    bbox: [80, 20, 85, 25],
    mode: 'count',
  });
  assert.match(
    count.ql,
    /nwr\["amenity"="bar"\].*nwr\["amenity"="pub"\].*out count;$/,
  );
});

test('unknown kinds, raw tags, bad and oversized boxes are refused', () => {
  assert.equal(
    compileOsmFeatureQuery({ preset: 'amenity=hospital', bbox: '0,0,1,1' })
      .code,
    'UNKNOWN_PRESET',
  );
  assert.equal(
    compileOsmFeatureQuery({ preset: '__proto__', bbox: '0,0,1,1' }).code,
    'UNKNOWN_PRESET',
  );
  assert.equal(
    compileOsmFeatureQuery({ preset: 'hospital', bbox: '0,0,1' }).code,
    'BAD_BOX',
  );
  assert.equal(
    compileOsmFeatureQuery({ preset: 'hospital', bbox: '0,1,1,0' }).code,
    'BAD_BOX',
  );
  assert.equal(
    compileOsmFeatureQuery({ preset: 'hospital', bbox: '0,0,3,3' }).code,
    'AREA_TOO_LARGE',
  );
  assert.equal(
    compileOsmFeatureQuery({
      preset: 'hospital',
      bbox: '0,0,3,3',
      mode: 'count',
    }).ok,
    true,
  );
  assert.equal(
    compileOsmFeatureQuery({
      preset: 'hospital',
      bbox: '0,0,7,7',
      mode: 'count',
    }).code,
    'AREA_TOO_LARGE',
  );
  const limited = compileOsmFeatureQuery({
    preset: 'hospital',
    bbox: '0,0,1,1',
    limit: 999999,
  });
  assert.match(
    limited.ql,
    new RegExp(`out center tags ${OSM_FEATURE_LIMITS.maxLimit};$`),
  );
});

test('a box across the antimeridian is searched as its two halves', () => {
  const compiled = compileOsmFeatureQuery({
    preset: 'hospital',
    bbox: '179.5,-17,-179.5,-16',
  });
  assert.equal(compiled.ok, true);
  assert.match(compiled.ql, /\(-17,179\.5,-16,180\).*\(-17,-180,-16,-179\.5\)/);
});

test('the generic Overpass guard still refuses boundary-area element scans', () => {
  const scan =
    'data=' +
    encodeURIComponent(
      '[out:json];area(3600000001)->.a;nwr["amenity"="hospital"](area.a);out;',
    );
  assert.equal(sanitizeOverpassBody(scan).ok, false);
});

test('answers are compacted: centres, kept tags, truncation and counts', () => {
  const compiled = compileOsmFeatureQuery({
    preset: 'hospital',
    bbox: '0,0,1,1',
    limit: 2,
  });
  const features = summarizeOsmFeatures(
    {
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 0.5,
          lon: 0.5,
          tags: { name: 'A', amenity: 'hospital', 'contact:phone': 'x' },
        },
        {
          type: 'way',
          id: 2,
          center: { lat: 0.4, lon: 0.4 },
          tags: { name: 'B', amenity: 'hospital' },
        },
      ],
    },
    compiled,
  );
  assert.equal(features.count, 2);
  assert.equal(features.truncated, true, 'the limit was reached');
  assert.deepEqual(features.features[1], {
    id: 'way/2',
    lat: 0.4,
    lon: 0.4,
    tags: { name: 'B', amenity: 'hospital' },
  });
  assert.equal('contact:phone' in features.features[0].tags, false);
  const count = summarizeOsmFeatures(
    {
      elements: [
        {
          type: 'count',
          tags: { nodes: '3', ways: '2', relations: '0', total: '5' },
        },
      ],
    },
    { ...compiled, mode: 'count' },
  );
  assert.equal(count.count, 5);
});

function mount(fetchPayload, { featuresCache, configured = () => true } = {}) {
  const routes = new Map();
  const writes = [];
  const memoryCache = () => {
    const held = new Map();
    return {
      get: async (key) => held.get(key),
      set: async (key, value) => {
        held.set(key, value);
        writes.push(key);
      },
    };
  };
  installOsmFeaturesRoute(
    { use: (route, handler) => routes.set(route, handler) },
    {
      fetchPayload,
      cacheRoot: null,
      configured,
      featuresCache: featuresCache || memoryCache(),
    },
  );
  let client = 0;
  const start = (search, route = '/api/osm/features') => {
    let req;
    let res;
    const promise = new Promise((resolve) => {
      client += 1;
      req = Object.assign(new EventEmitter(), {
        method: 'GET',
        url: `/?${search}`,
        headers: {},
        socket: { remoteAddress: `10.9.0.${client}` },
      });
      res = Object.assign(new EventEmitter(), {
        writableEnded: false,
        writeHead(status, headers) {
          res.status = status;
          res.headers = headers;
        },
        end(body) {
          res.writableEnded = true;
          resolve({
            status: res.status,
            headers: res.headers,
            body: JSON.parse(body),
          });
        },
      });
      routes.get(route)(req, res);
    });
    return {
      promise,
      disconnect() {
        res.emit('close');
      },
    };
  };
  const request = (search, route = '/api/osm/features') =>
    start(search, route).promise;
  return { request, start, writes };
}

test('the route answers, caches, and runs one upstream query at a time', async () => {
  let release;
  let upstream = 0;
  const { request, writes } = mount(async (body) => {
    upstream += 1;
    assert.match(decodeURIComponent(body), /^data=\[out:json\]/);
    await new Promise((r) => {
      release = r;
    });
    return {
      status: 200,
      body: JSON.stringify({
        elements: [{ type: 'node', id: 7, lat: 1, lon: 1, tags: {} }],
      }),
    };
  });
  const first = request('preset=hospital&bbox=0,0,2,2');
  await new Promise((r) => setTimeout(r, 5));
  const other = await request('preset=school&bbox=0,0,2,2');
  assert.equal(other.status, 503, 'a second, different search waits its turn');
  release();
  const answered = await first;
  assert.equal(answered.status, 200);
  assert.equal(answered.body.count, 1);
  const again = await request('preset=hospital&bbox=0,0,2,2');
  assert.equal(again.headers['X-OSM-Cache'], 'HIT');
  assert.equal(upstream, 1);
  assert.equal(writes.length, 1);
  const refused = await request('preset=hospital&bbox=0,0,9,9');
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'AREA_TOO_LARGE');
});

test('an upstream refusal is not an empty answer', async () => {
  const { request } = mount(async () => ({
    status: 429,
    body: 'rate_limited',
    rateLimited: true,
  }));
  const answer = await request('preset=hospital&bbox=0,0,1,1');
  assert.equal(answer.status, 429);
  assert.ok(answer.body.error);
});

test('malformed successful answers are refused and never cached', async () => {
  const payloads = [
    {},
    { elements: [{ type: 'count', tags: { nodes: '2' } }] },
    { elements: [{ type: 'way', id: 9, tags: { amenity: 'hospital' } }] },
  ];
  const { request, writes } = mount(async () => ({
    status: 200,
    body: JSON.stringify(payloads.shift()),
  }));
  const missingElements = await request('preset=hospital&bbox=0,0,1,1');
  const missingTotal = await request('preset=hospital&bbox=0,0,1,1&mode=count');
  const unusableRows = await request('preset=hospital&bbox=1,1,2,2');
  for (const answer of [missingElements, missingTotal, unusableRows]) {
    assert.equal(answer.status, 502);
    assert.match(answer.body.error, /failed/i);
  }
  assert.deepEqual(writes, []);
});

test('the last disconnected waiter aborts upstream work and frees the slot', async () => {
  let calls = 0;
  let firstStarted;
  let firstAborted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const aborted = new Promise((resolve) => {
    firstAborted = resolve;
  });
  const { request, start } = mount(async (_body, _cap, { signal }) => {
    calls += 1;
    if (calls === 1) {
      firstStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            firstAborted();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
    return { status: 200, body: '{"elements":[]}' };
  });
  const abandoned = start('preset=hospital&bbox=0,0,1,1');
  await started;
  abandoned.disconnect();
  await aborted;
  await new Promise((resolve) => setImmediate(resolve));
  const next = await request('preset=school&bbox=0,0,1,1');
  assert.equal(next.status, 200);
  assert.equal(calls, 2);
});

test('one disconnected coalesced waiter does not cancel a live sibling', async () => {
  let release;
  let upstreamSignal;
  let calls = 0;
  const { start } = mount(async (_body, _cap, { signal }) => {
    calls += 1;
    upstreamSignal = signal;
    await new Promise((resolve) => {
      release = resolve;
    });
    return { status: 200, body: '{"elements":[]}' };
  });
  const first = start('preset=hospital&bbox=0,0,1,1');
  await new Promise((resolve) => setImmediate(resolve));
  const second = start('preset=hospital&bbox=0,0,1,1');
  await new Promise((resolve) => setImmediate(resolve));
  first.disconnect();
  assert.equal(upstreamSignal.aborted, false);
  release();
  const answer = await second.promise;
  assert.equal(answer.status, 200);
  assert.equal(calls, 1);
});

test('without a configured Overpass the route refuses and fetches nothing', async () => {
  let upstream = 0;
  const { request } = mount(
    async () => {
      upstream += 1;
      return { status: 200, body: '{"elements":[]}' };
    },
    { configured: () => false },
  );
  const answer = await request('preset=hospital&bbox=85.2,27.6,85.4,27.8');
  assert.equal(answer.status, 503);
  assert.equal(answer.body.code, 'OVERPASS_NOT_CONFIGURED');
  assert.equal(answer.body.retryable, false);
  assert.match(answer.body.error, /configured Overpass/);
  assert.equal(upstream, 0);
});
