/**
 * @module layers/transit/stations
 * @description The French passenger-station network as the Transit layer draws
 * it: ground-clamped point pins in a draw-port points set plus the overlay
 * labels.
 *
 * WHY IT LIVES IN TRANSIT: the owner asked for the station network to be part
 * of the Transit row rather than a second row of its own, so the Layers panel
 * keeps one Transit row that draws the live GTFS-RT fleet AND the French rail
 * network's stations.
 *
 * The markers are POINT PINS, in the same points-set pattern the Bike Share
 * and satellite layers use. The network is national (2 792
 * stations), so ground ellipses big enough to see from orbit covered the map;
 * pins keep the network legible at every scale.
 */
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findCamera } from '../../render/rendererOf.js';
import { hexColor } from '../../render/color.js';
import {
  TRANSIT_STATION_PICK_PREFIX,
  TRANSIT_STATION_RANK_PRINCIPAL,
  TRANSIT_STATIONS_LABEL_MAX_ALTITUDE_M,
  TRANSIT_STATIONS_OVERLAY_COHORT_LIMIT,
  TRANSIT_STATIONS_OVERLAY_COLLISION_CAPACITY,
  TRANSIT_STATIONS_OVERLAY_SOURCE_ID,
  buildTransitStationCopy,
  createTransitStationOverlayEntry,
  createTransitStationSelectedOverlayEntry,
  selectTransitStationLabelCohort,
  transitStationClass,
} from './stationModel.js';
import {
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';
import { t } from '../../i18n/index.js';

/** The pin outline, the same soft black the Bike Share points use. */
const STATION_PIN_OUTLINE_COLOR = Object.freeze([0, 0, 0, 0.25]);

export * from './stationModel.js';

/**
 * The pin sizes in pixels, and the ONE rule that drives them.
 *
 * THE RULE: a station the catalogue gives a public short code
 * (`libellecourt`) is a PRINCIPAL station and is drawn at 9 px; a station with
 * no short code is a LOCAL station and is drawn at 6 px. Nothing else moves
 * the size.
 *
 * WHY ONLY THAT SIGNAL: the SNCF passenger-station catalogue publishes a
 * station's position, name, short code, UIC code and rail segment - and
 * nothing else. It publishes NO passenger count, NO service frequency, NO
 * train capacity and NO ridership. A pin sized by any of those would be
 * drawing a number the data does not carry, so the short code is the only
 * thing the size may follow. The UIC code is an identifier, not a measure,
 * and the segment is a grouping, not a measure; neither may set a size.
 *
 * WHAT THE LIVE DATA LOOKS LIKE: as of 2026-10-28 all 2 792 stations in the
 * catalogue carry a three-character short code, so in practice every pin is
 * drawn at the principal size and the smaller local size is the fallback for a
 * station the catalogue does not name. The rule stays because it is the only
 * one the catalogue supports, and it starts doing visible work the moment a
 * station arrives without a code.
 */
export const STATION_PIN_SIZE_PRINCIPAL = 9;
export const STATION_PIN_SIZE_LOCAL = 6;

/**
 * The distance behaviour of the pins, copied from the Bike Share layer so
 * the whole app shrinks and fades its points the same way: the pins scale
 * down and become translucent with distance, but never vanish entirely.
 */
export const STATION_PIN_SCALE_BY_DISTANCE = Object.freeze({
  near: 200,
  nearScale: 1.35,
  far: 130_000,
  farScale: 0.4,
});
export const STATION_PIN_TRANSLUCENCY_BY_DISTANCE = Object.freeze({
  near: 200,
  nearTranslucency: 1.0,
  far: 180_000,
  farTranslucency: 0.15,
});
export const STATION_PIN_DISABLE_DEPTH_TEST_DISTANCE = 2_500;

/** The selected pin: larger, with a white ring, like the Bike Share highlight. */
export const STATION_PIN_SELECTED_SIZE = 14;
export const STATION_PIN_SELECTED_OUTLINE_WIDTH = 2;
const STATION_PIN_SELECTED_OUTLINE_COLOR = Object.freeze([1, 1, 1, 1]);

/** Makes each layer instance's pin set id unique among the live sets. */
let instances = 0;

/** The retry ladder after a failed catalogue read: 30 s, 60 s, ... 5 min. */
export const STATION_RETRY_BASE_MS = 30_000;
export const STATION_RETRY_MAX_MS = 300_000;

/**
 * The station network the Transit layer owns.
 *
 * It is a scene-level part like the fleet: one draw-port points set of pins
 * plus the overlay labels, both released on destroy.
 *
 * @param {object} context
 * @returns {object}
 */
export function createStationNetwork({ state, services, parts, source }) {
  const { governorRequestRender } = services.render;
  const instance = (instances += 1);

  /** The pin set, hidden and empty, in the scene now. */
  function createPins(viewer) {
    destroyPins();
    state._stationPoints = drawOf(viewer).points({
      id: `transit:${instance}:stations`,
      clampTo: 'both',
      show: false,
    });
    state._stationPoints.set([]);
  }

  /** Let the pin set go. */
  function destroyPins() {
    state._stationPoints?.dispose();
    state._stationPoints = null;
    state._stationById = new Map();
    state._stationPointById = new Map();
  }

  /** Abort a station read that is still in flight, and any queued retry. */
  function abortStations() {
    state._stationRequest?.abort();
    state._stationRequest = null;
    clearTimeout(state._stationRetryTimer);
    state._stationRetryTimer = null;
  }

  /** The pin's resting look, from its station class. Mutates the item. */
  function stylePin(point, station, selected) {
    const classification = transitStationClass(station);
    const principal = classification.rank === TRANSIT_STATION_RANK_PRINCIPAL;
    point.color = hexColor(classification.color, 0.95);
    if (selected) {
      point.pixelSize = STATION_PIN_SELECTED_SIZE;
      point.outlineColor = STATION_PIN_SELECTED_OUTLINE_COLOR;
      point.outlineWidth = STATION_PIN_SELECTED_OUTLINE_WIDTH;
      return;
    }
    point.pixelSize = principal
      ? STATION_PIN_SIZE_PRINCIPAL
      : STATION_PIN_SIZE_LOCAL;
    point.outlineColor = STATION_PIN_OUTLINE_COLOR;
    point.outlineWidth = 1;
  }

  /** The station row for an id, or null. */
  function stationById(id) {
    return state._stationById?.get(id) ?? null;
  }

  /** Whether a station pin is on screen: the chips can hide the whole half. */
  function stationsShown() {
    return state._enabled && state._display !== 'vehicles';
  }

  /**
   * Publish the names worth drawing for the current view.
   *
   * The cohort follows the camera: the stations nearest the view centre, and
   * none at all from a national-scale view, where 48 arbitrary names would be
   * noise. Only the chosen stations are built into overlay entries.
   */
  function refreshLabels() {
    if (!state._overlayHost || !state._enabled) return;
    const camera = findCamera(state._viewer);
    const height = camera?.pose().height;
    let cohort = [];
    if (
      !Number.isFinite(height) ||
      height <= TRANSIT_STATIONS_LABEL_MAX_ALTITUDE_M
    ) {
      const bounds = camera?.viewRectangle() ?? null;
      cohort = selectTransitStationLabelCohort(state._stations, bounds, {
        exclude: state._stationSelectedId ?? null,
      });
    }
    const entries = cohort.map((station) =>
      createTransitStationOverlayEntry({
        id: station.id,
        position: fromDegrees(station.lon, station.lat),
        title: station.name,
        accent: transitStationClass(station).color,
      }),
    );
    state._overlayHost.setEntries(TRANSIT_STATIONS_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: TRANSIT_STATIONS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: TRANSIT_STATIONS_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
    governorRequestRender('transit-station-labels');
  }

  /** Drop the selection card and restore the selected pin. */
  function clearStationSelection() {
    const id = state._stationSelectedId;
    if (id == null) return false;
    state._stationSelectedId = null;
    const point = state._stationPointById?.get(id);
    const station = stationById(id);
    if (point && station) {
      stylePin(point, station, false);
      state._stationPoints?.upsert([point]);
    }
    state._overlayHost?.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
    if (state._enabled) refreshLabels();
    governorRequestRender('transit-station-deselect');
    return true;
  }

  /**
   * Select one station: highlight its pin and show its card.
   *
   * A selected vehicle and a selected station never coexist: they share the
   * one selected-card slot, so selecting here clears the vehicle first.
   *
   * @param {string} id Station id.
   * @returns {boolean} True when the station was selected.
   */
  function selectStation(id) {
    const station = stationById(id);
    const point = state._stationPointById?.get(id);
    if (!station || !point || !stationsShown()) return false;
    clearStationSelection();
    parts.selection.clearSelection();
    state._stationSelectedId = id;
    stylePin(point, station, true);
    state._stationPoints.upsert([point]);
    const card = createTransitStationSelectedOverlayEntry(
      id,
      point.pos,
      buildTransitStationCopy(station, t),
      transitStationClass(station).color,
    );
    if (card) {
      state._overlayHost.setEntries(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        [card],
        TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
    }
    // The card carries the name, so the ambient label for it steps aside.
    refreshLabels();
    governorRequestRender('transit-station-select');
    return true;
  }

  /** Rebuild the pins from the current stations, then the labels. */
  function renderStations() {
    const points = state._stationPoints;
    if (!points) return;
    state._stationById = new Map();
    state._stationPointById = new Map();
    const items = [];
    for (const station of state._stations) {
      const point = {
        id: `${TRANSIT_STATION_PICK_PREFIX}${station.id}`,
        pos: fromDegrees(station.lon, station.lat),
        height: 'clampGround',
        pixelSize: STATION_PIN_SIZE_LOCAL,
        color: [0, 0, 0, 1],
        scaleByDistance: {
          near: STATION_PIN_SCALE_BY_DISTANCE.near,
          nearValue: STATION_PIN_SCALE_BY_DISTANCE.nearScale,
          far: STATION_PIN_SCALE_BY_DISTANCE.far,
          farValue: STATION_PIN_SCALE_BY_DISTANCE.farScale,
        },
        fadeByDistance: {
          near: STATION_PIN_TRANSLUCENCY_BY_DISTANCE.near,
          nearValue: STATION_PIN_TRANSLUCENCY_BY_DISTANCE.nearTranslucency,
          far: STATION_PIN_TRANSLUCENCY_BY_DISTANCE.far,
          farValue: STATION_PIN_TRANSLUCENCY_BY_DISTANCE.farTranslucency,
        },
        disableDepthTest: STATION_PIN_DISABLE_DEPTH_TEST_DISTANCE,
      };
      stylePin(point, station, false);
      items.push(point);
      state._stationById.set(station.id, station);
      state._stationPointById.set(station.id, point);
    }
    points.set(items);
    // A station that is no longer in the catalogue cannot stay selected.
    if (
      state._stationSelectedId != null &&
      !state._stationById.has(state._stationSelectedId)
    ) {
      clearStationSelection();
    } else if (state._stationSelectedId != null) {
      const id = state._stationSelectedId;
      state._stationSelectedId = null;
      selectStation(id);
    }
    if (state._enabled) refreshLabels();
    governorRequestRender('transit-stations');
  }

  /**
   * Read the French passenger-station catalogue and draw it.
   *
   * The catalogue is STATIC, so this runs once per enable rather than on the
   * fleet's poll. It deliberately does NOT follow the fleet's altitude gate or
   * its camera-driven proximity polling: a static national rail network that
   * only appeared once the camera dropped into a live GTFS-RT coverage area
   * would read as broken from any wider view, and the read itself is one
   * small cached proxy response.
   *
   * @returns {Promise<boolean>} True when the catalogue was drawn.
   */
  async function loadStations() {
    if (!state._enabled || typeof source?.getStations !== 'function')
      return false;
    abortStations();
    const request = new AbortController();
    state._stationRequest = request;
    try {
      const snapshot = await source.getStations({ signal: request.signal });
      if (
        request.signal.aborted ||
        state._stationRequest !== request ||
        !state._enabled
      )
        return false;
      state._stations = snapshot.stations;
      state._stationTotal = snapshot.total;
      state._stationUpdatedAt = Date.now();
      state._stationError = null;
      state._stationFailures = 0;
      renderStations();
      state._dataManager?.refreshLayerStats?.();
      return true;
    } catch (error) {
      if (request.signal.aborted || state._stationRequest !== request)
        return false;
      state._stationError = error?.message || 'Station network unavailable';
      console.warn(
        '[Data:Transit] Station network unavailable:',
        state._stationError,
      );
      state._dataManager?.refreshLayerStats?.();
      // A catalogue that failed (cooling down, rate limited, offline) is tried
      // again on a backoff, so the network appears once the operator recovers
      // instead of staying blank until the layer is toggled.
      state._stationFailures = (state._stationFailures || 0) + 1;
      const wait = Math.min(
        STATION_RETRY_MAX_MS,
        STATION_RETRY_BASE_MS * 2 ** (state._stationFailures - 1),
      );
      state._stationRetryTimer = setTimeout(() => {
        state._stationRetryTimer = null;
        void loadStations();
      }, wait);
      return false;
    } finally {
      if (state._stationRequest === request) state._stationRequest = null;
    }
  }

  /**
   * Put the two halves of the row on screen as the display mode says: the
   * fleet's icon sets, the station pins and their labels. An enable calls it
   * too, so it honours the mode the operator last chose.
   */
  function syncDisplay() {
    const showVehicles = state._display !== 'stations';
    const showStations = state._display !== 'vehicles';
    if (state._stillIcons) state._stillIcons.show = showVehicles;
    if (state._movingIcons) state._movingIcons.show = showVehicles;
    if (state._stationPoints) state._stationPoints.show = showStations;
    state._overlayHost.setVisible(
      TRANSIT_STATIONS_OVERLAY_SOURCE_ID,
      showStations,
    );
    // A card for a pin that is no longer drawn must not linger.
    if (!showStations) clearStationSelection();
    // The selected-vehicle card is about a live vehicle, so it goes with
    // the fleet rather than lingering over a stations-only view.
    if (!showVehicles) parts.selection.clearSelection();
  }

  /**
   * Show or hide the two halves of the merged row, as the row's chips ask.
   *
   * The Transit row draws two different things: the live GTFS-RT fleet and
   * the static SNCF station network. The chips let the operator see one or
   * the other, so a country-wide view of the rail network is not buried
   * under a fleet of buses.
   *
   * @param {'both'|'vehicles'|'stations'} display The mode to draw.
   */
  function applyDisplayMode(display) {
    const mode =
      display === 'vehicles' || display === 'stations' ? display : 'both';
    if (state._display === mode) return false;
    state._display = mode;
    if (!state._enabled) return true;
    syncDisplay();
    governorRequestRender('transit-display-mode');
    return true;
  }

  /**
   * Take the network off the screen: cancel its read, drop its pins, labels
   * and selection, and forget the rows. The pin set itself stays (hidden).
   */
  function clearStations() {
    clearStationSelection();
    state._overlayHost.setVisible(TRANSIT_STATIONS_OVERLAY_SOURCE_ID, false);
    state._overlayHost.clearSource(TRANSIT_STATIONS_OVERLAY_SOURCE_ID);
    abortStations();
    if (state._stationPoints) {
      state._stationPoints.show = false;
      state._stationPoints.set([]);
    }
    state._stationById.clear();
    state._stationPointById.clear();
    state._stations = [];
    state._stationTotal = 0;
    state._stationError = null;
    state._stationFailures = 0;
  }

  return {
    createPins,
    destroyPins,
    clearStations,
    renderStations,
    refreshLabels,
    selectStation,
    clearStationSelection,
    loadStations,
    abortStations,
    applyDisplayMode,
    syncDisplay,
  };
}
