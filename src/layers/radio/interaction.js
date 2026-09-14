import * as Cesium from 'cesium';
import {
  RADIO_PREFIX,
  RADIO_PICK_OFFSETS,
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

  /** Resolve a station id from ordinary, selected, or Cesium cluster pick shapes. */

  function radioStationIdFromPick(picked) {
    const pending = [picked?.id, picked?.primitive?.id];
    const seen = new Set();
    while (pending.length) {
      const value = pending.shift();
      if (typeof value === 'string' || typeof value === 'number') {
        const id = String(value);
        if (id.startsWith(`${RADIO_PREFIX}selected:`))
          return id.slice(`${RADIO_PREFIX}selected:`.length);
        if (id.startsWith(RADIO_PREFIX)) return id.slice(RADIO_PREFIX.length);
        continue;
      }
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) pending.push(...value);
      else {
        pending.push(value.id);
        if (value.primitive) pending.push(value.primitive.id);
      }
    }
    return null;
  }

  function pickedRadioStationAt(position) {
    const scene = layerState._viewer?.scene;
    if (!scene || !position) return null;

    const stationFromPick = (picked) => {
      const stationId = radioStationIdFromPick(picked);
      return stationId && layerState._stationById.has(stationId)
        ? stationId
        : null;
    };
    const primaryPick = scene.pick(position);
    const primaryStationId = stationFromPick(primaryPick);
    if (primaryStationId) return primaryStationId;
    const primaryId = resolvePickId(primaryPick);
    if (primaryId && isOwnedByOtherLayer('radio', primaryId)) return null;

    if (typeof scene.drillPick === 'function') {
      const drilled = scene.drillPick(position, 16) || [];
      for (const picked of drilled) {
        const stationId = stationFromPick(picked);
        if (stationId) return stationId;
      }
    }

    for (const [offsetX, offsetY] of RADIO_PICK_OFFSETS) {
      const offsetPosition = new Cesium.Cartesian2(
        position.x + offsetX,
        position.y + offsetY,
      );
      const picked = scene.pick(offsetPosition);
      const pickedId = resolvePickId(picked);
      if (pickedId && isOwnedByOtherLayer('radio', pickedId)) continue;
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
    if (layerState._dataSource) layerState._dataSource.show = visible;
    setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, visible);
    if (visible) {
      installInteraction();
      parts.rendering.updateSelectionEntity();
      parts.rendering.updateRenderVisibility();
      parts.rendering.scheduleRadioOverlayPublish();
    } else {
      removeInteraction();
      if (layerState._selectedEntity && layerState._viewer)
        layerState._viewer.entities.remove(layerState._selectedEntity);
      layerState._selectedEntity = null;
    }
  }

  function installInteraction() {
    if (!layerState._viewer || layerState._clickHandler) return;
    registerPickOwner('radio', (id) => id.startsWith(RADIO_PREFIX));
    layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
      layerState._viewer.scene.canvas,
    );
    layerState._clickHandler.setInputAction((click) => {
      if (!radioPresentationAllowed()) return;
      const stationId = pickedRadioStationAt(click.position);
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
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
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
    layerState._clickHandler?.destroy();
    layerState._clickHandler = null;
    if (layerState._horizonTimer) clearInterval(layerState._horizonTimer);
    layerState._horizonTimer = null;
  }
  return {
    radioStationIdFromPick,
    pickedRadioStationAt,
    radioPresentationAllowed,
    syncRadioLifecyclePresentation,
    installInteraction,
    removeInteraction,
  };
}
