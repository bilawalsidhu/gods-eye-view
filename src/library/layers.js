/**
 * Layer modules for Data Library entries. A dataset renders through the same
 * GeoJSON layer as Datacenters and Dams; tiles drape through the renderer's
 * globe port on whichever imagery host the active map stack offers, as
 * Recent Imagery does; view-bounded datasets and coverage outlines draw
 * through the draw port.
 */
import {
  createLocalGeoJsonLayer,
  fillOf,
  localDatasetError,
  localGeojsonParts,
  rhumbPositions,
  strokeOf,
} from '../data/localGeojsonCore.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findGlobe,
  findQuery,
} from '../render/rendererOf.js';
import { cssColor } from '../render/color.js';
import { markBaseTileset } from '../render/baseTilesets.js';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import {
  NATURAL_EARTH_CREDIT,
  registerDynamicCredit,
} from '../data/dataCredits.js';
import { loadCountryOutlines, outlineRings } from './outlines.js';
import { NO_IMAGERY_HOST, resolveImageryHost } from '../maps/imageryHost.js';
import { msg, t } from '../i18n/index.js';
import { libraryLayerId } from './manifest.js';
import { coverageExtent, featureExtent } from './extent.js';
import { RELIEF_CLASSES, metresPerPixel, terrariumToRelief } from './relief.js';

const DEFAULT_DATASET_COLOR = '#8ad4ff';
const TILE_ERROR_LIMIT = 24;
const TILES_UNAVAILABLE = msg('tiles unavailable');
/** Imagery coverage outlines: a thin bright line that reads on photos. */
const OUTLINE_COLOR = '#ffffff';
const OUTLINE_WIDTH_PX = 2.5;
const ZOOM_IN_HINT = msg('zoom in to load this layer');
const VIEW_DEBOUNCE_MS = 450;
// The query window's half-size: half the camera height each way, between
// about 330 m and 5.5 km.
const VIEW_HALF_PER_METRE = 0.5;
const VIEW_MIN_HALF_DEG = 0.003;
const VIEW_MAX_HALF_DEG = 0.05;

/**
 * The row's chips. Unlike other layers' row controls they stay visible while
 * the layer is off (layerPanel.js honours `whileOff`).
 * Both are icon actions that also work while the layer is off: Zoom to
 * layer (the controller switches the layer on first) and Remove.
 * @param {() => object|null} getExtent
 * @param {(() => void) | null} onZoom
 * @param {(() => void) | null} onRemove
 */
function libraryRowControls(getExtent, onZoom, onRemove, legend = []) {
  const chips = [];
  if (typeof onZoom === 'function')
    chips.push({
      id: 'zoom',
      icon: 'zoom_in_map',
      action: true,
      whileOff: true,
      label: t('Zoom to layer'),
      title: t('Zoom to layer · fly to where this layer has data'),
      onClick: onZoom,
    });
  if (typeof onRemove === 'function')
    chips.push({
      id: 'remove',
      icon: 'delete',
      action: true,
      whileOff: true,
      label: t('Remove from Data Layers'),
      title: t('Remove from Data Layers · add it again from the library'),
      onClick: onRemove,
    });
  return legend.length ? { chips, legend } : { chips };
}

/**
 * The row legend: for `display.colorBy` one swatch per value, labelled from
 * `colorBy.labels` (else the value itself) and counted when counts are
 * given; otherwise the manifest's static `display.legend` (a tile layer's
 * colour scale). Labels travel with the colours, so colour is never alone.
 */
export function colorByLegend(display, counts = null) {
  const colorBy = display?.colorBy;
  if (!colorBy)
    return (display?.legend || []).map(({ label, color }) => ({
      label,
      color,
    }));
  const labels = colorBy.labels || {};
  // Values sharing a label are one legend group (coal, gas and oil are
  // "Fossil"); the first value's colour stands for the group.
  const groups = new Map();
  for (const [value, color] of Object.entries(colorBy.colors)) {
    const label = labels[value] || value;
    const group = groups.get(label) || { label, color, count: 0 };
    group.count += counts?.get(value) || 0;
    groups.set(label, group);
  }
  const items = [...groups.values()];
  // Values the manifest does not colour draw in the entry's colour.
  let other = 0;
  for (const [value, count] of counts || [])
    if (!Object.hasOwn(colorBy.colors, value)) other += count;
  if (other)
    items.push({
      label: t('Other'),
      color: display.color || DEFAULT_DATASET_COLOR,
      count: other,
    });
  return counts ? items : items.map(({ label, color }) => ({ label, color }));
}

/** Count features by their colorBy key. */
function countColorKeys(features) {
  const counts = new Map();
  for (const feature of features) {
    const key = String(feature?.properties?.__gevColorKey ?? '');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
}

/**
 * The attribution credit an entry registers while it is in use.
 * @param {object} entry
 * @returns {{ key: string, html: string }}
 */
export function libraryCredit(entry) {
  const text = escapeHtml(entry.attribution.text);
  const linked = entry.attribution.url
    ? `<a href="${escapeHtml(entry.attribution.url)}" target="_blank" rel="noopener">${text}</a>`
    : text;
  return {
    key: `library:${entry.id}`,
    html: `${linked} · <a href="${escapeHtml(entry.licence.url)}" target="_blank" rel="noopener">${escapeHtml(entry.licence.name)}</a>`,
  };
}

/**
 * A dataset entry as a manager layer.
 * @param {object} entry Validated dataset entry.
 * @param {{ services: object, source: ReturnType<import('./source.js').createLibrarySource> }} options
 */
export function createLibraryDatasetLayer(
  entry,
  { services, source, onZoom = null, onRemove = null, inputFor },
) {
  let truncated = false;
  let loaded = 0;
  let extent = null;
  let rowListener = null;
  let legendCounts = null;
  // Live data: features older than the source's cacheSeconds are loaded
  // again, on the next enable and on the manager's refresh tick while the
  // layer is on. Their age counts from when they were requested, and a tick
  // allows a little slack, so a tick every cacheSeconds refreshes on every
  // tick rather than every other one.
  const maxAgeMs = entry.source.cacheSeconds * 1000;
  const tickSlackMs = Math.min(5000, maxAgeMs / 10);
  /** When the drawn data was requested; 0 until a load succeeds. */
  let loadedAt = 0;
  let refreshController = null;
  let on = false;
  const age = () => Date.now() - loadedAt;
  function take(result, requestedAt) {
    loadedAt = requestedAt;
    truncated = result.truncated;
    loaded = result.features.length;
    extent = featureExtent(result.features);
    if (colorBy) legendCounts = countColorKeys(result.features);
    rowListener?.();
  }
  const colorBy = entry.display.colorBy || null;
  const layer = createLocalGeoJsonLayer(
    {
      id: libraryLayerId(entry.id),
      url: null,
      name: entry.title,
      color: entry.display.color || DEFAULT_DATASET_COLOR,
      icon: entry.icon,
      source: entry.provider,
      labels: true,
      // The pointer input the layer's clicks come through (tests pass one).
      ...(inputFor ? { inputFor } : {}),
      featureColor: colorBy
        ? (properties) =>
            colorBy.colors[String(properties?.__gevColorKey ?? '')] || null
        : null,
      loadFeatures: async ({ signal }) => {
        const requestedAt = Date.now();
        const result = await source.loadDataset(entry, { signal });
        take(result, requestedAt);
        return result.features;
      },
    },
    services,
  );
  const enable = layer.enable;
  const disable = layer.disable;
  const destroy = layer.destroy;
  const getStats = layer.getStats;
  const cancelRefresh = () => {
    refreshController?.abort();
    refreshController = null;
  };
  return Object.assign(layer, {
    libraryEntryId: entry.id,
    refreshInterval: maxAgeMs,
    async enable(viewer, ...rest) {
      on = true;
      registerDynamicCredit(viewer, libraryCredit(entry));
      if (loadedAt && age() >= maxAgeMs) layer.dropCachedFeatures();
      return enable(viewer, ...rest);
    },
    /**
     * The manager's refresh tick: once the data is due, load it again and
     * swap it in where it is drawn, so the old features (and a selected
     * one) stay while the request runs and stay if it fails. Nothing to
     * refresh before a first load has succeeded: the tick that follows
     * enable() must not retry a failed load and fail the switch-on.
     */
    async update(viewer) {
      if (!on || !loadedAt || refreshController) return;
      if (age() < maxAgeMs - tickSlackMs) return;
      const current = new AbortController();
      refreshController = current;
      const requestedAt = Date.now();
      try {
        const result = await source.loadDataset(entry, {
          signal: current.signal,
        });
        if (!on || current.signal.aborted) return;
        await layer.replaceFeatures(viewer, result.features);
        if (!on || current.signal.aborted) return;
        take(result, requestedAt);
      } finally {
        if (refreshController === current) refreshController = null;
      }
    },
    disable(viewer, ...rest) {
      on = false;
      cancelRefresh();
      return disable(viewer, ...rest);
    },
    destroy(viewer, ...rest) {
      on = false;
      cancelRefresh();
      return destroy(viewer, ...rest);
    },
    getStats() {
      const stats = getStats();
      // A capped dataset reads PARTIAL ("incomplete snapshot"), never as
      // the whole upstream set.
      return truncated && !stats.error
        ? { ...stats, partial: true, acceptedRowCount: loaded }
        : stats;
    },
    /** Where the loaded features are, or null before the first load. */
    getExtent: () => extent,
    getRowControls: () =>
      libraryRowControls(
        () => extent,
        onZoom,
        onRemove,
        colorByLegend(entry.display, legendCounts),
      ),
    setRowControlsListener(listener) {
      rowListener = typeof listener === 'function' ? listener : null;
    },
  });
}

/** A canvas for one tile: an offscreen one where the browser has it. */
function tileCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function')
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Make every pixel within `threshold` (the largest channel difference, 0–1)
 * of `rgba` transparent, as a renderer's colour-to-alpha draws it.
 * @param {Uint8ClampedArray} pixels RGBA, changed in place.
 * @param {number[]} rgba Colour 0–1.
 * @param {number} threshold
 */
export function clearNoData(pixels, rgba, threshold) {
  const [r, g, b] = rgba.map((channel) => channel * 255);
  const limit = threshold * 255;
  for (let i = 0; i < pixels.length; i += 4) {
    const diff = Math.max(
      Math.abs(pixels[i] - r),
      Math.abs(pixels[i + 1] - g),
      Math.abs(pixels[i + 2] - b),
    );
    if (diff < limit) pixels[i + 3] = 0;
  }
  return pixels;
}

/**
 * The tile hook an entry needs, or null: a Terrarium elevation tile drawn as
 * shaded relief, and the provider's "no imagery here" fill (`noDataColor`)
 * made transparent. The globe port hands each tile upright and takes back
 * an upright bitmap.
 * @param {object} entry
 * @returns {((tile: {x: number, y: number, level: number}, image: ImageBitmap) => Promise<ImageBitmap>) | null}
 */
export function libraryTileTransform(entry) {
  const relief = entry.source.encoding === 'terrarium';
  const noData = entry.display.noDataColor
    ? cssColor(entry.display.noDataColor)
    : null;
  if (!relief && !noData) return null;
  return async (tile, image) => {
    const { width, height } = image;
    const canvas = tileCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    let pixels = context.getImageData(0, 0, width, height).data;
    if (relief)
      pixels = terrariumToRelief(
        pixels,
        width,
        height,
        metresPerPixel(tile.level, tile.y, width),
      );
    if (noData) clearNoData(pixels, noData, NO_DATA_THRESHOLD);
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
    return createImageBitmap(canvas);
  };
}

/** The relief legend: elevation classes in metres. */
const reliefLegend = () =>
  RELIEF_CLASSES.map(({ label, color }) => ({ label: t(label), color }));

/** colorToAlpha threshold (max channel distance, 0–1) for `noDataColor`. */
const NO_DATA_THRESHOLD = 0.02;

/** The most tiles an entry's coverage may need at its minimum zoom. */
const COARSE_TILE_BUDGET = 256;

function webMercatorTileSpan(bbox, zoom) {
  const n = 2 ** zoom;
  const clampLat = (lat) => Math.max(-85.0511, Math.min(85.0511, lat));
  const tileX = (lon) =>
    Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const tileY = (lat) => {
    const rad = (clampLat(lat) * Math.PI) / 180;
    const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
    return Math.min(n - 1, Math.max(0, Math.floor(y * n)));
  };
  const [west, south, east, north] = bbox;
  return (tileX(east) - tileX(west) + 1) * (tileY(south) - tileY(north) + 1);
}

/**
 * The globe level below which a tile entry is hidden, or undefined when it
 * draws at every scale. The default renderer fetches an imagery layer's
 * minimum level for every globe tile it covers, however far out the camera
 * is: an entry whose coverage needs more than COARSE_TILE_BUDGET tiles at
 * its minimum zoom (Norway's cadastre from z14 is about two million) would
 * allocate them all when zoomed out. Such an entry is shown only from the
 * globe level that matches its minimum zoom (a geographic level spans two
 * Web Mercator ones, so level z − 1): it names no minimum level and holds
 * back every tile below its minimum zoom (`libraryImagerySpec`).
 * @param {object} entry
 * @returns {number|undefined}
 */
export function minimumTerrainLevelFor(entry) {
  const minZoom = entry?.source?.minZoom ?? 0;
  if (minZoom <= 0) return undefined;
  const bbox = entry.coverage?.bbox ?? [-180, -85.0511, 180, 85.0511];
  return webMercatorTileSpan(bbox, minZoom) > COARSE_TILE_BUDGET
    ? minZoom - 1
    : undefined;
}

/**
 * Draw order of aerial photography among the globe port's imagery: above
 * every other drape (basemaps at 0, heat, weather up to 4, other library
 * tiles), whenever they were added.
 */
export const LIBRARY_AERIAL_Z = 10;

/**
 * The globe port imagery spec for a tiles entry.
 * @param {object} entry Validated tiles entry.
 * @param {string} url Tile URL template.
 * @param {import('../render/contract/globe').ImagerySpec['fetchTile']|null} [fetchTile]
 *   Fetches each tile in place of the renderer (`source.tileFetch`).
 * @returns {import('../render/contract/globe').ImagerySpec}
 */
export function libraryImagerySpec(entry, url, fetchTile = null) {
  const bbox = entry.source.bounded ? entry.coverage.bbox : null;
  const minZoom = entry.source.minZoom ?? 0;
  // A dense entry (`minimumTerrainLevelFor`) is hidden where the view is
  // coarser than its minimum zoom, so nothing is drawn or fetched until the
  // view is close enough; from there on it draws as any entry does.
  const dense = minimumTerrainLevelFor(entry) !== undefined;
  const tileTransform = libraryTileTransform(entry);
  return {
    kind: 'xyz',
    url,
    tiling: 'webMercator',
    tileSize: entry.source.tileSize ?? 256,
    minLevel: minZoom,
    ...(dense ? { hiddenBelowMinLevel: true } : {}),
    maxLevel: entry.source.maxZoom ?? 18,
    credit: { text: entry.provider },
    // A bounded entry requests tiles inside its coverage only.
    ...(bbox
      ? {
          rectangle: {
            west: bbox[0],
            south: bbox[1],
            east: bbox[2],
            north: bbox[3],
          },
        }
      : {}),
    ...(entry.display.aerial ? { zOrder: LIBRARY_AERIAL_Z } : {}),
    ...(tileTransform ? { tileTransform } : {}),
    ...(fetchTile ? { fetchTile } : {}),
  };
}

/**
 * A tiles entry as a manager layer. It drapes through the viewer's globe
 * port, on whichever surface the map stack draws (`resolveImageryHost`).
 * @param {object} entry Validated tiles entry.
 * @param {{ source: object, getTileset?: () => object|null, mapStackController?: object, requestRender?: (reason: string) => void, onZoom?: Function|null, onRemove?: Function|null, host?: typeof resolveImageryHost }} options
 */
export function createLibraryTileLayer(
  entry,
  {
    source,
    getTileset = () => null,
    mapStackController = null,
    requestRender = () => {},
    onZoom = null,
    onRemove = null,
    host: resolveHost = resolveImageryHost,
  },
) {
  const id = libraryLayerId(entry.id);
  const extent = coverageExtent(entry);
  const outlineMode = entry.display.outline || null;
  /** The coverage outline's set, and how many rings it draws. */
  let outline = null;
  let outlineCount = 0;
  let outlineEpoch = 0;
  let outlineBuilds = 0;

  function removeOutline() {
    outlineEpoch += 1;
    try {
      outline?.dispose();
    } catch {
      /* its scene is already gone */
    }
    outline = null;
    outlineCount = 0;
  }

  /**
   * Draw the covered countries' borders as lines on the ground, so the edge
   * of the imagery is plain on the map. A failed border fetch costs only the
   * outline, never the imagery.
   */
  async function drawOutline() {
    if (!outlineMode || !viewer) return;
    const epoch = ++outlineEpoch;
    try {
      const rings = outlineRings(
        outlineMode === 'bbox' ? [] : await loadCountryOutlines(),
        entry,
      );
      if (epoch !== outlineEpoch || !enabled || !rings.length) return;
      const color = cssColor(OUTLINE_COLOR);
      const set = drawOf(viewer).lines({
        id: `${id}:outline:${++outlineBuilds}`,
        pickable: false,
      });
      try {
        set.set(
          rings.map((ring, index) => ({
            id: String(index),
            positions: ring.map(([lon, lat]) => fromDegrees(lon, lat, 0)),
            widthPx: OUTLINE_WIDTH_PX,
            mode: 'draped',
            clampTo: 'both',
            style: { kind: 'solid', color },
            pickable: false,
          })),
        );
      } catch (error) {
        set.dispose();
        throw error;
      }
      outline = set;
      outlineCount = rings.length;
      if (outlineMode !== 'bbox')
        registerDynamicCredit(viewer, NATURAL_EARTH_CREDIT);
      requestRender(`library-tiles:${entry.id}`);
    } catch (error) {
      console.warn(`[Library] ${entry.id} outline unavailable:`, error);
    }
  }
  const baseLegend =
    entry.source.encoding === 'terrarium'
      ? reliefLegend()
      : colorByLegend(entry.display);
  const legend = outlineMode
    ? [...baseLegend, { label: t('Coverage outline'), color: OUTLINE_COLOR }]
    : baseLegend;
  let viewer = null;
  let enabled = false;
  /** The globe port's layer while draped. */
  let imagery = null;
  /** The renderer could not take this entry's tiles (no tile hooks). */
  let refused = false;
  let tileErrors = 0;
  let lastUpdate = null;
  let unsubscribeMap = null;
  let removeErrorListener = null;

  function detach() {
    removeErrorListener?.();
    removeErrorListener = null;
    imagery?.remove();
    imagery = null;
  }

  function attach() {
    detach();
    refused = false;
    const tileset = getTileset();
    const host = resolveHost({ viewer, tileset });
    const globe = findGlobe(viewer);
    if (!host.collection || !globe) return false;
    // The globe port drapes on a tileset marked as a base.
    if (host.kind === 'tileset') markBaseTileset(tileset);
    try {
      imagery = globe.imagery.add(
        libraryImagerySpec(
          entry,
          source.tileTemplate(entry),
          source.tileFetch?.(entry) ?? null,
        ),
      );
    } catch (error) {
      // A renderer without tile hooks cannot draw relief or clear the
      // no-data fill: no drape, not a wrong one.
      console.warn(`[Library] ${entry.id} tiles refused:`, error);
      refused = true;
      return false;
    }
    imagery.alpha = entry.display.opacity ?? 1;
    removeErrorListener = imagery.on('tileError', (error) => {
      // A 4xx is the provider saying "no imagery here" (outside its
      // coverage), not a failure.
      const status = error?.status;
      if (status >= 400 && status < 500) return;
      tileErrors += 1;
    });
    lastUpdate = Date.now();
    return true;
  }

  function followMap() {
    if (!enabled) return;
    attach();
    requestRender(`library-tiles:${entry.id}`);
  }

  return {
    id,
    name: entry.title,
    icon: entry.icon,
    source: entry.provider,
    libraryEntryId: entry.id,
    updateInterval: 0,
    statsRefreshInterval: 1000,
    async init(nextViewer) {
      viewer = nextViewer;
    },
    async update() {},
    async enable(nextViewer) {
      viewer = nextViewer || viewer;
      enabled = true;
      tileErrors = 0;
      registerDynamicCredit(viewer, libraryCredit(entry));
      attach();
      unsubscribeMap?.();
      const off = mapStackController?.subscribe?.(followMap);
      unsubscribeMap = typeof off === 'function' ? off : null;
      void drawOutline();
      requestRender(`library-tiles:${entry.id}`);
    },
    async disable() {
      enabled = false;
      unsubscribeMap?.();
      unsubscribeMap = null;
      detach();
      removeOutline();
      requestRender(`library-tiles:${entry.id}`);
    },
    async destroy() {
      enabled = false;
      unsubscribeMap?.();
      unsubscribeMap = null;
      detach();
      removeOutline();
      viewer = null;
    },
    getStats() {
      if (!enabled) return { count: 0, lastUpdate };
      if (refused) return { count: 0, lastUpdate, error: TILES_UNAVAILABLE };
      if (!imagery)
        return {
          count: 0,
          lastUpdate,
          status: 'idle',
          statusMessage: NO_IMAGERY_HOST,
        };
      return {
        count: 1,
        // A drape has no feature count; say what the row's ON means.
        countLabel: t('DRAPED'),
        lastUpdate,
        error: tileErrors >= TILE_ERROR_LIMIT ? TILES_UNAVAILABLE : null,
      };
    },
    /** The manifest's declared coverage (the world when global). */
    getExtent: () => extent,
    getRowControls: () =>
      libraryRowControls(() => extent, onZoom, onRemove, legend),
    /** QA/test view of where the drape lives. */
    getDiagnostics() {
      return {
        draped: Boolean(imagery),
        tileErrors,
        outlineRings: outlineCount,
      };
    },
  };
}

/**
 * A view-bounded dataset (`source.view`): a layer too large to load whole,
 * such as every US building footprint. Below `view.maxAltitudeM` it loads
 * what intersects the camera's box, after the camera settles, and replaces
 * the previous set only once the new one is ready; higher up it asks the
 * viewer to zoom in. It draws through the viewer's draw port: polygons
 * fill the ground (and Google 3D tiles) without an outline, lines drape,
 * and points are small dots on the ground.
 * @param {object} entry Validated dataset entry with `source.view`.
 * @param {{ source: object, onZoom?: Function|null, onRemove?: Function|null, requestRender?: (reason: string) => void, debounceMs?: number }} options
 */
export function createLibraryViewLayer(
  entry,
  {
    source,
    onZoom = null,
    onRemove = null,
    requestRender = () => {},
    debounceMs = VIEW_DEBOUNCE_MS,
  },
) {
  const id = libraryLayerId(entry.id);
  const { maxAltitudeM, sample } = entry.source.view;
  // Zoom lands on the sample area, low enough for the layer to load.
  const extent = {
    ...(sample
      ? { west: sample[0], south: sample[1], east: sample[2], north: sample[3] }
      : coverageExtent(entry)),
    maxAltitudeM,
  };
  const color = cssColor(entry.display.color || DEFAULT_DATASET_COLOR) ?? [
    1, 1, 1, 1,
  ];
  const colorBy = entry.display.colorBy || null;
  const colorByValue = new Map(
    Object.entries(colorBy?.colors || {})
      .map(([value, css]) => [value, cssColor(css)])
      .filter(([, rgba]) => rgba),
  );
  let legendCounts = null;
  /** A feature's colour: its colorBy value's, else the entry's. */
  function colorOf(properties) {
    if (!colorBy) return color;
    const key = properties?.__gevColorKey ?? properties?.[colorBy.field];
    return colorByValue.get(String(key ?? '')) || color;
  }
  const withAlpha = (rgba, alpha) => [rgba[0], rgba[1], rgba[2], alpha];
  let viewer = null;
  let enabled = false;
  /** The sets drawing the current view's features, or null. */
  let drawn = null;
  let builds = 0;
  let controller = null;
  let timer = null;
  let removeMoveEnd = null;
  let count = 0;
  let truncated = false;
  let loading = false;
  let error = null;
  let tooHigh = false;
  let lastUpdate = null;
  let loadedKey = null;

  const render = () => requestRender(`library-view:${entry.id}`);

  function abort() {
    controller?.abort();
    controller = null;
  }

  function disposeSets(sets) {
    for (const set of Object.values(sets || {})) {
      try {
        set.dispose();
      } catch {
        /* its scene is already gone */
      }
    }
  }

  function clear() {
    disposeSets(drawn);
    drawn = null;
    loadedKey = null;
    count = 0;
    truncated = false;
    legendCounts = null;
  }

  /** The sets for one view's features, hidden until swapped in. */
  function build(features) {
    const draw = drawOf(viewer);
    const prefix = `${id}:view:${++builds}`;
    const sets = {};
    try {
      sets.fills = draw.shapes({ id: `${prefix}:fills`, show: false });
      sets.lines = draw.lines({ id: `${prefix}:lines`, show: false });
      sets.dots = draw.points({ id: `${prefix}:dots`, show: false });
      const fills = [];
      const lines = [];
      const dots = [];
      for (const part of localGeojsonParts(features)) {
        const meta = { layerId: id, id: part.id };
        const style = part.feature.properties;
        const own = colorOf(style);
        // As the GeoJSON loader drew them: edges along rhumb lines, and a
        // feature's simplestyle fill and stroke over the entry's colour (a
        // colorBy fill over both).
        if (part.kind === 'polygon')
          fills.push({
            id: part.id,
            geometry: {
              kind: 'polygon',
              rings: part.coordinates.map(rhumbPositions),
            },
            fill: colorBy
              ? withAlpha(own, 0.45)
              : fillOf(style, withAlpha(color, 0.35)),
            height: 'clampGround',
            clampTo: 'both',
            meta,
          });
        else if (part.kind === 'line') {
          const stroke = strokeOf(style, color);
          lines.push({
            id: part.id,
            positions: rhumbPositions(part.coordinates).map(({ lon, lat }) =>
              fromDegrees(lon, lat, 0),
            ),
            widthPx: stroke.widthPx,
            mode: 'draped',
            clampTo: 'both',
            style: { kind: 'solid', color: stroke.color },
            meta,
          });
        }
        // Points draw as small dots, not pins: a view can hold thousands.
        else if (part.kind === 'point')
          dots.push({
            id: part.id,
            pos: { lon: part.coordinates[0], lat: part.coordinates[1] },
            height: 'clampGround',
            pixelSize: 6,
            color: own,
            outlineColor: [0, 0, 0, 0.55],
            outlineWidth: 1,
            meta,
          });
      }
      sets.fills.set(fills);
      sets.lines.set(lines);
      sets.dots.set(dots);
    } catch (caught) {
      disposeSets(sets);
      throw caught;
    }
    return sets;
  }

  /**
   * The box to query: a window around the point the camera looks at, sized
   * by camera height (an oblique view's visible area reaches the horizon,
   * far beyond what one page can fill), clipped to what is in view.
   */
  function viewBox(camera, pose) {
    const canvas = canvasOf(viewer);
    const target =
      (canvas &&
        findQuery(viewer)?.pickEllipsoid(
          canvas.clientWidth / 2,
          canvas.clientHeight / 2,
        )) ||
      pose.position;
    if (!target) return null;
    const { lon, lat } = toLonLatH(target);
    const halfLat = Math.min(
      VIEW_MAX_HALF_DEG,
      Math.max(
        VIEW_MIN_HALF_DEG,
        (pose.height * VIEW_HALF_PER_METRE) / 111_320,
      ),
    );
    const halfLon = halfLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    let box = [lon - halfLon, lat - halfLat, lon + halfLon, lat + halfLat];
    const visible = camera.viewRectangle?.();
    if (visible && visible.west < visible.east)
      box = [
        Math.max(box[0], visible.west),
        Math.max(box[1], visible.south),
        Math.min(box[2], visible.east),
        Math.min(box[3], visible.north),
      ];
    // A view across the antimeridian or off the globe is skipped.
    return box[0] < box[2] && box[1] < box[3] && box[0] >= -180 && box[2] <= 180
      ? box
      : null;
  }

  async function refresh() {
    timer = null;
    if (!enabled || !viewer) return;
    const camera = findCamera(viewer);
    const pose = camera?.pose();
    const height = pose?.height;
    if (!(Number.isFinite(height) && height <= maxAltitudeM)) {
      tooHigh = true;
      abort();
      loading = false;
      clear();
      render();
      return;
    }
    tooHigh = false;
    const box = viewBox(camera, pose);
    if (!box) return;
    const key = box.map((value) => value.toFixed(4)).join(',');
    // Back on the view already drawn: a request for the view in between is
    // obsolete and must not replace it.
    if (key === loadedKey && drawn) {
      // What is drawn is this view's, so an error from the view in between
      // no longer applies.
      if (controller || error) {
        abort();
        loading = false;
        error = null;
        render();
      }
      return;
    }
    abort();
    const current = new AbortController();
    controller = current;
    loading = true;
    error = null;
    try {
      const result = await source.loadDataset(entry, {
        signal: current.signal,
        bbox: box,
      });
      if (!enabled || current.signal.aborted) return;
      const sets = build(result.features);
      const previous = drawn;
      drawn = sets;
      for (const set of Object.values(sets)) set.show = true;
      disposeSets(previous);
      count = result.features.length;
      truncated = result.truncated;
      if (colorBy) legendCounts = countColorKeys(result.features);
      lastUpdate = Date.now();
      loadedKey = key;
    } catch (caught) {
      if (current.signal.aborted || caught?.name === 'AbortError') return;
      error = localDatasetError(caught);
    } finally {
      if (controller === current) {
        controller = null;
        loading = false;
      }
      render();
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), debounceMs);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
    abort();
    loading = false;
    removeMoveEnd?.();
    removeMoveEnd = null;
  }

  return {
    id,
    name: entry.title,
    icon: entry.icon,
    source: entry.provider,
    libraryEntryId: entry.id,
    updateInterval: 0,
    statsRefreshInterval: 1000,
    async init(nextViewer) {
      viewer = nextViewer;
    },
    async update() {},
    async enable(nextViewer) {
      viewer = nextViewer || viewer;
      enabled = true;
      error = null;
      registerDynamicCredit(viewer, libraryCredit(entry));
      removeMoveEnd?.();
      removeMoveEnd = findCamera(viewer)?.on('moveEnd', schedule) ?? null;
      await refresh();
    },
    async disable() {
      enabled = false;
      stop();
      clear();
      render();
    },
    async destroy() {
      enabled = false;
      stop();
      clear();
      viewer = null;
    },
    getStats() {
      if (!enabled) return { count: 0, lastUpdate };
      if (tooHigh)
        return {
          count: 0,
          lastUpdate,
          status: 'zoom-in',
          statusMessage: ZOOM_IN_HINT,
        };
      const stats = { count, lastUpdate, loading, error };
      // One page per view: a dense view reads PARTIAL, never complete.
      return truncated && !error
        ? { ...stats, partial: true, acceptedRowCount: count }
        : stats;
    },
    /** The sample area (or coverage) for Zoom to layer. */
    getExtent: () => extent,
    getRowControls: () =>
      libraryRowControls(
        () => extent,
        onZoom,
        onRemove,
        colorByLegend(entry.display, legendCounts),
      ),
    /** QA/test view of the current load. */
    getDiagnostics() {
      return { loadedKey, count, tooHigh, loading };
    },
  };
}
