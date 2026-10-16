// QA fixture sources (only with allowQaRegistration, i.e. the dev server):
// `?qaFeed=flights:synthetic:10000,vessels:fixture` replaces those layers'
// live sources with seeded synthetic answers (src/bench/w1Feeds.js) served
// through the live sources' own parsers, so the layers see the same snapshot
// shape. Times are relative to now, so the objects stay fresh.
//
//   flights:synthetic[:count]   OpenSky states, `count` aircraft (8 000)
//   vessels:fixture             12 000 AIS rows, or those within an area

import {
  createFlightSource,
  createVesselSource,
} from '../../sources/live/standalone.js';
import { syntheticFlights, syntheticVessels } from '../../bench/w1Feeds.js';

const KINDS = Object.freeze({
  flights: new Set(['synthetic']),
  vessels: new Set(['fixture']),
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
        `qaFeed: unknown entry "${item}" (flights:synthetic[:count], vessels:fixture)`,
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
