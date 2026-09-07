import { assertSameOriginPath, latitude, longitude } from './http.js';

export const AZURE_MAPS_TILE_ENDPOINT = '/api/azure/maps/tile';
export const AZURE_MAPS_ATTRIBUTION_ENDPOINT = '/api/azure/maps/attribution';
export const AZURE_MAPS_DEFAULT_ATTRIBUTION = '© Microsoft Azure Maps and data suppliers';

export const AZURE_MAPS_IMAGERY_BFF_CONTRACTS = Object.freeze({
  tile: Object.freeze({
    method: 'GET',
    path: AZURE_MAPS_TILE_ENDPOINT,
    query: 'tilesetId, zoom, x, y, tileSize=256',
    response: 'Azure Maps raster tile bytes with the upstream Content-Type',
  }),
  attribution: Object.freeze({
    method: 'GET',
    path: AZURE_MAPS_ATTRIBUTION_ENDPOINT,
    query: 'tilesetId=<comma-separated raster tileset IDs>, bounds=west,south,east,north, zoom',
    response: '{ copyrights: (string|{ copyright?: string, text?: string })[] }',
  }),
});

export const AZURE_MAPS_IMAGERY_STYLES = Object.freeze({
  satellite: Object.freeze({
    id: 'satellite',
    label: 'Azure Satellite',
    tilesetId: 'microsoft.imagery',
    minimumLevel: 1,
    maximumLevel: 19,
    layers: Object.freeze([
      Object.freeze({
        id: 'imagery',
        role: 'base',
        tilesetId: 'microsoft.imagery',
        minimumLevel: 1,
        maximumLevel: 19,
        hasAlphaChannel: false,
      }),
    ]),
  }),
  hybrid: Object.freeze({
    id: 'hybrid',
    label: 'Azure Hybrid',
    minimumLevel: 1,
    maximumLevel: 19,
    layers: Object.freeze([
      Object.freeze({
        id: 'imagery',
        role: 'base',
        tilesetId: 'microsoft.imagery',
        minimumLevel: 1,
        maximumLevel: 19,
        hasAlphaChannel: false,
      }),
      Object.freeze({
        id: 'labels',
        role: 'overlay',
        tilesetId: 'microsoft.base.hybrid.road',
        minimumLevel: 0,
        maximumLevel: 22,
        hasAlphaChannel: true,
      }),
    ]),
  }),
  streets: Object.freeze({
    id: 'streets',
    label: 'Azure Streets',
    tilesetId: 'microsoft.base.road',
    minimumLevel: 0,
    maximumLevel: 22,
    layers: Object.freeze([
      Object.freeze({
        id: 'streets',
        role: 'base',
        tilesetId: 'microsoft.base.road',
        minimumLevel: 0,
        maximumLevel: 22,
        hasAlphaChannel: false,
      }),
    ]),
  }),
});

export const OSM_FALLBACK_METADATA = Object.freeze({
  id: 'osm',
  label: 'OpenStreetMap',
  shortLabel: 'OSM',
  url: 'https://tile.openstreetmap.org/',
  credit: '© OpenStreetMap contributors',
  maximumLevel: 19,
  reason: 'Azure Maps imagery is unavailable',
});

export function getAzureMapsImageryStyle(style) {
  const value = AZURE_MAPS_IMAGERY_STYLES[String(style ?? '').toLowerCase()];
  if (!value) throw new RangeError(`Unsupported Azure Maps imagery style: ${style}`);
  return value;
}

export function getAzureMapsImageryLayers(style) {
  return [...getAzureMapsImageryStyle(style).layers];
}

function getAzureMapsImageryLayer(style, layer) {
  const config = getAzureMapsImageryStyle(style);
  if (layer == null) {
    if (config.layers.length === 1) return config.layers[0];
    throw new TypeError(`${config.label} is composite; select a layer or use the plural provider helper`);
  }
  if (typeof layer === 'object' && config.layers.includes(layer)) return layer;
  const selected = config.layers.find((candidate) => candidate.id === layer || candidate.role === layer);
  if (!selected) throw new RangeError(`Unsupported ${config.label} layer: ${layer}`);
  return selected;
}

function endpointUrl(endpoint) {
  return new URL(assertSameOriginPath(endpoint), 'https://same-origin.invalid');
}

function sameOriginHref(url) {
  return `${url.pathname}${url.search}`;
}

export function buildAzureMapsTileUrl(style, x, y, level, {
  layer,
  endpoint = AZURE_MAPS_TILE_ENDPOINT,
  tileSize = 256,
} = {}) {
  const config = getAzureMapsImageryLayer(style, layer);
  const url = endpointUrl(endpoint);
  url.searchParams.set('tilesetId', config.tilesetId);
  url.searchParams.set('zoom', String(level));
  url.searchParams.set('x', String(x));
  url.searchParams.set('y', String(y));
  url.searchParams.set('tileSize', String(tileSize));
  return sameOriginHref(url);
}

export function buildAzureMapsTileUrls(style, x, y, level, options = {}) {
  return getAzureMapsImageryLayers(style).map((layer) => buildAzureMapsTileUrl(
    style,
    x,
    y,
    level,
    { ...options, layer },
  ));
}

function normalizeBounds(bounds) {
  if (Array.isArray(bounds) && bounds.length === 4) {
    return [
      longitude(bounds[0]),
      latitude(bounds[1]),
      longitude(bounds[2]),
      latitude(bounds[3]),
    ];
  }
  return [
    longitude(bounds?.west),
    latitude(bounds?.south),
    longitude(bounds?.east),
    latitude(bounds?.north),
  ];
}

function attributionStrings(data) {
  const values = data?.copyrights ?? data?.attributions ?? [];
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((entry) => {
    if (typeof entry === 'string') return entry.trim();
    return String(entry?.copyright ?? entry?.text ?? entry?.attribution ?? '').trim();
  }).filter(Boolean))];
}

/**
 * Retrieve view-dependent attribution through the same-origin BFF.
 */
export async function fetchAzureMapsAttribution({
  style,
  bounds,
  zoom,
  fetchImpl = globalThis.fetch,
  endpoint = AZURE_MAPS_ATTRIBUTION_ENDPOINT,
  signal,
}) {
  const config = getAzureMapsImageryStyle(style);
  const normalizedBounds = normalizeBounds(bounds);
  const requestedZoom = Number(zoom);
  if (!Number.isFinite(requestedZoom)) throw new TypeError('zoom must be a finite number');
  const attributionZoom = Math.min(
    config.maximumLevel,
    Math.max(config.minimumLevel, requestedZoom),
  );
  const url = endpointUrl(endpoint);
  url.searchParams.set('tilesetId', config.layers.map((layer) => layer.tilesetId).join(','));
  url.searchParams.set('bounds', normalizedBounds.join(','));
  url.searchParams.set('zoom', String(attributionZoom));
  const response = await fetchImpl(sameOriginHref(url), { signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Azure Maps attribution failed: HTTP ${response.status}`);
  const values = attributionStrings(data);
  return values.length ? values : [AZURE_MAPS_DEFAULT_ATTRIBUTION];
}

export class AzureMapsAttributionController {
  constructor(options) {
    this.options = options;
    this.values = [AZURE_MAPS_DEFAULT_ATTRIBUTION];
    this.generation = 0;
  }

  getAttributions() {
    return [...this.values];
  }

  async update({ bounds, zoom, signal }) {
    const generation = ++this.generation;
    const values = await fetchAzureMapsAttribution({
      ...this.options,
      bounds,
      zoom,
      signal,
    });
    if (generation === this.generation) {
      this.values = values;
      this.options.requestRender?.();
    }
    return this.getAttributions();
  }
}

/**
 * Build one Cesium-compatible raster provider. Hybrid callers should use the
 * plural helper, which returns the base and overlay in display order.
 */
export function createAzureMapsCesiumImageryProvider(Cesium, {
  style = 'satellite',
  layer,
  attributionController = null,
  endpoint = AZURE_MAPS_TILE_ENDPOINT,
  tileSize = 256,
  loadImage,
} = {}) {
  if (!Cesium?.WebMercatorTilingScheme || !Cesium?.Resource || !Cesium?.Credit) {
    throw new TypeError('A Cesium namespace with WebMercatorTilingScheme, Resource, and Credit is required');
  }
  const config = getAzureMapsImageryLayer(style, layer);
  const imageLoader = loadImage || ((provider, resource) => Cesium.ImageryProvider.loadImage(provider, resource));
  const creditCache = new Map();

  const provider = {
    ready: true,
    readyPromise: Promise.resolve(true),
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: config.minimumLevel,
    maximumLevel: config.maximumLevel,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    rectangle: null,
    tileDiscardPolicy: undefined,
    errorEvent: Cesium.Event ? new Cesium.Event() : undefined,
    credit: new Cesium.Credit(AZURE_MAPS_DEFAULT_ATTRIBUTION),
    proxy: undefined,
    hasAlphaChannel: config.hasAlphaChannel,
    azureMapsLayer: config,

    getTileCredits() {
      const values = attributionController?.getAttributions?.()
        || [AZURE_MAPS_DEFAULT_ATTRIBUTION];
      return values.map((value) => {
        if (!creditCache.has(value)) creditCache.set(value, new Cesium.Credit(value));
        return creditCache.get(value);
      });
    },

    requestImage(x, y, level, request) {
      const resource = new Cesium.Resource({
        url: buildAzureMapsTileUrl(style, x, y, level, {
          layer: config,
          endpoint,
          tileSize,
        }),
        request,
      });
      return imageLoader(provider, resource);
    },

    pickFeatures() {
      return undefined;
    },
  };
  provider.rectangle = provider.tilingScheme.rectangle;
  return provider;
}

export function createAzureMapsCesiumImageryProviders(Cesium, options = {}) {
  const style = options.style || 'satellite';
  return getAzureMapsImageryLayers(style).map((layer) => (
    createAzureMapsCesiumImageryProvider(Cesium, { ...options, style, layer })
  ));
}

export function createOsmFallbackProvider(Cesium, metadata = OSM_FALLBACK_METADATA) {
  if (!Cesium?.OpenStreetMapImageryProvider) {
    throw new TypeError('Cesium.OpenStreetMapImageryProvider is required');
  }
  return new Cesium.OpenStreetMapImageryProvider({
    url: metadata.url,
    credit: metadata.credit,
    maximumLevel: metadata.maximumLevel,
  });
}

export async function resolveAzureMapsCesiumImagery(Cesium, options = {}) {
  const style = getAzureMapsImageryStyle(options.style || 'satellite');
  const providers = createAzureMapsCesiumImageryProviders(Cesium, options);
  return {
    provider: providers.length === 1 ? providers[0] : null,
    providers,
    baseProvider: providers[0],
    overlayProviders: providers.slice(1),
    effectiveStyle: style.id,
    fallback: null,
  };
}
