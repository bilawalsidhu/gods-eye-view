import * as Cesium from 'cesium';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';
import { LOD_LEVELS } from './policy.js';

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
    /**
     * Shell services: `imageryHost()` resolves where draped imagery goes on
     * the active map stack (globe or 3D tiles, src/maps/imageryHost.js). The
     * heatmap moves with it; without a host it drapes on viewer.imageryLayers.
     * @param {{imageryHost?: () => {collection: ?Object, kind: string}}|null} services
     */
    attachShellServices(services) {
      layerState._imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      layerState._heatImagery?.rehome();
    },

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
      if (layerState._billboards) {
        // The camera can have moved anywhere while the layer was off: moveEnd
        // was not being listened to, and the preRender watcher is inert while
        // disabled AND while the (untimed) refetch below is in flight. So the
        // retained per-sprite show flags describe the OLD viewpoint. Re-cull
        // BEFORE the collection becomes visible — otherwise re-enabling at a
        // new location flashes far-side fires through the planet (and keeps
        // near-side ones hidden) until the fetch resolves.
        components.rendering.refreshHorizonCulling();
        layerState._billboards.show = true;
      }
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, true);
      if (LOD_LEVELS[layerState._currentLodIndex]?.mode === 'heat')
        layerState._heatImagery?.setShow(true);
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
      if (layerState._billboards) layerState._billboards.show = false;
      layerState._heatImagery?.setShow(false);
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
      layerState._allFires = [];
      layerState._allFiresByFrp = [];
      layerState._fires = [];
      layerState._firesByFrp = [];
      layerState._cellCacheByGrid.clear();
      clearTimeout(layerState._heatRebuildTimer);
      layerState._heatRebuildTimer = null;
      layerState._heatImagery?.destroy();
      layerState._heatImagery = null;
      layerState._heatRaster = null;
      layerState._imageryHost = null;
      layerState._count = 0;
      layerState._totalCount = 0;
      layerState._rowControlsListener = null;
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
      layerState._cullPositions.length = 0;
      layerState._camSnapValid = false;
    },
  };

  return { methods };
}
