import { bearingBetweenCoordinates } from '../../cockpitMath.js';
import { projectPoint } from '../../data/cctvFootprint.js';
import { greatCircleKm } from '../../data/routePlausible.js';
import {
  HORIZON_ANTENNA_EPSILON_M,
  HORIZON_BANDS,
  HORIZON_BIN_DEG,
  HORIZON_FIX_BUFFER,
  HORIZON_GAP_DEG,
  HORIZON_MAX_RANGE_KM,
  HORIZON_MIN_BINS,
  HORIZON_OUTLINE_STEP_DEG,
} from './policy.js';

/**
 * Index of the altitude band a barometric altitude falls in (lower bound
 * inclusive), or -1 when the altitude is unknown.
 * @param {number|null} altitudeFt
 * @param {ReadonlyArray<object>} [bands]
 * @returns {number}
 */
export function horizonBandIndex(altitudeFt, bands = HORIZON_BANDS) {
  if (!Number.isFinite(altitudeFt)) return -1;
  return bands.findIndex(
    (band) => altitudeFt >= band.minFt && altitudeFt < band.maxFt,
  );
}

/**
 * A usable antenna position, or null. `0, 0` is how decoders write an unset
 * location, so it is refused.
 * @param {{lat:number, lon:number}|null|undefined} position
 * @returns {{lat:number, lon:number}|null}
 */
export function validAntennaPosition(position) {
  const lat = finiteNumber(position?.lat);
  const lon = finiteNumber(position?.lon);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function horizonFix(fix) {
  if (fix?.onGround === true) return null;
  const lat = finiteNumber(fix?.lat);
  const lon = finiteNumber(fix?.lon);
  const altitudeFt = finiteNumber(fix?.altitudeFt);
  if (lat === null || lon === null || altitudeFt === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    lat,
    lon,
    altitudeFt,
    at: finiteNumber(fix.at),
    icao: typeof fix.icao === 'string' ? fix.icao : null,
  };
}

/**
 * Split one band's heard directions into outline runs.
 *
 * Neighbouring directions join while they are at most `gapDeg` apart; a wider
 * unheard sector breaks the outline instead of bridging it, so an open side
 * of the shell means "nothing heard that way yet". A run that goes all the
 * way round is `closed`. Runs of a single direction cannot draw and are left
 * out; a band with fewer than `minBins` directions draws nothing.
 * @param {Array<object|null>} bins Farthest fix per direction, by bin index.
 * @param {object} [options]
 * @returns {Array<{closed:boolean, points:object[]}>}
 */
export function horizonArcs(
  bins,
  {
    binDeg = HORIZON_BIN_DEG,
    gapDeg = HORIZON_GAP_DEG,
    minBins = HORIZON_MIN_BINS,
  } = {},
) {
  const present = [];
  bins.forEach((bin, index) => {
    if (bin) present.push(index);
  });
  if (present.length < Math.max(2, minBins)) return [];
  const gapBins = gapDeg / binDeg;
  const breaks = [];
  for (let k = 1; k < present.length; k += 1)
    if (present[k] - present[k - 1] > gapBins) breaks.push(k);
  const wraps = present[0] + bins.length - present.at(-1) <= gapBins;
  if (wraps && !breaks.length)
    return [{ closed: true, points: present.map((index) => bins[index]) }];
  // Start each run right after a break; a run joined across north wraps.
  const order = wraps
    ? [...present.slice(breaks[0]), ...present.slice(0, breaks[0])]
    : present;
  const starts = new Set(
    wraps ? breaks.map((k) => k - breaks[0]) : [0, ...breaks],
  );
  const arcs = [];
  let current = null;
  order.forEach((index, position) => {
    if (starts.has(position) || !current) {
      current = [];
      arcs.push(current);
    }
    current.push(bins[index]);
  });
  return arcs
    .filter((points) => points.length >= 2)
    .map((points) => ({ closed: false, points }));
}

/**
 * The drawn outline of one run: every heard direction's farthest position,
 * and between neighbours a polar sweep (bearing in `stepDeg` steps, range
 * linear in bearing) rather than a straight chord, so the outline reads like
 * a coverage plot and never cuts in toward the antenna. A closed run returns
 * to its first point.
 * @param {{closed:boolean, points:object[]}} arc From {@link horizonArcs}.
 * @param {{lat:number, lon:number}} antenna
 * @param {number} [stepDeg]
 * @returns {Array<{lat:number, lon:number}>}
 */
export function horizonOutline(
  arc,
  antenna,
  stepDeg = HORIZON_OUTLINE_STEP_DEG,
) {
  const points = arc.closed ? [...arc.points, arc.points[0]] : arc.points;
  const path = [];
  points.forEach((point, index) => {
    path.push({ lat: point.lat, lon: point.lon });
    const next = points[index + 1];
    if (!next) return;
    const sweep = (next.bearingDeg - point.bearingDeg + 360) % 360;
    // Bearings recovered from positions carry float noise (10.0000001°).
    const steps = Math.ceil(sweep / stepDeg - 1e-6);
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      path.push(
        projectPoint(
          antenna.lat,
          antenna.lon,
          point.bearingDeg + sweep * t,
          (point.rangeKm + (next.rangeKm - point.rangeKm) * t) * 1000,
        ),
      );
    }
  });
  return path;
}

/**
 * Session-only reception horizon: per altitude band, the farthest position
 * heard in each direction from the antenna.
 *
 * Positions are kept in a bounded buffer whether or not the antenna position
 * is known yet, so the horizon can be built (and rebuilt when the antenna
 * moves) from what was already heard. Nothing is stored beyond the page.
 * @param {object} [options]
 * @returns {object} Model: ingest, setAntenna, reset, snapshot.
 */
export function createHorizonModel({
  bands = HORIZON_BANDS,
  binDeg = HORIZON_BIN_DEG,
  gapDeg = HORIZON_GAP_DEG,
  minBins = HORIZON_MIN_BINS,
  maxRangeKm = HORIZON_MAX_RANGE_KM,
  bufferSize = HORIZON_FIX_BUFFER,
  antennaEpsilonM = HORIZON_ANTENNA_EPSILON_M,
} = {}) {
  const binCount = Math.round(360 / binDeg);
  const buffer = new Array(bufferSize);
  let head = 0;
  let size = 0;
  let antenna = null;
  let bins = [];
  const aircraft = new Set();
  let counted = 0;
  let implausible = 0;
  let lastFixAt = null;
  let version = 0;
  let shapeVersion = 0;
  let cached = null;

  function clearBins() {
    bins = bands.map(() => new Array(binCount).fill(null));
    aircraft.clear();
    counted = 0;
    implausible = 0;
  }
  clearBins();

  function remember(fix) {
    buffer[(head + size) % bufferSize] = fix;
    if (size < bufferSize) size += 1;
    else head = (head + 1) % bufferSize;
  }

  /** Place one fix relative to the current antenna; true when the shape grew. */
  function apply(fix) {
    const band = horizonBandIndex(fix.altitudeFt, bands);
    if (band < 0) return false;
    const rangeKm = greatCircleKm(antenna.lat, antenna.lon, fix.lat, fix.lon);
    if (!Number.isFinite(rangeKm) || rangeKm > maxRangeKm) {
      implausible += 1;
      return false;
    }
    counted += 1;
    if (fix.icao) aircraft.add(fix.icao);
    const bearingDeg = bearingBetweenCoordinates(
      antenna.lat,
      antenna.lon,
      fix.lat,
      fix.lon,
    );
    // Directly overhead has range but no direction.
    if (bearingDeg === null) return false;
    const index =
      Math.floor(((bearingDeg + binDeg / 2) % 360) / binDeg) % binCount;
    const current = bins[band][index];
    if (current && current.rangeKm >= rangeKm) return false;
    bins[band][index] = Object.freeze({ ...fix, rangeKm, bearingDeg });
    return true;
  }

  function rebuild() {
    clearBins();
    if (antenna)
      for (let i = 0; i < size; i += 1) apply(buffer[(head + i) % bufferSize]);
    version += 1;
    shapeVersion += 1;
    cached = null;
  }

  function farthestFix() {
    let best = null;
    bins.forEach((bandBins, bandIndex) => {
      for (const bin of bandBins)
        if (bin && (!best || bin.rangeKm > best.rangeKm))
          best = { ...bin, bandId: bands[bandIndex].id };
    });
    return best;
  }

  return {
    /**
     * Take one accepted position. Ground positions and positions without an
     * altitude have no band and are ignored.
     * @param {object} fix `{ icao, lat, lon, altitudeFt, onGround, at }`.
     * @returns {boolean} Whether the drawn horizon grew.
     */
    ingest(fix) {
      const entry = horizonFix(fix);
      if (!entry) return false;
      remember(entry);
      if (entry.at !== null) lastFixAt = Math.max(lastFixAt ?? 0, entry.at);
      version += 1;
      cached = null;
      if (!antenna) return false;
      const grew = apply(entry);
      if (grew) shapeVersion += 1;
      return grew;
    },

    /**
     * Centre the horizon on a new antenna position (null clears it) and
     * rebuild from the buffered positions. A move under `antennaEpsilonM`
     * keeps the horizon as it is.
     * @param {{lat:number, lon:number}|null} position
     * @returns {boolean} Whether the antenna changed.
     */
    setAntenna(position) {
      const next = validAntennaPosition(position);
      if (!next && !antenna) return false;
      if (
        next &&
        antenna &&
        greatCircleKm(antenna.lat, antenna.lon, next.lat, next.lon) * 1000 <
          antennaEpsilonM
      )
        return false;
      antenna = next;
      rebuild();
      return true;
    },

    /** Forget every position heard so far; the antenna stays. */
    reset() {
      head = 0;
      size = 0;
      buffer.fill(undefined);
      lastFixAt = null;
      rebuild();
    },

    /**
     * Plain snapshot for rendering and readouts, cached until the next change.
     * @returns {object}
     */
    snapshot() {
      if (cached) return cached;
      cached = Object.freeze({
        version,
        shapeVersion,
        antenna,
        counted,
        implausible,
        aircraft: aircraft.size,
        buffered: size,
        pending: antenna ? 0 : size,
        lastFixAt,
        farthest: farthestFix(),
        bands: bands.map((band, index) => {
          const heard = bins[index].filter(Boolean);
          return Object.freeze({
            id: band.id,
            label: band.label,
            shortLabel: band.shortLabel,
            color: band.color,
            drawFloorFt: band.drawFloorFt,
            drawCeilingFt: band.drawCeilingFt,
            directions: heard.length,
            coverage: heard.length / binCount,
            maxRangeKm: heard.reduce(
              (max, bin) => Math.max(max, bin.rangeKm),
              0,
            ),
            arcs: horizonArcs(bins[index], { binDeg, gapDeg, minBins }),
          });
        }),
      });
      return cached;
    },
  };
}
