import { STATION_KINDS, UNFIT_REASONS } from './model.js';

/** Shared by the proxy (before it caches or serves) and the browser source. */
export const MAX_TICKS = 26;
export const MAX_STATIONS = 300;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SITE = /^[A-Z]{4}$/;

const reject = (what) => {
  throw new Error(`Malformed bird migration ${what}`);
};
const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (value) =>
  typeof value === 'string' &&
  ISO.test(value) &&
  new Date(value).toISOString() === value;
const inRange = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;
const isPair = (value, min, max) =>
  Array.isArray(value) &&
  value.length === 2 &&
  inRange(value[0], min, max) &&
  inRange(value[1], min, max) &&
  value[0] < value[1];

/** A five-minute-aligned UTC minute, the only form a scan time takes. */
export function isScanTime(value) {
  return isTime(value) && Date.parse(value) % 300_000 === 0;
}

function parseBounds(value) {
  if (
    !isObject(value) ||
    !inRange(value.west, -180, 180) ||
    !inRange(value.east, -180, 180) ||
    !inRange(value.south, -90, 90) ||
    !inRange(value.north, -90, 90) ||
    value.west >= value.east ||
    value.south >= value.north
  )
    reject('bounds');
  const { west, south, east, north } = value;
  return Object.freeze({ west, south, east, north });
}

export function parseManifest(wire) {
  if (!isObject(wire) || wire.schemaVersion !== 1) reject('manifest');
  if (wire.unavailable === true) {
    if (typeof wire.reason !== 'string' || wire.reason.length > 200)
      reject('manifest');
    return Object.freeze({ unavailable: true, reason: wire.reason });
  }
  const { ticks } = wire;
  if (
    !Array.isArray(ticks) ||
    ticks.length < 1 ||
    ticks.length > MAX_TICKS ||
    ticks.some(
      (tick, i) => !isScanTime(tick) || (i > 0 && tick <= ticks[i - 1]),
    )
  )
    reject('ticks');
  if (wire.latest !== ticks.at(-1)) reject('latest tick');
  if (typeof wire.stale !== 'boolean') reject('manifest');
  return Object.freeze({
    ticks: Object.freeze([...ticks]),
    latest: wire.latest,
    bounds: parseBounds(wire.bounds),
    stale: wire.stale,
  });
}

function parsePosition(value) {
  if (
    !isObject(value) ||
    !inRange(value.lat, -90, 90) ||
    !inRange(value.lon, -180, 180) ||
    !inRange(value.elevM, -500, 9000)
  )
    reject('station position');
  return Object.freeze({ lat: value.lat, lon: value.lon, elevM: value.elevM });
}

function parseFit(value) {
  if (
    !isObject(value) ||
    value.velocityProduct !== 'N0U' ||
    value.maskProduct !== 'N0C' ||
    !Number.isInteger(value.gateCount) ||
    value.gateCount < 1 ||
    !inRange(value.azimuthCoverageDeg, 0, 360) ||
    !inRange(value.residualMs, 0, 100) ||
    !isPair(value.annulusKm, 0, 500) ||
    !isPair(value.beamHeightM, 0, 30_000)
  )
    reject('tracked station without a complete fit');
  return Object.freeze({
    velocityProduct: 'N0U',
    maskProduct: 'N0C',
    gateCount: value.gateCount,
    azimuthCoverageDeg: value.azimuthCoverageDeg,
    residualMs: value.residualMs,
    annulusKm: Object.freeze([...value.annulusKm]),
    beamHeightM: Object.freeze([...value.beamHeightM]),
  });
}

function parseStation(value) {
  if (!isObject(value) || !STATION_KINDS.includes(value.kind))
    reject('station');
  const { kind } = value;
  if (typeof value.site !== 'string' || !SITE.test(value.site))
    reject('station site');
  if (kind !== 'tracked' && ('track' in value || 'fit' in value))
    reject(`${kind} station holding a direction`);
  const station = {
    kind,
    site: value.site,
    position: parsePosition(value.position),
  };
  if (kind === 'no-scan') {
    if ('scanTime' in value) reject('no-scan station with a scan');
    return Object.freeze(station);
  }
  if (!isTime(value.scanTime)) reject('station scan time');
  station.scanTime = value.scanTime;
  if (kind === 'tracked') {
    const { track } = value;
    if (
      !isObject(track) ||
      !Number.isFinite(track.towardDeg) ||
      track.towardDeg < 0 ||
      track.towardDeg >= 360 ||
      !inRange(track.speedMs, 0, 60)
    )
      reject('station track');
    station.fit = parseFit(value.fit);
    station.track = Object.freeze({
      towardDeg: track.towardDeg,
      speedMs: track.speedMs,
    });
  } else if (kind === 'precipitation') {
    if (!inRange(value.rainFraction, 0, 1)) reject('rain fraction');
    station.rainFraction = value.rainFraction;
  } else if (kind === 'unfit') {
    if (!UNFIT_REASONS.includes(value.reason)) reject('unfit reason');
    station.reason = value.reason;
  }
  return Object.freeze(station);
}

/**
 * `{ schemaVersion: 1, time, motion }` for the requested tick. A tracked
 * station missing its track or fit fails the whole document.
 * @returns {import('./model.js').Motion}
 */
export function parseMotion(wire, time) {
  if (!isObject(wire) || wire.schemaVersion !== 1 || wire.time !== time)
    reject('motion');
  const { motion } = wire;
  if (!isObject(motion)) reject('motion');
  if (motion.kind === 'pending') return Object.freeze({ kind: 'pending' });
  if (motion.kind === 'unavailable') {
    if (typeof motion.reason !== 'string' || motion.reason.length > 200)
      reject('motion');
    return Object.freeze({ kind: 'unavailable', reason: motion.reason });
  }
  if (motion.kind !== 'reduced') reject('motion');
  if (
    !isTime(motion.reducedAt) ||
    typeof motion.final !== 'boolean' ||
    !inRange(motion.sampleRadiusKm, 1, 300) ||
    !Array.isArray(motion.stations) ||
    motion.stations.length > MAX_STATIONS
  )
    reject('reduced motion');
  return Object.freeze({
    kind: 'reduced',
    reducedAt: motion.reducedAt,
    final: motion.final,
    sampleRadiusKm: motion.sampleRadiusKm,
    stations: Object.freeze(motion.stations.map(parseStation)),
  });
}
