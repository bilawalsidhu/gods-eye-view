import {
  AWARENESS_MOTION_REFRESH_MS,
  AWARENESS_REFRESH_MS,
  AWARENESS_MOTION_SETTLE_MS,
  AWARENESS_REEVALUATE_DISTANCE_M,
} from './policy.js';

export function createModel({ state: layerState, services, parts, source }) {
  const flightsLayer = services.flights;
  const militaryFlightsLayer = services.military;

  /**
   * Whether focusing a Context target may take ownership of the camera.
   * Cockpit owns the camera at 20 Hz, so non-aircraft targets remain selectable
   * there but must not start a competing flyTo animation.
   *
   * @param {string} layerId Context target layer id.
   * @param {HTMLElement|null} [body=document.body] Document body to inspect.
   * @returns {boolean} Whether the target may start a camera flight.
   */

  function contextTargetFlyToAllowed(
    layerId,
    body = globalThis.document?.body,
  ) {
    const nonAircraft =
      layerId === 'ais-live-vessels' || layerId === 'military-installations';
    return !nonAircraft || !body?.classList?.contains('cockpit-mode');
  }

  /**
   * Refresh cadence for the Contacts direction arrows and card readouts.
   *
   * A MOVING camera earns the snappy cadence; a parked one keeps the cheap 750 ms
   * one. This is safe for requestRenderMode because the cadence is applied inside
   * `scene.preRender`: a faster interval can only ever consume frames the camera
   * movement is ALREADY forcing. A parked scene renders no frames at all, so no
   * extra refresh happens and no timer is introduced — the render governor and
   * the idle-leak fix both depend on parked staying quiet.
   * @param {boolean} cameraMoving Whether the camera pose changed since the last frame.
   * @returns {number} Minimum ms between refreshes.
   */

  function awarenessRefreshIntervalMs(cameraMoving) {
    return cameraMoving ? AWARENESS_MOTION_REFRESH_MS : AWARENESS_REFRESH_MS;
  }

  /**
   * Decide, for one rendered frame, whether the view counts as MOVING and whether
   * the Contacts readout may refresh.
   *
   * Motion is HYSTERETIC. The pose signature is quantized (~10 m / ~0.06°), so a
   * slow drag crosses a bin only every few frames: treating a single unchanged
   * frame as "parked" made every crossing look like a motion-end and refreshed at
   * nearly display rate. Motion therefore ends only after the pose has been
   * unchanged for AWARENESS_MOTION_SETTLE_MS, and the motion cadence is a HARD
   * floor in every state — no bin-crossing pattern, and no motion-end settle, can
   * refresh faster than AWARENESS_MOTION_REFRESH_MS.
   *
   * @param {object} input
   * @param {number} input.nowMs This frame's clock.
   * @param {number} input.lastRefreshMs When the readout last refreshed.
   * @param {number} input.lastPoseChangeMs When the camera pose last changed bins.
   * @param {boolean} input.wasMoving Whether the previous frame counted as moving.
   * @returns {{moving: boolean, refresh: boolean}}
   */

  function awarenessRefreshDecision({
    nowMs,
    lastRefreshMs,
    lastPoseChangeMs,
    wasMoving,
  }) {
    const moving = nowMs - lastPoseChangeMs < AWARENESS_MOTION_SETTLE_MS;
    // The single frame where hysteresis expires: settle the readout at rest
    // instead of leaving it up to a parked interval stale.
    const settling = Boolean(wasMoving) && !moving;
    const sinceRefresh = nowMs - lastRefreshMs;
    const refresh =
      sinceRefresh >= awarenessRefreshIntervalMs(true) &&
      (moving || settling || sinceRefresh >= awarenessRefreshIntervalMs(false));
    return { moving, refresh };
  }

  /**
   * Decide whether a source-scoped clear was an eviction rather than a deselect.
   *
   * Both arrive on the same events: the owning layer calls the same teardown for
   * "the user clicked away" and "this contact aged out of the feed". Only the
   * origin separates them, and it matters — a deliberate clear takes the Contact
   * panel down, while an eviction must keep it up in its CONTACT LOST state, or
   * the panel disappears out from under its own PREVIOUS/NEXT controls.
   * @param {{reason?: string}|null} cleared Cleared source detail.
   * @returns {boolean} Whether the subject left the feed on its own.
   */

  function awarenessClearIsEviction(cleared) {
    return cleared?.reason === 'evicted';
  }

  /**
   * Decide whether proximity cohorts need an expensive rescan.
   * @param {object} input Refresh evidence.
   * @param {boolean} input.force Explicit invalidation.
   * @param {boolean} input.hasResults Whether a prior evaluation exists.
   * @param {number} input.movementM Subject displacement since evaluation.
   * @param {boolean} input.sourceRevisionChanged Whether any source state changed.
   * @returns {boolean} Whether cohorts should be evaluated again.
   */

  function awarenessRefreshRequired({
    force,
    hasResults,
    movementM,
    sourceRevisionChanged,
  }) {
    return Boolean(
      force ||
      !hasResults ||
      sourceRevisionChanged ||
      !Number.isFinite(movementM) ||
      movementM >= AWARENESS_REEVALUATE_DISTANCE_M,
    );
  }

  /**
   * The per-layer counts the Contacts panel is showing, as one flat block.
   *
   * Three honest numbers were reaching the operator at once: this cohort count
   * (the panel), `analyst_query`'s count of CURRENTLY-LOADED records, and the
   * layer-wide loaded total in the coverage note. After the camera dives to a
   * tracked contact the flights layer reloads by viewport, so the loaded set can
   * hold a fraction of the cohort — 8 against the panel's 42 in the field. The
   * numbers are all correct and the disagreement still reads as chaos.
   *
   * Derived from the same snapshot the panel renders (`cohort.summary.count` via
   * `buildAwarenessContextSnapshot`), so the two cannot drift apart. A cohort
   * whose feed cannot answer reports 'unknown' rather than a misleading zero.
   * @param {object|null} snapshot `getContextSnapshot()` result.
   * @returns {{centeredOn: string|null, radiusKm: number|null, aircraft: number|string,
   *   flights: number|string, military: number|string, vessels: number|string}|null}
   *   Panel-equivalent counts.
   */

  function contactsWindowFromSnapshot(snapshot) {
    if (!snapshot?.subject) return null;
    const countFor = (cohortId) => {
      const cohort = Array.isArray(snapshot.cohorts)
        ? snapshot.cohorts.find((item) => item?.id === cohortId)
        : null;
      return Number.isFinite(cohort?.count) ? cohort.count : 'unknown';
    };
    const flights = countFor('flights');
    const military = countFor('military');
    return {
      centeredOn: snapshot.subject.label || snapshot.subject.id || null,
      radiusKm: Number.isFinite(snapshot.radiusM)
        ? Math.round(snapshot.radiusM / 1000)
        : null,
      aircraft:
        Number.isFinite(flights) && Number.isFinite(military)
          ? flights + military
          : 'unknown',
      flights,
      military,
      vessels: countFor('ais-live-vessels'),
    };
  }

  /** Build the read-only Awareness snapshot shared with compact HUD consumers. */

  function buildAwarenessContextSnapshot(
    results,
    navigation = {},
    { subjectPresent = true } = {},
  ) {
    if (!results) return null;
    return {
      subject: { ...results.subject },
      // Whether the subject is still reported by its source. The cockpit Contact
      // readout holds its last-known values behind a CONTACT LOST cue when this
      // is false, rather than presenting frozen geometry as a live reading.
      subjectPresent: subjectPresent !== false,
      evaluatedAt: results.evaluatedAt,
      radiusM: results.radiusM,
      cohorts: results.cohorts.map((cohort) => ({
        id: cohort.id,
        label: cohort.label,
        source: cohort.source,
        coverage: cohort.coverage || null,
        relationship: cohort.summary.relationship,
        count: cohort.summary.count,
        reason: cohort.summary.reason,
        nearest: cohort.summary.nearest.slice(),
      })),
      navigation: { ...navigation },
    };
  }

  function navigationState() {
    return {
      canPrevious: layerState.navigationIndex > 0,
      canFocus: Boolean(layerState.subject),
      canNext: parts.navigation.canNavigateNext(),
    };
  }

  /**
   * Whether Contacts genuinely has per-frame work right now.
   *
   * The direction arrows are screen-projected against the camera basis, so they
   * must be redrawn every frame while the view MOVES. Parked, or with no live
   * cohort to point at — nothing selected, every feed empty, every feed failed —
   * there is nothing to animate and Contacts must not be the reason the whole
   * scene keeps repainting.
   * @param {object} [snapshot] Explicit state, for tests.
   * @returns {boolean}
   */

  function awarenessNeedsContinuousRender({
    cameraMoving = layerState.cameraMoving,
    hasSubject = Boolean(layerState.subject),
    hasLiveResults = parts.panel.awarenessResultsAreLive(layerState.results),
  } = {}) {
    return Boolean(cameraMoving && hasSubject && hasLiveResults);
  }

  /**
   * Release any aircraft-owned follow camera before a non-aircraft context
   * selection takes ownership. Both layers are safe no-ops when idle and release
   * Cesium tracking in place, so the subsequent vessel/site framing starts from
   * the current view without the previous aircraft continuing to drag it.
   */

  function releaseAircraftTracking() {
    flightsLayer.stopTracking?.();
    militaryFlightsLayer.stopTracking?.();
  }
  return {
    contextTargetFlyToAllowed,
    awarenessRefreshIntervalMs,
    awarenessRefreshDecision,
    awarenessClearIsEviction,
    awarenessRefreshRequired,
    contactsWindowFromSnapshot,
    buildAwarenessContextSnapshot,
    navigationState,
    awarenessNeedsContinuousRender,
    releaseAircraftTracking,
  };
}
