import { installationFeedback } from '../../data/installationFeedback.js';
import {
  LAYER_ID,
  DISTANCE_PREFILTER_MARGIN_M,
  ANCHOR_REFRESH_M,
} from './policy.js';
import { t } from '../../i18n/index.js';
import { fromDegrees, toCartographicRadians } from '../../geo/ellipsoid.js';
import { surfaceDistance } from '../../geo/geodesic.js';
import { toDegrees, toRadians } from '../../geo/vector.js';
import { cameraOf } from '../../render/rendererOf.js';

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
     * @param {{x:number, y:number, z:number}|{latitude:number, longitude:number}|null} position
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
          const carto = toCartographicRadians(position);
          if (carto)
            next = {
              latitude: toDegrees(carto.lat),
              longitude: toDegrees(carto.lon),
            };
        }
      }
      // Keep the live centre even when the coarse fetch anchor has not moved.
      layerState.contextPosition = next
        ? fromDegrees(next.longitude, next.latitude)
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
          toRadians(previous.latitude),
          toRadians(previous.longitude),
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
      const centerCartographic = toCartographicRadians(center);
      if (!centerCartographic) return [];
      const nearby = [];
      const approximateLimit = Number.isFinite(range)
        ? range * 1.03 + DISTANCE_PREFILTER_MARGIN_M
        : Infinity;
      for (const record of layerState.records) {
        if (record.kind !== 'installation') continue;
        if (
          parts.model.approximateSurfaceDistanceM(
            centerCartographic.lat,
            centerCartographic.lon,
            record.latitude,
            record.longitude,
          ) > approximateLimit
        )
          continue;
        // The awareness disk is projected onto the ground. Confirm candidates
        // with an exact ellipsoidal surface distance.
        const distanceM = surfaceDistance(centerCartographic, {
          lon: toRadians(record.longitude),
          lat: toRadians(record.latitude),
        });
        if (!Number.isFinite(distanceM) || distanceM > range) continue;
        nearby.push({
          ...record,
          position: fromDegrees(
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
     * A loaded mapped installation by id, as `getNearby` returns it (with its
     * drawn `position`), or null while the layer is off or the id is not
     * loaded. Read-only: nothing is selected.
     * @param {string} id Source-backed installation id.
     * @returns {object|null}
     */
    getById(id) {
      if (!layerState.enabled || id === null || id === undefined) return null;
      const record = layerState.recordById.get(String(id));
      if (!record || record.kind !== 'installation') return null;
      return {
        ...record,
        position: fromDegrees(
          record.longitude,
          record.latitude,
          parts.rendering.installationSurfaceHeightM(record),
        ),
      };
    },

    /**
     * The mapped installation a query port's pick landed on: a site's dot,
     * outline or fill, or a named marker, each naming its installation in
     * its `meta`, as this layer's own click selection reads them. Null for
     * anything else.
     * @param {object|null|undefined} hit A query port `Hit`.
     * @returns {object|null} As {@link getById}.
     */
    findByPick(hit) {
      const id =
        hit?.set === parts.namedMarkers?.setId ||
        parts.rendering.ownsSet(hit?.set)
          ? hit.meta?.installationId
          : null;
      return id ? methods.getById(id) : null;
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
      cameraOf(layerState.viewer).flyToBounds(
        {
          center: {
            lon: record.longitude,
            lat: record.latitude,
            height: parts.rendering.installationSurfaceHeightM(record),
          },
          radius: 18000,
        },
        { durationS: 1.4 },
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
        // English: the analyst reads it as is; displays translate it.
        statusMessage: installationFeedback({
          ...layerState,
          count: layerState.lastUpdate ? mappedCount : undefined,
          retrying: layerState.loading && Boolean(layerState.failureReason),
        }),
        loadingLabel: layerState.loading
          ? t('loading mapped installation context')
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
