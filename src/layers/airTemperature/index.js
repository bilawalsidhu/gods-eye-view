import * as Cesium from 'cesium';
import { createAirTemperatureRendering } from './rendering.js';
import { createTemperatureInspection } from './inspection.js';
import { temperatureControls } from './presentation.js';
import { msg, t } from '../../i18n/index.js';

export function createAirTemperatureLayer({
  feed,
  clock,
  input,
  cesium = Cesium,
  container,
  createRendering = createAirTemperatureRendering,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Air temperature requires a snapshot source');
  let viewer = null;
  let rendering = null;
  let inspection = null;
  let imageryHost = null;
  let enabled = false;
  let request = null;
  let snapshot = null;
  let error = null;
  let units = '°C';
  let loading = false;
  let listener = null;
  const notify = () => listener?.();
  const unsubscribe = clock?.subscribe(notify);
  const layer = {
    id: 'air-temperature',
    name: 'Air Temperature',
    icon: '◐',
    source: 'NOAA GFS · FORECAST',
    updateInterval: 3600_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({
        cesium,
        getViewer: () => viewer,
        getHost: () =>
          imageryHost?.() ?? {
            collection: viewer.imageryLayers ?? viewer.scene?.imageryLayers,
            kind: 'globe',
          },
        onStatusChange: notify,
      });
      rendering.attach();
      inspection = createTemperatureInspection({
        viewer,
        cesium,
        input,
        container: container ?? viewer.container,
        getSnapshot: () => snapshot,
        onChange: notify,
      });
    },
    attachShellServices(services) {
      imageryHost = services?.imageryHost ?? null;
      rendering?.rehome();
    },
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      snapshot = null;
      error = null;
      loading = false;
      inspection?.clear();
      rendering?.clear();
      notify();
    },
    async update(nextViewer, { signal } = {}) {
      if (!enabled) return false;
      rendering?.rehome();
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const next = await feed.getSnapshot({ signal: controller.signal });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        snapshot = next;
        error = null;
        if (next.unavailable) {
          rendering?.clear();
          inspection?.clear();
        } else {
          rendering?.setField(next);
          inspection?.refresh();
        }
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = msg('Air temperature source unavailable');
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (['°C', '°F'].includes(params.units)) units = params.units;
      if (params.inspect === false) inspection?.clear();
      if (enabled && params.inspect === true) inspection?.sampleCenter();
      if (enabled && typeof params.pick === 'boolean')
        inspection?.setArmed(params.pick);
      if (enabled && params.point) inspection?.samplePoint(params.point);
      notify();
    },
    getParams() {
      return { units };
    },
    getPanelControls() {
      return temperatureControls({
        snapshot,
        units,
        loading,
        error: error || rendering?.getDiagnostics().imageryError,
        reading: inspection?.getReading(),
        armed: inspection?.isArmed(),
        history: clock?.getState().mode === 'history',
      });
    },
    getRowControls() {
      return layer.getPanelControls();
    },
    setRowControlsListener(next) {
      listener = typeof next === 'function' ? next : null;
    },
    getStats() {
      return {
        count: snapshot?.scalar?.values.length ?? 0,
        countLabel: t('Forecast'),
        lastUpdate: snapshot?.cycle ? Date.parse(snapshot.cycle.runIso) : null,
        loading,
        stale: Boolean(snapshot?.stale),
        source: 'NOAA GFS',
        model: 'GFS',
        validTime: snapshot?.cycle?.validIso,
        error:
          error ||
          snapshot?.reason ||
          rendering?.getDiagnostics().imageryError ||
          null,
      };
    },
    getDiagnostics() {
      return rendering?.getDiagnostics() ?? {};
    },
    destroy() {
      layer.disable();
      unsubscribe?.();
      inspection?.destroy();
      rendering?.destroy();
      viewer = rendering = inspection = imageryHost = listener = null;
    },
  };
  return layer;
}
