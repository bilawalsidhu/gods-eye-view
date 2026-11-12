import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ION_SERVER_MANAGED,
  ionRequestOptions,
  ionServerUrl,
  mapillaryGraphEndpoint,
} from './serverKeys.js';
import { createMapillarySource } from '../layers/streetLevel/providers/mapillary/source.js';

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
      assert.equal(
        mapillaryGraphEndpoint(),
        'https://app.gods-eye-view.invalid/api/mapillary/graph/',
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
      mapillaryGraphEndpoint(),
      'http://localhost:4173/api/mapillary/graph/',
    );
    assert.equal(
      createMapillarySource().graphEndpoint,
      'http://localhost:4173/api/mapillary/graph/',
    );
  });
});
