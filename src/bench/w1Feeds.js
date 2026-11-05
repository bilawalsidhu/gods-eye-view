// Seeded synthetic feed answers: the global /api/flights snapshot (OpenSky
// states), the /api/military snapshot (readsb rows), 12 000 AIS vessels on /api/vessels (with and without an area) and
// the local receivers' 1090 MHz and 978 MHz UAT aircraft near JFK, timed
// relative to one instant, so every run sees the same objects at the same
// places. Pure: Node and browser, no I/O. Used by the app's QA fixture
// sources (src/app/layers/qaSources.js).

import { createSyntheticFlights } from './syntheticFlights.js';

/** The replay clock of the synthetic recordings: 2026-10-16T12:00:00Z. */
export const W1_FROZEN_MS = Date.UTC(2026, 9, 16, 12);
const JFK = { lat: 40.64, lng: -73.78 };

/** Small deterministic PRNG (as syntheticFlights). */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (value, digits) => value.toString(16).padStart(digits, '0');

/** An OpenSky states payload: `count` aircraft, 2 000 of them near JFK. */
export function syntheticFlights({
  nowMs = W1_FROZEN_MS,
  count = 8_000,
  seed = 11,
} = {}) {
  const fleet = createSyntheticFlights({
    count,
    seed,
    near: { ...JFK, radiusM: 60_000, count: Math.min(2_000, count) },
  });
  const random = mulberry32(seed + 1);
  const nowSec = Math.floor(nowMs / 1000);
  const states = [];
  for (let index = 0; index < count; index++) {
    const age = Math.floor(random() * 10);
    states.push([
      hex(0xa00000 + index, 6),
      `GEV${String(index).padStart(4, '0')}`,
      'United States',
      nowSec - age,
      nowSec - Math.min(age, 2),
      Number(fleet.lon[index].toFixed(5)),
      Number(fleet.lat[index].toFixed(5)),
      Math.round(fleet.alt[index]),
      false,
      Number(fleet.speed[index].toFixed(1)),
      Number(fleet.heading[index].toFixed(1)),
      0,
      null,
      Math.round(fleet.alt[index]) + 30,
      null,
      false,
      0,
      index % 7 === 0 ? 1 : 3,
    ]);
  }
  return { time: nowSec, states };
}

const PORTS = [
  { lat: 40.6, lon: -74.02, spread: 0.25 }, // New York harbour
  { lat: 51.95, lon: 4.1, spread: 0.4 }, // Rotterdam
  { lat: 29.7, lon: -95.0, spread: 0.3 }, // Houston
  { lat: 1.26, lon: 103.8, spread: 0.4 }, // Singapore
];

function allVessels(nowMs, seed) {
  const random = mulberry32(seed);
  const nowSec = Math.floor(nowMs / 1000);
  const rows = [];
  for (let index = 0; index < 12_000; index++) {
    const port = index < 4_000 ? PORTS[index % PORTS.length] : null;
    const lat = port
      ? port.lat + (random() - 0.5) * port.spread
      : random() * 120 - 60;
    const lon = port
      ? port.lon + (random() - 0.5) * port.spread * 1.5
      : random() * 360 - 180;
    rows.push({
      mmsi: String(200_000_000 + index),
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      name: `GEV VESSEL ${index}`,
      imo: '',
      type: ['Cargo', 'Tanker', 'Passenger', 'Fishing', 'Tug'][index % 5],
      destination: '',
      speed: Number((random() * 18).toFixed(1)),
      course: Math.round(random() * 360),
      heading: Math.round(random() * 360),
      last_position_epoch: nowSec - Math.floor(random() * 120),
    });
  }
  return rows;
}

const kmBetween = (a, b) => {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/** The /api/vessels answer: 12 000 rows, or those within `area`. */
export function syntheticVessels({
  nowMs = W1_FROZEN_MS,
  seed = 21,
  area = null,
} = {}) {
  let rows = allVessels(nowMs, seed);
  if (area) rows = rows.filter((row) => kmBetween(area, row) <= area.radiusKm);
  return { rows, newestPositionAt: nowMs };
}

// Military types across the weight classes (data/aircraftClass): heavies,
// fast jets, helicopters, tankers, patrol.
const MILITARY_TYPES = [
  ['C17', 'RCH'],
  ['F16', 'VIPER'],
  ['KC135', 'PACK'],
  ['H60', 'DUSTY'],
  ['C130', 'HERKY'],
  ['P8', 'PELCN'],
  ['E3TF', 'SENTRY'],
  ['MQ9', 'REAPER'],
];

/**
 * The /api/military answer (readsb rows): `count` aircraft, 150 of them near
 * JFK (12 on the ground there), the rest worldwide. The first `overlap`
 * hexes are also civil synthetic flights (a00000…), which the flights layer
 * leaves to this layer while it is on (duplicate suppression).
 */
export function syntheticMilitary({
  nowMs = W1_FROZEN_MS,
  count = 1_000,
  seed = 41,
  overlap = 25,
} = {}) {
  const random = mulberry32(seed);
  const near = Math.min(150, count);
  const ac = [];
  for (let index = 0; index < count; index++) {
    const [type, call] = MILITARY_TYPES[index % MILITARY_TYPES.length];
    const nearJfk = index < near;
    const grounded = nearJfk && index % 12 === 5;
    const lat = nearJfk
      ? JFK.lat + (random() - 0.5) * (grounded ? 0.01 : 1.0)
      : random() * 140 - 70;
    const lon = nearJfk
      ? JFK.lng + (random() - 0.5) * (grounded ? 0.01 : 1.3)
      : random() * 360 - 180;
    ac.push({
      hex:
        index < overlap ? hex(0xa00000 + index, 6) : hex(0xae1000 + index, 6),
      type: 'adsb_icao',
      flight: `${call}${String(index % 100).padStart(2, '0')}`.padEnd(8),
      r: `${10_000 + index}`,
      t: type,
      alt_baro: grounded ? 'ground' : Math.round(2_000 + random() * 33_000),
      gs: grounded
        ? Math.round(random() * 12)
        : Math.round(160 + random() * 330),
      track: Math.round(random() * 3600) / 10,
      baro_rate: 0,
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      seen_pos: Number((random() * 2).toFixed(1)),
      seen: 0,
    });
  }
  return { ac, now: nowMs / 1000, total: ac.length, msg: 'No error' };
}

/** The /api/local-receivers/aircraft answer: 1090 MHz and 978 MHz UAT aircraft. */
export function syntheticLocalReceivers({
  nowMs = W1_FROZEN_MS,
  seed = 31,
} = {}) {
  const random = mulberry32(seed);
  const records = [];
  for (let index = 0; index < 40; index++) {
    const uat = index % 4 === 0;
    records.push({
      icao: hex(0xad0000 + index, 6),
      callsign: `LCL${index}`,
      lat: Number((JFK.lat + (random() - 0.5) * 0.8).toFixed(5)),
      lon: Number((JFK.lng + (random() - 0.5) * 1.0).toFixed(5)),
      altitudeFt: Math.round(1_000 + random() * 20_000),
      groundSpeedKt: Math.round(80 + random() * 300),
      trackDeg: Math.round(random() * 360),
      verticalRateFpm: 0,
      onGround: false,
      category: uat ? 'A1' : 'A3',
      lastPositionAt: nowMs - Math.floor(random() * 2_000),
      lastMessageAt: nowMs - Math.floor(random() * 500),
      messageCount: 50,
      band: uat ? '978' : '1090',
      source: 'feed',
    });
  }
  return {
    configured: true,
    generatedAt: nowMs,
    feeds: [
      // i18n-ignore: synthetic provider data
      { band: '1090', label: '1090 MHz', status: 'live', aircraft: 30 },
      // i18n-ignore: synthetic provider data
      { band: '978', label: '978 MHz UAT', status: 'live', aircraft: 10 },
    ],
    records,
  };
}
