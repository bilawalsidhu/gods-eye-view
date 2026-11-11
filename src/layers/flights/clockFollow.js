/**
 * What the layer drops when the world clock moves it to another time (its
 * source declares a timeline; see src/time/snapshotTimeline.js).
 */
export function createClockFollow({ flightState, parts }) {
  /**
   * Forget how every contact moved, before the snapshot at another time takes
   * the place of every contact: their fixes, courses, floors and the tracked
   * trail belong to the time the clock left.
   */
  function resetMotion() {
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

  /** Drop every contact: the time has none to show, or the clock went live. */
  function clear() {
    if (flightState._trackedIcao)
      parts.tracking._clearTracking(false, { evicted: true });
    resetMotion();
    for (const [icao24, billboard] of flightState._billboards) {
      flightState._billboardCollection?.remove(billboard);
      parts.rendering._releaseModel(icao24);
    }
    flightState._billboards.clear();
    flightState._cullPositions.clear();
    flightState._detectionObjects.clear();
    flightState.feed._count = 0;
    flightState.feed._lastUpdate = null;
  }

  return { resetMotion, clear };
}
