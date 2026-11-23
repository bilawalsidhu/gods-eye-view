/**
 * Sky view "Next passes". Pure, Cesium-free and DOM-free: it
 * runs inside the satellite worker (satWorker.js drives it a slice at a time
 * so ticks keep flowing) and in node tests.
 *
 * Every pass comes from the existing findNextSatellitePass() in
 * src/data/satellitePass.js (imported, never copied): coarse scan at
 * PASS_COARSE_STEP_SEC, bisected rise/set, parabolic peak, `visible` = some
 * part sunlit under a dark sky (Sun <= -6 deg). This module only adds:
 *   - which objects are scanned: the stations + visual groups (about 180),
 *     after a geometric prefilter (passReachable: an orbit whose ground track
 *     never comes within the horizon reach of the observer's latitude cannot
 *     pass, inclination vs latitude plus the apogee horizon circle), and
 *     without near-geosynchronous objects (they hang in the sky, no passes);
 *   - set/peak azimuths, a brightness ESTIMATE (brightness.js) at the
 *     brightest sunlit sample, and the pass arc sampled every ARC_STEP_SEC;
 *   - merging the identical passes of docked modules (ISS ZARYA/NAUKA...);
 *   - the cache rule: results stay valid until the TLE data the scan used
 *     changes, the observer moves more than OBSERVER_MOVE_KM, or Sky time
 *     leaves the first RESCAN_AFTER_MS of the 48 h window.
 */
import { gstime } from 'satellite.js';
import {
  findNextSatellitePass,
  isObserverDark,
  isSatelliteSunlit,
  lookAnglesAt,
  solarPositionECI,
} from '../data/satellitePass.js';
import { estimateMagnitude, phaseAngleDeg } from './brightness.js';
import { ISS_NORAD, observerEci } from './satCore.js';

export const PASS_HOURS = 48;
export const PASS_MIN_ELEV_DEG = 10;
export const PASS_COARSE_STEP_SEC = 30;
export const PASS_FINE_STEP_SEC = 5;
export const ARC_STEP_SEC = 10;
export const OBSERVER_MOVE_KM = 50;
/** Rescan once Sky time is this far into the 48 h window (or before it). */
export const RESCAN_AFTER_MS = 24 * 3600_000;
/** Groups the panel scans (by dedupe tag, see satCore SKY_CORE_GROUPS). */
export const PASS_GROUPS = Object.freeze(['stations', 'visual']);
/** Below this many revolutions a day an object does not "pass" (GEO-like). */
export const MIN_REVS_PER_DAY = 1.5;

const D2R = Math.PI / 180;
const SGP4_RADIUS_KM = 6378.135;
const R_MIN_KM = 6356.75;
const EARTH_MEAN_KM = 6371.0088;
const REACH_MARGIN_RAD = 1 * D2R;

/** Revolutions per day of a satrec (no is rad/min). */
export function revsPerDay(satrec) {
  return ((Number(satrec?.no) || 0) * 1440) / (2 * Math.PI);
}

/**
 * Geometric prefilter: false when the orbit can never rise above
 * `minElevDeg` for an observer at `latDeg`. The ground track reaches
 * latitudes up to the inclination (180 - i when retrograde); from apogee the
 * satellite is above minElev within a central angle lambda of the observer,
 * so the observer must sit within maxLat + lambda (+1 deg margin, polar Earth
 * radius for the widest circle). Conservative: it never rejects a pass.
 */
export function passReachable(satrec, latDeg, minElevDeg = PASS_MIN_ELEV_DEG) {
  const inc = Number(satrec?.inclo);
  const e = Math.min(Math.max(Number(satrec?.ecco) || 0, 0), 0.99);
  const apoKm = (Number(satrec?.a) || 0) * SGP4_RADIUS_KM * (1 + e);
  if (!Number.isFinite(inc) || !(apoKm > R_MIN_KM)) return false;
  const maxLat = inc <= Math.PI / 2 ? inc : Math.PI - inc;
  const el = minElevDeg * D2R;
  const lambda = Math.acos(Math.min(1, (R_MIN_KM * Math.cos(el)) / apoKm)) - el;
  return Math.abs(Number(latDeg) * D2R) <= maxLat + lambda + REACH_MARGIN_RAD;
}

/** Object scanned by the passes panel: stations/visual and not GEO-like. */
export function isPassCandidate(entry) {
  return (
    Boolean(entry?.satrec) &&
    PASS_GROUPS.includes(entry.group) &&
    revsPerDay(entry.satrec) >= MIN_REVS_PER_DAY
  );
}

/** ISS first, then stations, then visual; NORAD id breaks ties. */
export function passScanOrder(a, b) {
  const rank = (e) =>
    e.noradId === ISS_NORAD ? 0 : e.group === 'stations' ? 1 : 2;
  return rank(a) - rank(b) || a.noradId - b.noradId;
}

/** Great-circle distance between two observers (km). */
export function observerDistanceKm(a, b) {
  if (!a || !b) return Infinity;
  const p1 = a.latDeg * D2R;
  const p2 = b.latDeg * D2R;
  const dp = p2 - p1;
  const dl = (b.lonDeg - a.lonDeg) * D2R;
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * EARTH_MEAN_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  return Number.isFinite(d) ? d : Infinity;
}

/** True while a finished/running scan still answers a request. */
export function passCacheValid(cache, { key, observer, timeMs }) {
  if (!cache || cache.key !== key) return false;
  if (observerDistanceKm(cache.observer, observer) > OBSERVER_MOVE_KM)
    return false;
  const t = Number(timeMs);
  return t >= cache.fromMs && t <= cache.fromMs + RESCAN_AFTER_MS;
}

/**
 * Start of the 48 h window a scan asked at `timeMs` covers. Forward (live,
 * jumps, forward play) starts at `timeMs`. While Sky time runs BACKWARDS the
 * window starts RESCAN_AFTER_MS earlier, so `timeMs` sits at the late edge
 * of the cache rule: the scan stays valid for the next 24 h of reverse play
 * and still lists >= 24 h ahead of every time in that span (the same
 * guarantee a forward scan gives). A forward-anchored window would be left
 * by the very next reverse tick.
 */
export function passScanStart(timeMs, { backward = false } = {}) {
  const t = Number(timeMs);
  return backward ? t - RESCAN_AFTER_MS : t;
}

/**
 * How well a pass list scanned from `fromMs` answers "next passes" at
 * `timeMs`: 'none' (no scan yet), 'gap' (time is before the window: passes
 * between it and the window start are unknown), 'short' (past the cache
 * rule: under 24 h ahead is known, a rescan is due) or 'ok'.
 */
export function passCoverage(fromMs, timeMs) {
  if (fromMs == null || !Number.isFinite(fromMs)) return 'none';
  const t = Number(timeMs);
  if (t < fromMs) return 'gap';
  if (t > fromMs + RESCAN_AFTER_MS) return 'short';
  return 'ok';
}

/** One sample of a pass: look angles, sunlit, dark sky, estimate. */
export function passSample(entry, timeMs, observer) {
  const look = lookAnglesAt(
    entry.satrec,
    timeMs,
    observer.latDeg,
    observer.lonDeg,
  );
  if (!look) return null;
  const sunlit = isSatelliteSunlit(look.satECI, timeMs);
  const dark = isObserverDark(observer.latDeg, observer.lonDeg, timeMs);
  let estMag = null;
  let rangeKm = NaN;
  if (observer.ecf) {
    const o = observerEci(observer, gstime(new Date(timeMs))).r;
    rangeKm = Math.hypot(
      look.satECI.x - o.x,
      look.satECI.y - o.y,
      look.satECI.z - o.z,
    );
    if (sunlit && entry.rcsM2 != null)
      estMag = estimateMagnitude({
        noradId: entry.noradId,
        rcsM2: entry.rcsM2,
        rangeKm,
        phaseDeg: phaseAngleDeg(look.satECI, o, solarPositionECI(timeMs)),
      });
  }
  return {
    timeMs,
    azDeg: look.azDeg,
    elDeg: look.elevDeg,
    rangeKm,
    sunlit,
    dark,
    estMag,
  };
}

/** Pass arc samples every `stepSec` from rise to set (both included). */
export function passArc(
  entry,
  observer,
  riseMs,
  setMs,
  stepSec = ARC_STEP_SEC,
) {
  const out = [];
  const step = Math.max(1, stepSec) * 1000;
  for (let t = riseMs; ; t += step) {
    const at = Math.min(t, setMs);
    const s = passSample(entry, at, observer);
    if (s) out.push(s);
    if (at >= setMs) break;
  }
  return out;
}

/** Compact arc for postMessage: [azDeg, elDeg, sunlit 0/1, timeMs] rows. */
export const packArc = (samples) =>
  samples.map((s) => [s.azDeg, s.elDeg, s.sunlit ? 1 : 0, s.timeMs]);

/**
 * Panel row for one pass found by findNextSatellitePass(). `estMag` is the
 * brightest estimate over the arc samples that are sunlit (and under a dark
 * sky when the pass is VISIBLE); null without an RCS or a sunlit sample.
 */
export function describePass(
  entry,
  pass,
  observer,
  { fromMs = -Infinity } = {},
) {
  const arc = passArc(entry, observer, pass.riseMs, pass.setMs);
  const peak = passSample(entry, pass.maxElevMs, observer);
  const set = passSample(entry, pass.setMs, observer);
  let estMag = null;
  for (const s of [...arc, peak]) {
    if (!s || s.estMag == null || !s.sunlit) continue;
    if (pass.visible && !s.dark) continue;
    if (s.elDeg < PASS_MIN_ELEV_DEG - 1e-6) continue;
    if (estMag == null || s.estMag < estMag) estMag = s.estMag;
  }
  return {
    index: entry.index,
    noradId: entry.noradId,
    name: entry.name,
    klass: entry.klass,
    group: entry.group,
    riseMs: pass.riseMs,
    riseAzDeg: pass.riseAzDeg,
    peakMs: pass.maxElevMs,
    peakElevDeg: pass.maxElevDeg,
    peakAzDeg: peak ? peak.azDeg : NaN,
    setMs: pass.setMs,
    setAzDeg: set ? set.azDeg : NaN,
    visible: pass.visible,
    sunlitAtPeak: pass.sunlit,
    darkAtPeak: pass.observerDark,
    estMag,
    inProgress: pass.riseMs <= fromMs,
    alsoNames: [],
    alsoIds: [],
  };
}

/** Every pass of one object in [fromMs, fromMs + hours). */
export function passesForEntry(
  entry,
  observer,
  fromMs,
  {
    hours = PASS_HOURS,
    minElevDeg = PASS_MIN_ELEV_DEG,
    coarseStepSec = PASS_COARSE_STEP_SEC,
    fineStepSec = PASS_FINE_STEP_SEC,
  } = {},
) {
  const out = [];
  const end = fromMs + hours * 3600_000;
  let cursor = fromMs;
  while (cursor < end) {
    const pass = findNextSatellitePass({
      satrec: entry.satrec,
      latDeg: observer.latDeg,
      lonDeg: observer.lonDeg,
      fromMs: cursor,
      minElevDeg,
      horizonHours: Math.min(72, (end - cursor) / 3600_000),
      coarseStepSec,
      fineStepSec,
    });
    if (!pass || pass.riseMs >= end) break;
    // findNextSatellitePass never lists a pass whose peak misses minElev,
    // but a pass cut by the window end can; keep the rule explicit.
    if (pass.maxElevDeg >= minElevDeg)
      out.push(describePass(entry, pass, observer, { fromMs }));
    if (pass.setMs >= end) break;
    cursor = Math.max(pass.setMs, cursor) + coarseStepSec * 1000;
  }
  return out;
}

/**
 * Merge passes of objects that fly together (docked modules): same rise,
 * set and peak within a few seconds / a fraction of a degree. The ISS, then
 * an object with an estimate, then the lower NORAD id is kept; the others'
 * names/ids go to `alsoNames`/`alsoIds`.
 */
export function mergeDockedPasses(passes) {
  const sorted = [...passes].sort(
    (a, b) => a.riseMs - b.riseMs || a.noradId - b.noradId,
  );
  const kept = [];
  const better = (a, b) =>
    (b.noradId === ISS_NORAD) - (a.noradId === ISS_NORAD) ||
    (b.estMag != null) - (a.estMag != null) ||
    a.noradId - b.noradId;
  for (const p of sorted) {
    const twin = kept.find(
      (k) =>
        Math.abs(k.riseMs - p.riseMs) <= 15_000 &&
        Math.abs(k.setMs - p.setMs) <= 15_000 &&
        Math.abs(k.peakElevDeg - p.peakElevDeg) <= 0.5,
    );
    if (!twin) {
      kept.push({
        ...p,
        alsoNames: [...(p.alsoNames || [])],
        alsoIds: [...(p.alsoIds || [])],
      });
      continue;
    }
    if (better(p, twin) < 0) {
      const names = [twin.name, ...twin.alsoNames];
      const ids = [twin.noradId, ...twin.alsoIds];
      Object.assign(twin, p, { alsoNames: names, alsoIds: ids });
    } else {
      twin.alsoNames.push(p.name);
      twin.alsoIds.push(p.noradId);
    }
  }
  return kept.sort((a, b) => a.riseMs - b.riseMs || a.noradId - b.noradId);
}

/**
 * A resumable 48 h scan over the catalogue entries (worker side). step()
 * scans one object and returns its passes (null when done).
 */
export function createPassScan({
  entries,
  observer,
  fromMs,
  hours = PASS_HOURS,
  minElevDeg = PASS_MIN_ELEV_DEG,
  coarseStepSec = PASS_COARSE_STEP_SEC,
}) {
  const candidates = (entries || []).filter(isPassCandidate);
  const queue = candidates
    .filter((e) => passReachable(e.satrec, observer.latDeg, minElevDeg))
    .sort(passScanOrder);
  const found = [];
  let next = 0;
  let scanned = 0;
  return {
    total: queue.length,
    candidates: candidates.length,
    prefiltered: candidates.length - queue.length,
    fromMs,
    observer,
    get processed() {
      return scanned;
    },
    get done() {
      return next >= queue.length;
    },
    step() {
      if (next >= queue.length) return null;
      const entry = queue[next++];
      const rows = passesForEntry(entry, observer, fromMs, {
        hours,
        minElevDeg,
        coarseStepSec,
      });
      scanned += 1;
      found.push(...rows);
      return rows;
    },
    passes: () => mergeDockedPasses(found),
  };
}

/** First pass of `noradId` not yet over at `timeMs` (optionally VISIBLE). */
export function nextPassOf(
  passes,
  noradId,
  timeMs,
  { visibleOnly = false } = {},
) {
  let best = null;
  for (const p of passes || []) {
    if (p.noradId !== noradId && !(p.alsoIds || []).includes(noradId)) continue;
    if (!(p.setMs > timeMs)) continue;
    if (visibleOnly && !p.visible) continue;
    if (!best || p.riseMs < best.riseMs) best = p;
  }
  return best;
}

/**
 * Rows for the panel: not over yet at `timeMs`, VISIBLE only when the
 * naked-eye filter is on, soonest first.
 */
export function upcomingPasses(
  passes,
  timeMs,
  { visibleOnly = true, limit = 12 } = {},
) {
  return (passes || [])
    .filter((p) => p.setMs > timeMs && (!visibleOnly || p.visible))
    .sort((a, b) => a.riseMs - b.riseMs || a.noradId - b.noradId)
    .slice(0, limit);
}
