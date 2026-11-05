import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';

export function createLifecycle({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { clearSelectedEntityContextForLayer } = services.context;
  const { id, overlayHost } = config;

  // The heatmap is draped on the renderer's globe (Cesium only); it goes
  // with the renderer and is built again on the next one that can drape it.
  function releaseHeat() {
    clearTimeout(layerState._heatRebuildTimer);
    layerState._heatRebuildTimer = null;
    layerState._heatImagery?.destroy();
    layerState._heatImagery = null;
    layerState._heatRaster = null;
    layerState._handoffHeat = -1;
  }

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

    init(viewer, options) {
      this.attachRenderer(viewer, options);
    },
    attachRenderer(
      viewer,
      { engine = null, waitForCameraRestore = false } = {},
    ) {
      if (layerState._destroyed) return;
      if (layerState._renderer) return;
      layerState._renderer = config.renderer.create({
        viewer,
        engine,
        id,
        services,
        screenSpaceEventHandlerFactory: config.screenSpaceEventHandlerFactory,
      });
      layerState._viewer = layerState._renderer.view;
      layerState._dataSource = layerState._renderer.dataSource;
      layerState._renderer.setVisible(false);
      layerState._restoringViewport = waitForCameraRestore;
      if (layerState._enabled && !waitForCameraRestore) {
        this.showRenderer();
        layerState._renderer.onEnable();
      }
    },

    resumeViewport() {
      if (!layerState._restoringViewport) return;
      layerState._restoringViewport = false;
      if (layerState._enabled && layerState._renderer) {
        this.showRenderer();
        layerState._renderer.onEnable();
      }
    },

    detachRenderer() {
      components.selection.removeClickHandler();
      components.viewport.removeMoveEndWatcher();
      components.viewport.removeLodWatcher();
      unregisterPickOwner(id);
      components.rendering.removeDetectionCollections(layerState._viewer);
      releaseHeat();
      layerState._renderer?.destroy();
      layerState._renderer = layerState._viewer = layerState._dataSource = null;
      layerState._pickIndexById.clear();
      layerState._labelCandidates = [];
      layerState._camSnapValid = false;
    },

    showRenderer() {
      if (layerState._billboards) {
        // The camera can have moved anywhere while the layer was off: moveEnd
        // was not being listened to, and the preRender watcher is inert while
        // disabled AND while the (untimed) refetch below is in flight. So the
        // retained per-sprite show flags describe the OLD viewpoint. Re-cull
        // BEFORE the collection becomes visible — otherwise re-enabling at a
        // new location flashes far-side fires through the planet (and keeps
        // near-side ones hidden) until the fetch resolves.
        components.rendering.refreshHorizonCulling();
      }
      layerState._renderer.setVisible(true);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, true);
      // A filter can leave an old raster cached while the current set is empty.
      layerState._heatImagery?.setShow(layerState._fires.length > 0);
      // The camera can have crossed the hand-off while the layer was off.
      components.rendering.applyHandoffFade(true);
      components.viewport.installLodWatcher();
      components.viewport.installMoveEndWatcher();
      components.selection.installClickHandler();
      registerPickOwner(id, (pickedId) =>
        layerState._pickIndexById.has(pickedId),
      );
      components.rendering.renderCurrentLod(true);
    },

    async enable(viewer) {
      if (layerState._destroyed) return;
      if (!layerState._dataSource) this.init(viewer);
      layerState._enabled = true;
      const renderer = layerState._renderer;
      this.showRenderer();
      if (!layerState._fires.length && !layerState._loading)
        await components.ingestion.loadHeatmap();
      if (layerState._enabled && layerState._renderer === renderer)
        renderer.onEnable();
    },

    disable() {
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      layerState._enabled = false;
      components.selection.clearFireSelection();
      layerState._renderer?.setVisible(false);
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
      components.rendering.removeDetectionCollections(viewer);
      layerState._renderer?.destroy();
      layerState._renderer = null;
      layerState._viewer = null;
      layerState._dataSource = null;
      components.selection.clearContextRegistrations();
      clearSelectedEntityContextForLayer(id);
      layerState._allFires = [];
      layerState._allFiresByFrp = [];
      layerState._fires = [];
      layerState._firesByFrp = [];
      layerState._cellCacheByGrid.clear();
      layerState.glowSpriteCache.clear();
      releaseHeat();
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
