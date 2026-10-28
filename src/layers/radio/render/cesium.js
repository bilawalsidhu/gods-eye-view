import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { horizonOccluder } from '../../../data/iconOrientation.js';
import {
  RADIO_PREFIX,
  RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
} from '../policy.js';

/** Native scene resources stay owned by the viewer passed to init. */
export function createRadioCesiumRenderer({
  state: layerState,
  services,
  parts,
}) {
  let viewer = null;
  let dataSource = null;
  let selectedEntity = null;
  let removeClusterListener = null;
  let removeClick = null;

  function installClusterStyling() {
    if (!dataSource || removeClusterListener) return;
    const clustering = dataSource.clustering;
    clustering.enabled = true;
    clustering.pixelRange = 42;
    clustering.minimumClusterSize = 3;
    clustering.clusterPoints = true;
    clustering.clusterLabels = false;
    clustering.clusterBillboards = false;
    removeClusterListener = clustering.clusterEvent.addEventListener(
      (clusteredEntities, cluster) => {
        const clusteredStations = [];
        for (const entity of clusteredEntities) {
          const stationId = String(entity.id || '').slice(RADIO_PREFIX.length);
          const station = layerState._renderById.get(stationId)?.station;
          if (station) clusteredStations.push(station);
        }
        const clusterCategory = parts.model.radioClusterCategoryId(
          clusteredStations,
          layerState._filter,
        );
        const clusterColor = Cesium.Color.fromCssColorString(
          parts.model.radioCategoryColor(clusterCategory),
        );
        // Cesium assigns the entity-id array only to the generated cluster label.
        // Mirror it to the visible point so clicking either part of the callout
        // resolves the first station and remains a direct playback gesture.
        cluster.point.id = clusteredEntities;
        cluster.billboard.id = clusteredEntities;
        cluster.label.show = false;
        cluster.label.text = '';
        cluster.point.show = true;
        cluster.point.pixelSize = Math.min(
          26,
          12 + Math.log2(clusteredEntities.length) * 1.6,
        );
        cluster.point.color = clusterColor.withAlpha(0.9);
        cluster.point.outlineColor = Cesium.Color.BLACK;
        cluster.point.outlineWidth = 2;
        cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
        cluster.point.distanceDisplayCondition =
          new Cesium.DistanceDisplayCondition(
            0,
            RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
          );
        parts.rendering.scheduleRadioOverlayPublish();
      },
    );
  }

  const renderer = {
    get ready() {
      return Boolean(viewer && dataSource);
    },
    init(owner) {
      if (viewer) throw new Error('Radio renderer is already initialized');
      viewer = owner;
      dataSource = new Cesium.CustomDataSource('Radio stations');
      viewer.dataSources.add(dataSource);
      installClusterStyling();
      dataSource.show = false;
    },
    setVisible(visible) {
      if (dataSource) dataSource.show = visible;
    },
    markerPosition(station, lift) {
      const floor = services.ground.cachedGroundFloor(station.lat, station.lon);
      return Cesium.Cartesian3.fromDegrees(
        station.lon,
        station.lat,
        (Number.isFinite(floor) ? floor : 0) + lift,
      );
    },
    clearStations() {
      dataSource?.entities.removeAll();
    },
    addStation(station, position, markerColor) {
      const entity = dataSource.entities.add({
        id: `${RADIO_PREFIX}${station.id}`,
        position,
        point: {
          pixelSize: 13,
          color: Cesium.Color.fromCssColorString(markerColor).withAlpha(0.86),
          outlineColor: Cesium.Color.fromCssColorString('#071b25'),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(
            100_000,
            1.15,
            12_000_000,
            1,
          ),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
          ),
        },
      });
      return { station, position, entity, visible: true };
    },
    setStationVisible(record, visible) {
      record.entity.show = visible;
    },
    clearSelected() {
      if (selectedEntity && viewer) viewer.entities.remove(selectedEntity);
      selectedEntity = null;
    },
    addSelected(station, position, selectionColor, bracketImage) {
      selectedEntity = viewer.entities.add({
        id: `${RADIO_PREFIX}selected:${station.id}`,
        position: position,
        point: {
          pixelSize: 14,
          color: Cesium.Color.fromCssColorString(selectionColor),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
          ),
        },
        billboard: {
          image: bracketImage,
          width: 40,
          height: 40,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
          ),
          scaleByDistance: new Cesium.NearFarScalar(
            100_000,
            1,
            12_000_000,
            0.72,
          ),
        },
      });
    },
    setSelectedVisible(visible) {
      if (!selectedEntity) return false;
      const changed = selectedEntity.show !== visible;
      selectedEntity.show = visible;
      return changed;
    },
    clusters() {
      const points = dataSource?.clustering?._clusterPointCollection;
      const clusters = [];
      for (let index = 0; index < (points?.length || 0); index++) {
        const point = points.get(index);
        if (!point?.show || !point.position || !Array.isArray(point.id))
          continue;
        clusters.push({
          position: point.position,
          stationIds: point.id.map((entity) =>
            String(entity?.id || '').slice(RADIO_PREFIX.length),
          ),
        });
      }
      return clusters;
    },
    invalidateClusters() {
      if (!dataSource?.clustering.enabled) return;
      // Entity show changes alone do not invalidate native cluster primitives.
      const enabled = dataSource.clustering.clusterPoints;
      dataSource.clustering.clusterPoints = !enabled;
      dataSource.clustering.clusterPoints = enabled;
      viewer.scene?.requestRender?.();
    },
    cameraPosition() {
      return viewer?.camera?.positionWC;
    },
    cameraHeight() {
      return viewer?.camera?.positionCartographic?.height;
    },
    horizonVisible(position) {
      return horizonOccluder(viewer.camera).isPointVisible(position);
    },
    pick(position) {
      return viewer?.scene.pick(position);
    },
    drillPick(position, limit) {
      return viewer?.scene.drillPick?.(position, limit) || [];
    },
    installClick(callback) {
      services.picking.registerPickOwner('radio', (id) =>
        id.startsWith(RADIO_PREFIX),
      );
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction(
        (event) => callback(event.position),
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      let removed = false;
      removeClick = () => {
        if (!removed) {
          handler.destroy();
          services.picking.unregisterPickOwner('radio');
        }
        removed = true;
      };
      return removeClick;
    },
    cameraState() {
      const camera = viewer?.camera;
      return camera
        ? {
            height: camera.positionCartographic?.height,
            heading: camera.heading,
            pitch: camera.pitch,
            roll: camera.roll,
          }
        : null;
    },
    navigationAllowed() {
      return Boolean(viewer?.camera) && !viewer.trackedEntity;
    },
    recenterView() {
      const camera = viewer?.camera;
      const canvas = viewer?.scene?.canvas;
      const width = canvas?.clientWidth || canvas?.width;
      const height = canvas?.clientHeight || canvas?.height;
      if (!camera?.positionCartographic || !(width > 0) || !(height > 0))
        return null;
      const geometry = services.globe.projectEarthDiscToViewport(
        viewer,
        width,
        height,
        layerState._radioEarthScreenCenter,
        layerState._radioEarthToCenter,
      );
      return {
        width,
        height,
        cartographic: camera.positionCartographic,
        position: camera.positionWC,
        direction: camera.directionWC,
        fovy: camera.frustum?.fovy,
        geometry,
        toCenter: layerState._radioEarthToCenter,
      };
    },
    flyTo({ easing, ...options }) {
      viewer.camera.flyTo({
        ...options,
        ...(easing === 'cubicInOut'
          ? { easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT }
          : {}),
      });
    },
    cancelFlight() {
      viewer?.camera.cancelFlight();
    },
    viewportAnchor() {
      const camera = viewer?.camera;
      if (!camera) return null;
      const canvas = viewer.scene?.canvas;
      const position =
        canvas &&
        camera.pickEllipsoid?.(
          geo.cartesian2.create(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ),
          viewer.scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
        );
      const cartographic = position
        ? geo.cartographic.fromCartesian(position)
        : camera.positionCartographic;
      return cartographic
        ? {
            lat: geo.math.toDegrees(cartographic.latitude),
            lon: geo.math.toDegrees(cartographic.longitude),
            altitudeM: Number(camera.positionCartographic?.height),
          }
        : null;
    },
    destroy() {
      removeClick?.();
      removeClick = null;
      renderer.clearSelected();
      removeClusterListener?.();
      removeClusterListener = null;
      if (dataSource && viewer) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
    },
  };
  return renderer;
}
