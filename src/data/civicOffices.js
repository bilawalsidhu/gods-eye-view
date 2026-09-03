import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * @file Civic Offices — police stations, town halls and government offices for
 * the current viewport, from OpenStreetMap via the app's Overpass proxy.
 *
 * WHAT THIS LAYER IS NOT. OpenStreetMap is community-mapped, so this is a map
 * of what has been mapped, never a register of what exists. The distinction is
 * load-bearing here in a way it is not for aircraft or earthquakes: a civic
 * office that is absent from OSM looks exactly like a district with no office,
 * and a reader who takes the layer for a directory will read the gap as a fact
 * about the world rather than about the data.
 *
 * So the layer states its own limits from measurements it actually has, rather
 * than from a disclaimer:
 *
 *   - Overpass answers `out count` alongside the features, so the row can say
 *     "400 of 437 in view" instead of implying 400 is all of them.
 *   - Every Overpass response carries `osm3s.timestamp_osm_base`, the snapshot
 *     date of the mirror that answered. Mirrors lag, sometimes by months, and
 *     the row shows the date it got rather than today's.
 *   - Nothing is cached across viewports and no total is accumulated: the
 *     numbers describe the current view and say so.
 *
 * Administrative structures also change faster than OSM absorbs them. Vietnam's
 * 2025 two-tier reform is the case that prompted this layer: OSM currently
 * holds 5,393 commune-level boundary relations for the country, matching
 * neither the ~10,035 that existed before the merger nor the ~3,321 after it.
 * That is a mid-transition snapshot, and it is exactly why the layer reports a
 * date and a view count instead of a total.
 *
 * @module data/civicOffices
 */

const LAYER_ID = 'civic-offices';
/** Proxy endpoint — mirror rotation, sanitising and caching live server-side. */
const OVERPASS_URL = '/api/overpass';
/** Let the camera settle before spending a request on where it landed. */
const REQUEST_DEBOUNCE_MS = 500;
/**
 * Widest viewport that gets a request. Civic offices are dense — a 0.1° box
 * over Hanoi holds 437 — so a continental view would ask for a set nobody can
 * read and no cap can make meaningful. Above this the layer says so instead.
 */
const MAX_VIEWPORT_DEGREES = 2;
/** Server-side cap. `out count` still reports the full total behind it. */
const MAX_RENDERED = 400;
/** Past this the name is unreadable anyway; the dot still carries the position. */
const OVERLAY_MAX_DISTANCE_M = 40000;

/** OSM tag → the class this layer draws, in the order Overpass is asked. */
const CLASSES = Object.freeze([
  { id: 'police', selector: '["amenity"="police"]', label: 'Police', color: '#5aa9ff' },
  { id: 'townhall', selector: '["amenity"="townhall"]', label: 'Town hall', color: '#d9a85d' },
  { id: 'government', selector: '["office"="government"]', label: 'Government office', color: '#9ca6b0' },
]);

const state = {
  viewer: null,
  dataSource: null,
  moveEndRemove: null,
  timer: null,
  abort: null,
  enabled: false,
  loading: false,
  error: null,
  rendered: 0,
  inViewTotal: 0,
  dataDate: null,
  outOfRange: false,
  lastUpdate: null,
};

/**
 * Which class a feature belongs to, resolved in the order the classes are
 * declared. A building tagged both `amenity=police` and `office=government`
 * is a police station; the more specific tag wins by position, not by luck.
 * @param {object} tags - OSM tags.
 * @returns {?object} The matching class descriptor, or null.
 */
export function classifyCivicOffice(tags) {
  if (!tags) return null;
  if (tags.amenity === 'police') return CLASSES[0];
  if (tags.amenity === 'townhall') return CLASSES[1];
  if (tags.office === 'government') return CLASSES[2];
  return null;
}

/**
 * One name for the world overlay.
 *
 * Names go through the overlay rather than a Cesium entity `label`, which is
 * what this layer reached for first and what rendered nothing: no layer in this
 * app uses entity labels, `infoBox` is off, and every piece of on-globe text is
 * placed by the overlay's collision arbiter. A label outside it has nothing
 * keeping it off its neighbours.
 * @param {{id: string, position: Cesium.Cartesian3, name: string, classLabel: string, color: string}} office
 * @returns {object} A world-overlay entry.
 */
export function createCivicOfficeOverlayEntry({ id, position, name, classLabel, color }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: name,
    details: [classLabel],
    accent: color,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
    // Names are readable at neighbourhood range; past that the dots carry the
    // distribution and the arbiter is left free for layers that need it.
    maxDistance: OVERLAY_MAX_DISTANCE_M,
  };
}

/**
 * Overpass QL for one viewport.
 *
 * Two `out` statements read the same result set: `out count` for the honest
 * total and `out center` for what is drawn. Ways and relations are asked for
 * with `center` because an office is a point on this map whether it was mapped
 * as a node or as a building outline.
 * @param {{south: number, west: number, north: number, east: number}} bounds
 * @returns {string}
 */
export function civicOfficesQuery(bounds) {
  const box = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const selectors = CLASSES.map((entry) => `nwr${entry.selector}(${box});`).join('');
  return `[out:json][timeout:40];(${selectors});out count;out center tags ${MAX_RENDERED};`;
}

/**
 * Split an Overpass response into the count element and the drawable features.
 *
 * The count is what makes the row honest, so a response without one reports
 * `total: null` rather than quietly reusing the rendered length — that would
 * turn "we do not know how many there are" into "this is how many there are".
 * @param {object} payload - Parsed Overpass JSON.
 * @returns {{features: object[], total: ?number, dataDate: ?string}}
 */
export function readCivicOfficesPayload(payload) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  const countElement = elements.find((element) => element?.type === 'count');
  const parsedTotal = Number(countElement?.tags?.total);
  const features = [];

  for (const element of elements) {
    if (element?.type === 'count') continue;
    const lat = element?.lat ?? element?.center?.lat;
    const lon = element?.lon ?? element?.center?.lon;
    const classification = classifyCivicOffice(element?.tags);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !classification) continue;
    features.push({
      id: `${element.type}/${element.id}`,
      lat,
      lon,
      name: element.tags.name || element.tags['name:en'] || classification.label,
      classId: classification.id,
      color: classification.color,
      classLabel: classification.label,
    });
  }

  return {
    features,
    total: Number.isFinite(parsedTotal) ? parsedTotal : null,
    // The snapshot date of whichever mirror answered, not the date of the request.
    dataDate: typeof payload?.osm3s?.timestamp_osm_base === 'string'
      ? payload.osm3s.timestamp_osm_base.slice(0, 10)
      : null,
  };
}

/**
 * The line shown under the layer name. It reports the view, never the world.
 *
 * "in view" is the whole claim: no total is accumulated across viewports and
 * none is implied. When the response carried a count larger than what was
 * drawn, both numbers are shown, because a silently truncated list reads as a
 * complete one.
 * @param {{rendered: number, total: ?number, dataDate: ?string, outOfRange: boolean}} status
 * @returns {string}
 */
export function civicOfficesLabel({ rendered, total, dataDate, outOfRange }) {
  if (outOfRange) return 'zoom in to load — too wide to map';
  const counted = Number.isFinite(total) && total > rendered
    ? `${rendered} of ${total} in view`
    : `${rendered} in view`;
  const mapped = dataDate ? ` · mapped to ${dataDate}` : '';
  return `${counted}${mapped}`;
}

/** Current camera rectangle, or null when the globe edge makes it unreadable. */
function viewportBounds(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle?.(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;
  return {
    south: Cesium.Math.toDegrees(rectangle.south),
    west: Cesium.Math.toDegrees(rectangle.west),
    north: Cesium.Math.toDegrees(rectangle.north),
    east: Cesium.Math.toDegrees(rectangle.east),
  };
}

/** True when the rectangle is wider than this layer will ask Overpass for. */
export function boundsTooWide(bounds, maxDegrees = MAX_VIEWPORT_DEGREES) {
  if (!bounds) return true;
  return Math.abs(bounds.north - bounds.south) > maxDegrees
    || Math.abs(bounds.east - bounds.west) > maxDegrees;
}

function clearRendered() {
  state.dataSource?.entities.removeAll();
  clearOverlaySource(LAYER_ID);
  state.rendered = 0;
}

function render(features) {
  const entities = state.dataSource.entities;
  entities.removeAll();
  entities.suspendEvents();
  const overlayEntries = [];
  for (const feature of features) {
    const position = Cesium.Cartesian3.fromDegrees(feature.lon, feature.lat);
    entities.add({
      id: `${LAYER_ID}:${feature.id}`,
      position,
      point: {
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString(feature.color),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      description: `${feature.classLabel} · OpenStreetMap`,
    });
    overlayEntries.push(createCivicOfficeOverlayEntry({
      id: `${LAYER_ID}:${feature.id}`,
      position,
      name: feature.name,
      classLabel: feature.classLabel,
      color: feature.color,
    }));
  }
  entities.resumeEvents();
  setOverlayEntries(LAYER_ID, overlayEntries);
  setOverlaySourceVisible(LAYER_ID, true);
  state.rendered = features.length;
}

async function loadCivicOffices() {
  if (!state.enabled || !state.viewer) return;
  const bounds = viewportBounds(state.viewer);

  if (boundsTooWide(bounds)) {
    // Not an error: the camera is simply somewhere this layer cannot answer
    // for. Clear what was drawn so a stale city's offices do not float over a
    // continent as if they were the continent's.
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    state.outOfRange = true;
    state.error = null;
    state.inViewTotal = 0;
    state.dataDate = null;
    clearRendered();
    return;
  }

  state.abort?.abort();
  const abort = new AbortController();
  state.abort = abort;
  state.loading = true;
  state.outOfRange = false;

  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(civicOfficesQuery(bounds))}`,
      signal: abort.signal,
    });
    if (!response.ok) throw new Error(`Overpass ${response.status}`);
    const parsed = readCivicOfficesPayload(await response.json());
    if (abort.signal.aborted) return;

    render(parsed.features);
    state.inViewTotal = parsed.total;
    state.dataDate = parsed.dataDate;
    state.error = null;
    state.lastUpdate = Date.now();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    state.error = error?.message || 'Overpass unavailable';
  } finally {
    // An older aborted request must not clear a newer request's busy state.
    if (state.abort === abort) {
      state.abort = null;
      state.loading = false;
    }
  }
}

function scheduleLoad() {
  if (!state.enabled) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { loadCivicOffices(); }, REQUEST_DEBOUNCE_MS);
}

const civicOfficesLayer = {
  id: LAYER_ID,
  name: 'Civic Offices',
  icon: '🏛',
  source: 'OpenStreetMap',
  updateInterval: 0,
  statsRefreshInterval: 1000,

  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource(LAYER_ID);
    viewer.dataSources.add(state.dataSource);
    state.dataSource.show = false;
    state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
  },

  enable() {
    state.enabled = true;
    if (state.dataSource) state.dataSource.show = true;
    setOverlaySourceVisible(LAYER_ID, true);
    // The manager calls update() straight after enable(), which owns the first
    // fetch; a second one here would only race it.
  },

  disable() {
    state.enabled = false;
    clearTimeout(state.timer);
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    if (state.dataSource) state.dataSource.show = false;
    setOverlaySourceVisible(LAYER_ID, false);
  },

  update() { return loadCivicOffices(); },

  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.moveEndRemove = null;
    clearRendered();
    if (state.dataSource) viewer?.dataSources?.remove(state.dataSource, true);
    state.dataSource = null;
    state.viewer = null;
  },

  getStats() {
    return {
      count: state.rendered,
      lastUpdate: state.lastUpdate,
      loading: state.loading,
      error: state.error,
      // Both numbers reach the row, so the claim it makes stays checkable.
      inViewTotal: state.inViewTotal,
      dataDate: state.dataDate,
      outOfRange: state.outOfRange,
      // Rendered under the layer name in the settled state. It says what was
      // counted in this view and how old the answering mirror's data is — it
      // must never read as a count of what exists.
      loadingLabel: state.loading ? 'querying OpenStreetMap...' : civicOfficesLabel({
        rendered: state.rendered,
        total: state.inViewTotal,
        dataDate: state.dataDate,
        outOfRange: state.outOfRange,
      }),
    };
  },
};

export default civicOfficesLayer;
