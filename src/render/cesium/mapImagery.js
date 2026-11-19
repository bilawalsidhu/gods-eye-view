/**
 * @module render/cesium/mapImagery
 * @description The map stacks' imagery for the Cesium renderer: OSM, Esri
 * World Imagery and Cesium ion's world imagery (Bing over HTTPS).
 */
import * as Cesium from 'cesium';
import { ESRI_IMAGERY_CREDIT } from '../../maps/attribution.js';
import { ionRequestOptions } from '../../sources/serverKeys.js';

export { ESRI_ATTRIBUTION_HTML } from '../../maps/attribution.js';

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
      credit: ESRI_IMAGERY_CREDIT,
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
