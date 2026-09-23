import * as Cesium from 'cesium';
import {
  COURSE_HOLD_SPEED_MPS,
  TURN_MIN_SPEED_MPS,
  courseBetweenCartesians,
  courseSlewCapDps,
  estimateTurnRateDps,
  lerpAngleDeg,
  limitCourseStep,
  norm360,
  projectGroundArcLatLon,
  speedRamp,
  staleCoastLimitSeconds,
} from '../../data/motionModel.js';
import {
  LOCAL_ADSB_REANCHOR_AFTER,
  localAdsbFixIsPlausible,
} from '../../sources/adsbRecords.js';
import {
  COURSE_MAX_DPS,
  COURSE_SLEW_DT_MAX_SEC,
  DR_CORRECTION_MS,
} from '../flights/policy.js';

/** Heard positions kept per aircraft for its trail: 10 minutes, 600 fixes. */
export const LOCAL_ADSB_HISTORY_MS = 10 * 60_000;
export const LOCAL_ADSB_HISTORY_POINTS = 600;
/** A display correction larger than this snaps instead of sliding. */
export const LOCAL_ADSB_SNAP_M = 3_000;
/** Chord course uses the newest fix at least this much older than the anchor. */
const CHORD_BASELINE_MS = 2_000;
/** Turn rate is estimated over this window of heard fixes. */
const TURN_WINDOW_MS = 30_000;
/** Coast at least this long past a fix; longer while messages keep coming. */
const COAST_MINIMUM_SEC = 10;
const COAST_CONTACT_GRACE_SEC = 10;
const COAST_MAXIMUM_SEC = 60;
const KT_TO_MPS = 1852 / 3600;
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
const _chordFrom = new Cesium.Cartesian3();
const _chordTo = new Cesium.Cartesian3();

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function chordCourse(from, to) {
  Cesium.Cartesian3.fromDegrees(from.lon, from.lat, 0, undefined, _chordFrom);
  Cesium.Cartesian3.fromDegrees(to.lon, to.lat, 0, undefined, _chordTo);
  return courseBetweenCartesians(_chordFrom, _chordTo);
}

/**
 * Real-time display motion for one locally heard aircraft.
 *
 * Unlike the public flight layers there is no deliberate one-poll display
 * delay: local fixes arrive about once a second, so the marker is
 * extrapolated FORWARD from the newest fix with the shared motion model
 * (constant-rate-turn arc, path-derived course blended over the reported
 * track by speed, rate-limited slew) and a new fix is absorbed by a
 * correction offset that decays over the same window the tracked public
 * flight uses, so the marker never snaps. Every fix also passes the same
 * speed check the decoder applies, which covers decoder-feed records too.
 *
 * Positions are geodetic (degrees, barometric feet); callers add the render
 * datum. The heard history doubles as the selected aircraft's trail.
 */
export class LocalAdsbMotion {
  constructor() {
    /** @type {Array<{at:number, lat:number, lon:number, altitudeFt:number|null,
     *   trackDeg:number|null, speedMps:number|null}>} */
    this.fixes = [];
    this.anchor = null;
    this.correction = null;
    this.courseDeg = null;
    this.lastCourseAt = null;
    this.lastContactAt = null;
    this.rejectStreak = 0;
    this.rejectedFixes = 0;
    // The newest position evaluated, accepted or refused. Re-reading it (the
    // layer re-syncs the same record several times a second) is not a new
    // observation and must not count toward a re-anchor.
    this.lastCandidate = null;
  }

  /**
   * Take a record's newest position. Returns true when it became the new
   * anchor; a repeated, out-of-order or implausible fix returns false.
   * @param {object} record Local ADS-B record.
   * @param {number} nowMs Current epoch ms (display clock).
   * @returns {boolean}
   */
  observe(record, nowMs) {
    if (Number.isFinite(record?.lastMessageAt))
      this.lastContactAt = Math.max(
        this.lastContactAt ?? -Infinity,
        record.lastMessageAt,
      );
    const at = finite(record?.lastPositionAt);
    const lat = finite(record?.lat);
    const lon = finite(record?.lon);
    if (at === null || lat === null || lon === null) return false;
    const newest = this.fixes.at(-1);
    const seen = this.lastCandidate;
    if (newest && at <= newest.at) return false;
    if (seen && at <= seen.at) return false;
    // A decoder feed re-reads the same fix every poll and its rebased time
    // jitters with `seen_pos` rounding: the same position is not a new fix.
    if (seen && !seen.accepted && lat === seen.lat && lon === seen.lon)
      return false;
    if (newest && lat === newest.lat && lon === newest.lon) {
      // Same coordinates, but altitude and velocity may still be newer (a
      // hovering helicopter climbing, an aircraft coming to a stop): update
      // the motion telemetry without adding a trail point.
      this.lastCandidate = { at, lat, lon, accepted: true };
      this.rejectStreak = 0;
      this._refreshTelemetry(record, at, nowMs);
      return false;
    }
    const speedMps = Number.isFinite(record.groundSpeedKt)
      ? Math.max(0, record.groundSpeedKt) * KT_TO_MPS
      : (newest?.speedMps ?? null);
    const fix = {
      at,
      lat,
      lon,
      altitudeFt: finite(record.altitudeFt),
      trackDeg: Number.isFinite(record.trackDeg)
        ? norm360(record.trackDeg)
        : null,
      speedMps,
    };
    if (
      newest &&
      !localAdsbFixIsPlausible(newest, fix, {
        // The last known speed stands in while a record carries none.
        groundSpeedKt: Number.isFinite(speedMps) ? speedMps / KT_TO_MPS : null,
        category: record.category,
      })
    ) {
      this.rejectedFixes += 1;
      this.rejectStreak += 1;
      this.lastCandidate = { at, lat, lon, accepted: false };
      if (this.rejectStreak < LOCAL_ADSB_REANCHOR_AFTER) return false;
      // Three refusals in a row: the stream moved on and the old anchor was
      // the outlier. Restart the history from the new fix.
      this.fixes = [];
      this.correction = null;
    }
    this.rejectStreak = 0;
    this.lastCandidate = { at, lat, lon, accepted: true };

    const before = this.anchor ? this.displayAt(nowMs, { slew: false }) : null;
    this.fixes.push(fix);
    this._trimHistory(at);
    this.anchor = this._anchorFrom(fix, record);
    this._absorb(before, nowMs);
    return true;
  }

  /**
   * Apply a newer record's altitude, speed, track and vertical rate to the
   * current anchor when its position has not changed.
   */
  _refreshTelemetry(record, at, nowMs) {
    const anchor = this.anchor;
    const newest = this.fixes.at(-1);
    if (!anchor || !newest) return;
    const altitudeFt = finite(record.altitudeFt) ?? anchor.altitudeFt;
    const speedMps = Number.isFinite(record.groundSpeedKt)
      ? Math.max(0, record.groundSpeedKt) * KT_TO_MPS
      : anchor.speedMps;
    const trackDeg = Number.isFinite(record.trackDeg)
      ? norm360(record.trackDeg)
      : anchor.trackDeg;
    const verticalRateFpm = finite(record.verticalRateFpm);
    if (
      altitudeFt === anchor.altitudeFt &&
      speedMps === anchor.speedMps &&
      trackDeg === anchor.trackDeg &&
      verticalRateFpm === anchor.verticalRateFpm
    )
      return;
    const before = this.displayAt(nowMs, { slew: false });
    // The trail point keeps its heard position; the anchor takes the newer
    // telemetry, with altitude extrapolated from when it was reported.
    this.anchor = {
      ...this._anchorFrom(
        { ...newest, altitudeFt, speedMps, trackDeg },
        { verticalRateFpm },
      ),
      altitudeAt: at,
    };
    this._absorb(before, nowMs);
  }

  /** Slide from where the marker was drawn to the new anchor, or snap. */
  _absorb(before, nowMs) {
    if (before) {
      const after = this._raw(nowMs);
      const cosLat = Math.cos(after.lat * DEG);
      const north = (before.lat - after.lat) * DEG * EARTH_RADIUS_M;
      const east = (before.lon - after.lon) * DEG * EARTH_RADIUS_M * cosLat;
      const up =
        Number.isFinite(before.altitudeFt) && Number.isFinite(after.altitudeFt)
          ? before.altitudeFt - after.altitudeFt
          : 0;
      this.correction =
        Math.hypot(north, east) > LOCAL_ADSB_SNAP_M
          ? null
          : { east, north, upFt: up, startAt: nowMs };
    }
  }

  _trimHistory(newestAt) {
    let drop = 0;
    while (
      drop < this.fixes.length - 1 &&
      (newestAt - this.fixes[drop].at > LOCAL_ADSB_HISTORY_MS ||
        this.fixes.length - drop > LOCAL_ADSB_HISTORY_POINTS)
    )
      drop += 1;
    if (drop) this.fixes.splice(0, drop);
  }

  _anchorFrom(fix, record) {
    let chord = null;
    for (let index = this.fixes.length - 2; index >= 0; index -= 1) {
      if (fix.at - this.fixes[index].at < CHORD_BASELINE_MS) continue;
      chord = chordCourse(this.fixes[index], fix);
      break;
    }
    let courseDeg = fix.trackDeg;
    if (chord !== null)
      courseDeg =
        courseDeg === null
          ? chord
          : lerpAngleDeg(courseDeg, chord, speedRamp(fix.speedMps));
    const samples = [];
    let lastSampleAt = -Infinity;
    for (const sample of this.fixes) {
      if (fix.at - sample.at > TURN_WINDOW_MS) continue;
      if (sample.at - lastSampleAt < CHORD_BASELINE_MS) continue;
      lastSampleAt = sample.at;
      samples.push({
        tSec: sample.at / 1000,
        trackDeg: sample.trackDeg,
        speedMps: sample.speedMps,
      });
    }
    return {
      ...fix,
      courseDeg,
      turnRateDps: estimateTurnRateDps(
        samples,
        undefined,
        undefined,
        TURN_MIN_SPEED_MPS,
      ),
      verticalRateFpm: finite(record.verticalRateFpm),
    };
  }

  _coastSeconds(nowMs) {
    const anchor = this.anchor;
    const limit = staleCoastLimitSeconds({
      fixEpochMs: anchor.at,
      lastContactEpochMs: this.lastContactAt,
      minimumSec: COAST_MINIMUM_SEC,
      contactGraceSec: COAST_CONTACT_GRACE_SEC,
      maximumSec: COAST_MAXIMUM_SEC,
    });
    return Math.min(limit, Math.max(0, (nowMs - anchor.at) / 1000));
  }

  _raw(nowMs) {
    const anchor = this.anchor;
    const dtSec = this._coastSeconds(nowMs);
    const moving =
      Number.isFinite(anchor.speedMps) &&
      anchor.speedMps >= COURSE_HOLD_SPEED_MPS &&
      Number.isFinite(anchor.courseDeg);
    const projected = moving
      ? projectGroundArcLatLon(
          anchor.lat,
          anchor.lon,
          anchor.courseDeg,
          anchor.speedMps,
          anchor.turnRateDps,
          dtSec,
        )
      : { lat: anchor.lat, lon: anchor.lon };
    const altitudeDtSec = Number.isFinite(anchor.altitudeAt)
      ? Math.min(dtSec, Math.max(0, (nowMs - anchor.altitudeAt) / 1000))
      : dtSec;
    const altitudeFt =
      Number.isFinite(anchor.altitudeFt) &&
      Number.isFinite(anchor.verticalRateFpm)
        ? anchor.altitudeFt + (anchor.verticalRateFpm * altitudeDtSec) / 60
        : anchor.altitudeFt;
    return {
      lat: projected.lat,
      lon: projected.lon,
      altitudeFt,
      courseDeg: moving
        ? norm360(anchor.courseDeg + anchor.turnRateDps * dtSec)
        : null,
      speedMps: anchor.speedMps,
    };
  }

  /**
   * Where to draw the aircraft now.
   * @param {number} nowMs Current epoch ms.
   * @param {{slew?: boolean}} [options] `slew: false` reads without advancing
   *   the rate-limited course.
   * @returns {{lat:number, lon:number, altitudeFt:number|null,
   *   courseDeg:number|null}|null}
   */
  displayAt(nowMs, { slew = true } = {}) {
    if (!this.anchor) return null;
    const raw = this._raw(nowMs);
    const correction = this.correction;
    if (correction) {
      const weight = 1 - (nowMs - correction.startAt) / DR_CORRECTION_MS;
      if (weight <= 0) this.correction = null;
      else {
        const w = Math.min(1, weight);
        raw.lat += (correction.north * w) / EARTH_RADIUS_M / DEG;
        raw.lon +=
          (correction.east * w) /
          (EARTH_RADIUS_M * Math.max(1e-6, Math.cos(raw.lat * DEG))) /
          DEG;
        if (Number.isFinite(raw.altitudeFt))
          raw.altitudeFt += correction.upFt * w;
      }
    }
    let courseDeg = this.courseDeg;
    // Hover and taxi noise: below the hold speed the course is not updated.
    const target =
      raw.courseDeg ?? (courseDeg === null ? this.anchor.trackDeg : null);
    if (slew && target !== null) {
      const dtSec =
        this.lastCourseAt === null
          ? 0
          : Math.min(
              COURSE_SLEW_DT_MAX_SEC,
              Math.max(0, (nowMs - this.lastCourseAt) / 1000),
            );
      courseDeg = limitCourseStep(
        courseDeg,
        target,
        courseSlewCapDps(raw.speedMps, COURSE_MAX_DPS),
        dtSec,
      );
      this.courseDeg = courseDeg;
      this.lastCourseAt = nowMs;
    } else if (courseDeg === null && target !== null) {
      courseDeg = target;
    }
    return {
      lat: raw.lat,
      lon: raw.lon,
      altitudeFt: raw.altitudeFt,
      courseDeg,
    };
  }
}
