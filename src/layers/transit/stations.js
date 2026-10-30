/**
 * @module layers/transit/stations
 * @description The French passenger-station network as the Transit layer draws
 * it: point pins in a Cesium PointPrimitiveCollection plus the overlay
 * labels.
 *
 * WHY IT LIVES IN TRANSIT: the owner asked for the station network to be part
 * of the Transit row rather than a second row of its own, so the Layers panel
 * keeps one Transit row that draws the live GTFS-RT fleet AND the French rail
 * network's stations.
 *
 * The markers are POINT PINS, in the same PointPrimitiveCollection pattern the
 * Bike Share and satellite layers use. The network is national (2 792
 * stations), so ground ellipses big enough to see from orbit covered the map;
 * pins keep the network legible at every scale.
 */
import * as Cesium from 'cesium';
import {
  TRANSIT_STATION_RANK_PRINCIPAL,
  TRANSIT_STATIONS_OVERLAY_COHORT_LIMIT,
  TRANSIT_STATIONS_OVERLAY_COLLISION_CAPACITY,
  TRANSIT_STATIONS_OVERLAY_SOURCE_ID,
  createTransitStationOverlayEntry,
  selectTransitStationOverlayCohort,
  transitStationClass,
} from './stationModel.js';

/** The pin outline, the same soft black the Bike Share points use. */
const STATION_PIN_OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.25);

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

/**
 * The station network the Transit layer owns.
 *
 * It is a scene-level part like the fleet: one Cesium PointPrimitiveCollection
 * of pins plus the overlay labels, both released on destroy.
 *
 * @param {object} context
 * @returns {object}
 */
export function createStationNetwork({ state, services, parts, source }) {
  const { governorRequestRender } = services.render;

  /** Abort a station read that is still in flight. */
  function abortStations() {
    state._stationRequest?.abort();
    state._stationRequest = null;
  }

  /** Rebuild the pins and the overlay labels from the current stations. */
  function renderStations() {
    const points = state._stationPoints;
    if (!points) return;
    points.removeAll();
    const overlayEntries = [];
    for (const station of state._stations) {
      const position = Cesium.Cartesian3.fromDegrees(station.lon, station.lat);
      // ONE classification: the pin colour and the legend counts both come
      // from transitStationClass, so they cannot disagree.
      const classification = transitStationClass(station);
      const color = Cesium.Color.fromCssColorString(classification.color);
      const principal = classification.rank === TRANSIT_STATION_RANK_PRINCIPAL;
      points.add({
        id: `sncf-station:${station.id}`,
        position,
        pixelSize: principal
          ? STATION_PIN_SIZE_PRINCIPAL
          : STATION_PIN_SIZE_LOCAL,
        color: color.withAlpha(0.95),
        outlineColor: STATION_PIN_OUTLINE_COLOR,
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(
          STATION_PIN_SCALE_BY_DISTANCE.near,
          STATION_PIN_SCALE_BY_DISTANCE.nearScale,
          STATION_PIN_SCALE_BY_DISTANCE.far,
          STATION_PIN_SCALE_BY_DISTANCE.farScale,
        ),
        translucencyByDistance: new Cesium.NearFarScalar(
          STATION_PIN_TRANSLUCENCY_BY_DISTANCE.near,
          STATION_PIN_TRANSLUCENCY_BY_DISTANCE.nearTranslucency,
          STATION_PIN_TRANSLUCENCY_BY_DISTANCE.far,
          STATION_PIN_TRANSLUCENCY_BY_DISTANCE.farTranslucency,
        ),
        disableDepthTestDistance: STATION_PIN_DISABLE_DEPTH_TEST_DISTANCE,
      });
      overlayEntries.push(
        createTransitStationOverlayEntry({
          id: station.id,
          position,
          title: station.name,
          accent: classification.color,
        }),
      );
    }
    if (state._enabled) {
      state._overlayHost.setEntries(
        TRANSIT_STATIONS_OVERLAY_SOURCE_ID,
        selectTransitStationOverlayCohort(overlayEntries),
        {
          cohortLimit: TRANSIT_STATIONS_OVERLAY_COHORT_LIMIT,
          collisionCapacity: TRANSIT_STATIONS_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
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
      return false;
    } finally {
      if (state._stationRequest === request) state._stationRequest = null;
    }
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
    const showVehicles = mode !== 'stations';
    const showStations = mode !== 'vehicles';
    if (state._markers) state._markers.show = showVehicles;
    if (state._animatedMarkers) state._animatedMarkers.show = showVehicles;
    if (state._stationPoints) state._stationPoints.show = showStations;
    state._overlayHost.setVisible(
      TRANSIT_STATIONS_OVERLAY_SOURCE_ID,
      showStations,
    );
    if (!showVehicles) {
      // The selected-vehicle card is about a live vehicle, so it goes with
      // the fleet rather than lingering over a stations-only view.
      parts.selection.clearSelection();
    }
    governorRequestRender('transit-display-mode');
    return true;
  }

  return {
    renderStations,
    loadStations,
    abortStations,
    applyDisplayMode,
  };
}
