import {
  CONTEXT_FEATURE,
  CONTEXT_LINES,
  contextLine,
} from './contextGeometry.js';
import {
  cameraOf,
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findGlobe,
  findQuery,
} from '../render/rendererOf.js';
import { cssColor } from '../render/color.js';
import { fromDegrees, fromDegreesInto, toLonLatH } from '../geo/ellipsoid.js';
import { frustumPlanes } from '../geo/frustum.js';
import { horizonFrom } from '../geo/horizon.js';
import { sphereFromPoints } from '../geo/sphere.js';
import { densifyRhumb } from '../geo/rhumb.js';
import { heightsOf } from '../queries/heights.js';
import {
  layerTitle,
  mapAnalystRecord,
  parseGeojsonLines,
} from '../sources/infrastructureData.js';
import { createInfrastructureOverlayEntry } from './infrastructureOverlayEntry.js';
import { createGeojsonPins } from './geojsonPins.js';
import { inputFor as defaultInputFor } from '../input/dispatcher.js';
import { isUnderOtherCard } from './pickRegistry.js';
import {
  selectInfraLod,
  applyInfraEvictionGrace,
  shouldRecomputeInfraLod,
} from './localGeojsonLod.js';

const DEFAULT_LABEL_MAX = 900;
const DEFAULT_LABEL_GRID_PX = 132;
const VISIBILITY_UPDATE_MS = 450;
// Each source keeps its own bounded cohort; the host sums their ambient-card
// paint budgets only up to its 192-card shared-lane ceiling.
export const LOCAL_OVERLAY_COHORT_LIMIT = 160;
const LOCAL_OVERLAY_COLLISION_CAPACITY = 96;
const LOCAL_OVERLAY_CELL_SURPLUS = 2;
// Stems are anchored at ellipsoid height 0, but high-elevation features
// (e.g. dams in river canyons) sit hundreds of meters above the ellipsoid,
// burying the short close-in stem inside the photoreal mesh. Once the
// camera is near enough for tiles to be loaded, sample the real surface
// height once per feature and lift the stem onto it.
const GROUND_SAMPLE_MAX_DISTANCE_M = 75000;
const GROUND_SAMPLE_RETRY_MS = 2000;
const GROUND_SAMPLE_MAX_ABS_HEIGHT_M = 9000;
/**
 * Bounded give-up for the self-armed retry. Sampling can be SUPPORTED and still
 * never succeed (no sampleable surface under the feature), in which case each
 * requested frame would arm the next 2 s timer forever — an idle-governor leak
 * dressed up as a retry. After this many consecutive armed retries with no
 * record newly grounded, stop arming; camera motion (a frame we get for free)
 * still retries through the normal preRender walk and re-opens the budget.
 * 30 × 2 s ≈ 60 s, far longer than a tile stream-in.
 */
export const GROUND_SAMPLE_MAX_ARMED_RETRIES = 30;
/** Ignore sub-metre camera-derived stem-tip noise at camera settle. */
export const LOCAL_STEM_TIP_EPSILON_M = 0.5;
const LOCAL_STEM_TIP_EPSILON_SQ = LOCAL_STEM_TIP_EPSILON_M ** 2;

/**
 * Build the owner-approved local-infrastructure card copy.
 * @param {object} properties Unwrapped GeoJSON feature properties.
 * @param {string} layerId Local layer id.
 * @returns {{title:string,details:string[]}}
 */
export function localInfrastructureOverlayCopy(properties, layerId) {
  const props = unwrapProperties(properties) || {};
  const tags = props.tags || {};
  const title = featureLabelFromProperties(props, layerId);
  const details = [];

  if (layerId === 'local-datacenters') {
    const operator = firstClean([
      tags.operator,
      props.operator,
      tags['operator:short'],
    ]);
    const capacity = firstClean([
      tags['capacity:it_load'],
      tags.it_load,
      tags.capacity,
      props.capacity,
    ]);
    const line = [operator, capacity]
      .filter(
        (value, index, values) => value && values.indexOf(value) === index,
      )
      .filter(
        (value) => value.toLocaleLowerCase() !== title.toLocaleLowerCase(),
      )
      .join(' · ');
    if (line) details.push(clampCardLine(line));
  } else if (layerId === 'local-dams') {
    const river = firstClean([
      tags.associated_river,
      props.associated_river,
      tags.river,
      props.river,
      tags['river:name'],
    ]);
    if (river && river.toLocaleLowerCase() !== title.toLocaleLowerCase()) {
      details.push(clampCardLine(river));
    }
  } else if (Array.isArray(props.__gevDetails)) {
    // Data Library features carry their card lines from the manifest
    // (src/library/formats.js presentLibraryProperties).
    for (const line of props.__gevDetails.slice(0, 2)) {
      const clean = cleanLabel(line);
      if (clean) details.push(clampCardLine(clean));
    }
  }

  return { title, details };
}

/**
 * Produce one normalized-contract input owned by a local infrastructure layer.
 * The host revalidates the authoritative `source` value while normalizing it.
 * @param {object} options
 * @param {string} options.id Stable id within the source.
 * @param {string} options.layerId Local layer id.
 * @param {{x: number, y: number, z: number}} options.position Current stem-tip
 *   position, ECEF metres.
 * @param {object} options.properties Unwrapped feature properties.
 * @param {number} options.priority Source-owned importance score.
 * @param {string} options.accent Source accent color.
 * @returns {object}
 */
export function createLocalInfrastructureOverlayEntry({
  id,
  layerId,
  position,
  properties,
  priority,
  accent,
}) {
  const copy = localInfrastructureOverlayCopy(properties, layerId);
  return createInfrastructureOverlayEntry({
    id,
    source: layerId,
    position,
    title: copy.title,
    details: copy.details,
    accent,
    priority,
  });
}

/**
 * Retain a bounded screen-grid surplus for the host's final rectangle arbiter.
 * Two deterministic contenders per legacy grid cell preserve the old density
 * while giving the shared solver an alternative when the first card collides.
 * @param {object[]} records Local stem/entry records.
 * @param {object} options
 * @param {number} options.maxEntries Legacy source cap.
 * @param {number} options.gridPx Legacy screen grid size.
 * @param {number} options.width Viewport width in CSS pixels.
 * @param {number} options.height Viewport height in CSS pixels.
 * @param {function(object):({x:number,y:number}|null)} options.project Projection callback.
 * @param {number} [options.cohortLimit=Infinity] Host-safe materialization cap.
 * @returns {object[]} Bounded overlay entries for shared-host arbitration.
 */
export function selectLocalInfrastructureOverlayCohort(
  records,
  {
    maxEntries,
    gridPx,
    width,
    height,
    project,
    cohortLimit = Number.POSITIVE_INFINITY,
  },
) {
  const sourceCap = Math.max(0, Math.floor(Number(maxEntries) || 0));
  const materializationCap = Number.isFinite(Number(cohortLimit))
    ? Math.max(0, Math.floor(Number(cohortLimit)))
    : Number.POSITIVE_INFINITY;
  const cap = Math.min(sourceCap, materializationCap);
  const cellSize = Math.max(1, Number(gridPx) || 1);
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    cap === 0 ||
    typeof project !== 'function'
  ) {
    return [];
  }

  const cells = new Map();
  const padding = cellSize;
  for (const record of records) {
    const screen = project(record);
    if (!Number.isFinite(screen?.x) || !Number.isFinite(screen?.y)) continue;
    if (
      screen.x < -padding ||
      screen.x > width + padding ||
      screen.y < -padding ||
      screen.y > height + padding
    )
      continue;
    const key = `${Math.floor(screen.x / cellSize)}:${Math.floor(screen.y / cellSize)}`;
    let contenders = cells.get(key);
    if (!contenders) {
      contenders = [];
      cells.set(key, contenders);
    }
    insertLocalCellContender(contenders, record);
  }

  const primary = [];
  const surplus = [];
  for (const contenders of cells.values()) {
    if (contenders[0]) primary.push(contenders[0]);
    if (contenders[1]) surplus.push(contenders[1]);
  }
  primary.sort(compareLocalOverlayRecords);
  surplus.sort(compareLocalOverlayRecords);
  if (primary.length >= cap)
    return primary.slice(0, cap).map((record) => record.entry);
  const candidates = primary.concat(surplus.slice(0, cap - primary.length));
  return candidates.map((record) => record.entry);
}

/**
 * Bind a local layer's visibility and entry lifecycle to the shared host.
 * @param {object} options
 * @param {string} options.sourceId Local layer id.
 * @param {object} [options.host] Test seam for the three host lifecycle calls.
 * @returns {{show:function():void,publish:function(object[]):void,hide:function():void,destroy:function():void}}
 */
export function createLocalInfrastructureOverlayPublisher({ sourceId, host }) {
  let visible = false;
  let published = false;
  let destroyed = false;
  // Local entries have immutable metadata and a mutable Cartesian position.
  // Snapshot coordinates: retaining only the entry reference would miss a
  // stem tip moving in place. Republishing an unchanged cohort invalidates
  // the host and can sustain a render loop when frames exceed the 450 ms walk.
  let lastPublication = null;
  const sourceOptions = {
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    collisionCapacity: LOCAL_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  };

  return {
    show() {
      if (destroyed || visible) return;
      visible = true;
      host.setVisible(sourceId, true);
    },
    publish(entries) {
      if (destroyed || !visible) return;
      if (
        lastPublication &&
        entries.length === lastPublication.length &&
        entries.every((entry, index) => {
          const previous = lastPublication[index];
          return (
            entry === previous.entry &&
            entry.position?.x === previous.x &&
            entry.position?.y === previous.y &&
            entry.position?.z === previous.z
          );
        })
      )
        return;
      host.setEntries(sourceId, entries, sourceOptions);
      lastPublication = entries.map((entry) => ({
        entry,
        x: entry.position?.x,
        y: entry.position?.y,
        z: entry.position?.z,
      }));
      published = entries.length > 0;
    },
    hide() {
      if (destroyed) return;
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
      lastPublication = null;
    },
    destroy() {
      if (destroyed) return;
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
      lastPublication = null;
      destroyed = true;
    },
  };
}

/**
 * Reduce a bundled-dataset load failure to one short, honest stats string.
 *
 * These layers ship their data with the build, so a failure means the asset
 * is missing (404 / bad path) or corrupt — never "the network is slow". Both
 * must reach the user's chip; the raw parser message is console-only because
 * a truncated JSON blob is not a status line.
 *
 * @param {Error|{name?:string, message?:string}|null|undefined} error - The thrown load failure.
 * @returns {string} Short reason for getStats().error.
 */
export function localDatasetError(error) {
  if (error?.name === 'SyntaxError') return 'dataset is malformed';
  const message = String(error?.message || '').trim();
  return message ? `dataset unavailable (${message})` : 'dataset unavailable';
}

/** Layer instances made so far, so each draws under set ids of its own. */
let layerInstances = 0;

/** The stem's starting height above the ellipsoid, until the first walk sizes it. */
const INITIAL_TIP_HEIGHT_M = 2000;
/** A polygon's fill alpha, and the line widths, as the GeoJSON loader drew them. */
const FILL_ALPHA = 0.3;
const FEATURE_LINE_WIDTH_PX = 2;
const STEM_WIDTH_PX = 3.5;
const PIN_SIZE_PX = 8;
const BLACK = Object.freeze([0, 0, 0, 1]);

/** The GeoJSON loader's `marker-size` names, in pixels. */
const MARKER_SIZES = Object.freeze({ small: 24, medium: 48, large: 64 });
/**
 * Ground edges are drawn along rhumb lines, split this finely (metres), as
 * the default renderer splits a draped rhumb line.
 */
const RHUMB_GRANULARITY_M = 9999;

/** `rgba` with alpha `alpha`. */
const withAlpha = (rgba, alpha) => [rgba[0], rgba[1], rgba[2], alpha];

/** Whether the loader took a property: present and not null. */
const given = (value) => value !== undefined && value !== null;

/**
 * A feature's own stroke as the GeoJSON loader read it from its
 * properties (`stroke`, `stroke-opacity`, `stroke-width`), over the
 * layer's colour and width.
 */
export function strokeOf(properties, rgba) {
  let color = null;
  let widthPx = FEATURE_LINE_WIDTH_PX;
  if (properties) {
    if (given(properties['stroke-width']))
      widthPx = Number(properties['stroke-width']);
    if (given(properties.stroke)) color = cssColor(properties.stroke);
    const opacity = properties['stroke-opacity'];
    if (given(opacity) && opacity !== 1)
      color = withAlpha(color ?? rgba, Number(opacity));
  }
  return { color: color ?? rgba, widthPx };
}

/**
 * A polygon's own fill as the GeoJSON loader read it (`fill` keeps the
 * layer's fill alpha; `fill-opacity` sets the alpha).
 */
export function fillOf(properties, fillColor) {
  let fill = null;
  if (properties) {
    if (given(properties.fill)) {
      const css = cssColor(properties.fill);
      if (css) fill = withAlpha(css, fillColor[3]);
    }
    const opacity = properties['fill-opacity'];
    if (given(opacity) && opacity !== fillColor[3])
      fill = withAlpha(fill ?? fillColor, Number(opacity));
  }
  return fill ?? fillColor;
}

/**
 * A point's own marker colour and size as the GeoJSON loader read them
 * (`marker-color`, `marker-size`), over the layer's.
 */
function markerOf(properties, rgba) {
  const color = given(properties?.['marker-color'])
    ? cssColor(properties['marker-color'])
    : null;
  const size = MARKER_SIZES[properties?.['marker-size']] ?? PIN_SIZE_PX;
  return { color: color ?? rgba, size };
}

/** Whether a geometry has a point among its parts. */
const hasPoint = (shape) =>
  shape?.type === 'Point' ||
  shape?.type === 'MultiPoint' ||
  (shape?.type === 'GeometryCollection' &&
    Array.isArray(shape.geometries) &&
    shape.geometries.some(hasPoint));

/** The `marker-symbol` of every feature that draws a pin. */
function* markerSymbols(features) {
  for (const feature of features) {
    const symbol = feature?.properties?.['marker-symbol'];
    if (symbol !== undefined && symbol !== null && hasPoint(feature.geometry))
      yield symbol;
  }
}

/**
 * Ground `coordinates` as `{lon, lat}` degrees along the rhumb lines
 * between them, as the GeoJSON loader drew its draped edges.
 */
export function rhumbPositions(coordinates) {
  return densifyRhumb(
    coordinates.map((c) => ({ lon: c[0] * RADIANS, lat: c[1] * RADIANS })),
    RHUMB_GRANULARITY_M,
  ).map(({ lon, lat }) => ({ lon: lon / RADIANS, lat: lat / RADIANS }));
}
const RADIANS = Math.PI / 180;

/**
 * What a feature is known by: its id, or the feature itself when it has
 * none. A feature drawn in several parts (a MultiPolygon, or a dam mapped as
 * its outline and again as its crest lines under one id) is one feature.
 * @param {object} feature
 * @returns {string|object}
 */
function localFeatureKey(feature) {
  const { id } = feature;
  return id == null ? feature : String(id);
}

/**
 * The drawn parts of a feature collection, one per thing the GeoJSON loader
 * made an entity of, in its order and under its ids: a polygon, line or
 * point per part of a multi-geometry, the feature's id taking `_2`, `_3`…
 * when repeated, and an empty part for a null geometry. A feature without
 * an id gets one of its own. Throws as the loader does on a missing or
 * unknown geometry.
 * @param {object[]} features
 * @returns {Array<{id: string, kind: 'polygon'|'line'|'point'|'empty',
 *   feature: object, coordinates?: any}>}
 */
export function localGeojsonParts(features) {
  const parts = [];
  const taken = new Set();
  const idOf = (feature) => {
    const base =
      feature.id === undefined || feature.id === null
        ? `local-part:${parts.length}`
        : String(feature.id);
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
    return id;
  };
  const add = (feature, kind, coordinates) => {
    const id = idOf(feature);
    taken.add(id);
    parts.push({ id, kind, feature, coordinates });
  };
  const polygon = (feature, rings) => {
    if (rings.length === 0 || rings[0].length === 0) return;
    add(feature, 'polygon', rings);
  };
  const geometry = (feature, shape) => {
    switch (shape.type) {
      case 'Point':
        return add(feature, 'point', shape.coordinates);
      case 'MultiPoint':
        for (const point of shape.coordinates) add(feature, 'point', point);
        return;
      case 'LineString':
        return add(feature, 'line', shape.coordinates);
      case 'MultiLineString':
        for (const line of shape.coordinates) add(feature, 'line', line);
        return;
      case 'Polygon':
        return polygon(feature, shape.coordinates);
      case 'MultiPolygon':
        for (const rings of shape.coordinates) polygon(feature, rings);
        return;
      case 'GeometryCollection':
        for (const inner of shape.geometries) geometry(feature, inner);
        return;
      default:
        throw new Error(`Unknown geometry type: ${shape.type}`);
    }
  };
  for (const feature of features) {
    if (feature.geometry === null) {
      add(feature, 'empty');
      continue;
    }
    if (!feature.geometry) throw new Error('feature.geometry is required.');
    geometry(feature, feature.geometry);
  }
  return parts;
}

function anonymousContent(feature) {
  const properties = unwrapProperties(feature.properties ?? {});
  // The library computes rank from the whole snapshot. Inserting a newer
  // row can change it even when this source feature is unchanged.
  delete properties.__gevRank;
  return JSON.stringify([feature.geometry, properties], (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}

/** Keep anonymous Context keys independent of renderer part order. */
function anonymousContextKeys(parts, layerId, previous, nextKey) {
  const keys = new Map();
  const placeOf = new Map();
  const sourceIds = new Map();
  const sourceIdCounts = new Map();
  for (const { feature, kind, coordinates } of parts) {
    if (feature.id != null || kind === 'empty' || keys.has(feature)) continue;
    const point =
      kind === 'point'
        ? coordinates
        : kind === 'line'
          ? coordinates[0]
          : coordinates[0][0];
    const properties = unwrapProperties(feature.properties ?? {});
    const { name } = mapAnalystRecord({ properties }, layerId);
    placeOf.set(feature, JSON.stringify([point[1], point[0], name]));
    const sourceId = Object.hasOwn(properties, '__gevSourceId')
      ? properties.__gevSourceId
      : null;
    if (typeof sourceId === 'string' && sourceId) {
      sourceIds.set(feature, sourceId);
      sourceIdCounts.set(sourceId, (sourceIdCounts.get(sourceId) ?? 0) + 1);
    }
    keys.set(feature, null);
  }
  const uniqueId = (feature) => {
    const id = sourceIds.get(feature);
    return id && sourceIdCounts.get(id) === 1 ? id : null;
  };

  // Match the feed's own id first, wherever the feature moved. Every feature
  // still claims its place for the next snapshot.
  const byLocation = new Map();
  for (const feature of keys.keys()) {
    keys.set(feature, previous?.sourceKeys.get(uniqueId(feature)) ?? null);
    const place = placeOf.get(feature);
    if (!byLocation.has(place)) byLocation.set(place, []);
    byLocation.get(place).push(feature);
  }

  const groups = new Map();
  for (const [place, features] of byLocation) {
    const before = previous?.places.get(place);
    if (features.length === 1 && !before?.byContent) {
      const feature = features[0];
      const owner = sourceIds.get(feature) ?? null;
      const key =
        keys.get(feature) ?? (before?.owner === owner ? before.key : nextKey());
      keys.set(feature, key);
      groups.set(place, { feature, key, owner });
      continue;
    }

    // Once a place is ambiguous, keep matching its surviving features by
    // content. A singleton entering a collision can only keep an exact match.
    const oldKeys =
      before?.byContent ??
      (before && new Map([[anonymousContent(before.feature), [before.key]]]));
    const featuresByContent = new Map();
    for (const feature of features) {
      const content = anonymousContent(feature);
      if (!featuresByContent.has(content)) featuresByContent.set(content, []);
      featuresByContent.get(content).push(feature);
    }
    const byContent = new Map();
    groups.set(place, { byContent });
    for (const [content, matches] of featuresByContent) {
      const prior = oldKeys?.get(content);
      const own = matches.length === 1 ? keys.get(matches[0]) : null;
      // A different number of exact duplicates leaves no way to tell
      // which of those identical features survived.
      const ids = own
        ? [own]
        : prior?.length === matches.length
          ? prior
          : matches.map(() => nextKey());
      byContent.set(content, ids);
      for (const [index, feature] of matches.entries())
        keys.set(feature, ids[index]);
    }
  }
  const sourceKeys = new Map();
  for (const [feature, key] of keys) {
    const id = uniqueId(feature);
    if (id) sourceKeys.set(id, key);
  }
  return { keys, groups: { places: groups, sourceKeys } };
}

const lonLatOf = (coordinates) => ({
  lon: coordinates[0],
  lat: coordinates[1],
});
const distance = (a, b) => Math.sqrt(distanceSquared(a, b));
function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
const copy = (p) => ({ x: p.x, y: p.y, z: p.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * The horizontal field of view the stems are sized by: the wider of the
 * two angles, as the default renderer's frustum states its field of view.
 */
function wideFov(pose) {
  const fovy = Number.isFinite(pose?.fovy) ? pose.fovy : Math.PI / 3;
  const aspect = pose?.aspectRatio;
  return Number.isFinite(aspect) && aspect > 1
    ? 2 * Math.atan(Math.tan(fovy / 2) * aspect)
    : fovy;
}

/**
 * A layer drawing a bundled GeoJSON dataset through the renderer's draw
 * port: polygons and lines on the ground, and on each polygon or point a
 * 3D stem with a dot on its tip, sized to the camera and lifted onto the
 * sampled surface. Clicking any of it selects the feature and flies there.
 * @param {object} options Dataset URL (or a `loadFeatures({signal})` loader
 *   resolving to GeoJSON features), identity, appearance (an optional
 *   `featureColor(properties)` returns a CSS colour per feature) and optional
 *   adapters.
 * @param {object} services Caller-owned operations; see docs/INFRASTRUCTURE-LAYERS.md.
 *   An optional `getSelectedEntityContext()` lets `replaceFeatures` keep the
 *   selection on a feature the new set still has.
 * @returns {object} A fresh layer implementing init/enable/disable/update/destroy/getStats/getAnalystRecords.
 * One live instance per layer id is allowed in a given viewer/context/overlay host.
 * Destroy the previous instance before replacing it. Importing creates no layers.
 */
export function createLocalGeoJsonLayer(
  {
    id,
    url,
    name,
    color,
    icon = '📍',
    source = 'Local JSONL',
    osmDerived = false,
    labels = true,
    labelMax = DEFAULT_LABEL_MAX,
    labelGridPx = DEFAULT_LABEL_GRID_PX,
    loadFeatures = null,
    featureColor = null,
    inputFor = defaultInputFor,
    projectToWindow = (viewer, position) =>
      findQuery(viewer)?.project(position) ?? null,
  },
  {
    overlayHost,
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
    getSelectedEntityContext = null,
    governorRequestRender,
    showOsmCredit,
    hideOsmCredit,
  },
) {
  const setPrefix = `${id}:${++layerInstances}`;
  /** Builds made so far: each draws under set ids of its own. */
  let builds = 0;
  let anonymousGroups;
  let anonymousSequence = 0;
  /** Bumped by each `replaceFeatures`, so only the latest one swaps in. */
  let replacements = 0;
  /** The pins its points stand on, one image per distinct marker. */
  const pinMaker = createGeojsonPins();
  /** What this layer draws while built: its sets and parts, or null. */
  let _drawn = null;
  let _enabled = false;
  let _clickSubscription = null;
  let _count = 0;
  /** @type {number|null} Timestamp of the last successful dataset load. */
  let _lastUpdate = null;
  /** @type {string|null} Short reason the bundled dataset failed to load. */
  let _error = null;
  let _preRenderRemover = null;
  let _cameraMoveEndRemover = null;
  let _stemRecords = [];
  let _stemGeometryDirty = true;
  let _lastVisibilityUpdate = 0;
  let _destroyed = false;
  let _loadPromise = null;
  let _loadController = null;
  /**
   * The parsed bundled dataset, kept across disable/enable so a re-enable
   * rebuilds its sets without refetching. The sets themselves are NOT kept:
   * a hidden set still holds its primitives, and the ~11k features of the
   * three bundled layers hold hundreds of MB, so leaving them parked after a
   * toggle-off made the whole scene render ~2× slower for the rest of the
   * session (owner field test 2026-09-13).
   * @type {Array<object>|null}
   */
  let _cachedFeatures = null;
  /**
   * Globe-LOD active set: the record ids allowed to carry a live stem right
   * now. This bounds geometry refreshes and ground-sample work to the
   * camera-height budget in localGeojsonLod.js. Recomputed only
   * when the camera moves (`_stemGeometryDirty`, raised by moveEnd and by the
   * motion fallback below). Empty means "not computed yet" — the first
   * post-enable walk fills it.
   * @type {Set<string>}
   */
  let _activeLodIds = new Set();
  /** Eviction-grace bookkeeping for `_activeLodIds` (id -> {misses, since}). */
  let _lodGraceState = new Map();
  /** Budget cap the most recent camera-height band produced (0 until computed). */
  let _lastLodBudgetLimit = 0;
  /**
   * False until the first post-enable preRender walk has run the LOD
   * selection. While false the walk treats every record as active (old
   * behavior); once true, an EMPTY `_activeLodIds` legitimately means "nothing
   * should carry a stem right now" (e.g. every feature occluded), not "not
   * computed yet".
   */
  let _lodComputed = false;
  /**
   * Camera position the last LOD selection ran from — the reference the motion
   * fallback measures travel against. Preallocated: the walk copies into it,
   * so a moving camera allocates nothing per pass. Only meaningful while
   * `_lodComputed` is true.
   */
  const _lastLodCameraPos = { x: 0, y: 0, z: 0 };
  /** Last time the motion-fallback probe window opened (or a selection ran). */
  let _lastLodProbeMs = Number.NEGATIVE_INFINITY;
  let _groundRetryTimer = null;
  /** Consecutive self-armed retries since the last grounding/camera motion. */
  let _groundRetryArms = 0;
  /** Last observed height-sampling support; null until the first walk. */
  let _lastGroundSampleCapability = null;

  /**
   * Coalesced one-shot: ask the governor for a frame once the retry window
   * has elapsed, so the preRender ground-sample retry actually runs while the
   * camera is parked. One timer for the whole layer (not per record) — the
   * retry pass walks every record anyway. (perf rebase 2026-08-17)
   *
   * Two gates keep this from becoming an idle leak (review round 2):
   *   - CAPABILITY: without height sampling the sample can never succeed, so
   *     a timer here would re-arm on every requested frame, forever. Records
   *     simply stay at ellipsoid height — exactly the pre-perf keyless
   *     behavior.
   *   - BUDGET: sampling can be supported and still keep failing (no sampleable
   *     surface yet/ever). Give up after GROUND_SAMPLE_MAX_ARMED_RETRIES
   *     consecutive arms; free camera-motion frames still retry.
   * @param {object} viewer
   * @returns {void}
   */
  function scheduleGroundRetryRender(viewer) {
    if (_groundRetryTimer || !_enabled) return;
    if (!heightsOf(viewer).supported().surface) return;
    if (_groundRetryArms >= GROUND_SAMPLE_MAX_ARMED_RETRIES) return;
    _groundRetryArms += 1;
    _groundRetryTimer = setTimeout(() => {
      _groundRetryTimer = null;
      if (!_enabled || _destroyed) return;
      governorRequestRender(`local-ground-retry:${id}`);
    }, GROUND_SAMPLE_RETRY_MS);
  }

  function clearGroundRetryRender() {
    _groundRetryArms = 0;
    _lastGroundSampleCapability = null;
    if (!_groundRetryTimer) return;
    clearTimeout(_groundRetryTimer);
    _groundRetryTimer = null;
  }
  const _overlayPublisher = createLocalInfrastructureOverlayPublisher({
    sourceId: id,
    host: overlayHost,
  });

  /** Register the context of each record a build made. */
  function registerContexts(records) {
    for (const record of records)
      registerEntityContext(record.carrier, record.context);
  }

  /** Let go of every set a build made. */
  function disposeSets(sets) {
    for (const set of Object.values(sets)) {
      try {
        set.dispose();
      } catch {
        /* its scene is already gone */
      }
    }
  }

  /**
   * Take the built sets out of the scene entirely. The parsed features stay
   * cached, so the next enable() rebuilds without a fetch; what must not
   * survive a disable is what the sets draw and hold.
   */
  const releaseDrawn = () => {
    if (!_drawn) return;
    const drawn = _drawn;
    _drawn = null;
    _stemRecords = [];
    _stemGeometryDirty = true;
    _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
    removeEntityContextsForLayer(id);
    disposeSets(drawn.sets);
  };

  const disableLayer = (viewer) => {
    hideOsmCredit?.(viewer, id);
    _enabled = false;
    clearGroundRetryRender();
    _activeLodIds = new Set();
    _lodGraceState = new Map();
    _lastLodBudgetLimit = 0;
    _lodComputed = false;
    _lastLodProbeMs = Number.NEGATIVE_INFINITY;
    releaseDrawn();
    _overlayPublisher.hide();
    clearSelectedEntityContextForLayer(id);
    if (_preRenderRemover) {
      _preRenderRemover();
      _preRenderRemover = null;
    }
    if (_cameraMoveEndRemover) {
      _cameraMoveEndRemover();
      _cameraMoveEndRemover = null;
    }
  };

  /**
   * Build the sets for the parsed features: a fill for each polygon, a
   * draped line for each line, a pin for each point, and a stem and its dot
   * for each polygon and point. Hidden until the enable finishes, as the
   * loader's data source was. Each record's context is made here and
   * registered by the caller once the build has succeeded.
   */
  function buildDrawn(viewer, features) {
    const draw = drawOf(viewer);
    const rgba = cssColor(color) ?? [1, 1, 1, 1];
    const fillColor = [rgba[0], rgba[1], rgba[2], FILL_ALPHA];
    // An optional per-feature colour (Data Library colorBy): its CSS value
    // and RGBA, one per distinct value.
    const colors = new Map();
    const colorOf = (properties) => {
      const css =
        (typeof featureColor === 'function' && featureColor(properties)) ||
        color;
      if (css === color) return { css, rgba };
      if (!colors.has(css)) colors.set(css, { css, rgba: cssColor(css) });
      const found = colors.get(css);
      return found.rgba ? found : { css: color, rgba };
    };
    const parts = localGeojsonParts(features);
    const sets = {};
    // The count is of features, not parts: a multi-part feature is one item.
    const built = {
      sets,
      parts: new Map(),
      records: [],
      anonymous: anonymousContextKeys(
        parts,
        id,
        anonymousGroups,
        () => `geojson:anonymous:${setPrefix}:${++anonymousSequence}`,
      ),
      count: new Set(parts.map((part) => localFeatureKey(part.feature))).size,
    };
    const prefix = `${setPrefix}:${++builds}`;
    try {
      sets.fills = draw.shapes({ id: `${prefix}:fills`, show: false });
      // Raised polygons apart: a ground fill showing or hiding changes in
      // place only in a set of ground fills.
      sets.raised = draw.shapes({ id: `${prefix}:raised`, show: false });
      sets.lines = draw.lines({ id: `${prefix}:lines`, show: false });
      sets.pins = draw.icons({ id: `${prefix}:pins`, show: false });
      sets.stems = draw.lines({ id: `${prefix}:stems`, show: false });
      sets.dots = draw.points({ id: `${prefix}:dots`, show: false });

      const fills = [];
      const lines = [];
      const pins = [];
      for (const part of parts) {
        if (part.kind === 'empty') continue;
        const properties = unwrapProperties(part.feature.properties ?? {});
        // The object every item of this part carries as its `meta`: what a
        // click or point-and-ask hit hands back, and the context carrier.
        const carrier = { layerId: id, id: part.id, record: null };
        part.carrier = carrier;
        built.parts.set(part.id, part);
        // The feature's own simplestyle properties, as the loader read them.
        const style = part.feature.properties;
        if (part.kind === 'line') {
          const line = rhumbPositions(part.coordinates);
          part.contextLine = contextLine(line);
          const positions = line.map(({ lon, lat }) =>
            fromDegrees(lon, lat, 0),
          );
          part.flyTo = lonLatOf(part.coordinates[0]);
          const stroke = strokeOf(style, rgba);
          lines.push({
            id: part.id,
            positions,
            widthPx: stroke.widthPx,
            mode: 'draped',
            style: { kind: 'solid', color: stroke.color },
            meta: carrier,
          });
          continue;
        }

        const own = colorOf(properties);
        let lon;
        let lat;
        if (part.kind === 'polygon') {
          // Heights on the first position make the loader's polygon one of
          // per-position heights, outlined, its edges straight between its
          // positions; without, it lies on the ground along rhumb lines.
          const raised = part.coordinates[0][0].length > 2;
          part.raised = raised;
          part.rings = part.coordinates.map((ring) =>
            raised
              ? ring.map(([lon, lat, h]) => ({
                  lon,
                  lat,
                  height: Number(h) || 0,
                }))
              : rhumbPositions(ring),
          );
          // A feature colour of its own fills it, over its simplestyle fill.
          part.fill =
            own.rgba === rgba
              ? fillOf(style, fillColor)
              : withAlpha(own.rgba, FILL_ALPHA);
          // The stem stands on the centre of the outer ring's bounding
          // sphere, carried to the surface.
          const center = toLonLatH(
            sphereFromPoints(
              part.coordinates[0].map(([x, y, h]) =>
                fromDegrees(x, y, raised ? Number(h) || 0 : 0),
              ),
            ).center,
          );
          lon = center.lon;
          lat = center.lat;
        } else {
          lon = part.coordinates[0];
          lat = part.coordinates[1];
          part.pinClamped = part.coordinates.length <= 2;
          part.pinPos = { lon, lat };
          const marker = markerOf(style, own.rgba);
          part.pin = pinMaker.pin({
            ...marker,
            symbol: style?.['marker-symbol'],
          });
          part.pinSize = marker.size;
        }

        const groundHeight = 0; // Ellipsoid surface until a scene sample lands
        const base = fromDegrees(lon, lat, groundHeight);
        const tip = fromDegrees(lon, lat, INITIAL_TIP_HEIGHT_M);
        const recordId = part.id;
        const priority = labelPriorityFromProperties(properties, id);
        const record = {
          id: recordId,
          part,
          carrier,
          lon,
          lat,
          base,
          tip,
          nextTip: copy(tip),
          groundHeight,
          groundSampled: false,
          lastGroundSampleMs: 0,
          priority,
          properties,
          rgba: own.rgba,
          visible: true,
          entry: labels
            ? createLocalInfrastructureOverlayEntry({
                id: recordId,
                layerId: id,
                position: tip,
                properties,
                priority,
                accent: own.css,
              })
            : null,
          context: {
            id: `${id}:${recordId}`,
            layerId: id,
            layerName: name,
            source,
            label: featureLabelFromProperties(properties, id),
            properties,
            latitude: Number(lat.toFixed(6)),
            longitude: Number(lon.toFixed(6)),
            // The surface base voice targeting projects. Ground sampling
            // re-grounds it in place, so this stays current.
            targetPosition: base,
          },
        };
        carrier.record = record;
        // A context record is active while its feature shows.
        Object.defineProperty(carrier, 'show', {
          get: () => record.visible,
          enumerable: true,
        });
        built.records.push(record);
        if (part.kind === 'polygon') fills.push(fillItem(record));
        else pins.push(pinItem(record));
      }
      sets.fills.set(fills.filter((item) => item.height === 'clampGround'));
      sets.raised.set(fills.filter((item) => item.height !== 'clampGround'));
      sets.lines.set(lines);
      sets.pins.set(pins);
      sets.stems.set(built.records.map(stemItem));
      sets.dots.set(built.records.map(dotItem));
    } catch (error) {
      disposeSets(sets);
      throw error;
    }
    return built;
  }

  /**
   * Write what a walk changed: the stems and dots that moved or showed or
   * hid, the fills and pins that showed or hid (changed in place), and the
   * pins standing on a tip that moved.
   */
  function writeChanges(drawn, moved, shown) {
    if (!moved.size && !shown.size) return;
    const stems = new Set([...moved, ...shown]);
    drawn.sets.stems.upsert([...stems].map(stemItem));
    drawn.sets.dots.upsert([...stems].map(dotItem));
    const fills = [];
    const pins = [];
    for (const record of stems) {
      const { kind, pinClamped } = record.part;
      if (!shown.has(record) && (kind !== 'point' || pinClamped)) continue;
      if (kind === 'polygon') fills.push(fillItem(record));
      else pins.push(pinItem(record));
    }
    const ground = fills.filter((item) => item.height === 'clampGround');
    const raised = fills.filter((item) => item.height !== 'clampGround');
    if (ground.length) drawn.sets.fills.upsert(ground);
    if (raised.length) drawn.sets.raised.upsert(raised);
    if (pins.length) drawn.sets.pins.upsert(pins);
  }

  /** Fly to where a clicked part stands, holding camera input meanwhile. */
  function flyToPart(viewer, input, part) {
    const target = part.carrier.record
      ? { lon: part.carrier.record.lon, lat: part.carrier.record.lat }
      : part.flyTo;
    if (!target) return;
    // Before the hold: with no camera, nothing would end it.
    const camera = cameraOf(viewer);
    // Hold camera input so the user's input doesn't cancel the flight.
    // A hold, not a flag: the flight ending must not hand input back under
    // a drag or the cockpit.
    const releaseCamera = input.suspendCamera('local-geojson-flight');
    camera.flyTo(
      { lon: target.lon, lat: target.lat, height: 5000 },
      {
        durationS: 1.5,
        onComplete: releaseCamera,
        onCancel: releaseCamera,
      },
    );
  }

  const recordFeature = new WeakMap();
  const siteRecord = (feature, idForAnalyst, lat, lon, properties) => {
    const record = mapAnalystRecord(
      { id: idForAnalyst, lat, lon, properties },
      id,
    );
    const key = localFeatureKey(feature);
    record.key =
      typeof key === 'object'
        ? _drawn.anonymous.keys.get(feature)
        : `geojson:id:${key}`;
    Object.defineProperty(record, CONTEXT_FEATURE, {
      value: { layerName: name, source, properties },
    });
    recordFeature.set(record, feature);
    return record;
  };

  const layer = {
    id,
    name,
    icon,
    source,
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init: async (viewer) => {
      // DataLayerManager calls this once
    },

    update: async (viewer) => {
      // DataLayerManager calls this when enabled
    },

    /**
     * @returns {{count:number, lastUpdate:number|null, error:string|null}}
     *   A dead layer must be distinguishable from an empty one: a failed load
     *   surfaces `error` (manager chip → UNAVAILABLE) instead of reporting a
     *   silent zero count as nominal.
     */
    getStats: () => {
      return { count: _count, lastUpdate: _lastUpdate, error: _error };
    },

    /**
     * Globe-LOD state for QA harnesses (scripts/qa-infra-lod.mjs) and tests.
     * `active` is how many records currently carry a live stem; `total` is the
     * full materialized set. `active < total` means the declutter is engaged.
     * `budgetLimit` is the cap the last camera-height band produced; `computed`
     * is false until the first post-enable walk has run the selection.
     * @returns {{total:number, active:number, budgetLimit:number, computed:boolean}}
     */
    getLodDiagnostics: () => ({
      total: _stemRecords.length,
      active: _activeLodIds.size,
      budgetLimit: _lastLodBudgetLimit,
      computed: _lodComputed,
    }),

    /**
     * Snapshot in-memory infrastructure features as plain JSON-safe objects
     * for the analyst query engine. On-demand only (called at most once per
     * spoken query) — zero per-frame cost, no listeners, no caching. Returns
     * [] while the layer is disabled or empty. Disable keeps the loaded
     * stems for reuse; this method still returns [] until the next enable.
     * @param {number} [maxCount=2000] Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000, onlyFeature = null) {
      if (!_enabled || (!_stemRecords.length && !_drawn)) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      // One record per feature (localFeatureKey), as the layer counts them.
      // A multi-part polygon or point feature is listed at its first part,
      // with every part's point in `parts`, so Nearby measures it to the
      // nearest part. Line features below give one record per feature too.
      const listed = new Map();
      for (let i = 0; i < _stemRecords.length; i++) {
        const record = _stemRecords[i];
        const key = record.part?.feature
          ? localFeatureKey(record.part.feature)
          : null;
        if (onlyFeature !== null && key !== onlyFeature) continue;
        const first = key === null ? null : listed.get(key);
        if (first) {
          first.parts.push({ lat: record.lat, lon: record.lon });
          continue;
        }
        // The cap stops new rows, but a retained feature can have later parts.
        if (result.length >= limit) continue;
        const mapped = siteRecord(
          record.part.feature,
          record.id,
          record.lat,
          record.lon,
          record.properties,
        );
        if (key !== null) {
          mapped.parts = [{ lat: record.lat, lon: record.lon }];
          listed.set(key, mapped);
        }
        result.push(mapped);
      }
      // A one-part feature needs no list of parts.
      for (const mapped of listed.values())
        if (mapped.parts.length < 2) delete mapped.parts;
      // Line features (a dam drawn as its crest line) carry no stem, so they
      // are not stem records; list each once, at the middle vertex of its
      // part with the most vertices. Keep each line for rectangle queries,
      // including the lines of a feature already represented by a stem.
      const lines = new Map();
      for (const part of _drawn?.parts?.values() || []) {
        if (part.kind !== 'line') continue;
        const key = localFeatureKey(part.feature);
        if (onlyFeature !== null && key !== onlyFeature) continue;
        const middle =
          part.coordinates[Math.floor(part.coordinates.length / 2)];
        if (!Number.isFinite(middle?.[0]) || !Number.isFinite(middle?.[1]))
          continue;
        // The feature keeps its first part's id.
        const longest = lines.get(key);
        if (longest) {
          longest.paths.push(part.contextLine);
          if (longest.size < part.coordinates.length) {
            longest.size = part.coordinates.length;
            longest.middle = middle;
          }
        } else {
          lines.set(key, {
            id: part.id,
            size: part.coordinates.length,
            feature: part.feature,
            middle,
            paths: [part.contextLine],
          });
        }
      }
      for (const [key, { id: recordId, feature, middle, paths }] of lines) {
        let record = listed.get(key);
        if (!record) {
          if (result.length >= limit) continue;
          record = siteRecord(
            feature,
            recordId,
            middle[1],
            middle[0],
            unwrapProperties(feature.properties ?? {}),
          );
          result.push(record);
        }
        Object.defineProperty(record, CONTEXT_LINES, {
          value: Object.freeze(paths),
        });
      }
      return result;
    },

    getContextRecord(key, { fromDrawnPart = false, drawnPartId = key } = {}) {
      if (!fromDrawnPart) return undefined;
      const part = _drawn?.parts.get(drawnPartId);
      // A missing raw draw ID with significant whitespace must not resolve
      // through its trimmed sibling. Canonical keys still use record lookup.
      if (!part)
        return drawnPartId !== key && !drawnPartId.startsWith('geojson:')
          ? null
          : undefined;
      const record =
        layer.getAnalystRecords(1, localFeatureKey(part.feature))[0] ?? null;
      if (
        record &&
        part.kind === 'line' &&
        recordFeature.get(record) !== part.feature
      ) {
        const selected = siteRecord(
          part.feature,
          record.id,
          record.lat,
          record.lon,
          unwrapProperties(part.feature.properties ?? {}),
        );
        if (record.parts) selected.parts = record.parts;
        Object.defineProperty(selected, CONTEXT_LINES, {
          value: record[CONTEXT_LINES],
        });
        return selected;
      }
      return record;
    },

    enable: async (viewer) => {
      if (_destroyed) return;
      _enabled = true;
      _stemGeometryDirty = true;
      _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
      _groundRetryArms = 0; // fresh give-up budget per enable-cycle
      _lastGroundSampleCapability = null;
      _activeLodIds = new Set(); // fresh globe-LOD selection per enable-cycle
      _lodGraceState = new Map();
      _lastLodBudgetLimit = 0;
      _lodComputed = false;
      _lastLodProbeMs = Number.NEGATIVE_INFINITY;
      _overlayPublisher.show();

      // 1. Build the sets
      if (!_drawn) {
        if (!_loadPromise)
          _loadPromise = (async () => {
            _loadController = new AbortController();

            // Fetch and parse JSON Lines (.geojsonl) into features. The sets
            // are committed to `_drawn` only once setup finishes: a half-built
            // one published early would make every later enable() skip this
            // block, so the layer could never clear its error or retry.
            _error = null;
            try {
              let features = _cachedFeatures;
              if (!features && loadFeatures) {
                // A caller-owned loader (the Data Library) fetches and bounds
                // its own live dataset; this layer only draws it.
                features = await loadFeatures({
                  signal: _loadController.signal,
                });
                if (_destroyed) return;
                if (!Array.isArray(features))
                  throw new Error('dataset unavailable');
                _cachedFeatures = features;
              } else if (!features) {
                const response = await fetch(url, {
                  signal: _loadController.signal,
                });
                if (_destroyed) return;
                // A 404 returns an HTML body that would otherwise die in JSON.parse
                // one line later, reported as a parse error for a missing file.
                if (!response.ok) {
                  throw new Error(`HTTP ${response.status ?? '?'}`);
                }
                const text = await response.text();
                if (_destroyed) return;
                features = parseGeojsonLines(text);
                _cachedFeatures = features;
              }

              // The loader drew its pins' symbols before it finished loading.
              await pinMaker.load(markerSymbols(features), {
                signal: _loadController?.signal,
              });
              if (_destroyed) return;
              const built = buildDrawn(viewer, features);
              try {
                registerContexts(built.records);
              } catch (error) {
                disposeSets(built.sets);
                throw error;
              }
              _count = built.count;
              _stemRecords = built.records;
              _stemGeometryDirty = true;
              // Setup finished — publish it.
              _drawn = built;
              anonymousGroups = built.anonymous.groups;
              _lastUpdate = Date.now();
            } catch (e) {
              // The dataset ships with the build, so this is a broken install,
              // not a blip — it has to reach the chip, not just the console.
              // `buildDrawn` let go of its own sets.
              if (!_destroyed) _error = localDatasetError(e);
              if (_destroyed) return;
              removeEntityContextsForLayer(id);
              _count = 0;
              _stemRecords = [];
              console.error(`Failed to load ${id}:`, e);
            }

            if (_destroyed) return;
            // 2. Install the click handler
            if (!_clickSubscription) {
              const input = inputFor(viewer);
              _clickSubscription = input.onClick((event) => {
                if (!_enabled || !_drawn) return;
                // Another layer's card or label on top takes the click: the
                // item under it neither acts nor reads as empty space.
                if (isUnderOtherCard(event)) return;
                const hit = event.drawHit;
                if (!hit || !hit.set.startsWith(`${setPrefix}:`)) return;
                const part = _drawn.parts.get(hit.id);
                if (!part) return;
                selectEntityContext(part.carrier);
                // To the surface base of the stem, or the line's start.
                flyToPart(viewer, input, part);
              });
            }
          })();
        try {
          await _loadPromise;
        } finally {
          _loadPromise = null;
          _loadController = null;
        }
      }

      if (_destroyed) return;
      if (_enabled && _count > 0 && osmDerived) showOsmCredit?.(viewer, id);
      // 3. Add an incredibly fast pre-render occluder to hide points behind the globe
      if (_enabled && !_preRenderRemover) {
        // With no renderer to run frames (a viewer with no renderer, before it has
        // loaded the adapter's factories) there is nothing to walk: the
        // build has already reported why.
        _preRenderRemover =
          findFrame(viewer)?.on('preRender', () => {
            const drawn = _drawn;
            if (!_enabled || !drawn) return;
            const now = performance.now();
            if (now - _lastVisibilityUpdate < VISIBILITY_UPDATE_MS) return;
            _lastVisibilityUpdate = now;

            const pose = cameraOf(viewer).pose();
            const cameraPos = pose?.position;
            if (!cameraPos) return;
            const query = findQuery(viewer);
            const inView = (position) => !query?.isOccluded(position);

            // --- Globe-LOD motion fallback. ---
            // `_stemGeometryDirty` is otherwise raised only by moveEnd, which a
            // tracked-entity follow, Cockpit, route flight, or continuous orbit
            // never emits. Left alone the selection stays pinned to the region
            // the camera left: the walk below hides those records one by one as
            // they pass behind the globe and admits nothing newly visible, so
            // the layer bleeds down to sparse-or-empty until motion stops.
            // Bounded: rate-limited to a probe window, and only when the camera
            // has actually travelled since the last selection.
            if (
              !_stemGeometryDirty &&
              _lodComputed &&
              _stemRecords.length > 0
            ) {
              const probe = shouldRecomputeInfraLod({
                nowMs: now,
                lastProbeMs: _lastLodProbeMs,
                movedSqM: distanceSquared(cameraPos, _lastLodCameraPos),
                cameraHeightM: pose.height,
              });
              _lastLodProbeMs = probe.lastProbeMs;
              // Re-selecting demands fresh stem geometry: a record admitted
              // mid-motion has never had its tip sized for this camera.
              if (probe.recompute) _stemGeometryDirty = true;
            }

            const visibleOverlayRecords = [];
            const refreshStemGeometry = _stemGeometryDirty;
            // What this walk changes, written once at its end.
            const moved = new Set();
            const shown = new Set();

            // A scene that cannot sample heights can never ground a record, so it
            // must never arm a retry (the arm would re-arm on every requested
            // frame, forever) and must not spend ANY per-record work trying.
            // Read once per walk, not per record.
            const canSampleGround = heightsOf(viewer).supported().surface;
            // Capability can arrive late (a renderer bound after this layer
            // started). A parked camera has no moveEnd to re-open a spent
            // budget, so the false→true edge does it.
            if (canSampleGround && _lastGroundSampleCapability === false)
              _groundRetryArms = 0;
            _lastGroundSampleCapability = canSampleGround;
            let groundRetryPending = false;
            let groundSampleProgress = false;
            const sizing = {
              pose,
              canvasHeight: canvasOf(viewer)?.clientHeight || 1080,
              ground: groundOf(viewer),
            };

            // --- Globe-LOD: recompute the active-stem set on camera moves. ---
            // `_stemGeometryDirty` is set by moveEnd, the first enable, and the
            // motion fallback above — exactly when the camera-height budget and
            // per-record distances can have changed. Without this, all local
            // infrastructure features run stem trig + set writes on every
            // move; with it, only the ~80 (global) to ~420 (regional)
            // budgeted records do.
            // The horizon test is the same cheap one used below.
            if (refreshStemGeometry && _stemRecords.length > 0) {
              const candidates = new Array(_stemRecords.length);
              for (let i = 0; i < _stemRecords.length; i++) {
                const record = _stemRecords[i];
                candidates[i] = {
                  id: record.id,
                  priority: record.priority,
                  distanceM: distance(cameraPos, record.base),
                  inView: inView(record.base),
                };
              }
              const selection = selectInfraLod(candidates, {
                cameraHeightM: pose.height,
                incumbentIds: _activeLodIds,
              });
              const grace = applyInfraEvictionGrace({
                selectedIds: selection.activeIds,
                builtIds: [..._activeLodIds],
                graceState: _lodGraceState,
                nowMs: now,
                activeLimit: selection.budget.activeLimit,
              });
              _activeLodIds = new Set(grace.keepIds);
              _lodGraceState = grace.graceState;
              _lastLodBudgetLimit = selection.budget.activeLimit;
              _lodComputed = true;
              // Adopt this pass as the motion-fallback reference. Travel is
              // measured from the last SELECTION, never the previous walk, so
              // jitter around a parked camera never accumulates into a
              // recompute while genuine slow travel eventually does.
              Object.assign(_lastLodCameraPos, copy(cameraPos));
              _lastLodProbeMs = now;
            }

            for (let i = 0; i < _stemRecords.length; i++) {
              const record = _stemRecords[i];
              const isActive = !_lodComputed || _activeLodIds.has(record.id);
              const isVisible = isActive && inView(record.base);
              if (record.visible !== isVisible) {
                record.visible = isVisible;
                shown.add(record);
              }

              // Records outside the globe-LOD active set carry no visible stem,
              // so skip every per-frame cost for them — geometry trig, the
              // ground-sample GPU readback, overlay-label candidacy. They rejoin
              // on the next camera move if the budget has room.
              if (!isActive) continue;

              const wasGroundSampled = record.groundSampled;
              const terrainFloorChanged = refreshLocalTerrainFloor(
                sizing,
                record,
              );
              if (refreshStemGeometry || terrainFloorChanged) {
                if (updateLocalStemGeometry(sizing, record, now))
                  moved.add(record);
              } else if (
                canSampleGround &&
                !record.groundSampled &&
                now - record.lastGroundSampleMs >= GROUND_SAMPLE_RETRY_MS
              ) {
                // Capability first: without it the distance below is pure waste,
                // once per ungrounded record per walk, forever.
                const away = distance(cameraPos, record.base);
                if (
                  away < GROUND_SAMPLE_MAX_DISTANCE_M &&
                  sampleLocalGroundHeight(sizing, record, now) &&
                  updateLocalStemGeometry(sizing, record, now, away)
                )
                  moved.add(record);
              }
              if (!wasGroundSampled && record.groundSampled)
                groundSampleProgress = true;
              // Still unsampled AND close enough for a retry to succeed: this
              // layer has no hold and no periodic update, so under the idle
              // governor the retry's preRender never arrives on a parked camera
              // and the stem stays at ellipsoid height (buried/floating) until
              // the user happens to move. Schedule the frame the retry needs.
              // Gated on a sampleable scene and in-range, in-view records only,
              // so a far camera (or a keyless scene) stays fully idle; the
              // distance is only computed for still-unsampled stems.
              if (
                canSampleGround &&
                !record.groundSampled &&
                !groundRetryPending &&
                distance(cameraPos, record.base) <
                  GROUND_SAMPLE_MAX_DISTANCE_M &&
                groundSampleInView(sizing, record)
              ) {
                groundRetryPending = true;
              }
              if (isVisible && record.entry) visibleOverlayRecords.push(record);
            }
            _stemGeometryDirty = false;
            writeChanges(drawn, moved, shown);
            // Tiles ARE streaming in: real progress re-opens the give-up budget
            // so the records still waiting get their own bounded run of retries.
            if (groundSampleProgress) _groundRetryArms = 0;
            if (groundRetryPending) scheduleGroundRetryRender(viewer);

            const canvas = canvasOf(viewer);
            const cohort = selectLocalInfrastructureOverlayCohort(
              visibleOverlayRecords,
              {
                maxEntries: labelMax,
                gridPx: labelGridPx,
                width: canvas?.clientWidth || canvas?.width || 0,
                height: canvas?.clientHeight || canvas?.height || 0,
                cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
                project: (record) => projectToWindow(viewer, record.tip),
              },
            );
            _overlayPublisher.publish(cohort);
          }) ?? null;
      }
      if (_enabled && !_cameraMoveEndRemover) {
        _cameraMoveEndRemover =
          findCamera(viewer)?.on('moveEnd', () => {
            if (!_enabled) return;
            _stemGeometryDirty = true;
            _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
            // Real camera motion is a fresh situation (new tiles, new distances)
            // and its frames are free, so it re-opens the retry budget that a
            // parked camera may have spent.
            _groundRetryArms = 0;
            findFrame(viewer)?.requestRender('local-geojson');
          }) ?? null;
      }

      // Honor a disable() that landed while we were awaiting the fetch/parse:
      // disable() runs before `_drawn` exists, so its release is a no-op —
      // release the finished build here instead of parking it hidden in the
      // scene (the parsed features stay cached for the next enable).
      if (!_enabled) {
        releaseDrawn();
        return;
      }
      if (_drawn) for (const set of Object.values(_drawn.sets)) set.show = true;
      findFrame(viewer)?.requestRender('local-geojson');
    },

    disable: disableLayer,

    /**
     * Forget the parsed features so the next enable() loads them again: a
     * caller-owned live loader (the Data Library) uses it once its data is
     * older than the source allows.
     */
    dropCachedFeatures: () => {
      _cachedFeatures = null;
    },

    /**
     * Draw a new feature set in place of the current one while the layer is
     * on (a live loader's refresh). The current features stay drawn until
     * the new ones are built; a selected feature stays selected when its
     * source ID or anonymous key survives. A failed rebuild keeps the
     * current features and rejects. Off, the set is only kept for
     * the next enable().
     * @param {object} viewer
     * @param {object[]} features GeoJSON features.
     */
    replaceFeatures: async (viewer, features) => {
      if (_destroyed) return;
      const previousFeatures = _cachedFeatures;
      _cachedFeatures = features;
      if (!_enabled || !_drawn || _loadPromise) return;
      const token = ++replacements;
      const outgoing = _drawn;
      // Still the replacement to make: on, not rebuilt or replaced meanwhile.
      const current = () =>
        !_destroyed &&
        _enabled &&
        _drawn === outgoing &&
        token === replacements;
      let selectedHere;
      let built;
      try {
        // The loader drew its pins' symbols before it finished loading.
        await pinMaker.load(markerSymbols(features));
        if (!current()) return;
        built = buildDrawn(viewer, features);
        // Read the active selection before the new carriers take its old ID.
        const selected = getSelectedEntityContext?.();
        selectedHere = selected?.layerId === id ? selected : null;
        registerContexts(built.records);
      } catch (error) {
        // `buildDrawn` let go of its own sets on a throw; a build whose
        // contexts failed goes here, and the current records keep theirs.
        if (built) {
          disposeSets(built.sets);
          try {
            registerContexts(outgoing.records);
          } catch {
            /* the store is gone with them */
          }
        }
        if (!current()) return;
        if (_cachedFeatures === features) _cachedFeatures = previousFeatures;
        throw new Error(localDatasetError(error));
      }

      // A record the new set still has keeps the height sampled under it.
      const previous = new Map(
        outgoing.records.map((record) => [record.id, record]),
      );
      for (const record of built.records) {
        const old = previous.get(record.id);
        if (
          !old?.groundSampled ||
          old.lon !== record.lon ||
          old.lat !== record.lat
        )
          continue;
        record.groundSampled = true;
        setLocalGroundHeight(record, old.groundHeight);
      }
      let match = null;
      const feature =
        selectedHere &&
        outgoing.parts.get(selectedHere.id?.slice(id.length + 1))?.feature;
      if (feature) {
        // Renderer IDs can be reassigned. Match the feature first, then
        // prefer to keep its previously selected part.
        const anonymous = feature.id == null;
        const key = anonymous
          ? outgoing.anonymous.keys.get(feature)
          : localFeatureKey(feature);
        const candidates =
          key == null
            ? []
            : built.records.filter(({ part }) =>
                anonymous
                  ? built.anonymous.keys.get(part.feature) === key
                  : localFeatureKey(part.feature) === key,
              );
        match =
          candidates.find(
            (record) =>
              Math.abs(record.lon - selectedHere.longitude) < 1e-6 &&
              Math.abs(record.lat - selectedHere.latitude) < 1e-6,
          ) ??
          candidates.find((record) => record.context.id === selectedHere.id) ??
          candidates[0];
      }
      _drawn = built;
      anonymousGroups = built.anonymous.groups;
      _stemRecords = built.records;
      _count = built.count;
      _lastUpdate = Date.now();
      _error = null;
      // A fresh walk for the new records: LOD, stems and labels.
      _stemGeometryDirty = true;
      _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
      _activeLodIds = new Set();
      _lodGraceState = new Map();
      _lastLodBudgetLimit = 0;
      _lodComputed = false;
      _lastLodProbeMs = Number.NEGATIVE_INFINITY;
      _groundRetryArms = 0;
      // The new set's contexts took the old ids: a selection it does not
      // have must not land on whatever now holds its id.
      if (match) selectEntityContext(match.carrier);
      else if (selectedHere)
        clearSelectedEntityContextForLayer(id, { evicted: true });
      // Records the new set no longer has go with the old sets.
      removeEntityContextsForLayer(id, {
        retainIds: new Set(built.records.map((record) => record.context.id)),
      });
      for (const set of Object.values(built.sets)) set.show = true;
      disposeSets(outgoing.sets);
      findFrame(viewer)?.requestRender('local-geojson');
    },

    destroy: (viewer) => {
      if (_destroyed) return;
      _destroyed = true;
      _loadController?.abort();
      // Defensively disable first so listeners and selection state are
      // torn down even if destroy is called while the layer is enabled.
      disableLayer(viewer);
      removeEntityContextsForLayer(id);
      _clickSubscription?.();
      _clickSubscription = null;
      _overlayPublisher.destroy();
      _cachedFeatures = null;
      anonymousGroups = undefined;
      pinMaker.clear();
      _stemRecords = [];
      _count = 0;
      _lastUpdate = null;
      _error = null;
    },
  };
  return layer;
}

/**
 * A polygon's fill, showing as its record does: on the ground, or with
 * per-position heights and outlined in the feature's colour, as the loader
 * outlined every polygon.
 */
const fillItem = (record) =>
  record.part.raised
    ? {
        id: record.id,
        geometry: {
          kind: 'polygon',
          rings: record.part.rings,
          perPositionHeight: true,
        },
        fill: record.part.fill,
        outline: record.rgba,
        // The loader's outline was an outline geometry, whose width the
        // default renderer clamps to what WebGL draws: 1 px on most
        // browsers, whatever `stroke-width` says.
        outlineWidth: 1,
        height: 'absolute',
        // The loader's entities drew a raised polygon lit by the sun.
        lit: true,
        meta: record.carrier,
        show: record.visible,
      }
    : {
        id: record.id,
        geometry: { kind: 'polygon', rings: record.part.rings },
        fill: record.part.fill,
        height: 'clampGround',
        meta: record.carrier,
        show: record.visible,
      };

/** A point's pin, in its own marker colour and size, showing as its record does. */
const pinItem = (record) => ({
  id: record.id,
  // A point with a height stands its pin on the stem's tip, as the loader's
  // billboard rode its entity's position; one without lies on the ground.
  ...(record.part.pinClamped
    ? { pos: record.part.pinPos, height: 'clampGround' }
    : { pos: copy(record.tip) }),
  image: record.part.pin,
  size: [record.part.pinSize, record.part.pinSize],
  anchor: 'bottom',
  meta: record.carrier,
  show: record.visible,
});

/** A record's stem, from its base to its tip, in the feature's colour. */
const stemItem = (record) => ({
  id: record.id,
  positions: [copy(record.base), copy(record.tip)],
  widthPx: STEM_WIDTH_PX,
  mode: '3d',
  style: { kind: 'solid', color: record.rgba },
  meta: record.carrier,
  show: record.visible,
});

/**
 * The dot on a record's tip, never depth-tested against the photoreal
 * mesh: the walk's horizon test hides it behind the globe.
 */
const dotItem = (record) => ({
  id: record.id,
  pos: copy(record.tip),
  pixelSize: 10,
  color: record.rgba,
  outlineColor: BLACK,
  outlineWidth: 2,
  disableDepthTest: Number.POSITIVE_INFINITY,
  meta: record.carrier,
  show: record.visible,
});

/**
 * What a walk asks of the ground under its records: heights now, and
 * whether the globe is shown and its terrain has finished loading.
 */
function groundOf(viewer) {
  const globe = findGlobe(viewer);
  const heights = heightsOf(viewer);
  return {
    heights,
    canSample: heights.supported().surface,
    globeShown: globe?.isGlobeVisible?.() === true,
    terrainSettled: () => globe?.isSettled('terrain') !== false,
  };
}

function compareLocalOverlayRecords(a, b) {
  return b.priority - a.priority || String(a.id).localeCompare(String(b.id));
}

function insertLocalCellContender(contenders, record) {
  let index = 0;
  while (
    index < contenders.length &&
    compareLocalOverlayRecords(contenders[index], record) <= 0
  ) {
    index++;
  }
  contenders.splice(index, 0, record);
  if (contenders.length > LOCAL_OVERLAY_CELL_SURPLUS)
    contenders.length = LOCAL_OVERLAY_CELL_SURPLUS;
}

function refreshLocalTerrainFloor(sizing, record) {
  const { ground } = sizing;
  if (!record.groundSampled || !ground.globeShown || !ground.terrainSettled())
    return false;
  if (
    distance(sizing.pose.position, record.base) >= GROUND_SAMPLE_MAX_DISTANCE_M
  )
    return false;
  // Camera motion can refine terrain after the first successful depth sample.
  // Reuse the loaded mesh on existing bounded walks; never arm a timer or do
  // another GPU readback just to maintain this floor. Keep roof elevations.
  const height = ground.heights.now(record, { against: 'terrain' });
  if (
    height === null ||
    Math.abs(height) > GROUND_SAMPLE_MAX_ABS_HEIGHT_M ||
    height <= record.groundHeight
  )
    return false;
  setLocalGroundHeight(record, height);
  return true;
}

const groundSampleLow = { x: 0, y: 0, z: 0 };
const groundSampleHigh = { x: 0, y: 0, z: 0 };

/**
 * Whether the camera can see the ground under the record: inside the view
 * frustum and above the horizon. A surface height sample reads only surface
 * rendered for the current view, so a sample of unseen ground passes through
 * the Earth (about -6,344 km near Ashburn on Esri) and fails on every 2 s
 * retry, each one a full offscreen render; 110 unseen data centres there held
 * rest frames at 58-589 ms. Unsampled bases sit on the ellipsoid, so the test
 * uses loaded globe terrain when there is some. Otherwise (a hidden globe) it
 * tests the vertical across +/-GROUND_SAMPLE_MAX_ABS_HEIGHT_M, every height a
 * sample can accept, so high or below-ellipsoid ground in view is never
 * mistaken for an unseen base. Unseen ground is sampled on the first walk that
 * sees it.
 */
function groundSampleInView(sizing, record) {
  const { ground, pose } = sizing;
  const terrain = ground.globeShown
    ? ground.heights.now(record, { against: 'terrain' })
    : null;
  const known =
    terrain !== null && Math.abs(terrain) <= GROUND_SAMPLE_MAX_ABS_HEIGHT_M;
  const low = fromDegreesInto(
    record.lon,
    record.lat,
    known ? terrain : -GROUND_SAMPLE_MAX_ABS_HEIGHT_M,
    groundSampleLow,
  );
  const high = known
    ? low
    : fromDegreesInto(
        record.lon,
        record.lat,
        GROUND_SAMPLE_MAX_ABS_HEIGHT_M,
        groundSampleHigh,
      );
  // The vertical is unseen only when both ends are outside the same plane.
  // The planes and the horizon are the walk's: one pose, read once.
  sizing.planes ??= frustumPlanes(pose);
  for (const { normal, w } of sizing.planes) {
    if (dot(normal, low) + w < 0 && dot(normal, high) + w < 0) return false;
  }
  // The horizon test hides every point below the ellipsoid from a camera
  // near it, so ground below 0 m (low-geoid coasts, the Dead Sea) is tested
  // at 0 m; unknown ground at the top of the vertical.
  const horizonHeight = known
    ? Math.max(terrain, 0)
    : GROUND_SAMPLE_MAX_ABS_HEIGHT_M;
  sizing.horizon ??= horizonFrom(pose.position);
  return sizing.horizon.isPointVisible(
    fromDegreesInto(record.lon, record.lat, horizonHeight, groundSampleHigh),
  );
}

function sampleLocalGroundHeight(sizing, record, now) {
  const { ground } = sizing;
  if (record.groundSampled || !ground.canSample) return false;
  if (now - record.lastGroundSampleMs < GROUND_SAMPLE_RETRY_MS) return false;
  if (!groundSampleInView(sizing, record)) return false;
  record.lastGroundSampleMs = now;
  if (ground.globeShown && !ground.terrainSettled()) return false;
  // A miss is tiles not ready: retry on a later bounded update. The layer's
  // own sets are not ground, so the sample sees through them.
  let sampled = ground.heights.now(record);
  if (sampled === null || Math.abs(sampled) > GROUND_SAMPLE_MAX_ABS_HEIGHT_M)
    return false;
  // A coarse scene-depth sample can lie below the terrain already loaded by
  // the visible globe. Keep that terrain as a floor while allowing roofs and
  // valid below-sea-level elevations. Photoreal scenes hide the globe, so its
  // inactive terrain must not constrain their geometry.
  const terrainHeight = ground.globeShown
    ? ground.heights.now(record, { against: 'terrain' })
    : null;
  if (
    terrainHeight !== null &&
    Math.abs(terrainHeight) <= GROUND_SAMPLE_MAX_ABS_HEIGHT_M
  ) {
    sampled = Math.max(sampled, terrainHeight);
  }
  record.groundSampled = true;
  setLocalGroundHeight(record, sampled);
  return true;
}

function setLocalGroundHeight(record, height) {
  record.groundHeight = height;
  fromDegreesInto(record.lon, record.lat, record.groundHeight, record.base);
}

/**
 * Size a record's stem to the camera: its tip stands where the stem spans
 * about 65 px on screen. False when the tip moved less than the epsilon,
 * which leaves it where it was.
 */
function updateLocalStemGeometry(sizing, record, now, knownDistance = null) {
  const away = Number.isFinite(knownDistance)
    ? knownDistance
    : distance(sizing.pose.position, record.base);
  if (away < GROUND_SAMPLE_MAX_DISTANCE_M)
    sampleLocalGroundHeight(sizing, record, now);
  // Keep the intended screen-size scaling in close-up views too. A 5 km
  // minimum made a marker hundreds of metres tall beside a nearby building.
  const effectiveDistance = Math.max(away, 1);
  const fov = wideFov(sizing.pose);
  const targetPx = 65;
  const fovFactor = 2 * Math.tan(fov / 2) * (targetPx / sizing.canvasHeight);
  const tipHeight = record.groundHeight + effectiveDistance * fovFactor;
  fromDegreesInto(record.lon, record.lat, tipHeight, record.nextTip);
  // A base that moved moves the stem, whatever its tip does.
  const baseMoved = record.drawnBaseHeight !== record.groundHeight;
  if (
    !baseMoved &&
    distanceSquared(record.tip, record.nextTip) <= LOCAL_STEM_TIP_EPSILON_SQ
  ) {
    return false;
  }
  record.drawnBaseHeight = record.groundHeight;
  Object.assign(record.tip, record.nextTip);
  return true;
}

function featureLabelFromProperties(props, layerId) {
  const tags = props.tags || {};

  const candidates = [
    props.name,
    tags.name,
    tags['name:en'],
    tags.official_name,
    tags.operator,
    tags['operator:short'],
    props.operator,
    props.output ? `${layerTitle(layerId)} ${props.output}` : '',
    props.osm_id ? `${layerTitle(layerId)} ${props.osm_id}` : '',
  ];

  const text = candidates.map(cleanLabel).find(Boolean);
  return clampLabel(text || layerTitle(layerId));
}

function labelPriorityFromProperties(props, layerId) {
  const tags = props.tags || {};

  let score = 0;
  if (cleanLabel(props.name) || cleanLabel(tags.name)) score += 1000;
  if (cleanLabel(tags['name:en'])) score += 700;
  if (cleanLabel(tags.operator) || cleanLabel(props.operator)) score += 180;
  if (props.output || tags['plant:output:electricity']) score += 120;
  if (layerId === 'local-dams') score += 80;
  if (layerId === 'local-datacenters') score += 60;
  // Data Library features carry their manifest importance (0–600), below the
  // named/unnamed gap so a rank never promotes an unnamed feature.
  if (Number.isFinite(props.__gevRank))
    score += Math.max(0, Math.min(600, props.__gevRank));
  return score;
}

function unwrapProperties(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(unwrapProperties);
  // Keep feed keys, including "__proto__", as own data properties.
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry && typeof entry.getValue === 'function'
        ? unwrapProperties(entry.getValue())
        : unwrapProperties(entry),
    ]),
  );
}

function cleanLabel(value) {
  const text = String(value || '').trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  return text;
}

function firstClean(values) {
  return values.map(cleanLabel).find(Boolean) || '';
}

function clampLabel(value) {
  const text = cleanLabel(value);
  return text.length > 34 ? `${text.slice(0, 31)}...` : text;
}

function clampCardLine(value) {
  const text = cleanLabel(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

export { mapAnalystRecord };
