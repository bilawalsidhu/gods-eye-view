import * as Cesium from 'cesium';
import {
  GDACS_LEVELS,
  GDACS_LEVEL_COLORS,
  GDACS_LEVEL_NAMES,
  GDACS_TYPE_NAMES,
} from './records.js';
export * from './records.js';
export { createGdacsSource } from './source.js';

const LAYER_ID = 'gdacs-alerts';
const ENTITY_PREFIX = `${LAYER_ID}:`;
const MARKER_PX = Object.freeze({ red: 15, orange: 12, green: 8 });
const SELECTED_PX = 19;
/** Levels whose event names are always labelled on the globe. */
const LABELLED = new Set(['red', 'orange']);
const LABEL_PRIORITY = Object.freeze({ red: 3000, orange: 2000, green: 1000 });
const LABEL_LIMIT = 64;
const LABEL_MAX_CHARS = 40;
const DISCLAIMER =
  'GDACS alerts are automatic estimates of likely humanitarian impact. They do not replace official information or warnings from local or national disaster management authorities.';
const CAVEAT = 'Automatic impact estimates, not official warnings';
/** The caveat every published selection carries downstream. */
export const GDACS_SELECTION_CAVEAT =
  'automatic estimate, not official warning';
const LAYER_NAME = 'Disaster Alerts';

const utc = (ms) =>
  Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'unknown';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * A globe label short enough to sit beside its point. GDACS names multi-country
 * events "Drought in A, B, C"; the label keeps the first country and a count.
 */
export function gdacsLabelTitle(name) {
  const list = /^(.+? in )([^,]+)((?:, [^,]+)+)$/.exec(name);
  if (!list) return clip(name, LABEL_MAX_CHARS);
  const more = ` +${list[3].split(',').length - 1}`;
  return `${clip(`${list[1]}${list[2]}`, LABEL_MAX_CHARS - more.length)}${more}`;
}

const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * The normalized shared-context record for one selected GDACS event, as
 * `gev:entity-selected` publishes it. The location is the event centroid
 * GDACS reports: a single point, never the affected area, so the record
 * carries no polygon, footprint or extent.
 * @param {object} event Sanitized GDACS event record.
 * @param {{fetchedAt?: number|null}} [provenance] Snapshot provenance.
 * @returns {object} Context metadata for `registerEntityContext`.
 */
export function gdacsSelectionContext(event, { fetchedAt = null } = {}) {
  const updatedAt = event.modifiedMs ?? event.toMs ?? event.fromMs ?? null;
  return {
    id: `${ENTITY_PREFIX}${event.id}`,
    layerId: LAYER_ID,
    layerName: LAYER_NAME,
    kind: 'disaster-alert',
    source: 'GDACS',
    label: event.name,
    latitude: event.lat,
    longitude: event.lon,
    geometryKind: 'point',
    locationKind: 'centroid',
    caveat: GDACS_SELECTION_CAVEAT,
    provenance: {
      source: 'GDACS',
      reportUrl: event.reportUrl || null,
      eventId: event.eventId,
      episodeId: event.episodeId,
      eventType: event.type,
      alertLevel: event.level,
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
      updatedAt,
    },
    properties: {
      gdacsId: event.id,
      eventType: GDACS_TYPE_NAMES[event.type] || event.type,
      alertLevel: GDACS_LEVEL_NAMES[event.level] || event.level,
      country: event.country || null,
      severity: event.severity || null,
      current: event.current === true,
      reportUrl: event.reportUrl || null,
      location: 'event centroid (point), not the affected area',
      caveat: GDACS_SELECTION_CAVEAT,
    },
  };
}

/**
 * Own one GDACS alert display: the event centroids GDACS publishes for
 * earthquakes, tropical cyclones, floods, volcanoes, droughts and wildfires,
 * coloured by alert level and selectable from the globe or the row list.
 * Globe selection needs the application's `picking` registry and `pointer`
 * ownership; without them the row list still selects and focuses events.
 * Event names are world-overlay labels, drawn only when an `overlayHost` is
 * supplied. With the application `context` store the selected event is
 * published on the shared `gev:entity-selected` lane and released through
 * `gev:entity-selection-cleared` when GDACS still owns the selection.
 */
export function createGdacsAlertsLayer({
  source,
  cesium = Cesium,
  now = () => Date.now(),
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
  picking = null,
  pointer = null,
  overlayHost = null,
  context = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GDACS alerts require a snapshot source');
  const C = cesium;
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _events = [];
  let _missing = [];
  let _signature = null;
  let _selectedId = null;
  let _lastUpdate = null;
  let _fetchedAt = null;
  let _lastError = null;
  let _stale = false;
  let _listener = null;
  let _runNavigation = null;
  let _clickHandler = null;
  let _removePreRender = null;
  let _occluder = null;
  let _navigationGeneration = 0;
  let _labelIds = [];
  /** entity id -> event id, for picks and ownership. */
  const _entityEvents = new Map();
  /** event id -> { entity, position } */
  const _markers = new Map();

  const notify = () => _listener?.();
  const requestRender = () => {
    if (!_viewer?.isDestroyed?.()) _viewer?.scene?.requestRender?.();
  };
  const selected = () =>
    _events.find((event) => event.id === _selectedId) || null;

  // Points are drawn over terrain and 3D tiles, so the far side of the globe
  // has to be hidden by hand.
  function cullHorizon() {
    _occluder.cameraPosition = _viewer.camera.positionWC;
    let changed = false;
    for (const { entity, position } of _markers.values()) {
      const show = _occluder.isPointVisible(position);
      if (entity.show !== show) {
        entity.show = show;
        changed = true;
      }
    }
    if (changed) requestRender();
  }

  function syncHorizonListener() {
    const scene = _viewer?.scene;
    if (!_enabled || !_markers.size || !scene?.preRender) {
      _removePreRender?.();
      _removePreRender = null;
      return;
    }
    if (_removePreRender) return;
    _occluder ||= new C.EllipsoidalOccluder(
      C.Ellipsoid.WGS84,
      _viewer.camera.positionWC,
    );
    _removePreRender = scene.preRender.addEventListener(cullHorizon);
  }

  function styleMarker(event, entity) {
    const active = event.id === _selectedId;
    entity.point.pixelSize = active ? SELECTED_PX : MARKER_PX[event.level];
    entity.point.outlineColor = active ? C.Color.WHITE : C.Color.BLACK;
    entity.point.outlineWidth = active ? 3 : 1.5;
  }

  /** Name red and orange events, and the selected one, on the globe. */
  function publishLabels() {
    if (!overlayHost || !_enabled) return;
    const entries = _events
      .filter(
        (event) =>
          _markers.has(event.id) &&
          (event.id === _selectedId || LABELLED.has(event.level)),
      )
      .map((event) => {
        const active = event.id === _selectedId;
        return {
          id: event.id,
          position: _markers.get(event.id).position,
          variant: 'label',
          title: gdacsLabelTitle(event.name),
          accent: GDACS_LEVEL_COLORS[event.level],
          priority: LABEL_PRIORITY[event.level] + (active ? 10_000 : 0),
          protected: active,
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 14,
          verticalOnly: true,
          placement: 'above',
        };
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, LABEL_LIMIT);
    _labelIds = entries.map(({ id }) => id);
    overlayHost.setEntries(LAYER_ID, entries, {
      cohortLimit: LABEL_LIMIT,
      collisionCapacity: 32,
      moving: false,
    });
  }

  function clearLabels() {
    _labelIds = [];
    overlayHost?.clearSource(LAYER_ID);
    overlayHost?.setVisible(LAYER_ID, false);
  }

  function render() {
    // Only what is drawn decides a rebuild; a fresh fetch of the same
    // events leaves the entities alone.
    const signature = JSON.stringify(
      _events.map(({ id, level, lon, lat, name }) => [
        id,
        level,
        lon,
        lat,
        name,
      ]),
    );
    if (signature === _signature) return;
    _signature = signature;
    _dataSource.entities.removeAll();
    _entityEvents.clear();
    _markers.clear();
    for (const event of _events) {
      const id = `${ENTITY_PREFIX}${event.id}`;
      const position = C.Cartesian3.fromDegrees(event.lon, event.lat, 0);
      const color = C.Color.fromCssColorString(GDACS_LEVEL_COLORS[event.level]);
      const entity = _dataSource.entities.add(
        new C.Entity({
          id,
          name: event.name,
          position,
          point: {
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            pixelSize: MARKER_PX[event.level],
            color,
            outlineColor: C.Color.BLACK,
            outlineWidth: 1.5,
          },
        }),
      );
      _entityEvents.set(id, event.id);
      _markers.set(event.id, { entity, position });
      if (event.id === _selectedId) styleMarker(event, entity);
    }
    syncHorizonListener();
    publishLabels();
    requestRender();
  }

  /**
   * Publish the selected event into the shared context store, or release it.
   * A sibling layer's selection is never cleared: the store only clears a
   * record GDACS owns.
   */
  function publishContext(event, { evicted = false } = {}) {
    if (!context) return;
    try {
      if (!event) {
        context.clearSelectedEntityContextForLayer(LAYER_ID, { evicted });
        context.removeEntityContextsForLayer(LAYER_ID);
        return;
      }
      const metadata = gdacsSelectionContext(event, { fetchedAt: _fetchedAt });
      const carrier = {
        show: true,
        // The point voice's visible-entity scan projects: the centroid.
        __localBaseCartesian:
          _markers.get(event.id)?.position ||
          C.Cartesian3.fromDegrees(event.lon, event.lat, 0),
      };
      context.registerEntityContext(carrier, {
        ...metadata,
        dataSource: _dataSource,
      });
      context.selectEntityContext(carrier);
      context.removeEntityContextsForLayer(LAYER_ID, {
        retainIds: new Set([metadata.id]),
      });
    } catch (e) {
      // The local selection still works without the shared store.
      console.warn('[Data:GDACS] Selection context unavailable:', e);
    }
  }

  function ownsContextSelection() {
    if (!context) return true;
    try {
      const store = context.getContextStore();
      return store.entities.get(store.selectedEntityId)?.layerId === LAYER_ID;
    } catch {
      return true;
    }
  }

  /** Refresh the published record in place after a fetch, without reselecting. */
  function refreshContext() {
    const event = selected();
    if (!context || !event) return;
    try {
      const metadata = gdacsSelectionContext(event, { fetchedAt: _fetchedAt });
      const existing = context.getContextStore().entities.get(metadata.id);
      if (existing?.layerId === LAYER_ID)
        context.registerEntityContext(existing.entity, {
          ...metadata,
          dataSource: _dataSource,
        });
    } catch {
      // store unavailable: nothing to refresh
    }
  }

  function select(id, { evicted = false } = {}) {
    if (_selectedId !== id) ++_navigationGeneration;
    const previous = _selectedId;
    _selectedId = id;
    for (const eventId of [previous, id]) {
      const marker = eventId && _markers.get(eventId);
      const event = marker && _events.find((entry) => entry.id === eventId);
      if (event) styleMarker(event, marker.entity);
    }
    if (previous !== id) {
      publishLabels();
      publishContext(selected(), { evicted });
    } else if (id && !ownsContextSelection()) {
      // Re-choosing the event after a sibling layer took the shared
      // selection claims it back.
      publishContext(selected());
    }
    requestRender();
  }

  // Photorealistic 3D Tiles pick as tileset content without an entity id;
  // that is empty map, the same as no pick at all on the globe.
  const isSurfacePick = (picked) =>
    !picked ||
    (picked.id === undefined &&
      (picked.content !== undefined ||
        (typeof C.Cesium3DTileset === 'function' &&
          picked.primitive instanceof C.Cesium3DTileset)));

  function installSelection() {
    const canvas = _viewer?.scene?.canvas;
    if (
      _clickHandler ||
      !picking ||
      !canvas ||
      typeof C.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const owner = new C.ScreenSpaceEventHandler(canvas);
    _clickHandler = owner;
    owner.setInputAction((click) => {
      // Ambient selection yields to draw tools and Director; it never claims
      // the pointer, camera or tracking state.
      if (
        !_enabled ||
        _clickHandler !== owner ||
        (pointer && !pointer.isPointerFree()) ||
        !click?.position
      )
        return;
      const picked = _viewer.scene.pick(click.position);
      const pickedId = picking.resolvePickId(picked);
      const eventId = pickedId ? _entityEvents.get(pickedId) : null;
      if (eventId) {
        layer.setParams({ eventId });
        return;
      }
      // A sibling layer's pick (an aircraft, a vessel) is not empty map.
      if (pickedId && picking.isOwnedByOtherLayer(LAYER_ID, pickedId)) return;
      if (_selectedId && isSurfacePick(picked))
        layer.setParams({ clear: true });
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeSelection() {
    const owner = _clickHandler;
    _clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }

  function detailLines(event) {
    const period =
      event.fromMs && event.toMs && event.toMs - event.fromMs >= 60_000
        ? `${utc(event.fromMs)} to ${utc(event.toMs)}`
        : utc(event.toMs ?? event.fromMs);
    return [
      event.name,
      `${GDACS_LEVEL_NAMES[event.level]} alert · ${GDACS_TYPE_NAMES[event.type]}${event.country ? ` · ${event.country}` : ''}`,
      event.severity,
      period,
      event.current ? '' : 'Episode no longer marked current by GDACS',
    ].filter(Boolean);
  }

  // The legend carries the per-level counts; the summary names the total.
  function summaryLines() {
    return [
      _events.length
        ? plural(_events.length, 'event')
        : _lastUpdate
          ? 'No GDACS events on the map'
          : _lastError
            ? 'GDACS alerts unavailable'
            : 'Loading GDACS alerts…',
      _missing.length
        ? `No data this refresh: ${_missing.map((type) => GDACS_TYPE_NAMES[type] || type).join(', ')}`
        : '',
      _stale ? 'Some feeds are cached copies' : '',
      _lastError && _events.length ? `Last refresh failed: ${_lastError}` : '',
      CAVEAT,
    ].filter(Boolean);
  }

  const layer = {
    id: LAYER_ID,
    name: LAYER_NAME,
    icon: '⚠',
    source: 'GDACS',
    updateInterval: 600_000,

    init(viewer) {
      if (_viewer) throw new Error('GDACS alerts layer is already initialized');
      _viewer = viewer;
      _dataSource = new C.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost?.setVisible(LAYER_ID, false);
    },

    attachShellServices(services) {
      _runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
    },

    enable() {
      if (_enabled) return;
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      picking?.registerPickOwner(
        LAYER_ID,
        (id) => _enabled && _entityEvents.has(String(id)),
      );
      installSelection();
      syncHorizonListener();
      overlayHost?.setVisible(LAYER_ID, true);
      publishLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      picking?.unregisterPickOwner(LAYER_ID);
      removeSelection();
      syncHorizonListener();
      if (_selectedId) select(null);
      clearLabels();
      if (_dataSource) _dataSource.show = false;
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
        _events = snapshot.events;
        _missing = snapshot.missing || [];
        _fetchedAt = Number.isFinite(snapshot.fetchedAt)
          ? snapshot.fetchedAt
          : now();
        // Rebuild the markers before a selection change republishes labels.
        render();
        if (_selectedId && !_events.some((event) => event.id === _selectedId))
          select(null, { evicted: true });
        else refreshContext();
        _stale = snapshot.stale === true;
        _lastUpdate = now();
        _lastError = null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:GDACS] Fetch error:', e);
        _lastError = e?.message || 'GDACS alerts unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
        notify();
      }
    },

    setParams(params = {}) {
      if (!_enabled) return;
      if (params.clear === true || params.eventId === null) {
        select(null);
        notify();
      } else if (
        typeof params.eventId === 'string' &&
        _events.some((event) => event.id === params.eventId)
      ) {
        select(params.eventId);
        notify();
      }
      const event = selected();
      if (params.focus === true && event && _runNavigation) {
        const generation = ++_navigationGeneration;
        _runNavigation(() => {
          if (
            !_enabled ||
            generation !== _navigationGeneration ||
            _selectedId !== event.id
          )
            return;
          return _viewer.camera.flyTo({
            destination: C.Cartesian3.fromDegrees(
              event.lon,
              event.lat,
              1_500_000,
            ),
            duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
              ? 0
              : 1.4,
          });
        });
      }
      if (params.report === true && event?.reportUrl)
        openExternal(event.reportUrl);
    },

    getRowControls() {
      const event = selected();
      return {
        chips: event?.reportUrl
          ? [
              {
                id: 'report',
                label: 'GDACS report ↗',
                title: `Open the GDACS report for ${event.name} in a new tab`,
                params: { report: true },
              },
            ]
          : [],
        legend: GDACS_LEVELS.map((level, index) => ({
          label: GDACS_LEVEL_NAMES[level],
          color: GDACS_LEVEL_COLORS[level],
          count: _events.filter((entry) => entry.level === level).length,
          ...(index === 0 ? { blurb: DISCLAIMER } : {}),
        })),
        list: {
          ariaLabel: 'GDACS events, most severe first',
          items: _events.map((entry, index) => ({
            id: entry.id,
            ordinal: index + 1,
            // GDACS names already say the hazard ("Flood in China").
            lead: GDACS_LEVEL_NAMES[entry.level].toUpperCase(),
            text: `${entry.name}${entry.severity ? ` · ${entry.severity}` : ''}`,
            active: entry.id === _selectedId,
            params: { eventId: entry.id, focus: true },
          })),
        },
        // The row renders info as one wrapped paragraph.
        info: (event ? detailLines(event) : summaryLines()).join(' · '),
        infoTitle: `Select an event on the map, or choose one in the list to select it and move the camera. Click empty map space to clear the selection. Points mark the event centre GDACS publishes, not the affected area. ${DISCLAIMER}`,
      };
    },

    setRowControlsListener(value) {
      _listener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: _events.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        partial: _missing.length > 0,
      };
    },

    getDiagnostics() {
      return {
        enabled: _enabled,
        requestPending: Boolean(_request),
        selectionActive: _clickHandler !== null,
        horizonCulling: _removePreRender !== null,
        selectedId: _selectedId,
        entities: _markers.size,
        labels: [..._labelIds],
      };
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _events = [];
      _missing = [];
      _signature = null;
      _entityEvents.clear();
      _markers.clear();
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _occluder = null;
      _listener = null;
      _runNavigation = null;
      _lastUpdate = null;
      _fetchedAt = null;
      _lastError = null;
      _stale = false;
    },
  };
  return layer;
}
