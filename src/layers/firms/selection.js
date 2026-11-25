import {
  FIRMS_OVERLAY_SOURCE_ID,
  fireDetectionKey,
} from '../../data/firmsLabels.js';
import { inputFor } from '../../input/dispatcher.js';
import { CONTEXT_TOP_N } from './policy.js';
import { t } from '../../i18n/index.js';

export function createSelection({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { resolvePickId, isOwnedByOtherLayer, clickCard } = services.picking;
  const { requestWorldFocus } = services.focus;
  const {
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    getContextStore,
    registerEntityContext,
  } = services.context;
  const { id, name } = config;

  /**
   * Install the LEFT_CLICK handler for fire selection (enable-time only,
   * mirroring the flight layers). Clicking a fire sprite selects it and
   * surfaces it in the shared context store; clicking empty space clears
   * the selection. Picks owned by sibling layers are left alone.
   */

  function installClickHandler() {
    if (layerState._clickSubscription || !layerState._viewer) return;
    const input = inputFor(layerState._viewer);
    layerState._clickSubscription = input.onClick((event) => {
      // The card or label painted on top takes the click, read once per
      // click so every layer agrees: ours acts whatever is drawn under it;
      // another layer's is that layer's click.
      const top = clickCard?.(event) ?? null;
      if (top) {
        if (top.sourceId !== FIRMS_OVERLAY_SOURCE_ID) return;
        const carded = layerState._fireByCardId.get(top.entryId);
        if (carded) selectAndFocusFire(carded);
        return;
      }
      const pickedId = resolvePickId(event.topHit ?? null);
      // A pick that belongs to a sibling layer (an aircraft, a flight trail)
      // is not "empty space": leave the selection alone.
      const otherLayer = Boolean(pickedId && isOwnedByOtherLayer(id, pickedId));
      // The stand-in is asked where markers are picked: the click corrected
      // for the sensor style (`event.position`), and only when no sibling
      // layer's item is on top, as a marker under that item would not be hit.
      const fire = layerState._standIn
        ? otherLayer
          ? null
          : standInFire(event.position ?? event.screenPosition)
        : pickedFire(event.drawHit);
      if (fire) {
        selectAndFocusFire(fire);
        return;
      }
      if (otherLayer) return;
      clearFireSelection();
    });
  }

  function removeClickHandler() {
    layerState._clickSubscription?.();
    layerState._clickSubscription = null;
  }

  /** Select one stable detection and request one UI-owned camera transfer. */

  function selectAndFocusFire(fire) {
    selectFire(fire);
    // A stand-in that draws the fire larger than a marker says how far the
    // camera stands from it (`setMarkerStandIn`).
    const rangeM = layerState._standIn?.focusRangeM?.(fire);
    requestWorldFocus({
      kind: 'fire',
      id: fireDetectionKey(fire),
      label: t('FIRE'),
      position: components.model.firePosition(fire),
      ...(Number.isFinite(rangeM) && rangeM > 0 ? { rangeM } : {}),
    });
  }

  /**
   * Resolve a pick to one of this layer's fire records, or null: a hit (a
   * draw-port `Hit`, `event.drawHit`) on a glow of the layer's own icon set
   * whose id is a fire it draws now.
   * @param {?{set: string, id: string}} hit - The renderer's hit.
   * @returns {?Object} Fire record.
   */

  function pickedFire(hit) {
    if (!hit || !layerState._icons || hit.set !== layerState._icons.id)
      return null;
    return layerState._pickIndexById.get(hit.id) ?? null;
  }

  /** The shown detections by their key, for the shown set they were made from. */
  let keyed = { fires: null, byKey: null };

  /**
   * Resolve a click to one of this layer's fire records through the
   * application's stand-in for its markers (`setMarkerStandIn`), or null:
   * the record its hit test answers, matched by its detection key to a fire
   * the layer shows now (so one the filter hides is not selected).
   * @param {?{x: number, y: number}} screenPosition - Where the user clicked.
   * @returns {?Object} Fire record.
   */

  function standInFire(screenPosition) {
    if (!screenPosition) return null;
    const record = layerState._standIn?.hitTest(screenPosition);
    if (!record) return null;
    if (keyed.fires !== layerState._fires)
      keyed = {
        fires: layerState._fires,
        byKey: new Map(
          layerState._fires.map((fire) => [fireDetectionKey(fire), fire]),
        ),
      };
    return keyed.byKey.get(fireDetectionKey(record)) ?? null;
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
    registerEntityContext(fire.contextEntity, {
      targetPosition: components.model.firePosition(fire),
      id: recordId,
      layerId: id,
      layerName: name,
      source: 'NASA FIRMS',
      // Hidden with the layer: the context store reads its `show`.
      dataSource: layerState._cells,
      // i18n-ignore: English entity label; the voice card translates it (shownEntityLabel)
      label: `Fire · FRP ${components.model.formatFrp(fire.frp)} MW`,
      latitude: fire.lat,
      longitude: fire.lon,
      properties: {
        frp: fire.frp,
        confidence: components.model.confidenceBucket(fire.confidence),
        age:
          fire.acqMs > 0
            ? components.model.formatAge(
                components.model.ageReferenceMs() - fire.acqMs,
              )
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
    standInFire,
    selectFire,
    clearFireSelection,
    refreshContextRegistrations,
    registerFireContext,
    clearContextRegistrations,
    topFiresWithinBounds,
  };
}
