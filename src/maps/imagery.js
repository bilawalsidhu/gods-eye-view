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
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken }).then(
    upgradeBingTileProtocol,
  );
}

/**
 * Cesium's Bing provider requests tiles over the page's own protocol, so on
 * http://localhost every tile is an http:// URL that the CSP's https-only
 * img-src blocks and the globe renders blank. ion offers no way to pass
 * Bing's `tileProtocol` option through, so upgrade the inner template here.
 * The labelled style's http host has no matching certificate; Bing serves
 * those tiles over https from its `{subdomain}.ssl.ak.dynamic` host instead.
 */
export function upgradeBingTileProtocol(provider) {
  const bing = provider?._imageryProvider;
  const template = bing?._imageUrlTemplate;
  if (typeof template === 'string' && template.startsWith('http:'))
    bing._imageUrlTemplate = `https:${template.slice('http:'.length)}`.replace(
      'https://ak.dynamic.{subdomain}.tiles.virtualearth.net/',
      'https://{subdomain}.ssl.ak.dynamic.tiles.virtualearth.net/',
    );
  return provider;
}
