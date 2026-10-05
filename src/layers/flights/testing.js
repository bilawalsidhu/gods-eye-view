import * as Cesium from 'cesium';
import { CYAN_TRANSPARENT } from './policy.js';

export function createTesting({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  /** Test seam for the display-floor clamp (unit-tested against real Cesium math
   *  with seeded mesh cells — the drift mechanism is otherwise only reachable
   *  through a live poll + render loop). */

  function _floorGroundedDisplayPositionForTest(
    info,
    pos,
    modelOwnsVisual,
    icao24 = '__test__',
    nowMs = Date.now(),
  ) {
    return parts.motion._floorGroundedDisplayPosition(
      icao24,
      info,
      pos,
      modelOwnsVisual,
      nowMs,
    );
  }

  /** Test hook: drops the per-contact display-floor state (hysteresis + rebuild
   *  cache) so each case starts clean. There is no cross-contact state to reset —
   *  the clamp is per-contact all the way down. */

  function _clearDisplayFloorStateForTest() {
    flightState._displayFloorState.clear();
  }

  /**
   * Seed only the mutable state needed to exercise tracked-card refreshes through
   * the production poll reconciler. Tests still call `flightsLayer.update()`;
   * this seam avoids constructing the browser-only Cesium layer lifecycle.
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

  function _setTrackedFlightRefreshStateForTest({
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

  function _setFlightTrackingRefreshOutcomeForTest({
    status = 'accepted',
    ids = [],
    source = 'OpenSky Network',
    coverage = 'test',
  } = {}) {
    const epoch = ++flightState.feed._trackingRefreshEpoch;
    flightState.feed._lastTrackingRefreshOutcome = {
      epoch,
      status,
      ids: new Set(ids.map((id) => String(id).trim().toLowerCase())),
      source,
      coverage,
    };
  }

  /** Add a cached contact so tests can model a target arriving on a later feed. */

  function _addFlightTrackingCandidateForTest({
    icao24,
    meta,
    billboard,
    history = [],
  }) {
    flightState._billboards.set(icao24, billboard);
    flightState.records.data.set(icao24, meta);
    flightState._positionHistory.set(icao24, history);
  }

  /** Expose the military-suppression decision for the civil duplicate. */

  function _militaryLayerSuppressesForTest(icao24) {
    return parts.tracking._militaryLayerSuppresses(icao24);
  }

  /** Arm the deferred restore latch directly, without a full setParams turn. */

  function _armFlightTrackingRestoreForTest(id, origin = 'share-restore') {
    flightState._pendingTrackingRestore =
      id === null
        ? null
        : { id, generation: flightState._trackingIntentGeneration, origin };
  }

  /** Return the deferred restore target held by the production tracker. */

  function _pendingFlightTrackingRestoreForTest() {
    return flightState._pendingTrackingRestore?.id ?? null;
  }

  /** Exercise the production deferred-restore retry after a simulated feed refresh. */

  function _applyPendingFlightTrackingRestoreForTest() {
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
      ? CYAN_TRANSPARENT
      : Cesium.Color.CYAN;
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
    _floorGroundedDisplayPositionForTest,
    _clearDisplayFloorStateForTest,
    _setTrackedFlightRefreshStateForTest,
    _setFlightTrackingRefreshOutcomeForTest,
    _addFlightTrackingCandidateForTest,
    _militaryLayerSuppressesForTest,
    _armFlightTrackingRestoreForTest,
    _pendingFlightTrackingRestoreForTest,
    _applyPendingFlightTrackingRestoreForTest,
    _setCockpitDetectionSubjectForTest,
    _trackedModelRegimeActiveForTest,
    _updateTrackedModelForTest,
    _trackedBillboardColorForTest,
    _driveFleetModelHandoffForTest,
    _ensureFleetModelForTest,
  };
}
