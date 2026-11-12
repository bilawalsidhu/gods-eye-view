import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ION_SERVER_MANAGED,
  fetchIonCredential,
  fetchMapillaryConfigured,
  fetchServerKeyStatus,
  ionRequestOptions,
  ionServerUrl,
} from './serverKeys.js';
import { createMapillarySource } from '../layers/streetLevel/providers/mapillary/source.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Run `body` as a page whose own address is `href` and which may name the app's. */
async function asPage({ href, appBaseUrl }, body) {
  const saved = {
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    app: Object.getOwnPropertyDescriptor(globalThis, 'GEV_APP_BASE_URL'),
  };
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href },
  });
  if (appBaseUrl === undefined) delete globalThis.GEV_APP_BASE_URL;
  else globalThis.GEV_APP_BASE_URL = appBaseUrl;
  try {
    return await body();
  } finally {
    if (saved.location)
      Object.defineProperty(globalThis, 'location', saved.location);
    else delete globalThis.location;
    if (saved.app)
      Object.defineProperty(globalThis, 'GEV_APP_BASE_URL', saved.app);
    else delete globalThis.GEV_APP_BASE_URL;
  }
}

test('in the panel the ion and Graph addresses follow the app address the panel names, not the host page', async () => {
  // A host may serve the panel page from an address that cannot be a base
  // (`about:srcdoc`, `blob:`, `data:`); the panel answers the app's paths
  // itself, under GEV_APP_BASE_URL.
  await asPage(
    {
      href: 'about:srcdoc',
      appBaseUrl: 'https://app.gods-eye-view.invalid/',
    },
    () => {
      assert.equal(
        ionServerUrl(),
        'https://app.gods-eye-view.invalid/api/ion/',
      );
      assert.deepEqual(ionRequestOptions(ION_SERVER_MANAGED), {
        accessToken: '',
        server: 'https://app.gods-eye-view.invalid/api/ion/',
      });
      assert.equal(
        createMapillarySource().graphEndpoint,
        'https://app.gods-eye-view.invalid/api/mapillary/graph/',
      );
    },
  );
});

test('outside the panel the addresses follow the page', async () => {
  await asPage({ href: 'http://localhost:4173/#v=2' }, () => {
    assert.equal(ionServerUrl(), 'http://localhost:4173/api/ion/');
    assert.equal(
      createMapillarySource().graphEndpoint,
      'http://localhost:4173/api/mapillary/graph/',
    );
  });
});

test('ion: a server that cannot answer leaves the keyless map stacks, whatever the failure', async () => {
  const answers = {
    'no ion route (404)': async () => json({ error: 'Not found' }, 404),
    'refused (403)': async () => json({ error: 'refused' }, 403),
    'no key (503)': async () =>
      json({ error: 'no_key', keyRequired: true }, 503),
    'not configured': async () => json({ configured: false }),
    'a page instead of JSON': async () =>
      new Response('<!doctype html>', { status: 200 }),
    'the panel could not reach the server': async () => {
      throw new Error('The app’s server did not answer');
    },
  };
  for (const [label, fetchImpl] of Object.entries(answers))
    assert.equal(await fetchIonCredential(fetchImpl), '', label);
});

test('ion: a status request that never comes back is given up, so the app still starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = fetchIonCredential(
    (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
    { timeoutMs: 5_000 },
  );
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  assert.equal(await pending, '');
  assert.equal(signal.aborted, true, 'the request itself is cancelled too');
});

test('ion: an answer that comes in time is used', async () => {
  assert.equal(
    await fetchIonCredential(async () => json({ configured: true }), {
      timeoutMs: 5_000,
    }),
    ION_SERVER_MANAGED,
  );
});

test('mapillary: a server that cannot answer reads as not configured, whatever the failure', async () => {
  const answers = {
    'no Mapillary route (404)': async () => json({ error: 'Not found' }, 404),
    'refused (403)': async () => json({ error: 'refused' }, 403),
    'no key (503)': async () =>
      json({ error: 'no_key', keyRequired: true }, 503),
    'not configured': async () => json({ configured: false }),
    'configured is not a boolean': async () => json({ configured: 'yes' }),
    'a page instead of JSON': async () =>
      new Response('<!doctype html>', { status: 200 }),
    'the panel could not reach the server': async () => {
      throw new Error('The app’s server did not answer');
    },
  };
  for (const [label, fetchImpl] of Object.entries(answers))
    assert.equal(await fetchMapillaryConfigured(fetchImpl), false, label);
});

test('mapillary: the answer is only the boolean, from the status route, uncached', async () => {
  const calls = [];
  const configured = await fetchMapillaryConfigured(async (url, init) => {
    calls.push({ url, init });
    return json({ configured: true, token: 'MLY|must-not-matter' });
  });
  assert.equal(configured, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/mapillary/status');
  assert.equal(calls[0].init.cache, 'no-store');
});

test('mapillary: a status request that never comes back is given up and cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = fetchMapillaryConfigured(
    (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
    { timeoutMs: 5_000 },
  );
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true, 'the request itself is cancelled too');
});

test('mapillary: in the panel the request goes through the page fetch and degrades to not configured', async () => {
  await asPage(
    { href: 'about:srcdoc', appBaseUrl: 'https://app.gods-eye-view.invalid/' },
    async () => {
      // The page's fetch (patched by the panel) resolves the app's paths; a
      // bare `fetch` on an about:srcdoc page would reject a relative URL.
      const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      const seen = [];
      globalThis.fetch = async (url) => {
        seen.push(String(url));
        if (String(url).endsWith('/ion/status'))
          return json({ configured: false });
        throw new TypeError('Failed to parse URL from /api/mapillary/status');
      };
      try {
        assert.deepEqual(await fetchServerKeyStatus(), {
          cesiumToken: '',
          mapillaryConfigured: false,
        });
        assert.deepEqual(seen.sort(), [
          '/api/ion/status',
          '/api/mapillary/status',
        ]);
      } finally {
        if (saved) Object.defineProperty(globalThis, 'fetch', saved);
        else delete globalThis.fetch;
      }
    },
  );
});

test('the ion and Mapillary status requests go out together, so startup waits for the slower one only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const open = {};
  const pending = fetchServerKeyStatus(
    (url) => {
      asked.push(url);
      return new Promise((resolve) => (open[url] = resolve));
    },
    { timeoutMs: 15_000 },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(asked.sort(), ['/api/ion/status', '/api/mapillary/status']);
  open['/api/mapillary/status'](json({ configured: true }));
  open['/api/ion/status'](json({ configured: true }));
  assert.deepEqual(await pending, {
    cesiumToken: ION_SERVER_MANAGED,
    mapillaryConfigured: true,
  });
});

test('one status request that hangs does not hold the other back past the bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = fetchServerKeyStatus(
    (url) =>
      url === '/api/ion/status'
        ? new Promise(() => {})
        : Promise.resolve(json({ configured: true })),
    { timeoutMs: 15_000 },
  );
  // Let the answered request finish reading its body (setImmediate is not
  // mocked) before the bound passes.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  assert.deepEqual(await pending, {
    cesiumToken: '',
    mapillaryConfigured: true,
  });
});
