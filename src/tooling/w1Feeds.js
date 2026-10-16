// The W1 baseline's synthetic recordings (scripts/qa-w1-baseline
// --synthesize): the seeded answers of src/bench/w1Feeds.js as replayable
// recordings, all at one frozen instant.

import {
  W1_FROZEN_MS,
  syntheticFlights,
  syntheticLocalReceivers,
  syntheticVessels,
} from '../bench/w1Feeds.js';

export {
  W1_FROZEN_MS,
  syntheticFlights,
  syntheticLocalReceivers,
  syntheticVessels,
};

const entry = (key, payload) => ({
  key,
  path: key.split(' ')[1].split('?')[0],
  status: 200,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(payload)).toString('base64'),
  atMs: W1_FROZEN_MS,
});

/** qa-w1-baseline recordings (DIR/<layer>.json) for flights, vessels and local ADS-B. */
export function syntheticRecordings(nowMs = W1_FROZEN_MS) {
  const recording = (layer, entries) => ({
    layer,
    synthetic: true,
    frozenMs: nowMs,
    entries,
  });
  return {
    flights: recording('flights', [
      entry('GET /api/flights', syntheticFlights({ nowMs })),
    ]),
    vessels: recording('vessels', [
      entry(
        'GET /api/vessels?maxRows=12000&lat=40.65724&lon=-73.78000&radius_km=10.0',
        syntheticVessels({
          nowMs,
          area: { lat: 40.65724, lon: -73.78, radiusKm: 10 },
        }),
      ),
      // Last: the answer for any other area too (the replay's fallback).
      entry('GET /api/vessels?maxRows=12000', syntheticVessels({ nowMs })),
    ]),
    localAdsb: recording('localAdsb', [
      entry(
        'GET /api/local-receivers/aircraft',
        syntheticLocalReceivers({ nowMs }),
      ),
    ]),
  };
}
