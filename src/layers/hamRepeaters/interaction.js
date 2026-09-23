import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  HAM_REPEATERS_LAYER_ID,
  HOVER_THROTTLE_MS,
  REPEATER_PREFIX,
} from './policy.js';

export function createInteraction({ state: layerState, services, parts }) {
  const {
    resolvePickId,
    isOwnedByOtherLayer,
    registerPickOwner,
    unregisterPickOwner,
  } = services.picking;

  /** Resolve a repeater id from an ordinary or a cluster pick; the selection and hover markers are never picked. */
  function repeaterIdFromPick(picked) {
    const raw = picked?.id ?? picked?.primitive?.id;
    if (Array.isArray(raw)) {
      const first = raw.find((entity) =>
        String(entity?.id || '').startsWith(REPEATER_PREFIX),
      );
      return first ? String(first.id).slice(REPEATER_PREFIX.length) : null;
    }
    const text = String(resolvePickId(picked) || '');
    if (!text.startsWith(REPEATER_PREFIX)) return null;
    const id = text.slice(REPEATER_PREFIX.length);
    return id === 'selected' || id === 'hover' ? null : id;
  }

  function pickedRepeaterAt(position) {
    const scene = layerState._viewer?.scene;
    if (!scene || !position) return null;
    const picked = scene.pick(position);
    if (isOwnedByOtherLayer(HAM_REPEATERS_LAYER_ID, resolvePickId(picked)))
      return null;
    const id = repeaterIdFromPick(picked);
    return id && layerState._byId.has(id) ? id : null;
  }

  /** The manager's lifecycle gate: markers show only in a settled enabled state. */
  function presentationAllowed() {
    if (!layerState._managerPresentation) return layerState._enabled;
    return (
      layerState._enabled &&
      layerState._managerPresentation.enabled &&
      layerState._managerPresentation.lifecycleState === 'enabled' &&
      !layerState._managerPresentation.uncertain
    );
  }

  function syncPresentation() {
    const visible = presentationAllowed();
    if (layerState._dataSource) layerState._dataSource.show = visible;
    if (layerState._selectedEntity)
      layerState._selectedEntity.show =
        visible && Boolean(layerState._selectedId);
    if (layerState._hoverEntity)
      layerState._hoverEntity.show = visible && Boolean(layerState._hoverId);
    if (visible && layerState._viewer && !layerState._clickHandler)
      installInteraction();
    if (!visible) removeInteraction();
  }

  function installInteraction() {
    if (!layerState._viewer || layerState._clickHandler) return;
    registerPickOwner(
      HAM_REPEATERS_LAYER_ID,
      (id) => typeof id === 'string' && id.startsWith(REPEATER_PREFIX),
    );
    layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
      layerState._viewer.scene.canvas,
    );
    layerState._clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!presentationAllowed()) return;
      const id = pickedRepeaterAt(click.position);
      if (!id) return;
      parts.queries.select(id, { origin: 'user' });
      if (typeof document !== 'undefined') {
        document.dispatchEvent(
          new CustomEvent('gev:ham-repeater-selected', {
            detail: { repeaterId: id },
          }),
        );
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    layerState._clickHandler.setInputAction((movement) => {
      const now = Date.now();
      if (now - layerState._lastHoverPick < HOVER_THROTTLE_MS) return;
      layerState._lastHoverPick = now;
      if (!presentationAllowed()) return;
      parts.rendering.setHover(pickedRepeaterAt(movement.endPosition));
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }

  function removeInteraction() {
    unregisterPickOwner(HAM_REPEATERS_LAYER_ID);
    layerState._clickHandler?.destroy();
    layerState._clickHandler = null;
    parts.rendering.setHover(null);
  }

  return {
    repeaterIdFromPick,
    pickedRepeaterAt,
    presentationAllowed,
    syncPresentation,
    installInteraction,
    removeInteraction,
  };
}
