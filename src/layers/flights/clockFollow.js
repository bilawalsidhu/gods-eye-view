import { forgetPlacedAircraft } from './placed.js';

/**
 * What the layer drops when the world clock moves it to another time (its
 * source declares a timeline; see src/time/snapshotTimeline.js).
 */
export function createClockFollow({ flightState, services, parts }) {
  /**
   * Forget how every contact moved, before the snapshot at another time takes
   * the place of every contact: their fixes, courses, floors and the tracked
   * trail belong to the time the clock left.
   */
  function resetMotion() {
    forgetPlacedAircraft(
      services?.placement,
      flightState._positionHistory.keys(),
    );
    flightState.records.reset();
    flightState._positionHistory.clear();
    flightState._displayCourse.clear();
    flightState._groundSnap.clear();
    flightState._displayFloorState.clear();
    flightState._drReconcileValid = false;
    flightState._cachedDRFrame = -1;
    flightState._cachedDRPosition = null;
    parts.tracking._clearTrail();
    flightState._lastCamPoseSig = '';
  }

  /**
   * The contacts drawn now that the first live snapshot after the clock came
   * back to live lacks (the tracked one too): the snapshot judges them as a
   * poll judges any absence (see the snapshot renderer).
   * @param {{records: Array<{id: string}>}} snapshot
   * @returns {Set<string>}
   */
  function absentAtHandover(snapshot) {
    const present = new Set(snapshot.records.map((record) => record.id));
    const drawn = [...(flightState._icons?.ids() ?? [])];
    if (flightState._trackedIcao) drawn.push(flightState._trackedIcao);
    return new Set(drawn.filter((id) => !present.has(id)));
  }

  /**
   * Back at live: forget how every contact moved, as at a jump, but keep the
   * tracked trail, and keep the contacts `kept` (absentAtHandover) as they
   * were: their record, fixes and course. Each was last seen at its newest
   * fix, not when it was loaded, so absence judges how old it really is.
   * @param {Set<string>} kept
   */
  function handOverMotion(kept) {
    const held = [];
    for (const id of kept)
      held.push([
        id,
        flightState.records.data.get(id),
        flightState._positionHistory.get(id),
        flightState._displayCourse.get(id),
      ]);
    forgetPlacedAircraft(
      services?.placement,
      [...flightState._positionHistory.keys()].filter((id) => !kept.has(id)),
    );
    flightState.records.reset();
    flightState._positionHistory.clear();
    flightState._displayCourse.clear();
    flightState._groundSnap.clear();
    flightState._displayFloorState.clear();
    flightState._drReconcileValid = false;
    flightState._cachedDRFrame = -1;
    flightState._cachedDRPosition = null;
    flightState._lastCamPoseSig = '';
    for (const [id, meta, history, course] of held) {
      if (meta)
        flightState.records.data.set(id, {
          ...meta,
          observedReceiptMs: meta.newestFixMs ?? meta.observedReceiptMs,
        });
      if (history) flightState._positionHistory.set(id, history);
      if (course !== undefined) flightState._displayCourse.set(id, course);
    }
  }

  /** Drop every contact: the time has none to show, or the clock went live. */
  function clear() {
    if (flightState._trackedIcao)
      parts.tracking._clearTracking(false, { evicted: true });
    resetMotion();
    // Each contact's icon row and 3D model go with it.
    for (const icao24 of [...(flightState._icons?.ids() ?? [])])
      parts.icons._forgetContact(icao24);
    flightState._detectionObjects.clear();
    flightState.feed._count = 0;
    flightState.feed._lastUpdate = null;
  }

  return { resetMotion, absentAtHandover, handOverMotion, clear };
}
