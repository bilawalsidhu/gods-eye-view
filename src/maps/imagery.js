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

export const KARTVERKET_ATTRIBUTION_HTML =
  '© <a href="https://www.kartverket.no" target="_blank" rel="noopener">Kartverket</a>, CC BY 4.0';

/**
 * Kartverket's open WMTS cache (no key, CORS open): Norway's topographic
 * map, or its nautical charts. Tiles outside each layer's extent come back
 * empty, so requests stop at it: elsewhere the bare globe shows.
 */
export const KARTVERKET_LAYERS = Object.freeze({
  topo: Object.freeze({
    west: 3.7765,
    south: 57.6411,
    east: 31.9867,
    north: 71.5664,
  }),
  sjokartraster: Object.freeze({
    west: -14.6549,
    south: 53.7516,
    east: 44.2455,
    north: 81.7781,
  }),
});

export function createKartverketImagery(layer) {
  const extent = KARTVERKET_LAYERS[layer];
  if (!extent) throw new Error(`Unknown Kartverket layer: ${layer}`);
  return new Cesium.UrlTemplateImageryProvider({
    url: `https://cache.kartverket.no/v1/wmts/1.0.0/${layer}/default/webmercator/{z}/{y}/{x}.png`,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    maximumLevel: 18,
    rectangle: Cesium.Rectangle.fromDegrees(
      extent.west,
      extent.south,
      extent.east,
      extent.north,
    ),
    credit: new Cesium.Credit(KARTVERKET_ATTRIBUTION_HTML),
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
  if (
    style === Cesium.IonWorldImageryStyle.AERIAL ||
    style === Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS
  ) {
    return createBingIonImagery(style, accessToken);
  }
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}

async function createBingIonImagery(style, accessToken) {
  const endpoint = await new Cesium.Resource({
    url: `https://api.cesium.com/v1/assets/${style}/endpoint`,
    queryParameters: { access_token: accessToken },
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
