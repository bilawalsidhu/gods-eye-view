import assert from 'node:assert/strict';
import test from 'node:test';
import { readBrowserConfig } from './browserConfig.js';

const built = {
  googleApiKey: 'build-google-example',
  cesiumToken: 'build-cesium-example',
  mapillaryToken: 'build-mapillary-example',
};

test('cancelled startup never starts a configuration request', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  assert.deepEqual(
    await readBrowserConfig(built, {
      signal: controller.signal,
      fetchImpl: async () => {
        fetched = true;
        return Response.json({});
      },
    }),
    built,
  );
  assert.equal(fetched, false);
});

test('runtime browser fields override build values without adopting other fields', async () => {
  let request;
  const config = await readBrowserConfig(built, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        googleMapsApiKey: 'runtime-google-example',
        cesiumIonToken: 'runtime-cesium-example',
        mapillaryClientToken: 'runtime-mapillary-example',
        serverApiKey: 'must-not-propagate',
        autoPlacesInstallationFallback: true,
      });
    },
  });
  assert.deepEqual(config, {
    googleApiKey: 'runtime-google-example',
    cesiumToken: 'runtime-cesium-example',
    mapillaryToken: 'runtime-mapillary-example',
  });
  assert.equal(request.url, '/api/runtime-config');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.redirect, 'error');
});

test('empty or invalid runtime fields retain the corresponding build value', async () => {
  assert.deepEqual(
    await readBrowserConfig(built, {
      fetchImpl: async () =>
        Response.json({
          googleMapsApiKey: '',
          cesiumIonToken: null,
          mapillaryClientToken: 123,
        }),
    }),
    built,
  );
});

test('static hosting, malformed responses and network refusal preserve startup fallback', async () => {
  for (const reply of [
    () => new Response('not found', { status: 404 }),
    () => new Response('<html>static fallback</html>'),
    () => Response.json(null),
    () => Response.json([]),
    () => {
      throw new Error('network refused');
    },
  ]) {
    assert.deepEqual(
      await readBrowserConfig(built, { fetchImpl: async () => reply() }),
      built,
    );
  }
  assert.deepEqual(
    await readBrowserConfig(
      {},
      {
        fetchImpl: async () => new Response('', { status: 404 }),
      },
    ),
    { googleApiKey: '', cesiumToken: '', mapillaryToken: '' },
  );
});

test('oversized configuration is refused before it can replace build values', async () => {
  assert.deepEqual(
    await readBrowserConfig(built, {
      fetchImpl: async () =>
        Response.json({ googleMapsApiKey: 'x'.repeat(20_000) }),
    }),
    built,
  );
});

test('startup deadline bounds transports and response bodies that ignore abort', async () => {
  let signal;
  assert.deepEqual(
    await readBrowserConfig(built, {
      timeoutMs: 10,
      fetchImpl: (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    }),
    built,
  );
  assert.equal(signal.aborted, true);
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  assert.deepEqual(
    await readBrowserConfig(built, {
      timeoutMs: 10,
      fetchImpl: async () => new Response(body),
    }),
    built,
  );
  assert.equal(cancelled, true);
});
