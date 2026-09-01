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

/**
 * @module weatherBalloons
 * @description Live radiosonde (weather balloon) telemetry from SondeHub — a
 * volunteer-receiver network for meteorological balloons, the same coverage
 * model adsb.lol uses for aircraft. Structured after ./earthquakes.js: a
 * flat point layer, no LOD/activation-altitude gating, camera-anchored like
 * ./flights.js since SondeHub's endpoint requires a lat/lon/radius query.
 */

const API_URL = '/api/sondehub/balloons';
const LAYER_ID = 'weather-balloons';
/** Cesium entity id prefix; also the pick-ownership namespace other layers check against. */
const ENTITY_ID_PREFIX = 'balloon:';

export const BALLOON_OVERLAY_SOURCE_ID = 'weather-balloons';
export const BALLOON_OVERLAY_COHORT_LIMIT = 60;
export const BALLOON_OVERLAY_COLLISION_CAPACITY = 30;

/** Overlay source for the single click-selected detail card (see createBalloonSelectedOverlayEntry). */
export const BALLOON_SELECTED_OVERLAY_SOURCE_ID = 'weather-balloons-selected';
export const BALLOON_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  // The selected sonde keeps ascending/descending while its card is up, so
  // the card needs the same per-frame reprojection the ambient labels get.
  moving: true,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

const ASCENDING_COLOR = Cesium.Color.fromCssColorString('#5ec8ff');
const DESCENDING_COLOR = Cesium.Color.fromCssColorString('#ff9f45');
const UNKNOWN_COLOR = Cesium.Color.fromCssColorString('#c9c9c9');

function phaseColor(phase) {
  if (phase === 'ascending') return ASCENDING_COLOR;
  if (phase === 'descending') return DESCENDING_COLOR;
  return UNKNOWN_COLOR;
}

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
 * Validate one entry of the PROXY's already-normalized `balloons` array
 * (see sondehubFallback.js `normalizeSondehubBalloon` — the server ran this
 * once already, so the shape here is flat: {serial, lat, lon, altitudeM,
 * verticalRateMps, phase, ...}, NOT SondeHub's raw {alt, vel_v, ...} shape).
 * A second full re-normalization at this layer would look for the WRONG
 * field names and silently null every numeric field, so this only re-checks
 * that the two fields this renderer actually indexes by are still sane.
 */
function isUsableBalloon(entry) {
  return Boolean(entry)
    && typeof entry.serial === 'string' && entry.serial.length > 0
    && Number.isFinite(entry.lat) && Number.isFinite(entry.lon);
}

/** Build the source-owned overlay label for one balloon. */
export function createBalloonOverlayEntry({ id, position, serial, altitudeM, accent }) {
  const altKm = Number.isFinite(altitudeM) ? (altitudeM / 1000).toFixed(1) : '?';
  return {
    id: String(id),
    position,
    variant: 'label',
    title: `${serial} · ${altKm}km`,
    accent,
    priority: Number.isFinite(altitudeM) ? Math.round(altitudeM) : 0,
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

const PHASE_LABELS = Object.freeze({
  ascending: 'ASCENDING',
  descending: 'DESCENDING',
  unknown: 'PHASE UNKNOWN',
});

/** Feet, to match flights.js/gliders.js's aviation display convention. */
function formatBalloonAltitude(altitudeM) {
  return Number.isFinite(altitudeM)
    ? `${Math.round(altitudeM * 3.28084).toLocaleString('en-US')} ft`
    : 'alt unknown';
}

function formatBalloonSpeed(speedMps) {
  return Number.isFinite(speedMps) ? `${Math.round(speedMps * 1.944)} kt` : '';
}

/** Signed m/s — SondeHub's own unit; the sign is what tells ascent from descent. */
function formatBalloonVerticalRate(verticalRateMps) {
  if (!Number.isFinite(verticalRateMps)) return '';
  return `${verticalRateMps > 0 ? '+' : ''}${verticalRateMps.toFixed(1)} m/s`;
}

function formatBalloonHeading(headingDeg) {
  return Number.isFinite(headingDeg) ? `${Math.round(headingDeg)}°` : '';
}

function formatBalloonTemp(tempC) {
  return Number.isFinite(tempC) ? `${tempC.toFixed(1)}°C` : '';
}

/** "3s ago" / "4m ago" / "2h ago", derived from SondeHub's own report timestamp. */
function formatBalloonAge(timeMs) {
  if (!Number.isFinite(timeMs)) return 'age unknown';
  const ageSeconds = (Date.now() - timeMs) / 1000;
  if (ageSeconds < 0) return 'age unknown';
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  return `${Math.round(ageSeconds / 3600)}h ago`;
}

/**
 * Build the click-selection detail card's text, [title, ...detail lines] —
 * same shape as bikeshare.js `buildSelectionLabel` / gliders.js
 * `buildGliderSelectionLines`.
 * @param {object} balloon One proxy-normalized SondeHub record.
 * @returns {string[]} [title, ...details].
 */
function buildBalloonSelectionLines(balloon) {
  const phaseLabel = PHASE_LABELS[balloon.phase] || PHASE_LABELS.unknown;
  const altLine = [formatBalloonAltitude(balloon.altitudeM), formatBalloonTemp(balloon.tempC)]
    .filter(Boolean).join(' · ');
  const lines = [balloon.serial, `${phaseLabel} · ${altLine}`];
  const motion = [
    formatBalloonSpeed(balloon.speedMps),
    formatBalloonVerticalRate(balloon.verticalRateMps),
    formatBalloonHeading(balloon.headingDeg),
  ].filter(Boolean).join(' · ');
  if (motion) lines.push(motion);
  const make = [balloon.manufacturer, balloon.type].filter(Boolean).join(' ');
  const tail = [
    make,
    formatBalloonAge(balloon.timeMs),
    balloon.uploaderCallsign ? `via ${balloon.uploaderCallsign}` : '',
  ].filter(Boolean).join(' · ');
  if (tail) lines.push(tail);
  return lines;
}

/**
 * Build the protected click-selection detail card for one balloon — the
 * same "no information when I click on them" fix applied to gliders.js.
 * Structured after bikeshare.js `createBikeshareSelectedOverlayEntry`: a
 * single always-shown card in its own overlay source, distinct from the
 * ambient serial/altitude labels this layer already draws (which are
 * `interactive: false` by design).
 * @param {object} balloon One proxy-normalized SondeHub record (must carry `serial`).
 * @param {Cesium.Cartesian3} position World position for the card anchor.
 * @returns {object|null} Overlay entry, or null when the balloon is unusable.
 */
export function createBalloonSelectedOverlayEntry(balloon, position) {
  if (!balloon?.serial || !position) return null;
  const [title, ...details] = buildBalloonSelectionLines(balloon);
  return {
    id: `balloon-selected:${balloon.serial}`,
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: phaseColor(balloon.phase).toCssColorString(),
    interactive: false,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/** Keep the highest (most interesting/visible) balloons, stable tie-break. */
export function selectBalloonOverlayCohort(entries, limit = BALLOON_OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(0, Math.min(
    BALLOON_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

export function createWeatherBalloonsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  screenSpaceEventHandlerFactory = (viewer) => new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  let _dataSource = null;
  let _viewer = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** balloon.serial → raw balloon record from the most recent poll; the click handler's lookup table. */
  let _balloonBySerial = new Map();
  /** serial of the click-selected balloon, or null. */
  let _selectedSerial = null;
  let _clickHandler = null;

  /** Publish (or refresh) the detail card for one balloon without changing `_selectedSerial`. */
  function publishSelectedCard(balloon) {
    const position = Cesium.Cartesian3.fromDegrees(
      balloon.lon,
      balloon.lat,
      Math.max(0, balloon.altitudeM ?? 0),
    );
    const entry = createBalloonSelectedOverlayEntry(balloon, position);
    overlayHost.setEntries(
      BALLOON_SELECTED_OVERLAY_SOURCE_ID,
      entry ? [entry] : [],
      BALLOON_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function clearSelection() {
    if (!_selectedSerial) return;
    _selectedSerial = null;
    overlayHost.clearSource(BALLOON_SELECTED_OVERLAY_SOURCE_ID);
  }

  /**
   * Select a balloon by its SondeHub serial, publishing its detail card.
   * @param {string} serial Raw serial (no `balloon:` prefix).
   * @returns {boolean} True when the balloon was found and selected.
   */
  function selectBalloonBySerial(serial) {
    const balloon = _balloonBySerial.get(serial);
    if (!balloon) return false;
    _selectedSerial = serial;
    publishSelectedCard(balloon);
    return true;
  }

  /**
   * Install the LEFT_CLICK handler for balloon selection (enable-time only,
   * mirroring gliders.js/firmsHeatmap.js/bikeshare.js): clicking a balloon
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
        if (selectBalloonBySerial(pickedId.slice(ENTITY_ID_PREFIX.length))) return;
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
    name: 'Weather Balloons',
    icon: '🎈',
    source: 'SondeHub',
    updateInterval: 30000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('weather-balloons');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _balloonBySerial = new Map();
      _selectedSerial = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(BALLOON_OVERLAY_SOURCE_ID, false);
      console.log('[Data:WeatherBalloons] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(BALLOON_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      registerPickOwner(LAYER_ID, (pickedId) => (
        typeof pickedId === 'string' && pickedId.startsWith(ENTITY_ID_PREFIX)
      ));
    },

    disable(viewer) {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(BALLOON_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(BALLOON_OVERLAY_SOURCE_ID, false);
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
          _lastError = `SondeHub proxy HTTP ${response.status}`;
          console.warn(`[Data:WeatherBalloons] API returned ${response.status}`);
          return false;
        }
        const data = await response.json();
        signal?.throwIfAborted();
        if (!data || !Array.isArray(data.balloons)) {
          _lastError = 'Malformed balloon response';
          return false;
        }

        _dataSource.entities.removeAll();
        const overlayEntries = [];
        const nextBalloonBySerial = new Map();
        let count = 0;

        for (const balloon of data.balloons) {
          if (!isUsableBalloon(balloon)) continue;
          count += 1;
          nextBalloonBySerial.set(balloon.serial, balloon);
          const color = phaseColor(balloon.phase);
          const position = Cesium.Cartesian3.fromDegrees(
            balloon.lon,
            balloon.lat,
            Math.max(0, balloon.altitudeM ?? 0),
          );
          _dataSource.entities.add({
            id: `balloon:${balloon.serial}`,
            position,
            point: {
              pixelSize: 7,
              color,
              outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: {
              serial: balloon.serial,
              altitudeM: balloon.altitudeM,
              verticalRateMps: balloon.verticalRateMps,
              speedMps: balloon.speedMps,
              headingDeg: balloon.headingDeg,
              phase: balloon.phase,
              type: balloon.type,
              manufacturer: balloon.manufacturer,
              uploaderCallsign: balloon.uploaderCallsign,
            },
          });
          overlayEntries.push(createBalloonOverlayEntry({
            id: balloon.serial,
            position,
            serial: balloon.serial,
            altitudeM: balloon.altitudeM,
            accent: color.toCssColorString(),
          }));
        }

        _balloonBySerial = nextBalloonBySerial;

        if (_enabled) {
          overlayHost.setEntries(
            BALLOON_OVERLAY_SOURCE_ID,
            selectBalloonOverlayCohort(overlayEntries),
            {
              cohortLimit: BALLOON_OVERLAY_COHORT_LIMIT,
              collisionCapacity: BALLOON_OVERLAY_COLLISION_CAPACITY,
              moving: true,
            },
          );
          // The selected balloon keeps rising/falling between polls; re-anchor
          // its card to the fresh position rather than leaving it behind, and
          // drop the card the moment it ages out of the feed rather than
          // freezing it at a last-known position that reads as live.
          if (_selectedSerial) {
            const stillPresent = _balloonBySerial.get(_selectedSerial);
            if (stillPresent) publishSelectedCard(stillPresent);
            else clearSelection();
          }
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:WeatherBalloons] Updated: ${_count} sondes`);
        return true;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.warn('[Data:WeatherBalloons] Fetch error:', error);
        _lastError = 'SondeHub network error';
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(BALLOON_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(BALLOON_OVERLAY_SOURCE_ID, false);
      clearSelection();
      removeClickHandler();
      unregisterPickOwner(LAYER_ID);
      if (_dataSource) {
        (viewer || _viewer)?.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _count = 0;
      _balloonBySerial = new Map();
      _selectedSerial = null;
      _lastUpdate = null;
      _lastError = null;
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

const weatherBalloonsLayer = createWeatherBalloonsLayer();

export default weatherBalloonsLayer;
