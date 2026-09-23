import * as Cesium from 'cesium';
import {
  repeaterColor,
  repeaterDetails,
  repeaterLabel,
  repeaterMatchesFilter,
  repeaterProvenance,
} from '../../sources/hamRepeaters.js';
import {
  FLY_ALTITUDE_M,
  GLOBE_INTERACTION_MAX_DISTANCE_M,
  HAM_REPEATERS_LAYER_ID,
  LABEL_FONT,
  MARKER_LIFT_M,
  OUTLINE_COLOR,
  REPEATER_PREFIX,
  SELECTED_LIFT_M,
} from './policy.js';

export function createRendering({ state: layerState, services, parts }) {
  const { cachedGroundFloor } = services.ground;
  const { governorRequestRender } = services.render;
  const {
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
  } = services.context;

  function cssColor(hex, alpha = 1) {
    return Cesium.Color.fromCssColorString(hex || '#ffffff').withAlpha(alpha);
  }

  function markerPosition(repeater, liftM = MARKER_LIFT_M) {
    const floor = cachedGroundFloor(repeater.lat, repeater.lon);
    return Cesium.Cartesian3.fromDegrees(
      repeater.lon,
      repeater.lat,
      (Number.isFinite(floor) ? floor : 0) + liftM,
    );
  }

  function markerColor(repeater) {
    const base = cssColor(repeaterColor(repeater.kind));
    const status = String(repeater.status || '').toLowerCase();
    if (status.includes('off') || status.includes('closed'))
      return base.withAlpha(0.35);
    return base.withAlpha(0.9);
  }

  function markerSize(repeater) {
    return layerState._selectedId === repeater.id ? 14 : 10;
  }

  function labelGraphics(pixelOffsetY) {
    return {
      text: '',
      font: LABEL_FONT,
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, pixelOffsetY),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: cssColor(OUTLINE_COLOR, 0.75),
    };
  }

  /** The click card and voice read these; the row's provenance travels with it. */
  function contextMetadata(repeater) {
    return {
      id: repeater.id,
      layerId: HAM_REPEATERS_LAYER_ID,
      dataSource: layerState._dataSource,
      layerName: 'Repeaters',
      source: repeater.sourceLabel,
      label: repeaterLabel(repeater),
      latitude: repeater.lat,
      longitude: repeater.lon,
      properties: {
        callsign: repeater.callsign,
        kind: repeater.kind,
        module: repeater.module,
        outputHz: repeater.outputHz,
        inputHz: repeater.inputHz,
        offsetHz: repeater.offsetHz,
        band: repeater.band,
        toneHz: repeater.toneHz,
        toneBurstHz: repeater.toneBurstHz,
        echolink: repeater.echolink,
        allstar: repeater.allstar,
        irlp: repeater.irlp,
        wires: repeater.wires,
        city: repeater.city,
        region: repeater.region,
        country: repeater.country,
        distanceKm: repeater.distanceKm,
        status: repeater.status,
        statusKnown: repeater.statusKnown,
        positionPrecise: repeater.positionPrecise,
        confidence: repeater.confidence,
        recordUpdatedAt: repeater.recordUpdatedAt,
        sourceUrl: repeater.sourceUrl,
        details: repeaterDetails(repeater),
        provenance: repeaterProvenance(repeater),
      },
    };
  }

  function addMarker(repeater) {
    const position = markerPosition(repeater);
    const entity = layerState._dataSource.entities.add({
      id: `${REPEATER_PREFIX}${repeater.id}`,
      position,
      show: repeaterMatchesFilter(repeater, layerState._filter),
      point: {
        pixelSize: markerSize(repeater),
        color: markerColor(repeater),
        outlineColor: cssColor(OUTLINE_COLOR),
        outlineWidth: repeater.positionPrecise === false ? 2 : 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(50_000, 1.2, 3_000_000, 0.9),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          GLOBE_INTERACTION_MAX_DISTANCE_M,
        ),
      },
    });
    registerEntityContext(entity, contextMetadata(repeater));
    layerState._renderById.set(repeater.id, { repeater, entity, position });
  }

  /** Replace the marker set with a new result. */
  function reconcile(repeaters) {
    layerState._repeaters = Object.freeze([...repeaters]);
    layerState._byId = new Map(repeaters.map((row) => [row.id, row]));
    if (
      layerState._selectedId &&
      !layerState._byId.has(layerState._selectedId)
    ) {
      layerState._selectedId = null;
      clearSelectedEntityContextForLayer(HAM_REPEATERS_LAYER_ID);
    }
    if (layerState._hoverId && !layerState._byId.has(layerState._hoverId))
      setHover(null);
    layerState._renderById.clear();
    if (!layerState._dataSource) return;
    layerState._dataSource.entities.removeAll();
    removeEntityContextsForLayer(HAM_REPEATERS_LAYER_ID);
    for (const repeater of repeaters) addMarker(repeater);
    updateSelectionEntity();
    governorRequestRender('ham-repeaters-reconcile');
  }

  function restyleMarkers() {
    for (const { repeater, entity } of layerState._renderById.values()) {
      entity.point.color = markerColor(repeater);
      entity.point.pixelSize = markerSize(repeater);
      entity.show = repeaterMatchesFilter(repeater, layerState._filter);
    }
    updateSelectionEntity();
    governorRequestRender('ham-repeaters-restyle');
  }

  function updateSelectionEntity() {
    if (!layerState._viewer) return;
    const repeater = layerState._selectedId
      ? layerState._byId.get(layerState._selectedId)
      : null;
    if (!repeater) {
      if (layerState._selectedEntity)
        layerState._viewer.entities.remove(layerState._selectedEntity);
      layerState._selectedEntity = null;
      return;
    }
    const position = markerPosition(repeater, SELECTED_LIFT_M);
    const text = `${repeaterLabel(repeater)}\n${repeaterDetails(repeater)}\n${repeaterProvenance(repeater)}`;
    if (!layerState._selectedEntity) {
      layerState._selectedEntity = layerState._viewer.entities.add({
        id: `${REPEATER_PREFIX}selected`,
        position,
        point: {
          pixelSize: 22,
          color: Cesium.Color.TRANSPARENT,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: { ...labelGraphics(-22), text },
      });
    } else {
      layerState._selectedEntity.position = position;
      layerState._selectedEntity.label.text = text;
    }
    layerState._selectedEntity.show = parts.interaction.presentationAllowed();
  }

  /** A hover label for a marker that is not the selected one. */
  function setHover(id) {
    const next = id && id !== layerState._selectedId ? id : null;
    if (next === layerState._hoverId && (next || !layerState._hoverEntity))
      return;
    layerState._hoverId = next;
    const repeater = next ? layerState._byId.get(next) : null;
    if (!repeater || !layerState._viewer) {
      if (layerState._hoverEntity) layerState._hoverEntity.show = false;
      governorRequestRender('ham-repeaters-hover');
      return;
    }
    const position = markerPosition(repeater, SELECTED_LIFT_M);
    if (!layerState._hoverEntity) {
      layerState._hoverEntity = layerState._viewer.entities.add({
        id: `${REPEATER_PREFIX}hover`,
        position,
        label: { ...labelGraphics(-16), text: repeaterLabel(repeater) },
      });
    } else {
      layerState._hoverEntity.position = position;
      layerState._hoverEntity.label.text = repeaterLabel(repeater);
    }
    layerState._hoverEntity.show = parts.interaction.presentationAllowed();
    governorRequestRender('ham-repeaters-hover');
  }

  function installClusterStyling() {
    if (!layerState._dataSource || layerState._removeClusterListener) return;
    const clustering = layerState._dataSource.clustering;
    clustering.enabled = true;
    clustering.pixelRange = 34;
    clustering.minimumClusterSize = 3;
    clustering.clusterPoints = true;
    clustering.clusterLabels = false;
    clustering.clusterBillboards = false;
    layerState._removeClusterListener =
      clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
        const kinds = new Map();
        for (const entity of clusteredEntities) {
          const repeater = layerState._renderById.get(
            String(entity.id || '').slice(REPEATER_PREFIX.length),
          )?.repeater;
          if (repeater)
            kinds.set(repeater.kind, (kinds.get(repeater.kind) || 0) + 1);
        }
        const dominant =
          [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'FM';
        cluster.point.id = clusteredEntities;
        cluster.billboard.id = clusteredEntities;
        cluster.label.show = false;
        cluster.label.text = '';
        cluster.point.show = true;
        cluster.point.pixelSize = Math.min(
          26,
          12 + Math.log2(clusteredEntities.length) * 1.6,
        );
        cluster.point.color = cssColor(repeaterColor(dominant), 0.85);
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

  /** Publish the selection to the context store (click card, HUD, voice). */
  function syncSelectionContext() {
    const entry = layerState._selectedId
      ? layerState._renderById.get(layerState._selectedId)
      : null;
    if (entry) selectEntityContext(entry.entity);
    else clearSelectedEntityContextForLayer(HAM_REPEATERS_LAYER_ID);
  }

  function flyTo(repeater, { altitudeM = FLY_ALTITUDE_M } = {}) {
    if (!layerState._viewer || !repeater) return false;
    layerState._viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        repeater.lon,
        repeater.lat,
        altitudeM,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
      duration: 2.0,
    });
    return true;
  }

  /** Frame every visible repeater. */
  function frame({ padding = 1.5 } = {}) {
    if (!layerState._viewer) return false;
    const points = parts.queries
      .visibleRepeaters()
      .map((repeater) => markerPosition(repeater));
    if (!points.length) return false;
    const sphere = Cesium.BoundingSphere.fromPoints(points);
    sphere.radius = Math.max(sphere.radius * padding, 20_000);
    layerState._viewer.camera.flyToBoundingSphere(sphere, {
      duration: 2.2,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-60),
        sphere.radius * 2.6,
      ),
    });
    return true;
  }

  function clearRendered() {
    layerState._dataSource?.entities.removeAll();
    layerState._renderById.clear();
    removeEntityContextsForLayer(HAM_REPEATERS_LAYER_ID);
  }

  return {
    markerPosition,
    reconcile,
    restyleMarkers,
    updateSelectionEntity,
    setHover,
    installClusterStyling,
    syncSelectionContext,
    flyTo,
    frame,
    clearRendered,
  };
}
