// apiEndpoints parity tests — the consolidation contract from PLAN.md Batch 4:
// every concrete route the app can call is declared here exactly once, and
// every declared route exists in BOTH runtimes (dev middleware mount from
// vite/proxies/* and a Pages Function under functions/api/**). This is the
// test that would have caught the terrain-heights / route prod 404s.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { api, apiEndpoints } from './apiEndpoints.js';
import createViteConfig from '../../vite.config.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Dummy args good enough for every builder — only the path shape matters. */
const BUILDER_CALLS = [
  ['opensky', () => api.opensky()],
  ['openskyTrack', () => api.openskyTrack('abc123')],
  ['adsbdbType', () => api.adsbdbType('ABC123')],
  ['adsbdbRoute', () => api.adsbdbRoute('UAL 214')],
  ['adsblol', () => api.adsblol()],
  ['adsblolMil', () => api.adsblolMil()],
  ['adsblolTrace', () => api.adsblolTrace('a1b2c3')],
  ['aisLive', () => api.aisLive()],
  ['aisLiveTrack', () => api.aisLiveTrack('123456')],
  ['celestrak', () => api.celestrak('active')],
  ['rocketLaunches', () => api.rocketLaunches()],
  ['firms', () => api.firms()],
  ['weatherEffects', () => api.weatherEffects('lat=30.27')],
  ['tomtomStatus', () => api.tomtomStatus()],
  ['tomtomFlowTile', () => api.tomtomFlowTile(12, 345, 678)],
  ['gbfs', () => api.gbfs('https://gbfs.lyft.com/feed.json')],
  ['overpass', () => api.overpass()],
  ['route', () => api.route('foot', '-0.12,51.5;-0.13,51.51')],
  ['terrainHeights', () => api.terrainHeights('-0.12,51.5;-0.13,51.51')],
  ['regionalBrief', () => api.regionalBrief('latitude=30.27&longitude=-97.74')],
  ['googleTextSearch', () => api.googleTextSearch('q=fort')],
  ['googleNearbyPlaces', () => api.googleNearbyPlaces('q=fort')],
  ['militaryInstallations', () => api.militaryInstallations('south=1&west=2')],
  ['openzenithReverseGeocode', () => api.openzenithReverseGeocode('30.27', '-97.74')],
  ['cctvSources', () => api.cctvSources()],
  ['cctvHealth', () => api.cctvHealth()],
  ['cctvFrame', () => api.cctvFrame('austin/42', '?ts=99')],
  ['cctvMedia', () => api.cctvMedia('austin/42')],
  ['radioStations', () => api.radioStations()],
  ['radioClick', () => api.radioClick('some-uuid')],
  ['realtimeToken', () => api.realtimeToken()],
  ['realtimeDebugLog', () => api.realtimeDebugLog()],
  ['hudSummary', () => api.hudSummary()],
  ['analytics', () => api.analytics()],
];

/** Second path segment after /api — the routing bucket both runtimes key on. */
function routePrefix(url) {
  const pathname = new URL(url, 'https://unit.test').pathname;
  assert.ok(pathname.startsWith('/api/'), `route must live under /api: ${url}`);
  return pathname.split('/')[2];
}

function inventoryEntries() {
  const byPrefix = new Map();
  for (const [name, call] of BUILDER_CALLS) {
    const url = call();
    const prefix = routePrefix(url);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
    byPrefix.get(prefix).add(name);
  }
  for (const [name, base] of Object.entries(apiEndpoints)) {
    const prefix = routePrefix(base);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
    byPrefix.get(prefix).add(`base:${name}`);
  }
  return byPrefix;
}

/** Routes the dev server actually mounts, straight from vite.config.js. */
function devMounts() {
  const config = createViteConfig({ mode: 'test' });
  const mounts = [];
  const fakeServer = {
    middlewares: {
      use: (route) => {
        if (typeof route === 'string') mounts.push(route);
      },
    },
    httpServer: { on() {}, off() {} },
  };
  for (const plugin of config.plugins.flat(Infinity)) {
    // Our proxy factories all self-identify ('…-proxy', 'track-backfill-proxies');
    // everything else in the array (e.g. vite-plugin-pwa) is not an API mount.
    if (plugin && /(proxy|proxies)/.test(String(plugin.name)) && typeof plugin.configureServer === 'function') {
      plugin.configureServer(fakeServer);
    }
  }
  return mounts;
}

/** Route buckets served by Pages Functions on the static deployment. */
function pagesFunctionPrefixes() {
  const apiDir = `${REPO_ROOT}/functions/api`;
  const prefixes = new Set();
  for (const entry of readdirSync(apiDir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue; // _lib.js, _upstream.js — shared modules, not routes
    if (entry.isFile()) {
      if (/\.(js|ts)$/.test(entry.name) && !entry.name.includes('.test.')) {
        prefixes.add(entry.name.replace(/\.(js|ts)$/, ''));
      }
      continue;
    }
    if (entry.isDirectory()) prefixes.add(entry.name); // flat + [[path]] handlers alike
  }
  return prefixes;
}

test('every builder emits the exact byte-for-byte URL its call site used to compose', () => {
  const expected = {
    opensky: '/api/opensky',
    openskyTrack: '/api/opensky-track?icao24=abc123',
    adsbdbType: '/api/adsbdb/type/abc123',
    adsbdbRoute: '/api/adsbdb/route/UAL%20214',
    adsblol: '/api/adsblol',
    adsblolMil: '/api/adsblol/mil',
    adsblolTrace: '/api/adsblol/trace?hex=a1b2c3',
    aisLive: '/api/ais-live',
    aisLiveTrack: '/api/ais-live/track?mmsi=123456',
    celestrak: '/api/celestrak/active',
    rocketLaunches: '/api/launches',
    firms: '/api/firms',
    weatherEffects: '/api/weather-effects?lat=30.27',
    tomtomStatus: '/api/tomtom/status',
    tomtomFlowTile: '/api/tomtom/flow/12/345/678.pbf',
    gbfs: '/api/gbfs/https%3A%2F%2Fgbfs.lyft.com%2Ffeed.json',
    overpass: '/api/overpass',
    route: '/api/route?profile=foot&coords=-0.12%2C51.5%3B-0.13%2C51.51',
    terrainHeights: '/api/terrain/heights?points=-0.12%2C51.5%3B-0.13%2C51.51',
    regionalBrief: '/api/regional-brief?latitude=30.27&longitude=-97.74',
    googleTextSearch: '/api/google/text-search?q=fort',
    googleNearbyPlaces: '/api/google/nearby-places?q=fort',
    militaryInstallations: '/api/military-installations?south=1&west=2',
    openzenithReverseGeocode: '/api/openzenith/reverse-geocode?lat=30.27&lon=-97.74',
    cctvSources: '/api/cctv/sources',
    cctvHealth: '/api/cctv/health',
    cctvFrame: '/api/cctv/frame/austin%2F42?ts=99',
    cctvMedia: '/api/cctv/media/austin%2F42',
    radioStations: '/api/radio/stations',
    radioClick: '/api/radio/click/some-uuid',
    realtimeToken: '/api/realtime/token',
    realtimeDebugLog: '/api/realtime/debug-log',
    hudSummary: '/api/openai/hud-summary',
    analytics: '/api/analytics',
  };
  for (const [name, call] of BUILDER_CALLS) {
    assert.equal(call(), expected[name], `builder ${name} drifted from its client contract`);
  }
});

test('base roots keep their exact production paths', () => {
  assert.equal(apiEndpoints.opensky, '/api/opensky');
  assert.equal(apiEndpoints.openskyTrack, '/api/opensky-track');
  assert.equal(apiEndpoints.adsbdb, '/api/adsbdb');
  assert.equal(apiEndpoints.celestrak, '/api/celestrak');
  assert.equal(apiEndpoints.aisLive, '/api/ais-live');
  assert.equal(apiEndpoints.firms, '/api/firms');
  assert.equal(apiEndpoints.tomtom, '/api/tomtom');
  assert.equal(apiEndpoints.cctv, '/api/cctv');
  assert.equal(apiEndpoints.overpass, '/api/overpass');
  assert.equal(apiEndpoints.gbfs, '/api/gbfs');
  assert.equal(apiEndpoints.terrain, '/api/terrain');
  assert.equal(apiEndpoints.radio, '/api/radio');
  assert.equal(apiEndpoints.rocketLaunches, '/api/launches');
  assert.equal(apiEndpoints.militaryInstallations, '/api/military-installations');
  assert.equal(apiEndpoints.regionalBrief, '/api/regional-brief');
  assert.equal(Object.getPrototypeOf(apiEndpoints), Object.prototype, 'no surprise prototype');
});

test('every inventory route is served by BOTH the dev middleware and a Pages Function', () => {
  const inventory = inventoryEntries();
  const mounts = new Set(devMounts().map(routePrefix));
  const functions = pagesFunctionPrefixes();

  for (const [prefix, builders] of inventory) {
    assert.ok(mounts.has(prefix), `route /api/${prefix} (${[...builders].join(', ')}) has no dev middleware mount`);
    assert.ok(functions.has(prefix), `route /api/${prefix} (${[...builders].join(', ')}) has no Pages Function — prod 404`);
  }
});

test('every dev middleware mount is declared in the inventory', () => {
  const inventory = inventoryEntries();
  for (const mount of devMounts()) {
    const prefix = routePrefix(mount);
    assert.ok(
      inventory.has(prefix),
      `dev middleware mounts /api/${prefix} but no client builder declares it`,
    );
  }
});

test('every Pages Function route is declared in the inventory', () => {
  const inventory = inventoryEntries();
  for (const prefix of pagesFunctionPrefixes()) {
    assert.ok(
      inventory.has(prefix),
      `functions/api serves /api/${prefix} but no client builder declares it`,
    );
  }
});

test('the removed dead /api/weather route is gone from inventory, dev, and Pages', () => {
  assert.ok(!('weather' in apiEndpoints), 'weather base root removed');
  assert.ok(!BUILDER_CALLS.some(([name]) => name === 'weather'));
  assert.equal(pagesFunctionPrefixes().has('weather'), false, 'functions/api/weather must stay deleted');
  assert.ok(!devMounts().includes('/api/weather'));
});
