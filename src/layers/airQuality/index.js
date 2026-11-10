import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import { fromDegrees } from '../../geo/cartesian3.js';
import { toDegrees } from '../../geo/math.js';
import { createAirQualityDisplay } from './render/display.js';
import { msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AIR_QUALITY_BANDS,
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
  AIR_QUALITY_PROVIDERS,
  createAirQualityOverlayEntry,
  mapAnalystRecord,
  newestObservation,
  readingsAreStale,
  readingsInView,
  selectAirQualityOverlayCohort,
} from './model.js';
export * from './model.js';
export { createEcccAirQualitySource } from './source.js';

/** Station markers are a point reading, not an extent. */
const STATION_MARKER_RADIUS_M = 6_000;
/** Readings listed in the readout card. */
const READOUT_LIMIT = 5;

/** Own one air-quality display, its refresh lifecycle, and its readout card. */
export function createAirQualityLayer({
  source,
  overlayHost,
  rendererFactory = ({ engine }) => createAirQualityDisplay(engine),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
  let sceneEngine = null;
  overlayHost = bindOverlayHost(overlayHost, () => sceneEngine);
  let initialized = false;
  let _request = null;
  let renderer = null;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  /** The camera's lon/lat rectangle in degrees, or null when unresolvable. */
  const viewRectangle = () => {
    const rectangle = renderer?.viewRectangle();
    if (!rectangle) return null;
    return {
      west: toDegrees(rectangle.west),
      south: toDegrees(rectangle.south),
      east: toDegrees(rectangle.east),
      north: toDegrees(rectangle.north),
    };
  };

  const layer = {
    id: 'air-quality',
    name: 'Air quality',
    icon: '◍',
    source: 'ECCC MSC GeoMet',
    updateInterval: 1_200_000,

    init(viewer, { engine = null } = {}) {
      if (initialized)
        throw new Error('Air quality layer is already initialized');
      initialized = true;
      try {
        if (engine) this.attachRenderer({ engine });
      } catch (error) {
        this.destroy();
        throw error;
      }
    },

    show(enabled) {
      renderer?.setVisible(enabled);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, enabled);
    },
    attachRenderer({ engine = null } = {}) {
      if (!initialized || renderer)
        throw new Error('Invalid air quality scene attachment');
      sceneEngine = engine;
      renderer = rendererFactory({ engine });
      this.show(_enabled);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, _enabled);
      if (_readings.length) this._render();
    },

    detachRenderer() {
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      renderer?.destroy();
      renderer = null;
      sceneEngine = null;
    },

    enable() {
      _enabled = true;
      renderer?.setVisible(true);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, true);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      renderer?.setVisible(false);
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const readings = await source.getSnapshot({ signal: request.signal });
        // A superseded or aborted request must not touch the scene, and neither
        // must one that lands after the layer was switched off.
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _readings = readings;
        this._render();
        _count = _readings.length;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Air quality request failed');
        console.warn('[Data:AirQuality] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Redraw the station discs and overlay labels from the current readings. */
    _render() {
      if (!renderer) return;
      renderer.replace(_readings, STATION_MARKER_RADIUS_M);
      const overlayEntries = [];
      for (const reading of _readings) {
        const position = fromDegrees(reading.lon, reading.lat);
        overlayEntries.push(
          createAirQualityOverlayEntry({
            id: reading.id,
            position,
            title: `${reading.name} ${reading.label}`,
            accent: reading.color,
            value: reading.value,
          }),
        );
      }
      if (_enabled) {
        overlayHost.setEntries(
          AIR_QUALITY_OVERLAY_SOURCE_ID,
          selectAirQualityOverlayCohort(overlayEntries),
          {
            cohortLimit: AIR_QUALITY_OVERLAY_COHORT_LIMIT,
            collisionCapacity: AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      _enabled = false;
      initialized = false;
      this.detachRenderer();
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /**
     * Readout descriptor for the Weather panel: the band legend, and the worst
     * readings currently in view.
     *
     * `readout: true` renders the toggle and source line only; the card owns
     * the rest. Coverage is stated plainly because this layer is not global.
     */
    getRowControls() {
      const provider = AIR_QUALITY_PROVIDERS.eccc;
      const inView = readingsInView(_readings, viewRectangle(), READOUT_LIMIT);
      const newest = _readings.reduce(
        (max, reading) => Math.max(max, reading.observedMs || 0),
        0,
      );
      // Readings and errors stay English data (analyst records, stats); the
      // card translates them as the Layers panel row does. A provider's own
      // error text has no catalog entry and shows as it came.
      return {
        readout: true,
        summary: {
          label: t(provider.label),
          coverage: t(provider.coverage),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: `${provider.network} · ${provider.scale}`,
          status: _lastError
            ? translateFeedError(_lastError)
            : _count === 0
              ? _lastUpdate === null
                ? t('No readings available')
                : t('No current readings')
              : tn(
                  _count,
                  '{count} station reporting',
                  '{count} stations reporting',
                ),
          units: provider.scale,
        },
        legend: AIR_QUALITY_BANDS.map((band) => ({
          color: band.color,
          label: t(band.label),
        })),
        legendCategorical: true,
        list: {
          ariaLabel: t('Highest air-quality readings in view'),
          items: inView.map((reading, index) => ({
            id: reading.id,
            ordinal: index + 1,
            lead: `${reading.scale} ${reading.label}`,
            text: `${reading.name} · ${t(reading.risk)}`,
            accent: reading.color,
          })),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot readings as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_readings.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _readings
        .slice(0, limit)
        .map((reading, index) => mapAnalystRecord(reading, index));
    },

    getStats() {
      // `lastUpdate` is when a response was received; `observedAt` is when the
      // network actually measured. Freshness is judged on the latter, so a feed
      // that keeps answering with hours-old observations reports STALE rather
      // than being narrated as live by the HUD and voice provenance envelope.
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        observedAt: newestObservation(_readings),
        // Only a completed refresh can be stale; before one there is no feed.
        stale: _lastUpdate !== null && readingsAreStale(_readings),
      };
    },
  };
  return layer;
}
