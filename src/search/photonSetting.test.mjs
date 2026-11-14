// PHOTON_URL: unset keeps the public default, empty disables, else a URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultPlaceSearch } from './defaults.js';

async function hosts(endpoints) {
  const asked = [];
  const search = createDefaultPlaceSearch({
    endpoints,
    fetchImpl: async (url) => {
      asked.push(new URL(String(url), 'http://local.test').host);
      return new Response(
        JSON.stringify({ features: [], status: 'ZERO_RESULTS', results: [] }),
        { status: 200 },
      );
    },
  });
  await search.geocode('nowhere-photon-setting');
  return asked;
}

test('place search follows the Photon setting', async () => {
  assert.ok(
    (await hosts({})).includes('photon.komoot.io'),
    'default is public Photon',
  );
  const own = await hosts({ photon: 'https://photon.example.test/api/' });
  assert.ok(own.includes('photon.example.test'));
  assert.ok(!own.includes('photon.komoot.io'));
  const off = await hosts({ photon: null });
  assert.ok(!off.some((host) => host.includes('photon')), off.join(','));
});

test('the last-resort route is skipped when the server reports Nominatim unconfigured', async () => {
  const run = async (configured) => {
    const asked = [];
    const search = createDefaultPlaceSearch({
      endpoints: { photon: null },
      fetchImpl: async (url) => {
        const path = new URL(String(url), 'http://local.test').pathname;
        asked.push(path);
        if (path === '/api/geocode/status')
          return Response.json({ configured });
        return Response.json({ status: 'ZERO_RESULTS', results: [] });
      },
    });
    await search.geocode(`nowhere-nominatim-${configured}`);
    return asked;
  };
  const off = await run(false);
  assert.ok(off.includes('/api/geocode/status'));
  assert.ok(!off.includes('/api/geocode'), off.join(','));
  const on = await run(true);
  assert.ok(on.includes('/api/geocode'), on.join(','));
});

test('a search cancelled while the Nominatim probe is pending starts no last-resort request', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const asked = [];
  const controller = new AbortController();
  const search = createDefaultPlaceSearch({
    endpoints: { photon: null },
    fetchImpl: async (url) => {
      const path = new URL(String(url), 'http://local.test').pathname;
      asked.push(path);
      if (path === '/api/geocode/status') {
        controller.abort();
        await held;
        return Response.json({ configured: true });
      }
      return Response.json({ status: 'ZERO_RESULTS', results: [] });
    },
  });
  const pending = search.geocode('nowhere-cancelled', {
    signal: controller.signal,
  });
  release();
  await pending.catch(() => null);
  assert.ok(!asked.includes('/api/geocode'), asked.join(','));
});
