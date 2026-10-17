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
import { createLocalReceiverFeeds } from '../../layers/localAdsb/feeds.js';

const KINDS = Object.freeze({
  flights: new Set(['synthetic']),
  military: new Set(['synthetic']),
  vessels: new Set(['fixture']),
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
      (count !== null && !(Number.isInteger(count) && count > 0))
    )
      throw new TypeError(
        `qaFeed: unknown entry "${item}" (flights:synthetic[:count], military:synthetic[:count], vessels:fixture, local-adsb:fixture)`,
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
    if (layer === 'flights')
      sources.flights = createFlightSource({
        now,
        fetchImpl: async () =>
          json(syntheticFlights({ nowMs: now(), count: count ?? 8000 })),
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
