import * as Cesium from 'cesium';
import { msg, t, tn, formatNumber } from '../../i18n/index.js';
import {
  RIVER_GAUGE_CATEGORIES,
  countGaugesInFlood,
  countRiverGauges,
  mapRiverGaugeAnalystRecord,
  newestRiverGaugeObservation,
  riverGaugeCategory,
  riverGaugePageUrl,
} from './records.js';
import { RIVER_GAUGE_OVERLAY_SOURCE_ID, buildRiverGaugeCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createRiverGaugeSource } from './source.js';

const LAYER_ID = 'river-gauges';
const PICK_PREFIX = 'river-gauge:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Points shrink with range so a national view stays legible. */
const SCALE_BY_DISTANCE = new Cesium.NearFarScalar(2.0e5, 1.25, 8.0e6, 0.55);

/**
 * Own one river-gauge display: the national snapshot as point primitives
 * coloured by NWS flood category, click selection, and the selected gauge's
 * card with its flood stages and crests.
 *
 * A source resolves `getSnapshot({signal})` to `{gauges, generatedAt, stale,
 * failedRegions}` and `getGauge(lid, {signal})` to the trimmed detail
 * (records.js and server/providers/nwps.js own both shapes).
 */
export function createRiverGaugesLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  render = null,
  openExternal = null,
  screenSpaceEventHandlerFactory = null,
} = {}) {
  if (
    typeof source?.getSnapshot !== 'function' ||
    typeof source?.getGauge !== 'function'
  )
    throw new TypeError('River gauges require a gauge source');

  const state = {
    viewer: null,
    points: null,
    enabled: false,
    /** Displayed gauges by pick id. */
    records: new Map(),
    pointById: new Map(),
    counts: countRiverGauges([]),
    generatedAt: null,
    request: null,
    loading: false,
    lastUpdate: null,
    observedAt: null,
    error: null,
    stale: false,
    selectedId: null,
    cardId: null,
    details: new Map(),
    detailRequest: null,
    clickHandler: null,
    removePreRender: null,
    viewMatrix: new Cesium.Matrix4(),
    occluder: new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84),
  };

  const requestRender = (reason) => render?.governorRequestRender?.(reason);

  /** Hide points on the far side of the globe; depth testing is off for them. */
  function cull(force = false) {
    const viewer = state.viewer;
    const camera = viewer?.camera;
    if (!state.enabled || !state.points || !camera?.positionWC) return;
    if (
      !force &&
      camera.viewMatrix &&
      Cesium.Matrix4.equals(state.viewMatrix, camera.viewMatrix)
    )
      return;
    if (camera.viewMatrix)
      Cesium.Matrix4.clone(camera.viewMatrix, state.viewMatrix);
    state.occluder.cameraPosition = camera.positionWC;
    for (const point of state.pointById.values())
      point.show = state.occluder.isPointVisible(point.position);
  }

  function appearance(point, gauge, selected) {
    const category = riverGaugeCategory(gauge.observed.category);
    const color = Cesium.Color.fromCssColorString(category.color);
    point.color = category.dim ? color.withAlpha(0.55) : color;
    point.pixelSize = category.size + (selected ? 5 : 0);
    point.outlineColor = selected
      ? Cesium.Color.WHITE
      : Cesium.Color.BLACK.withAlpha(category.inFlood ? 0.9 : 0.5);
    point.outlineWidth = selected ? 3 : category.inFlood ? 1.5 : 0.5;
  }

  /** Replace the drawn gauges; flood gauges are added last so they draw on top. */
  function renderGauges(gauges) {
    state.points.removeAll();
    state.pointById.clear();
    state.records.clear();
    const ordered = [...gauges].sort(
      (a, b) =>
        riverGaugeCategory(b.observed.category).rank -
        riverGaugeCategory(a.observed.category).rank,
    );
    for (const gauge of ordered) {
      const point = state.points.add({
        id: gauge.id,
        position: Cesium.Cartesian3.fromDegrees(gauge.lon, gauge.lat),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: SCALE_BY_DISTANCE,
      });
      appearance(point, gauge, gauge.id === state.selectedId);
      state.pointById.set(gauge.id, point);
      state.records.set(gauge.id, gauge);
    }
    state.counts = countRiverGauges(gauges);
    cull(true);
    if (state.selectedId && !state.records.has(state.selectedId))
      clearSelection();
    else if (state.selectedId) publishCard();
    requestRender('river-gauges-render');
  }

  function publishCard() {
    const gauge = state.selectedId ? state.records.get(state.selectedId) : null;
    if (!gauge || !overlayHost) return;
    const link = Boolean(openExternal && riverGaugePageUrl(gauge.lid));
    const card = {
      ...buildRiverGaugeCard(
        gauge,
        state.details.has(gauge.lid) ? state.details.get(gauge.lid) : undefined,
        Date.now(),
        { link },
      ),
      position: Cesium.Cartesian3.fromDegrees(gauge.lon, gauge.lat),
    };
    if (link)
      card.activate = () => {
        openExternal(riverGaugePageUrl(gauge.lid));
        return true;
      };
    state.cardId = card.id;
    overlayHost.setEntries(
      RIVER_GAUGE_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
    requestRender('river-gauges-card');
  }

  function loadDetail(gauge) {
    if (state.details.has(gauge.lid)) return;
    state.detailRequest?.controller.abort();
    const request = { lid: gauge.lid, controller: new AbortController() };
    state.detailRequest = request;
    source
      .getGauge(gauge.lid, { signal: request.controller.signal })
      .then((detail) => {
        if (request.controller.signal.aborted) return;
        state.details.set(gauge.lid, detail);
      })
      .catch(() => {
        if (request.controller.signal.aborted) return;
        // The card says so; selecting the gauge again asks again.
        state.details.set(gauge.lid, null);
      })
      .finally(() => {
        if (state.detailRequest === request) state.detailRequest = null;
        if (
          !request.controller.signal.aborted &&
          state.selectedId === gauge.id &&
          state.enabled
        )
          publishCard();
      });
  }

  function select(id) {
    const gauge = state.records.get(id);
    if (!gauge) return false;
    if (state.selectedId && state.selectedId !== id) releaseHighlight();
    state.selectedId = id;
    if (state.details.get(gauge.lid) === null) state.details.delete(gauge.lid);
    const point = state.pointById.get(id);
    if (point) appearance(point, gauge, true);
    publishCard();
    loadDetail(gauge);
    return true;
  }

  function releaseHighlight() {
    const gauge = state.records.get(state.selectedId);
    const point = state.pointById.get(state.selectedId);
    if (gauge && point) appearance(point, gauge, false);
  }

  function clearSelection() {
    state.detailRequest?.controller.abort();
    state.detailRequest = null;
    if (state.selectedId) releaseHighlight();
    state.selectedId = null;
    state.cardId = null;
    overlayHost?.clearSource(RIVER_GAUGE_OVERLAY_SOURCE_ID);
    requestRender('river-gauges-card');
  }

  function pickedGaugeId(picked) {
    const id = picking?.resolvePickId
      ? picking.resolvePickId(picked)
      : typeof picked?.id === 'string'
        ? picked.id
        : null;
    return typeof id === 'string' &&
      id.startsWith(PICK_PREFIX) &&
      state.records.has(id)
      ? id
      : null;
  }

  function onClick(click) {
    if (!state.enabled || (pointer && !pointer.isPointerFree())) return;
    // A click on the selected card opens the gauge's NWPS page.
    const cardHit = overlayHost?.hitTest?.(
      click.position?.x,
      click.position?.y,
      {
        sourceId: RIVER_GAUGE_OVERLAY_SOURCE_ID,
      },
    );
    if (cardHit && cardHit.entryId === state.cardId) {
      const gauge = state.records.get(state.selectedId);
      const url = gauge ? riverGaugePageUrl(gauge.lid) : null;
      if (url && openExternal) openExternal(url);
      return;
    }
    const picked = state.viewer.scene.pick(click.position);
    const id = picked ? pickedGaugeId(picked) : null;
    if (id) {
      if (id === state.selectedId) clearSelection();
      else select(id);
      return;
    }
    // Another layer's object is not empty map: leave the selection alone.
    if (picked && picking?.isOwnedByOtherLayer) {
      const pickId = picking.resolvePickId(picked);
      if (pickId && picking.isOwnedByOtherLayer(LAYER_ID, pickId)) return;
    }
    if (state.selectedId) clearSelection();
  }

  /** Select the most severe gauge nearest the camera and fly to it. */
  function focusMostSevere() {
    const camera = state.viewer?.camera;
    if (!state.enabled || !camera?.positionWC || state.viewer.trackedEntity)
      return false;
    let best = null;
    let bestRank = Infinity;
    let bestDistance = Infinity;
    for (const gauge of state.records.values()) {
      const category = riverGaugeCategory(gauge.observed.category);
      if (!category.inFlood || category.rank > bestRank) continue;
      const distance = Cesium.Cartesian3.distanceSquared(
        camera.positionWC,
        state.pointById.get(gauge.id).position,
      );
      if (category.rank < bestRank || distance < bestDistance) {
        best = gauge;
        bestRank = category.rank;
        bestDistance = distance;
      }
    }
    if (!best || !select(best.id)) return false;
    camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(best.lon, best.lat),
        500,
      ),
      {
        duration: 1.5,
        offset: new Cesium.HeadingPitchRange(
          camera.heading || 0,
          -Math.PI / 3,
          60_000,
        ),
      },
    );
    return true;
  }

  function installClickHandler() {
    if (state.clickHandler || !state.viewer) return;
    state.clickHandler = screenSpaceEventHandlerFactory
      ? screenSpaceEventHandlerFactory(state.viewer)
      : new Cesium.ScreenSpaceEventHandler(state.viewer.scene.canvas);
    state.clickHandler.setInputAction(
      onClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  const layer = {
    id: LAYER_ID,
    name: 'River Flood Gauges',
    icon: '≋',
    // English in layer state; the layer row translates it.
    source: source.label || msg('NOAA NWPS · OBSERVED'),
    // The server rebuilds its national snapshot at most every 15 minutes.
    updateInterval: 300_000,

    init(viewer) {
      if (state.viewer)
        throw new Error('River gauge layer is already initialized');
      state.viewer = viewer;
      state.points = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection(),
      );
      state.points.show = false;
      overlayHost?.setVisible?.(RIVER_GAUGE_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      if (state.enabled) return;
      state.enabled = true;
      if (state.points) state.points.show = true;
      picking?.registerPickOwner?.(LAYER_ID, (id) => state.records.has(id));
      overlayHost?.setVisible?.(RIVER_GAUGE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      const scene = state.viewer?.scene;
      if (scene?.preRender && !state.removePreRender)
        state.removePreRender = scene.preRender.addEventListener(() =>
          cull(false),
        );
      cull(true);
      // DataLayerManager calls update() right after enable(); it owns the fetch.
    },

    disable() {
      state.enabled = false;
      state.request?.abort();
      state.request = null;
      state.loading = false;
      clearSelection();
      overlayHost?.setVisible?.(RIVER_GAUGE_OVERLAY_SOURCE_ID, false);
      picking?.unregisterPickOwner?.(LAYER_ID);
      state.clickHandler?.destroy();
      state.clickHandler = null;
      state.removePreRender?.();
      state.removePreRender = null;
      if (state.points) {
        state.points.removeAll();
        state.points.show = false;
      }
      state.pointById.clear();
      state.records.clear();
      state.counts = countRiverGauges([]);
      state.generatedAt = null;
      state.error = null;
      state.stale = false;
      requestRender('river-gauges-render');
    },

    async update() {
      if (!state.enabled || !state.points) return false;
      state.request?.abort();
      const request = new AbortController();
      state.request = request;
      state.loading = state.records.size === 0;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        // A superseded request, or one landing after disable, must not draw.
        if (
          request.signal.aborted ||
          state.request !== request ||
          !state.enabled
        )
          return false;
        if (
          snapshot.generatedAt === null ||
          snapshot.generatedAt !== state.generatedAt
        )
          renderGauges(snapshot.gauges);
        state.generatedAt = snapshot.generatedAt;
        state.lastUpdate = Date.now();
        state.observedAt = newestRiverGaugeObservation(snapshot.gauges);
        state.stale = snapshot.stale;
        state.error = null;
        return true;
      } catch (error) {
        if (
          request.signal.aborted ||
          state.request !== request ||
          !state.enabled
        )
          return false;
        state.error = error?.message || msg('River gauge source unavailable');
        // Gauges from an earlier snapshot stay up and read as stale.
        state.stale = state.records.size > 0;
        console.warn('[Data:RiverGauges] Refresh failed:', state.error);
        return false;
      } finally {
        if (state.request === request) {
          state.request = null;
          state.loading = false;
        }
        requestRender('river-gauges-status');
      }
    },

    destroy(viewer = state.viewer) {
      this.disable();
      if (state.points) viewer?.scene?.primitives?.remove(state.points);
      state.points = null;
      state.viewer = null;
      state.details.clear();
      state.lastUpdate = null;
      state.observedAt = null;
    },

    getRowControls() {
      const inFlood = countGaugesInFlood(state.counts);
      return {
        chips: [
          {
            id: 'river-gauges-most-severe',
            label: t('SHOW MOST SEVERE'),
            title: state.viewer?.trackedEntity
              ? t(
                  'Stop following the current object before navigating to a gauge',
                )
              : t(
                  'Move to the most severe flooding gauge and show its details',
                ),
            disabled:
              !state.enabled ||
              !inFlood ||
              Boolean(state.viewer?.trackedEntity),
            onClick: focusMostSevere,
          },
        ],
        legend: RIVER_GAUGE_CATEGORIES.map((category, index) => ({
          label: t(category.label),
          color: category.color,
          count: state.counts[category.id] || 0,
          ...(index === 0
            ? {
                blurb: t(
                  'Colour shows the NWS flood category of the latest reading. Categories come from NOAA; they are not flood warnings. Click a gauge for its flood stages and crests.',
                ),
              }
            : {}),
        })),
      };
    },

    /**
     * Gauges as JSON-safe records for the analyst query engine; [] while off.
     * @param {number} [maxCount=Infinity]
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!state.enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : Infinity;
      const result = [];
      for (const gauge of state.records.values()) {
        if (result.length >= limit) break;
        result.push(mapRiverGaugeAnalystRecord(gauge));
      }
      return result;
    },

    getStats() {
      const count = state.records.size;
      const pieces = [];
      for (const category of RIVER_GAUGE_CATEGORIES) {
        const n = state.counts[category.id] || 0;
        if (!category.inFlood || !n) continue;
        const values = { count: formatNumber(n) };
        if (category.id === 'major')
          pieces.push(tn(n, '{count} major', '{count} major', values));
        else if (category.id === 'moderate')
          pieces.push(tn(n, '{count} moderate', '{count} moderate', values));
        else if (category.id === 'minor')
          pieces.push(tn(n, '{count} minor', '{count} minor', values));
        else
          pieces.push(tn(n, '{count} at action', '{count} at action', values));
      }
      return {
        count,
        countLabel:
          state.enabled && count
            ? [
                tn(count, '{count} gauge', '{count} gauges', {
                  count: formatNumber(count),
                }),
                ...(pieces.length ? pieces : [t('none in flood')]),
              ].join(' · ')
            : '',
        countsByCategory: { ...state.counts },
        lastUpdate: state.lastUpdate,
        // When NWPS last measured, not when the snapshot arrived.
        observedAt: state.observedAt,
        stale: state.stale,
        error: state.error,
        loading: state.loading,
        loadingLabel: state.loading
          ? t('building the national gauge snapshot')
          : state.stale && !state.error
            ? t('Some regions not refreshed')
            : '',
      };
    },
  };
  return layer;
}
