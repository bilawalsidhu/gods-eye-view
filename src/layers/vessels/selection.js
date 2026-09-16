import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { VESSEL_OVERLAY_SOURCE_ID } from '../../data/vesselLabels.js';

export function createSelection({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;
  const { requestWorldFocus } = services.worldFocus;
  const {
    selectEntityContext,
    registerEntityContext,
    clearSelectedEntityContextForLayer,
  } = services.context;
  const aisLiveVesselsLayer = layer;

  function installInteraction(viewer) {
    if (state.clickHandler || !viewer) return;
    const handler = state.interactionHandlerFactory
      ? state.interactionHandlerFactory(viewer)
      : new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    bindVesselInteraction(
      viewer,
      handler,
      state.interactionKeyTarget || document,
    );
  }

  function bindVesselInteraction(viewer, handler, keyTarget) {
    state.clickHandler = handler;
    handler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!state.feed.enabled) return;
      const picked = viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      let record = pickedId ? state.records.byMmsi.get(pickedId) : null;
      const rawId = picked?.id ?? picked?.primitive?.id;
      const ownRecordPick =
        rawId && typeof rawId === 'object' && Object.hasOwn(rawId, 'mmsi');

      // An own-layer record without a live map key is a strict no-op (FB-1
      // residual). Trails carry no layer identity and hug their contacts, so any
      // `gev-trail:*` pick is also a no-op. Every other non-vessel pick — sibling
      // unowned scene picks dismiss the current vessel inspection.
      if (ownRecordPick && (!pickedId || !record)) return;
      if (pickedId && !record && String(pickedId).startsWith('gev-trail:'))
        return;

      // A sibling layer already owns this click. Preserve the current vessel
      // selection and do not compete with its camera command.
      if (pickedId && isOwnedByOtherLayer('ais-live-vessels', pickedId)) return;

      // Cards are painted on a pointer-events:none canvas, so the scene pick is
      // usually terrain behind the card. Resolve against the host's current
      // actionable hit rectangles before treating the click as empty space.
      const cardHit = !record
        ? vesselState._vesselOverlayHost.hitTest?.(
            click.position?.x,
            click.position?.y,
            {
              sourceId: VESSEL_OVERLAY_SOURCE_ID,
            },
          )
        : null;
      if (!record && cardHit) {
        const mmsi = String(cardHit.entryId || '').startsWith('vessel:')
          ? cardHit.entryId.slice('vessel:'.length)
          : null;
        record = mmsi ? state.records.byMmsi.get(mmsi) || null : null;
        // A stale card id is not empty terrain and must not clear a newer
        // selection. The next paint will evict its hit rectangle.
        if (!record) return;
      }

      if (record) {
        // A valid sprite or card click always transfers the camera exactly once,
        // including a second click on the already-selected vessel.
        selectAndFocusVessel(record);
      } else {
        const transition = components.queries.reduceVesselSelection({
          selectedMmsi: state.selectedRecord?.mmsi,
          pickedMmsi: null,
          gesture: 'click',
        });
        if (transition.action === 'deselect') clearVesselInspection();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    state.keyTarget = keyTarget;
    state.keydownHandler = onVesselKeyDown;
    keyTarget.addEventListener('keydown', state.keydownHandler);
    // Vessels never set viewer.trackedEntity, so any new tracked entity belongs
    // to another layer and takes interaction ownership of the scene.
    state.trackedEntityRemover = viewer.trackedEntityChanged.addEventListener(
      () => {
        if (viewer.trackedEntity && state.selectedRecord)
          clearVesselInspection();
      },
    );
  }

  /** Select one live vessel and request one UI-owned camera transfer. */

  function selectAndFocusVessel(record) {
    if (!record?.mmsi) return false;
    const transition = components.queries.reduceVesselSelection({
      selectedMmsi: state.selectedRecord?.mmsi,
      pickedMmsi: record.mmsi,
      gesture: 'click',
    });
    if (transition.action === 'select') selectVessel(record);
    requestWorldFocus({
      kind: 'vessel',
      id: record.mmsi,
      label: record.name || record.mmsi,
      position:
        components.rendering.getVisual(record).billboard?.position ||
        components.rendering.getVisual(record).position,
    });
    return true;
  }

  function removeVesselInteraction() {
    if (state.clickHandler) {
      state.clickHandler.destroy();
      state.clickHandler = null;
    }
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
      selectedMmsi: state.selectedRecord?.mmsi,
      gesture: 'escape',
    });
    if (transition.action === 'deselect') {
      clearVesselInspection();
    }
  }

  function selectVessel(record) {
    if (!record?.mmsi) return;
    const reuseTrail = state.trailMmsi === record.mmsi;
    clearSelection({ preserveTrail: reuseTrail });
    state.selectedRecord = record;
    record.missedRefreshes = 0;
    if (components.rendering.getVisual(record).billboard) {
      components.rendering.getVisual(record).billboard.image =
        components.rendering.shipIcon(record, true);
      components.rendering.getVisual(record).billboard.scale =
        components.rendering.shipScale(record) * 1.2;
    }
    // Rebuild the card set immediately so the full-detail card appears on the
    // click, not up to VISIBILITY_UPDATE_MS later.
    components.rendering.updateVisibility(true);
    components.cards.updateSelectedVesselHud(record);
    if (registerSelectedContext(record)) {
      selectEntityContext(record);
    }
    // Track-history trail (PRD F3/F4): seed with the current position + async
    // backfill from the server-side per-MMSI ring buffer.
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
    if (!record?.mmsi) return null;
    try {
      return registerEntityContext(record, {
        id: `ais-${record.mmsi}`,
        layerId: 'ais-live-vessels',
        layerName: 'Live AIS Vessels',
        source: aisLiveVesselsLayer.source,
        label: components.cards.displayVesselName(record),
        latitude: record.lat,
        longitude: record.lon,
        properties: {
          mmsi: record.mmsi,
          type: record.type,
          speedKt: record.speed,
          course: record.course,
          destination: record.destination,
          ...(record.telemetry ? { telemetry: record.telemetry } : {}),
        },
      });
    } catch (error) {
      console.warn('[Data:ais-live-vessels] context register failed', error);
      return null;
    }
  }

  function clearSelection({ preserveTrail = false, evicted = false } = {}) {
    const record = state.selectedRecord;
    if (components.rendering.getVisual(record)?.billboard) {
      components.rendering.getVisual(record).billboard.image =
        components.rendering.shipIcon(record, false);
      components.rendering.getVisual(record).billboard.scale =
        components.rendering.shipScale(record);
    }
    state.selectedRecord = null;
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
    removeVesselInteraction,
    onVesselKeyDown,
    selectVessel,
    registerSelectedContext,
    clearSelection,
    clearVesselInspection,
  };
}
