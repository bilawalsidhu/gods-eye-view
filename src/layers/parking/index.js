import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { formatCockpitBriefAge } from '../../ui/cockpitPresentation.js';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { occupancyBand } from './records.js';
export * from './records.js';
export {
  createParkingSource,
  parkingViewFits,
  PARKING_API_ROOT,
  PARKING_MAX_SPAN_DEG,
  PARKING_SITE_LIMIT,
} from './source.js';

const LAYER_ID = 'parking';
const REQUEST_DEBOUNCE_MS = 300;
/**
 * Free counts are re-read this often while the layer is on; ParkAPI's pull
 * sources report every few minutes.
 */
export const PARKING_POLL_MS = 300_000;
/** Ground plausibility window for a card anchor read from the floor cache. */
const MIN_FLOOR_M = -500;
const MAX_FLOOR_M = 10_000;

/**
 * Point colour per occupancy band. Live sites run green to red by the share
 * of spaces free; a site without a live count stays a neutral grey, so a
 * static capacity is never read as availability.
 */
const BAND_STYLE = Object.freeze({
  free: Object.freeze({ color: '#3ddc84', label: msg('30% or more free') }),
  filling: Object.freeze({ color: '#ffb02e', label: msg('10–30% free') }),
  full: Object.freeze({ color: '#ff4d4f', label: msg('Under 10% free') }),
  static: Object.freeze({ color: '#9aa4ad', label: msg('No live count') }),
});
const BAND_ORDER = Object.freeze(['free', 'filling', 'full', 'static']);

/** Card type line per ParkAPI `type`; any other type reads as parking alone. */
const TYPE_LABELS = Object.freeze({
  UNDERGROUND: msg('UNDERGROUND GARAGE'),
  CAR_PARK: msg('MULTI-STOREY CAR PARK'),
  OFF_STREET_PARKING_GROUND: msg('SURFACE CAR PARK'),
});

/** Bigger garages draw bigger points: 7 px up to 13 px at 2,000+ spaces. */
function pointSize(record) {
  const capacity = record.capacity || 0;
  return Math.round(
    Math.min(13, Math.max(7, 7 + 1.8 * Math.log10(Math.max(1, capacity / 10)))),
  );
}

/**
 * The detail lines of one site's card. Names, operators and addresses stay
 * as published; only the app's own words translate.
 * @param {object} record Parking record.
 * @returns {string[]} Card lines.
 */
export function parkingCardDetails(record) {
  const lines = [
    TYPE_LABELS[record.type]
      ? `${t('PARKING')} · ${t(TYPE_LABELS[record.type])}`
      : t('PARKING'),
  ];
  if (record.free !== null) {
    const total = record.liveCapacity || record.capacity;
    lines.push(
      total
        ? t('{free} FREE OF {capacity}', {
            free: formatNumber(record.free),
            capacity: formatNumber(total),
          })
        : t('{free} FREE', { free: formatNumber(record.free) }),
    );
    if (record.updatedAt !== null)
      lines.push(
        t('LIVE · UPDATED {age}', {
          age: formatCockpitBriefAge(new Date(record.updatedAt).toISOString()),
        }),
      );
  } else {
    lines.push(
      record.capacity !== null
        ? tn(
            record.capacity,
            '{count} SPACE · NO LIVE COUNT',
            '{count} SPACES · NO LIVE COUNT',
            { count: formatNumber(record.capacity) },
          )
        : t('NO LIVE COUNT'),
    );
  }
  const reserved = [
    record.disabled
      ? tn(
          record.disabled,
          '{count} DISABLED SPACE',
          '{count} DISABLED SPACES',
          {
            count: formatNumber(record.disabled),
          },
        )
      : '',
    record.charging
      ? tn(
          record.charging,
          '{count} CHARGING SPACE',
          '{count} CHARGING SPACES',
          {
            count: formatNumber(record.charging),
          },
        )
      : '',
  ].filter(Boolean);
  if (reserved.length) lines.push(reserved.join(' · '));
  if (record.operator) lines.push(record.operator);
  if (record.address) lines.push(record.address);
  lines.push(
    record.contributor
      ? // i18n-ignore: attribution text is shown as the licensor requires
        `MobiData BW · ParkAPI, dl-de/by-2-0 · ${record.contributor}`
      : // i18n-ignore: attribution text is shown as the licensor requires
        'MobiData BW · ParkAPI, dl-de/by-2-0',
  );
  return lines;
}

/**
 * Own one parking display: its viewport requests, point markers, click
 * selection and readout card. A source reads a bounded box with an
 * AbortSignal and resolves { records, zoomIn, partial, saturated, observedAt };
 * records come from `normalizeParkingSite` (plus a `contributor`). Provider
 * decoding stays in the source.
 */
export function createParkingLayer({
  source,
  services,
  openLink = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  if (typeof source?.getSites !== 'function')
    throw new TypeError('Parking requires a parking-site source');
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
    /** Displayed sites by id. */
    records: new Map(),
    selectedId: null,
    request: null,
    loading: false,
    debounceTimer: null,
    pollTimer: null,
    moveEndRemove: null,
    clickHandler: null,
    lastUpdate: null,
    /** Newest live reading among the displayed sites. */
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
    const record = entity.gevParkingRecord;
    entity.point.pixelSize = pointSize(record) + (selected ? 4 : 0);
    entity.point.color = selected
      ? Cesium.Color.WHITE
      : Cesium.Color.fromCssColorString(
          BAND_STYLE[occupancyBand(record)].color,
        );
  }

  function registerContext(entity, record) {
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      dataSource: state.dataSource,
      layerName: 'Parking',
      source: source.attribution?.description || source.label,
      label: record.name || t('Parking site'),
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        name: record.name,
        type: record.type,
        capacity: record.capacity,
        free: record.free,
        updatedAt: record.updatedAt,
      },
    });
  }

  /** Show `records`, keeping the markers of sites that stay in view. */
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
            pixelSize: pointSize(record),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      } else if (
        entity.gevParkingRecord.latitude !== record.latitude ||
        entity.gevParkingRecord.longitude !== record.longitude
      ) {
        entity.position = position;
      }
      entity.gevParkingRecord = record;
      setAppearance(entity, record.id === state.selectedId);
      registerContext(entity, record);
    }
    entities.resumeEvents();
    removeEntityContextsForLayer(LAYER_ID, { retainIds: new Set(next.keys()) });
    state.records = next;
    // A read without the selected site also closes its card; one that still
    // has it refreshes the card's free count.
    if (state.selectedId && !next.has(state.selectedId)) {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
    } else if (state.selectedId) {
      const entity = entities.getById(state.selectedId);
      if (entity?.gevLabelModel) {
        entity.gevLabelModel = {
          ...entity.gevLabelModel,
          title: next.get(state.selectedId).name || t('Parking site'),
          details: parkingCardDetails(next.get(state.selectedId)),
        };
        services.readout?.refreshTrackedReadout?.(entity);
      }
    }
    if (next.size)
      services.credits?.registerDynamicCredit?.(
        state.viewer,
        services.credits.PARKING_CREDIT,
      );
    governorRequestRender('parking-render');
  }

  function clearRendered() {
    state.dataSource?.entities.removeAll();
    state.records = new Map();
    if (state.selectedId) clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
    removeEntityContextsForLayer(LAYER_ID);
    governorRequestRender('parking-render');
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
    entity.gevLabelModel = {
      title: record.name || t('Parking site'),
      details: parkingCardDetails(record),
      accent: BAND_STYLE[occupancyBand(record)].color,
      cardStyle: 'tactical',
      selected: true,
      leaderStyle: 'elbow',
      anchorRadiusPx: 7,
      anchorRadiusScale: null,
    };
    selectEntityContext(entity);
    governorRequestRender('parking-selection');
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
    governorRequestRender('parking-selection');
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

  function openSelectedPage() {
    const url = state.records.get(state.selectedId)?.url;
    if (!state.enabled || !url) return false;
    openLink(url);
    return true;
  }

  function showZoomIn() {
    clearRendered();
    state.status = 'zoom-in';
    state.error = null;
    state.stale = false;
    state.partial = false;
    state.saturated = false;
    state.observedAt = null;
  }

  function scheduleLoad() {
    if (!state.enabled) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      loadSites();
    }, REQUEST_DEBOUNCE_MS);
  }

  async function loadSites() {
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
    governorRequestRender('parking-status');
    try {
      const snapshot = await source.getSites(box, { signal: request.signal });
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
      state.error = error?.message || msg('Parking source unavailable');
      // Sites from an earlier read stay up and are reported as such.
      state.stale = state.records.size > 0;
      state.status = state.stale ? 'stale' : 'unavailable';
      console.warn('[Data:Parking] Refresh failed:', state.error);
      return false;
    } finally {
      if (state.request === request) {
        state.request = null;
        state.loading = false;
      }
      governorRequestRender('parking-status');
    }
  }

  function bandCounts() {
    const counts = { free: 0, filling: 0, full: 0, static: 0 };
    for (const record of state.records.values())
      counts[occupancyBand(record)] += 1;
    return counts;
  }

  const layer = {
    id: LAYER_ID,
    name: 'Parking',
    icon: '🅿️',
    source: source.label || 'MobiData BW · ParkAPI',
    // Camera moves drive requests and the layer's own poll refreshes free
    // counts (PARKING_POLL_MS). With no manager interval the manager ticks the
    // row every second, so camera-driven reads show without waiting for a poll.
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      if (state.viewer) throw new Error('Parking layer is already initialized');
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
        // Clicking the selected site again or empty map releases it.
        else releaseSelection();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      if (state.enabled) return;
      state.enabled = true;
      registerPickOwner(LAYER_ID, (id) => state.records.has(id));
      clearInterval(state.pollTimer);
      state.pollTimer = setInterval(loadSites, PARKING_POLL_MS);
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
      state.observedAt = null;
    },

    update() {
      return loadSites();
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
    },

    getRowControls() {
      const count = state.records.size;
      const selected = state.records.get(state.selectedId);
      const counts = bandCounts();
      return {
        chips: [
          {
            id: 'find-parking',
            label: t('SHOW NEAREST', { context: 'parking' }),
            title: state.viewer?.trackedEntity
              ? t(
                  'Stop following the current object before navigating to a parking site',
                )
              : t(
                  'Move to the nearest loaded parking site and show its details',
                ),
            disabled:
              !state.enabled || !count || Boolean(state.viewer?.trackedEntity),
            onClick: focusNearest,
          },
          {
            id: 'parking-page',
            label: t('OPERATOR PAGE'),
            title: selected?.url
              ? t("Open the selected site's page from its operator")
              : t('Select a parking site that publishes a page'),
            disabled: !state.enabled || !selected?.url,
            onClick: openSelectedPage,
          },
        ],
        legend: BAND_ORDER.map((band) => ({
          label: t(BAND_STYLE[band].label),
          color: BAND_STYLE[band].color,
          count: counts[band],
          ...(band === 'static'
            ? {
                blurb: t(
                  'Car parks and garages published by ParkAPI, mostly in Baden-Württemberg. Colour is the share of spaces free where the operator reports a live count; grey sites publish only their capacity. Kerbside street parking is not shown.',
                ),
              }
            : {}),
        })),
      };
    },

    getStats() {
      const count = state.records.size;
      const live = count - bandCounts().static;
      return {
        count,
        countLabel:
          state.enabled && state.status !== 'zoom-in'
            ? count
              ? tn(
                  count,
                  '{count} site · {live} live',
                  '{count} sites · {live} live',
                  {
                    live: formatNumber(live),
                  },
                )
              : tn(count, '{count} site', '{count} sites')
            : '',
        lastUpdate: state.lastUpdate,
        // The newest free count the operators reported, not the fetch time.
        observedAt: state.observedAt,
        stale: state.stale,
        partial: state.partial,
        saturated: state.saturated,
        error: state.error,
        status: state.status,
        loading: state.loading,
        loadingLabel: state.loading
          ? t('loading parking sites')
          : state.status === 'zoom-in'
            ? t('Zoom in to load parking sites')
            : [
                state.stale ? t('Showing cached locations') : '',
                state.saturated ? t('Coverage limited — zoom in') : '',
                state.status === 'empty'
                  ? t('No ParkAPI coverage in this view')
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
      };
    },
  };
  return layer;
}
