import { AMBER_TRANSPARENT, TRACKED_ICON_COLOR } from './policy.js';

export function createTesting({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  /**
   * Seed only the mutable state needed to exercise tracked-card refreshes through
   * the production military poll reconciler. Tests still call
   * `militaryFlightsLayer.update()` rather than invoking the writer directly.
   * @param {object} state
   * @param {string} state.icao24
   * @param {object} state.entity
   * @param {object} state.meta
   * @param {object} state.billboard
   * @param {object} state.billboardCollection
   * @param {object} state.viewer
   * @param {Array<Object>} [state.history=[]]
   * @param {boolean} [state.tracked=true]
   * @param {Iterable<[string, object]>} [state.models=[]] - Fleet 3D models keyed
   *   by icao24, for the billboard-hidden/model-shown handoff state.
   */

  function _setTrackedMilitaryRefreshStateForTest({
    icao24,
    entity,
    meta,
    billboard,
    billboardCollection,
    viewer,
    history = [],
    tracked = true,
    models = [],
    modelCollection = null,
  }) {
    flightState._viewer = viewer;
    flightState._modelCollection = modelCollection;
    flightState._billboardCollection = billboardCollection;
    flightState._billboards = new Map([[icao24, billboard]]);
    flightState._cullPositions.clear();
    flightState._models.clear();
    for (const [key, model] of models) flightState._models.set(key, model);
    flightState._detectionObjects = new Map();
    flightState.records.data = new Map([[icao24, meta]]);
    flightState._positionHistory = new Map([[icao24, history]]);
    flightState.records.missingPolls = new Map();
    flightState._displayCourse.clear();
    flightState.records.geoidNCache.clear();
    flightState._trackedIcao = tracked ? icao24 : null;
    flightState._trackedEntity = tracked ? entity : null;
    flightState._trackedModel = null;
    parts.tracking._cancelPendingTrackingRestore();
    flightState._trackedModelLoading = false;
    // NOTE: deliberately does NOT reset the per-selection latches. They are
    // production state owned by the tracking lifecycle (_resetTrackedSelectionState),
    // and clearing them here would mask exactly the deselect→re-track hole this
    // seam is used to test.
    flightState.feed._backoff = false;
    flightState.feed._retryAt = 0;
  }

  /** Seed the authoritative snapshot outcome used by share-Follow tests. */

  function _setMilitaryTrackingRefreshOutcomeForTest({
    status = 'accepted',
    ids = [],
    source = flightState.feed._lastSource,
  } = {}) {
    const epoch = ++flightState.feed._trackingRefreshEpoch;
    flightState.feed._lastTrackingRefreshOutcome = {
      epoch,
      status,
      ids: new Set(ids.map((id) => String(id).trim().toLowerCase())),
      source,
    };
  }

  /** Add a cached contact so tests can model a target arriving on a later feed. */

  function _addMilitaryTrackingCandidateForTest({
    icao24,
    meta,
    billboard,
    history = [],
  }) {
    flightState._billboards.set(icao24, billboard);
    flightState.records.data.set(icao24, meta);
    flightState._positionHistory.set(icao24, history);
  }

  /** Return the deferred restore target held by the production tracker. */

  function _pendingMilitaryTrackingRestoreForTest() {
    return flightState._pendingTrackingRestore?.id ?? null;
  }

  /** Exercise the production deferred-restore retry after a simulated feed refresh. */

  function _applyPendingMilitaryTrackingRestoreForTest() {
    return parts.tracking._applyPendingTrackingRestore();
  }

  /** Set the exact Cockpit subject through the production state transition for focused tests. */

  function _setCockpitDetectionSubjectForTest(active, subjectId = null) {
    parts.tracking._applyCockpitState({ active, subjectId });
  }

  /** Evaluate the TRACKED contact's zoom regime through the production predicate.
   *  The decision is latch-bearing (default-on, hysteretic, cockpit/TR-3B-suppressed)
   *  and otherwise only observable through a live scene, so tests drive it here. */

  function _trackedModelRegimeActiveForTest() {
    return parts.tracking._trackedModelRegimeActive();
  }

  /** Run one frame of the production tracked-model driver (normally a
   *  `scene.preUpdate` listener) so tests can pin its bounded load retries. */

  function _updateTrackedModelForTest() {
    return parts.rendering._updateTrackedModel();
  }

  /** Evaluate the production tracked-billboard handoff colour for focused tests. */

  function _trackedBillboardColorForTest() {
    return parts.rendering._modelOwnsVisual(flightState._trackedIcao)
      ? AMBER_TRANSPARENT
      : TRACKED_ICON_COLOR;
  }

  /** Drive the exact fleet billboard-to-model handoff used by `_fleetTick`. */

  function _driveFleetModelHandoffForTest({ icao24, position, course = 0 }) {
    return parts.rendering._driveFleetModelHandoff(
      icao24,
      flightState._models.get(icao24),
      flightState._billboards.get(icao24),
      position,
      course,
    );
  }

  /** Exercise the exact asynchronous fleet loader and return its admitted model. */

  async function _ensureFleetModelForTest(icao24) {
    await parts.rendering._ensureModel(icao24);
    return flightState._models.get(icao24) || null;
  }
  return {
    _setTrackedMilitaryRefreshStateForTest,
    _setMilitaryTrackingRefreshOutcomeForTest,
    _addMilitaryTrackingCandidateForTest,
    _pendingMilitaryTrackingRestoreForTest,
    _applyPendingMilitaryTrackingRestoreForTest,
    _setCockpitDetectionSubjectForTest,
    _trackedModelRegimeActiveForTest,
    _updateTrackedModelForTest,
    _trackedBillboardColorForTest,
    _driveFleetModelHandoffForTest,
    _ensureFleetModelForTest,
  };
}
