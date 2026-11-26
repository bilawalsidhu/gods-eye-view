import {
  followedOf,
  onFollowChanged,
  stopFollowing,
} from '../../data/followed.js';
import {
  claimSelection,
  followOnSecondClick,
  releaseSelection,
  yieldSelectionToOthers,
} from '../../data/clickSelect.js';
import { FOLLOW_MIN_RANGE_M } from '../../data/trackedCamera.js';
import { findCamera } from '../../render/rendererOf.js';
import { vec } from '../../geo/index.js';
import { inputFor } from '../../input/dispatcher.js';
import { VESSEL_OVERLAY_SOURCE_ID } from '../../data/vesselLabels.js';

/**
 * How far a follow camera starts from a ship, metres: a ship sits on the
 * sea, so it is framed as an aircraft on the ground is (behind and above).
 */
export const VESSEL_FOLLOW_RANGE_M = 3000;

export function createSelection({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { isOwnedByOtherLayer } = services.picking;
  const { requestWorldFocus } = services.worldFocus;
  const {
    selectEntityContext,
    registerEntityContext,
    clearSelectedEntityContextForLayer,
  } = services.context;
  const aisLiveVesselsLayer = layer;

  function installInteraction(viewer) {
    if (state.clickSubscription || !viewer) return;
    bindVesselInteraction(viewer, state.interactionKeyTarget || document);
  }

  function bindVesselInteraction(viewer, keyTarget) {
    boundViewer = viewer;
    state.clickSubscription = inputFor(viewer).onClick((event) => {
      if (!state.feed.enabled) return;
      // The bridge view owns the selection: a click on open water must not
      // deselect the vessel the camera is riding.
      if (state.cockpitSubjectId) return;
      // The card or label painted on top takes the click, read once per
      // click so every layer agrees: a card of ours acts whatever is drawn
      // under it; another layer's is that layer's click.
      const top = services.picking.clickCard?.(event) ?? null;
      if (top) {
        if (top.sourceId !== VESSEL_OVERLAY_SOURCE_ID) return;
        const id = String(top.entryId || '').startsWith('vessel:')
          ? top.entryId.slice('vessel:'.length)
          : null;
        const carded = id ? state.records.byId.get(id) || null : null;
        // A stale card id is not empty terrain and must not clear a newer
        // selection. The next paint will evict its hit rectangle.
        if (carded) clickVessel(carded);
        return;
      }
      const pickedId = event.id;
      const record = pickedId ? state.records.byId.get(pickedId) : null;
      // A vessel icon's pick is an item of the layer's icon set, whose id is
      // its row id: the record's id, or an unkeyed row's. Removing a row
      // removes its item, so an evicted vessel cannot be picked at all; a
      // live row whose record is gone stays a no-op below.
      const hit = event.drawHit;
      const ownRecordPick =
        Boolean(hit) &&
        hit.set === state.icons?.setId &&
        state.icons.has(hit.id) === true;

      // An own-layer row without a live map key is a strict no-op (FB-1
      // residual). Trails carry no layer identity and hug their contacts, so any
      // `gev-trail:*` pick is also a no-op. A pick a sibling layer owns (an
      // aircraft, a route, a cyclone) is that layer's: preserve the current
      // vessel selection and do not compete with its camera command. Every
      // other non-vessel pick dismisses the current vessel inspection.
      if (ownRecordPick && (!pickedId || !record)) return;
      if (
        !record &&
        pickedId &&
        (String(pickedId).startsWith('gev-trail:') ||
          isOwnedByOtherLayer('ais-live-vessels', pickedId))
      )
        return;

      if (record) {
        clickVessel(record);
      } else {
        const transition = components.queries.reduceVesselSelection({
          selectedId: state.selectedRecord?.id,
          pickedId: null,
          gesture: 'click',
        });
        if (transition.action === 'deselect') clearVesselInspection();
      }
    });
    state.keyTarget = keyTarget;
    state.keydownHandler = onVesselKeyDown;
    keyTarget.addEventListener('keydown', state.keydownHandler);
    // Anything newly followed but the selected ship's own follow belongs to
    // another layer and takes interaction ownership of the scene; so does
    // anything another layer selects (a click selects without following).
    const offFollow = onFollowChanged(viewer, (followed) => {
      if (followed && followed !== state.followTarget && state.selectedRecord)
        clearVesselInspection();
    });
    const offSelection = yieldSelectionToOthers(
      'ais-live-vessels',
      () => Boolean(state.selectedRecord),
      () => clearVesselInspection(),
    );
    state.trackedEntityRemover = () => {
      offFollow();
      offSelection();
    };
  }

  /**
   * A click on a vessel (its icon or its card): the first selects it and
   * centres it once; a second click on the selected one follows it, as the
   * card's Follow does; a click on the followed one keeps the follow
   * (src/data/clickSelect.js).
   */
  function clickVessel(record) {
    if (record?.id && state.selectedRecord?.id === record.id) {
      followOnSecondClick('ais-live-vessels', record.id, {
        isFollowed: isSelectedFollowed,
        follow: followSelected,
      });
      return true;
    }
    return selectAndFocusVessel(record);
  }

  /** The viewer the layer draws in. */
  const viewerOf = () => state.viewer || boundViewer;
  let boundViewer = null;

  /**
   * What the camera follows a ship with: where the layer draws it (its
   * placement, dead-reckoned and blended, or its segment at the world
   * time), so the eye and the icon never part. Where the renderer moves the
   * icons itself it follows the drawn item. The ship is read by id, so a
   * refresh that replaces its record keeps the follow on it.
   */
  function vesselFollowTarget(record) {
    const id = record.id;
    const current = () =>
      (state.selectedRecord?.id === id ? state.selectedRecord : null) ||
      state.records.byId.get(id) ||
      null;
    const drawn = () => {
      const now = current();
      return now ? (components.rendering.drawnPositionNow(now) ?? null) : null;
    };
    const visual = components.rendering.getVisual?.(record);
    const setId = state.icons?.setId;
    return {
      key: `ais-live-vessels:${id}`,
      name: components.cards.displayVesselName(record),
      position: drawn,
      displayPosition: drawn,
      ...(setId && visual?.iconId
        ? { item: { set: setId, id: String(visual.iconId) } }
        : {}),
      frame: 'enu',
      viewFrom: vec(
        0,
        -VESSEL_FOLLOW_RANGE_M * 0.8,
        VESSEL_FOLLOW_RANGE_M * 0.55,
      ),
      minRange: FOLLOW_MIN_RANGE_M,
    };
  }

  /** Whether the camera follows the selected ship now. */
  function isSelectedFollowed() {
    return (
      Boolean(state.followTarget) &&
      followedOf(viewerOf()) === state.followTarget
    );
  }

  /**
   * Have the camera follow the selected ship (an explicit follow: the
   * card's Follow, a spoken "track", a second click).
   * @returns {boolean} Whether the camera follows it.
   */
  function followSelected() {
    const record = state.selectedRecord;
    const camera = findCamera(viewerOf());
    if (!record?.id || !camera) return false;
    if (isSelectedFollowed()) return true;
    if (state.followTarget?.key !== `ais-live-vessels:${record.id}`)
      state.followTarget = vesselFollowTarget(record);
    camera.cancelFlight();
    camera.follow(state.followTarget);
    return isSelectedFollowed();
  }

  /**
   * Select one live vessel and request one UI-owned camera transfer: the
   * click's centring (src/data/clickSelect.js), keeping the camera's
   * distance and angle. The camera does not follow the vessel.
   */
  function selectAndFocusVessel(record) {
    if (!record?.id) return false;
    const transition = components.queries.reduceVesselSelection({
      selectedId: state.selectedRecord?.id,
      pickedId: record.id,
      gesture: 'click',
    });
    if (transition.action === 'select') selectVessel(record);
    requestWorldFocus({
      kind: 'vessel',
      id: record.id,
      label: record.name || record.mmsi || record.id,
      position: components.rendering.iconPosition(record),
      // The camera keeps its distance and angle; the vessel slides to the centre.
      keepView: true,
    });
    return true;
  }

  function removeVesselInteraction() {
    state.clickSubscription?.();
    state.clickSubscription = null;
    if (state.keyTarget && state.keydownHandler) {
      state.keyTarget.removeEventListener('keydown', state.keydownHandler);
    }
    state.keyTarget = null;
    state.keydownHandler = null;
    if (state.trackedEntityRemover) {
      state.trackedEntityRemover();
      state.trackedEntityRemover = null;
    }
  }

  function onVesselKeyDown(event) {
    if (!state.feed.enabled || event.key !== 'Escape') return;
    const transition = components.queries.reduceVesselSelection({
      selectedId: state.selectedRecord?.id,
      gesture: 'escape',
    });
    if (transition.action === 'deselect') {
      clearVesselInspection();
    }
  }

  function selectVessel(record) {
    if (!record?.id) return;
    const reuseTrail = state.trailId === record.id;
    // Selected again (found again in its feed, picked again): a follow of it
    // goes on.
    const again = state.selectedRecord?.id === record.id;
    const followTarget = again ? state.followTarget : null;
    clearSelection({ preserveTrail: reuseTrail, keepFollow: again });
    state.selectedRecord = record;
    state.followTarget = followTarget;
    // The one selection: any other layer's selected thing lets go.
    claimSelection('ais-live-vessels', record.id);
    record.missedRefreshes = 0;
    components.rendering.syncRecordIcon(record);
    // Rebuild the card set immediately so the full-detail card appears on the
    // click, not up to VISIBILITY_UPDATE_MS later.
    components.rendering.updateVisibility(true);
    components.cards.updateSelectedVesselHud(record);
    components.photos.requestVesselPhoto(record);
    if (registerSelectedContext(record)) {
      selectEntityContext(record);
    }
    // Track-history trail (PRD F3/F4): seed with the current position + async
    // backfill from the source's recent track for this vessel.
    if (reuseTrail) {
      components.tracking.appendSelectedVesselTrailFix(record);
    } else {
      components.tracking.startSelectedVesselTrail(record);
    }
  }

  /**
   * Register (or refresh) the selected vessel in the shared context store so
   * the realtime/voice layer can describe what the user has selected.
   * @param {Object} record - Selected vessel record.
   * @returns {Object|null} The context record, or null if registration failed.
   */

  function registerSelectedContext(record) {
    if (!record?.id) return null;
    try {
      return registerEntityContext(record, {
        id: `ais-${record.id}`,
        layerId: 'ais-live-vessels',
        layerName: 'Live AIS Vessels',
        source: aisLiveVesselsLayer.source,
        label: components.cards.displayVesselName(record),
        latitude: record.lat,
        longitude: record.lon,
        properties: {
          vesselId: record.id,
          mmsi: record.mmsi || null,
          type: record.type,
          speedKt: record.speed,
          course: record.course,
          destination: record.destination,
        },
      });
    } catch (error) {
      console.warn('[Data:ais-live-vessels] context register failed', error);
      return null;
    }
  }

  function clearSelection({
    preserveTrail = false,
    evicted = false,
    keepFollow = false,
  } = {}) {
    const record = state.selectedRecord;
    // The ship let go is no longer followed.
    const following = isSelectedFollowed();
    state.followTarget = null;
    if (following && !keepFollow) stopFollowing(viewerOf());
    state.selectedRecord = null;
    if (record) releaseSelection('ais-live-vessels', record.id);
    if (record) components.rendering.syncRecordIcon(record);
    // Drop the full-detail card right away (no-op when the layer is disabled —
    // disable() clears the entry set itself).
    if (record && state.feed.enabled)
      components.rendering.updateVisibility(true);
    if (!preserveTrail) components.tracking.clearSelectedVesselTrail();
    try {
      clearSelectedEntityContextForLayer('ais-live-vessels', { evicted });
    } catch (error) {
      console.warn('[Data:ais-live-vessels] context clear failed', error);
    }
  }

  /**
   * @param {object} [options] Clear origin.
   * @param {boolean} [options.evicted=false] The vessel aged out of the feed
   *   rather than being deselected.
   */

  function clearVesselInspection({ evicted = false } = {}) {
    clearSelection({ evicted });
    components.cards.resetSelectedVesselHud();
  }
  return {
    installInteraction,
    bindVesselInteraction,
    selectAndFocusVessel,
    clickVessel,
    followSelected,
    isSelectedFollowed,
    removeVesselInteraction,
    onVesselKeyDown,
    selectVessel,
    registerSelectedContext,
    clearSelection,
    clearVesselInspection,
  };
}
