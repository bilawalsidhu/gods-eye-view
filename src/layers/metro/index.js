import * as Cesium from 'cesium';
import {
  DEFAULT_STATION_COLOR,
  MAX_VIEW_SPAN_DEG,
  buildLineSegments,
  isViewQueryable,
  mergeStations,
  summarizeLines,
} from './model.js';

export const METRO_LAYER_ID = 'metro';
const REQUEST_DEBOUNCE_MS = 900;
/** Above this camera height the view spans too many cities to look up. */
const MAX_CAMERA_HEIGHT_M = 200_000;
const MAX_RENDERED = 4000;
const MAX_SEGMENTS = 6000;
const LINE_WIDTH_PX = 2.5;
const LINE_ALPHA = 0.6;
const STOP_OUTLINE_PX = 1;
const GLOW_ALPHA = 0.28;
const LABEL_RANGE_M = 7000;
const LABEL_COHORT_LIMIT = 120;
const LABEL_COLLISION_CAPACITY = 60;
export const METRO_OVERLAY_SOURCE_ID = 'metro';
const NO_OVERLAY_HOST = Object.freeze({
  setEntries() {},
  clearSource() {},
  setVisible() {},
});
const POINT_HEIGHT_OFFSET_M = 4;
const PICK_PREFIX = 'metro:';

const toDeg = Cesium.Math?.toDegrees ?? ((r) => (r * 180) / Math.PI);

/**
 * Metro stations from Wikidata for the cities in view.
 *
 * On each settled camera move the layer resolves the most populous Wikidata
 * cities inside the view, then loads metro stations for any city it has not
 * already fetched. Stations from every city in view are drawn as points
 * coloured by their line (P465), joined by line-coloured track segments
 * draped on the surface from Wikidata adjacency (P197). Names of nearby stations are published to
 * the shared world-overlay host rather than drawn as Cesium labels.
 */
export function createMetroLayer({
  source,
  overlayHost = NO_OVERLAY_HOST,
  services = {},
  cesium = Cesium,
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  if (
    typeof source?.getCitiesInView !== 'function' ||
    typeof source?.fetchStations !== 'function' ||
    typeof source?.peekStations !== 'function'
  )
    throw new TypeError('Metro requires a station source');
  const requestRender = services.render?.governorRequestRender || (() => {});
  const picking = services.picking || {};
  const sprites = services.sprites || {};
  const isPointerFree = services.isPointerFree || (() => true);

  const state = {
    viewer: null,
    points: null,
    lines: null,
    linesKey: '',
    segmentCount: 0,
    linesSupported: null,
    rendered: new Map(),
    enabled: false,
    destroyed: false,
    cities: [],
    stations: [],
    selectedId: null,
    status: 'idle',
    error: null,
    loading: false,
    loadingLabel: '',
    lastUpdate: null,
    saturated: false,
    abort: null,
    debounceTimer: null,
    moveEndRemove: null,
    clickHandler: null,
    listener: null,
  };

  const notify = () => {
    requestRender('metro');
    state.listener?.();
  };

  function setStatus(status, error = null) {
    state.status = status;
    state.error = error;
    notify();
  }

  function centerOfView(viewer) {
    const canvas = viewer.scene?.canvas;
    const ellipsoid = viewer.scene?.globe?.ellipsoid;
    if (
      canvas &&
      ellipsoid &&
      typeof viewer.camera.pickEllipsoid === 'function'
    ) {
      const middle = new cesium.Cartesian2(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
      const hit = viewer.camera.pickEllipsoid(middle, ellipsoid);
      if (hit) {
        const carto = cesium.Cartographic.fromCartesian(hit, ellipsoid);
        if (carto)
          return { lon: toDeg(carto.longitude), lat: toDeg(carto.latitude) };
      }
    }
    const carto = viewer.camera.positionCartographic;
    return carto
      ? { lon: toDeg(carto.longitude), lat: toDeg(carto.latitude) }
      : null;
  }

  /** The view rectangle, clipped to a bounded window around the view centre. */
  function viewportBox(viewer) {
    const height = viewer?.camera?.positionCartographic?.height;
    if (!Number.isFinite(height) || height > MAX_CAMERA_HEIGHT_M) return null;
    const center = centerOfView(viewer);
    if (!center) return null;
    const half = MAX_VIEW_SPAN_DEG / 2;
    const bounds = {
      west: Math.max(-180, center.lon - half),
      south: Math.max(-90, center.lat - half),
      east: Math.min(180, center.lon + half),
      north: Math.min(90, center.lat + half),
    };
    const rect = viewer.camera.computeViewRectangle?.(
      viewer.scene?.globe?.ellipsoid,
    );
    if (!rect) return bounds;
    const view = {
      west: toDeg(rect.west),
      south: toDeg(rect.south),
      east: toDeg(rect.east),
      north: toDeg(rect.north),
    };
    if (view.west > view.east) return bounds;
    const clipped = {
      west: Math.max(view.west, bounds.west),
      south: Math.max(view.south, bounds.south),
      east: Math.min(view.east, bounds.east),
      north: Math.min(view.north, bounds.north),
    };
    return isViewQueryable(clipped) ? clipped : bounds;
  }

  function stationPosition(station) {
    let height = POINT_HEIGHT_OFFSET_M;
    const scene = state.viewer?.scene;
    const carto = cesium.Cartographic.fromDegrees(station.lon, station.lat);
    const sampled = scene?.sampleHeightSupported
      ? scene.sampleHeight(carto)
      : scene?.globe?.getHeight?.(carto);
    if (Number.isFinite(sampled)) height += sampled;
    return cesium.Cartesian3.fromDegrees(station.lon, station.lat, height);
  }

  function styleRendered(entry) {
    const selected = entry.station.id === state.selectedId;
    entry.point.pixelSize = selected ? 13 : 8;
    entry.point.outlineColor = selected
      ? cesium.Color.YELLOW
      : cesium.Color.BLACK.withAlpha(0.85);
    entry.point.outlineWidth = selected ? 2 : STOP_OUTLINE_PX;
    if (entry.glow) entry.glow.pixelSize = selected ? 24 : 15;
  }

  /** Publish names for the stations nearest the camera, plus the selection. */
  function publishLabels() {
    if (!state.enabled || !state.viewer) {
      overlayHost.clearSource(METRO_OVERLAY_SOURCE_ID);
      return;
    }
    const eye = state.viewer.camera?.positionWC;
    const near = [];
    for (const entry of state.rendered.values()) {
      const selected = entry.station.id === state.selectedId;
      const distance = eye
        ? cesium.Cartesian3.distance(eye, entry.position)
        : Number.POSITIVE_INFINITY;
      if (selected || distance <= LABEL_RANGE_M)
        near.push({ entry, distance, selected });
    }
    near.sort((a, b) => b.selected - a.selected || a.distance - b.distance);
    overlayHost.setEntries(
      METRO_OVERLAY_SOURCE_ID,
      near
        .slice(0, LABEL_COHORT_LIMIT)
        .map(({ entry, distance, selected }) => ({
          id: entry.station.id,
          position: entry.position,
          variant: 'label',
          title: entry.station.name,
          details: selected ? entry.station.lines.slice(0, 3) : [],
          accent: entry.station.color || DEFAULT_STATION_COLOR,
          priority: selected
            ? LABEL_RANGE_M * 2
            : Math.round(LABEL_RANGE_M - Math.min(distance, LABEL_RANGE_M)),
          selected,
          collisionGroup: 'ambient-label',
          paintLane: selected ? undefined : 'ambient-label',
          maxDistance: selected ? undefined : LABEL_RANGE_M,
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          gapPx: 12,
          verticalOnly: true,
          placement: 'above',
        })),
      {
        cohortLimit: LABEL_COHORT_LIMIT,
        collisionCapacity: LABEL_COLLISION_CAPACITY,
        moving: false,
      },
    );
  }

  function render() {
    if (!state.points) return;
    const visible = state.enabled ? state.stations.slice(0, MAX_RENDERED) : [];
    state.saturated = state.enabled && state.stations.length > MAX_RENDERED;
    const keep = new Set(visible.map((station) => station.id));
    for (const [id, entry] of state.rendered) {
      if (keep.has(id)) continue;
      state.points.remove(entry.point);
      if (entry.glow) state.points.remove(entry.glow);
      state.rendered.delete(id);
    }
    for (const station of visible) {
      if (state.rendered.has(station.id)) continue;
      const position = stationPosition(station);
      const color = cesium.Color.fromCssColorString(
        station.color || DEFAULT_STATION_COLOR,
      );
      const pickId = `${PICK_PREFIX}${station.id}`;
      const scaleByDistance = new cesium.NearFarScalar(500, 1.3, 120_000, 0.45);
      // PointPrimitives cannot blur, so a faint, larger point behind the stop
      // with a softer outline reads as a two-step glow.
      const glow = state.points.add({
        position,
        pixelSize: 15,
        color: color.withAlpha(GLOW_ALPHA),
        outlineColor: color.withAlpha(GLOW_ALPHA / 2),
        outlineWidth: 3,
        scaleByDistance,
        disableDepthTestDistance: 5000,
        id: pickId,
      });
      const point = state.points.add({
        position,
        pixelSize: 8,
        color,
        outlineColor: cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: STOP_OUTLINE_PX,
        scaleByDistance,
        disableDepthTestDistance: 5000,
        id: pickId,
      });
      const entry = { station, point, glow, position };
      state.rendered.set(station.id, entry);
      styleRendered(entry);
    }
    if (state.selectedId && !state.rendered.has(state.selectedId))
      state.selectedId = null;
    renderLines(visible);
    publishLabels();
    requestRender('metro-points');
  }

  function removeLines() {
    if (state.lines) state.viewer?.scene?.groundPrimitives?.remove(state.lines);
    state.lines = null;
    state.linesKey = '';
    state.segmentCount = 0;
  }

  /** Rebuild the track batch when the drawn segment set changes. */
  function renderLines(stations) {
    const scene = state.viewer?.scene;
    if (!state.enabled || !scene?.groundPrimitives) return removeLines();
    if (state.linesSupported === null)
      state.linesSupported =
        typeof cesium.GroundPolylinePrimitive === 'function' &&
        cesium.GroundPolylinePrimitive.isSupported?.(scene) !== false;
    if (!state.linesSupported) return removeLines();
    const segments = buildLineSegments(stations).slice(0, MAX_SEGMENTS);
    const key = segments.map((segment) => segment.id).join('|');
    if (key === state.linesKey) return;
    removeLines();
    if (!segments.length) return;
    const colors = new Map();
    const instances = segments.map((segment) => {
      if (!colors.has(segment.color))
        colors.set(
          segment.color,
          cesium.ColorGeometryInstanceAttribute.fromColor(
            cesium.Color.fromCssColorString(segment.color).withAlpha(
              LINE_ALPHA,
            ),
          ),
        );
      return new cesium.GeometryInstance({
        id: `${PICK_PREFIX}line:${segment.id}`,
        geometry: new cesium.GroundPolylineGeometry({
          positions: [
            cesium.Cartesian3.fromDegrees(segment.from.lon, segment.from.lat),
            cesium.Cartesian3.fromDegrees(segment.to.lon, segment.to.lat),
          ],
          width: LINE_WIDTH_PX,
        }),
        attributes: { color: colors.get(segment.color) },
      });
    });
    state.lines = scene.groundPrimitives.add(
      new cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        // Photoreal tiles hide the globe; other stacks drape on terrain.
        classificationType: cesium.ClassificationType.BOTH,
        appearance: new cesium.PolylineColorAppearance(),
        asynchronous: true,
      }),
    );
    state.linesKey = key;
    state.segmentCount = segments.length;
  }

  function collectStations() {
    state.stations = mergeStations(
      state.cities.map((city) => source.peekStations(city.id) || []),
    );
  }

  function onMoveEnd() {
    if (!state.enabled) return;
    publishLabels();
    scheduleLoad();
  }

  function scheduleLoad() {
    if (!state.enabled) return;
    clearTimer(state.debounceTimer);
    state.debounceTimer = setTimer(() => {
      state.debounceTimer = null;
      void load();
    }, REQUEST_DEBOUNCE_MS);
  }

  async function load() {
    if (!state.enabled || !state.viewer) return;
    clearTimer(state.debounceTimer);
    state.debounceTimer = null;
    const box = viewportBox(state.viewer);
    if (!box) {
      // Keep stations already drawn; the row explains why nothing new loads.
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      setStatus('zoom-in');
      return;
    }
    state.abort?.abort();
    const controller = new AbortController();
    state.abort = controller;
    const current = () =>
      state.enabled && state.abort === controller && !controller.signal.aborted;
    state.loading = true;
    state.loadingLabel = 'finding cities in view';
    setStatus('loading');
    try {
      const cities = await source.getCitiesInView(box, {
        signal: controller.signal,
      });
      if (!current()) return;
      state.cities = [...cities];
      collectStations();
      render();
      let pending = state.cities.filter(
        (city) => source.peekStations(city.id) === undefined,
      );
      while (pending.length) {
        state.loadingLabel = `loading stations · ${pending
          .slice(0, 3)
          .map((city) => city.name)
          .join(', ')}`;
        notify();
        await source.fetchStations(
          pending.map((city) => city.id),
          { signal: controller.signal },
        );
        if (!current()) return;
        collectStations();
        render();
        const next = state.cities.filter(
          (city) => source.peekStations(city.id) === undefined,
        );
        // A source that answers nothing new must not loop forever.
        if (next.length >= pending.length) break;
        pending = next;
      }
      state.lastUpdate = Date.now();
      setStatus(state.stations.length ? 'ready' : 'empty');
    } catch (error) {
      if (!current()) return;
      setStatus(
        'unavailable',
        error?.name === 'TimeoutError'
          ? 'Wikidata query timed out'
          : error?.message || 'Wikidata unavailable',
      );
    } finally {
      if (state.abort === controller) {
        state.abort = null;
        state.loading = false;
        state.loadingLabel = '';
        notify();
      }
    }
  }

  function select(id) {
    const previous = state.rendered.get(state.selectedId);
    state.selectedId = id && state.rendered.has(id) ? id : null;
    if (previous) styleRendered(previous);
    const next = state.rendered.get(state.selectedId);
    if (next) styleRendered(next);
    publishLabels();
    notify();
  }

  function installClickHandler() {
    if (
      state.clickHandler ||
      !state.viewer?.scene?.canvas ||
      typeof cesium.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const handler = new cesium.ScreenSpaceEventHandler(
      state.viewer.scene.canvas,
    );
    state.clickHandler = handler;
    handler.setInputAction((click) => {
      if (!state.enabled || !click?.position || !isPointerFree()) return;
      const picked = state.viewer.scene.pick(click.position);
      const id = typeof picked?.id === 'string' ? picked.id : '';
      if (id.startsWith(PICK_PREFIX)) select(id.slice(PICK_PREFIX.length));
      else if (state.selectedId) select(null);
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    const handler = state.clickHandler;
    state.clickHandler = null;
    if (handler && !handler.isDestroyed?.()) handler.destroy();
  }

  function selectedStation() {
    return state.rendered.get(state.selectedId)?.station || null;
  }

  const layer = {
    id: METRO_LAYER_ID,
    name: 'Metro Stations',
    icon: 'Ⓜ',
    source: 'Wikidata',
    updateInterval: 0,
    statsRefreshInterval: 1000,
    init(viewer) {
      if (state.viewer) throw new Error('Metro layer is already initialized');
      state.viewer = viewer;
      state.points = new cesium.PointPrimitiveCollection();
      state.points.show = false;
      viewer.scene.primitives.add(state.points);
      overlayHost.setVisible(METRO_OVERLAY_SOURCE_ID, false);
      sprites.registerSpriteCollection?.(METRO_LAYER_ID, state.points);
      state.moveEndRemove = viewer.camera.moveEnd.addEventListener(onMoveEnd);
    },
    enable() {
      if (state.enabled || state.destroyed) return;
      state.enabled = true;
      state.points.show = true;
      overlayHost.setVisible(METRO_OVERLAY_SOURCE_ID, true);
      picking.registerPickOwner?.(
        METRO_LAYER_ID,
        (id) =>
          typeof id === 'string' &&
          id.startsWith(PICK_PREFIX) &&
          state.rendered.has(id.slice(PICK_PREFIX.length)),
      );
      installClickHandler();
      sprites.restoreSpriteOrder?.(state.viewer);
      // DataLayerManager calls update() right after enable(); it owns the first fetch.
    },
    disable() {
      state.enabled = false;
      clearTimer(state.debounceTimer);
      state.debounceTimer = null;
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      state.loadingLabel = '';
      picking.unregisterPickOwner?.(METRO_LAYER_ID);
      removeClickHandler();
      state.selectedId = null;
      state.cities = [];
      state.stations = [];
      render();
      removeLines();
      if (state.points) state.points.show = false;
      overlayHost.clearSource(METRO_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(METRO_OVERLAY_SOURCE_ID, false);
      setStatus('idle');
    },
    update() {
      return load();
    },
    destroy(viewer = state.viewer) {
      if (state.destroyed) return;
      layer.disable();
      state.destroyed = true;
      state.moveEndRemove?.();
      state.moveEndRemove = null;
      sprites.unregisterSpriteCollection?.(METRO_LAYER_ID, state.points);
      removeLines();
      if (viewer?.scene?.primitives && state.points)
        viewer.scene.primitives.remove(state.points);
      state.points = null;
      state.rendered.clear();
      state.viewer = null;
      state.listener = null;
    },
    setRowControlsListener(value) {
      state.listener = typeof value === 'function' ? value : null;
    },
    getRowControls() {
      const station = selectedStation();
      const lines = summarizeLines(state.stations);
      const cities = state.cities
        .filter((city) => (source.peekStations(city.id) || []).length)
        .map((city) => city.name);
      const info = station
        ? `${station.name}${station.lines.length ? ` · ${station.lines.join(', ')}` : ''}\n${station.url}`
        : cities.length
          ? `Cities in view: ${cities.join(', ')}`
          : '';
      return {
        chips: station
          ? [
              {
                id: 'open-wikidata',
                label: 'WIKIDATA ↗',
                title: `Open ${station.name} on Wikidata`,
                onClick: () =>
                  globalThis.open?.(
                    station.url,
                    '_blank',
                    'noopener,noreferrer',
                  ),
              },
              {
                id: 'clear-selection',
                label: 'CLEAR',
                title: 'Clear the selected station',
                onClick: () => select(null),
              },
            ]
          : [],
        legend: lines.map((line) => ({
          label: line.name,
          color: line.color || DEFAULT_STATION_COLOR,
          count: line.count,
        })),
        info,
        infoTitle:
          'Metro stations (Q928830) located in the Wikidata cities in view, coloured by line. Click a station to select it. Coverage follows Wikidata modelling and may be incomplete.',
      };
    },
    getStats() {
      const count = state.rendered.size;
      const cityCount = state.cities.filter(
        (city) => (source.peekStations(city.id) || []).length,
      ).length;
      return {
        count,
        countLabel:
          state.enabled && count
            ? `${count} station${count === 1 ? '' : 's'}${
                cityCount
                  ? ` · ${cityCount} cit${cityCount === 1 ? 'y' : 'ies'}`
                  : ''
              }`
            : '',
        lastUpdate: state.lastUpdate,
        loading: state.loading,
        loadingLabel: state.loading
          ? state.loadingLabel
          : state.saturated
            ? `Showing first ${MAX_RENDERED} stations — zoom in`
            : '',
        status: state.status,
        statusMessage:
          state.status === 'zoom-in'
            ? 'Zoom in to a city to load metro stations'
            : state.status === 'empty'
              ? 'No metro stations on Wikidata for the cities in view'
              : '',
        error: state.error,
        saturated: state.saturated,
        source: 'Wikidata',
      };
    },
    getDiagnostics() {
      return {
        enabled: state.enabled,
        status: state.status,
        cities: state.cities.map((city) => city.id),
        stations: state.stations.length,
        rendered: state.rendered.size,
        segments: state.segmentCount,
        selectedId: state.selectedId,
        requestPending: Boolean(state.abort),
      };
    },
  };
  return layer;
}

export { createMetroSource } from './source.js';
