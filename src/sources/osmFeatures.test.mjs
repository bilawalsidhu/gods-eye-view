import test from 'node:test';
import assert from 'node:assert/strict';
import { createOsmFeatureSource } from './osmFeatures.js';

const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (typeof body === 'string') throw new SyntaxError('not JSON');
    return body;
  },
});

test('the request names only the preset, box, mode and limit', async () => {
  let asked = null;
  const search = createOsmFeatureSource({
    fetchImpl: async (url) => {
      asked = new URL(url, 'http://localhost');
      return respond(200, { features: [], count: 0 });
    },
  });
  const result = await search({
    preset: 'hospital',
    bbox: [85.2, 27.6, 85.4, 27.8],
    limit: 50,
  });
  assert.equal(result.ok, true);
  assert.equal(asked.pathname, '/api/osm/features');
  assert.equal(asked.searchParams.get('preset'), 'hospital');
  assert.equal(
    asked.searchParams.get('bbox'),
    '85.20000,27.60000,85.40000,27.80000',
  );
  assert.equal(asked.searchParams.get('mode'), 'features');
  assert.equal(asked.searchParams.get('limit'), '50');
});

test('an aborted search rethrows; a network failure is a refusal', async () => {
  const controller = new AbortController();
  const aborting = createOsmFeatureSource({
    fetchImpl: async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    },
  });
  await assert.rejects(
    aborting(
      { preset: 'hospital', bbox: [0, 0, 1, 1] },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  const offline = createOsmFeatureSource({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const refused = await offline({ preset: 'hospital', bbox: [0, 0, 1, 1] });
  assert.deepEqual([refused.ok, refused.status], [false, 0]);
});

test('server refusals keep their status and code', async () => {
  const notConfigured = createOsmFeatureSource({
    fetchImpl: async () =>
      respond(503, {
        error: 'Place search needs a configured Overpass server.',
        code: 'OVERPASS_NOT_CONFIGURED',
      }),
  });
  const refused = await notConfigured({
    preset: 'hospital',
    bbox: [0, 0, 1, 1],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 503);
  assert.equal(refused.code, 'OVERPASS_NOT_CONFIGURED');
  const busy = createOsmFeatureSource({
    fetchImpl: async () => respond(429, '<html>Too Many Requests</html>'),
  });
  const limited = await busy({ preset: 'hospital', bbox: [0, 0, 1, 1] });
  assert.equal(limited.ok, false);
  assert.equal(limited.status, 429);
  assert.equal(limited.code, null);
  assert.match(limited.error, /429/);
});

test('a success whose body is not JSON is a failure, not zero places', async () => {
  const garbled = createOsmFeatureSource({
    fetchImpl: async () => respond(200, '<html>proxy error</html>'),
  });
  const result = await garbled({ preset: 'hospital', bbox: [0, 0, 1, 1] });
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
});
