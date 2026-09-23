import * as Cesium from 'cesium';
import { normalizeRepeaterFilter } from '../../sources/hamRepeaters.js';
import { INITIAL_GATE } from './state.js';

export function createLifecycle({ state: layerState, parts }) {
  const methods = {
    /** Create the data source once; markers stay hidden until enabled. */
    init(viewer) {
      layerState._sessionGeneration += 1;
      layerState._viewer = viewer;
      const created = !layerState._dataSource;
      if (created) {
        layerState._dataSource = new Cesium.CustomDataSource('Ham repeaters');
        viewer.dataSources.add(layerState._dataSource);
        parts.rendering.installClusterStyling();
      }
      layerState._dataSource.show = false;
      // The public surface (the voice tool, ensureLoaded) can load rows before
      // the manager ever calls init. reconcile() drops markers while there is
      // no data source, so replay what state already holds or the globe and
      // the panel disagree until the next successful load.
      if (created && layerState._repeaters.length)
        parts.rendering.reconcile(layerState._repeaters);
    },

    enable() {
      layerState._enabled = true;
      parts.camera.installCameraWatch();
      parts.interaction.syncPresentation();
      parts.presentation.emitState();
      // DataLayerManager calls update() right after enable(); it owns the first fetch.
    },

    /** Hide the layer and cancel any request; the last result, area and selection survive. */
    disable() {
      layerState._sessionGeneration += 1;
      layerState._enabled = false;
      parts.camera.removeCameraWatch();
      layerState._requestGeneration += 1;
      layerState._abort?.abort();
      layerState._abort = null;
      layerState._loading = false;
      parts.interaction.removeInteraction();
      if (layerState._dataSource) layerState._dataSource.show = false;
      if (layerState._viewer) {
        if (layerState._selectedEntity)
          layerState._viewer.entities.remove(layerState._selectedEntity);
        if (layerState._hoverEntity)
          layerState._viewer.entities.remove(layerState._hoverEntity);
      }
      layerState._selectedEntity = null;
      layerState._hoverEntity = null;
      layerState._hoverId = null;
      parts.presentation.emitState();
    },

    destroy() {
      this.disable();
      layerState._removeClusterListener?.();
      layerState._removeClusterListener = null;
      parts.rendering.clearRendered();
      if (layerState._dataSource && layerState._viewer)
        layerState._viewer.dataSources.remove(layerState._dataSource, true);
      layerState._dataSource = null;
      layerState._repeaters = Object.freeze([]);
      layerState._byId = new Map();
      layerState._area = null;
      layerState._gate = INITIAL_GATE;
      layerState._lastLoad = null;
      layerState._selectedId = null;
      layerState._filter = normalizeRepeaterFilter();
      layerState._error = null;
      layerState._stale = false;
      layerState._partial = false;
      layerState._errors = Object.freeze({});
      layerState._sources = Object.freeze([]);
      layerState._updatedAt = null;
      layerState._managerPresentation = null;
      layerState._viewer = null;
      parts.presentation.emitState();
      layerState._listeners.clear();
      layerState._rowControlsListener = null;
    },
  };

  return { methods };
}
