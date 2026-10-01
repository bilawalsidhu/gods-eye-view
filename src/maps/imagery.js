import * as Cesium from 'cesium';

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

/**
 * NASA GIBS imagery, as a dated WMTS overlay.
 *
 * Uses the **EPSG:3857** endpoint, not EPSG:4326. GIBS' geographic matrix sets
 * are not power-of-two pyramids — the 1km set goes 2x1, 3x2, 5x3, 10x5 — while
 * Cesium's GeographicTilingScheme doubles every level. Mixing the two asks for
 * columns that do not exist and paints the ones that do in the wrong place
 * (Antarctic violet over southern Africa, observed 2026-09-21). The
 * GoogleMapsCompatible sets are standard 256 px power-of-two pyramids and map
 * straight onto WebMercatorTilingScheme.
 *
 * GIBS is keyless and sends `Access-Control-Allow-Origin: *` on tiles it has —
 * but omits it on the 404 for an unpublished date, so callers resolve an
 * available date by image probe rather than by fetch.
 * @param {{layer:string, date:string, tileMatrixSet?:string, maximumLevel?:number, credit?:string}} options GIBS layer, ISO date and matrix set.
 * @returns {Cesium.WebMapTileServiceImageryProvider} Overlay imagery provider.
 */
export function createGibsImagery({
  layer,
  date,
  tileMatrixSet = 'GoogleMapsCompatible_Level7',
  maximumLevel = 7,
  credit = 'NASA EOSDIS Global Imagery Browse Services (GIBS)',
}) {
  if (!layer || !date)
    throw new Error('GIBS imagery requires a layer and a date');
  return new Cesium.WebMapTileServiceImageryProvider({
    url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/${tileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png`,
    layer,
    style: 'default',
    format: 'image/png',
    tileMatrixSetID: tileMatrixSet,
    maximumLevel,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    credit,
    enablePickFeatures: false,
  });
}
