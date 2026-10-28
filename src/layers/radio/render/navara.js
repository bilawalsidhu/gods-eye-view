import * as geo from '../../../geo/index.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { rgbaFromCss } from '../../shared/color.js';
import {
  clusterRadioPoints,
  createRadioPointOrder,
} from '../screenClusters.js';
import {
  RADIO_PREFIX,
  RADIO_TUNER_DIRECTORY_LIMIT,
  RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
} from '../policy.js';

/** Point batches and a single reusable selection bracket; no media ownership. */
export function createRadioNavaraRenderer(engine, { state, services, parts }) {
  let initialized = false;
  let visible = false;
  let sets = [];
  let normal, grouped, selected, bracket;
  let clusters = [];
  let singletonIds = new Set();
  let previousHeight;
  let selectedRecord = null;
  let dirty = true;
  const pointOrder = createRadioPointOrder();
  let lastCamera = null;
  let removeFrame = null,
    removeCamera = null,
    removeClick = null;

  const request = () => engine.render.request('radio-render');
  const rgba = (css, alpha = 1) => rgbaFromCss(css).withAlpha(alpha).rgba();
  const inRange = (position) =>
    geo.cartesian3.distance(engine.camera.livePosition, position) <=
    RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M;
  const pointSet = (id, capacity, order, point) =>
    engine.movers.createSet({
      id,
      capacity,
      order,
      point,
      kind: 'point',
      pickable: true,
      depthTest: 'always',
      sharpen: true,
    });
  const syncSelection = () => {
    const record = selectedRecord;
    const count = record ? 1 : 0;
    selected.setCount(count);
    bracket.setCount(count);
    if (record) {
      const fields = {
        position: record.position,
        color: record.color,
        show: visible && record.visible && inRange(record.position),
        pickId: `${RADIO_PREFIX}selected:${record.station.id}`,
      };
      selected.set(0, fields);
      bracket.set(0, { ...fields, cell: 'bracket' });
    }
    selected.commit();
    bracket.commit();
  };
  const syncPoints = () => {
    normal.setCount(state._renderById.size);
    let index = 0;
    for (const record of state._renderById.values())
      normal.set(index++, {
        position: record.position,
        color: record.color,
        show:
          visible &&
          record.visible &&
          singletonIds.has(record.station.id) &&
          inRange(record.position),
        pickId: `${RADIO_PREFIX}${record.station.id}`,
      });
    grouped.setCount(clusters.length);
    clusters.forEach((cluster, i) => {
      const stations = cluster.stationIds.map((id) =>
        state._stationById.get(id),
      );
      const category = parts.model.radioClusterCategoryId(
        stations,
        state._filter,
      );
      grouped.set(i, {
        position: cluster.position,
        color: rgba(parts.model.radioCategoryColor(category), 0.9),
        scale: Math.min(26, 12 + Math.log2(stations.length) * 1.6) / 12,
        show: visible && inRange(cluster.position),
        // The native cluster click resolves its first actual station too.
        pickId: `${RADIO_PREFIX}${cluster.stationIds[0]}`,
      });
    });
    normal.commit();
    grouped.commit();
  };
  const rebuild = () => {
    if (!initialized || !visible) return;
    const height = engine.camera.height();
    const result = clusterRadioPoints({
      records: pointOrder.update(state._renderById.values()),
      project: (p) => engine.projector.worldToWindow(p),
      horizonVisible: (p) => engine.projector.horizonVisible(p),
      height,
      previousHeight,
      previousClusters: clusters,
    });
    clusters = result.clusters;
    singletonIds = new Set(result.singletons);
    previousHeight = height;
    dirty = false;
    syncPoints();
    syncSelection();
    parts.rendering.scheduleRadioOverlayPublish();
  };
  const frame = () => {
    if (!visible) return;
    if (dirty) rebuild();
    const camera = engine.camera.livePosition;
    if (
      !lastCamera ||
      camera.x !== lastCamera.x ||
      camera.y !== lastCamera.y ||
      camera.z !== lastCamera.z
    ) {
      lastCamera = { ...camera };
      syncPoints();
      syncSelection();
    }
  };

  const renderer = {
    get ready() {
      return initialized;
    },
    init() {
      if (initialized) throw new Error('Radio renderer is already initialized');
      normal = pointSet('radio-stations', RADIO_TUNER_DIRECTORY_LIMIT, 40, {
        sizePx: 13,
        outlinePx: 1,
        outlineColor: rgba('#071b25'),
        scaleByDistance: [100_000, 1.15, 12_000_000, 1],
      });
      grouped = pointSet('radio-clusters', RADIO_TUNER_DIRECTORY_LIMIT, 41, {
        sizePx: 12,
        outlinePx: 2,
        outlineColor: [0, 0, 0, 1],
      });
      selected = pointSet('radio-selected', 1, 42, {
        sizePx: 14,
        outlinePx: 2,
        outlineColor: [0, 0, 0, 1],
      });
      const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.labels.radioSelectionBracketSvg('#ffffff'))}`;
      bracket = engine.movers.createSet({
        id: 'radio-bracket',
        kind: 'sprite',
        capacity: 1,
        order: 43,
        pickable: true,
        depthTest: 'always',
        sharpen: true,
        sprite: {
          sizePx: 40,
          scaleByDistance: [100_000, 1, 12_000_000, 0.72],
          atlas: { url: image, cells: { bracket: [0, 0, 1, 1] } },
        },
      });
      sets = [normal, grouped, selected, bracket];
      for (const set of sets) {
        set.setCount(0);
        set.commit();
      }
      initialized = true;
      removeFrame = engine.frames.preRender.addEventListener(frame);
      removeCamera = engine.camera.changed.addEventListener((amount) => {
        if (Number.isFinite(amount) && amount < 0.05) return;
        dirty = true;
        if (visible) request();
      });
    },
    setVisible(value) {
      visible = value;
      if (!initialized) return;
      if (value) {
        dirty = true;
        request();
      } else {
        pointOrder.update(state._renderById.values(), false);
        for (const set of sets) {
          set.setCount(0);
          set.commit();
        }
      }
    },
    markerPosition(station, lift) {
      const floor = services.ground.cachedGroundFloor(station.lat, station.lon);
      return geo.cartesian3.fromDegrees(
        station.lon,
        station.lat,
        (Number.isFinite(floor) ? floor : 0) + lift,
      );
    },
    clearStations() {
      pointOrder.clear(state._renderById.values());
      // Native EntityCluster retains its previous zoom clusters across a
      // directory refresh; candidates are re-evaluated against the new rows.
      singletonIds.clear();
      dirty = true;
      if (initialized) {
        normal.setCount(0);
        normal.commit();
      }
    },
    addStation(station, position, color) {
      if (state._renderById.size >= RADIO_TUNER_DIRECTORY_LIMIT)
        throw new RangeError('Radio directory exceeds its point budget');
      dirty = true;
      return { station, position, color: rgba(color, 0.86), visible: true };
    },
    setStationVisible(record, value) {
      if (record.renderVisible !== value) {
        record.renderVisible = value;
        dirty = true;
        if (visible) request();
      }
    },
    clearSelected() {
      selectedRecord = null;
      if (initialized) syncSelection();
    },
    addSelected(station, position, color) {
      selectedRecord = { station, position, color: rgba(color), visible: true };
      syncSelection();
    },
    setSelectedVisible(value) {
      if (!selectedRecord || selectedRecord.visible === value) return false;
      selectedRecord.visible = value;
      syncSelection();
      return true;
    },
    clusters() {
      return clusters;
    },
    invalidateClusters() {
      dirty = true;
      if (visible) request();
    },
    cameraPosition() {
      return engine.camera.livePosition;
    },
    cameraHeight() {
      return engine.camera.height();
    },
    horizonVisible(position) {
      return engine.projector.horizonVisible(position);
    },
    pick(position) {
      return engine.picker.pick(position);
    },
    drillPick(position, limit) {
      return engine.picker.drillPick(position, limit);
    },
    installClick(callback) {
      removeClick = selectionDispatcherFor(engine).register('radio', {
        owns: (id) => id.startsWith(RADIO_PREFIX),
        onClick: ({ position }) => callback(position),
      });
      return removeClick;
    },
    cameraState() {
      const pose = engine.camera.pose();
      return {
        height: pose.cartographic.height,
        heading: pose.heading,
        pitch: pose.pitch,
        roll: pose.roll,
      };
    },
    navigationAllowed() {
      return !engine.camera.following();
    },
    recenterView() {
      const pose = engine.camera.pose();
      const { width, height } = engine.host.size();
      if (!(width > 0) || !(height > 0)) return null;
      const toCenter = geo.cartesian3.negate(
        pose.position,
        state._radioEarthToCenter,
      );
      const radius = services.globe.earthDiscScreenRadius(
        geo.cartesian3.magnitude(pose.position),
        height,
        pose.fovy,
      );
      const center =
        geo.cartesian3.dot(pose.direction, toCenter) > 0
          ? engine.projector.worldToWindow(
              geo.cartesian3.ZERO,
              state._radioEarthScreenCenter,
            )
          : null;
      const keyhole = services.globe.getKeyholeGeometry(width, height);
      const geometry =
        center && radius
          ? {
              earthCenterX: center.x,
              earthCenterY: center.y,
              earthRadius: radius,
              keyholeCenterX: keyhole.centerX,
              keyholeCenterY: keyhole.centerY,
              keyholeRadius: keyhole.radius,
            }
          : null;
      return {
        width,
        height,
        cartographic: pose.cartographic,
        position: pose.position,
        direction: pose.direction,
        fovy: pose.fovy,
        toCenter,
        geometry,
      };
    },
    flyTo(options) {
      engine.camera.flyTo(options);
    },
    cancelFlight() {
      engine.camera.cancelFlight();
    },
    viewportAnchor() {
      const { width, height } = engine.host.size();
      const position = engine.camera.pickEllipsoid({
        x: width / 2,
        y: height / 2,
      });
      const cartographic = position
        ? geo.cartographic.fromCartesian(position)
        : engine.camera.pose().cartographic;
      return cartographic
        ? {
            lat: geo.math.toDegrees(cartographic.latitude),
            lon: geo.math.toDegrees(cartographic.longitude),
            altitudeM: engine.camera.height(),
          }
        : null;
    },
    destroy() {
      removeClick?.();
      removeClick = null;
      removeFrame?.();
      removeFrame = null;
      removeCamera?.();
      removeCamera = null;
      for (const set of sets) set.destroy();
      sets = [];
      initialized = false;
      visible = false;
      selectedRecord = null;
      clusters = [];
      singletonIds.clear();
      previousHeight = undefined;
      pointOrder.reset();
      lastCamera = null;
      dirty = true;
    },
  };
  return renderer;
}
