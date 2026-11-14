import { inputFor } from '../../input/dispatcher.js';
import {
  RADIO_PREFIX,
  RADIO_PICK_WINDOW_PX,
  RADIO_OVERLAY_SOURCE_ID,
  HORIZON_TICK_MS,
} from './policy.js';

export function createInteraction({
  state: layerState,
  services,
  parts,
  source,
}) {
  const {
    resolvePickId,
    isOwnedByOtherLayer,
    registerPickOwner,
    unregisterPickOwner,
  } = services.picking;
  const { setOverlaySourceVisible } = services.overlays;

  /**
   * The station under a click: the pick itself, then one drill through a
   * window around it, which also catches a near miss. Both passes are the
   * click's own, so other layers reading the same click share them.
   * @param {import('../../input/dispatcher.js').ClickEvent} event
   * @returns {string|null}
   */
  function pickedRadioStationAt(event) {
    if (!event) return null;

    const stationFromPick = (picked) => {
      const stationId = parts.rendering.radioStationIdFromPick(picked);
      return stationId && layerState._stationById.has(stationId)
        ? stationId
        : null;
    };
    const primaryPick = event.topHit;
    const primaryStationId = stationFromPick(primaryPick);
    if (primaryStationId) return primaryStationId;
    const primaryId = resolvePickId(primaryPick);
    if (primaryId && isOwnedByOtherLayer('radio', primaryId)) return null;

    for (const picked of event.drill(
      16,
      RADIO_PICK_WINDOW_PX,
      RADIO_PICK_WINDOW_PX,
    )) {
      const stationId = stationFromPick(picked);
      if (stationId) return stationId;
    }
    return null;
  }

  function radioPresentationAllowed() {
    if (!layerState._managerLifecyclePresentation) return layerState._enabled;
    return (
      layerState._enabled &&
      layerState._managerLifecyclePresentation.lifecycleState === 'enabled' &&
      layerState._managerLifecyclePresentation.enabled &&
      !layerState._managerLifecyclePresentation.uncertain
    );
  }

  function syncRadioLifecyclePresentation() {
    const visible = radioPresentationAllowed();
    parts.rendering.setStationsShown(visible);
    setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, visible);
    if (visible) {
      installInteraction();
      parts.rendering.updateSelectionEntity();
      parts.rendering.updateRenderVisibility();
      parts.rendering.scheduleRadioOverlayPublish();
    } else {
      removeInteraction();
      parts.rendering.removeSelectionEntity();
    }
  }

  function installInteraction() {
    if (!layerState._viewer || layerState._clickSubscription) return;
    registerPickOwner('radio', (id) => id.startsWith(RADIO_PREFIX));
    const viewer = layerState._viewer;
    layerState._clickSubscription = inputFor(viewer).onClick((event) => {
      if (!radioPresentationAllowed()) return;
      const stationId = pickedRadioStationAt(event);
      if (!stationId) return;
      layerState._playFallbackId = null;
      layerState._playFallbackFocus = null;
      parts.selection.selectRadioStation(stationId, {
        autoplay: true,
        origin: 'user',
      });
      if (typeof document !== 'undefined') {
        document.dispatchEvent(
          new CustomEvent('gev:radio-selected', { detail: { stationId } }),
        );
      }
    });
    // Polling remains bounded during flights, but a stationary camera no longer
    // rewrites every station's visibility four times per second while voice and
    // audio processing share the main thread.
    layerState._horizonTimer = setInterval(
      () => parts.rendering.updateRenderVisibility({ force: false }),
      HORIZON_TICK_MS,
    );
  }

  function removeInteraction() {
    unregisterPickOwner('radio');
    layerState._clickSubscription?.();
    layerState._clickSubscription = null;
    if (layerState._horizonTimer) clearInterval(layerState._horizonTimer);
    layerState._horizonTimer = null;
  }
  return {
    pickedRadioStationAt,
    radioPresentationAllowed,
    syncRadioLifecyclePresentation,
    installInteraction,
    removeInteraction,
  };
}
