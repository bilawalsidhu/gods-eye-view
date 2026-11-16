import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { drawOf } from '../../render/rendererOf.js';
import { createEntityCard } from '../entityCard.js';
import {
  VIGICRUES_DESCRIPTION,
  VIGICRUES_LEVEL_COLORS,
  VIGICRUES_OVERLAY_COLLISION_CAPACITY,
  VIGICRUES_OVERLAY_COHORT_LIMIT,
  VIGICRUES_OVERLAY_SOURCE_ID,
  VIGICRUES_UNKNOWN_COLOR,
  VIGICRUES_STATION_PICK_PREFIX,
  VIGICRUES_ZONE_PICK_PREFIX,
  buildVigicruesStationCopy,
  buildVigicruesZoneCopy,
  vigicruesPick,
  createVigicruesOverlayEntry,
  mapVigicruesStationRecord,
  selectVigicruesOverlayCohort,
  zoneLines,
  vigicruesLevelLabel,
} from './model.js';
export * from './model.js';
export { createVigicruesSource } from './source.js';

let layerSeq = 0;

/** Sensor markers are a point anchor, not an extent. */
const SENSOR_MARKER_RADIUS_M = 4_000;

/**
 * Own one flood-warning display: the warning zones as ground geometry and
 * the river sensors as anchors.
 */
export function createVigicruesFloodsLayer({
  source,
  overlayHost,
  interaction,
  inputFor,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Vigicrues floods require a snapshot source');
  if (!overlayHost)
    throw new TypeError('Vigicrues floods require an overlay host');
  let _viewer = null;
  let _request = null;
  let _sets = null;
  let _stations = [];
  let _zones = [];
  let _total = 0;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const cardSourceId = `${VIGICRUES_OVERLAY_SOURCE_ID}-selected`;
  const card = createEntityCard({
    layerId: 'vigicrues-floods',
    overlayHost,
    sourceId: cardSourceId,
    interaction,
    ...(inputFor ? { inputFor } : {}),
    owns: (id) => vigicruesPick(id) !== null,
    resolve(id, click) {
      const pick = vigicruesPick(id);
      if (!pick) return null;
      if (pick.kind === 'station') {
        const station = _stations.find((entry) => entry.id === pick.id);
        if (!station) return null;
        return {
          ...buildVigicruesStationCopy(station, t),
          accent: station.color,
          position: fromDegrees(station.lon, station.lat, 0),
        };
      }
      const zone = _zones.find((entry) => entry.id === pick.id);
      if (!zone || !click.position) return null;
      return { ...buildVigicruesZoneCopy(zone, t), accent: zone.color };
    },
  });

  const notify = () => rowControlsListener?.();
  const setShown = (show) => {
    if (!_sets) return;
    _sets.zones.show = show;
    _sets.stations.show = show;
  };

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
      // A viewer with no renderer bound draws nothing; the layer still runs.
      try {
        const draw = drawOf(viewer);
        const base = `vigicrues-floods:${++layerSeq}`;
        _sets = {
          zones: draw.lines({ id: `${base}:zones`, clampTo: 'both' }),
          stations: draw.shapes({ id: `${base}:stations`, clampTo: 'both' }),
        };
        _sets.zones.show = false;
        _sets.stations.show = false;
      } catch {
        _sets = null;
      }
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
      setShown(true);
      overlayHost.setVisible(VIGICRUES_OVERLAY_SOURCE_ID, true);
      card.install(_viewer);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      setShown(false);
      overlayHost.clearSource(VIGICRUES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VIGICRUES_OVERLAY_SOURCE_ID, false);
      card.remove();
      notify();
    },

    async update() {
      if (!_enabled || !_sets) return false;
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
      if (!_sets) return;
      card.clear();
      const overlayEntries = [];
      const shapes = [];
      for (const station of _stations) {
        const position = fromDegrees(station.lon, station.lat, 0);
        shapes.push({
          // The pick id the card's `owns`/`resolve` read.
          id: `${VIGICRUES_STATION_PICK_PREFIX}${station.id}`,
          geometry: {
            kind: 'ellipse',
            center: position,
            // Static axes: the marker is a point anchor, not an extent.
            semiMajor: SENSOR_MARKER_RADIUS_M,
            semiMinor: SENSOR_MARKER_RADIUS_M,
          },
          fill: hexColor(station.color, 0.35),
          outline: hexColor(station.color, 0.9),
          outlineWidth: 2,
          clampTo: 'both',
          meta: {
            name: station.name,
            river: station.river,
            commune: station.commune,
            hasBulletin: station.hasBulletin,
            lat: station.lat,
            lon: station.lon,
          },
        });
        overlayEntries.push(
          createVigicruesOverlayEntry({
            id: station.id,
            position,
            title: station.name,
            accent: station.color,
          }),
        );
      }
      _sets.stations.set(shapes);
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
      if (!_sets) return;
      const lines = [];
      for (const zone of _zones) {
        const color = hexColor(zone.color, 0.85);
        let index = 0;
        for (const line of zoneLines(zone.geometry)) {
          if (line.length < 2) continue;
          lines.push({
            id: `${VIGICRUES_ZONE_PICK_PREFIX}${zone.id}:${index}`,
            positions: line.map((point) =>
              fromDegrees(point.lon, point.lat, 0),
            ),
            widthPx: 2,
            mode: 'draped',
            style: { kind: 'solid', color },
            meta: {
              name: zone.label,
              territory: zone.territory,
              level: zone.level,
            },
          });
          index += 1;
        }
      }
      _sets.zones.set(lines);
    },

    destroy() {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(VIGICRUES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VIGICRUES_OVERLAY_SOURCE_ID, false);
      card.remove();
      if (_sets) {
        _sets.zones.dispose();
        _sets.stations.dispose();
        _sets = null;
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
