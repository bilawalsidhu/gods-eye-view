import {
  FIRMS_OVERLAY_SOURCE_ID,
  fireDetectionKey,
} from '../../data/firmsLabels.js';
import * as Cesium from 'cesium';
import { CONTEXT_TOP_N } from './policy.js';

export function createSelection({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;
  const { requestWorldFocus } = services.focus;
  const {
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    getContextStore,
    registerEntityContext,
  } = services.context;
  const { id, name, overlayHost, screenSpaceEventHandlerFactory } = config;

  /**
   * Install the LEFT_CLICK handler for fire selection (enable-time only,
   * mirroring the flight layers). Clicking a fire sprite selects it and
   * surfaces it in the shared context store; clicking empty space clears
   * the selection. Picks owned by sibling layers are left alone.
   */

  function installClickHandler() {
    if (layerState._clickHandler || !layerState._viewer) return;
    layerState._clickHandler = screenSpaceEventHandlerFactory(
      layerState._viewer,
    );
    layerState._clickHandler.setInputAction((click) => {
      const picked = layerState._viewer.scene.pick(click.position);
      const fire = pickedFire(picked);
      if (fire) {
        selectAndFocusFire(fire);
        return;
      }
      // A pick that belongs to a sibling layer (e.g. an aircraft) is not
      // "empty space" — leave the selection alone and let that layer handle it.
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && isOwnedByOtherLayer(id, pickedId)) return;
      }
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        {
          sourceId: FIRMS_OVERLAY_SOURCE_ID,
        },
      );
      if (cardHit) {
        const carded = layerState._fireByCardId.get(cardHit.entryId);
        if (carded) selectAndFocusFire(carded);
        return;
      }
      clearFireSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (layerState._clickHandler) {
      layerState._clickHandler.destroy();
      layerState._clickHandler = null;
    }
  }

  /** Select one stable detection and request one UI-owned camera transfer. */

  function selectAndFocusFire(fire) {
    selectFire(fire);
    requestWorldFocus({
      kind: 'fire',
      id: fireDetectionKey(fire),
      label: 'FIRE',
      position: components.model.firePosition(fire),
    });
  }

  /**
   * Resolve a scene pick to one of this layer's fire records, or null.
   * BillboardCollection picks surface our id either on picked.primitive.id
   * or directly on picked.id depending on the CesiumJS pick path.
   * @param {*} picked - Result of scene.pick().
   * @returns {?Object} Fire record.
   */

  function pickedFire(picked) {
    if (!picked) return null;
    const primitiveId = picked.primitive?.id;
    if (
      typeof primitiveId === 'string' &&
      layerState._pickIndexById.has(primitiveId)
    ) {
      return layerState._pickIndexById.get(primitiveId);
    }
    if (
      typeof picked.id === 'string' &&
      layerState._pickIndexById.has(picked.id)
    ) {
      return layerState._pickIndexById.get(picked.id);
    }
    return null;
  }

  /**
   * Select a fire: show its detail label and mark it selected in the shared
   * context store so voice "what's selected" resolves to it.
   * @param {Object} fire - Detection record.
   */

  function selectFire(fire, publishSelection = true) {
    layerState._selectedFire = fire;
    try {
      registerFireContext(fire);
      layerState._contextIds.add(fireDetectionKey(fire));
      if (publishSelection) selectEntityContext(fire.contextEntity);
    } catch {
      // context store unavailable — the selection label still works
    }
    components.cards.rebuildAmbientLabels();
  }

  function clearFireSelection() {
    if (!layerState._selectedFire) return;
    layerState._selectedFire = null;
    clearSelectedEntityContextForLayer(id);
    components.cards.rebuildAmbientLabels();
  }

  /**
   * Register the top detections of the current render set in the shared
   * context store (voice "what's burning here") and drop stale entries
   * from the previous rebuild.
   * @param {Array<Object>} fires - FRP-ranked detections to register.
   */

  function refreshContextRegistrations(fires) {
    let store = null;
    try {
      store = getContextStore();
    } catch {
      return;
    }

    const nextIds = new Set();
    for (const fire of fires) {
      nextIds.add(registerFireContext(fire));
    }
    // The click-selected fire must stay queryable ("what's selected") even
    // when it falls outside the top-N context slice.
    if (layerState._selectedFire) {
      nextIds.add(registerFireContext(layerState._selectedFire));
    }

    for (const staleId of layerState._contextIds) {
      if (!nextIds.has(staleId)) store.entities.delete(staleId);
    }
    layerState._contextIds = nextIds;
  }

  /**
   * Register one fire in the shared context store (idempotent) and return
   * its record id.
   * @param {Object} fire - Detection record.
   * @returns {string} Context record id.
   */

  function registerFireContext(fire) {
    const recordId = fireDetectionKey(fire);
    if (!fire.contextEntity) {
      fire.contextEntity = {
        show: true,
      };
    }
    // Refreshed every registration: the anchor re-grounds onto the DEM when
    // its floor cell warms, and voice targeting must project the same point
    // the sprite renders at.
    fire.contextEntity.__localBaseCartesian =
      components.model.firePosition(fire);
    registerEntityContext(fire.contextEntity, {
      id: recordId,
      layerId: id,
      layerName: name,
      source: 'NASA FIRMS',
      dataSource: layerState._dataSource,
      label: `Fire · FRP ${components.model.formatFrp(fire.frp)} MW`,
      latitude: fire.lat,
      longitude: fire.lon,
      properties: {
        frp: fire.frp,
        confidence: components.model.confidenceBucket(fire.confidence),
        age:
          fire.acqMs > 0
            ? components.model.formatAge(Date.now() - fire.acqMs)
            : 'unknown',
        sensor: fire.sensor || 'unknown',
      },
    });
    return recordId;
  }

  function clearContextRegistrations() {
    if (!layerState._contextIds.size) return;
    try {
      const store = getContextStore();
      for (const recordId of layerState._contextIds)
        store.entities.delete(recordId);
    } catch {
      // store unavailable — nothing to clean
    }
    layerState._contextIds = new Set();
  }

  /**
   * Top-FRP detections within the given bounds (or globally when bounds is
   * null). Walks the pre-sorted FRP index so it stays a single cheap pass.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   * @param {number} limit - Max detections returned.
   * @returns {Array<Object>}
   */

  function topFiresWithinBounds(bounds, limit = CONTEXT_TOP_N) {
    if (!bounds) return layerState._firesByFrp.slice(0, limit);
    const top = [];
    for (const fire of layerState._firesByFrp) {
      if (!components.model.boundsContainPoint(bounds, fire.lat, fire.lon))
        continue;
      top.push(fire);
      if (top.length >= limit) break;
    }
    return top;
  }
  return {
    installClickHandler,
    removeClickHandler,
    selectAndFocusFire,
    pickedFire,
    selectFire,
    clearFireSelection,
    refreshContextRegistrations,
    registerFireContext,
    clearContextRegistrations,
    topFiresWithinBounds,
  };
}
