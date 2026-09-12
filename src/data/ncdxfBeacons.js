/**
 * NCDXF / IARU International Beacon Project (IBP) — static table and slot math.
 *
 * 18 CW beacons share five HF frequencies (14100 / 18110 / 21150 / 24930 /
 * 28200 kHz) in a 3-minute UTC-synchronised cycle of 18 × 10 s slots. In a
 * slot the beacon sends its callsign at 22 wpm (about 6 s) followed by four
 * one-second dashes at 100 W, 10 W, 1 W and 100 mW. On band index b (0..4)
 * at slot s the beacon with index (s − b + 18) % 18 transmits — i.e. each
 * beacon steps down through the bands in consecutive slots.
 *
 * Table copied from HamRig `dx.html` (`IBP_BEACONS`, owner-permitted); the
 * schedule is public at https://www.ncdxf.org/beacon/beaconschedule.html.
 * Browser-safe and pure; all time maths uses the UTC fields of the supplied
 * instant so it is drift-free and testable.
 */

import { bandColor } from './hamRadioShared.js';

export const IBP_BEACONS = Object.freeze([
  { call: '4U1UN', location: 'United Nations, New York', cc: 'us', grid: 'FN30as', lat: 40.75, lon: -73.97 },
  { call: 'VE8AT', location: 'Inuvik, Canada', cc: 'ca', grid: 'CP38gh', lat: 68.32, lon: -133.62 },
  { call: 'W6WX', location: 'Mt Umunhum, USA', cc: 'us', grid: 'CM97bd', lat: 37.15, lon: -121.90 },
  { call: 'KH6RS', location: 'Maui, Hawaii', cc: 'us', grid: 'BL10ts', lat: 20.72, lon: -156.42 },
  { call: 'ZL6B', location: 'Masterton, New Zealand', cc: 'nz', grid: 'RE78tw', lat: -41.05, lon: 175.60 },
  { call: 'VK6RBP', location: 'Rolystone, Australia', cc: 'au', grid: 'OF87av', lat: -32.11, lon: 116.05 },
  { call: 'JA2IGY', location: 'Mt Asama, Japan', cc: 'jp', grid: 'PM84jk', lat: 34.45, lon: 136.78 },
  { call: 'RR9O', location: 'Novosibirsk, Russia', cc: 'ru', grid: 'NO14kx', lat: 54.98, lon: 82.90 },
  { call: 'VR2B', location: 'Hong Kong', cc: 'hk', grid: 'OL72bg', lat: 22.27, lon: 114.15 },
  { call: '4S7B', location: 'Colombo, Sri Lanka', cc: 'lk', grid: 'MJ96wv', lat: 6.90, lon: 79.87 },
  { call: 'ZS6DN', location: 'Pretoria, South Africa', cc: 'za', grid: 'KG44dc', lat: -25.90, lon: 28.27 },
  { call: '5Z4B', location: 'Kilifi, Kenya', cc: 'ke', grid: 'KI88ks', lat: -3.63, lon: 39.85 },
  { call: '4X6TU', location: 'Tel Aviv, Israel', cc: 'il', grid: 'KM72jb', lat: 32.05, lon: 34.77 },
  { call: 'OH2B', location: 'Lohja, Finland', cc: 'fi', grid: 'KP20eh', lat: 60.32, lon: 24.37 },
  { call: 'CS3B', location: 'Madeira, Portugal', cc: 'pt', grid: 'IM12mr', lat: 32.72, lon: -16.82 },
  { call: 'LU4AA', location: 'Buenos Aires, Argentina', cc: 'ar', grid: 'GF05tj', lat: -34.62, lon: -58.42 },
  { call: 'OA4B', location: 'Lima, Peru', cc: 'pe', grid: 'FH17mw', lat: -12.08, lon: -77.05 },
  { call: 'YV5B', location: 'Caracas, Venezuela', cc: 've', grid: 'FJ69cc', lat: 10.50, lon: -66.92 },
].map((row) => Object.freeze(row)));

/** The five IBP frequencies in band order (index = band index b). */
export const IBP_BANDS = Object.freeze([
  { khz: 14100, band: '20m', color: bandColor('20m') },
  { khz: 18110, band: '17m', color: bandColor('17m') },
  { khz: 21150, band: '15m', color: bandColor('15m') },
  { khz: 24930, band: '12m', color: bandColor('12m') },
  { khz: 28200, band: '10m', color: bandColor('10m') },
].map((row) => Object.freeze(row)));

export const IBP_CYCLE_SECONDS = 180;
export const IBP_SLOT_SECONDS = 10;

/**
 * Beacons currently off the air (as of 2026-07, ncdxf.org/beacon/beaconschedule.html).
 * A live binding: `setIbpOffAir(list)` replaces it for every importer.
 */
export let IBP_OFF_AIR = Object.freeze(['YV5B']);

const BEACON_INDEX = new Map(IBP_BEACONS.map((row, index) => [row.call, index]));

function normalizeCall(call) {
  return String(call ?? '').trim().toUpperCase();
}

/** Replace the off-air list (callsigns, case-insensitive; unknown calls are dropped). */
export function setIbpOffAir(list) {
  const calls = (Array.isArray(list) ? list : [])
    .map(normalizeCall)
    .filter((call) => BEACON_INDEX.has(call));
  IBP_OFF_AIR = Object.freeze([...new Set(calls)]);
  return IBP_OFF_AIR;
}

/** Whether a beacon is listed as off the air. */
export function isIbpOffAir(call) {
  return IBP_OFF_AIR.includes(normalizeCall(call));
}

/** Beacon row by callsign (case-insensitive), or null. */
export function ibpBeacon(call) {
  const index = BEACON_INDEX.get(normalizeCall(call));
  return index === undefined ? null : IBP_BEACONS[index];
}

/** Index (0..17) of the beacon transmitting on band index `bandIndex` during `slot`. */
export function ibpBeaconIndexOnBand(slot, bandIndex) {
  return (((slot - bandIndex) % 18) + 18) % 18;
}

/** What a beacon is doing `secondsIntoSlot` seconds into its slot. */
export function ibpPowerStep(secondsIntoSlot) {
  const s = Number(secondsIntoSlot);
  if (!Number.isFinite(s) || s < 6) return 'call';
  if (s < 7) return '100W';
  if (s < 8) return '10W';
  if (s < 9) return '1W';
  return '100mW';
}

function cyclePosition(nowMs) {
  const ms = Number(nowMs);
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const wholeSeconds = (date.getUTCMinutes() % 3) * 60 + date.getUTCSeconds();
  const secondsIntoCycle = wholeSeconds + date.getUTCMilliseconds() / 1000;
  const slot = Math.floor(wholeSeconds / IBP_SLOT_SECONDS); // 0..17
  const secondsIntoSlot = secondsIntoCycle - slot * IBP_SLOT_SECONDS;
  return { slot, secondsIntoCycle, secondsIntoSlot };
}

/**
 * Current IBP slot and who is transmitting on each of the five bands.
 * `powerStep` is 'call' for the first 6 s, then '100W' / '10W' / '1W' / '100mW'
 * for the four one-second dashes.
 */
export function ibpSlot(nowMs = Date.now()) {
  const { slot, secondsIntoCycle, secondsIntoSlot } = cyclePosition(nowMs);
  const powerStep = ibpPowerStep(secondsIntoSlot);
  const byBand = IBP_BANDS.map((band, bandIndex) => {
    const index = ibpBeaconIndexOnBand(slot, bandIndex);
    const beacon = IBP_BEACONS[index];
    return {
      khz: band.khz,
      band: band.band,
      color: band.color,
      index,
      call: beacon.call,
      location: beacon.location,
      grid: beacon.grid,
      lat: beacon.lat,
      lon: beacon.lon,
      offAir: IBP_OFF_AIR.includes(beacon.call),
      powerStep,
    };
  });
  return {
    slot,
    secondsIntoSlot,
    secondsIntoCycle,
    secondsUntilNextSlot: IBP_SLOT_SECONDS - secondsIntoSlot,
    byBand,
  };
}

/**
 * When a beacon next starts on each band: `secondsUntil` is the time to the
 * start of its next slot on that band (0 when it starts right now; up to 180
 * when it has just started). `active` marks the band it is on at this instant.
 * Unknown callsigns → [].
 */
export function ibpScheduleFor(call, nowMs = Date.now()) {
  const index = BEACON_INDEX.get(normalizeCall(call));
  if (index === undefined) return [];
  const { slot, secondsIntoCycle } = cyclePosition(nowMs);
  return IBP_BANDS.map((band, bandIndex) => {
    const startSeconds = (index + bandIndex) * IBP_SLOT_SECONDS;
    const secondsUntil = ((startSeconds - secondsIntoCycle) % IBP_CYCLE_SECONDS + IBP_CYCLE_SECONDS) % IBP_CYCLE_SECONDS;
    return {
      khz: band.khz,
      band: band.band,
      secondsUntil,
      active: ibpBeaconIndexOnBand(slot, bandIndex) === index,
    };
  });
}
