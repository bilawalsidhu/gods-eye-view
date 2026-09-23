import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { WEB_RECEIVERS_LAYER_ID, WEB_RECEIVER_PREFIX } from './policy.js';

export function createInteraction({ state: layerState, services, parts }) {
  const {
    resolvePickId,
    isOwnedByOtherLayer,
    registerPickOwner,
    unregisterPickOwner,
  } = services.picking;

  /** Resolve a receiver id from an ordinary or a Cesium cluster pick. */
  function receiverIdFromPick(picked) {
    const id = resolvePickId(picked);
    if (id === null && Array.isArray(picked?.id)) {
      const first = picked.id.find((entity) =>
        String(entity?.id || '').startsWith(WEB_RECEIVER_PREFIX),
      );
      return first ? String(first.id).slice(WEB_RECEIVER_PREFIX.length) : null;
    }
    const text = String(id || '');
    if (
      !text.startsWith(WEB_RECEIVER_PREFIX) ||
      text === `${WEB_RECEIVER_PREFIX}selected`
    )
      return null;
    return text.slice(WEB_RECEIVER_PREFIX.length);
  }

  function pickedReceiverAt(position) {
    const scene = layerState._viewer?.scene;
    if (!scene || !position) return null;
    const picked = scene.pick(position);
    if (isOwnedByOtherLayer(WEB_RECEIVERS_LAYER_ID, resolvePickId(picked)))
      return null;
    const id = receiverIdFromPick(picked);
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
    if (visible && layerState._viewer && !layerState._clickHandler)
      installInteraction();
    if (!visible) removeInteraction();
  }

  function installInteraction() {
    if (!layerState._viewer || layerState._clickHandler) return;
    registerPickOwner(
      WEB_RECEIVERS_LAYER_ID,
      (id) => typeof id === 'string' && id.startsWith(WEB_RECEIVER_PREFIX),
    );
    layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
      layerState._viewer.scene.canvas,
    );
    layerState._clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!presentationAllowed()) return;
      const id = pickedReceiverAt(click.position);
      if (!id) return;
      parts.queries.selectReceiver(id, { origin: 'user' });
      if (typeof document !== 'undefined') {
        document.dispatchEvent(
          new CustomEvent('gev:web-receiver-selected', {
            detail: { receiverId: id },
          }),
        );
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeInteraction() {
    unregisterPickOwner(WEB_RECEIVERS_LAYER_ID);
    layerState._clickHandler?.destroy();
    layerState._clickHandler = null;
  }

  return {
    receiverIdFromPick,
    pickedReceiverAt,
    presentationAllowed,
    syncPresentation,
    installInteraction,
    removeInteraction,
  };
}
