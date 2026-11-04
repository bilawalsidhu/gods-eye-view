import * as Cesium from 'cesium';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';

export function createLifecycle({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { restoreSpriteOrderOnEnable } = services.sprites;
  const { clearSelectedEntityContextForLayer } = services.context;
  const { id, overlayHost } = config;

  const methods = {
    init(viewer) {
      if (layerState._destroyed) return;
      layerState._viewer = viewer;
      layerState._dataSource = new Cesium.CustomDataSource(id);
      layerState._dataSource.show = false;
      viewer.dataSources.add(layerState._dataSource);
    },

    async enable(viewer) {
      if (layerState._destroyed) return;
      layerState._enabled = true;
      layerState._viewer = viewer;
      if (!layerState._dataSource) this.init(viewer);
      if (layerState._dataSource) layerState._dataSource.show = true;
      // The GPU culls the far side each frame, so retained rows are right
      // for wherever the camera went while the layer was off.
      if (layerState._icons) layerState._icons.show = true;
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, true);
      components.viewport.installLodWatcher();
      components.viewport.installMoveEndWatcher();
      components.selection.installClickHandler();
      registerPickOwner(id, (pickedId) =>
        layerState._pickIndexById.has(pickedId),
      );
      if (!layerState._fires.length && !layerState._loading)
        await components.ingestion.loadHeatmap();
      if (
        layerState._enabled &&
        !layerState._destroyed &&
        layerState._viewer === viewer
      )
        restoreSpriteOrderOnEnable('firms', viewer);
    },

    disable() {
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      layerState._enabled = false;
      components.selection.clearFireSelection();
      if (layerState._dataSource) layerState._dataSource.show = false;
      if (layerState._icons) layerState._icons.show = false;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      clearSelectedEntityContextForLayer(id);
      components.selection.removeClickHandler();
      components.viewport.removeMoveEndWatcher();
      unregisterPickOwner(id);
      components.viewport.removeLodWatcher();
    },

    destroy(viewer = layerState._viewer) {
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      if (layerState._destroyed) return;
      layerState._destroyed = true;
      layerState._enabled = false;
      components.viewport.removeLodWatcher();
      components.viewport.removeMoveEndWatcher();
      components.selection.removeClickHandler();
      unregisterPickOwner(id);
      if (layerState._dataSource && viewer) {
        viewer.dataSources.remove(layerState._dataSource, true);
      }
      layerState._dataSource = null;
      components.rendering.removeDetectionCollections(viewer);
      components.selection.clearContextRegistrations();
      clearSelectedEntityContextForLayer(id);
      layerState._fires = [];
      layerState._firesByFrp = [];
      layerState._cellCacheByGrid.clear();
      layerState._count = 0;
      layerState._cellCount = 0;
      layerState._lastUpdate = null;
      layerState._keyRequired = false;
      layerState._stale = false;
      layerState._error = null;
      layerState._currentLodId = null;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      layerState._currentLodIndex = -1;
      layerState._lastViewRect = null;
      layerState._selectedFire = null;
      layerState._labelCandidates = [];
      layerState._labelLodDistance = 0;
      layerState._pickIndexById.clear();
      layerState._fireByCardId.clear();
      layerState._camSnapValid = false;
    },
  };

  return { methods };
}
