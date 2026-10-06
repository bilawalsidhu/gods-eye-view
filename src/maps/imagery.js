import * as Cesium from 'cesium';

import {
  SENTINEL2_MAX_ZOOM,
  SENTINEL2_MIN_ZOOM,
  SENTINEL2_TERRAIN_LEVELS,
  SENTINEL2_TILE_SIZE,
} from '../data/sentinel2Tiles.js';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}

/** Same-origin tile route; the server holds the Sentinel Hub credentials. */
export const SENTINEL2_TILE_URL = '/api/sentinel2/tile/{z}/{x}/{y}.png';

/**
 * Draw Sentinel-2 only where its 10 m pixels hold up: below the minimum the
 * view is regional, past the maximum it would be stretched pixels. Outside
 * the window the Esri underlay shows instead.
 */
export const SENTINEL2_LAYER_OPTIONS = Object.freeze({
  minimumTerrainLevel: SENTINEL2_TERRAIN_LEVELS.min,
  maximumTerrainLevel: SENTINEL2_TERRAIN_LEVELS.max,
});

/**
 * Least-cloudy Sentinel-2 mosaic of the last 30 days, via the local proxy.
 * The provider never asks outside z8-z14, the zooms the proxy accepts.
 */
export function createSentinel2Imagery() {
  return new Cesium.UrlTemplateImageryProvider({
    url: SENTINEL2_TILE_URL,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    minimumLevel: SENTINEL2_MIN_ZOOM,
    maximumLevel: SENTINEL2_MAX_ZOOM,
    tileWidth: SENTINEL2_TILE_SIZE,
    tileHeight: SENTINEL2_TILE_SIZE,
    hasAlphaChannel: true,
    enablePickFeatures: false,
  });
}
