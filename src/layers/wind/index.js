import * as Cesium from 'cesium';
import { createWindRendering } from './rendering.js';

/** Summarize a wind manifest for the layer status surface. */
export function windStats(manifest) {
  return {
    count: manifest?.grid ? manifest.grid.nx * manifest.grid.ny : 0,
    lastUpdate: manifest?.cycle?.runIso ? Date.parse(manifest.cycle.runIso) : manifest?.fetchedAt ?? null,
    error: manifest?.unavailable ? manifest.reason || 'Wind unavailable' : manifest?.reason || null,
  };
}

/** Create the GFS wind data layer. */
export function createWindLayer({ feed, cesium = Cesium, container, services } = {}) {
  if (typeof feed?.getSnapshot !== 'function') throw new TypeError('Wind requires a snapshot source');
  let viewer = null;
  let request = null;
  let enabled = false;
  let rendering = null;
  let manifest = null;
  let error = null;
  const layer = {
    id: 'wind', name: 'Wind', icon: '🌬', source: 'NOAA GFS', updateInterval: 3600_000,
    init(nextViewer) { viewer = nextViewer; rendering = createWindRendering({ cesium, container: nextViewer.container, getViewer: () => viewer }); rendering.attach(); },
    enable() { enabled = true; rendering?.start(); },
    disable() { request?.abort(); request = null; enabled = false; rendering?.stop(); rendering?.clear(); },
    async update(nextViewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const snapshot = await feed.getSnapshot({ signal: signal || controller.signal });
        if (!enabled || controller.signal.aborted || signal?.aborted) return false;
        manifest = snapshot;
        error = null;
        if (!snapshot.unavailable) rendering.setField(snapshot);
        return true;
      } catch (cause) {
        if (controller.signal.aborted || signal?.aborted) return false;
        error = cause?.message || 'Wind source unavailable';
        return true;
      } finally { if (request === controller) request = null; }
    },
    destroy() { request?.abort(); request = null; enabled = false; rendering?.destroy(); rendering = null; viewer = null; },
    getStats() { return { ...windStats(manifest), error: error || windStats(manifest).error }; },
    getParticleCount() { return rendering?.getParticleCount() || 0; },
  };
  return layer;
}
