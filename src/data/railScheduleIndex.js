/**
 * @module railScheduleIndex
 * @description Server-side lookup over a schedule pack (the
 * `<feedId>.schedule.json` scripts/build-rail-paths.mjs writes) for a
 * realtime source that names a train by its number (Irish Rail's train
 * codes): `createRunIndex`, the dated runs of a pack's trips, so a reported
 * train takes the trip it is on (its line and stops). The train's position
 * is never taken from the timetable.
 *
 * Pure: no I/O. Times are epoch milliseconds; a run starts at the service
 * day's GTFS origin (noon minus 12 h in the pack's time zone) plus the
 * trip's start, and lasts its profile's last offset, as
 * src/data/railSchedule.js reads them.
 */

import { serviceDayOriginMs } from './railTimeZones.js';

function packTrips(raw) {
  return raw?.trips && typeof raw.trips === 'object' ? raw.trips : {};
}

function packServices(raw) {
  return raw?.services && typeof raw.services === 'object' ? raw.services : {};
}

function serviceDates(services, service) {
  const dates = services[service];
  return Array.isArray(dates) ? dates : [];
}

/**
 * The dated runs of a pack's trips. Built lazily per trip, so a source that
 * looks up a few hundred train numbers never expands the whole pack. It
 * keeps the parts of the pack it reads (trips, profiles, services), not the
 * pack itself.
 * @param {object} raw Decoded schedule pack.
 * @returns {{runsOf: (tripId: string) => Array<{tripId: string, date: string,
 *     startMs: number, endMs: number}>,
 *   tripsNamed: (name: string) => string[],
 *   activeTrip: (name: string, nowMs: number,
 *     options?: {slackMs?: number, delayMs?: number}) =>
 *     ({tripId: string, date: string, startMs: number, endMs: number}|null)}}
 */
export function createRunIndex(raw) {
  const trips = packTrips(raw);
  const services = packServices(raw);
  const zone = typeof raw?.timezone === 'string' ? raw.timezone : 'UTC';
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const origins = new Map();
  const originOf = (date) => {
    let origin = origins.get(date);
    if (origin === undefined) {
      origin = serviceDayOriginMs(date, zone);
      origins.set(date, origin);
    }
    return origin;
  };
  let names = null;
  const runs = new Map();
  function runsOf(tripId) {
    let list = runs.get(tripId);
    if (list) return list;
    list = [];
    const trip = Object.hasOwn(trips, tripId) ? trips[tripId] : null;
    const profile = trip ? profiles[trip.profile] : null;
    if (trip && Array.isArray(profile) && Number.isFinite(trip.startSec)) {
      const durationMs = (Number(profile[profile.length - 1]) || 0) * 1000;
      for (const date of serviceDates(services, trip.service)) {
        const origin = originOf(date);
        if (!Number.isFinite(origin)) continue;
        const startMs = origin + trip.startSec * 1000;
        list.push({ tripId, date, startMs, endMs: startMs + durationMs });
      }
    }
    runs.set(tripId, list);
    return list;
  }
  return {
    runsOf,
    tripsNamed(name) {
      if (!names) {
        names = new Map();
        for (const [tripId, trip] of Object.entries(trips)) {
          if (typeof trip?.name !== 'string' || !trip.name) continue;
          const list = names.get(trip.name);
          if (list) list.push(tripId);
          else names.set(trip.name, [tripId]);
        }
      }
      return names.get(String(name ?? '')) ?? [];
    },
    /**
     * The run of a train number that is under way at `nowMs` (or within
     * `slackMs` of its start or end); the one whose span is nearest when
     * several qualify, null when none or when two tie. A train running
     * `delayMs` late (negative: early) is where its timetable was that long
     * ago, so its runs are compared at `nowMs - delayMs`.
     */
    activeTrip(name, nowMs, { slackMs = 10 * 60_000, delayMs = 0 } = {}) {
      const at = nowMs - (Number.isFinite(delayMs) ? delayMs : 0);
      let best = null;
      let bestScore = Infinity;
      let tie = false;
      for (const tripId of this.tripsNamed(name)) {
        for (const run of runsOf(tripId)) {
          if (at < run.startMs - slackMs || at > run.endMs + slackMs) continue;
          const score =
            at < run.startMs
              ? run.startMs - at
              : at > run.endMs
                ? at - run.endMs
                : 0;
          if (score < bestScore) {
            best = run;
            bestScore = score;
            tie = false;
          } else if (score === bestScore && best && run.tripId !== best.tripId)
            tie = true;
        }
      }
      return tie ? null : best;
    },
  };
}
