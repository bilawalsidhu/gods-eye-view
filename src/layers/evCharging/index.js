import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { formatCockpitCoordinate } from '../../ui/cockpitPresentation.js';
import { msg, t, tn } from '../../i18n/index.js';
export * from './records.js';
export {
  createChargingSource,
  chargingViewFits,
  CHARGING_MAX_TILES,
  CHARGING_STATION_LIMIT,
} from './source.js';

const LAYER_ID = 'ev-charging';
const REQUEST_DEBOUNCE_MS = 300;
/** The layer's own poll, which retries a failed view. */
export const EV_POLL_MS = 300_000;
/** Lime marks power, apart from the cyan ALPR badges and data centers. */
const EV_COLOR = '#9dff5c';
/** Ground plausibility window for a card anchor read from the floor cache. */
const MIN_FLOOR_M = -500;
const MAX_FLOOR_M = 10_000;

/**
 * Own one EV charging display: its viewport requests, point markers, click
 * selection and readout card. A source reads a bounded box with an
 * AbortSignal and resolves { records, zoomIn, partial, saturated, observedAt };
 * records carry a stable string id, latitude / longitude in degrees and the
 * name as published (or null). Provider decoding stays in the source.
 */
export function createEvChargingLayer({ source, services } = {}) {
  if (typeof source?.getStations !== 'function')
    throw new TypeError('EV charging requires a station source');
  const { governorRequestRender } = services.render;
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context;

  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    /** Displayed stations by id. */
    records: new Map(),
    selectedId: null,
    request: null,
    loading: false,
    debounceTimer: null,
    pollTimer: null,
    moveEndRemove: null,
    clickHandler: null,
    lastUpdate: null,
    /** Planet build time of the displayed stations. */
    observedAt: null,
    error: null,
    status: 'idle',
    stale: false,
    partial: false,
    saturated: false,
  };

  /**
   * A box around the ground at the view centre, sized by the camera range.
   * The horizon rectangle of a tilted view spans far past what is legible, so
   * it is only the fallback for viewers that cannot pick the ellipsoid.
   * @returns {{south:number, west:number, north:number, east:number}|null}
   */
  function viewBox() {
    const viewer = state.viewer;
    const camera = viewer?.camera;
    const canvas = viewer?.scene?.canvas;
    const toDeg = Cesium.Math.toDegrees;
    if (typeof camera?.pickEllipsoid === 'function' && canvas) {
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (!width || !height) return null;
      const focus = camera.pickEllipsoid(
        new Cesium.Cartesian2(width / 2, height / 2),
        viewer.scene.globe.ellipsoid,
      );
      if (!focus) return null;
      const location = Cesium.Cartographic.fromCartesian(focus);
      const range = Cesium.Cartesian3.distance(camera.positionWC, focus);
      const latSpan = Math.max(500, range) / 111_320;
      const lonSpan = latSpan / Math.cos(location.latitude);
      const latitude = toDeg(location.latitude);
      const longitude = toDeg(location.longitude);
      if (
        !Number.isFinite(latSpan + lonSpan) ||
        Math.abs(latitude) + latSpan > 85 ||
        Math.abs(longitude) + lonSpan > 180
      )
        return null;
      return {
        south: latitude - latSpan,
        west: longitude - lonSpan,
        north: latitude + latSpan,
        east: longitude + lonSpan,
      };
    }
    const rectangle = camera?.computeViewRectangle?.(
      viewer.scene.globe.ellipsoid,
    );
    if (!rectangle) return null;
    const box = {
      south: toDeg(rectangle.south),
      west: toDeg(rectangle.west),
      north: toDeg(rectangle.north),
      east: toDeg(rectangle.east),
    };
    // A rectangle across the antimeridian is never city-scale.
    return box.east > box.west ? box : null;
  }

  function setAppearance(entity, selected) {
    entity.point.pixelSize = selected ? 13 : 9;
    entity.point.color = selected
      ? Cesium.Color.WHITE
      : Cesium.Color.fromCssColorString(EV_COLOR);
  }

  function registerContext(entity, record) {
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      dataSource: state.dataSource,
      layerName: 'EV Charging',
      source: source.attribution?.description || source.label,
      label: record.name || t('EV charging station'),
      latitude: record.latitude,
      longitude: record.longitude,
      properties: { name: record.name },
    });
  }

  /** Show `records`, keeping the markers of stations that stay in view. */
  function renderRecords(records) {
    const next = new Map(records.map((record) => [record.id, record]));
    const entities = state.dataSource.entities;
    entities.suspendEvents();
    for (const entity of [...entities.values])
      if (!next.has(entity.id)) entities.remove(entity);
    for (const record of records) {
      const position = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
      );
      let entity = entities.getById(record.id);
      if (!entity) {
        entity = entities.add({
          id: record.id,
          position,
          point: {
            pixelSize: 9,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            color: Cesium.Color.fromCssColorString(EV_COLOR),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      } else if (
        entity.gevChargingRecord.latitude !== record.latitude ||
        entity.gevChargingRecord.longitude !== record.longitude
      ) {
        entity.position = position;
      }
      entity.gevChargingRecord = record;
      registerContext(entity, record);
    }
    entities.resumeEvents();
    removeEntityContextsForLayer(LAYER_ID, { retainIds: new Set(next.keys()) });
    state.records = next;
    // A read without the selected station also closes its card.
    if (state.selectedId && !next.has(state.selectedId)) {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
    }
    // The on-map credit follows displayed stations, not loading or prompts.
    if (next.size)
      services.credits?.showOsmCredit?.(state.viewer, LAYER_ID, {
        openMapTiles: true,
      });
    else services.credits?.hideOsmCredit?.(state.viewer, LAYER_ID);
    governorRequestRender('ev-charging-render');
  }

  function clearRendered() {
    state.dataSource?.entities.removeAll();
    state.records = new Map();
    if (state.selectedId) clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
    removeEntityContextsForLayer(LAYER_ID);
    services.credits?.hideOsmCredit?.(state.viewer, LAYER_ID);
    governorRequestRender('ev-charging-render');
  }

  /** The point the readout card leads to: the cached floor, else sea level. */
  function anchorFor(record) {
    const floor = services.groundFloor?.cachedGroundFloor?.(
      record.latitude,
      record.longitude,
    );
    return Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      Number.isFinite(floor) && floor >= MIN_FLOOR_M && floor <= MAX_FLOOR_M
        ? floor
        : 0,
    );
  }

  function selectRecord(id) {
    const entity = state.dataSource?.entities.getById(id);
    const record = state.records.get(id);
    if (!entity || !record) return false;
    releaseSelection();
    state.selectedId = id;
    setAppearance(entity, true);
    const anchor = anchorFor(record);
    entity.gevTrackedId = id;
    entity.gevDisplayPosition = () => anchor;
    // The name stays as published; only the app's own words translate.
    entity.gevLabelModel = {
      title: record.name || t('EV charging station'),
      details: [
        t('EV CHARGING · OSM MAPPED'),
        `${formatCockpitCoordinate(record.latitude, 'N', 'S', 5)} ${formatCockpitCoordinate(record.longitude, 'E', 'W', 5)}`,
        // i18n-ignore: attribution text is shown as the licensor requires
        '© OpenStreetMap contributors',
      ],
      accent: EV_COLOR,
      cardStyle: 'tactical',
      selected: true,
      leaderStyle: 'elbow',
      anchorRadiusPx: 7,
      anchorRadiusScale: null,
    };
    selectEntityContext(entity);
    governorRequestRender('ev-charging-selection');
    return true;
  }

  /** Drop this layer's selection; another layer's newer one stays intact. */
  function releaseSelection() {
    const entity = state.selectedId
      ? state.dataSource?.entities.getById(state.selectedId)
      : null;
    if (entity) setAppearance(entity, false);
    if (!state.selectedId) return;
    state.selectedId = null;
    clearSelectedEntityContextForLayer(LAYER_ID);
    governorRequestRender('ev-charging-selection');
  }

  /** Another layer or a voice action took the shared selection. */
  function syncContextSelection() {
    if (state.selectedId && getSelectedEntityContext()?.id !== state.selectedId)
      releaseSelection();
  }

  function focusNearest() {
    const camera = state.viewer?.camera;
    if (!state.enabled || !camera?.positionWC || state.viewer.trackedEntity)
      return false;
    let nearest = null,
      distance = Infinity;
    for (const record of state.records.values()) {
      const candidate = Cesium.Cartesian3.distanceSquared(
        camera.positionWC,
        Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude),
      );
      if (candidate < distance) {
        nearest = record;
        distance = candidate;
      }
    }
    if (!nearest || !selectRecord(nearest.id)) return false;
    camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(anchorFor(nearest), 30),
      {
        duration: 1.2,
        offset: new Cesium.HeadingPitchRange(
          camera.heading || 0,
          -Math.PI / 4,
          800,
        ),
      },
    );
    return true;
  }

  function showZoomIn() {
    clearRendered();
    state.status = 'zoom-in';
    state.error = null;
    state.stale = false;
    state.partial = false;
    state.saturated = false;
  }

  function scheduleLoad() {
    if (!state.enabled) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      loadStations();
    }, REQUEST_DEBOUNCE_MS);
  }

  async function loadStations() {
    if (!state.enabled || !state.viewer) return false;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    // A request for a view the user has left must not replace this one.
    state.request?.abort();
    state.request = null;
    const box = viewBox();
    if (!box) {
      state.loading = false;
      showZoomIn();
      return false;
    }
    const request = new AbortController();
    state.request = request;
    state.loading = true;
    governorRequestRender('ev-charging-status');
    try {
      const snapshot = await source.getStations(box, {
        signal: request.signal,
      });
      // A superseded or aborted request must not touch the scene, and neither
      // must one that lands after the layer was switched off.
      if (request.signal.aborted || state.request !== request || !state.enabled)
        return false;
      if (snapshot.zoomIn) {
        showZoomIn();
        return true;
      }
      renderRecords(snapshot.records);
      state.lastUpdate = Date.now();
      state.observedAt = snapshot.observedAt ?? null;
      state.error = null;
      state.stale = false;
      state.partial = snapshot.partial === true;
      state.saturated = snapshot.saturated === true;
      state.status = state.records.size ? 'ready' : 'empty';
      return true;
    } catch (error) {
      if (
        error?.name === 'AbortError' ||
        request.signal.aborted ||
        state.request !== request ||
        !state.enabled
      )
        return false;
      state.error = error?.message || msg('EV charging source unavailable');
      // Markers from an earlier read stay up and are reported as such.
      state.stale = state.records.size > 0;
      state.status = state.stale ? 'stale' : 'unavailable';
      console.warn('[Data:EvCharging] Refresh failed:', state.error);
      return false;
    } finally {
      if (state.request === request) {
        state.request = null;
        state.loading = false;
      }
      governorRequestRender('ev-charging-status');
    }
  }

  const layer = {
    id: LAYER_ID,
    name: 'EV Charging',
    icon: '🔌',
    // English in layer state; the layer row translates it.
    source: source.label || msg('OpenStreetMap · community mapped'),
    // Camera moves drive requests and the layer's own poll (EV_POLL_MS)
    // retries a failed view; tiles already read answer from the cache without
    // a request. With no manager interval the manager ticks the row every
    // second, so a camera-driven read shows without waiting for a poll.
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      if (state.viewer)
        throw new Error('EV charging layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource(LAYER_ID);
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
      state.moveEndRemove =
        viewer.camera.moveEnd.addEventListener(scheduleLoad);
      for (const event of [
        'gev:entity-selected',
        'gev:entity-selection-cleared',
      ])
        globalThis.window?.addEventListener?.(event, syncContextSelection);
      state.clickHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      state.clickHandler.setInputAction((click) => {
        // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
        if (!isPointerFree() || !state.enabled) return;
        const picked = viewer.scene.pick(click.position);
        const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
        if (id && state.records.has(id) && id !== state.selectedId)
          selectRecord(id);
        // Clicking the selected station again or empty map releases it.
        else releaseSelection();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      if (state.enabled) return;
      state.enabled = true;
      registerPickOwner(LAYER_ID, (id) => state.records.has(id));
      clearInterval(state.pollTimer);
      state.pollTimer = setInterval(loadStations, EV_POLL_MS);
      if (state.dataSource) state.dataSource.show = true;
      // DataLayerManager calls update() right after enable(); it owns the first fetch.
    },

    disable() {
      state.enabled = false;
      // Abort in flight: a response arriving after disable must not redraw.
      state.request?.abort();
      state.request = null;
      state.loading = false;
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      unregisterPickOwner(LAYER_ID);
      releaseSelection();
      clearRendered();
      if (state.dataSource) state.dataSource.show = false;
      state.status = 'idle';
      state.error = null;
      state.stale = false;
      state.partial = false;
      state.saturated = false;
    },

    update() {
      return loadStations();
    },

    destroy(viewer = state.viewer) {
      this.disable();
      source.destroy?.();
      state.moveEndRemove?.();
      state.moveEndRemove = null;
      for (const event of [
        'gev:entity-selected',
        'gev:entity-selection-cleared',
      ])
        globalThis.window?.removeEventListener?.(event, syncContextSelection);
      state.clickHandler?.destroy();
      state.clickHandler = null;
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.viewer = null;
      state.lastUpdate = null;
      state.observedAt = null;
    },

    getRowControls() {
      const count = state.records.size;
      return {
        chips: [
          {
            id: 'find-charger',
            label: t('SHOW NEAREST'),
            title: state.viewer?.trackedEntity
              ? t(
                  'Stop following the current object before navigating to a charging station',
                )
              : t(
                  'Move to the nearest loaded charging station and show its details',
                ),
            disabled:
              !state.enabled || !count || Boolean(state.viewer?.trackedEntity),
            onClick: focusNearest,
          },
        ],
        legend: [
          {
            label: t('Charging stations'),
            color: EV_COLOR,
            count,
            blurb: t(
              'Stations mapped in OpenStreetMap turn white when selected. The map data names them; it carries no sockets, power or live availability.',
            ),
          },
        ],
      };
    },

    getStats() {
      const count = state.records.size;
      return {
        count,
        countLabel:
          state.enabled && state.status !== 'zoom-in'
            ? tn(count, '{count} nearby', '{count} nearby')
            : '',
        lastUpdate: state.lastUpdate,
        // When OpenStreetMap was extracted into the tiles, not when they arrived.
        observedAt: state.observedAt,
        stale: state.stale,
        partial: state.partial,
        saturated: state.saturated,
        error: state.error,
        status: state.status,
        loading: state.loading,
        loadingLabel: state.loading
          ? t('loading charging stations')
          : state.status === 'zoom-in'
            ? t('Zoom in to load charging stations')
            : [
                state.stale ? t('Showing cached locations') : '',
                state.saturated ? t('Coverage limited — zoom in') : '',
                state.status === 'empty'
                  ? t('No charging stations mapped in this area')
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
      };
    },
  };
  return layer;
}
