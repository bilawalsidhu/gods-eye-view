import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import {
  GLIDER_CLASSES,
  gliderClassLegend,
  gliderClassOf,
} from './gliderClass.js';

/**
 * @module gliders
 * @description Live FLARM/OGN-tracker traffic from the Open Glider Network,
 * scoped to just sailplanes and crewed balloons — traffic that mostly carries
 * no ADS-B transponder, so neither OpenSky nor adsb.lol ever see it.
 * Structured after ./earthquakes.js: a flat point layer, camera-anchored like
 * ./flights.js since the OGN feed requires a lat/lon bounding box.
 *
 * Which OGN types are surfaced, and the color each draws in, live in
 * ./gliderClass.js — one table behind the filter, the points and the row
 * legend. Everything else OGN reports — paragliders, hang gliders, tow
 * planes, helicopters, drones, the ADS-B/Mode-S traffic OGN receivers relay
 * under the generic 'plane'/'jet' codes (already owned by ./flights.js), and
 * the static ground beacons filed under 'unknown' — is deliberately dropped;
 * see the OGN_TYPE_CLASS doc comment in that module for the full breakdown.
 */

const API_URL = '/api/ogn/gliders';
const LAYER_ID = 'gliders';
/** Cesium entity id prefix; also the pick-ownership namespace other layers check against. */
const ENTITY_ID_PREFIX = 'glider:';

export const GLIDER_OVERLAY_SOURCE_ID = 'gliders';
export const GLIDER_OVERLAY_COHORT_LIMIT = 80;
export const GLIDER_OVERLAY_COLLISION_CAPACITY = 40;

/** Overlay source for the single click-selected detail card (see createGliderSelectedOverlayEntry). */
export const GLIDER_SELECTED_OVERLAY_SOURCE_ID = 'gliders-selected';
export const GLIDER_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  // The selected contact keeps moving while its card is up (unlike a bikeshare
  // dock), so the card needs the same per-frame reprojection the ambient
  // labels get.
  moving: true,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Class key → Cesium point color, converted once at module load from the CSS
 * hex strings in gliderClass.js. That module owns the palette so the legend
 * swatch on the layer row and the point in the scene are painted from one
 * string and can never drift apart.
 */
const CLASS_COLORS = Object.freeze(Object.fromEntries(
  Object.entries(GLIDER_CLASSES)
    .map(([klass, spec]) => [klass, Cesium.Color.fromCssColorString(spec.color)]),
));

/** Camera subpoint in degrees, or null. Mirrors flights.js `_viewerAnchorDeg`. */
function viewerAnchorDeg(viewer) {
  const cartographic = viewer?.camera?.positionCartographic;
  if (!cartographic) return null;
  const latitude = Cesium.Math.toDegrees(cartographic.latitude);
  const longitude = Cesium.Math.toDegrees(cartographic.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function apiUrl(anchor) {
  if (!anchor) return null;
  const params = new URLSearchParams({
    lat: anchor.latitude.toFixed(4),
    lon: anchor.longitude.toFixed(4),
  });
  return `${API_URL}?${params}`;
}

/**
 * Validate one entry of the PROXY's already-normalized `aircraft` array (see
 * ognFallback.js `normalizeOgnMarker` — the server ran this once already).
 * Re-checks only the fields this renderer indexes by, deliberately not a
 * second full re-normalization (see weatherBalloons.js for why that would be
 * actively wrong, not just redundant, against an already-flat shape).
 *
 * Also enforces the gliderClass.js taxonomy as a FILTER, not just a paint
 * table: `lxml.php` mixes real FLARM/OGN-tracker contacts with plain
 * ADS-B/Mode-S targets an OGN ground station happened to also receive,
 * tagged generically as OGN ftype 8 ('plane') or 9 ('jet') — traffic that
 * already has a transponder and is already rendered by flights.js. Left
 * unfiltered, those (plus stray 'ufo'/'airship'/'parachute'/'drop-plane'
 * codes) flooded this "Gliders & Paragliders" layer with ordinary,
 * already-tracked-elsewhere airplanes, wildly inflating the active-glider
 * count. `gliderClassOf` returns null for exactly those types.
 */
function isUsableGlider(entry) {
  return Boolean(entry)
    && typeof entry.id === 'string' && entry.id.length > 0
    && Number.isFinite(entry.lat) && Number.isFinite(entry.lon)
    && gliderClassOf(entry.typeLabel) !== null;
}

/** Build the source-owned overlay label for one OGN contact. */
export function createGliderOverlayEntry({ id, position, label, accent, priority }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: label,
    accent,
    priority,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Feet-and-knots to match flights.js/militaryFlights.js's aviation display convention. */
function formatGliderAltitude(altitudeM) {
  return Number.isFinite(altitudeM)
    ? `${Math.round(altitudeM * 3.28084).toLocaleString('en-US')} ft`
    : 'alt unknown';
}

function formatGliderSpeed(speedMps) {
  return Number.isFinite(speedMps) ? `${Math.round(speedMps * 1.944)} kt` : '';
}

/** Vario reading in the unit soaring pilots actually use — OGN's own m/s, signed. */
function formatGliderClimb(climbMps) {
  if (!Number.isFinite(climbMps)) return '';
  return `${climbMps > 0 ? '+' : ''}${climbMps.toFixed(1)} m/s`;
}

function formatGliderHeading(headingDeg) {
  return Number.isFinite(headingDeg) ? `${Math.round(headingDeg)}°` : '';
}

/** "3s ago" / "4m ago" — OGN's own ageSeconds, no wall-clock math needed. */
function formatGliderAge(ageSeconds) {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'age unknown';
  return ageSeconds < 60 ? `${Math.round(ageSeconds)}s ago` : `${Math.round(ageSeconds / 60)}m ago`;
}

/**
 * Build the click-selection detail card's text, [title, ...detail lines] —
 * same shape as bikeshare.js `buildSelectionLabel`. `klass` is passed in
 * rather than re-derived so a caller that already resolved it (the render
 * loop) and a caller that has not (a stale/reselected contact) read the same
 * label either way.
 * @param {object} contact One proxy-normalized OGN contact.
 * @param {string} klass Resolved gliderClass.js key ('glider' or 'balloon').
 * @returns {string[]} [title, ...details].
 */
function buildGliderSelectionLines(contact, klass) {
  const title = contact.registration || contact.callsign || GLIDER_CLASSES[klass].label;
  const lines = [
    title,
    `${GLIDER_CLASSES[klass].label} · ${formatGliderAltitude(contact.altitudeM)}`,
  ];
  const motion = [
    formatGliderSpeed(contact.speedMps),
    formatGliderClimb(contact.climbMps),
    formatGliderHeading(contact.headingDeg),
  ].filter(Boolean).join(' · ');
  if (motion) lines.push(motion);
  const tail = [
    formatGliderAge(contact.ageSeconds),
    contact.receiver ? `via ${contact.receiver}` : '',
  ].filter(Boolean).join(' · ');
  if (tail) lines.push(tail);
  return lines;
}

/**
 * Build the protected click-selection detail card for one contact — the
 * "why is there no information when I click on them" fix. Structured after
 * bikeshare.js `createBikeshareSelectedOverlayEntry`: a single always-shown
 * card in its own overlay source, distinct from the ambient ID labels this
 * layer already draws (which are `interactive: false` by design).
 * @param {object} contact One proxy-normalized OGN contact (must carry `id`).
 * @param {Cesium.Cartesian3} position World position for the card anchor.
 * @returns {object|null} Overlay entry, or null when the contact is unusable.
 */
export function createGliderSelectedOverlayEntry(contact, position) {
  if (!contact?.id || !position) return null;
  const klass = gliderClassOf(contact.typeLabel) || 'glider';
  const [title, ...details] = buildGliderSelectionLines(contact, klass);
  return {
    id: `glider-selected:${contact.id}`,
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: GLIDER_CLASSES[klass].color,
    interactive: false,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/** Keep the highest-altitude contacts, stable tie-break — matches the balloon/earthquake cohort convention. */
export function selectGliderOverlayCohort(entries, limit = GLIDER_OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(0, Math.min(
    GLIDER_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

export function createGlidersLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  screenSpaceEventHandlerFactory = (viewer) => new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  let _dataSource = null;
  let _viewer = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** Class key → count from the most recent poll; drives the row legend. */
  let _classTally = Object.create(null);
  /** contact.id → raw contact from the most recent poll; the click handler's lookup table. */
  let _contactById = new Map();
  /** contact.id of the click-selected contact, or null. */
  let _selectedId = null;
  let _clickHandler = null;

  /** Publish (or refresh) the detail card for one contact without changing `_selectedId`. */
  function publishSelectedCard(contact) {
    const position = Cesium.Cartesian3.fromDegrees(
      contact.lon,
      contact.lat,
      Math.max(0, contact.altitudeM ?? 0),
    );
    const entry = createGliderSelectedOverlayEntry(contact, position);
    overlayHost.setEntries(
      GLIDER_SELECTED_OVERLAY_SOURCE_ID,
      entry ? [entry] : [],
      GLIDER_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function clearSelection() {
    if (!_selectedId) return;
    _selectedId = null;
    overlayHost.clearSource(GLIDER_SELECTED_OVERLAY_SOURCE_ID);
  }

  /**
   * Select a contact by its OGN id, publishing its detail card.
   * @param {string} contactId Raw OGN contact id (no `glider:` prefix).
   * @returns {boolean} True when the contact was found and selected.
   */
  function selectContactById(contactId) {
    const contact = _contactById.get(contactId);
    if (!contact) return false;
    _selectedId = contactId;
    publishSelectedCard(contact);
    return true;
  }

  /**
   * Install the LEFT_CLICK handler for contact selection (enable-time only,
   * mirroring firmsHeatmap.js/bikeshare.js): clicking a glider or balloon
   * shows its detail card; clicking empty space clears it. A pick that
   * belongs to a sibling layer is left alone rather than treated as "empty
   * space" and clearing our selection out from under it.
   */
  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      const picked = _viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      if (typeof pickedId === 'string' && pickedId.startsWith(ENTITY_ID_PREFIX)) {
        if (selectContactById(pickedId.slice(ENTITY_ID_PREFIX.length))) return;
      }
      if (pickedId && isOwnedByOtherLayer(LAYER_ID, pickedId)) return;
      clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  const layer = {
    id: LAYER_ID,
    name: 'Gliders & Balloons',
    icon: '🪂',
    source: 'Open Glider Network',
    updateInterval: 30000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('gliders');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _classTally = Object.create(null);
      _contactById = new Map();
      _selectedId = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(GLIDER_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Gliders] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(GLIDER_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      registerPickOwner(LAYER_ID, (pickedId) => (
        typeof pickedId === 'string' && pickedId.startsWith(ENTITY_ID_PREFIX)
      ));
    },

    disable(viewer) {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      // Drop the tally with the points it described, so a re-enable cannot
      // flash the previous location's legend before the first poll lands.
      _classTally = Object.create(null);
      overlayHost.clearSource(GLIDER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GLIDER_OVERLAY_SOURCE_ID, false);
      clearSelection();
      removeClickHandler();
      unregisterPickOwner(LAYER_ID);
    },

    async update(viewer, { signal = null } = {}) {
      const anchor = viewerAnchorDeg(viewer || _viewer);
      const url = apiUrl(anchor);
      if (!url) {
        _lastError = 'No camera position yet';
        return false;
      }
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          _lastError = `OGN proxy HTTP ${response.status}`;
          console.warn(`[Data:Gliders] API returned ${response.status}`);
          return false;
        }
        const data = await response.json();
        signal?.throwIfAborted();
        if (!data || !Array.isArray(data.aircraft)) {
          _lastError = 'Malformed glider response';
          return false;
        }

        _dataSource.entities.removeAll();
        const overlayEntries = [];
        const tally = Object.create(null);
        const nextContactById = new Map();
        let count = 0;
        // OGN's own id fields are NOT centrally guaranteed unique the way
        // USGS earthquake ids are (verified 2026-09-01: a raw sentinel bug
        // once collapsed hundreds of contacts to one id — see ognFallback.js)
        // — a resilient fallback here, not just a fixed root cause, since
        // Cesium's `entities.add` THROWS and would kill the rest of this
        // poll's batch on any future id the normalizer didn't anticipate.
        const seenIds = new Set();

        for (const contact of data.aircraft) {
          if (!isUsableGlider(contact) || seenIds.has(contact.id)) continue;
          seenIds.add(contact.id);
          count += 1;
          // isUsableGlider already rejected every unsurfaced type, so this
          // always resolves to 'glider' or 'balloon' — never null.
          const klass = gliderClassOf(contact.typeLabel);
          tally[klass] = (tally[klass] || 0) + 1;
          nextContactById.set(contact.id, contact);
          const color = CLASS_COLORS[klass];
          const position = Cesium.Cartesian3.fromDegrees(
            contact.lon,
            contact.lat,
            Math.max(0, contact.altitudeM ?? 0),
          );
          _dataSource.entities.add({
            id: `glider:${contact.id}`,
            position,
            point: {
              pixelSize: 6,
              color,
              outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: {
              id: contact.id,
              callsign: contact.callsign,
              registration: contact.registration,
              altitudeM: contact.altitudeM,
              climbMps: contact.climbMps,
              speedMps: contact.speedMps,
              headingDeg: contact.headingDeg,
              typeCode: contact.typeCode,
              typeLabel: contact.typeLabel,
              receiver: contact.receiver,
              ageSeconds: contact.ageSeconds,
            },
          });
          const label = contact.registration || contact.callsign || contact.typeLabel;
          overlayEntries.push(createGliderOverlayEntry({
            id: contact.id,
            position,
            label,
            accent: GLIDER_CLASSES[klass].color,
            priority: Number.isFinite(contact.altitudeM) ? Math.round(contact.altitudeM) : 0,
          }));
        }

        _contactById = nextContactById;

        if (_enabled) {
          overlayHost.setEntries(
            GLIDER_OVERLAY_SOURCE_ID,
            selectGliderOverlayCohort(overlayEntries),
            {
              cohortLimit: GLIDER_OVERLAY_COHORT_LIMIT,
              collisionCapacity: GLIDER_OVERLAY_COLLISION_CAPACITY,
              moving: true,
            },
          );
          // The selected contact keeps flying between polls; re-anchor its
          // card to the fresh position rather than leaving it behind, and
          // drop the card the moment the contact ages out of the feed rather
          // than freezing it at a last-known position that reads as live.
          if (_selectedId) {
            const stillPresent = _contactById.get(_selectedId);
            if (stillPresent) publishSelectedCard(stillPresent);
            else clearSelection();
          }
        }

        _count = count;
        _classTally = tally;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Gliders] Updated: ${_count} contacts`);
        return true;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.warn('[Data:Gliders] Fetch error:', error);
        _lastError = 'OGN network error';
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(GLIDER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GLIDER_OVERLAY_SOURCE_ID, false);
      clearSelection();
      removeClickHandler();
      unregisterPickOwner(LAYER_ID);
      if (_dataSource) {
        (viewer || _viewer)?.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _count = 0;
      _classTally = Object.create(null);
      _contactById = new Map();
      _selectedId = null;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Layer-row sub-controls (DataLayerManager row-controls contract): a color
     * legend, so the point colors are learnable without a new panel.
     *
     * No chips — this layer has no modes. The legend lists only the classes the
     * last poll actually returned, and the manager repaints the row after every
     * update, so no `setRowControlsListener` is needed here: unlike the
     * satellite catalog, nothing about this tally settles outside the poll.
     * @returns {{ chips: Array<object>, legend: Array<object> }} Row controls.
     */
    getRowControls() {
      return { chips: [], legend: gliderClassLegend(_classTally) };
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}

const glidersLayer = createGlidersLayer();

export default glidersLayer;
