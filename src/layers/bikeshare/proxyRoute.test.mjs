// BIKESHARE PROXY ROUTE — the client's URL against the real mounted middleware.
//
// The station source and the GBFS proxy are unit-tested apart, each against a
// stand-in for the other, so a disagreement about the request shape stayed
// invisible while the layer was dark. These cases run the URL the client
// actually produces through the middleware the dev server actually mounts, with
// only the upstream network call replaced, and assert the two documents join
// into a station record with availability counts.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gbfsProxy } from '../../../server/providers/gbfs.js';
import { localProviderPlugins } from '../../../server/providers/local.js';
import { createBikeshareSource } from './source.js';
import { createModel } from './model.js';
import { CITY_BY_ID } from './registry.js';

const AUSTIN = CITY_BY_ID.get('austin-capmetro');

const STATION_INFORMATION = {
  data: {
    stations: [
      {
        station_id: '2537',
        name: 'Republic Square',
        lat: 30.2681,
        lon: -97.7469,
        capacity: 13,
      },
    ],
  },
};

const STATION_STATUS = {
  data: {
    stations: [
      {
        station_id: '2537',
        num_bikes_available: 4,
        num_docks_available: 9,
        is_renting: 1,
        is_returning: 1,
      },
    ],
  },
};

/**
 * Mount the GBFS proxy the way the dev server does and return a fetch-shaped
 * entry point for it.
 *
 * `server.middlewares.use(route, handler)` is connect: it matches a request
 * whose path starts with the mount route, then strips that prefix from
 * `req.url` before the handler sees it. The handler therefore never reads
 * `/api/gbfs/...`, only the remainder — which is exactly the detail the client
 * and the proxy disagreed about. Reproducing the strip here is what makes this
 * a round trip rather than two more isolated stubs.
 *
 * @returns {(input: string, init?: object) => Promise<Response>}
 */
function mountGbfsProxy(
  install = (server) => gbfsProxy().configureServer(server),
) {
  const routes = new Map();
  install({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });

  return async function mountedFetch(input, init = {}) {
    const requested = new URL(String(input), 'http://localhost');
    let matched = null;
    for (const [route, handler] of routes) {
      if (
        requested.pathname !== route &&
        !requested.pathname.startsWith(route + '/')
      )
        continue;
      matched = { route, handler };
      break;
    }
    if (!matched) return new Response('no route', { status: 404 });

    // connect: the mount prefix is removed and a leading slash restored.
    let rest =
      requested.pathname.slice(matched.route.length) + requested.search;
    if (rest[0] !== '/') rest = '/' + rest;

    const req = { method: init.method || 'GET', url: rest, headers: {} };
    return await new Promise((resolve, reject) => {
      let status = 200;
      let headers = {};
      const res = {
        writeHead(code, sent) {
          status = code;
          headers = sent || {};
          return res;
        },
        end(body = '') {
          resolve(new Response(String(body), { status, headers }));
        },
      };
      Promise.resolve(matched.handler(req, res)).catch(reject);
    });
  };
}

/** Replace the global fetch used by the proxy's upstream step for one call. */
async function withUpstream(byUrl, run) {
  const previous = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    requested.push(href);
    const body = byUrl[href];
    if (!body) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    return await run(requested);
  } finally {
    globalThis.fetch = previous;
  }
}

test('the station source reaches the mounted proxy and both documents join into a station record', async () => {
  const upstreamByUrl = {
    [AUSTIN.stationInformationUrl]: STATION_INFORMATION,
    [AUSTIN.stationStatusUrl]: STATION_STATUS,
  };

  const { info, status, requested } = await withUpstream(
    upstreamByUrl,
    async (requested) => {
      const source = createBikeshareSource({
        fetchImpl: mountGbfsProxy(),
      });
      const info = await source.getStations(AUSTIN.stationInformationUrl);
      const status = await source.getStations(AUSTIN.stationStatusUrl);
      return { info, status, requested };
    },
  );

  assert.deepEqual(
    requested,
    [AUSTIN.stationInformationUrl, AUSTIN.stationStatusUrl],
    'the proxy reached the upstream the client asked for, unchanged',
  );

  const model = createModel({});
  const infoMap = model.parseStationInformation(info);
  const statusMap = model.parseStationStatus(status);
  const station = infoMap.get('2537');
  const availability = statusMap.get('2537');
  assert.ok(station, 'station information survived the round trip');
  assert.ok(availability, 'station status survived the round trip');

  assert.deepEqual(
    {
      stationId: station.stationId,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      capacity: station.capacity,
      bikesAvailable: availability.bikesAvailable,
      docksAvailable: availability.docksAvailable,
      isRenting: availability.isRenting,
    },
    {
      stationId: '2537',
      name: 'Republic Square',
      lat: 30.2681,
      lon: -97.7469,
      capacity: 13,
      bikesAvailable: 4,
      docksAvailable: 9,
      isRenting: true,
    },
  );
});

test('the proxy relays its cache policy and upstream host through the mounted route', async () => {
  await withUpstream(
    { [AUSTIN.stationStatusUrl]: STATION_STATUS },
    async () => {
      const mounted = mountGbfsProxy();
      const response = await mounted(
        '/api/gbfs/' + encodeURIComponent(AUSTIN.stationStatusUrl),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(
        response.headers.get('x-gbfs-upstream'),
        'austin.publicbikesystem.net',
      );
    },
  );
});

test('the query-string shape the client used to send is refused by the mounted route', async () => {
  await withUpstream(
    { [AUSTIN.stationStatusUrl]: STATION_STATUS },
    async (requested) => {
      const mounted = mountGbfsProxy();
      const response = await mounted(
        '/api/gbfs?url=' + encodeURIComponent(AUSTIN.stationStatusUrl),
      );
      assert.equal(
        response.status,
        400,
        'the old client URL is the 400 every city reported',
      );
      assert.deepEqual(requested, [], 'no upstream request is made for it');
    },
  );
});

test('the mounted route still refuses a host outside the allowlist', async () => {
  await withUpstream({}, async (requested) => {
    const mounted = mountGbfsProxy();
    const response = await mounted(
      '/api/gbfs/' +
        encodeURIComponent('https://attacker.example/station_status.json'),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(requested, []);
  });
});

/**
 * The GBFS plugin as the application actually composes it.
 *
 * Mounting `gbfsProxy()` directly proves the handler agrees with the client,
 * but not that the application still registers it. These take the plugin out
 * of the real provider list by name, so dropping GBFS from the composition —
 * or from the preview half of it — fails here rather than in a browser.
 */
function composedGbfsPlugin() {
  const plugin = localProviderPlugins().find(
    (entry) => entry.name === 'gbfs-proxy',
  );
  assert.ok(plugin, 'the application must compose a GBFS provider');
  return plugin;
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`the composed application serves the client's GBFS URL through ${hook}`, async () => {
    const plugin = composedGbfsPlugin();
    assert.equal(
      typeof plugin[hook],
      'function',
      `the composed GBFS provider must register on ${hook}`,
    );

    const { info, status, requested } = await withUpstream(
      {
        [AUSTIN.stationInformationUrl]: STATION_INFORMATION,
        [AUSTIN.stationStatusUrl]: STATION_STATUS,
      },
      async (requested) => {
        const source = createBikeshareSource({
          fetchImpl: mountGbfsProxy((server) => plugin[hook](server)),
        });
        const info = await source.getStations(AUSTIN.stationInformationUrl);
        const status = await source.getStations(AUSTIN.stationStatusUrl);
        return { info, status, requested };
      },
    );

    assert.deepEqual(requested, [
      AUSTIN.stationInformationUrl,
      AUSTIN.stationStatusUrl,
    ]);

    const model = createModel({});
    const station = model.parseStationInformation(info).get('2537');
    const availability = model.parseStationStatus(status).get('2537');
    assert.deepEqual(
      {
        name: station?.name,
        capacity: station?.capacity,
        bikesAvailable: availability?.bikesAvailable,
        docksAvailable: availability?.docksAvailable,
      },
      {
        name: 'Republic Square',
        capacity: 13,
        bikesAvailable: 4,
        docksAvailable: 9,
      },
    );
  });
}
