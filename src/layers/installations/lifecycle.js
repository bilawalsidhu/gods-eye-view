import { cameraOf } from '../../render/rendererOf.js';
import { CAMERA_CHANGED_THRESHOLD, LAYER_ID } from './policy.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { clearSelectedEntityContextForLayer } = services.context;

  const methods = {
    init(viewer) {
      layerState.viewer = viewer;
      parts.rendering.attach(viewer);
      const cameraChanged = () => {
        if (!layerState.contextAnchor) parts.viewport.scheduleLoad();
      };
      const camera = cameraOf(viewer);
      layerState.moveEndRemove = camera.on('moveEnd', cameraChanged);
      // Measured for this listener alone; off, a load is never scheduled.
      layerState.changedRemove = camera.on('changed', cameraChanged, {
        threshold: CAMERA_CHANGED_THRESHOLD,
      });
      parts.selection.installInteraction(viewer);
    },

    enable() {
      layerState.enabled = true;
      layerState.surfaceChangedRemove ||= services.maps?.subscribeMapStack(
        parts.rendering.syncSelectionFill,
      );
      // Cached markers and geometry become visible before the next fetch.
      parts.namedMarkers?.enable();
      parts.namedMarkers?.sync(layerState.records || []);
      registerPickOwner(LAYER_ID, (id) => layerState.recordById.has(id));
      parts.rendering.setShown(true);
      // DataLayerManager invokes update() immediately after enable(), which owns
      // the first fetch. Avoid racing it with a second aborting request here.
    },

    disable() {
      layerState.enabled = false;
      parts.namedMarkers?.hide();
      layerState.contextAnchor = null;
      layerState.contextPosition = null;
      layerState.coverage = { kind: 'viewport' };
      layerState.cameraLoadKey = null;
      layerState.cameraLoadOwner = null;
      unregisterPickOwner(LAYER_ID);
      parts.viewport.clearUnavailableRetry();
      clearTimeout(layerState.timer);
      layerState.abort?.abort();
      layerState.abort = null;
      layerState.loading = false;
      parts.rendering.setShown(false);
      clearSelectedEntityContextForLayer(LAYER_ID);
      layerState.selectedId = null;
      parts.rendering.clearSelectionFill?.();
      layerState.surfaceChangedRemove?.();
      layerState.surfaceChangedRemove = null;
      layerState.failureReason = null;
      parts.ingestion.setInstallationStatus('idle');
    },

    destroy(viewer) {
      source.destroy?.();
      this.disable();
      layerState.contextAnchor = null;
      layerState.contextPosition = null;
      layerState.coverage = { kind: 'viewport' };
      layerState.moveEndRemove?.();
      layerState.changedRemove?.();
      parts.selection.destroy?.();
      layerState.clickSubscription?.();
      layerState.clickSubscription = null;
      parts.namedMarkers?.destroy();
      parts.rendering.clearRendered();
      parts.rendering.detach(viewer);
    },
  };

  return { methods };
}
