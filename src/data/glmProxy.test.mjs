import test from 'node:test';
import assert from 'node:assert/strict';
import { glmProxy } from '../../server/providers/glm.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}
const key =
  'GLM-L2-LCFA/2026/257/12/OR_GLM-L2-LCFA_G19_s20262571200000_e20262571200200_c20262571200212.nc';
test('GLM routes manifest, status, and not found', async () => {
  const request = install(
    glmProxy({
      now: () => Date.UTC(2026, 8, 14, 12),
      listObjectsImpl: async () => ({ keys: [{ key }] }),
      fetchObjectBufferImpl: async () => Buffer.from('x'),
      parseGranuleImpl: async () => ({ flashes: [] }),
    }),
  );
  const manifest = JSON.parse((await request('/')).body);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.sources.length, 2);
  assert.ok(Array.isArray(manifest.flashes));
  assert.equal(manifest.totalCount, 0);
  assert.equal(manifest.returnedCount, 0);
  assert.equal(manifest.truncated, false);
  assert.equal(typeof manifest.coverageComplete, 'boolean');
  const status = JSON.parse((await request('/status')).body);
  assert.equal('flashes' in status, false);
  const missing = await request('/nope');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'not_found' });
});
