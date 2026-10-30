import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  COPERNICUS_DESCRIPTION,
  COPERNICUS_PHASES,
  copernicusActivationStatus,
  copernicusActivationStatusLabel,
  copernicusPhaseLabel,
  COPERNICUS_OVERLAY_COLLISION_CAPACITY,
  COPERNICUS_OVERLAY_COHORT_LIMIT,
  COPERNICUS_OVERLAY_SOURCE_ID,
  copernicusCategoryColor,
  copernicusCategoryLabel,
  createCopernicusOverlayEntry,
  mapCopernicusRecord,
  selectCopernicusOverlayCohort,
} from './model.js';
export * from './model.js';
export { createCopernicusEmsSource } from './source.js';

/** Activation markers are a point anchor, not an extent. */
const ACTIVATION_MARKER_RADIUS_M = 12_000;

/**
 * Own one Copernicus EMS activation display: the active civil-protection
 * activations as selectable ground anchors.
 */
export function createCopernicusEmsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Copernicus EMS requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('Copernicus EMS requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _activations = [];
  let _total = 0;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const layer = {
    id: 'copernicus-ems',
    name: 'Copernicus EMS',
    icon: '🆘',
    source: 'Copernicus EMS',
    updateInterval: 30 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Copernicus EMS layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('copernicus-ems');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _activations = [];
      _total = 0;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(COPERNICUS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(COPERNICUS_OVERLAY_SOURCE_ID, true);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(COPERNICUS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(COPERNICUS_OVERLAY_SOURCE_ID, false);
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
        _activations = snapshot.activations;
        _total = snapshot.total;
        this._render();
        _count = _activations.length;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Activation feed unavailable');
        console.warn('[Data:CopernicusEMS] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Rebuild entities and overlay labels from the current activations. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      const overlayEntries = [];
      for (const activation of _activations) {
        const position = Cesium.Cartesian3.fromDegrees(
          activation.lon,
          activation.lat,
        );
        const color = Cesium.Color.fromCssColorString(activation.color);
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `copernicus-activation:${activation.id}`,
            position,
            ellipse: {
              // Static axes, as in the earthquake layer: a per-frame axis
              // re-tessellates the clamped ground primitive every frame.
              semiMajorAxis: ACTIVATION_MARKER_RADIUS_M,
              semiMinorAxis: ACTIVATION_MARKER_RADIUS_M,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
              outline: true,
              outlineColor: color.withAlpha(0.9),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: {
              name: activation.name,
              code: activation.code,
              category: activation.category,
              categoryLabel: activation.categoryLabel,
              phase: activation.phase,
              phaseLabel: activation.phaseLabel,
              country: activation.country,
              lat: activation.lat,
              lon: activation.lon,
            },
          }),
        );
        overlayEntries.push(
          createCopernicusOverlayEntry({
            id: activation.id,
            position,
            title: activation.code || activation.name,
            accent: activation.color,
          }),
        );
      }
      if (_enabled) {
        overlayHost.setEntries(
          COPERNICUS_OVERLAY_SOURCE_ID,
          selectCopernicusOverlayCohort(overlayEntries),
          {
            cohortLimit: COPERNICUS_OVERLAY_COHORT_LIMIT,
            collisionCapacity: COPERNICUS_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(COPERNICUS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(COPERNICUS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _activations = [];
      _total = 0;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /** Readout descriptor for the Layers panel. */
    /**
     * The card for the Copernicus EMS row.
     *
     * The activation STATUS rides the card's badge, the same plain
     * uppercase badge the other cards use: NEW for an activation the
     * operator has only just raised, ONGOING for one still running, CLOSED
     * for one they have closed. The phase scale (preparedness through
     * recovery) is what the colour legend lists, and the phases are the
     * operator's own.
     *
     * The badge reports the WORST status in the feed, so one new activation
     * in a list of closed ones is not hidden behind a CLOSED badge.
     */
    getRowControls() {
      const categories = [
        ...new Set(_activations.map((entry) => entry.category)),
      ];
      const now = Date.now();
      const statuses = _activations.map((entry) =>
        copernicusActivationStatus(entry, now),
      );
      const open = statuses.filter((status) => status !== 'closed').length;
      const fresh = statuses.filter((status) => status === 'new').length;
      const closed = statuses.filter((status) => status === 'closed').length;
      const worst = fresh > 0 ? 'new' : open > 0 ? 'ongoing' : 'closed';
      const status = _lastError
        ? translateFeedError(_lastError)
        : _count === 0
          ? _lastUpdate === null
            ? t('No activations available')
            : t('No active activations')
          : tn(_count, '{count} activation', '{count} activations');
      const phases = [
        ...new Set(
          _activations
            .map((entry) => entry.phase)
            .filter((phase) => Boolean(phase)),
        ),
      ].map((phase) => ({
        phase,
        label: copernicusPhaseLabel(phase),
        count: _activations.filter((entry) => entry.phase === phase).length,
      }));
      return {
        readout: true,
        summary: {
          label: t('Copernicus EMS'),
          // The badge names the activation status, not the coverage: the
          // card's own body carries what the feed covers.
          coverage: t(copernicusActivationStatusLabel(worst)),
          detail: t(COPERNICUS_DESCRIPTION),
          validTime: _lastUpdate
            ? new Date(_lastUpdate).toISOString()
            : undefined,
          status,
          units: t('{new} new · {open} ongoing · {closed} closed', {
            new: String(fresh),
            open: String(open),
            closed: String(closed),
          }),
        },
        legend: phases.map((phase) => ({
          color: copernicusCategoryColor(
            _activations.find((entry) => entry.phase === phase.phase)?.category,
          ),
          label: t(phase.label),
        })),
        legendCategorical: true,
        list: {
          ariaLabel: t('Copernicus EMS activations'),
          items: _activations.slice(0, 50).map((entry) => ({
            id: entry.id,
            lead: t(copernicusPhaseLabel(entry.phase)),
            text: entry.name,
            accent: entry.color,
          })),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot the activation records as JSON-safe rows for the analyst
     * query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_activations.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _activations.slice(0, limit).map(mapCopernicusRecord);
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        total: _total || null,
      };
    },
  };
  return layer;
}
