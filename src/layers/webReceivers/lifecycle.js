import * as Cesium from 'cesium';
import { DEFAULT_FILTER } from './policy.js';

export function createLifecycle({ state: layerState, parts }) {
  const methods = {
    /** Create the data source once; markers stay hidden until enabled. */
    init(viewer) {
      layerState._sessionGeneration += 1;
      layerState._viewer = viewer;
      if (!layerState._dataSource) {
        layerState._dataSource = new Cesium.CustomDataSource('Web receivers');
        viewer.dataSources.add(layerState._dataSource);
        parts.rendering.installClusterStyling();
      }
      layerState._dataSource.show = false;
    },

    enable() {
      layerState._enabled = true;
      parts.interaction.syncPresentation();
      parts.presentation.emitState();
    },

    /** Hide the layer and cancel any request; the catalog and selection survive. */
    disable() {
      layerState._sessionGeneration += 1;
      layerState._enabled = false;
      layerState._requestGeneration += 1;
      layerState._abort?.abort();
      layerState._abort = null;
      layerState._loading = false;
      layerState._loadPromise = null;
      parts.interaction.removeInteraction();
      if (layerState._dataSource) layerState._dataSource.show = false;
      if (layerState._selectedEntity && layerState._viewer)
        layerState._viewer.entities.remove(layerState._selectedEntity);
      layerState._selectedEntity = null;
      parts.presentation.emitState();
    },

    destroy() {
      this.disable();
      layerState._removeClusterListener?.();
      layerState._removeClusterListener = null;
      if (layerState._dataSource && layerState._viewer)
        layerState._viewer.dataSources.remove(layerState._dataSource, true);
      layerState._dataSource = null;
      layerState._receivers = Object.freeze([]);
      layerState._byId = new Map();
      layerState._renderById.clear();
      layerState._selectedId = null;
      layerState._highlightIds = new Set();
      layerState._filter = DEFAULT_FILTER;
      layerState._lastTune = null;
      layerState._lastSearch = null;
      layerState._error = null;
      layerState._stale = false;
      layerState._degraded = false;
      layerState._updatedAt = null;
      layerState._sources = null;
      layerState._managerPresentation = null;
      layerState._viewer = null;
      parts.presentation.emitState();
      layerState._listeners.clear();
    },
  };

  return { methods };
}
