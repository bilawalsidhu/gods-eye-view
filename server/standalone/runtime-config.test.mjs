import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeConfigPlugin } from './runtime-config.js';

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook} exposes only the three browser fields with uncached JSON`, () => {
    const env = {
      GOOGLE_MAPS_API_KEY: 'public-google-example',
      CESIUM_ION_TOKEN: 'public-cesium-example',
      MAPILLARY_CLIENT_TOKEN: 'public-mapillary-example',
      GOOGLE_MAPS_SERVER_API_KEY: 'private-server-example',
      OPENAI_API_KEY: 'private-model-example',
      GEV_PUBLIC_ORIGIN: 'https://example.test',
    };
    let handler;
    runtimeConfigPlugin({ env })[hook]({
      middlewares: {
        use(path, fn) {
          assert.equal(path, '/api/runtime-config');
          handler = fn;
        },
      },
    });
    let status, headers, body;
    const response = {
      writeHead(s, h) {
        status = s;
        headers = h;
      },
      end(value) {
        body = JSON.parse(value);
      },
    };
    handler({ method: 'GET', url: '/' }, response, () =>
      assert.fail('unexpected fallthrough'),
    );
    assert.equal(status, 200);
    assert.deepEqual(body, {
      googleMapsApiKey: env.GOOGLE_MAPS_API_KEY,
      cesiumIonToken: env.CESIUM_ION_TOKEN,
      mapillaryClientToken: env.MAPILLARY_CLIENT_TOKEN,
    });
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.match(headers['Content-Type'], /^application\/json/);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    handler({ method: 'POST', url: '/' }, response);
    assert.equal(status, 405);
    let fellThrough = false;
    handler({ method: 'GET', url: '/other' }, response, () => {
      fellThrough = true;
    });
    assert.equal(fellThrough, true);
  });
}

test('keyless endpoint uses empty values rather than serializing the environment', () => {
  let handler;
  runtimeConfigPlugin({ env: {} }).configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  handler(
    { method: 'GET', url: '/' },
    {
      writeHead() {},
      end(body) {
        assert.deepEqual(JSON.parse(body), {
          googleMapsApiKey: '',
          cesiumIonToken: '',
          mapillaryClientToken: '',
        });
      },
    },
  );
});
