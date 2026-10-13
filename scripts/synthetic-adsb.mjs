/**
 * Deterministic synthetic ADS-B sky for the Reception Horizon gate and the
 * fake decoder feed (`scripts/fake-adsb-feed.mjs`).
 *
 * Aircraft fly straight great-circle legs at mixed altitudes around an
 * antenna. One is "heard" (given a position in `aircraft.json`) only inside a
 * radio horizon that grows with altitude, minus a ridge that shadows low
 * traffic to the west-north-west, so the expected horizon has a known shape.
 * Every `glitchEveryS` seconds one heard aircraft reports a single corrupt
 * position 1,800 km away, and a never-seen hex reports one position 1,500 km
 * away: both must stay off the horizon.
 *
 * The documents follow dump1090-fa / readsb: `aircraft.json` with `now`,
 * `messages` and `aircraft[]` (`hex`, `flight`, `alt_baro`, `gs`, `track`,
 * `lat`, `lon`, `seen`, `seen_pos`, `category`, `messages`, `rssi`), and
 * `receiver.json` with `lat`/`lon` when a location is configured.
 */

const EARTH_KM = 6371.0088;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const FT_TO_M = 0.3048;

/** Synthetic antenna height used by the radio-horizon model. */
export const SYNTHETIC_ANTENNA_HEIGHT_M = 15;
/** The ridge: bearings it shadows, and how far it lets low traffic be heard. */
export const SYNTHETIC_RIDGE = Object.freeze({
  fromDeg: 250,
  toDeg: 310,
  belowFt: 15_000,
  factor: 0.55,
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function destination(lat, lon, bearingDeg, km) {
  const d = km / EARTH_KM;
  const b = bearingDeg * D2R;
  const p1 = lat * D2R;
  const l1 = lon * D2R;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
}

export function distanceKm(a, b) {
  const dp = (b.lat - a.lat) * D2R;
  const dl = (b.lon - a.lon) * D2R;
  const h =
    Math.sin(dp / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const p1 = a.lat * D2R;
  const p2 = b.lat * D2R;
  const dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/**
 * How far the synthetic antenna hears an aircraft at this altitude and
 * bearing: the 4/3-Earth radio horizon, shortened behind the ridge.
 * @param {number} altitudeFt
 * @param {number} bearing Degrees from the antenna.
 * @returns {number} Kilometres.
 */
export function syntheticHorizonKm(altitudeFt, bearing) {
  const base =
    4.12 *
    (Math.sqrt(SYNTHETIC_ANTENNA_HEIGHT_M) +
      Math.sqrt(Math.max(0, altitudeFt) * FT_TO_M));
  const ridge =
    bearing >= SYNTHETIC_RIDGE.fromDeg &&
    bearing <= SYNTHETIC_RIDGE.toDeg &&
    altitudeFt < SYNTHETIC_RIDGE.belowFt;
  return base * (ridge ? SYNTHETIC_RIDGE.factor : 0.92);
}

const PROFILES = [
  { share: 0.22, altFt: [1_500, 4_800], gsKt: [95, 160], category: 'A1' },
  { share: 0.18, altFt: [5_000, 14_800], gsKt: [180, 300], category: 'A2' },
  { share: 0.15, altFt: [15_000, 24_800], gsKt: [280, 400], category: 'A3' },
  { share: 0.22, altFt: [25_000, 34_800], gsKt: [400, 470], category: 'A3' },
  { share: 0.23, altFt: [35_000, 41_000], gsKt: [430, 500], category: 'A5' },
];

/**
 * A synthetic sky around `antenna`. Advance it by calling the document
 * builders with increasing times.
 * @param {object} [options]
 * @param {{lat:number, lon:number}} [options.antenna]
 * @param {number} [options.aircraftCount]
 * @param {number} [options.seed]
 * @param {number} [options.startMs]
 * @param {number} [options.glitchEveryS]
 * @param {boolean} [options.location] Whether receiver.json carries lat/lon.
 * @param {number} [options.timeScale] Run the sky this many times faster
 *   than the clock (for demos: 20 plays an hour in three minutes). Reported
 *   ground speeds scale too, so the motion stays self-consistent.
 */
export function createSyntheticSky({
  antenna = { lat: 30.2672, lon: -97.7431 },
  aircraftCount = 140,
  seed = 1090,
  startMs = Date.now(),
  glitchEveryS = 20,
  location = true,
  timeScale = 1,
} = {}) {
  const random = mulberry32(seed);
  const between = ([lo, hi]) => lo + (hi - lo) * random();
  let lastMs = startMs;
  let messages = 0;
  let ghost = 0;

  function profile() {
    let pick = random();
    for (const entry of PROFILES) {
      if (pick < entry.share) return entry;
      pick -= entry.share;
    }
    return PROFILES.at(-1);
  }

  function spawn(index, anywhere) {
    const kind = profile();
    const altFt = Math.round(between(kind.altFt) / 100) * 100;
    // Start inside the area on the first spawn; later ones enter from its
    // rim and cross it, so every direction keeps seeing traffic.
    const from = random() * 360;
    const start = destination(
      antenna.lat,
      antenna.lon,
      from,
      anywhere ? 30 + random() * 480 : 560,
    );
    const inward =
      (bearingDeg(start, antenna) + (random() - 0.5) * 110 + 360) % 360;
    return {
      hex: (0xa00000 + index * 97 + Math.floor(random() * 50)).toString(16),
      flight: `SYN${String(index).padStart(3, '0')}`,
      category: kind.category,
      altFt,
      gsKt: Math.round(between(kind.gsKt)),
      track: anywhere ? random() * 360 : inward,
      lat: start.lat,
      lon: start.lon,
      messages: 0,
    };
  }

  const fleet = Array.from({ length: aircraftCount }, (_, index) =>
    spawn(index, true),
  );

  function advance(nowMs) {
    const dtS = Math.max(0, Math.min(10, (nowMs - lastMs) / 1000)) * timeScale;
    lastMs = Math.max(lastMs, nowMs);
    fleet.forEach((plane, index) => {
      const km = (plane.gsKt * 1.852 * dtS) / 3600;
      const next = destination(plane.lat, plane.lon, plane.track, km);
      // Keep the great-circle track honest as the aircraft moves.
      plane.track = (bearingDeg(next, plane) + 180) % 360;
      plane.lat = next.lat;
      plane.lon = next.lon;
      if (distanceKm(antenna, plane) > 600) {
        const fresh = spawn(index, false);
        fresh.hex = plane.hex;
        fresh.flight = plane.flight;
        fleet[index] = fresh;
      }
    });
  }

  return {
    antenna,

    /** dump1090-style `aircraft.json` at `nowMs`. */
    aircraftJson(nowMs = Date.now()) {
      advance(nowMs);
      const second = Math.floor(nowMs / 1000);
      const glitching = glitchEveryS > 0 && second % glitchEveryS === 0;
      let glitched = false;
      const aircraft = [];
      for (const plane of fleet) {
        const range = distanceKm(antenna, plane);
        const heard =
          range <= syntheticHorizonKm(plane.altFt, bearingDeg(antenna, plane));
        if (range > 650) continue;
        plane.messages += heard ? 6 : 0;
        messages += heard ? 6 : 0;
        const entry = {
          hex: plane.hex,
          flight: plane.flight,
          category: plane.category,
          alt_baro: plane.altFt,
          gs: Math.round(plane.gsKt * timeScale),
          track: Math.round(plane.track * 10) / 10,
          seen: heard ? 0.2 : 30,
          messages: plane.messages,
          rssi: heard ? -20 - (range / 400) * 15 : -49.5,
        };
        if (heard) {
          let { lat, lon } = plane;
          if (glitching && !glitched) {
            ({ lat, lon } = destination(antenna.lat, antenna.lon, 45, 1_800));
            glitched = true;
          }
          Object.assign(entry, { lat, lon, seen_pos: 0.3 });
        }
        if (heard) aircraft.push(entry);
      }
      if (glitching) {
        ghost += 1;
        const far = destination(antenna.lat, antenna.lon, 200, 1_500);
        aircraft.push({
          hex: (0xf00000 + ghost).toString(16),
          alt_baro: 33_000,
          lat: far.lat,
          lon: far.lon,
          seen: 0.1,
          seen_pos: 0.1,
          messages: 2,
        });
      }
      return { now: nowMs / 1000, messages, aircraft };
    },

    /** dump1090-style `receiver.json`, with the location when configured. */
    receiverJson() {
      return {
        version: 'synthetic',
        refresh: 1000,
        history: 0,
        ...(location ? { lat: antenna.lat, lon: antenna.lon } : {}),
      };
    },
  };
}
