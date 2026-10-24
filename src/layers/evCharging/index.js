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
export { createOpenChargeMapClient } from './openChargeMap.js';
export {
  mergeOcmSites,
  groundDistanceM,
  OCM_MATCH_DISTANCE_M,
} from './merge.js';

const LAYER_ID = 'ev-charging';
const REQUEST_DEBOUNCE_MS = 300;
/** The layer's own poll, which retries a failed view. */
export const EV_POLL_MS = 300_000;
/** Lime marks power, apart from the cyan ALPR badges and data centers. */
const EV_COLOR = '#9dff5c';
/** Amber marks a site only Open Charge Map lists. */
const OCM_ONLY_COLOR = '#ffb347';
/** OCM StatusType ids, in the app's words. */
const OCM_STATUS_LABELS = Object.freeze({
  0: msg('Status unknown'),
  10: msg('Available (automated status)'),
  20: msg('In use (automated status)'),
  30: msg('Temporarily unavailable'),
  50: msg('Operational'),
  75: msg('Partly operational'),
  100: msg('Not operational'),
  150: msg('Planned'),
});
/** Connector lines a card lists before summarising the rest. */
const CARD_CONNECTOR_LINES = 3;
/** DataProvider 1: records Open Charge Map's own contributors entered. */
const OCM_CONTRIBUTORS_PROVIDER = 1;
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
    /** The last read's Open Charge Map summary, or null without a key. */
    enrichment: null,
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

  const colorFor = (record) =>
    record?.origin === 'ocm' ? OCM_ONLY_COLOR : EV_COLOR;

  function setAppearance(entity, selected) {
    entity.point.pixelSize = selected ? 13 : 9;
    entity.point.color = selected
      ? Cesium.Color.WHITE
      : Cesium.Color.fromCssColorString(colorFor(entity.gevChargingRecord));
  }

  function registerContext(entity, record) {
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      dataSource: state.dataSource,
      layerName: 'EV Charging',
      source:
        record.origin === 'ocm'
          ? 'Open Charge Map' // i18n-ignore: provider name
          : source.attribution?.description || source.label,
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
            color: Cesium.Color.fromCssColorString(colorFor(record)),
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
      if (record.ocm?.provider)
        services.credits?.registerDynamicCredit?.(
          state.viewer,
          services.credits.openChargeMapCredit?.(record.ocm.provider),
        );
    }
    entities.resumeEvents();
    removeEntityContextsForLayer(LAYER_ID, { retainIds: new Set(next.keys()) });
    state.records = next;
    // A read without the selected station also closes its card.
    if (state.selectedId && !next.has(state.selectedId)) {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
    }
    // The on-map credit follows displayed OpenStreetMap stations, not loading
    // or prompts.
    if (records.some((record) => record.origin !== 'ocm'))
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
      details: record.ocm
        ? ocmCardDetails(record)
        : [
            t('EV CHARGING · OSM MAPPED'),
            coordinateLine(record),
            // i18n-ignore: attribution text is shown as the licensor requires
            '© OpenStreetMap contributors',
          ],
      accent: colorFor(record),
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

  function coordinateLine(record) {
    return `${formatCockpitCoordinate(record.latitude, 'N', 'S', 5)} ${formatCockpitCoordinate(record.longitude, 'E', 'W', 5)}`;
  }

  /**
   * Card lines for a station Open Charge Map describes. Operator, address,
   * connector names and cost are shown as published; status, counts and the
   * frame are the app's words.
   */
  function ocmCardDetails(record) {
    const site = record.ocm;
    const ocmOnly = record.origin === 'ocm';
    const lines = [
      ocmOnly
        ? t('EV CHARGING · OPEN CHARGE MAP')
        : t('EV CHARGING · OSM MAPPED · OPEN CHARGE MAP'),
    ];
    if (site.operator) lines.push(site.operator);
    if (ocmOnly && site.address) lines.push(site.address);
    const status = OCM_STATUS_LABELS[site.status?.id];
    if (status)
      lines.push(
        Number.isFinite(site.lastStatusUpdate)
          ? t('{status} · updated {date}', {
              status: t(status),
              date: new Date(site.lastStatusUpdate).toISOString().slice(0, 10),
            })
          : t(status),
      );
    // One line per connector type and power; OCM lists a connection per row,
    // and a row without a quantity counts as one connector.
    const groups = new Map();
    for (const connection of site.connections || []) {
      const key = `${connection.type ?? ''}|${connection.powerKw ?? ''}`;
      const group = groups.get(key) ?? {
        ...connection,
        count: 0,
        given: false,
      };
      group.count += connection.quantity ?? 1;
      group.given ||= Number.isInteger(connection.quantity);
      groups.set(key, group);
    }
    const connectors = [...groups.values()].map((group) =>
      [
        group.count > 1 || group.given ? `${group.count}×` : '',
        group.type || t('Connector'),
        group.powerKw
          ? t('{power} kW', { power: Math.round(group.powerKw * 10) / 10 })
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    lines.push(...connectors.slice(0, CARD_CONNECTOR_LINES));
    if (connectors.length > CARD_CONNECTOR_LINES)
      lines.push(
        tn(
          connectors.length - CARD_CONNECTOR_LINES,
          '+{count} more connector type',
          '+{count} more connector types',
        ),
      );
    if (site.numberOfPoints)
      lines.push(
        tn(
          site.numberOfPoints,
          '{count} charge point',
          '{count} charge points',
        ),
      );
    if (site.usageCost) lines.push(t('Cost: {cost}', { cost: site.usageCost }));
    lines.push(coordinateLine(record));
    // i18n-ignore: attribution text is shown as the licensor requires
    if (!ocmOnly) lines.push('© OpenStreetMap contributors');
    lines.push(ocmAttribution(site.provider));
    return lines;
  }

  function ocmAttribution(provider) {
    const licence = provider?.licence ? ` · ${provider.licence}` : '';
    return provider?.id === OCM_CONTRIBUTORS_PROVIDER
      ? // i18n-ignore: attribution text is shown as the licensor requires
        `© Open Charge Map contributors${licence}`
      : `${t('{provider} via Open Charge Map', { provider: provider?.name || '?' })}${licence}`;
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
    state.enrichment = null;
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
      state.enrichment = snapshot.enrichment ?? null;
      // A failed Open Charge Map read leaves the OpenStreetMap stations up and
      // names the enrichment's fault in its fixed form.
      state.error = state.enrichment?.error ?? null;
      state.stale = false;
      state.partial = snapshot.partial === true;
      state.saturated =
        snapshot.saturated === true || state.enrichment?.saturated === true;
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
      state.enrichment = null;
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
      const enrichment = state.enrichment;
      const ocmOnly = enrichment
        ? [...state.records.values()].filter(
            (record) => record.origin === 'ocm',
          ).length
        : 0;
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
        legend: enrichment
          ? [
              {
                label: t('Charging stations'),
                color: EV_COLOR,
                count: count - ocmOnly,
                blurb: t(
                  'Stations mapped in OpenStreetMap turn white when selected. Where Open Charge Map lists a site within 50 m, the card adds its connectors, power, operator and reported status; that status is what contributors last reported, not live availability.',
                ),
              },
              {
                label: t('Open Charge Map only'),
                color: OCM_ONLY_COLOR,
                count: ocmOnly,
                blurb: t(
                  'Sites Open Charge Map lists with no OpenStreetMap station within 50 m. Only openly licensed records are shown, credited to their data provider.',
                ),
              },
            ]
          : [
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
        ...(state.enrichment
          ? { source: msg('OpenStreetMap + Open Charge Map') }
          : {}),
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
