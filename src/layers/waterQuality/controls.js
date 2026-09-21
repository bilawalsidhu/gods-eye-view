import * as Cesium from 'cesium';
import { waterQualityFeedback } from '../../data/waterQualityFeedback.js';
import {
  ANALYTE_FAMILIES,
  COVERAGE_CAVEATS,
  DISTANCE_PREFILTER_MARGIN_M,
  FAMILY_IDS,
  LAYER_ID,
} from './policy.js';

export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: LAYER_ID,

    name: 'Water Quality',

    icon: '💧',

    source: 'Water Quality Portal (USGS/EPA + contributing agencies)',

    /** Camera-driven, like other viewport-bounded layers: never polled. */
    updateInterval: 0,

    statsRefreshInterval: 1000,

    analyteFamilies: ANALYTE_FAMILIES,

    /**
     * Switch the analyte family and reload. Each family is a separate upstream
     * query, so records are dropped rather than filtered: keeping the previous
     * family's dots on screen under a new legend would misreport what was asked.
     * @param {string} familyId Family identifier.
     * @returns {Promise<void>|undefined} The reload, when the family changed.
     */
    setAnalyteFamily(familyId) {
      const family = String(familyId || '').toLowerCase();
      if (!FAMILY_IDS.includes(family) || family === layerState.family) return;
      layerState.family = family;
      layerState.records = [];
      layerState.recordById = new Map();
      layerState.selectedId = null;
      layerState.measurementsBySite.clear();
      layerState.measurementsAbort?.abort();
      parts.rendering.clearRendered();
      return parts.ingestion.loadSites();
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
        if (
          parts.model.approximateSurfaceDistanceM(
            centerCartographic.latitude,
            centerCartographic.longitude,
            record.latitude,
            record.longitude,
          ) > approximateLimit
        )
          continue;
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
            parts.rendering.siteSurfaceHeightM(record),
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
     * Select and frame a monitoring site from another contextual UI.
     * @param {string} id Site identifier.
     * @returns {boolean} True when an available site was focused.
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
            parts.rendering.siteSurfaceHeightM(record),
          ),
          12000,
        ),
        { duration: 1.4 },
      );
      return true;
    },

    getStats() {
      const stats = {
        count: layerState.records.length,
        /** When THIS CLIENT fetched — not when the water was sampled. */
        lastUpdate: layerState.lastUpdate,
        stale: layerState.stale,
        saturated: layerState.saturated,
        totalSiteCount: layerState.totalSiteCount,
        /**
         * Start of the sampling window these records answer for. Deliberately
         * NOT folded into `stale`: a site sampled two years ago is ordinary for
         * this data, and reporting it as a degraded feed would make the feed
         * state meaningless for every other layer that shares the chip.
         */
        sampledSince: layerState.sampledSince,
        family: layerState.family,
        coverage: COVERAGE_CAVEATS[layerState.family] || null,
        error: layerState.error,
        status: layerState.status,
        loading: layerState.loading,
        retryAt: layerState.retryAt,
        retrying: layerState.loading && Boolean(layerState.failureReason),
        failureReason: layerState.failureReason,
        loadingLabel: layerState.loading ? 'loading monitoring sites' : '',
      };
      return { ...stats, statusMessage: waterQualityFeedback(stats) };
    },
  };

  return { methods };
}
