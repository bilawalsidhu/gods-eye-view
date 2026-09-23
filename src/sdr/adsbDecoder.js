import {
  LOCAL_ADSB_POSITION_MARGIN_M,
  LOCAL_ADSB_REANCHOR_AFTER,
  LOCAL_ADSB_REFERENCE_MAX_AGE_MS,
  localAdsbFixIsPlausible,
  localAdsbSpeedLimitKt,
} from '../sources/adsbRecords.js';

const MODE_S_POLYNOMIAL = 0xfff409;
/** An aircraft with no CRC-valid message for this long is removed. */
export const LOCAL_ADSB_STALE_MS = 60_000;
const CPR_PAIR_MAX_AGE_MS = 10_000;
/** Surface aircraft move slowly; an even/odd surface pair may be further apart. */
const CPR_SURFACE_PAIR_MAX_AGE_MS = 25_000;
/**
 * Half a surface CPR latitude zone (90° / 60 zones / 2 = 0.75°, 45 NM): a
 * single surface frame decodes unambiguously only against a reference known
 * to be closer than this to the aircraft.
 */
const SURFACE_REFERENCE_RANGE_M = 45 * 1_852;
const KT_TO_MPS = 1_852 / 3_600;
const CPR_SCALE = 131_072;
const CPR_NZ = 15;
const CALLSIGN_CHARSET =
  '#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######';
const PREAMBLE_SAMPLES = 16;
const FRAME_BITS = 112;
const FRAME_SAMPLES = PREAMBLE_SAMPLES + FRAME_BITS * 2;
const STREAM_CARRY_BYTES = (FRAME_SAMPLES - 1) * 2;

function bit(bytes, index) {
  return (bytes[index >> 3] >> (7 - (index & 7))) & 1;
}

function bits(bytes, start, length) {
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 2 + bit(bytes, start + index);
  }
  return value;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function cprNl(latitude) {
  const absolute = Math.abs(latitude);
  if (absolute >= 87) return absolute === 87 ? 2 : 1;
  const numerator = 1 - Math.cos(Math.PI / (2 * CPR_NZ));
  const denominator = Math.cos((Math.PI / 180) * absolute) ** 2;
  return Math.floor((2 * Math.PI) / Math.acos(1 - numerator / denominator));
}

function normalizeLongitude(longitude) {
  let normalized = longitude;
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  return normalized;
}

function validReference(reference) {
  return (
    Boolean(reference) &&
    Number.isFinite(reference.latitude) &&
    Number.isFinite(reference.longitude)
  );
}

/** The candidate `value + k * period` nearest `target`. */
function nearestAlias(value, period, target) {
  return value + period * Math.round((target - value) / period);
}

/**
 * Locally decode one CPR frame against a reference within half a zone.
 * Surface frames use quarter-size zones (90° instead of 360°), so their
 * reference must be within 45 NM of the aircraft: only the aircraft's own
 * recent position qualifies (see `surfaceReference`).
 */
function decodeLocalCpr(frame, reference) {
  if (!validReference(reference)) return null;
  const span = frame.surface ? 90 : 360;
  const parity = frame.odd ? 1 : 0;
  const dLat = span / (4 * CPR_NZ - parity);
  const latitudeIndex =
    Math.floor(reference.latitude / dLat) +
    Math.floor(
      0.5 +
        positiveModulo(reference.latitude, dLat) / dLat -
        frame.latitude / CPR_SCALE,
    );
  let latitude = dLat * (latitudeIndex + frame.latitude / CPR_SCALE);
  if (latitude >= 270) latitude -= 360;
  if (latitude < -90 || latitude > 90) return null;

  const longitudeZones = Math.max(cprNl(latitude) - parity, 1);
  const dLon = span / longitudeZones;
  const longitudeIndex =
    Math.floor(reference.longitude / dLon) +
    Math.floor(
      0.5 +
        positiveModulo(reference.longitude, dLon) / dLon -
        frame.longitude / CPR_SCALE,
    );
  const longitude = normalizeLongitude(
    dLon * (longitudeIndex + frame.longitude / CPR_SCALE),
  );
  return { latitude, longitude };
}

function decodeGlobalCpr(even, odd) {
  if (
    !even ||
    !odd ||
    Math.abs(even.receivedAt - odd.receivedAt) > CPR_PAIR_MAX_AGE_MS
  )
    return null;
  const latitudeIndex = Math.floor(
    (59 * even.latitude - 60 * odd.latitude) / CPR_SCALE + 0.5,
  );
  let evenLatitude =
    6 * (positiveModulo(latitudeIndex, 60) + even.latitude / CPR_SCALE);
  let oddLatitude =
    (360 / 59) * (positiveModulo(latitudeIndex, 59) + odd.latitude / CPR_SCALE);
  if (evenLatitude >= 270) evenLatitude -= 360;
  if (oddLatitude >= 270) oddLatitude -= 360;
  if (cprNl(evenLatitude) !== cprNl(oddLatitude)) return null;

  const useOdd = odd.receivedAt > even.receivedAt;
  const latitude = useOdd ? oddLatitude : evenLatitude;
  const longitudeZones = Math.max(cprNl(latitude) - (useOdd ? 1 : 0), 1);
  const longitudeIndex = Math.floor(
    (even.longitude * (cprNl(latitude) - 1) - odd.longitude * cprNl(latitude)) /
      CPR_SCALE +
      0.5,
  );
  const frame = useOdd ? odd : even;
  const longitude = normalizeLongitude(
    (360 / longitudeZones) *
      (positiveModulo(longitudeIndex, longitudeZones) +
        frame.longitude / CPR_SCALE),
  );
  return { latitude, longitude };
}

/**
 * Globally decode an even/odd pair of SURFACE position frames. Surface CPR
 * encodes a quarter of the globe, so the pair leaves four candidate
 * latitudes/longitudes 90° apart; the one nearest `reference` (the aircraft's
 * last position or the receiver) is the answer, and without a reference
 * there is no answer.
 */
function decodeGlobalSurfaceCpr(even, odd, reference) {
  if (
    !even ||
    !odd ||
    !validReference(reference) ||
    Math.abs(even.receivedAt - odd.receivedAt) > CPR_SURFACE_PAIR_MAX_AGE_MS
  )
    return null;
  const latitudeIndex = Math.floor(
    (59 * even.latitude - 60 * odd.latitude) / CPR_SCALE + 0.5,
  );
  const evenLatitude = nearestAlias(
    (90 / 60) * (positiveModulo(latitudeIndex, 60) + even.latitude / CPR_SCALE),
    90,
    reference.latitude,
  );
  const oddLatitude = nearestAlias(
    (90 / 59) * (positiveModulo(latitudeIndex, 59) + odd.latitude / CPR_SCALE),
    90,
    reference.latitude,
  );
  if (Math.abs(evenLatitude) > 90 || Math.abs(oddLatitude) > 90) return null;
  if (cprNl(evenLatitude) !== cprNl(oddLatitude)) return null;

  const useOdd = odd.receivedAt > even.receivedAt;
  const latitude = useOdd ? oddLatitude : evenLatitude;
  const nl = cprNl(latitude);
  const longitudeZones = Math.max(nl - (useOdd ? 1 : 0), 1);
  const longitudeIndex = Math.floor(
    (even.longitude * (nl - 1) - odd.longitude * nl) / CPR_SCALE + 0.5,
  );
  const frame = useOdd ? odd : even;
  const longitude = normalizeLongitude(
    nearestAlias(
      (90 / longitudeZones) *
        (positiveModulo(longitudeIndex, longitudeZones) +
          frame.longitude / CPR_SCALE),
      90,
      reference.longitude,
    ),
  );
  return { latitude, longitude };
}

/**
 * Ground speed in knots from a surface message's 7-bit movement field
 * (DO-260B §2.2.3.2.4.2): null for "no information" and reserved codes.
 */
function decodeSurfaceMovement(movement) {
  if (movement === 0 || movement > 124) return null;
  if (movement === 1) return 0;
  if (movement === 124) return 175;
  const bands = [
    [2, 0.125, 0.125],
    [9, 1, 0.25],
    [13, 2, 0.5],
    [39, 15, 1],
    [94, 70, 2],
    [109, 100, 5],
  ];
  let band = bands[0];
  for (const candidate of bands) if (movement >= candidate[0]) band = candidate;
  const [firstCode, firstKt, stepKt] = band;
  return firstKt + (movement - firstCode) * stepKt;
}

function decodeAltitude(bytes) {
  if (!bit(bytes, 47)) return null;
  const encoded = (bits(bytes, 40, 7) << 4) | bits(bytes, 48, 4);
  return encoded * 25 - 1_000;
}

function decodeCallsign(bytes) {
  let callsign = '';
  for (let index = 0; index < 8; index += 1) {
    callsign += CALLSIGN_CHARSET[bits(bytes, 40 + index * 6, 6)] || ' ';
  }
  return callsign.replace(/[_#]/g, ' ').trim();
}

function decodeVelocity(bytes) {
  const subtype = bits(bytes, 37, 3);
  if (subtype !== 1 && subtype !== 2) return null;
  const multiplier = subtype === 2 ? 4 : 1;
  const eastWestRaw = bits(bytes, 46, 10);
  const northSouthRaw = bits(bytes, 57, 10);
  if (!eastWestRaw || !northSouthRaw) return null;
  const eastWest = (eastWestRaw - 1) * multiplier * (bit(bytes, 45) ? -1 : 1);
  const northSouth =
    (northSouthRaw - 1) * multiplier * (bit(bytes, 56) ? -1 : 1);
  const speedKt = Math.hypot(eastWest, northSouth);
  const headingDeg = positiveModulo(
    (Math.atan2(eastWest, northSouth) * 180) / Math.PI,
    360,
  );
  const verticalRaw = bits(bytes, 69, 9);
  const verticalRateFpm = verticalRaw
    ? (verticalRaw - 1) * 64 * (bit(bytes, 68) ? -1 : 1)
    : null;
  return { speedKt, headingDeg, verticalRateFpm };
}

/** Compute the 24-bit Mode S parity remainder. Valid extended squitters return zero. */
export function modeSChecksum(bytes) {
  let remainder = 0;
  for (let index = 0; index < bytes.length * 8; index += 1) {
    const feedback = bit(bytes, index) ^ ((remainder >> 23) & 1);
    remainder = (remainder << 1) & 0xffffff;
    if (feedback) remainder ^= MODE_S_POLYNOMIAL;
  }
  return remainder;
}

/** Decode one 112-bit DF17/DF18 extended-squitter message. */
export function decodeAdsbMessage(bytes, { receivedAt = Date.now() } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 14) return null;
  const downlinkFormat = bits(bytes, 0, 5);
  if (
    (downlinkFormat !== 17 && downlinkFormat !== 18) ||
    modeSChecksum(bytes) !== 0
  )
    return null;
  const icao = [...bytes.slice(1, 4)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const typeCode = bits(bytes, 32, 5);
  const message = { icao, typeCode, receivedAt };
  if (typeCode >= 1 && typeCode <= 4) {
    message.callsign = decodeCallsign(bytes);
    // dump1090 convention: category set A = TC 4, B = TC 3, C = TC 2, D = TC 1,
    // followed by the 3-bit emitter category ('A7' rotorcraft, 'A1' light).
    message.category = `${String.fromCharCode(69 - typeCode)}${bits(bytes, 37, 3)}`;
  } else if (typeCode >= 5 && typeCode <= 8) {
    // Surface position: movement, ground track when its status bit is set,
    // and a quarter-globe CPR position; there is no altitude on the ground.
    message.onGround = true;
    message.altitudeFt = null;
    const speedKt = decodeSurfaceMovement(bits(bytes, 37, 7));
    if (speedKt !== null) message.speedKt = speedKt;
    if (bit(bytes, 44)) message.headingDeg = (bits(bytes, 45, 7) * 360) / 128;
    message.cpr = {
      surface: true,
      odd: Boolean(bit(bytes, 53)),
      latitude: bits(bytes, 54, 17),
      longitude: bits(bytes, 71, 17),
      receivedAt,
    };
  } else if (typeCode >= 9 && typeCode <= 18) {
    message.onGround = false;
    message.altitudeFt = decodeAltitude(bytes);
    message.cpr = {
      odd: Boolean(bit(bytes, 53)),
      latitude: bits(bytes, 54, 17),
      longitude: bits(bytes, 71, 17),
      receivedAt,
    };
  } else if (typeCode === 19) {
    Object.assign(message, decodeVelocity(bytes) || {});
  }
  return message;
}

function recentReference(track, receivedAt) {
  if (
    !Number.isFinite(track.latitude) ||
    !Number.isFinite(track.longitude) ||
    !Number.isFinite(track.lastPositionAt) ||
    receivedAt - track.lastPositionAt > LOCAL_ADSB_REFERENCE_MAX_AGE_MS
  )
    return null;
  return { latitude: track.latitude, longitude: track.longitude };
}

/**
 * The aircraft's own last position as a single-frame SURFACE reference, when
 * it is established to be within 45 NM: recent, and the aircraft cannot have
 * covered 45 NM since at its speed limit (the speed check's limit). The
 * receiver location never qualifies, since how far away a heard aircraft is
 * cannot be known from one frame.
 */
function surfaceReference(track, message) {
  const reference = recentReference(track, message.receivedAt);
  if (!reference) return null;
  const groundSpeedKt = Number.isFinite(track.speedKt)
    ? Math.max(
        track.speedKt,
        Number.isFinite(message.speedKt) ? message.speedKt : 0,
      )
    : null;
  const limitKt = localAdsbSpeedLimitKt({
    groundSpeedKt,
    category: track.category,
  });
  const reachM =
    LOCAL_ADSB_POSITION_MARGIN_M +
    ((message.receivedAt - track.lastPositionAt + 1_000) / 1_000) *
      limitKt *
      KT_TO_MPS;
  return reachM < SURFACE_REFERENCE_RANGE_M ? reference : null;
}

/**
 * Merge one decoded message into a stable aircraft record.
 *
 * Airborne (TC 9–18) and surface (TC 5–8) positions are paired separately.
 * A surface pair needs a reference to pick its quadrant (the aircraft's last
 * position, else the receiver); surface messages also set `onGround` and
 * clear the altitude, and the next airborne position clears `onGround`.
 *
 * A position comes from a fresh even/odd pair (global CPR), else from one
 * frame decoded relative to the aircraft's own last accepted position when it
 * is under 10 minutes old, else (airborne only) relative to the receiver
 * location. A single surface frame needs the aircraft's own position within
 * 45 NM, so a surface track is always seeded by a pair. Every
 * candidate then passes the dump1090-style speed check against the last
 * accepted fix; a failing fix is counted (`rejectedPositions` on the track and
 * `positionsRejected` on the optional `stats`) and not applied. From the
 * third consecutive rejection on, a globally decoded fix is accepted as the
 * new reference, so one bad accepted fix cannot freeze a track.
 * @param {Map<string, object>} tracks Tracks keyed by uppercase ICAO.
 * @param {object} message Output of `decodeAdsbMessage`.
 * @param {{latitude:number, longitude:number}|null} [receiverLocation]
 * @param {{positionsRejected?:number}} [stats] Mutable decoder counters.
 * @returns {object|null} The updated track.
 */
export function updateAircraftTrack(
  tracks,
  message,
  receiverLocation = null,
  stats = null,
) {
  if (!(tracks instanceof Map) || !message?.icao) return null;
  const prior = tracks.get(message.icao) || {
    icao: message.icao,
    callsign: null,
    category: null,
    altitudeFt: null,
    latitude: null,
    longitude: null,
    speedKt: null,
    headingDeg: null,
    verticalRateFpm: null,
    messages: 0,
    lastSeen: 0,
    lastPositionAt: null,
    onGround: false,
    cprEven: null,
    cprOdd: null,
    cprSurfaceEven: null,
    cprSurfaceOdd: null,
    rejectedPositions: 0,
    rejectStreak: 0,
  };
  const next = {
    ...prior,
    messages: prior.messages + 1,
    lastSeen: message.receivedAt,
  };
  for (const key of [
    'callsign',
    'category',
    'altitudeFt',
    'speedKt',
    'headingDeg',
    'verticalRateFpm',
  ]) {
    if (message[key] !== undefined && message[key] !== null)
      next[key] = message[key];
  }
  // A position message says where the aircraft is: on the surface (no
  // altitude, no climb) or airborne again.
  if (typeof message.onGround === 'boolean') {
    next.onGround = message.onGround;
    if (message.onGround) {
      next.altitudeFt = null;
      next.verticalRateFpm = null;
    }
  }
  if (message.cpr) {
    const surface = Boolean(message.cpr.surface);
    // Airborne and surface frames use different zone sizes: never pair them.
    if (surface) {
      if (message.cpr.odd) next.cprSurfaceOdd = message.cpr;
      else next.cprSurfaceEven = message.cpr;
    } else if (message.cpr.odd) next.cprOdd = message.cpr;
    else next.cprEven = message.cpr;
    const reference = recentReference(prior, message.receivedAt);
    const global = surface
      ? decodeGlobalSurfaceCpr(
          next.cprSurfaceEven,
          next.cprSurfaceOdd,
          reference || receiverLocation,
        )
      : decodeGlobalCpr(next.cprEven, next.cprOdd);
    const position =
      global ||
      (surface
        ? decodeLocalCpr(message.cpr, surfaceReference(prior, message))
        : decodeLocalCpr(message.cpr, reference) ||
          decodeLocalCpr(message.cpr, receiverLocation));
    if (position) {
      const plausible =
        !reference ||
        localAdsbFixIsPlausible(
          {
            lat: prior.latitude,
            lon: prior.longitude,
            at: prior.lastPositionAt,
          },
          {
            lat: position.latitude,
            lon: position.longitude,
            at: message.receivedAt,
          },
          { groundSpeedKt: next.speedKt, category: next.category },
        );
      const reanchor =
        !plausible &&
        Boolean(global) &&
        (prior.rejectStreak || 0) + 1 >= LOCAL_ADSB_REANCHOR_AFTER;
      if (plausible || reanchor) {
        Object.assign(next, position);
        next.lastPositionAt = message.receivedAt;
        next.rejectStreak = 0;
      } else {
        next.rejectedPositions = (prior.rejectedPositions || 0) + 1;
        next.rejectStreak = (prior.rejectStreak || 0) + 1;
        if (stats) stats.positionsRejected = (stats.positionsRejected || 0) + 1;
      }
    }
  }
  tracks.set(message.icao, next);
  return next;
}

/** Remove aircraft that have not transmitted recently. */
export function pruneAircraftTracks(
  tracks,
  now = Date.now(),
  ttlMs = LOCAL_ADSB_STALE_MS,
) {
  if (!(tracks instanceof Map)) return 0;
  let removed = 0;
  for (const [icao, aircraft] of tracks) {
    if (now - aircraft.lastSeen < ttlMs) continue;
    tracks.delete(icao);
    removed += 1;
  }
  return removed;
}

function preambleContrast(power, offset) {
  const pulseOffsets = [0, 2, 7, 9];
  // Only the six defined gaps between Mode S preamble pulses establish the
  // local floor. Samples 10–15 can contain the trailing shape of the last RF
  // pulse on a real 2 Msps receiver and treating them as quiet rejects frames
  // that a clean synthetic fixture does not expose.
  const quietOffsets = [1, 3, 4, 5, 6, 8];
  let pulseMean = 0;
  let quietMean = 0;
  for (const index of pulseOffsets) pulseMean += power[offset + index];
  for (const index of quietOffsets) quietMean += power[offset + index];
  pulseMean /= pulseOffsets.length;
  quietMean /= quietOffsets.length;
  const contrast = pulseMean - quietMean;
  if (contrast < 120 || pulseMean < quietMean * 1.8) return 0;
  const decisionLevel = quietMean + contrast * 0.35;
  if (pulseOffsets.some((index) => power[offset + index] <= decisionLevel))
    return 0;
  return contrast;
}

/** Extract CRC-valid 112-bit ADS-B messages from unsigned 8-bit interleaved IQ. */
export function extractAdsbMessages(buffer, sampleRate = 2_000_000) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    Math.abs(sampleRate - 2_000_000) > 30_000
  )
    return [];
  const iq = new Uint8Array(buffer);
  const sampleCount = Math.floor(iq.length / 2);
  const power = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const i = iq[index * 2] - 127.5;
    const q = iq[index * 2 + 1] - 127.5;
    power[index] = i * i + q * q;
  }

  const messages = [];
  for (let offset = 0; offset <= sampleCount - FRAME_SAMPLES; offset += 1) {
    const contrast = preambleContrast(power, offset);
    if (!contrast) continue;
    const bytes = new Uint8Array(14);
    let uncertainBits = 0;
    for (let bitIndex = 0; bitIndex < FRAME_BITS; bitIndex += 1) {
      const sampleOffset = offset + PREAMBLE_SAMPLES + bitIndex * 2;
      const first = power[sampleOffset];
      const second = power[sampleOffset + 1];
      const total = first + second;
      const difference = Math.abs(first - second);
      if (
        difference < Math.max(20, contrast * 0.02) ||
        difference / Math.max(total, 1) < 0.04
      )
        uncertainBits += 1;
      if (first > second) bytes[bitIndex >> 3] |= 1 << (7 - (bitIndex & 7));
    }
    if (uncertainBits <= 10 && modeSChecksum(bytes) === 0) {
      messages.push(bytes);
      offset += FRAME_SAMPLES - 1;
    }
  }
  return messages;
}

/** Preserve enough IQ between USB reads to recover frames split at a block edge. */
export class AdsbStreamDecoder {
  constructor() {
    this._carry = new Uint8Array(0);
  }

  reset() {
    this._carry = new Uint8Array(0);
  }

  extract(buffer, sampleRate = 2_000_000) {
    if (!(buffer instanceof ArrayBuffer)) return [];
    const incoming = new Uint8Array(buffer);
    let combined = incoming;
    if (this._carry.length) {
      combined = new Uint8Array(this._carry.length + incoming.length);
      combined.set(this._carry);
      combined.set(incoming, this._carry.length);
    }
    this._carry = combined.slice(
      Math.max(0, combined.length - STREAM_CARRY_BYTES),
    );
    return extractAdsbMessages(combined.buffer, sampleRate);
  }
}
