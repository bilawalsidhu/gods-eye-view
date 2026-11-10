import * as Cesium from 'cesium';
import { msg, t, tn, formatNumber } from '../../i18n/index.js';
import {
  SEA_LEVEL_FRESHNESS,
  countSeaLevelStations,
  newestSeaLevelReading,
  seaLevelFreshness,
  seaLevelStationPageUrl,
} from './records.js';
import { SEA_LEVEL_OVERLAY_SOURCE_ID, buildSeaLevelCard } from './cards.js';
export * from './records.js';
export * from './cards.js';
export { createSeaLevelSource } from './source.js';

const LAYER_ID = 'sea-level-stations';
const PICK_PREFIX = 'sea-level:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Points shrink with range so a world view stays legible. */
const SCALE_BY_DISTANCE = new Cesium.NearFarScalar(2.0e5, 1.4, 1.0e7, 0.6);

/**
 * Own one sea level station display: the IOC snapshot as point primitives
 * coloured by how recently each station reported, click selection, and the
 * selected station's card with its last 72 hours.
 *
 * A source resolves `getSnapshot({signal})` to `{stations, generatedAt,
 * stale}` and `getStation(code, {signal})` to the normalised series
 * (records.js and server/providers/seaLevel.js own both shapes).
 */
export function createSeaLevelLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  render = null,
  openExternal = null,
  screenSpaceEventHandlerFactory = null,
  now = () => Date.now(),
} = {}) {
  if (
    typeof source?.getSnapshot !== 'function' ||
    typeof source?.getStation !== 'function'
  )
    throw new TypeError('Sea level stations require a station source');

  const state = {
    viewer: null,
    points: null,
    enabled: false,
    /** Displayed stations by pick id. */
    records: new Map(),
    pointById: new Map(),
    counts: countSeaLevelStations([]),
    /** When the drawn snapshot arrived, on this clock. */
    receivedAt: null,
    request: null,
    loading: false,
    lastUpdate: null,
    observedAt: null,
    error: null,
    stale: false,
    selectedId: null,
    cardId: null,
    series: new Map(),
    seriesRequest: null,
    clickHandler: null,
    removePreRender: null,
    viewMatrix: new Cesium.Matrix4(),
    occluder: new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84),
  };

  const requestRender = (reason) => render?.governorRequestRender?.(reason);

  /** A station's reading age now: its age on arrival plus time since. */
  function ageNow(station) {
    if (!Number.isFinite(station.ageMs) || state.receivedAt === null)
      return null;
    return station.ageMs + Math.max(0, now() - state.receivedAt);
  }

  /** Hide points on the far side of the globe; depth testing is off for them. */
  function cull(force = false) {
    const camera = state.viewer?.camera;
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

  function appearance(point, station, selected) {
    const band = seaLevelFreshness(station.ageMs);
    const color = Cesium.Color.fromCssColorString(band.color);
    point.color = band.dim ? color.withAlpha(0.55) : color;
    point.pixelSize = band.size + (selected ? 5 : 0);
    point.outlineColor = selected
      ? Cesium.Color.WHITE
      : Cesium.Color.BLACK.withAlpha(band.dim ? 0.4 : 0.8);
    point.outlineWidth = selected ? 3 : band.dim ? 0.5 : 1;
  }

  /** Replace the drawn stations; reporting ones are added last, on top. */
  function renderStations(stations) {
    state.points.removeAll();
    state.pointById.clear();
    state.records.clear();
    const ordered = [...stations].sort(
      (a, b) =>
        seaLevelFreshness(b.ageMs).rank - seaLevelFreshness(a.ageMs).rank,
    );
    for (const station of ordered) {
      const point = state.points.add({
        id: station.id,
        position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: SCALE_BY_DISTANCE,
      });
      appearance(point, station, station.id === state.selectedId);
      state.pointById.set(station.id, point);
      state.records.set(station.id, station);
    }
    state.counts = countSeaLevelStations(stations);
    cull(true);
    if (state.selectedId && !state.records.has(state.selectedId))
      clearSelection();
    else if (state.selectedId) publishCard();
    requestRender('sea-level-render');
  }

  function publishCard() {
    const station = state.selectedId
      ? state.records.get(state.selectedId)
      : null;
    if (!station || !overlayHost) return;
    const url = seaLevelStationPageUrl(station.code);
    const link = Boolean(openExternal && url);
    const card = {
      ...buildSeaLevelCard(
        station,
        state.series.has(station.code)
          ? state.series.get(station.code)
          : undefined,
        { ageMs: ageNow(station), link },
      ),
      position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat),
    };
    if (link)
      card.activate = () => {
        openExternal(url);
        return true;
      };
    state.cardId = card.id;
    overlayHost.setEntries(
      SEA_LEVEL_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
    requestRender('sea-level-card');
  }

  function loadSeries(station) {
    if (state.series.has(station.code)) return;
    state.seriesRequest?.controller.abort();
    const request = { code: station.code, controller: new AbortController() };
    state.seriesRequest = request;
    source
      .getStation(station.code, { signal: request.controller.signal })
      .then((series) => {
        if (request.controller.signal.aborted) return;
        state.series.set(station.code, series);
      })
      .catch(() => {
        if (request.controller.signal.aborted) return;
        // The card says so; selecting the station again asks again.
        state.series.set(station.code, null);
      })
      .finally(() => {
        if (state.seriesRequest === request) state.seriesRequest = null;
        if (
          !request.controller.signal.aborted &&
          state.selectedId === station.id &&
          state.enabled
        )
          publishCard();
      });
  }

  function select(id) {
    const station = state.records.get(id);
    if (!station) return false;
    if (state.selectedId && state.selectedId !== id) releaseHighlight();
    state.selectedId = id;
    if (state.series.get(station.code) === null)
      state.series.delete(station.code);
    const point = state.pointById.get(id);
    if (point) appearance(point, station, true);
    publishCard();
    loadSeries(station);
    return true;
  }

  function releaseHighlight() {
    const station = state.records.get(state.selectedId);
    const point = state.pointById.get(state.selectedId);
    if (station && point) appearance(point, station, false);
  }

  function clearSelection() {
    state.seriesRequest?.controller.abort();
    state.seriesRequest = null;
    if (state.selectedId) releaseHighlight();
    state.selectedId = null;
    state.cardId = null;
    overlayHost?.clearSource(SEA_LEVEL_OVERLAY_SOURCE_ID);
    requestRender('sea-level-card');
  }

  function pickedStationId(picked) {
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
    // A click on the selected card opens the station's IOC page.
    const cardHit = overlayHost?.hitTest?.(
      click.position?.x,
      click.position?.y,
      { sourceId: SEA_LEVEL_OVERLAY_SOURCE_ID },
    );
    if (cardHit && cardHit.entryId === state.cardId) {
      const station = state.records.get(state.selectedId);
      const url = station ? seaLevelStationPageUrl(station.code) : null;
      if (url && openExternal) openExternal(url);
      return;
    }
    const picked = state.viewer.scene.pick(click.position);
    const id = picked ? pickedStationId(picked) : null;
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
    name: 'Sea level stations',
    icon: '≈',
    // English in layer state; the layer row translates it.
    source: source.label || msg('IOC / VLIZ · RAW'),
    // The server reads the IOC list at most every 10 minutes.
    updateInterval: 600_000,

    init(viewer) {
      if (state.viewer)
        throw new Error('Sea level layer is already initialized');
      state.viewer = viewer;
      state.points = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection(),
      );
      state.points.show = false;
      overlayHost?.setVisible?.(SEA_LEVEL_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      if (state.enabled) return;
      state.enabled = true;
      if (state.points) state.points.show = true;
      picking?.registerPickOwner?.(LAYER_ID, (id) => state.records.has(id));
      overlayHost?.setVisible?.(SEA_LEVEL_OVERLAY_SOURCE_ID, true);
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
      overlayHost?.setVisible?.(SEA_LEVEL_OVERLAY_SOURCE_ID, false);
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
      state.counts = countSeaLevelStations([]);
      state.receivedAt = null;
      state.error = null;
      state.stale = false;
      requestRender('sea-level-render');
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
        // Ages move on even when the snapshot is the same, so always redraw.
        state.receivedAt = now();
        renderStations(snapshot.stations);
        state.lastUpdate = Date.now();
        state.observedAt = newestSeaLevelReading(snapshot.stations);
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
        state.error = error?.message || msg('Sea level source unavailable');
        // Stations from an earlier snapshot stay up and read as stale.
        state.stale = state.records.size > 0;
        console.warn('[Data:SeaLevel] Refresh failed:', state.error);
        return false;
      } finally {
        if (state.request === request) {
          state.request = null;
          state.loading = false;
        }
        requestRender('sea-level-status');
      }
    },

    destroy(viewer = state.viewer) {
      this.disable();
      if (state.points) viewer?.scene?.primitives?.remove(state.points);
      state.points = null;
      state.viewer = null;
      state.series.clear();
      state.lastUpdate = null;
      state.observedAt = null;
    },

    getRowControls() {
      return {
        legend: SEA_LEVEL_FRESHNESS.map((band, index) => ({
          label: t(band.label),
          color: band.color,
          count: state.counts[band.id] || 0,
          ...(index === 0
            ? {
                blurb: t(
                  'Colour shows how recently each tide gauge reported, never the level: every gauge has its own datum. Raw data, not quality controlled. Click a station for its last 72 hours.',
                ),
              }
            : {}),
        })),
      };
    },

    getStats() {
      const count = state.records.size;
      const reporting = state.counts.reporting || 0;
      return {
        count,
        countLabel:
          state.enabled && count
            ? [
                tn(reporting, '{count} reporting', '{count} reporting', {
                  count: formatNumber(reporting),
                }),
                tn(count, '{count} station', '{count} stations', {
                  count: formatNumber(count),
                }),
              ].join(' · ')
            : '',
        countsByFreshness: { ...state.counts },
        lastUpdate: state.lastUpdate,
        // When the newest gauge last measured, not when the snapshot arrived.
        observedAt: state.observedAt,
        stale: state.stale,
        error: state.error,
        loading: state.loading,
      };
    },
  };
  return layer;
}
