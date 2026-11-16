import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATION_LIST_URL,
  ZONES_URL,
  loadVigicruesCatalog,
  loadVigicruesZones,
} from './vigicrues.js';

/** A JSON upstream response. */
function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

/** A redirect response with a Location header. */
function redirectResponse(status, location) {
  return new Response(null, { status, headers: { Location: location } });
}

test('the station catalogue follows the operator\'s same-origin 302', async () => {
  // The operator serves /services/observations.json as a 302 to
  // /services/observations.json/index.php, which answers 200. Treating the
  // 302 as a fatal upstream error is what made the route answer 502.
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === STATION_LIST_URL)
      return redirectResponse(302, '/services/observations.json/index.php');
    return jsonResponse({
      NbElements: 1,
      Observations: {
        ListeStation: [{ CdStationHydro: '1234', DtObsHydro: 1700000000000 }],
      },
    });
  };
  const catalog = await loadVigicruesCatalog(fetchImpl, undefined);
  assert.deepEqual(catalog.ids, ['1234'], 'the catalogue is read after the hop');
  assert.equal(catalog.total, 1);
  assert.deepEqual(
    seen,
    [STATION_LIST_URL, 'https://www.vigicrues.gouv.fr/services/observations.json/index.php'],
    'the redirect is followed by hand, on the same origin',
  );
});

test('a cross-origin redirect is refused, not followed', async () => {
  // The allow-list is the contract: an upstream that bounced the proxy at a
  // third party would turn it into a suggestion. This is the SSRF guard.
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return redirectResponse(302, 'https://evil.test/observations.json');
  };
  await assert.rejects(
    loadVigicruesCatalog(fetchImpl, undefined),
    /upstream redirect refused \(cross-origin\)/,
    'a cross-origin hop is refused',
  );
  assert.deepEqual(seen, [STATION_LIST_URL], 'the third party is never fetched');
});

test('a redirect without a Location header is refused', async () => {
  const fetchImpl = async () => redirectResponse(302, '');
  await assert.rejects(
    loadVigicruesCatalog(fetchImpl, undefined),
    /upstream redirect refused \(missing-location\)/,
  );
});

test('a redirect to http is refused (no scheme downgrade)', async () => {
  const fetchImpl = async () =>
    redirectResponse(302, 'http://www.vigicrues.gouv.fr/services/x');
  await assert.rejects(
    loadVigicruesCatalog(fetchImpl, undefined),
    /upstream redirect refused \(not-https\)/,
  );
});

test('a redirect chain longer than the limit is refused', async () => {
  let hops = 0;
  const fetchImpl = async () => {
    hops += 1;
    return redirectResponse(302, `/services/hop-${hops}.json`);
  };
  await assert.rejects(
    loadVigicruesCatalog(fetchImpl, undefined),
    /upstream redirected too many times/,
  );
});

test('the zone route still reads a plain 200 with no hop', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return jsonResponse({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { id: 'z1', lbentcru: 'Zone 1', CdTCC: '75' },
          geometry: { type: 'Polygon', coordinates: [] },
        },
      ],
    });
  };
  const zones = await loadVigicruesZones(fetchImpl, undefined);
  assert.equal(zones.count, 1);
  assert.equal(zones.zones[0].id, 'z1');
  assert.deepEqual(seen, [ZONES_URL], 'a direct 200 is fetched once');
});

test('the zone route follows a same-origin hop too', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === ZONES_URL)
      return redirectResponse(302, '/services/InfoVigiCru.geojson/index.php');
    return jsonResponse({ type: 'FeatureCollection', features: [] });
  };
  const zones = await loadVigicruesZones(fetchImpl, undefined);
  assert.equal(zones.count, 0);
  assert.equal(seen.length, 2, 'the hop is followed');
});
