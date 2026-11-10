// The radio stations on the globe contract (engine.movers, engine.camera,
// engine.projector, engine.picker), the same on every engine:
// - stations: one point set; a station shows while it is visible to the
//   layer (category filter and horizon), not clustered and within
//   RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M of the camera;
// - clusters: ../screenClusters.js groups the visible stations on screen
//   (Cesium's point EntityCluster rules: 42 px range, three or more) after
//   each camera change, one point per cluster in its own set;
// - selection: an opaque point and a corner-bracket sprite over the rest;
// - clicks: an own-rule owner of the selection dispatcher; the layer picks.
// Media, labels and policy stay in the layer.

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
import {
  BRACKET_ORDER,
  BRACKET_SET_ID,
  BRACKET_SPRITE,
  CLUSTER_ALPHA,
  CLUSTER_ORDER,
  CLUSTER_POINT,
  CLUSTER_SET_ID,
  SELECTED_ORDER,
  SELECTED_POINT,
  SELECTED_SET_ID,
  STATION_ALPHA,
  STATION_ORDER,
  STATION_POINT,
  STATION_SET_ID,
  clusterPixelSize,
} from './style.js';

// Camera changes below this fraction keep the clusters.
const RECLUSTER_FRACTION = 0.05;

const rgba = (css, alpha = 1) => rgbaFromCss(css).withAlpha(alpha).rgba();

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, context)`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ state: object, services: object, parts: object }} context
 */
export function createRadioDisplay(engine, { state, services, parts }) {
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
  const inRange = (position) =>
    geo.cartesian3.distance(engine.camera.livePosition, position) <=
    RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M;
  const pointSet = (id, capacity, order, { outlineCss, ...point }) =>
    engine.movers.createSet({
      id,
      capacity,
      order,
      point: outlineCss ? { ...point, outlineColor: rgba(outlineCss) } : point,
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
        color: rgba(parts.model.radioCategoryColor(category), CLUSTER_ALPHA),
        scale: clusterPixelSize(stations.length) / CLUSTER_POINT.sizePx,
        show: visible && inRange(cluster.position),
        // A click on a cluster resolves its first station.
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
  // Clusters after a camera change; the distance cut whenever the camera moved.
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
    engine,
    get ready() {
      return initialized;
    },
    init() {
      if (initialized) throw new Error('Radio renderer is already initialized');
      normal = pointSet(
        STATION_SET_ID,
        RADIO_TUNER_DIRECTORY_LIMIT,
        STATION_ORDER,
        STATION_POINT,
      );
      grouped = pointSet(
        CLUSTER_SET_ID,
        RADIO_TUNER_DIRECTORY_LIMIT,
        CLUSTER_ORDER,
        CLUSTER_POINT,
      );
      selected = pointSet(SELECTED_SET_ID, 1, SELECTED_ORDER, SELECTED_POINT);
      // White brackets, tinted by the selection's colour.
      const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.labels.radioSelectionBracketSvg('#ffffff'))}`;
      bracket = engine.movers.createSet({
        id: BRACKET_SET_ID,
        kind: 'sprite',
        capacity: 1,
        order: BRACKET_ORDER,
        pickable: true,
        depthTest: 'always',
        sharpen: true,
        sprite: {
          ...BRACKET_SPRITE,
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
        if (Number.isFinite(amount) && amount < RECLUSTER_FRACTION) return;
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
      // The previous clusters stay for the next zoom-in rule; their members
      // are re-evaluated against the new rows.
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
      return {
        station,
        position,
        color: rgba(color, STATION_ALPHA),
        visible: true,
      };
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
      selectedRecord = {
        station,
        position,
        color: rgba(color),
        visible: engine.projector.horizonVisible(position),
      };
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
    ownsPick: (id) => String(id).startsWith(RADIO_PREFIX),
    installClick(callback) {
      removeClick = selectionDispatcherFor(engine).register('radio', {
        owns: renderer.ownsPick,
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
      const geometry = services.globe.projectEarthDiscToViewport(
        {
          camera: {
            positionWC: pose.position,
            directionWC: pose.direction,
            frustum: { fovy: pose.fovy },
          },
          scene: {},
        },
        width,
        height,
        state._radioEarthScreenCenter,
        state._radioEarthToCenter,
        engine.projector,
      );
      return {
        width,
        height,
        cartographic: pose.cartographic,
        position: pose.position,
        direction: pose.direction,
        fovy: pose.fovy,
        geometry,
        toCenter: state._radioEarthToCenter,
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
