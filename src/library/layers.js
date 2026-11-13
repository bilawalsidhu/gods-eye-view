/**
 * Layer modules for Data Library entries. A dataset renders through the same
 * GeoJSON layer as Datacenters and Dams; tiles drape on whichever imagery
 * host the active map stack offers, as Recent Imagery does.
 */
import * as Cesium from 'cesium';
import {
  createLocalGeoJsonLayer,
  localDatasetError,
} from '../data/localGeojsonCore.js';
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
  {
    services,
    source,
    onZoom = null,
    onRemove = null,
    screenSpaceEventHandlerFactory,
  },
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
      ...(screenSpaceEventHandlerFactory
        ? { screenSpaceEventHandlerFactory }
        : {}),
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

/**
 * Draw one Terrarium tile as shaded relief on a canvas. Cesium loads imagery
 * bitmaps already flipped for WebGL and flips a canvas on upload, so a bitmap
 * is drawn back north-up first and the canvas goes out north-up.
 */
function renderReliefTile(image, level, y) {
  const { width, height } = image;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    context.translate(0, height);
    context.scale(1, -1);
  }
  context.drawImage(image, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  const relief = terrariumToRelief(
    pixels,
    width,
    height,
    metresPerPixel(level, y, width),
  );
  context.putImageData(new ImageData(relief, width, height), 0, 0);
  image.close?.();
  return canvas;
}

/** Wrap a provider so each elevation tile it loads becomes shaded relief. */
function asReliefProvider(provider) {
  const load = provider.requestImage.bind(provider);
  provider.requestImage = (x, y, level, request) => {
    const pending = load(x, y, level, request);
    // Undefined means throttled: Cesium asks again later.
    return pending?.then((image) => renderReliefTile(image, level, y));
  };
  return provider;
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
 * draws at every scale. Cesium fetches an imagery layer's minimum level for
 * every globe tile it covers, however far out the camera is: an entry whose
 * coverage needs more than COARSE_TILE_BUDGET tiles at its minimum zoom
 * (Norway's cadastre from z14 is about two million) would allocate them all
 * when zoomed out. Such an entry is shown only from the globe level that
 * matches its minimum zoom (a geographic level spans two Web Mercator ones,
 * so level z − 1).
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
 * A tiles entry as a manager layer.
 * @param {object} entry Validated tiles entry.
 * @param {{ source: object, getTileset?: () => object|null, mapStackController?: object, cesium?: object, requestRender?: (reason: string) => void }} options
 */
export function createLibraryTileLayer(
  entry,
  {
    source,
    getTileset = () => null,
    mapStackController = null,
    cesium = Cesium,
    requestRender = () => {},
    onZoom = null,
    onRemove = null,
  },
) {
  const id = libraryLayerId(entry.id);
  const extent = coverageExtent(entry);
  const outlineMode = entry.display.outline || null;
  let outline = null;
  let outlineEpoch = 0;

  function removeOutline() {
    outlineEpoch += 1;
    if (outline && viewer?.dataSources)
      viewer.dataSources.remove(outline, true);
    outline = null;
  }

  /**
   * Draw the covered countries' borders as ground-clamped lines, so the edge
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
      const source = new cesium.CustomDataSource(`${id}:outline`);
      for (const ring of rings)
        source.entities.add({
          polyline: {
            positions: cesium.Cartesian3.fromDegreesArray(ring.flat()),
            clampToGround: true,
            width: OUTLINE_WIDTH_PX,
            material: cesium.Color.fromCssColorString(OUTLINE_COLOR),
          },
        });
      await viewer.dataSources.add(source);
      if (epoch !== outlineEpoch || !enabled) {
        viewer.dataSources.remove(source, true);
        return;
      }
      outline = source;
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
  let imagery = null;
  let collection = null;
  let tileErrors = 0;
  let lastUpdate = null;
  let unsubscribeMap = null;
  let removeErrorListener = null;
  let stopKeepingOnTop = null;

  /**
   * Aerial photography sits above every other drape (basemaps, weather,
   * other library tiles): raise it now and whenever a layer is added above.
   */
  function keepOnTop(target, layer) {
    const raise = () => {
      if (target.isDestroyed?.() || !target.contains?.(layer)) return;
      if (target.indexOf(layer) === target.length - 1) return;
      target.raiseToTop(layer);
      requestRender(`library-tiles:${entry.id}`);
    };
    raise();
    const off = target.layerAdded?.addEventListener?.(raise);
    stopKeepingOnTop = typeof off === 'function' ? off : null;
  }

  function detach() {
    removeErrorListener?.();
    removeErrorListener = null;
    stopKeepingOnTop?.();
    stopKeepingOnTop = null;
    if (imagery && collection && !collection.isDestroyed?.())
      collection.remove(imagery, true);
    imagery = null;
    collection = null;
  }

  function attach() {
    detach();
    const host = resolveImageryHost({ viewer, tileset: getTileset() });
    if (!host.collection) return false;
    const bbox = entry.source.bounded ? entry.coverage.bbox : null;
    const tileSize = entry.source.tileSize ?? 256;
    const template = new cesium.UrlTemplateImageryProvider({
      url: source.tileTemplate(entry),
      tileWidth: tileSize,
      tileHeight: tileSize,
      minimumLevel: entry.source.minZoom ?? 0,
      maximumLevel: entry.source.maxZoom ?? 18,
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      credit: entry.provider,
      hasAlphaChannel: true,
      // A bounded entry requests tiles inside its coverage only.
      ...(bbox && cesium.Rectangle
        ? { rectangle: cesium.Rectangle.fromDegrees(...bbox) }
        : {}),
    });
    const provider =
      entry.source.encoding === 'terrarium'
        ? asReliefProvider(template)
        : template;
    const onError = (event) => {
      // A 4xx is the provider saying "no imagery here" (outside its
      // coverage), not a failure: do not retry it or count it.
      const status = event?.error?.statusCode;
      if (status >= 400 && status < 500) {
        if (event) event.retry = false;
        return;
      }
      tileErrors += 1;
    };
    provider.errorEvent?.addEventListener?.(onError);
    removeErrorListener = () =>
      provider.errorEvent?.removeEventListener?.(onError);
    const minimumTerrainLevel = minimumTerrainLevelFor(entry);
    imagery =
      minimumTerrainLevel !== undefined && cesium.ImageryLayer
        ? new cesium.ImageryLayer(provider, { minimumTerrainLevel })
        : null;
    if (imagery) host.collection.add(imagery);
    else imagery = host.collection.addImageryProvider(provider);
    imagery.alpha = entry.display.opacity ?? 1;
    if (entry.display.noDataColor && cesium.Color) {
      // The provider's "no imagery here" fill, drawn transparent (JPEG
      // noise along the edge of the fill sits just inside the threshold).
      imagery.colorToAlpha = cesium.Color.fromCssColorString(
        entry.display.noDataColor,
      );
      imagery.colorToAlphaThreshold = NO_DATA_THRESHOLD;
    }
    collection = host.collection;
    if (entry.display.aerial) keepOnTop(collection, imagery);
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
        outlineRings: outline?.entities.values.length ?? 0,
      };
    },
  };
}

/**
 * A view-bounded dataset (`source.view`): a layer too large to load whole,
 * such as every US building footprint. Below `view.maxAltitudeM` it loads
 * what intersects the camera's box, after the camera settles, and replaces
 * the previous set only once the new one is ready; higher up it asks the
 * viewer to zoom in. Polygons are clamped to the ground (and to Google 3D
 * tiles), as an outline on the surface.
 * @param {object} entry Validated dataset entry with `source.view`.
 * @param {{ source: object, onZoom?: Function|null, onRemove?: Function|null, cesium?: object, requestRender?: (reason: string) => void, debounceMs?: number }} options
 */
export function createLibraryViewLayer(
  entry,
  {
    source,
    onZoom = null,
    onRemove = null,
    cesium = Cesium,
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
  const color = cesium.Color.fromCssColorString(
    entry.display.color || DEFAULT_DATASET_COLOR,
  );
  const colorBy = entry.display.colorBy || null;
  const colorByValue = new Map(
    Object.entries(colorBy?.colors || {}).map(([value, css]) => [
      value,
      cesium.Color.fromCssColorString(css),
    ]),
  );
  let legendCounts = null;
  /** A feature's colour: its colorBy value's, else the entry's. */
  function colorOf(entity) {
    if (!colorBy) return color;
    const properties = entity.properties?.getValue?.(
      cesium.JulianDate?.now?.(),
    );
    const key = properties?.__gevColorKey ?? properties?.[colorBy.field];
    return colorByValue.get(String(key ?? '')) || color;
  }
  let viewer = null;
  let enabled = false;
  let dataSource = null;
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

  function clear() {
    if (dataSource && viewer?.dataSources)
      viewer.dataSources.remove(dataSource, true);
    dataSource = null;
    loadedKey = null;
    count = 0;
    truncated = false;
    legendCounts = null;
  }

  /**
   * The box to query: a window around the point the camera looks at, sized
   * by camera height (an oblique view's visible area reaches the horizon,
   * far beyond what one page can fill), clipped to what is in view.
   */
  function viewBox(height) {
    const scene = viewer?.scene;
    const canvas = scene?.canvas;
    const ellipsoid = scene?.globe?.ellipsoid ?? cesium.Ellipsoid.WGS84;
    const target =
      (canvas &&
        viewer.camera.pickEllipsoid?.(
          new cesium.Cartesian2(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ),
          ellipsoid,
        )) ||
      viewer.camera.positionWC;
    const center =
      target && cesium.Cartographic.fromCartesian(target, ellipsoid);
    if (!center) return null;
    const lat = (center.latitude * 180) / Math.PI;
    const lon = (center.longitude * 180) / Math.PI;
    const halfLat = Math.min(
      VIEW_MAX_HALF_DEG,
      Math.max(VIEW_MIN_HALF_DEG, (height * VIEW_HALF_PER_METRE) / 111_320),
    );
    const halfLon = halfLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    let box = [lon - halfLon, lat - halfLat, lon + halfLon, lat + halfLat];
    const visible = viewer.camera.computeViewRectangle?.(ellipsoid);
    if (visible && visible.west < visible.east) {
      const degrees = [
        visible.west,
        visible.south,
        visible.east,
        visible.north,
      ].map((radians) => (radians * 180) / Math.PI);
      box = [
        Math.max(box[0], degrees[0]),
        Math.max(box[1], degrees[1]),
        Math.min(box[2], degrees[2]),
        Math.min(box[3], degrees[3]),
      ];
    }
    // A view across the antimeridian or off the globe is skipped.
    return box[0] < box[2] && box[1] < box[3] && box[0] >= -180 && box[2] <= 180
      ? box
      : null;
  }

  async function refresh() {
    timer = null;
    if (!enabled || !viewer) return;
    const height = viewer.camera?.positionCartographic?.height;
    if (!(Number.isFinite(height) && height <= maxAltitudeM)) {
      tooHigh = true;
      abort();
      loading = false;
      clear();
      render();
      return;
    }
    tooHigh = false;
    const box = viewBox(height);
    if (!box) return;
    const key = box.map((value) => value.toFixed(4)).join(',');
    // Back on the view already drawn: a request for the view in between is
    // obsolete and must not replace it.
    if (key === loadedKey && dataSource) {
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
      const loaded = await cesium.GeoJsonDataSource.load(
        { type: 'FeatureCollection', features: result.features },
        {
          clampToGround: true,
          fill: color.withAlpha(0.35),
          stroke: color,
          markerColor: color,
        },
      );
      if (!enabled || current.signal.aborted) return;
      loaded.name = entry.title;
      for (const entity of loaded.entities.values) {
        const fill = colorOf(entity);
        // Ground-clamped polygons cannot draw outlines; say so up front
        // instead of letting Cesium warn on every entity.
        if (entity.polygon) {
          entity.polygon.outline = false;
          if (colorBy) entity.polygon.material = fill.withAlpha(0.45);
        }
        // Points draw as small dots, not Cesium's default pins: a view can
        // hold thousands of them.
        if (entity.billboard && cesium.PointGraphics) {
          entity.billboard = undefined;
          entity.point = new cesium.PointGraphics({
            pixelSize: 6,
            color: fill,
            outlineColor: cesium.Color.BLACK.withAlpha(0.55),
            outlineWidth: 1,
            heightReference: cesium.HeightReference?.CLAMP_TO_GROUND,
          });
        }
      }
      await viewer.dataSources.add(loaded);
      if (!enabled || current.signal.aborted) {
        viewer.dataSources.remove(loaded, true);
        return;
      }
      const previous = dataSource;
      dataSource = loaded;
      if (previous) viewer.dataSources.remove(previous, true);
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
      removeMoveEnd = null;
      const moveEnd = viewer?.camera?.moveEnd;
      if (moveEnd?.addEventListener) {
        moveEnd.addEventListener(schedule);
        removeMoveEnd = () => moveEnd.removeEventListener(schedule);
      }
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
