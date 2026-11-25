/**
 * @module render/vectorBase/style
 * @description Loads a MapLibre style document for the vector base painter:
 * its vector sources resolved to tile URL templates (a TileJSON `url`, or
 * inline `tiles`), its layers compiled ({@link module:render/vectorBase/expressions}),
 * and its background. A layer the painter cannot draw is listed in `skipped`
 * with the reason, never drawn wrong.
 */
import { compileFilter, compileValue, Unsupported } from './expressions.js';
import { colorOf, numberOf } from './paint.js';

/** Layer types the painter draws. */
export const PAINTED_TYPES = Object.freeze([
  'background',
  'fill',
  'line',
  'circle',
  'symbol',
]);

/** Paint and layout properties that, set, make a layer one not drawn. */
const UNDRAWN = Object.freeze({
  fill: ['fill-pattern', 'fill-translate'],
  line: ['line-pattern', 'line-offset', 'line-translate', 'line-gradient'],
  circle: ['circle-translate'],
  symbol: [],
  background: ['background-pattern'],
});

/** Properties whose values are arrays. */
const ARRAY_VALUES = new Set([
  'text-font',
  'text-offset',
  'text-translate',
  'text-variable-anchor',
  'line-dasharray',
  'icon-offset',
  'icon-translate',
  'fill-translate',
  'line-translate',
  'circle-translate',
]);

/**
 * Properties that interpolate (numbers, colours, number arrays the
 * specification marks interpolated): a legacy function without a `type` is
 * `exponential` on these and `interval` on every other (`line-cap`,
 * `line-join`, `line-dasharray`, `text-field`, `text-font`,
 * `text-transform`, `text-anchor`, ...).
 */
const INTERPOLATED = new Set([
  'background-color',
  'background-opacity',
  'fill-color',
  'fill-opacity',
  'fill-outline-color',
  'line-color',
  'line-opacity',
  'line-width',
  'line-gap-width',
  'line-blur',
  'circle-radius',
  'circle-color',
  'circle-opacity',
  'circle-blur',
  'circle-stroke-width',
  'circle-stroke-color',
  'circle-stroke-opacity',
  'text-size',
  'text-color',
  'text-opacity',
  'text-halo-color',
  'text-halo-width',
  'text-halo-blur',
  'text-offset',
  'text-max-width',
  'text-letter-spacing',
  'text-line-height',
  'text-rotate',
  'text-padding',
  'text-radial-offset',
]);

/** Defaults the painter reads for each layer type, as the specification's. */
const DEFAULTS = {
  background: { 'background-color': '#000000', 'background-opacity': 1 },
  fill: { 'fill-color': '#000000', 'fill-opacity': 1 },
  line: {
    'line-color': '#000000',
    'line-opacity': 1,
    'line-width': 1,
    'line-gap-width': 0,
    'line-cap': 'butt',
    'line-join': 'miter',
  },
  circle: {
    'circle-radius': 5,
    'circle-color': '#000000',
    'circle-opacity': 1,
    'circle-stroke-width': 0,
    'circle-stroke-color': '#000000',
    'circle-stroke-opacity': 1,
  },
  symbol: {
    'text-size': 16,
    'text-color': '#000000',
    'text-opacity': 1,
    'text-halo-color': 'rgba(0,0,0,0)',
    'text-halo-width': 0,
    'text-transform': 'none',
    'text-font': ['Open Sans Regular'],
    'symbol-placement': 'point',
  },
};

/**
 * Defaults a value that cannot be evaluated falls back to, beyond those the
 * painter always reads (`DEFAULTS`): the specification's.
 */
const FALLBACKS = {
  symbol: {
    'text-field': '',
    'text-anchor': 'center',
    'text-offset': [0, 0],
    'text-max-width': 10,
  },
};

/** `url` resolved against `base`; a data or blob URL as it is. */
function resolve(url, base) {
  if (/^(data|blob):/i.test(url)) return url;
  try {
    // A tile template's `{z}`, `{x}` and `{y}` stay as they are.
    return new URL(url, base).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  } catch {
    return url;
  }
}

/** A response's JSON, refusing a failed one. */
async function json(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok)
    throw new Error(`${url} answered ${response.status ?? 'an error'}`);
  return response.json();
}

/**
 * A compiled layer, or a reason it is not drawn.
 * @returns {{layer?: object, reason?: string}}
 */
function compileLayer(layer, sources) {
  const type = layer.type;
  if (!PAINTED_TYPES.includes(type)) return { reason: `${type} layers` };
  const layout = layer.layout ?? {};
  const paint = layer.paint ?? {};
  if (layout.visibility === 'none') return { reason: 'hidden' };
  for (const key of UNDRAWN[type])
    if (paint[key] !== undefined || layout[key] !== undefined)
      return { reason: key };
  if (type !== 'background') {
    const source = sources[layer.source];
    if (!source) return { reason: `source ${layer.source}, not vector` };
    if (!layer['source-layer']) return { reason: 'no source-layer' };
  }
  try {
    const values = {};
    for (const [key, value] of Object.entries({
      ...DEFAULTS[type],
      ...layout,
      ...paint,
    }))
      if (key !== 'visibility')
        values[key] = compileValue(value, {
          array: ARRAY_VALUES.has(key),
          interpolated: INTERPOLATED.has(key),
        });
    return {
      layer: {
        id: layer.id,
        type,
        source: layer.source,
        sourceLayer: layer['source-layer'],
        minzoom: layer.minzoom ?? 0,
        maxzoom: layer.maxzoom ?? 24,
        filter: compileFilter(layer.filter),
        values,
        // What a value that cannot be evaluated, or comes to nothing, is.
        defaults: { ...FALLBACKS[type], ...DEFAULTS[type] },
        hasText: type === 'symbol' && layout['text-field'] !== undefined,
        // A text field not an expression fills `{name}` tokens.
        tokens: !Array.isArray(layout['text-field']),
      },
    };
  } catch (error) {
    // Unsupported, or not a value the specification allows: not drawn.
    return {
      reason: error instanceof Unsupported ? error.message : String(error),
    };
  }
}

/**
 * Load a MapLibre style document and the TileJSON its vector sources name.
 * @param {string} styleUrl
 * @param {typeof fetch} [fetchImpl]
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{
 *   url: string,
 *   style: object,
 *   sources: Record<string, {tiles: string[], minzoom: number, maxzoom: number,
 *     scheme: 'xyz'|'tms', attribution?: string}>,
 *   layers: object[],
 *   background: {color: string, opacity: number}|null,
 *   skipped: Array<{id: string, reason: string}>,
 *   attribution: string[],
 *   tiles: Map<string, Promise<object>>,
 * }>}
 */
export async function loadVectorStyle(
  styleUrl,
  fetchImpl = globalThis.fetch,
  { signal } = {},
) {
  const style = await json(fetchImpl, styleUrl, signal);
  if (!style || typeof style !== 'object' || !Array.isArray(style.layers))
    throw new TypeError(`${styleUrl} is not a style document`);
  const sources = {};
  const attribution = [];
  for (const [name, source] of Object.entries(style.sources ?? {})) {
    if (source?.type !== 'vector') continue;
    let spec = source;
    let base = styleUrl;
    if (!Array.isArray(source.tiles) && typeof source.url === 'string') {
      base = resolve(source.url, styleUrl);
      spec = { ...(await json(fetchImpl, base, signal)), ...source };
    }
    if (!Array.isArray(spec.tiles) || spec.tiles.length === 0) continue;
    sources[name] = {
      tiles: spec.tiles.map((t) => resolve(t, base)),
      minzoom: spec.minzoom ?? 0,
      maxzoom: spec.maxzoom ?? 14,
      scheme: spec.scheme === 'tms' ? 'tms' : 'xyz',
      attribution: spec.attribution,
    };
    if (spec.attribution) attribution.push(spec.attribution);
  }
  const layers = [];
  const skipped = [];
  let background = null;
  for (const raw of style.layers) {
    const { layer, reason } = compileLayer(raw, sources);
    if (!layer) {
      skipped.push({ id: raw.id, reason });
      continue;
    }
    layers.push(layer);
    if (layer.type === 'background' && !background) {
      // As it paints: a value that cannot be evaluated, or is not a
      // colour or number, is the property's default.
      const at = { zoom: 0, properties: {}, type: 'Polygon' };
      background = {
        color: colorOf(layer, 'background-color', at),
        opacity: numberOf(layer, 'background-opacity', at),
      };
    }
  }
  return {
    url: styleUrl,
    style,
    sources,
    layers,
    background,
    skipped,
    attribution,
    // Decoded source tiles by URL, shared by every tile painted.
    tiles: new Map(),
  };
}
