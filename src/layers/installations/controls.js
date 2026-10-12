import * as Cesium from 'cesium';
import { installationFeedback } from '../../data/installationFeedback.js';
import {
  LAYER_ID,
  DISTANCE_PREFILTER_MARGIN_M,
  ANCHOR_REFRESH_M,
} from './policy.js';
import { t } from '../../i18n/index.js';

// installationFeedback.js composes its guidance inside the portable
// node/browser graph (the server-side HUD summary reads the same module), so
// its copy stays English there. getStats is the browser presentation
// boundary: map the closed message vocabulary to the catalog, passing any
// live provider error through verbatim (docs/TRANSLATORS.md).
const INSTALLATION_FEEDBACK_KEYS = Object.freeze({
  'Retrying mapped sites…': 'layers.installations.feedback.retrying',
  'Fetching mapped sites…': 'layers.installations.feedback.fetching',
  'Zoom in to search mapped installations':
    'layers.installations.feedback.zoomIn',
  'Showing cached mapped sites': 'layers.installations.feedback.cached',
  'Mapped sites not loaded': 'layers.installations.feedback.notLoaded',
  'Mapped sites loaded': 'layers.installations.feedback.loaded',
  'Overpass rate-limited': 'layers.installations.feedback.reason.rateLimited',
  'Overpass timed out': 'layers.installations.feedback.reason.timeout',
  'Overpass could not complete the query':
    'layers.installations.feedback.reason.queryFailed',
  'Overpass temporarily unavailable':
    'layers.installations.feedback.reason.unavailable',
});

const INSTALLATION_RETRY_IN_RE = /^(.*) — retrying in (\d+)s$/;
const INSTALLATION_RETRY_PENDING_RE = /^(.*) — retry pending$/;

function localizeInstallationFeedback(message) {
  if (typeof message !== 'string' || !message) return message;
  const key = INSTALLATION_FEEDBACK_KEYS[message];
  if (key) return t(key);
  const retryIn = message.match(INSTALLATION_RETRY_IN_RE);
  if (retryIn) {
    const reasonKey = INSTALLATION_FEEDBACK_KEYS[retryIn[1]];
    return t('layers.installations.feedback.retryIn', {
      reason: reasonKey ? t(reasonKey) : retryIn[1],
      seconds: retryIn[2],
    });
  }
  const pending = message.match(INSTALLATION_RETRY_PENDING_RE);
  if (pending) {
    const reasonKey = INSTALLATION_FEEDBACK_KEYS[pending[1]];
    return t('layers.installations.feedback.retryPending', {
      reason: reasonKey ? t(reasonKey) : pending[1],
    });
  }
  return message;
}

export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: LAYER_ID,

    name: 'Mapped Installations',

    icon: '⌖',

    source: 'OpenStreetMap + optional Google Maps Places',

    updateInterval: 0,

    statsRefreshInterval: 1000,

    visitNamedMarkers(visitor) {
      parts.namedMarkers.visit(visitor);
    },

    /** Request a one-shot Google Maps Places search around the current map view. */
    searchNearby() {
      layerState.googleSearchRequested = true;
      return parts.ingestion.loadInstallations();
    },

    /**
     * Load sites around a Contacts subject instead of the camera viewport.
     *
     * A follow or Cockpit camera moves every frame, so `moveEnd` never fires and
     * its view rectangle often reaches the horizon; a subject window is the
     * only area that answers "what is near this contact". The window moves
     * only after the subject travels ANCHOR_REFRESH_M, and cached tiles make
     * that cheap. Passing null returns the layer to viewport loading.
     * @param {Cesium.Cartesian3|{latitude:number, longitude:number}|null} position
     *   Subject position.
     * @returns {boolean} Whether a new load was scheduled.
     */
    setContextAnchor(position) {
      let next = null;
      if (position) {
        if (
          Number.isFinite(position.latitude) &&
          Number.isFinite(position.longitude)
        )
          next = { latitude: position.latitude, longitude: position.longitude };
        else {
          const carto = Cesium.Cartographic.fromCartesian(position);
          if (carto)
            next = {
              latitude: Cesium.Math.toDegrees(carto.latitude),
              longitude: Cesium.Math.toDegrees(carto.longitude),
            };
        }
      }
      // Keep the live centre even when the coarse fetch anchor has not moved.
      layerState.contextPosition = next
        ? Cesium.Cartesian3.fromDegrees(next.longitude, next.latitude)
        : null;
      const previous = layerState.contextAnchor;
      if (!next) {
        if (!previous) return false;
        layerState.contextAnchor = null;
        parts.viewport.scheduleLoad();
        return true;
      }
      if (
        previous &&
        parts.model.approximateSurfaceDistanceM(
          Cesium.Math.toRadians(previous.latitude),
          Cesium.Math.toRadians(previous.longitude),
          next.latitude,
          next.longitude,
        ) < ANCHOR_REFRESH_M
      )
        return false;
      layerState.contextAnchor = next;
      parts.viewport.scheduleLoad();
      return true;
    },

    getNearby(center, rangeM, maxCount = 50) {
      if (!center) return [];
      const range = Number.isFinite(rangeM) ? rangeM : Infinity;
      const centerCartographic = Cesium.Cartographic.fromCartesian(center);
      if (!centerCartographic) return [];
      const nearby = [];
      const approximateLimit = Number.isFinite(range)
        ? range * 1.03 + DISTANCE_PREFILTER_MARGIN_M
        : Infinity;
      for (const record of layerState.records) {
        if (record.kind !== 'installation') continue;
        if (
          parts.model.approximateSurfaceDistanceM(
            centerCartographic.latitude,
            centerCartographic.longitude,
            record.latitude,
            record.longitude,
          ) > approximateLimit
        )
          continue;
        // The awareness disk is projected onto the ground. Confirm candidates
        // with an exact ellipsoidal surface distance and reusable scratch state.
        layerState.distanceEndpointScratch.longitude = Cesium.Math.toRadians(
          record.longitude,
        );
        layerState.distanceEndpointScratch.latitude = Cesium.Math.toRadians(
          record.latitude,
        );
        layerState.distanceEndpointScratch.height = 0;
        layerState.distanceGeodesicScratch.setEndPoints(
          centerCartographic,
          layerState.distanceEndpointScratch,
        );
        const distanceM = layerState.distanceGeodesicScratch.surfaceDistance;
        if (!Number.isFinite(distanceM) || distanceM > range) continue;
        nearby.push({
          ...record,
          position: Cesium.Cartesian3.fromDegrees(
            record.longitude,
            record.latitude,
            parts.rendering.installationSurfaceHeightM(record),
          ),
          distanceM,
        });
      }
      nearby.sort((a, b) => a.distanceM - b.distanceM);
      return nearby.slice(
        0,
        Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 50,
      );
    },

    /**
     * Select and frame a mapped installation from another contextual UI.
     * @param {string} id Source-backed installation id.
     * @returns {boolean} True when an available installation was focused.
     */
    focusById(id) {
      const record = layerState.recordById.get(String(id));
      if (!record || !layerState.viewer) return false;
      // No camera flight without a real selection: a flight plus a stale subject
      // reads as success to Context navigation and strands NEXT on this item.
      if (!parts.selection.selectRecord(record.id)) return false;
      layerState.viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(
          Cesium.Cartesian3.fromDegrees(
            record.longitude,
            record.latitude,
            parts.rendering.installationSurfaceHeightM(record),
          ),
          18000,
        ),
        { duration: 1.4 },
      );
      return true;
    },

    /**
     * Snapshot loaded mapped installations as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, name, class, kind, lat, lon}.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!layerState.enabled) return [];
      const result = [];
      for (const record of layerState.records || []) {
        if (result.length >= maxCount) break;
        if (
          !Number.isFinite(record.latitude) ||
          !Number.isFinite(record.longitude)
        )
          continue;
        result.push({
          id: record.name || record.id,
          name: record.name || null,
          class: record.class || null,
          kind: record.kind || null,
          lat: record.latitude,
          lon: record.longitude,
        });
      }
      return result;
    },

    getStats() {
      const namedMarkers = parts.namedMarkers?.stats();
      const subjectWindow =
        layerState.coverage?.kind === 'subject' &&
        layerState.contextPosition &&
        Number.isFinite(layerState.coverage.radiusM);
      const mappedCount = subjectWindow
        ? methods.getNearby(
            layerState.contextPosition,
            layerState.coverage.radiusM,
            layerState.records.length || 1,
          ).length
        : layerState.wide && namedMarkers
          ? namedMarkers.pointsOnScreen
          : layerState.records.filter(
              (record) => record.kind === 'installation',
            ).length;
      return {
        count:
          subjectWindow || layerState.wide
            ? mappedCount
            : layerState.records.length,
        namedInView: layerState.namedInView || 0,
        wide: Boolean(layerState.wide),
        ...namedMarkers,
        lastUpdate: layerState.lastUpdate,
        stale: layerState.stale,
        saturated: layerState.saturated,
        error: layerState.error,
        status: layerState.status,
        loading: layerState.loading,
        retryAt: layerState.retryAt,
        retrying: layerState.loading && Boolean(layerState.failureReason),
        failureReason: layerState.failureReason,
        statusMessage: localizeInstallationFeedback(
          installationFeedback({
            ...layerState,
            count: layerState.lastUpdate ? mappedCount : undefined,
            retrying: layerState.loading && Boolean(layerState.failureReason),
          }),
        ),
        loadingLabel: layerState.loading
          ? t('layers.installations.loading')
          : '',
        coverage: layerState.coverage,
        coverageLabel:
          layerState.coverage?.kind === 'subject'
            ? `WITHIN ${Math.round(layerState.coverage.radiusM / 1000)} KM`
            : 'CURRENT VIEWPORT ONLY',
      };
    },
  };

  return { methods };
}
