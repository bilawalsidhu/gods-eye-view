import { trackedIconColor } from '../../data/trackedAircraftIcon.js';
import { createModelRecord } from '../../data/modelRecord.js';
import {
  aircraftIconTestSeams,
  createContactIcons,
} from '../../data/aircraftIconLayer.js';

export function createTesting({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { _seedIconForTest, _iconForTest, _setIconForTest } =
    aircraftIconTestSeams(flightState, parts, 'military');
  /**
   * Seed only the mutable state needed to exercise tracked-card refreshes through
   * the production military poll reconciler. Tests still call
   * `militaryFlightsLayer.update()` rather than invoking the writer directly.
   * @param {object} state
   * @param {string} state.icao24
   * @param {object} state.entity
   * @param {object} state.meta
   * @param {{position?: {x: number, y: number, z: number}, show?: boolean}} [state.icon]
   *   Where the contact's icon is held, and whether it is shown.
   * @param {{show?: boolean}} [state.iconLayer] Layer visibility.
   * @param {object} state.viewer
   * @param {Array<Object>} [state.history=[]]
   * @param {boolean} [state.tracked=true]
   * @param {Iterable<[string, object]>} [state.models=[]] - Fleet 3D models keyed
   *   by icao24, for the icon-hidden/model-shown handoff state: each object
   *   becomes the contact's model record (`ready`, `show`, and a placement
   *   `modelMatrix` when given), so the test reads what the layer writes back.
   * @param {object|null} [state.draw] A draw port the layer's model sets are
   *   made on (a test double); none keeps the records only.
   */

  /** Turn a test's model fields into the contact's model record, in place. */
  function _modelRecordForTest(fields, meta) {
    const spec = parts.rendering._modelSpec(meta);
    const base = createModelRecord({
      specKey: parts.rendering._specKeyFor(meta),
      bellyM: spec.bellyM,
      scale: spec.scale,
    });
    for (const key of Object.keys(base))
      if (!(key in fields)) fields[key] = base[key];
    fields.ready = fields.ready === true;
    fields.show = fields.show ?? true;
    if (fields.modelMatrix) {
      fields.matrix = Float64Array.from(fields.modelMatrix);
      fields.position = {
        x: fields.matrix[12],
        y: fields.matrix[13],
        z: fields.matrix[14],
      };
      fields.placed = true;
    }
    return fields;
  }

  function _setTrackedMilitaryRefreshStateForTest({
    icao24,
    entity,
    meta,
    icon,
    iconLayer,
    viewer,
    history = [],
    tracked = true,
    models = [],
    draw = null,
    trackedModelEligible = true,
  }) {
    flightState._viewer = viewer;
    parts.rendering._disposeModelSets();
    if (draw) parts.rendering._createModelSets(viewer, { draw });
    parts.icons._disposeIcons();
    if (draw) parts.icons._createIcons(viewer);
    else flightState._icons = createContactIcons();
    flightState._icons.show = iconLayer?.show ?? true;
    _seedIconForTest(icao24, icon, tracked);
    flightState._models.clear();
    for (const [key, model] of models)
      flightState._models.set(key, _modelRecordForTest(model, meta));
    flightState._detectionObjects = new Map();
    flightState.records.data = new Map([[icao24, meta]]);
    flightState._positionHistory = new Map([[icao24, history]]);
    flightState.records.missingPolls = new Map();
    flightState._displayCourse.clear();
    flightState.records.geoidNCache.clear();
    flightState._trackedIcao = tracked ? icao24 : null;
    flightState._trackedEntity = tracked ? entity : null;
    flightState._trackedModel = null;
    // Whether the fleet's model rule gives the tracked contact a model (the
    // fleet pass keeps it): a model unless the test says otherwise.
    flightState._trackedModelEligible = tracked && trackedModelEligible;
    // `null`: as a selection seeds it (from the contact's fleet model).
    if (trackedModelEligible === null)
      parts.tracking._resetTrackedSelectionState();
    parts.tracking._cancelPendingTrackingRestore();
    // NOTE: deliberately does NOT reset the load-failure budget. It is
    // production state owned by the tracking lifecycle
    // (_resetTrackedSelectionState), and clearing it here would mask exactly
    // the deselect→re-track hole this seam is used to test.
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
    icon,
    history = [],
  }) {
    _seedIconForTest(icao24, icon, false);
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

  /** Evaluate whether the TRACKED contact draws as its model, through the
   *  production predicate (the fleet's rule; cockpit/TR-3B-suppressed). */

  function _trackedModelRegimeActiveForTest() {
    return parts.tracking._trackedModelRegimeActive();
  }

  /** Run one frame of the production tracked-model driver (normally a
   *  `preUpdate` listener). */

  function _updateTrackedModelForTest() {
    return parts.rendering._updateTrackedModel();
  }

  /** Evaluate the production tracked-billboard handoff colour for focused tests. */

  function _trackedBillboardColorForTest() {
    const icao24 = flightState._trackedIcao;
    const color = parts.rendering._fleetBillboardColor(icao24);
    return parts.rendering._modelOwnsVisual(icao24)
      ? trackedIconColor(color, 0)
      : color;
  }

  /** Drive the exact fleet icon-to-model handoff used by `_fleetTick`. */

  function _driveFleetModelHandoffForTest({ icao24, position, course = 0 }) {
    return parts.rendering._driveFleetModelHandoff(
      icao24,
      flightState._models.get(icao24),
      position,
      course,
    );
  }

  /** Exercise the exact fleet admission and return the admitted model's record. */

  function _ensureFleetModelForTest(icao24) {
    parts.rendering._ensureModel(icao24);
    return flightState._models.get(icao24) ?? null;
  }

  /** How the tracked billboard is drawn (`_trackedBillboardLook`,
   *  `_trackedSprite`, `_trackedIconColor`) next to how the contact's fleet
   *  icon is (`_fleetLook`, `_fleetBillboardColor`). */

  function _trackedIconLookForTest(icao24) {
    return {
      tracked: {
        ...parts.tracking._trackedBillboardLook(),
        sprite: parts.tracking._trackedSprite(icao24),
        color: parts.tracking._trackedIconColor(),
      },
      fleet: {
        ...parts.icons._fleetLook(icao24),
        color: parts.rendering._fleetBillboardColor(icao24),
      },
    };
  }

  /** The tracked model's record, or null. */

  function _trackedModelForTest() {
    return flightState._trackedModel;
  }

  /** The fleet and tracked model sets' ids, or null without sets. */

  function _modelSetIdsForTest() {
    const [fleet, tracked] = parts.rendering._modelSetIds();
    return fleet ? { fleet, tracked } : null;
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
    _iconForTest,
    _setIconForTest,
    _ensureFleetModelForTest,
    _trackedModelForTest,
    _trackedIconLookForTest,
    _modelSetIdsForTest,
  };
}
