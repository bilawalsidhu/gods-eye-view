import * as Cesium from 'cesium';
import { ionRequestOptions } from '../sources/serverKeys.js';

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
  // The ion token stays on the server; ionRequestOptions routes the
  // endpoint request to this app's /api/ion/ when the token is server-managed.
  const options = ionRequestOptions(accessToken);
  if (
    style === Cesium.IonWorldImageryStyle.AERIAL ||
    style === Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS
  ) {
    return createBingIonImagery(style, options);
  }
  return Cesium.IonImageryProvider.fromAssetId(style, options);
}

async function createBingIonImagery(style, { accessToken, server }) {
  const endpoint = await new Cesium.Resource({
    url: new URL(
      `v1/assets/${style}/endpoint`,
      server || 'https://api.cesium.com/',
    ).href,
    queryParameters: accessToken ? { access_token: accessToken } : {},
  }).fetchJson();
  if (
    endpoint?.type !== 'IMAGERY' ||
    endpoint.externalType !== 'BING' ||
    typeof endpoint.options?.url !== 'string'
  ) {
    throw new Error('Ion world imagery did not return a Bing imagery endpoint');
  }
  // Bing otherwise follows the page's HTTP scheme on localhost. Resolve its
  // ion-issued credentials through public APIs so tiles use HTTPS without
  // weakening CSP, changing SDK defaults or touching provider internals.
  const { url, ...options } = endpoint.options;
  const provider = await Cesium.BingMapsImageryProvider.fromUrl(url, {
    ...options,
    tileProtocol: 'https',
  });
  const ionCredits = (endpoint.attributions ?? []).map(
    ({ html, collapsible }) => new Cesium.Credit(html, collapsible === false),
  );
  const getTileCredits = provider.getTileCredits.bind(provider);
  provider.getTileCredits = (x, y, level) => [
    ...ionCredits,
    ...(getTileCredits(x, y, level) ?? []),
  ];
  return provider;
}
