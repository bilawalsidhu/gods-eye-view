import * as Cesium from 'cesium';
import {
  RADIATION_BANDS,
  RADIATION_BAND_COLORS,
  RADIATION_SOURCE_NAMES,
  SAFECAST_CPM_PER_USVH,
  radiationBand,
} from './records.js';
export * from './records.js';
export { createRadiationSource } from './source.js';

const LAYER_ID = 'radiation';
const ENTITY_PREFIX = `${LAYER_ID}:`;
const MARKER_PX = Object.freeze({
  high: 13,
  raised: 11,
  elevated: 8,
  typical: 6,
});
const SELECTED_PX = 16;
/** Bands whose readings are always labelled on the globe. */
const LABELLED = new Set(['high', 'raised']);
const LABEL_PRIORITY = Object.freeze({
  high: 3000,
  raised: 2000,
  elevated: 1000,
  typical: 0,
});
const LABEL_LIMIT = 32;
const LABEL_MAX_CHARS = 40;
/** The row lists only the highest readings; the globe shows them all. */
const LIST_LIMIT = 25;
const FOCUS_HEIGHT_M = 300_000;
const SOURCE_PAGES = Object.freeze({
  bfs: 'https://odlinfo.bfs.de/ODL/EN/home/home_node.html',
  safecast: 'https://map.safecast.org/',
});
const DISCLAIMER = `Ambient gamma dose rate at each station or sensor. Natural background is typically 0.05–0.3 µSv/h and varies with altitude, geology and rain. BfS ODL values are official 1-hour means; Safecast values are volunteer sensor readings converted from counts per minute (${SAFECAST_CPM_PER_USVH} CPM = 1 µSv/h for the LND 7318 tube). Not an official warning: follow your national authority.`;
const CAVEAT = 'Ambient dose rate, not an official warning';

const utc = (ms) =>
  Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'unknown';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
/** µSv/h with the precision a reading supports. */
export const formatDose = (usvh) =>
  usvh >= 10 ? usvh.toFixed(1) : usvh >= 1 ? usvh.toFixed(2) : usvh.toFixed(3);

/** A globe label: the place and its dose rate. */
export function radiationLabelTitle(reading) {
  const dose = ` ${formatDose(reading.usvh)} µSv/h`;
  return `${clip(reading.name, LABEL_MAX_CHARS - dose.length)}${dose}`;
}

/**
 * Own one ambient gamma dose rate display: the latest reading of each BfS
 * ODL station and Safecast sensor, coloured by dose-rate band and selectable
 * from the globe or the row list of the highest readings. Globe selection
 * needs the application's `picking` registry and `pointer` ownership;
 * without them the row list still selects and focuses readings. Labels are
 * world-overlay labels, drawn only when an `overlayHost` is supplied.
 */
export function createRadiationLayer({
  source,
  cesium = Cesium,
  now = () => Date.now(),
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
  picking = null,
  pointer = null,
  overlayHost = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Radiation requires a snapshot source');
  const C = cesium;
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _readings = [];
  let _missing = [];
  let _signature = null;
  let _selectedId = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _listener = null;
  let _runNavigation = null;
  let _clickHandler = null;
  let _removePreRender = null;
  let _occluder = null;
  let _culledFrom = null;
  let _navigationGeneration = 0;
  let _labelIds = [];
  /** entity id -> reading id, for picks and ownership. */
  const _entityReadings = new Map();
  /** reading id -> { entity, position, reading } */
  const _markers = new Map();

  const notify = () => _listener?.();
  const requestRender = () => {
    if (!_viewer?.isDestroyed?.()) _viewer?.scene?.requestRender?.();
  };
  const selected = () =>
    (_selectedId && _markers.get(_selectedId)?.reading) || null;

  // Points are drawn over terrain and 3D tiles, so the far side of the globe
  // has to be hidden by hand; only a moved camera changes the answer.
  function cullHorizon(force = false) {
    const camera = _viewer.camera.positionWC;
    if (!force && _culledFrom && C.Cartesian3.equals(camera, _culledFrom))
      return;
    _culledFrom = C.Cartesian3.clone(camera, _culledFrom || undefined);
    _occluder.cameraPosition = camera;
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
    _removePreRender = scene.preRender.addEventListener(() => cullHorizon());
  }

  function styleMarker(reading, entity) {
    const active = reading.id === _selectedId;
    entity.point.pixelSize = active
      ? SELECTED_PX
      : MARKER_PX[radiationBand(reading.usvh)];
    entity.point.outlineColor = active ? C.Color.WHITE : C.Color.BLACK;
    entity.point.outlineWidth = active ? 3 : 1;
  }

  /** Name raised and high readings, and the selected one, on the globe. */
  function publishLabels() {
    if (!overlayHost || !_enabled) return;
    const entries = _readings
      .filter(
        (reading) =>
          _markers.has(reading.id) &&
          (reading.id === _selectedId ||
            LABELLED.has(radiationBand(reading.usvh))),
      )
      .map((reading) => {
        const active = reading.id === _selectedId;
        const band = radiationBand(reading.usvh);
        return {
          id: reading.id,
          position: _markers.get(reading.id).position,
          variant: 'label',
          title: radiationLabelTitle(reading),
          accent: RADIATION_BAND_COLORS[band],
          priority: LABEL_PRIORITY[band] + (active ? 10_000 : 0),
          protected: active,
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 12,
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
    // readings leaves the entities alone.
    const signature = JSON.stringify(
      _readings.map(({ id, lon, lat, usvh }) => [id, lon, lat, usvh]),
    );
    if (signature === _signature) {
      for (const reading of _readings) {
        const marker = _markers.get(reading.id);
        if (marker) marker.reading = reading;
      }
      return;
    }
    _signature = signature;
    _dataSource.entities.removeAll();
    _entityReadings.clear();
    _markers.clear();
    for (const reading of _readings) {
      const id = `${ENTITY_PREFIX}${reading.id}`;
      const position = C.Cartesian3.fromDegrees(reading.lon, reading.lat, 0);
      const band = radiationBand(reading.usvh);
      const entity = _dataSource.entities.add(
        new C.Entity({
          id,
          name: reading.name,
          position,
          point: {
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            pixelSize: MARKER_PX[band],
            color: C.Color.fromCssColorString(RADIATION_BAND_COLORS[band]),
            outlineColor: C.Color.BLACK,
            outlineWidth: 1,
          },
        }),
      );
      _entityReadings.set(id, reading.id);
      _markers.set(reading.id, { entity, position, reading });
      if (reading.id === _selectedId) styleMarker(reading, entity);
    }
    syncHorizonListener();
    if (_removePreRender) cullHorizon(true);
    publishLabels();
    requestRender();
  }

  function select(id) {
    if (_selectedId !== id) ++_navigationGeneration;
    const previous = _selectedId;
    _selectedId = id;
    for (const readingId of [previous, id]) {
      const marker = readingId && _markers.get(readingId);
      if (marker) styleMarker(marker.reading, marker.entity);
    }
    if (previous !== id) publishLabels();
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
      const readingId = pickedId ? _entityReadings.get(pickedId) : null;
      if (readingId) {
        layer.setParams({ readingId });
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

  function detailLines(reading) {
    const bfs = reading.source === 'bfs';
    return [
      `${reading.name}${reading.country ? ` (${reading.country})` : ''}`,
      `${formatDose(reading.usvh)} µSv/h · ${RADIATION_SOURCE_NAMES[reading.source]}`,
      bfs
        ? `1-hour mean ending ${utc(reading.atMs)}`
        : `Measured ${utc(reading.atMs)}`,
      reading.cpm === null
        ? ''
        : `${reading.cpm} CPM on an LND 7318 tube (${SAFECAST_CPM_PER_USVH} CPM = 1 µSv/h)`,
      bfs ? `Station ${reading.id.replace(/^bfs-/, '')}` : '',
      CAVEAT,
    ].filter(Boolean);
  }

  // The legend carries the per-band counts; the summary names the total.
  function summaryLines() {
    const count = (id) =>
      _readings.filter((reading) => reading.source === id).length;
    return [
      _readings.length
        ? `${plural(_readings.length, 'reading')} · ${count('bfs')} ${RADIATION_SOURCE_NAMES.bfs} · ${count('safecast')} ${RADIATION_SOURCE_NAMES.safecast}`
        : _lastUpdate
          ? 'No current dose-rate readings'
          : _lastError
            ? 'Dose-rate readings unavailable'
            : 'Loading dose-rate readings…',
      _missing.length
        ? `No data this refresh: ${_missing.map((id) => RADIATION_SOURCE_NAMES[id] || id).join(', ')}`
        : '',
      _stale ? 'Some feeds are cached copies' : '',
      _lastError && _readings.length
        ? `Last refresh failed: ${_lastError}`
        : '',
      _readings.length > LIST_LIMIT
        ? `List shows the ${LIST_LIMIT} highest readings`
        : '',
      CAVEAT,
    ].filter(Boolean);
  }

  const layer = {
    id: LAYER_ID,
    name: 'Radiation',
    icon: '☢',
    source: 'BfS · Safecast',
    updateInterval: 600_000,

    init(viewer) {
      if (_viewer) throw new Error('Radiation layer is already initialized');
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
        (id) => _enabled && _entityReadings.has(String(id)),
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
      _culledFrom = null;
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
        _readings = snapshot.readings;
        _missing = snapshot.missing || [];
        // Rebuild the markers before a selection change republishes labels.
        render();
        if (_selectedId && !_markers.has(_selectedId)) select(null);
        _stale = snapshot.stale === true;
        _lastUpdate = now();
        _lastError = null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Radiation] Fetch error:', e);
        _lastError = e?.message || 'Dose-rate readings unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
        notify();
      }
    },

    setParams(params = {}) {
      if (!_enabled) return;
      if (params.clear === true || params.readingId === null) {
        select(null);
        notify();
      } else if (
        typeof params.readingId === 'string' &&
        _markers.has(params.readingId)
      ) {
        select(params.readingId);
        notify();
      }
      const reading = selected();
      if (params.focus === true && reading && _runNavigation) {
        const generation = ++_navigationGeneration;
        _runNavigation(() => {
          if (
            !_enabled ||
            generation !== _navigationGeneration ||
            _selectedId !== reading.id
          )
            return;
          return _viewer.camera.flyTo({
            destination: C.Cartesian3.fromDegrees(
              reading.lon,
              reading.lat,
              FOCUS_HEIGHT_M,
            ),
            duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
              ? 0
              : 1.4,
          });
        });
      }
      if (params.sourcePage === true && reading)
        openExternal(SOURCE_PAGES[reading.source]);
    },

    getRowControls() {
      const reading = selected();
      return {
        chips: reading
          ? [
              {
                id: 'source',
                label: `${RADIATION_SOURCE_NAMES[reading.source]} ↗`,
                title:
                  reading.source === 'bfs'
                    ? 'Open BfS ODL-Info, the official German dose-rate network, in a new tab'
                    : 'Open the Safecast map in a new tab',
                params: { sourcePage: true },
              },
            ]
          : [],
        legend: RADIATION_BANDS.map((band, index) => ({
          label: band.label,
          color: RADIATION_BAND_COLORS[band.id],
          count: _readings.filter(
            (entry) => radiationBand(entry.usvh) === band.id,
          ).length,
          ...(index === 0 ? { blurb: DISCLAIMER } : {}),
        })),
        list: {
          ariaLabel: 'Highest current dose-rate readings, highest first',
          items: _readings.slice(0, LIST_LIMIT).map((entry, index) => ({
            id: entry.id,
            ordinal: index + 1,
            lead: formatDose(entry.usvh),
            text: `${entry.name}${entry.country ? ` · ${entry.country}` : ''} · ${RADIATION_SOURCE_NAMES[entry.source]}`,
            active: entry.id === _selectedId,
            params: { readingId: entry.id, focus: true },
          })),
        },
        // The row renders info as one wrapped paragraph.
        info: (reading ? detailLines(reading) : summaryLines()).join(' · '),
        infoTitle: `Select a point on the map, or choose one of the highest readings in the list to select it and move the camera. Click empty map space to clear the selection. Values are µSv/h. ${DISCLAIMER}`,
      };
    },

    setRowControlsListener(value) {
      _listener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: _readings.length,
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
      _readings = [];
      _missing = [];
      _signature = null;
      _entityReadings.clear();
      _markers.clear();
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _occluder = null;
      _culledFrom = null;
      _listener = null;
      _runNavigation = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },
  };
  return layer;
}
