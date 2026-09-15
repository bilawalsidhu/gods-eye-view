import * as Cesium from 'cesium';
import { createWindRendering } from './rendering.js';

/** Format an ISO date/time into UTC string (YYYY-MM-DD HH:mm UTC). */
export function formatWindValidTime(isoString) {
  if (!isoString) return null;
  const timeMs = Date.parse(isoString);
  if (!Number.isFinite(timeMs)) return null;
  const date = new Date(timeMs);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min} UTC`;
}

/** Summarize a wind manifest for the layer status surface. */
export function windStats(manifest) {
  const time = manifest?.cycle?.validIso || manifest?.cycle?.runIso;
  return {
    count: manifest?.grid ? manifest.grid.nx * manifest.grid.ny : 0,
    lastUpdate: time ? Date.parse(time) : (manifest?.fetchedAt ?? null),
    error: manifest?.unavailable
      ? manifest.reason || 'Wind unavailable'
      : manifest?.reason || null,
  };
}

/** Create the GFS/IFS wind data layer. */
export function createWindLayer({
  feed,
  cesium = Cesium,
  container,
  services,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Wind requires a snapshot source');
  let viewer = null;
  let request = null;
  let enabled = false;
  let rendering = null;
  let manifest = null;
  let error = null;
  let model = 'gfs';
  let generation = 0;
  let rowControlsListener = null;
  const layer = {
    id: 'wind',
    name: 'Wind',
    icon: '🌬',
    source: 'NOAA GFS / ECMWF IFS',
    updateInterval: 3600_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createWindRendering({
        cesium,
        container: nextViewer.container,
        getViewer: () => viewer,
      });
      rendering.attach();
    },
    enable() {
      enabled = true;
      rendering?.start();
    },
    disable() {
      request?.abort();
      request = null;
      enabled = false;
      rendering?.stop();
      rendering?.clear();
    },
    async update(nextViewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const snapshot = await feed.getSnapshot({
          signal: signal || controller.signal,
          model,
        });
        if (!enabled || controller.signal.aborted || signal?.aborted)
          return false;
        manifest = snapshot;
        error = null;
        if (!snapshot.unavailable) rendering.setField(snapshot);
        rowControlsListener?.();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || signal?.aborted) return false;
        error = cause?.message || 'Wind source unavailable';
        rowControlsListener?.();
        return true;
      } finally {
        if (request === controller) request = null;
      }
    },
    setParams(params = {}) {
      if (!['gfs', 'ifs'].includes(params.model) || params.model === model)
        return;
      model = params.model;
      generation += 1;
      rowControlsListener?.();
      if (enabled) {
        request?.abort();
        const currentGeneration = generation;
        queueMicrotask(() => {
          if (enabled && currentGeneration === generation) layer.update(viewer);
        });
      }
    },
    getParams() {
      return { model };
    },
    /**
     * Row controls: a GFS/IFS source chip, the wind-intensity colour legend,
     * and active model valid timestamp readout with sensible fallback.
     * The chip is stateless — it declares the params to apply and the manager
     * owns the write.
     * @returns {{chips: Array<object>, legend: Array<object>, info: string, infoTitle: string}}
     */
    getRowControls() {
      const chip = (value, label) => ({
        id: `model-${value}`,
        label,
        active: model === value,
        state: model === value ? 'active' : 'idle',
        title:
          value === 'gfs'
            ? 'Use NOAA GFS 10 m wind'
            : 'Use ECMWF IFS 10 m wind',
        params: { model: value },
      });
      const modelUpper = (model || 'gfs').toUpperCase();
      const validIso =
        manifest?.model === model && !manifest?.unavailable
          ? manifest?.cycle?.validIso || manifest?.cycle?.runIso
          : null;
      const validTimestamp = formatWindValidTime(validIso);
      const validLabel = validTimestamp
        ? `Valid: ${validTimestamp}`
        : 'Valid: Unavailable';

      return {
        chips: [chip('gfs', 'GFS'), chip('ifs', 'IFS')],
        legend: [
          { label: '0', color: '#1e3a8a' },
          { label: '5', color: '#2563eb' },
          { label: '10', color: '#22d3ee' },
          { label: '15', color: '#34d399' },
          { label: '20', color: '#fbbf24' },
          { label: '25', color: '#f97316' },
          { label: '30+ m/s', color: '#ef4444' },
        ],
        info: `${modelUpper} · ${validLabel}`,
        infoTitle: validTimestamp
          ? `${modelUpper} 10 m wind forecast valid at ${validTimestamp}`
          : `${modelUpper} 10 m wind forecast valid time unavailable`,
      };
    },
    /** Repaint the row after a synchronous model change. */
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    destroy() {
      request?.abort();
      request = null;
      enabled = false;
      rendering?.destroy();
      rendering = null;
      viewer = null;
    },
    getStats() {
      const stats = windStats(manifest);
      const modelUpper = (model || 'gfs').toUpperCase();
      const validIso =
        manifest?.model === model && !manifest?.unavailable
          ? manifest?.cycle?.validIso || manifest?.cycle?.runIso
          : null;
      const validTimestamp = formatWindValidTime(validIso);
      return {
        ...stats,
        source: model === 'ifs' ? 'ECMWF IFS' : 'NOAA GFS',
        model: modelUpper,
        validTime: validTimestamp || 'Unavailable',
        error: error || stats.error,
      };
    },
    getParticleCount() {
      return rendering?.getParticleCount() || 0;
    },
  };
  return layer;
}
