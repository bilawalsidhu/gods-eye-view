import * as Cesium from 'cesium';
import { LAYER_ID } from './policy.js';

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
      layerState.dataSource = new Cesium.CustomDataSource('water-quality');
      viewer.dataSources.add(layerState.dataSource);
      layerState.moveEndRemove = viewer.camera.moveEnd.addEventListener(
        parts.viewport.scheduleLoad,
      );
      parts.selection.installInteraction(viewer);
    },

    enable() {
      layerState.enabled = true;
      registerPickOwner(LAYER_ID, (id) => layerState.recordById.has(id));
      layerState.dataSource.show = true;
      // DataLayerManager invokes update() immediately after enable(), which owns
      // the first fetch. Avoid racing it with a second aborting request here.
    },

    disable() {
      layerState.enabled = false;
      unregisterPickOwner(LAYER_ID);
      parts.viewport.clearUnavailableRetry();
      clearTimeout(layerState.timer);
      // Both controllers: the card fetch outlives a camera move by design, so
      // only an explicit disable is allowed to cancel it.
      layerState.abort?.abort();
      layerState.abort = null;
      layerState.measurementsAbort?.abort();
      layerState.measurementsAbort = null;
      layerState.loading = false;
      layerState.measurementsLoading = false;
      if (layerState.dataSource) layerState.dataSource.show = false;
      clearSelectedEntityContextForLayer(LAYER_ID);
      layerState.selectedId = null;
      layerState.failureReason = null;
      parts.ingestion.setWaterQualityStatus('idle');
    },

    destroy(viewer) {
      this.disable();
      layerState.moveEndRemove?.();
      layerState.clickHandler?.destroy();
      layerState.clickHandler = null;
      layerState.measurementsBySite.clear();
      parts.rendering.clearRendered();
      if (layerState.dataSource && viewer)
        viewer.dataSources.remove(layerState.dataSource, true);
      layerState.dataSource = null;
    },
  };

  return { methods };
}
