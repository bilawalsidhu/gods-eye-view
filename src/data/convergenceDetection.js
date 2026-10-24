// src/data/convergenceDetection.js — Convergence (rendezvous) detection over track history.
//
// Derived-intelligence layer, sibling to Pattern Watch: it reports where two
// independently tracked entities closed to the same place and time, held
// proximity, then separated. It works over history ALREADY sitting client-side
// (the trails the layers keep), and — like analystEngine — it is pure query
// logic that renders nothing; a surface consumes the returned `items`.
//
// WHAT IT REPORTS vs WHAT IT DOES NOT
//   It reports an OBSERVED spatiotemporal coincidence, with geometry attached:
//   the two {layerKey, id} identities, when they were closest and how close,
//   how long they held proximity, and whether they approached-then-departed.
//   Each event carries a coincidence score in [0,1] derived only from that
//   geometry.
//
//   It does NOT assert intent. There is no "meeting", "transfer", "handoff",
//   "contact" or "relationship" — the event shape has no field for it, by
//   design (a source-level test pins this). Two entities being in the same
//   place at the same time is a geometric fact; what it means is a judgement
//   the operator makes and owns. See docs/convergence-detection.md.
//
// METHOD (per candidate pair, over the overlapping time span)
//   1. Coarse gate: time-overlap + bounding-box, so not every O(n^2) pair is
//      scored (spatial bucketing in detectConvergences).
//   2. Resample both tracks onto a common time grid inside their overlap.
//      A grid step that straddles a gap longer than maxGapS is left undefined
//      rather than interpolated, so a convergence is never manufactured from
//      missing data (the feeds arrive every 15–30 s with dead-reckoned gaps).
//   3. Separation series d(t). A convergence requires:
//        min(d) <= rNearM              (they actually got close)
//        dwell( d <= rNearM ) >= tMin  (not a fly-by crossing)
//        approach then departure       (closed in, then out)
//   4. Score = closeness · dwell · approach/departure geometry.
//
// The engine is domain-agnostic: choose rNearM and tMinDwellS for the entities
// being watched (hundreds of metres and minutes for vessels; tighter for road
// vehicles). Distances are geodesic metres via haversine, so no projection is
// needed at the input.
//
// @module data/convergenceDetection

/** @typedef {{ t: number, lat: number, lon: number }} Fix  A timestamped position (unix seconds, degrees). */
/** @typedef {{ layerKey: string, id: string, kind?: string, label?: string, fixes: Fix[] }} Track */

const EARTH_R_M = 6_371_000;

/** Default detection thresholds. Tuned for maritime scale; override per layer. */
export const CONVERGENCE_DEFAULTS = Object.freeze({
  rNearM: 200, // "close" threshold, metres
  tMinDwellS: 120, // minimum time held within rNearM, seconds
  gridDtS: 15, // resample step, seconds
  maxGapS: 300, // do not interpolate across gaps longer than this
  minOverlapS: 60, // ignore pairs overlapping less than this
  bucketM: 2000, // spatial bucket size for coarse pairing, metres
  requireApproachDepart: true,
  minSamples: 3, // usable co-observed grid points required
  // Rendezvous-signature reference values — the observed geometry that
  // separates a deliberate meet from two entities that happen to drift close.
  reachRefM: 2000, // distance-closed at which "reach" saturates
  loiterFrac: 0.45, // hold speed below this fraction of transit = station-keeping
  // Recurring-rendezvous reference values — a pair that meets repeatedly, at
  // the same place, on a regular cadence, is a far stronger observed pattern
  // than any single event.
  recurLocRefM: 1500, // location spread at which "same place" saturates to 0
  recurMinOccurrences: 2, // meets needed before a pair is "recurring"
});

/** Geodesic distance in metres between two lat/lon points (haversine). */
export function metersBetween(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Chronologically sorted copy of a track's fixes. */
function sortedFixes(track) {
  return [...track.fixes].sort((a, b) => a.t - b.t);
}

function span(track) {
  const f = track.fixes;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of f) {
    if (p.t < lo) lo = p.t;
    if (p.t > hi) hi = p.t;
  }
  return [lo, hi];
}

function bbox(track) {
  let latMin = Infinity;
  let lonMin = Infinity;
  let latMax = -Infinity;
  let lonMax = -Infinity;
  for (const p of track.fixes) {
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
    if (p.lon < lonMin) lonMin = p.lon;
    if (p.lon > lonMax) lonMax = p.lon;
  }
  return { latMin, lonMin, latMax, lonMax };
}

/**
 * Linear interpolation of a track onto tGrid. A grid time inside a gap longer
 * than maxGapS (no bracketing fix close enough) yields null, so it is excluded
 * from scoring rather than fabricated.
 * @returns {Array<{lat:number, lon:number} | null>}
 */
export function resampleTrack(track, tGrid, maxGapS) {
  const f = sortedFixes(track);
  const ts = f.map((p) => p.t);
  const out = new Array(tGrid.length).fill(null);
  for (let i = 0; i < tGrid.length; i += 1) {
    const t = tGrid[i];
    if (t < ts[0] || t > ts[ts.length - 1]) continue;
    // find bracketing indices j-1, j with ts[j] >= t
    let j = 0;
    while (j < ts.length && ts[j] < t) j += 1;
    if (j === 0) {
      out[i] = { lat: f[0].lat, lon: f[0].lon };
      continue;
    }
    if (j >= ts.length) {
      out[i] = { lat: f[f.length - 1].lat, lon: f[f.length - 1].lon };
      continue;
    }
    const tLo = ts[j - 1];
    const tHi = ts[j];
    if (tHi - tLo > maxGapS) continue; // real gap: leave null
    const a = tHi === tLo ? 0 : (t - tLo) / (tHi - tLo);
    out[i] = {
      lat: f[j - 1].lat + a * (f[j].lat - f[j - 1].lat),
      lon: f[j - 1].lon + a * (f[j].lon - f[j - 1].lon),
    };
  }
  return out;
}

function scoreEvent(minSepM, dwellS, approached, departed, cfg) {
  const closeness = Math.max(0, 1 - minSepM / cfg.rNearM);
  const dwellTerm = 1 - Math.exp(-dwellS / (cfg.tMinDwellS * 1.5));
  const geom = approached && departed ? 1 : approached || departed ? 0.6 : 0.3;
  const s = 0.5 * closeness + 0.3 * dwellTerm + 0.2 * geom;
  return Math.round(s * 1e4) / 1e4;
}

function median(xs) {
  const v = xs.filter((x) => x != null).sort((p, q) => p - q);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Local planar velocity (east, north metres per second) between two fixes. */
function velocityMps(p0, p1, dt) {
  if (!p0 || !p1 || dt <= 0) return null;
  const meanLat = ((p0.lat + p1.lat) / 2) * (Math.PI / 180);
  const east = (p1.lon - p0.lon) * 111_320 * Math.cos(meanLat);
  const north = (p1.lat - p0.lat) * 111_320;
  return {
    east: east / dt,
    north: north / dt,
    speed: Math.hypot(east, north) / dt,
  };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Rendezvous signature — the observed behavioural geometry that separates a
 * deliberate meet (came together from a distance, held station, parted) from a
 * coincidental drift-by (two entities that were already near and meandered
 * within range). Every term is a measured quantity, surfaced so the operator
 * sees WHY an event scored the way it did. This describes observed behaviour;
 * it still asserts nothing about intent, meaning, or what passed between them.
 */
function rendezvousSignature(grid, pa, pb, d, kMin, nearIdx, cfg) {
  const dt = cfg.gridDtS;
  const holdSet = new Set(nearIdx);
  const holdLo = nearIdx[0];
  const holdHi = nearIdx[nearIdx.length - 1];

  // per-step speeds and hold co-motion
  const speedA = [];
  const speedB = [];
  const holdSpeedA = [];
  const holdSpeedB = [];
  const transitA = [];
  const transitB = [];
  const cosines = [];
  for (let i = 1; i < grid.length; i += 1) {
    const va = velocityMps(pa[i - 1], pa[i], dt);
    const vb = velocityMps(pb[i - 1], pb[i], dt);
    if (va) speedA[i] = va.speed;
    if (vb) speedB[i] = vb.speed;
    const inHold = holdSet.has(i) || holdSet.has(i - 1);
    if (inHold) {
      if (va) holdSpeedA.push(va.speed);
      if (vb) holdSpeedB.push(vb.speed);
      if (va && vb && va.speed > 0.05 && vb.speed > 0.05) {
        const dot = va.east * vb.east + va.north * vb.north;
        cosines.push(dot / (va.speed * vb.speed * dt * dt));
      }
    } else {
      if (va) transitA.push(va.speed);
      if (vb) transitB.push(vb.speed);
    }
  }

  // distance erased on approach, and re-opened on departure
  let closedFromM = 0;
  for (let i = 0; i <= kMin; i += 1)
    if (d[i] != null && d[i] > closedFromM) closedFromM = d[i];
  let openedToM = 0;
  for (let i = kMin; i < grid.length; i += 1)
    if (d[i] != null && d[i] > openedToM) openedToM = d[i];

  const transitSpeed = { a: median(transitA), b: median(transitB) };
  const holdSpeed = { a: median(holdSpeedA), b: median(holdSpeedB) };
  const loiterRatio = {
    a:
      transitSpeed.a > 0.05 && holdSpeed.a != null
        ? holdSpeed.a / transitSpeed.a
        : null,
    b:
      transitSpeed.b > 0.05 && holdSpeed.b != null
        ? holdSpeed.b / transitSpeed.b
        : null,
  };
  const loiteredA = loiterRatio.a != null && loiterRatio.a < cfg.loiterFrac;
  const loiteredB = loiterRatio.b != null && loiterRatio.b < cfg.loiterFrac;
  const stationKeeping = loiteredA && loiteredB;
  const coMotion = cosines.length ? clamp01(median(cosines)) : null;

  // component terms in [0,1]
  const reachTerm = clamp01(1 - Math.exp(-closedFromM / cfg.reachRefM));
  // mutual loiter: governed by whichever entity slowed LEAST; null ratios are
  // treated as "did not demonstrably slow" (neutral-low), never as slowed.
  const rA = loiterRatio.a == null ? 1 : loiterRatio.a;
  const rB = loiterRatio.b == null ? 1 : loiterRatio.b;
  const mutualLoiterTerm = clamp01(1 - Math.max(rA, rB));
  const dwellTerm =
    1 - Math.exp(-(((holdHi - holdLo) * dt + dt) / (cfg.tMinDwellS * 1.5)));
  const closeTerm = clamp01(
    1 - Math.min(...d.filter((x) => x != null)) / cfg.rNearM,
  );

  const strength =
    0.3 * reachTerm +
    0.3 * mutualLoiterTerm +
    0.2 * dwellTerm +
    0.2 * closeTerm;

  return {
    closedFromM: Math.round(closedFromM),
    openedToM: Math.round(openedToM),
    transitSpeedMps: {
      a: transitSpeed.a == null ? null : Math.round(transitSpeed.a * 100) / 100,
      b: transitSpeed.b == null ? null : Math.round(transitSpeed.b * 100) / 100,
    },
    holdSpeedMps: {
      a: holdSpeed.a == null ? null : Math.round(holdSpeed.a * 100) / 100,
      b: holdSpeed.b == null ? null : Math.round(holdSpeed.b * 100) / 100,
    },
    loiterRatio: {
      a: loiterRatio.a == null ? null : Math.round(loiterRatio.a * 100) / 100,
      b: loiterRatio.b == null ? null : Math.round(loiterRatio.b * 100) / 100,
    },
    stationKeeping,
    coMotion: coMotion == null ? null : Math.round(coMotion * 100) / 100,
    strength: Math.round(strength * 1e4) / 1e4,
  };
}

/**
 * Analyze one pair of tracks. Returns a convergence event, or null if the pair
 * does not converge under cfg. The returned object intentionally has no
 * intent/relationship field.
 */
export function analyzePair(a, b, config = {}) {
  const cfg = { ...CONVERGENCE_DEFAULTS, ...config };
  const [aLo, aHi] = span(a);
  const [bLo, bHi] = span(b);
  const tLo = Math.max(aLo, bLo);
  const tHi = Math.min(aHi, bHi);
  if (!(tHi - tLo >= cfg.minOverlapS)) return null;

  const grid = [];
  for (let t = tLo; t <= tHi + 1e-6; t += cfg.gridDtS) grid.push(t);

  const pa = resampleTrack(a, grid, cfg.maxGapS);
  const pb = resampleTrack(b, grid, cfg.maxGapS);

  const d = new Array(grid.length).fill(null);
  let usable = 0;
  for (let i = 0; i < grid.length; i += 1) {
    if (pa[i] && pb[i]) {
      d[i] = metersBetween(pa[i].lat, pa[i].lon, pb[i].lat, pb[i].lon);
      usable += 1;
    }
  }
  if (usable < cfg.minSamples) return null;

  // indices inside rNearM
  const nearIdx = [];
  for (let i = 0; i < grid.length; i += 1) {
    if (d[i] != null && d[i] <= cfg.rNearM) nearIdx.push(i);
  }
  if (nearIdx.length === 0) return null;

  const dwellS =
    (nearIdx[nearIdx.length - 1] - nearIdx[0]) * cfg.gridDtS + cfg.gridDtS;
  if (dwellS < cfg.tMinDwellS) return null;

  // minimum separation
  let kMin = -1;
  let minSep = Infinity;
  for (let i = 0; i < grid.length; i += 1) {
    if (d[i] != null && d[i] < minSep) {
      minSep = d[i];
      kMin = i;
    }
  }

  // approach: separation strictly larger before the minimum; depart: after
  let approached = false;
  for (let i = 0; i < kMin; i += 1) {
    if (d[i] != null) {
      approached = d[i] > minSep + 1;
      break;
    }
  }
  let departed = false;
  for (let i = grid.length - 1; i > kMin; i -= 1) {
    if (d[i] != null) {
      departed = d[i] > minSep + 1;
      break;
    }
  }
  if (cfg.requireApproachDepart && !(approached || departed)) return null;

  const signature = rendezvousSignature(grid, pa, pb, d, kMin, nearIdx, cfg);

  return {
    a: {
      layerKey: a.layerKey,
      id: a.id,
      kind: a.kind ?? null,
      label: a.label ?? null,
    },
    b: {
      layerKey: b.layerKey,
      id: b.id,
      kind: b.kind ?? null,
      label: b.label ?? null,
    },
    tClosest: grid[kMin],
    tStart: grid[nearIdx[0]],
    tEnd: grid[nearIdx[nearIdx.length - 1]],
    minSeparationM: Math.round(minSep * 10) / 10,
    dwellS: Math.round(dwellS * 10) / 10,
    closest: {
      lat: (pa[kMin].lat + pb[kMin].lat) / 2,
      lon: (pa[kMin].lon + pb[kMin].lon) / 2,
    },
    approached,
    departed,
    // score: raw proximity coincidence (how clean the close-approach geometry is)
    score: scoreEvent(minSep, dwellS, approached, departed, cfg),
    // signatureStrength: how strongly the OBSERVED behaviour matches a
    // deliberate rendezvous (came together, held station, parted) rather than a
    // coincidental drift-by. This is the field to gate/rank on to cut
    // coincidences. It describes behaviour, not intent.
    signatureStrength: signature.strength,
    signature,
    samples: usable,
  };
}

/** Spatial + temporal coarse gate → candidate pair indices. */
function candidatePairs(tracks, cfg) {
  const buckets = new Map();
  const pairs = new Set();
  const key = (bx, by) => `${bx}:${by}`;
  // metres-per-degree varies with latitude; a coarse degree bucket is enough
  // for gating and avoids projecting. Convert bucketM to a degree box at the
  // track's mean latitude.
  const degLat = cfg.bucketM / 111_320;
  for (let idx = 0; idx < tracks.length; idx += 1) {
    const bb = bbox(tracks[idx]);
    const meanLat = (bb.latMin + bb.latMax) / 2;
    const degLon =
      cfg.bucketM /
      (111_320 * Math.max(0.05, Math.cos((meanLat * Math.PI) / 180)));
    const bx0 = Math.floor(bb.lonMin / degLon);
    const bx1 = Math.floor(bb.lonMax / degLon);
    const by0 = Math.floor(bb.latMin / degLat);
    const by1 = Math.floor(bb.latMax / degLat);
    for (let bx = bx0 - 1; bx <= bx1 + 1; bx += 1) {
      for (let by = by0 - 1; by <= by1 + 1; by += 1) {
        const here = buckets.get(key(bx, by));
        if (here)
          for (const other of here)
            if (other !== idx)
              pairs.add(idx < other ? `${idx},${other}` : `${other},${idx}`);
      }
    }
    for (let bx = bx0; bx <= bx1; bx += 1) {
      for (let by = by0; by <= by1; by += 1) {
        const k = key(bx, by);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(idx);
      }
    }
  }
  return [...pairs].map((s) => s.split(',').map(Number));
}

/**
 * Detect convergences across a set of tracks.
 * @param {Track[]} tracks  Each track = an entity's fix history.
 * @param {object} [config] Overrides for CONVERGENCE_DEFAULTS.
 * @returns {Array} Convergence events, highest score first.
 */
export function detectConvergences(tracks, config = {}) {
  const cfg = { ...CONVERGENCE_DEFAULTS, ...config };
  const usable = tracks.filter((t) => t.fixes && t.fixes.length >= 2);
  const events = [];
  for (const [i, j] of candidatePairs(usable, cfg)) {
    const [iLo, iHi] = span(usable[i]);
    const [jLo, jHi] = span(usable[j]);
    if (Math.min(iHi, jHi) - Math.max(iLo, jLo) < cfg.minOverlapS) continue;
    const ev = analyzePair(usable[i], usable[j], cfg);
    if (ev) events.push(ev);
  }
  // Rank by rendezvous-signature strength (proximity coincidence breaks ties):
  // a coincidental drift-by can score high on raw proximity but low on
  // signature, so this ordering surfaces deliberate-looking meets first.
  events.sort(
    (x, y) => y.signatureStrength - x.signatureStrength || y.score - x.score,
  );
  return events;
}

/**
 * Recurring rendezvous — group convergence events by the unordered pair and
 * surface pairs that meet REPEATEDLY. Recurrence is the strongest observed
 * signal in this module: one close approach is ambiguous, but the same two
 * entities meeting again and again, at the same place, on a regular cadence, is
 * a pattern no single event can be. Feed it the events from one run, or the
 * concatenated events from many runs across hours or days.
 *
 * Like everything here it reports observed structure, never intent — a
 * recurring meet can be a ferry pair, a pilot boat working a station, a tug and
 * its charge. The engine measures the recurrence; the meaning is the operator's.
 *
 * @param {Array} events  Convergence events (e.g. from detectConvergences).
 * @param {object} [config]
 * @returns {Array} One record per recurring pair, strongest recurrence first.
 */
export function detectRecurringRendezvous(events, config = {}) {
  const cfg = { ...CONVERGENCE_DEFAULTS, ...config };
  const groups = new Map();
  for (const e of events) {
    const idA = `${e.a.layerKey}:${e.a.id}`;
    const idB = `${e.b.layerKey}:${e.b.id}`;
    const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const out = [];
  for (const [key, evs] of groups) {
    if (evs.length < cfg.recurMinOccurrences) continue;
    evs.sort((x, y) => x.tClosest - y.tClosest);
    const times = evs.map((e) => e.tClosest);
    const n = evs.length;

    // cadence: regularity of the gaps between successive meets
    const intervals = [];
    for (let i = 1; i < times.length; i += 1)
      intervals.push(times[i] - times[i - 1]);
    const medianIntervalS = median(intervals);
    let cadenceRegularity = null;
    if (intervals.length >= 2 && medianIntervalS > 0) {
      const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
      const variance =
        intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
      const cv = Math.sqrt(variance) / mean; // coefficient of variation
      cadenceRegularity = clamp01(1 - cv);
    }

    // location spread: how tightly the meet points cluster (same place?)
    const latC = evs.reduce((s, e) => s + e.closest.lat, 0) / n;
    const lonC = evs.reduce((s, e) => s + e.closest.lon, 0) / n;
    const dists = evs.map((e) =>
      metersBetween(latC, lonC, e.closest.lat, e.closest.lon),
    );
    const locationSpreadM = median(dists);

    const meanSignature =
      evs.reduce((s, e) => s + (e.signatureStrength ?? 0), 0) / n;

    // composite recurrence strength in [0,1]
    const countTerm = clamp01(1 - Math.exp(-(n - 1) / 2));
    const locationTerm = clamp01(1 - locationSpreadM / cfg.recurLocRefM);
    const cadenceTerm = cadenceRegularity == null ? 0.5 : cadenceRegularity;
    const strength =
      0.35 * countTerm +
      0.25 * locationTerm +
      0.2 * cadenceTerm +
      0.2 * meanSignature;

    out.push({
      a: evs[0].a,
      b: evs[0].b,
      occurrences: n,
      firstT: times[0],
      lastT: times[times.length - 1],
      spanS: times[times.length - 1] - times[0],
      medianIntervalS:
        medianIntervalS == null ? null : Math.round(medianIntervalS),
      cadenceRegularity:
        cadenceRegularity == null
          ? null
          : Math.round(cadenceRegularity * 100) / 100,
      locationSpreadM: Math.round(locationSpreadM),
      meetPoint: { lat: latC, lon: lonC },
      meanSignatureStrength: Math.round(meanSignature * 1e4) / 1e4,
      recurrenceStrength: Math.round(strength * 1e4) / 1e4,
      events: evs,
    });
  }
  out.sort((x, y) => y.recurrenceStrength - x.recurrenceStrength);
  return out;
}

/**
 * Engine factory mirroring createAnalystEngine: injected providers keep it
 * pure and node-testable. The surface wires getTracks() to the live trail
 * history store; the engine fetches nothing itself.
 * @param {{ getTracks: () => Track[] }} providers
 */
export function createConvergenceEngine(providers) {
  const getTracks = providers?.getTracks;
  if (typeof getTracks !== 'function') {
    throw new TypeError(
      'createConvergenceEngine requires a getTracks() provider',
    );
  }
  const DISCLAIMER =
    'Observed spatiotemporal coincidence only. No meeting, transfer, ' +
    'or relationship is asserted — that judgement is the operator’s.';
  return {
    /** Run detection over the current track snapshot. */
    detect(config = {}) {
      return {
        items: detectConvergences(getTracks(), config),
        disclaimer: DISCLAIMER,
      };
    },
    /**
     * Recurring rendezvous over the current snapshot, or over events supplied
     * from earlier runs (pass { priorEvents } to fold in past windows/days).
     */
    recurring(config = {}) {
      const { priorEvents = [], ...cfg } = config;
      const events = [...priorEvents, ...detectConvergences(getTracks(), cfg)];
      return {
        items: detectRecurringRendezvous(events, cfg),
        disclaimer: DISCLAIMER,
      };
    },
  };
}
