import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  VIGICRUES_DESCRIPTION,
  VIGICRUES_LEVEL_COLORS,
  VIGICRUES_OVERLAY_COLLISION_CAPACITY,
  VIGICRUES_OVERLAY_COHORT_LIMIT,
  VIGICRUES_OVERLAY_SOURCE_ID,
  VIGICRUES_UNKNOWN_COLOR,
  createVigicruesOverlayEntry,
  mapVigicruesStationRecord,
  selectVigicruesOverlayCohort,
  zoneLines,
  vigicruesLevelLabel,
} from './model.js';
export * from './model.js';
export { createVigicruesSource } from './source.js';

/** Sensor markers are a point anchor, not an extent. */
const SENSOR_MARKER_RADIUS_M = 4_000;

/**
 * Own one flood-warning display: the warning zones as ground geometry and
 * the river sensors as anchors.
 */
export function createVigicruesFloodsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Vigicrues floods require a snapshot source');
  if (!overlayHost)
    throw new TypeError('Vigicrues floods require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _stations = [];
  let _zones = [];
  let _total = 0;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const layer = {
    id: 'vigicrues-floods',
    name: 'Flood Warnings',
    icon: '🌊',
    // The DATASET name only. The operator (Vigicrues) and the licence live
    // in DATA_SOURCES.md and the in-app credits.
    source: 'VIGICRUES',
    updateInterval: 15 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Vigicrues layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('vigicrues-floods');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _stations = [];
      _zones = [];
      _total = 0;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(VIGICRUES_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(VIGICRUES_OVERLAY_SOURCE_ID, true);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(VIGICRUES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VIGICRUES_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _stations = snapshot.stations;
        _zones = snapshot.zones;
        _total = snapshot.total;
        this._render();
        _count = _stations.length;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Flood feed unavailable');
        console.warn('[Data:Vigicrues] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /**
     * Rebuild entities and overlay labels from the current snapshot.
     *
     * The zone geometry is STATIC: it is built once per refresh as plain
     * positions, never through a CallbackProperty, so the ground primitive
     * is not re-tessellated every frame.
     */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      const overlayEntries = [];
      for (const station of _stations) {
        const position = Cesium.Cartesian3.fromDegrees(
          station.lon,
          station.lat,
        );
        const color = Cesium.Color.fromCssColorString(station.color);
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `vigicrues-station:${station.id}`,
            position,
            ellipse: {
              // Static axes: a per-frame axis re-tessellates the clamped
              // ground primitive every frame.
              semiMajorAxis: SENSOR_MARKER_RADIUS_M,
              semiMinorAxis: SENSOR_MARKER_RADIUS_M,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
              outline: true,
              outlineColor: color.withAlpha(0.9),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: {
              name: station.name,
              river: station.river,
              commune: station.commune,
              hasBulletin: station.hasBulletin,
              lat: station.lat,
              lon: station.lon,
            },
          }),
        );
        overlayEntries.push(
          createVigicruesOverlayEntry({
            id: station.id,
            position,
            title: station.name,
            accent: station.color,
          }),
        );
      }
      this._renderZones();
      if (_enabled) {
        overlayHost.setEntries(
          VIGICRUES_OVERLAY_SOURCE_ID,
          selectVigicruesOverlayCohort(overlayEntries),
          {
            cohortLimit: VIGICRUES_OVERLAY_COHORT_LIMIT,
            collisionCapacity: VIGICRUES_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    /** Build the warning-zone ground geometry as static polylines. */
    _renderZones() {
      if (!_dataSource) return;
      for (const zone of _zones) {
        const color = Cesium.Color.fromCssColorString(zone.color).withAlpha(
          0.85,
        );
        let index = 0;
        for (const line of zoneLines(zone.geometry)) {
          if (line.length < 2) continue;
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `vigicrues-zone:${zone.id}:${index}`,
              polyline: {
                // Static positions: a CallbackProperty here re-tessellates the
                // clamped ground primitive every frame.
                positions: line,
                width: 2,
                material: color,
                clampToGround: true,
              },
              properties: {
                name: zone.label,
                territory: zone.territory,
                level: zone.level,
              },
            }),
          );
          index += 1;
        }
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(VIGICRUES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VIGICRUES_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _stations = [];
      _zones = [];
      _total = 0;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /**
     * The row's legend: the vigilance bands, coloured exactly as the map
     * draws them, each with the number of warning zones currently in it.
     *
     * This is the CONTAINMENT-BAND shape the perimeters and GNSS rows use:
     * a legend is a list of {label, color, count}, where the colour is the
     * datum. The scale is the repo's own (VIGICRUES_LEVEL_COLORS in the
     * model), so the row and the map cannot drift apart.
     *
     * The bands are ALWAYS shown, not only the levels present right now: a
     * vigilance level that happens to be empty is still part of the scale,
     * and a legend that grows and shrinks with the data cannot be read as a
     * scale at all.
     */
    getRowControls() {
      const bands = VIGICRUES_LEVEL_COLORS.map((band, index) => ({
        label: t(band.label),
        color: band.color,
        count: _zones.filter((zone) => zone.level === band.id).length,
        ...(index === 0
          ? {
              blurb: t(
                'Colour shows the vigilance level the operator published for the warning zone. The zones are the river-course segments themselves, not the flooded area.',
              ),
            }
          : {}),
      }));
      const unknown = _zones.filter(
        (zone) =>
          zone.level == null ||
          !VIGICRUES_LEVEL_COLORS.some((band) => band.id === zone.level),
      ).length;
      if (unknown) {
        bands.push({
          label: t(vigicruesLevelLabel(null)),
          color: VIGICRUES_UNKNOWN_COLOR,
          count: unknown,
        });
      }
      return {
        chips: [],
        legend: bands,
        info: _lastError
          ? translateFeedError(_lastError)
          : t('{count} sensors · {zones} warning zones', {
              count: String(_count),
              zones: String(_zones.length),
            }),
        infoTitle: t(
          'The vigilance level is the one the operator published for each warning zone.',
        ),
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot the sensor records as JSON-safe rows for the analyst query
     * engine.
     * @param {number} [maxCount=2000]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_stations.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _stations.slice(0, limit).map(mapVigicruesStationRecord);
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        zoneCount: _zones.length,
        total: _total || null,
      };
    },
  };
  return layer;
}
