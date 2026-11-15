import * as Cesium from 'cesium';
import { createMonthIndicator } from './indicator.js';

export function createLifecycle({ state: layerState, services, parts }) {
  const methods = {
    init(viewer) {
      layerState.viewer = viewer;
      layerState.sampleDataSource = new Cesium.CustomDataSource(
        'surface-temperature-sample',
      );
      viewer.dataSources.add(layerState.sampleDataSource);
      parts.sampling.installInteraction(viewer);
      parts.indicator = createMonthIndicator({
        container: viewer.container,
        // A failed year is reported on the panel itself (view().error).
        onYear: (year) => void parts.playback.selectYear(year).catch(() => {}),
        onMonth: (month) => parts.playback.seekMonth(month),
        onToggle: () => parts.playback.togglePlay(),
      });
    },

    enable() {
      layerState.enabled = true;
      // DataLayerManager calls update() straight after enable(), which owns the
      // first year resolution. Avoid racing it with a second request.
    },

    disable() {
      layerState.enabled = false;
      layerState.abort?.abort();
      layerState.abort = null;
      layerState.sampleAbort?.abort();
      layerState.sampleAbort = null;
      layerState.sampling = false;
      layerState.loading = false;
      parts.playback.release();
      parts.sampling.clearReadout();
      layerState.failureReason = null;
      parts.ingestion.setStatus('idle');
    },

    destroy(viewer) {
      this.disable();
      layerState.clickHandler?.destroy();
      layerState.clickHandler = null;
      if (layerState.sampleDataSource && viewer)
        viewer.dataSources.remove(layerState.sampleDataSource, true);
      layerState.sampleDataSource = null;
      parts.indicator?.destroy();
      parts.indicator = null;
      layerState.viewer = null;
    },
  };

  return { methods };
}
