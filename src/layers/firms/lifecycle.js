import { drawOf } from '../../render/rendererOf.js';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';

/**
 * The layer's shape sets start with this; each layer has its own
 * (`firms:1:cells`, …), so several can share a renderer.
 */
export const FIRMS_CELL_SET_PREFIX = 'firms';
let instances = 0;

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
      layerState._cells = drawOf(viewer).shapes({
        id: `${FIRMS_CELL_SET_PREFIX}:${++instances}:cells`,
        clampTo: 'both',
        show: false,
      });
    },

    async enable(viewer) {
      if (layerState._destroyed) return;
      layerState._enabled = true;
      layerState._viewer = viewer;
      if (!layerState._cells) this.init(viewer);
      if (layerState._cells) layerState._cells.show = true;
      // The GPU culls the far side each frame, so retained rows are right
      // for wherever the camera went while the layer was off.
      if (layerState._icons) layerState._icons.show = true;
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
      if (!layerState._fires.length && !layerState._loading)
        await components.ingestion.loadHeatmap();
    },

    disable() {
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      layerState._enabled = false;
      components.selection.clearFireSelection();
      if (layerState._cells) layerState._cells.show = false;
      if (layerState._icons) layerState._icons.show = false;
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
      layerState._cells?.dispose();
      layerState._cells = null;
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
      layerState._handoffHeat = -1;
      layerState._imageryHost = null;
      layerState._count = 0;
      layerState._totalCount = 0;
      layerState._rowControlsListener = null;
      layerState._cellCount = 0;
      layerState._lastUpdate = null;
      layerState._at = null;
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
