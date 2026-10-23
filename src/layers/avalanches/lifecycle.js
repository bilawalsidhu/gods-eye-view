import * as Cesium from 'cesium';
import { createAvalanchePanel } from './panel.js';

export function createLifecycle({ state: layerState, parts }) {
  const methods = {
    init(viewer) {
      layerState.viewer = viewer;
      layerState.dataSource = new Cesium.CustomDataSource('avalanches');
      layerState.dataSource.show = false;
      viewer.dataSources.add(layerState.dataSource);
      parts.panel = createAvalanchePanel({
        container: viewer.container,
        onDay: (index) => parts.playback.seekDay(index),
        onToggle: () => parts.playback.togglePlay(),
        onReplay: () => void parts.ingestion.startReplay(),
        onWeek: (from, to) => void parts.ingestion.loadWeek(from, to),
        onLive: () => void parts.ingestion.loadLive(),
      });
      parts.selection.install(viewer);
    },

    enable() {
      layerState.enabled = true;
      if (layerState.dataSource) layerState.dataSource.show = true;
      // DataLayerManager calls update() straight after enable(), which owns
      // the first window. Avoid racing it with a second request here.
    },

    disable() {
      layerState.enabled = false;
      layerState.abort?.abort();
      layerState.abort = null;
      layerState.loading = false;
      parts.playback.stop();
      parts.presenter.hide();
      parts.rendering.clear();
      if (layerState.dataSource) layerState.dataSource.show = false;
      layerState.window = null;
      layerState.season = null;
      layerState.selected = null;
      layerState.quiet = false;
      layerState.failureReason = null;
      parts.ingestion.setStatus('idle');
    },

    destroy(viewer) {
      this.disable();
      parts.selection.uninstall();
      parts.panel?.destroy();
      parts.panel = null;
      if (layerState.dataSource && viewer)
        viewer.dataSources.remove(layerState.dataSource, true);
      layerState.dataSource = null;
      layerState.viewer = null;
    },
  };

  return { methods };
}
