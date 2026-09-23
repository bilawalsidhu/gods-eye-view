import * as Cesium from 'cesium';
import {
  describeReceiverBands,
  receiverMatchesFilter,
} from '../../sources/webReceivers.js';
import {
  FLY_TO_ALTITUDE_M,
  GLOBE_INTERACTION_MAX_DISTANCE_M,
  MARKER_LIFT_M,
  MARKER_OUTLINE_COLOR,
  RECEIVER_TYPE_COLORS,
  SELECTED_LIFT_M,
  WEB_RECEIVER_PREFIX,
} from './policy.js';

export function createRendering({ state: layerState, services, parts }) {
  const { cachedGroundFloor } = services.ground;
  const { governorRequestRender } = services.render;

  function markerPosition(receiver, liftM = MARKER_LIFT_M) {
    const floor = cachedGroundFloor(receiver.lat, receiver.lon);
    return Cesium.Cartesian3.fromDegrees(
      receiver.lon,
      receiver.lat,
      (Number.isFinite(floor) ? floor : 0) + liftM,
    );
  }

  function markerColor(receiver) {
    const base = Cesium.Color.fromCssColorString(
      RECEIVER_TYPE_COLORS[receiver.type] || '#ffffff',
    );
    if (receiver.online === false) return base.withAlpha(0.3);
    if (
      layerState._highlightIds.size &&
      !layerState._highlightIds.has(receiver.id)
    )
      return base.withAlpha(0.5);
    return base.withAlpha(0.9);
  }

  function markerSize(receiver) {
    return layerState._highlightIds.has(receiver.id) ? 16 : 11;
  }

  function restyleMarkers() {
    for (const { receiver, entity } of layerState._renderById.values()) {
      entity.point.color = markerColor(receiver);
      entity.point.pixelSize = markerSize(receiver);
      entity.show = receiverMatchesFilter(receiver, layerState._filter);
    }
    updateSelectionEntity();
    governorRequestRender('web-receivers-restyle');
  }

  /** Replace the marker set with the accepted catalog. */
  function reconcile(receivers) {
    layerState._receivers = Object.freeze([...receivers]);
    layerState._byId = new Map(
      receivers.map((receiver) => [receiver.id, receiver]),
    );
    if (layerState._selectedId && !layerState._byId.has(layerState._selectedId))
      layerState._selectedId = null;
    layerState._highlightIds = new Set(
      [...layerState._highlightIds].filter((id) => layerState._byId.has(id)),
    );
    layerState._renderById.clear();
    if (!layerState._dataSource) return;
    layerState._dataSource.entities.removeAll();
    for (const receiver of receivers) {
      const position = markerPosition(receiver);
      const entity = layerState._dataSource.entities.add({
        id: `${WEB_RECEIVER_PREFIX}${receiver.id}`,
        position,
        show: receiverMatchesFilter(receiver, layerState._filter),
        point: {
          pixelSize: markerSize(receiver),
          color: markerColor(receiver),
          outlineColor: Cesium.Color.fromCssColorString(MARKER_OUTLINE_COLOR),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(
            100_000,
            1.2,
            12_000_000,
            1,
          ),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            GLOBE_INTERACTION_MAX_DISTANCE_M,
          ),
        },
      });
      layerState._renderById.set(receiver.id, { receiver, entity, position });
    }
    updateSelectionEntity();
    governorRequestRender('web-receivers-reconcile');
  }

  function updateSelectionEntity() {
    if (!layerState._viewer) return;
    const receiver = layerState._selectedId
      ? layerState._byId.get(layerState._selectedId)
      : null;
    if (!receiver) {
      if (layerState._selectedEntity)
        layerState._viewer.entities.remove(layerState._selectedEntity);
      layerState._selectedEntity = null;
      return;
    }
    const position = markerPosition(receiver, SELECTED_LIFT_M);
    const text = `${receiver.name}\n${receiver.typeLabel} · ${describeReceiverBands(receiver)}`;
    if (!layerState._selectedEntity) {
      layerState._selectedEntity = layerState._viewer.entities.add({
        id: `${WEB_RECEIVER_PREFIX}selected`,
        position,
        point: {
          pixelSize: 22,
          color: Cesium.Color.TRANSPARENT,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text,
          font: '12px "JetBrains Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -22),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor:
            Cesium.Color.fromCssColorString(MARKER_OUTLINE_COLOR).withAlpha(
              0.75,
            ),
        },
      });
    } else {
      layerState._selectedEntity.position = position;
      layerState._selectedEntity.label.text = text;
    }
    layerState._selectedEntity.show = parts.interaction.presentationAllowed();
    governorRequestRender('web-receivers-selection');
  }

  function installClusterStyling() {
    if (!layerState._dataSource || layerState._removeClusterListener) return;
    const clustering = layerState._dataSource.clustering;
    clustering.enabled = true;
    clustering.pixelRange = 38;
    clustering.minimumClusterSize = 3;
    clustering.clusterPoints = true;
    clustering.clusterLabels = false;
    clustering.clusterBillboards = false;
    layerState._removeClusterListener =
      clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
        const types = new Map();
        for (const entity of clusteredEntities) {
          const receiver = layerState._renderById.get(
            String(entity.id || '').slice(WEB_RECEIVER_PREFIX.length),
          )?.receiver;
          if (receiver)
            types.set(receiver.type, (types.get(receiver.type) || 0) + 1);
        }
        const dominant =
          [...types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'kiwisdr';
        cluster.point.id = clusteredEntities;
        cluster.billboard.id = clusteredEntities;
        cluster.label.show = false;
        cluster.label.text = '';
        cluster.point.show = true;
        cluster.point.pixelSize = Math.min(
          26,
          12 + Math.log2(clusteredEntities.length) * 1.6,
        );
        cluster.point.color = Cesium.Color.fromCssColorString(
          RECEIVER_TYPE_COLORS[dominant],
        ).withAlpha(0.85);
        cluster.point.outlineColor = Cesium.Color.BLACK;
        cluster.point.outlineWidth = 2;
        cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
        cluster.point.distanceDisplayCondition =
          new Cesium.DistanceDisplayCondition(
            0,
            GLOBE_INTERACTION_MAX_DISTANCE_M,
          );
      });
  }

  /** Fly to one receiver at a regional altitude. */
  function flyTo(receiver, { altitudeM = FLY_TO_ALTITUDE_M } = {}) {
    if (!layerState._viewer || !receiver) return false;
    layerState._viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        receiver.lon,
        receiver.lat,
        altitudeM,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
      duration: 2.2,
    });
    return true;
  }

  /** Frame several receivers at once (used after a voice search). */
  function frame(ids, { padding = 1.6 } = {}) {
    if (!layerState._viewer) return false;
    const points = (Array.isArray(ids) ? ids : [])
      .map((id) => layerState._byId.get(id))
      .filter(Boolean)
      .map((receiver) => markerPosition(receiver));
    if (!points.length) return false;
    const sphere = Cesium.BoundingSphere.fromPoints(points);
    sphere.radius = Math.max(sphere.radius * padding, 60_000);
    layerState._viewer.camera.flyToBoundingSphere(sphere, {
      duration: 2.4,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-60),
        sphere.radius * 2.6,
      ),
    });
    return true;
  }

  return {
    markerPosition,
    restyleMarkers,
    reconcile,
    updateSelectionEntity,
    installClusterStyling,
    flyTo,
    frame,
  };
}
