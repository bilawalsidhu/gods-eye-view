import * as Cesium from 'cesium';

/** Return the display color bucket for a lightning flash energy. */
export function flashColor(energyJ) {
  const css = energyJ < 1e-14 ? '#7fe3ff' : energyJ < 1e-13 ? '#ffd166' : '#ffffff';
  return Cesium.Color.fromCssColorString(css);
}

/** Summarize a GLM manifest for layer status displays. */
export function lightningStats(manifest) {
  const flashes = manifest?.flashes;
  const valid = Array.isArray(flashes) && Number.isFinite(flashes.length);
  return {
    count: manifest?.returnedCount ?? (valid ? flashes.length : 0),
    lastUpdate: manifest?.fetchedAt ?? null,
    error: valid ? null : 'Malformed lightning snapshot',
    truncated: Boolean(manifest?.truncated),
  };
}

/** Create a Cesium point layer for GLM lightning flashes. */
export function createGlmLayer({ feed, cesium = Cesium } = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('GLM requires a snapshot source');
  let _viewer = null;
  let _points = null;
  let _request = null;
  let _enabled = false;
  let _stats = { count: 0, lastUpdate: null, error: null, truncated: false };
  const layer = {
    id: 'glm-lightning',
    name: 'GLM Lightning',
    icon: '⚡',
    source: 'NOAA GLM',
    updateInterval: 20000,
    init(viewer) {
      _viewer = viewer;
      _points = new cesium.PointPrimitiveCollection();
      _points.show = false;
      viewer.scene.primitives.add(_points);
    },
    enable() {
      _enabled = true;
      if (_points) _points.show = true;
    },
    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_points) {
        _points.show = false;
        _points.removeAll();
      }
    },
    async update(viewer, { signal } = {}) {
      if (!_enabled) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const manifest = await feed.getSnapshot({ signal: signal ?? request.signal });
        if (request.signal.aborted || signal?.aborted || _request !== request || !_enabled)
          return false;
        _points.removeAll();
        for (const flash of manifest.flashes.slice(0, 20000))
          _points.add({
            position: cesium.Cartesian3.fromDegrees(flash.lon, flash.lat),
            pixelSize: 6,
            color: flashColor(flash.energyJ),
            id: flash.id,
          });
        _stats = lightningStats(manifest);
        return true;
      } catch (error) {
        if (request.signal.aborted || signal?.aborted || _request !== request || !_enabled)
          return false;
        _stats = { ..._stats, error: error?.message || 'Lightning source unavailable' };
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },
    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      if (_points && viewer) viewer.scene.primitives.remove(_points);
      _points = null;
      _viewer = null;
      _enabled = false;
    },
    getStats() {
      return { ..._stats };
    },
    getPointCount() {
      return _points?.items?.length ?? 0;
    },
  };
  return layer;
}
