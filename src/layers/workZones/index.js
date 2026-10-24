import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { translateFeedError } from '../../ui/statusText.js';
import { msg, t } from '../../i18n/index.js';
import {
  feedSummary,
  workZoneBand,
  workZoneCardModel,
  workZoneCountLabel,
  workZoneLegend,
} from './presentation.js';
export * from './presentation.js';
export { createWorkZoneSource } from './source.js';

const LAYER_ID = 'work-zones';
const ENTITY_PREFIX = 'work-zones:';
/** Ground plausibility window for a card anchor read from the floor cache. */
const MIN_FLOOR_M = -500;
const MAX_FLOOR_M = 10_000;
/**
 * Markers nearer than this draw over terrain and buildings; further ones are
 * depth-tested, so a continental view never shows markers through the globe.
 */
const MARKER_DEPTH_TEST_M = 50_000;
const SELECTED_COLOR = '#ffffff';

const markerEntityId = (eventId) => `${ENTITY_PREFIX}${eventId}`;

/**
 * Own the US work zone display: the shared WZDx snapshot, ground-clamped
 * lines and markers coloured by lane impact, click selection and its card.
 * A source resolves { feeds, events, ageMs, linesDropped } (source.js).
 */
export function createWorkZonesLayer({ source, services } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Work zones require a snapshot source');
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
    /** Displayed events by id, with their entities and draw signature. */
    events: new Map(),
    /** Entity id → event id, for picks on markers and lines alike. */
    owners: new Map(),
    feeds: [],
    publishers: new Map(),
    selectedId: null,
    request: null,
    loading: false,
    clickHandler: null,
    lastUpdate: null,
    observedAt: null,
    linesDropped: 0,
    error: null,
    status: 'idle',
    stale: false,
    partial: false,
  };

  function lineMaterial(band, selected) {
    const color = Cesium.Color.fromCssColorString(
      selected ? SELECTED_COLOR : band.color,
    ).withAlpha(selected ? 1 : band.alpha);
    return band.dashed
      ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 12 })
      : new Cesium.ColorMaterialProperty(color);
  }

  function setAppearance(entry, selected) {
    const band = workZoneBand(entry.event);
    entry.marker.point.pixelSize = selected
      ? band.pixelSize + 5
      : band.pixelSize;
    entry.marker.point.color = Cesium.Color.fromCssColorString(
      selected ? SELECTED_COLOR : band.color,
    );
    for (const line of entry.lines) {
      line.polyline.material = lineMaterial(band, selected);
      line.polyline.width = selected ? band.width + 2 : band.width;
    }
  }

  function addEntities(event) {
    const band = workZoneBand(event);
    const entities = state.dataSource.entities;
    const id = markerEntityId(event.id);
    const marker = entities.add({
      id,
      position: Cesium.Cartesian3.fromDegrees(event.anchor[0], event.anchor[1]),
      point: {
        pixelSize: band.pixelSize,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        color: Cesium.Color.fromCssColorString(band.color),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        disableDepthTestDistance: MARKER_DEPTH_TEST_M,
      },
    });
    state.owners.set(id, event.id);
    const lines = event.lines.map((line, index) => {
      const lineId = `${id}|line|${index}`;
      state.owners.set(lineId, event.id);
      return entities.add({
        id: lineId,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(line.flat()),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
          width: band.width,
          material: lineMaterial(band, false),
        },
      });
    });
    return { marker, lines };
  }

  function removeEntities(entry) {
    const entities = state.dataSource.entities;
    for (const entity of [entry.marker, ...entry.lines]) {
      state.owners.delete(entity.id);
      entities.remove(entity);
    }
  }

  /** Show `events`, keeping entities whose event did not change. */
  function renderEvents(events) {
    const next = new Map();
    state.dataSource.entities.suspendEvents();
    try {
      const incoming = new Map(events.map((event) => [event.id, event]));
      for (const [id, entry] of state.events)
        if (!incoming.has(id)) removeEntities(entry);
      for (const event of events) {
        const signature = JSON.stringify(event);
        const previous = state.events.get(event.id);
        if (previous?.signature === signature) {
          next.set(event.id, previous);
          continue;
        }
        if (previous) removeEntities(previous);
        next.set(event.id, { event, signature, ...addEntities(event) });
      }
    } finally {
      state.dataSource.entities.resumeEvents();
    }
    state.events = next;
    if (state.selectedId) {
      const entry = next.get(state.selectedId);
      // A refresh without the selected event closes its card; a changed one
      // reopens it on the new entities.
      if (!entry) releaseSelection();
      else if (!entry.selectedCard) selectEvent(state.selectedId);
    }
    governorRequestRender('work-zones-render');
  }

  function clearRendered() {
    releaseSelection();
    state.dataSource?.entities.removeAll();
    state.events = new Map();
    state.owners = new Map();
    governorRequestRender('work-zones-render');
  }

  /** The point the card leads to: the cached floor, else sea level. */
  function anchorFor(event) {
    const [longitude, latitude] = event.anchor;
    const floor = services.groundFloor?.cachedGroundFloor?.(
      latitude,
      longitude,
    );
    return Cesium.Cartesian3.fromDegrees(
      longitude,
      latitude,
      Number.isFinite(floor) && floor >= MIN_FLOOR_M && floor <= MAX_FLOOR_M
        ? floor
        : 0,
    );
  }

  function selectEvent(id) {
    const entry = state.events.get(id);
    if (!entry) return false;
    if (state.selectedId && state.selectedId !== id) releaseSelection();
    for (const other of state.events.values()) other.selectedCard = false;
    state.selectedId = id;
    entry.selectedCard = true;
    setAppearance(entry, true);
    const { event, marker } = entry;
    const anchor = anchorFor(event);
    const publisher = state.publishers.get(event.feed) ?? event.feed ?? 'WZDx';
    marker.gevTrackedId = marker.id;
    marker.gevDisplayPosition = () => anchor;
    marker.gevLabelModel = workZoneCardModel(event, { publisher });
    // Only the selected event is a context record: four thousand markers
    // would otherwise sit in the shared store for nothing.
    registerEntityContext(marker, {
      id: marker.id,
      layerId: LAYER_ID,
      dataSource: state.dataSource,
      layerName: 'US Work Zones',
      source: publisher,
      label: event.roads.join(' / ') || t('Unnamed road'),
      latitude: event.anchor[1],
      longitude: event.anchor[0],
      properties: {
        type: event.type,
        impact: event.impact,
        direction: event.direction,
        start: event.start,
        end: event.end,
      },
    });
    selectEntityContext(marker);
    governorRequestRender('work-zones-selection');
    return true;
  }

  /** Drop this layer's selection; another layer's newer one stays intact. */
  function releaseSelection() {
    if (!state.selectedId) return;
    const entry = state.events.get(state.selectedId);
    if (entry) {
      entry.selectedCard = false;
      setAppearance(entry, false);
    }
    state.selectedId = null;
    clearSelectedEntityContextForLayer(LAYER_ID);
    removeEntityContextsForLayer(LAYER_ID);
    governorRequestRender('work-zones-selection');
  }

  /** Another layer or a voice action took the shared selection. */
  function syncContextSelection() {
    if (
      state.selectedId &&
      getSelectedEntityContext()?.id !== markerEntityId(state.selectedId)
    )
      releaseSelection();
  }

  function updateFeeds(feeds) {
    state.feeds = feeds;
    state.publishers = new Map(feeds.map((feed) => [feed.id, feed.publisher]));
    const shown = feeds.filter((feed) => feed.status !== 'unavailable');
    state.partial =
      shown.length < feeds.length || feeds.some((f) => f.status === 'stale');
    // Stale when nothing is live: every event shown is from an earlier read.
    state.stale = shown.length > 0 && !feeds.some((f) => f.status === 'live');
    const ages = shown.map((feed) => feed.ageMs).filter(Number.isFinite);
    state.observedAt = ages.length ? Date.now() - Math.max(...ages) : null;
  }

  async function load() {
    if (!state.enabled || !state.viewer) return false;
    state.request?.abort();
    const request = new AbortController();
    state.request = request;
    state.loading = true;
    governorRequestRender('work-zones-status');
    try {
      const snapshot = await source.getSnapshot({ signal: request.signal });
      // A superseded or aborted read must not touch the scene, and neither
      // must one that lands after the layer was switched off.
      if (request.signal.aborted || state.request !== request || !state.enabled)
        return false;
      updateFeeds(snapshot.feeds);
      renderEvents(snapshot.events);
      state.linesDropped = snapshot.linesDropped;
      state.lastUpdate = Date.now();
      state.error = null;
      state.status = state.events.size ? 'ready' : 'empty';
      return true;
    } catch (error) {
      if (
        error?.name === 'AbortError' ||
        request.signal.aborted ||
        state.request !== request ||
        !state.enabled
      )
        return false;
      state.error = error?.message || msg('Work zone source unavailable');
      // Events from an earlier read stay up and are reported as such.
      state.stale = state.events.size > 0;
      state.status = state.stale ? 'stale' : 'unavailable';
      console.warn('[Data:WorkZones] Refresh failed:', state.error);
      return false;
    } finally {
      if (state.request === request) {
        state.request = null;
        state.loading = false;
      }
      governorRequestRender('work-zones-status');
    }
  }

  const layer = {
    id: LAYER_ID,
    name: 'US Work Zones',
    icon: '🚧',
    // English in layer state; the layer row translates it.
    source: source.label || msg('WZDx · US state DOTs'),
    // The proxy rebuilds its shared snapshot at most every five minutes.
    updateInterval: 300_000,
    statsRefreshInterval: 1000,

    init(viewer) {
      if (state.viewer)
        throw new Error('Work zone layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource(LAYER_ID);
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
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
        const entityId =
          typeof picked?.id?.id === 'string' ? picked.id.id : null;
        const id = entityId ? state.owners.get(entityId) : null;
        if (id && id !== state.selectedId) selectEvent(id);
        // Clicking the selected work zone again or empty map releases it.
        else if (!entityId || id) releaseSelection();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      if (state.enabled) return;
      state.enabled = true;
      registerPickOwner(LAYER_ID, (id) => state.owners.has(id));
      if (state.dataSource) state.dataSource.show = true;
      // DataLayerManager calls update() right after enable(); it owns the first fetch.
    },

    disable() {
      state.enabled = false;
      // Abort in flight: a response arriving after disable must not redraw.
      state.request?.abort();
      state.request = null;
      state.loading = false;
      unregisterPickOwner(LAYER_ID);
      clearRendered();
      if (state.dataSource) state.dataSource.show = false;
      state.status = 'idle';
      state.error = null;
      state.stale = false;
      state.partial = false;
      state.feeds = [];
    },

    update() {
      return load();
    },

    destroy(viewer = state.viewer) {
      this.disable();
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
      const events = [...state.events.values()].map((entry) => entry.event);
      const summary = state.feeds.length ? feedSummary(state.feeds) : '';
      return {
        chips: [],
        info: [
          summary ? translateFeedError(summary) : '',
          state.linesDropped
            ? t('{count} long work zones shown as markers only', {
                count: state.linesDropped,
              })
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
        infoTitle: t(
          'US state DOT Work Zone Data Exchange (WZDx) feeds, read by this server every five minutes and shared by every viewer. Only states with a keyless, CC0 feed are included; elsewhere the map is empty because no feed is read, not because there is no work.',
        ),
        legend: workZoneLegend(events),
      };
    },

    getStats() {
      const count = state.events.size;
      return {
        count,
        countLabel: state.enabled && count ? workZoneCountLabel(count) : '',
        lastUpdate: state.lastUpdate,
        // When the oldest feed shown was read upstream, not when it arrived.
        observedAt: state.observedAt,
        stale: state.stale,
        partial: state.partial,
        error: state.error,
        status: state.status,
        loading: state.loading,
        feeds: state.feeds.map(({ id, status, count: feedCount }) => ({
          id,
          status,
          count: feedCount,
        })),
        loadingLabel: state.loading
          ? t('loading work zones')
          : state.status === 'empty'
            ? t('No current work zones in the configured feeds')
            : '',
      };
    },
  };
  return layer;
}
