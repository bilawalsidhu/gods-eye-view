/**
 * @file weatherRadar.js
 * @description Live Weather Radar layer using RainViewer tiled precipitation radar.
 * Fetches current radar frames via the server proxy and renders them on the Cesium globe.
 */

import * as Cesium from 'cesium';
import { registerDynamicCredit, RAINVIEWER_CREDIT } from './dataCredits.js';

const METADATA_URL = '/api/weather-radar/metadata';
const METADATA_REFRESH_MS = 5 * 60_000;

const DEFAULT_OPTIONS = {
  colorScheme: '2',
  smooth: '1',
  snow: '1',
  opacity: 0.7, // Keep 0.7 to match unit tests and standard overlay opacity
};

let _viewer = null;
let _enabled = false;
let _radarLayer = null;
let _metadataRefreshTimer = null;
let _host = '';
let _latestFrame = null;
let _opacity = DEFAULT_OPTIONS.opacity;
let _lastUpdate = null;
let _lastError = null;

function getTileSize() {
  if (typeof window !== 'undefined' && window.devicePixelRatio >= 2) {
    return 512;
  }
  return 256;
}

async function fetchMetadata() {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';
  const response = await fetch(new URL(METADATA_URL, origin).toString());
  if (!response.ok) {
    throw new Error(`Metadata fetch failed: ${response.status}`);
  }
  return await response.json();
}

function removeRadarLayer() {
  if (_viewer && _radarLayer) {
    try {
      _viewer.imageryLayers.remove(_radarLayer, true);
    } catch {
      /* best effort */
    }
    _radarLayer = null;
  }
}

function updateRadarLayer() {
  if (!_viewer || !_enabled || !_latestFrame || !_host) {
    removeRadarLayer();
    return;
  }

  const size = getTileSize();
  const url = `/api/weather-radar/tile?host=${encodeURIComponent(_host)}&framePath=${encodeURIComponent(_latestFrame.path)}&size=${size}&z={z}&x={x}&y={y}&color=${DEFAULT_OPTIONS.colorScheme}&options=${DEFAULT_OPTIONS.smooth}_${DEFAULT_OPTIONS.snow}`;

  if (_radarLayer) {
    _radarLayer.show = _enabled;
    _radarLayer.alpha = _opacity;
    return;
  }

  const provider = new Cesium.UrlTemplateImageryProvider({
    url,
    tileWidth: size,
    tileHeight: size,
    minimumLevel: 0,
    maximumLevel: 7,
    credit: 'RainViewer',
    enablePickFeatures: false,
  });

  _radarLayer = new Cesium.ImageryLayer(provider, {
    alpha: _opacity,
    show: _enabled,
  });

  _viewer.imageryLayers.add(_radarLayer);
  _viewer.imageryLayers.raiseToTop(_radarLayer);
}

async function refreshRadar() {
  try {
    const data = await fetchMetadata();
    _host = data.host || 'https://tilecache.rainviewer.com';
    const frames = data.frames || [];

    if (frames.length > 0) {
      const latest = frames[frames.length - 1];
      if (!_latestFrame || _latestFrame.path !== latest.path) {
        _latestFrame = latest;
        removeRadarLayer();
        updateRadarLayer();
      }
      _lastUpdate = Date.now();
      _lastError = null;
    }
  } catch (err) {
    _lastError = err.message;
    console.warn('[Weather Radar] Refresh error:', err);
  }
}

/**
 * Weather Radar data layer module.
 * Implements the standard God's Eye View DataLayer contract.
 */
export const weatherRadarLayer = {
  id: 'weather-radar',
  name: 'Weather Radar',
  icon: '🌦',
  source: 'RainViewer',
  updateInterval: 300000,

  async init(viewer) {
    _viewer = viewer;
    registerDynamicCredit(viewer, RAINVIEWER_CREDIT);
    return true;
  },

  async enable(viewer) {
    if (viewer) _viewer = viewer;
    _enabled = true;

    await refreshRadar();
    updateRadarLayer();

    if (!_metadataRefreshTimer) {
      _metadataRefreshTimer = setInterval(refreshRadar, METADATA_REFRESH_MS);
      _metadataRefreshTimer?.unref?.();
    }
    return true;
  },

  async update(viewer) {
    if (viewer) _viewer = viewer;
    await refreshRadar();
    return true;
  },

  async disable() {
    _enabled = false;
    if (_metadataRefreshTimer) {
      clearInterval(_metadataRefreshTimer);
      _metadataRefreshTimer = null;
    }
    if (_radarLayer) {
      _radarLayer.show = false;
    }
    return true;
  },

  async destroy() {
    await this.disable();
    removeRadarLayer();
    _viewer = null;
    _latestFrame = null;
    return true;
  },

  setParams(params) {
    if (params?.opacity !== undefined) {
      _opacity = Math.max(0, Math.min(1, Number(params.opacity)));
      if (_radarLayer) {
        _radarLayer.alpha = _opacity;
      }
    }
    return true;
  },

  getParams() {
    return { opacity: _opacity };
  },

  getStats() {
    return {
      lastUpdate: _lastUpdate,
      status: _lastError ? 'degraded' : _enabled ? 'nominal' : 'disabled',
      error: _lastError,
      frames: _latestFrame ? 1 : 0,
      source: 'RainViewer',
      coverage: 'global',
    };
  },

  isEnabled() {
    return _enabled;
  },
};

export default weatherRadarLayer;
