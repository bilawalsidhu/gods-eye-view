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
 * The imagery factory a globe stack descriptor names: ion styles, OSM, or
 * Esri. Shared by the default map sources and the Cesium globe engine.
 * @param {{ kind: string, style?: number }} descriptor
 * @param {string} [ionToken]
 * @returns {(request?: { signal?: AbortSignal }) => object | Promise<object>}
 */
export function imageryFactoryFor(descriptor, ionToken = '') {
  if (descriptor.kind === 'ion')
    return () => createIonImagery(descriptor.style, ionToken);
  return descriptor.kind === 'osm' ? createOsmImagery : createEsriImagery;
}
