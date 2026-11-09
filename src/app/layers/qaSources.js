// QA fixture sources (only with allowQaRegistration, i.e. the dev server):
// `?qaFeed=flights:synthetic:10000,vessels:fixture` replaces those layers'
// live sources with seeded synthetic answers (src/bench/w1Feeds.js) served
// through the live sources' own parsers, so the layers see the same snapshot
// shape. Times are relative to now, so the objects stay fresh.
//
//   flights:synthetic[:count]   OpenSky states, `count` aircraft (8 000)
//   military:synthetic[:count]  readsb rows, `count` aircraft (1 000); the
//                               first 25 are also synthetic civil flights
//   vessels:fixture             12 000 AIS rows, or those within an area
//   launches:fixture          three LL2 missions; also supplies the satellite dependency
//   satellites:fixture         839 core TLEs + 6000 dense points
//   local-adsb:fixture          the local receivers' answer (server format,
//                               /api/local-receivers/aircraft): 40 aircraft
//                               near JFK, 1090 MHz and 978 MHz UAT

import {
  createFlightSource,
  createMilitarySource,
  createVesselSource,
} from '../../sources/live/standalone.js';
import {
  syntheticFlights,
  syntheticLocalReceivers,
  syntheticMilitary,
  syntheticVessels,
} from '../../bench/w1Feeds.js';
import { launchFixture } from '../../bench/launchFixture.js';
import { createLaunchSource } from '../../layers/launches/source.js';
import { satelliteFixture } from '../../bench/satelliteFixture.js';
import { createSatelliteSource } from '../../layers/satellites/source.js';
import { createLocalReceiverFeeds } from '../../layers/localAdsb/feeds.js';

// The largest synthetic fleet used by the QA scenarios.
const MAX_QA_COUNT = 10_000;

const KINDS = Object.freeze({
  flights: new Set(['synthetic']),
  military: new Set(['synthetic']),
  vessels: new Set(['fixture']),
  satellites: new Set(['fixture']),
  launches: new Set(['fixture']),
  'local-adsb': new Set(['fixture']),
});

/** The qaFeed entries of a location search, or a TypeError. */
export function parseQaFeed(search = '') {
  const value = new URLSearchParams(search).get('qaFeed');
  if (!value) return [];
  return value.split(',').map((item) => {
    const [layer, kind, rawCount] = item.split(':');
    const count = rawCount === undefined ? null : Number(rawCount);
    if (
      !KINDS[layer]?.has(kind) ||
      (count !== null &&
        !(Number.isSafeInteger(count) && count > 0 && count <= MAX_QA_COUNT))
    )
      throw new TypeError(
        `qaFeed: unknown entry "${item}" (flights:synthetic[:count], military:synthetic[:count], vessels:fixture, satellites:fixture, launches:fixture, local-adsb:fixture)`,
      );
    return { layer, kind, count };
  });
}

const json = (payload) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Source overrides for createStandaloneLayerSources. */
export function createQaSources(entries, { now = () => Date.now() } = {}) {
  const sources = {};
  for (const { layer, count } of entries) {
    if (layer === 'launches') {
      sources.launches = createLaunchSource({
        fetchImpl: async (url) =>
          String(url).includes('/celestrak/')
            ? new Response(satelliteFixture('stations'))
            : json(launchFixture()),
      });
      sources.satellites ??= createSatelliteSource({
        fetchImpl: async (url) =>
          new Response(satelliteFixture(String(url).split('/').at(-1))),
      });
    }
    if (layer === 'satellites')
      sources.satellites = createSatelliteSource({
        fetchImpl: async (url) =>
          new Response(satelliteFixture(String(url).split('/').at(-1))),
      });
    if (layer === 'flights')
      sources.flights = createFlightSource({
        now,
        fetchImpl: async (url) => {
          const request = String(url);
          if (request.includes('/api/adsbdb/')) return json({ found: false });
          if (request.includes('/api/flights/track')) return json({ path: [] });
          return json(syntheticFlights({ nowMs: now(), count: count ?? 8000 }));
        },
      });
    if (layer === 'military')
      sources.military = createMilitarySource({
        now,
        fetchImpl: async (url) =>
          String(url).includes('/track')
            ? json({ timestamp: now() / 1000, trace: [] })
            : json(syntheticMilitary({ nowMs: now(), count: count ?? 1000 })),
      });
    if (layer === 'local-adsb')
      sources.localAdsbFeeds = createLocalReceiverFeeds({
        now,
        fetchImpl: async () => json(syntheticLocalReceivers({ nowMs: now() })),
      });
    if (layer === 'vessels')
      sources.vessels = createVesselSource({
        fetchImpl: async (url) => {
          if (String(url).includes('/api/vessels/track'))
            return json({ samples: [] });
          const params = new URL(url).searchParams;
          const area = params.has('lat')
            ? {
                lat: Number(params.get('lat')),
                lon: Number(params.get('lon')),
                radiusKm: Number(params.get('radius_km')),
              }
            : null;
          return json(syntheticVessels({ nowMs: now(), area }));
        },
      });
  }
  return sources;
}
