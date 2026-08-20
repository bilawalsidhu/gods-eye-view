/**
 * SGP4 propagation for the satellite layer, and the message protocol the Web Worker
 * speaks. No Cesium and no DOM: this file is the whole of the maths and it runs off the
 * main thread.
 *
 * Elements come from `/api/satellites/elements` as the backend's `Satellite` contract and
 * go straight into `satellite.js`'s `json2satrec`. Nothing here parses or builds a TLE
 * line pair, and nothing should: CelesTrak exhausted the 5-digit catalogue on 2026-07-11,
 * the TLE format has no sixth column for a catalogue number, and every object catalogued
 * since is unrepresentable in it.
 *
 * **The one rule that matters.** SGP4 returns a position in TEME, and turning that into
 * an earth-fixed longitude and latitude is a single rotation about the polar axis by
 * Greenwich Mean Sidereal Time. Propagating to one instant and rotating by the GMST of
 * another moves every satellite the same way, raises no error and produces no NaN: the
 * constellation simply sits somewhere it is not. Measured on the recorded ISS elements, a
 * 60-second mismatch is 0.25068 degrees of longitude, about 27.8 km at the equator, with
 * latitude and altitude untouched. So exactly one function in this file propagates, and it
 * takes one `Date` and uses it for both steps. There is no exported "rotate" step to get
 * wrong.
 *
 * `satellite.js`'s `gstime` and `eciToGeodetic` are used rather than Cesium's
 * `Transforms.computeTemeToPseudoFixedMatrix`, which is the same single rotation and is
 * already installed. The reason is the worker: importing Cesium into a thread that never
 * draws anything would pull a renderer in for one trigonometric identity. `gstime` is
 * already here because the propagator is.
 */

import { eciToGeodetic, gstime, json2satrec, propagate } from 'satellite.js';
import type { OMMJsonObject, SatRec, SatRecError } from 'satellite.js';

import type { Satellite } from '../../types/entities';

const RAD_TO_DEG = 180 / Math.PI;
const KM_TO_M = 1000;
const TWO_PI = 2 * Math.PI;
/** Julian date of the Unix epoch, 1970-01-01T00:00:00Z. */
const UNIX_EPOCH_JD = 2_440_587.5;

/**
 * How old an element set may be before it is dropped rather than drawn: 3.5 days.
 *
 * CelesTrak's own number, mirroring `STALE_EPOCH_AGE_S` in
 * `src/tracker/contracts/satellite.py`. Their `OLDEST` table flag lists objects whose GP
 * data is more than 3.5 days old, and on the active list that is normally fewer than 50 of
 * 10,000-plus.
 *
 * This is the guard that stops the layer presenting stale elements as live while CelesTrak
 * is unreachable. A clean error code is not evidence of a usable position: the recorded
 * ISS elements propagated 365 days past their epoch still return `error = 0` and a
 * plausible 402 km altitude.
 */
export const STALE_EPOCH_AGE_MS = 3.5 * 24 * 60 * 60 * 1000;

/** Samples in one orbit trail. 180 puts the chord error at about a kilometre in low orbit. */
export const ORBIT_TRAIL_SAMPLES = 180;

/**
 * The eleven OMM keywords `json2satrec` actually reads, taken off our domain contract.
 *
 * `OBJECT_NAME` and `OBJECT_ID` are required by the library's type but never read by
 * `json2satrec`, and CelesTrak omits both for analyst objects in the 80000 series, so the
 * fallback is empty rather than invented.
 *
 * The epoch is normalised to a `Z` suffix. `json2satrec` appends a `Z` when the string
 * lacks one, so `...+00:00` becomes `...+00:00Z`, which `new Date()` rejects, and the whole
 * satrec comes back NaN with nothing thrown. Our backend already serialises `Z`; this is
 * here because the cost of being wrong about that is an empty layer with no error.
 */
export function toOmm(record: Satellite): OMMJsonObject {
  return {
    OBJECT_NAME: record.object_name ?? '',
    OBJECT_ID: record.object_id ?? '',
    EPOCH: record.epoch.replace(/\+00:00$/, 'Z'),
    MEAN_MOTION: record.mean_motion,
    ECCENTRICITY: record.eccentricity,
    INCLINATION: record.inclination_deg,
    RA_OF_ASC_NODE: record.ra_of_asc_node_deg,
    ARG_OF_PERICENTER: record.arg_of_pericenter_deg,
    MEAN_ANOMALY: record.mean_anomaly_deg,
    NORAD_CAT_ID: record.norad_cat_id,
    ELEMENT_SET_NO: record.element_set_no,
    BSTAR: record.bstar,
    MEAN_MOTION_DOT: record.mean_motion_dot,
    MEAN_MOTION_DDOT: record.mean_motion_ddot,
  };
}

/**
 * Reused across a whole tick so propagating a thousand satellites allocates nothing.
 *
 * Same trick as the scratch `Cartesian3` in `layers/aircraft.ts`. Private to this module:
 * a caller reads it only immediately after `propagateInto` returned true.
 */
const scratch = { lon: 0, lat: 0, altitudeM: 0 };

/**
 * Propagate one element set to one instant and leave the answer in `scratch`.
 *
 * The only place TEME becomes longitude and latitude. `when` is used for the propagation
 * and for the GMST rotation, which is what makes the 28 km skew described at the top of
 * this file unrepresentable rather than merely discouraged.
 *
 * False means the position was refused, not that it is zero. `communityDecayCheckEnabled`
 * folds in the community check for objects that decayed long ago, which plain SGP4 answers
 * with a confident garbage position instead of an error, so one null check covers both
 * failure modes. On false the caller may read `satrec.error` for the reason, but only
 * straight away: SGP4 mutates it on every propagation of any element set.
 */
function propagateInto(satrec: SatRec, when: Date): boolean {
  const positionAndVelocity = propagate(satrec, when, { communityDecayCheckEnabled: true });
  if (positionAndVelocity === null) {
    return false;
  }
  const geodetic = eciToGeodetic(positionAndVelocity.position, gstime(when));
  const lon = geodetic.longitude * RAD_TO_DEG;
  const lat = geodetic.latitude * RAD_TO_DEG;
  const altitudeM = geodetic.height * KM_TO_M;
  // A finite satrec propagating successfully should not produce a non-finite position, but
  // a NaN reaching a PointPrimitiveCollection draws nothing and reports nothing, so it is
  // checked here rather than discovered on a globe.
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(altitudeM)) {
    return false;
  }
  scratch.lon = lon;
  scratch.lat = lat;
  scratch.altitudeM = altitudeM;
  return true;
}

/** One tick of positions, in the flat form the render layer and `postMessage` both want. */
export interface Positions {
  /**
   * NORAD catalogue numbers, one per drawn satellite.
   *
   * `Int32Array` holds all nine digits the contract allows: the largest analyst number 18
   * SPCS is assigning is above 799,500,000 and the signed 32-bit limit is 2,147,483,647.
   */
  ids: Int32Array;
  /** `[lon, lat, altitudeMetres]` per satellite, in the same order as `ids`. */
  lonLatAlt: Float64Array;
  /** Refused by SGP4 this tick: decayed, or elements it cannot propagate. */
  dropped: number;
  /** Not drawn this tick because the element set is older than 3.5 days. */
  stale: number;
}

interface Loaded {
  satrec: SatRec;
  epochMs: number;
}

/**
 * Holds initialised element sets and answers position queries. One instance per worker.
 *
 * Keyed on the NORAD catalogue number, so two overlapping CelesTrak groups cannot draw the
 * same object twice.
 */
export class SatelliteEngine {
  private readonly loaded = new Map<number, Loaded>();
  private readonly refusals = new Map<SatRecError, number>();

  get size(): number {
    return this.loaded.size;
  }

  /**
   * Why SGP4 refused the element sets it has refused, by `SatRecError` code, since the
   * engine was created. 6 is decayed, 1 mean eccentricity out of range, 2 mean motion below
   * zero, 3 perturbed eccentricity out of range, 4 semi-latus rectum below zero.
   */
  get refusalsByCode(): ReadonlyMap<SatRecError, number> {
    return this.refusals;
  }

  /**
   * Replace the loaded element sets. Anything the backend no longer serves is gone, which
   * is the cheapest decay guard there is: a decayed object stops appearing in its group.
   *
   * A record whose satrec comes back non-finite is rejected and counted rather than kept,
   * because the failure is silent downstream.
   */
  load(records: readonly Satellite[]): { accepted: number; rejected: number } {
    this.loaded.clear();
    let rejected = 0;
    for (const record of records) {
      const satrec = json2satrec(toOmm(record));
      if (!Number.isFinite(satrec.jdsatepoch) || !Number.isFinite(satrec.no)) {
        rejected += 1;
        continue;
      }
      // The epoch is read back off the satrec rather than parsed a second time, so the
      // staleness guard and the propagator cannot disagree about which instant it is.
      const epochMs = (satrec.jdsatepoch - UNIX_EPOCH_JD) * 86_400_000;
      this.loaded.set(record.norad_cat_id, { satrec, epochMs });
    }
    return { accepted: this.loaded.size, rejected };
  }

  /** Every drawable satellite at one instant. */
  positionsAt(when: Date): Positions {
    const capacity = this.loaded.size;
    const ids = new Int32Array(capacity);
    const lonLatAlt = new Float64Array(capacity * 3);
    const atMs = when.getTime();
    let drawn = 0;
    let dropped = 0;
    let stale = 0;

    for (const [noradCatId, entry] of this.loaded) {
      if (atMs - entry.epochMs > STALE_EPOCH_AGE_MS) {
        stale += 1;
        continue;
      }
      if (!propagateInto(entry.satrec, when)) {
        // Read now or never: the next propagation overwrites it.
        this.refusals.set(entry.satrec.error, (this.refusals.get(entry.satrec.error) ?? 0) + 1);
        dropped += 1;
        continue;
      }
      ids[drawn] = noradCatId;
      lonLatAlt[drawn * 3] = scratch.lon;
      lonLatAlt[drawn * 3 + 1] = scratch.lat;
      lonLatAlt[drawn * 3 + 2] = scratch.altitudeM;
      drawn += 1;
    }

    return {
      ids: ids.subarray(0, drawn),
      lonLatAlt: lonLatAlt.subarray(0, drawn * 3),
      dropped,
      stale,
    };
  }

  /**
   * One full revolution of one satellite, centred on `when`, as `[lon, lat, altitudeM]`
   * triples. Null when the object is not loaded, or when any sample will not propagate.
   *
   * All or nothing on purpose: skipping a failed sample would join two points either side
   * of the gap with a chord straight through the earth, which reads as an orbit nobody is
   * in. One revolution takes 2π/n minutes, where `satrec.no` is the mean motion in radians
   * per minute.
   */
  orbitAt(
    noradCatId: number,
    when: Date,
    samples: number = ORBIT_TRAIL_SAMPLES,
  ): Float64Array | null {
    const entry = this.loaded.get(noradCatId);
    if (entry === undefined || samples < 2) {
      return null;
    }
    const periodMs = (TWO_PI / entry.satrec.no) * 60_000;
    const track = new Float64Array(samples * 3);
    for (let index = 0; index < samples; index += 1) {
      const offsetMs = periodMs * (index / (samples - 1) - 0.5);
      if (!propagateInto(entry.satrec, new Date(when.getTime() + offsetMs))) {
        return null;
      }
      track[index * 3] = scratch.lon;
      track[index * 3 + 1] = scratch.lat;
      track[index * 3 + 2] = scratch.altitudeM;
    }
    return track;
  }
}

/** Main thread to worker. */
export type EngineRequest =
  | { type: 'elements'; satellites: Satellite[] }
  | { type: 'positions'; atMs: number }
  | { type: 'orbit'; noradCatId: number; atMs: number };

/** Worker to main thread. */
export type EngineReply =
  | { type: 'elements'; accepted: number; rejected: number }
  | ({ type: 'positions'; atMs: number } & Positions)
  | { type: 'orbit'; noradCatId: number; lonLatAlt: Float64Array | null };

/**
 * The worker's whole behaviour, as a pure function of engine and request.
 *
 * Kept out of `worker.ts` so it is tested in the node test runner rather than only inside a
 * browser thread.
 */
export function handleRequest(engine: SatelliteEngine, request: EngineRequest): EngineReply {
  switch (request.type) {
    case 'elements': {
      const { accepted, rejected } = engine.load(request.satellites);
      return { type: 'elements', accepted, rejected };
    }
    case 'positions': {
      return {
        type: 'positions',
        atMs: request.atMs,
        ...engine.positionsAt(new Date(request.atMs)),
      };
    }
    case 'orbit': {
      return {
        type: 'orbit',
        noradCatId: request.noradCatId,
        lonLatAlt: engine.orbitAt(request.noradCatId, new Date(request.atMs)),
      };
    }
  }
}

/**
 * Buffers to hand over rather than copy.
 *
 * A thousand satellites is a 24 KB position array every frame. Transferred, that costs a
 * pointer; structured-cloned, it costs an allocation and a copy per frame on the main
 * thread, which is the one thread that has to draw.
 */
export function transferables(reply: EngineReply): Transferable[] {
  if (reply.type === 'positions') {
    return [reply.ids.buffer, reply.lonLatAlt.buffer];
  }
  if (reply.type === 'orbit' && reply.lonLatAlt !== null) {
    return [reply.lonLatAlt.buffer];
  }
  return [];
}
