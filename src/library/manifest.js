/**
 * Data Library manifest contract.
 *
 * A library entry is a pointer to a live upstream the provider hosts: a query
 * API, a provider-hosted static file or a tile endpoint. Nothing a manifest
 * describes is bundled in this repository, so every instance — hosted or
 * self-hosted — serves the same entries without hosting any data.
 *
 * Pure and portable: the server, the browser and the repo scripts all import
 * this module, so it loads no catalogs and touches no DOM. See
 * docs/DATA-LIBRARY.md for the authoring guide.
 */
import {
  LIBRARY_ID_PATTERN,
  LIBRARY_LAYER_PREFIX,
  libraryEntryIdOf,
  libraryLayerId,
} from '../data/libraryLayerIds.js';

/** The three entry kinds this build renders. */
export const LIBRARY_KINDS = Object.freeze(['dataset', 'tiles', 'pack']);

/** Vector formats a `dataset` entry may declare, normalized to GeoJSON. */
export const DATASET_FORMATS = Object.freeze([
  'geojson',
  'geojsonl',
  'csv',
  'json',
  'arcgis',
  'geoparquet',
]);

/** Raster formats a `tiles` entry may declare. */
export const TILE_FORMATS = Object.freeze(['xyz', 'bbox']);
/**
 * What a tile's pixels hold when they are not a picture: `terrarium` is
 * elevation as terrain-RGB, drawn as shaded relief by the browser.
 */
export const TILE_ENCODINGS = Object.freeze(['terrarium']);
/** A `bbox` tile template's placeholder (MapLibre's name for it). */
export const BBOX_TOKEN = '{bbox-epsg-3857}';
const MERCATOR_HALF_WORLD_M = 20037508.342789244;

/**
 * A tile's Web Mercator bounds as `west,south,east,north` metres.
 * @returns {string}
 */
export function tileBbox3857(z, x, y) {
  const size = (2 * MERCATOR_HALF_WORLD_M) / 2 ** z;
  const west = -MERCATOR_HALF_WORLD_M + x * size;
  const north = MERCATOR_HALF_WORLD_M - y * size;
  return [west, north - size, west + size, north]
    .map((value) => value.toFixed(3))
    .join(',');
}

/**
 * One tile's upstream URL from a tiles entry's template: `{z}/{x}/{y}` for
 * `xyz`, the tile's EPSG:3857 bounds for `bbox` (WMS GetMap, ArcGIS export).
 */
export function libraryTileUrl(template, z, x, y) {
  return template
    .replaceAll(BBOX_TOKEN, tileBbox3857(z, x, y))
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{reverseY}', String(2 ** z - 1 - y))
    .replaceAll('{y}', String(y));
}

/** How the browser reaches the upstream. */
export const FETCH_MODES = Object.freeze(['browser-direct', 'proxied']);

/** Lifecycle states; only maintainers and the health probe change them. */
export const LIBRARY_STATUSES = Object.freeze([
  'incubating',
  'community',
  'verified',
  'stale',
  'archived',
]);

/** Browse filter families, matching the Data Layers panel groups. */
export const LIBRARY_FAMILIES = Object.freeze([
  'movement',
  'cameras',
  'infrastructure',
  'events',
  'weather',
  'environment',
  'imagery',
  'demographics',
]);

/** Host layers a `pack` entry may extend, with the env switch grammar. */
export const PACK_HOSTS = Object.freeze(['cctv']);

export const DEFAULT_CACHE_SECONDS = 3600;
export const MIN_CACHE_SECONDS = 60;
export const MAX_CACHE_SECONDS = 86_400;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_FEATURES = 10_000;
export const MAX_MAX_FEATURES = 20_000;
export const DEFAULT_ARCGIS_PAGES = 5;
export const MAX_ARCGIS_PAGES = 10;
export const MAX_TILE_ZOOM = 22;
/** View-bounded datasets load only below this camera height range (m). */
export const MIN_VIEW_ALTITUDE_M = 300;
export const MAX_VIEW_ALTITUDE_M = 50_000;

const TOP_LEVEL_KEYS = new Set([
  'id',
  'kind',
  'family',
  'title',
  'provider',
  'description',
  'icon',
  'maintainer',
  'coverage',
  'source',
  'display',
  'pack',
  'licence',
  'attribution',
  'status',
  'regionsServed',
  'reviewed',
  'imagery',
]);
const SOURCE_KEYS = new Set([
  'format',
  'url',
  'fetch',
  'query',
  'columns',
  'records',
  'partitions',
  'view',
  'cacheSeconds',
  'maxBytes',
  'maxFeatures',
  'maxPages',
  'minZoom',
  'maxZoom',
  'bounded',
  'encoding',
  'tileSize',
  'key',
]);
const DISPLAY_KEYS = new Set([
  'color',
  'label',
  'fields',
  'rank',
  'colorBy',
  'legend',
  'outline',
  'opacity',
  'aerial',
  'noDataColor',
]);
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KEY_PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

const isObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/**
 * Parse an upstream URL a manifest may name: https, no credentials, no
 * fragment, a real hostname. Tile templates keep their `{z}/{x}/{y}` tokens.
 * @param {unknown} value
 * @returns {URL|null}
 */
export function libraryUpstreamUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(
      value
        .replaceAll(BBOX_TOKEN, '0,0,0,0')
        .replace(/\{([xyz]|reverseY)\}/g, '0'),
    );
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.hash) return null;
  if (!url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname)) return null;
  return url;
}

/** A licence or attribution link: https, no credentials; fragments allowed. */
function httpsDocumentUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validBbox(bbox) {
  return (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every(Number.isFinite) &&
    bbox[0] >= -180 &&
    bbox[2] <= 180 &&
    bbox[1] >= -90 &&
    bbox[3] <= 90 &&
    bbox[0] < bbox[2] &&
    bbox[1] < bbox[3]
  );
}

function checkCoverage(coverage, errors) {
  if (!isObject(coverage)) {
    errors.push('coverage must be an object');
    return;
  }
  const { global, countries, bbox } = coverage;
  if (global !== undefined && typeof global !== 'boolean')
    errors.push('coverage.global must be a boolean');
  if (countries !== undefined) {
    if (
      !Array.isArray(countries) ||
      !countries.length ||
      countries.some((code) => !COUNTRY_PATTERN.test(code))
    )
      errors.push('coverage.countries must list ISO 3166-1 alpha-2 codes');
  }
  if (bbox !== undefined) {
    if (!validBbox(bbox))
      errors.push('coverage.bbox must be [west, south, east, north] degrees');
  }
  if (global !== true && countries === undefined && bbox === undefined)
    errors.push('coverage needs global, countries or bbox');
}

function boundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function checkSource(entry, errors) {
  const { source, kind } = entry;
  if (!isObject(source)) {
    errors.push('source must be an object');
    return;
  }
  for (const key of Object.keys(source))
    if (!SOURCE_KEYS.has(key))
      errors.push(`source.${key} is not a known field`);
  const formats =
    kind === 'dataset'
      ? DATASET_FORMATS
      : kind === 'tiles'
        ? TILE_FORMATS
        : ['host'];
  if (!formats.includes(source.format))
    errors.push(`source.format must be one of ${formats.join(', ')}`);
  if (!libraryUpstreamUrl(source.url))
    errors.push('source.url must be an https URL without credentials');
  if (kind === 'pack') return;
  if (!FETCH_MODES.includes(source.fetch))
    errors.push(`source.fetch must be one of ${FETCH_MODES.join(', ')}`);
  if (kind === 'tiles' && typeof source.url === 'string') {
    if (source.format === 'bbox') {
      if (!source.url.includes(BBOX_TOKEN))
        errors.push(`source.url must contain ${BBOX_TOKEN}`);
      if (/\{[xyz]\}/.test(source.url))
        errors.push('a bbox template takes no {z}/{x}/{y}');
    } else {
      for (const token of ['{z}', '{x}'])
        if (!source.url.includes(token))
          errors.push(`source.url must contain ${token}`);
      // TMS servers count rows from the south: Cesium's {reverseY}.
      if (!source.url.includes('{y}') && !source.url.includes('{reverseY}'))
        errors.push('source.url must contain {y} or {reverseY}');
    }
  }
  if (
    source.cacheSeconds !== undefined &&
    !boundedInteger(source.cacheSeconds, MIN_CACHE_SECONDS, MAX_CACHE_SECONDS)
  )
    errors.push(
      `source.cacheSeconds must be ${MIN_CACHE_SECONDS}–${MAX_CACHE_SECONDS}`,
    );
  if (
    source.maxBytes !== undefined &&
    !boundedInteger(source.maxBytes, 1024, MAX_MAX_BYTES)
  )
    errors.push(`source.maxBytes must be at most ${MAX_MAX_BYTES}`);
  if (
    source.maxFeatures !== undefined &&
    !boundedInteger(source.maxFeatures, 1, MAX_MAX_FEATURES)
  )
    errors.push(`source.maxFeatures must be at most ${MAX_MAX_FEATURES}`);
  if (source.maxPages !== undefined) {
    if (source.format !== 'arcgis')
      errors.push('source.maxPages applies to arcgis only');
    else if (!boundedInteger(source.maxPages, 1, MAX_ARCGIS_PAGES))
      errors.push(`source.maxPages must be 1–${MAX_ARCGIS_PAGES}`);
  }
  if (source.query !== undefined) {
    const valid =
      isObject(source.query) &&
      Object.entries(source.query).every(
        ([name, value]) =>
          FIELD_PATTERN.test(name) &&
          typeof value === 'string' &&
          value.length <= 512,
      );
    if (!valid) errors.push('source.query must map field names to strings');
  }
  if (source.view !== undefined) {
    const { view } = source;
    const valid =
      isObject(view) &&
      Object.keys(view).every((key) =>
        ['maxAltitudeM', 'sample'].includes(key),
      ) &&
      boundedInteger(
        view.maxAltitudeM,
        MIN_VIEW_ALTITUDE_M,
        MAX_VIEW_ALTITUDE_M,
      ) &&
      (view.sample === undefined || validBbox(view.sample));
    if (!valid)
      errors.push(
        `source.view needs maxAltitudeM (${MIN_VIEW_ALTITUDE_M}–${MAX_VIEW_ALTITUDE_M}) and an optional sample bbox`,
      );
    // View-bounded loading queries the camera's box; this build does that
    // for ArcGIS layers and partitioned GeoParquet, fetched by the browser.
    if (
      !['arcgis', 'geoparquet'].includes(source.format) ||
      source.fetch !== 'browser-direct'
    )
      errors.push(
        'source.view needs format arcgis or geoparquet and fetch browser-direct',
      );
  }
  if (source.partitions !== undefined) {
    const { partitions } = source;
    const host = libraryUpstreamUrl(source.url)?.host;
    const listUrl = libraryUpstreamUrl(partitions?.listUrl);
    const keyBase = libraryUpstreamUrl(partitions?.keyBase);
    const valid =
      source.format === 'geoparquet' &&
      isObject(partitions) &&
      Object.keys(partitions).every((key) =>
        ['listUrl', 'keyBase'].includes(key),
      ) &&
      listUrl &&
      keyBase &&
      listUrl.host === host &&
      keyBase.host === host;
    if (!valid)
      errors.push(
        'source.partitions needs an S3 listUrl and keyBase on the source host (geoparquet only)',
      );
    // A partitioned set is far too large to load whole.
    if (source.view === undefined)
      errors.push('a partitioned source must be view-bounded (source.view)');
  }
  if (source.records !== undefined) {
    if (source.format !== 'json')
      errors.push('source.records applies to json only');
    else if (!FIELD_PATTERN.test(source.records))
      errors.push('source.records must be a property path');
  }
  if (source.columns !== undefined) {
    const valid =
      ['csv', 'json'].includes(source.format) &&
      isObject(source.columns) &&
      FIELD_PATTERN.test(source.columns.lat ?? '') &&
      FIELD_PATTERN.test(source.columns.lon ?? '');
    if (!valid)
      errors.push(
        'source.columns needs lat and lon column names (csv or json only)',
      );
  }
  if (source.bounded !== undefined) {
    // Request tiles only inside coverage.bbox (a provider that answers
    // outside its coverage with errors, or asks for fair use).
    if (kind !== 'tiles' || typeof source.bounded !== 'boolean')
      errors.push('source.bounded is a boolean for tiles');
    else if (source.bounded && !entry.coverage?.bbox)
      errors.push('source.bounded needs coverage.bbox');
  }
  if (source.encoding !== undefined) {
    if (kind !== 'tiles' || !TILE_ENCODINGS.includes(source.encoding))
      errors.push(
        `source.encoding is for tiles: one of ${TILE_ENCODINGS.join(', ')}`,
      );
    else if (source.format !== 'xyz')
      errors.push('an encoded tiles source must be xyz');
  }
  if (
    source.tileSize !== undefined &&
    (kind !== 'tiles' || ![256, 512].includes(source.tileSize))
  )
    errors.push('source.tileSize is 256 or 512, for tiles');
  for (const zoom of ['minZoom', 'maxZoom']) {
    if (source[zoom] === undefined) continue;
    if (kind !== 'tiles') errors.push(`source.${zoom} applies to tiles only`);
    else if (!boundedInteger(source[zoom], 0, MAX_TILE_ZOOM))
      errors.push(`source.${zoom} must be 0–${MAX_TILE_ZOOM}`);
  }
  if (
    Number.isInteger(source.minZoom) &&
    Number.isInteger(source.maxZoom) &&
    source.minZoom > source.maxZoom
  )
    errors.push('source.minZoom must not exceed source.maxZoom');
  if (source.key !== undefined && source.key !== null) {
    const { key } = source;
    const valid =
      isObject(key) &&
      LIBRARY_ID_PATTERN.test(key.id ?? '') &&
      ['query', 'header'].includes(key.in) &&
      KEY_PARAM_PATTERN.test(key.name ?? '');
    if (!valid) errors.push('source.key needs id, in (query|header) and name');
    // A key never reaches the browser: keyed entries go through the server.
    if (source.fetch !== 'proxied')
      errors.push('a keyed source must use fetch: proxied');
  }
}

function checkDisplay(entry, errors) {
  const { display, kind } = entry;
  if (display === undefined) return;
  if (!isObject(display)) {
    errors.push('display must be an object');
    return;
  }
  for (const key of Object.keys(display))
    if (!DISPLAY_KEYS.has(key))
      errors.push(`display.${key} is not a known field`);
  if (display.color !== undefined && !COLOR_PATTERN.test(display.color))
    errors.push('display.color must be #rrggbb');
  if (display.label !== undefined && !FIELD_PATTERN.test(display.label))
    errors.push('display.label must be a property name');
  if (
    display.fields !== undefined &&
    (!Array.isArray(display.fields) ||
      display.fields.length > 4 ||
      display.fields.some((field) => !FIELD_PATTERN.test(field)))
  )
    errors.push('display.fields must list up to four property names');
  if (
    display.rank !== undefined &&
    !(
      isObject(display.rank) &&
      FIELD_PATTERN.test(display.rank.field ?? '') &&
      ['desc', 'asc'].includes(display.rank.order ?? 'desc') &&
      Object.keys(display.rank).every((key) => ['field', 'order'].includes(key))
    )
  )
    errors.push('display.rank needs a property field and order (desc|asc)');
  if (display.colorBy !== undefined) {
    const { colorBy } = display;
    const colors = isObject(colorBy)
      ? Object.entries(colorBy.colors || {})
      : [];
    const valid =
      isObject(colorBy) &&
      Object.keys(colorBy).every((key) =>
        ['field', 'colors', 'labels'].includes(key),
      ) &&
      (colorBy.labels === undefined ||
        (isObject(colorBy.labels) &&
          Object.entries(colorBy.labels).every(
            ([value, label]) =>
              Object.hasOwn(colorBy.colors || {}, value) && isText(label, 40),
          ))) &&
      FIELD_PATTERN.test(colorBy.field ?? '') &&
      colors.length > 0 &&
      colors.length <= 32 &&
      colors.every(
        ([value, color]) =>
          value.length > 0 && value.length <= 24 && COLOR_PATTERN.test(color),
      );
    if (!valid)
      errors.push(
        'display.colorBy needs a field and up to 32 value → #rrggbb colours',
      );
    // A legend groups values by label; it must stay readable.
    const groups = new Set(
      colors.map(([value]) => colorBy.labels?.[value] ?? value),
    );
    if (groups.size > 12)
      errors.push('display.colorBy can show at most 12 legend groups');
  }
  if (display.legend !== undefined) {
    const valid =
      Array.isArray(display.legend) &&
      display.legend.length > 0 &&
      display.legend.length <= 16 &&
      display.legend.every(
        (item) =>
          isObject(item) &&
          Object.keys(item).every((key) => ['label', 'color'].includes(key)) &&
          isText(item.label, 40) &&
          COLOR_PATTERN.test(item.color ?? ''),
      );
    if (!valid)
      errors.push('display.legend needs 1–16 { label, color: #rrggbb } items');
    if (display.colorBy)
      errors.push(
        'display.legend and display.colorBy: the colorBy legend is built from colorBy',
      );
  }
  if (display.outline !== undefined) {
    // Outline the covered countries' borders (imagery edges): `countries`
    // draws every part, `coverage` only the parts inside coverage.bbox.
    // `bbox` draws coverage.bbox itself: a state or city inside a country.
    if (!['coverage', 'countries', 'bbox'].includes(display.outline))
      errors.push('display.outline must be coverage, countries or bbox');
    if (kind !== 'tiles') errors.push('display.outline applies to tiles only');
    if (display.outline !== 'bbox' && !entry.coverage?.countries?.length)
      errors.push('display.outline needs coverage.countries');
    if (display.outline !== 'countries' && !entry.coverage?.bbox)
      errors.push(`display.outline: ${display.outline} needs coverage.bbox`);
  }
  if (display.aerial !== undefined) {
    // Aerial photography stays above every other imagery drape.
    if (kind !== 'tiles' || typeof display.aerial !== 'boolean')
      errors.push('display.aerial is a boolean for tiles');
  }
  if (display.noDataColor !== undefined) {
    // The fill a provider paints where it has no imagery (PDOK's white
    // outside the Netherlands); drawn transparent so it never hides the globe.
    if (kind !== 'tiles')
      errors.push('display.noDataColor applies to tiles only');
    else if (!COLOR_PATTERN.test(String(display.noDataColor)))
      errors.push('display.noDataColor must be #rrggbb');
  }
  if (
    display.opacity !== undefined &&
    !(
      Number.isFinite(display.opacity) &&
      display.opacity > 0 &&
      display.opacity <= 1
    )
  )
    errors.push('display.opacity must be in (0, 1]');
  if (
    kind === 'tiles' &&
    (display.label || display.fields || display.rank || display.colorBy)
  )
    errors.push(
      'display.label, fields, rank and colorBy apply to datasets only',
    );
}

/** What an imagery entry shows: the registry's product types. */
export const IMAGERY_TYPES = Object.freeze([
  'ortho',
  'satellite-mosaic',
  'oblique',
  'historic',
]);
const IMAGERY_KEYS = new Set([
  'type',
  'resolution',
  'resolutionM',
  'trueOrtho',
  'vintage',
  'updateCycle',
  'orthoQuality',
  'registry',
]);

/**
 * `imagery`: what a photo layer is, for viewers choosing between them —
 * product type, ground resolution as published and in metres, whether it is
 * a true orthophoto, the years flown and how often it is refreshed.
 */
function checkImagery(raw, errors) {
  const { imagery } = raw;
  if (raw.kind !== 'tiles' || !isObject(imagery)) {
    errors.push('imagery applies to tiles only and is an object');
    return;
  }
  for (const key of Object.keys(imagery))
    if (!IMAGERY_KEYS.has(key))
      errors.push(`imagery.${key} is not a known field`);
  if (!IMAGERY_TYPES.includes(imagery.type))
    errors.push(`imagery.type must be one of ${IMAGERY_TYPES.join(', ')}`);
  if (!isText(imagery.resolution, 64))
    errors.push(
      'imagery.resolution is the published ground resolution (≤ 64 chars)',
    );
  if (
    !Number.isFinite(imagery.resolutionM) ||
    imagery.resolutionM <= 0 ||
    imagery.resolutionM > 10_000
  )
    errors.push('imagery.resolutionM is the finest resolution in metres');
  if (typeof imagery.trueOrtho !== 'boolean')
    errors.push('imagery.trueOrtho is a boolean');
  for (const [key, max] of [
    ['vintage', 32],
    ['updateCycle', 80],
    ['orthoQuality', 120],
  ])
    if (imagery[key] !== undefined && !isText(imagery[key], max))
      errors.push(`imagery.${key} must be text (≤ ${max} chars)`);
  if (imagery.registry !== undefined && !httpsDocumentUrl(imagery.registry))
    errors.push('imagery.registry must be an https link');
}

/**
 * Validate one manifest. Strict: unknown fields are errors, so a typo cannot
 * silently drop a licence or a cap.
 * @param {unknown} raw Parsed manifest JSON.
 * @returns {{ ok: boolean, errors: string[], entry: object|null }}
 */
export function validateLibraryManifest(raw) {
  const errors = [];
  if (!isObject(raw))
    return { ok: false, errors: ['manifest must be an object'], entry: null };
  for (const key of Object.keys(raw))
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`${key} is not a known field`);
  if (!LIBRARY_ID_PATTERN.test(raw.id ?? ''))
    errors.push('id must be 3–48 lowercase letters, digits or dashes');
  if (raw.kind === 'provider')
    errors.push('provider entries are not supported by this build yet');
  else if (!LIBRARY_KINDS.includes(raw.kind))
    errors.push(`kind must be one of ${LIBRARY_KINDS.join(', ')}`);
  if (!LIBRARY_FAMILIES.includes(raw.family))
    errors.push(`family must be one of ${LIBRARY_FAMILIES.join(', ')}`);
  if (!isText(raw.title, 60)) errors.push('title is required (≤ 60 chars)');
  if (!isText(raw.provider, 32))
    errors.push('provider is required: a short source name (≤ 32 chars)');
  if (!isText(raw.description, 240))
    errors.push('description is required (≤ 240 chars)');
  if (raw.icon !== undefined && !isText(raw.icon, 4))
    errors.push('icon must be a short glyph');
  if (!isText(raw.maintainer, 80)) errors.push('maintainer is required');
  if (!LIBRARY_STATUSES.includes(raw.status))
    errors.push(`status must be one of ${LIBRARY_STATUSES.join(', ')}`);
  if (raw.reviewed !== undefined && !DATE_PATTERN.test(raw.reviewed))
    errors.push('reviewed must be YYYY-MM-DD');
  checkCoverage(raw.coverage, errors);
  if (LIBRARY_KINDS.includes(raw.kind)) checkSource(raw, errors);
  checkDisplay(raw, errors);
  if (raw.imagery !== undefined) checkImagery(raw, errors);
  if (raw.kind === 'pack') {
    const pack = raw.pack;
    if (
      !isObject(pack) ||
      !PACK_HOSTS.includes(pack.host) ||
      !ENV_PATTERN.test(pack.env ?? '')
    )
      errors.push(
        `pack needs host (${PACK_HOSTS.join(', ')}) and its env switch`,
      );
  } else if (raw.pack !== undefined) errors.push('pack applies to packs only');
  const { licence, attribution } = raw;
  if (
    !isObject(licence) ||
    !isText(licence.name, 160) ||
    !httpsDocumentUrl(licence.url) ||
    (licence.operatorOptIn !== undefined &&
      typeof licence.operatorOptIn !== 'boolean')
  )
    errors.push('licence needs name, an https url and optional operatorOptIn');
  if (raw.kind === 'pack' && licence?.operatorOptIn !== true)
    errors.push('a pack is switched by its host: licence.operatorOptIn: true');
  if (
    !isObject(attribution) ||
    !isText(attribution.text, 200) ||
    (attribution.url !== undefined && !httpsDocumentUrl(attribution.url))
  )
    errors.push('attribution needs text and an optional https url');
  if (raw.regionsServed !== undefined && raw.regionsServed !== null) {
    if (
      !Array.isArray(raw.regionsServed) ||
      !raw.regionsServed.length ||
      raw.regionsServed.some((code) => !COUNTRY_PATTERN.test(code))
    )
      errors.push('regionsServed must list ISO 3166-1 alpha-2 codes or null');
  }
  if (errors.length) return { ok: false, errors, entry: null };
  return { ok: true, errors: [], entry: freezeEntry(raw) };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Fill defaults so every consumer reads the same resolved caps. */
function freezeEntry(raw) {
  const entry = structuredClone(raw);
  if (entry.kind !== 'pack') {
    entry.source.cacheSeconds ??= DEFAULT_CACHE_SECONDS;
    if (entry.kind === 'dataset') {
      entry.source.maxBytes ??= DEFAULT_MAX_BYTES;
      entry.source.maxFeatures ??= DEFAULT_MAX_FEATURES;
      if (entry.source.format === 'arcgis')
        entry.source.maxPages ??= DEFAULT_ARCGIS_PAGES;
    }
    entry.source.key ??= null;
  }
  entry.display ??= {};
  entry.licence.operatorOptIn ??= false;
  entry.regionsServed ??= null;
  entry.icon ??= entry.kind === 'tiles' ? '▦' : '◆';
  return deepFreeze(entry);
}

/**
 * Validate a whole catalog: every entry valid, ids unique.
 * @param {unknown[]} manifests
 * @returns {{ ok: boolean, errors: string[], entries: object[] }}
 */
export function validateLibraryCatalog(manifests) {
  const errors = [];
  const entries = [];
  const ids = new Set();
  for (const [index, raw] of (manifests || []).entries()) {
    const label = raw?.id || `#${index}`;
    const result = validateLibraryManifest(raw);
    for (const error of result.errors) errors.push(`${label}: ${error}`);
    if (!result.ok) continue;
    if (ids.has(result.entry.id)) {
      errors.push(`${label}: duplicate id`);
      continue;
    }
    ids.add(result.entry.id);
    entries.push(result.entry);
  }
  return { ok: errors.length === 0, errors, entries };
}

// The layer namespace belongs to the layer lifecycle; the library reads it.
export {
  LIBRARY_ID_PATTERN,
  LIBRARY_LAYER_PREFIX,
  libraryEntryIdOf,
  libraryLayerId,
};

/**
 * Whether the operator switched an opt-in entry on. `GEV_LIBRARY_ENABLE`
 * lists opt-in ids; `GEV_LIBRARY_DISABLE` removes any entry outright.
 * @param {string|undefined} value Comma-separated ids.
 * @returns {Set<string>}
 */
export function parseLibraryIdList(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => LIBRARY_ID_PATTERN.test(id)),
  );
}
