import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolsHandler } from '../../server/serverless/tools-route.js';
import { toolIndex, toolCatalogue } from '../../server/tools/registry.js';

function invoke(handler, url, method = 'GET') {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      end: (body) => resolve({ status: res.statusCode, headers, body: body ? JSON.parse(body) : null }),
    };
    handler({ url, method, on() {} }, res);
  });
}

const fakeIndex = new Map([
  [
    'echo_point',
    {
      name: 'echo_point',
      summary: 'Echo a point',
      params: {
        lat: { type: 'number', required: true, min: -90, max: 90 },
        lon: { type: 'number', required: true, min: -180, max: 180 },
      },
      cacheSeconds: 30,
      handler: async (params) => ({ ok: true, data: { point: [params.lat, params.lon] }, provider: { status: 'live', source: 'test' } }),
    },
  ],
  [
    'broken',
    { name: 'broken', params: {}, handler: async () => ({ ok: false, status: 503, error: { code: 'not_configured', message: 'X_KEY not set' } }) },
  ],
]);

test('/api/tools returns the catalogue and invokes a tool with validated params', async () => {
  const handler = createToolsHandler({ index: fakeIndex });
  const catalogue = await invoke(handler, '/');
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.body.ok, true);
  const ok = await invoke(handler, '/echo_point?lat=30.27&lon=-97.74');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data, { point: [30.27, -97.74] });
  assert.equal(ok.body.provider.status, 'live');
  assert.match(ok.headers['cache-control'], /s-maxage=30/);
  const unknownParam = await invoke(handler, '/echo_point?lat=1&lon=2&bogus=1');
  assert.equal(unknownParam.status, 400);
  assert.equal(unknownParam.body.error.code, 'unknown_param');
  const missing = await invoke(handler, '/echo_point?lat=1');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'missing_param');
  const unknownTool = await invoke(handler, '/nope');
  assert.equal(unknownTool.status, 404);
  assert.equal(unknownTool.body.error.code, 'unknown_tool');
  const failed = await invoke(handler, '/broken');
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, 'not_configured');
  const method = await invoke(handler, '/echo_point?lat=1&lon=2', 'POST');
  assert.equal(method.status, 405);
});

test('the real registry has unique tool names and a serialisable catalogue', () => {
  const index = toolIndex();
  assert.ok(index instanceof Map);
  const catalogue = toolCatalogue();
  assert.ok(Array.isArray(catalogue));
  for (const plugin of catalogue) {
    assert.ok(plugin.id && plugin.name);
    for (const tool of plugin.tools) assert.match(tool.path, /^\/api\/tools\/[a-z0-9_]+$/);
  }
  JSON.stringify(catalogue);
});
