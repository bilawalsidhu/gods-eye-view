import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  LAYER_ID,
  MAX_VIEWPORT_DEGREES,
  MAX_RENDERED,
  DIRECTION_CONE_M,
  ALPR_COLOR,
  CREDIT_DISPLAY_MS,
} from './policy.js';
import { boxContains, destinationPointDeg } from './model.js';

export function createAlprPresentation({ state, services, source }) {
  const { governorRequestRender } = services.render;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context;

  const { cachedGroundFloor } = services.groundFloor;

  function markerColor() {
    return Cesium.Color.fromCssColorString(ALPR_COLOR);
  }

  // The horizon rectangle is unstable during low-angle orbits and can exclude
  // the ground point in the center of the screen. Bound nearby coverage around
  // that point instead; the camera-to-ground range keeps zoom-out queries capped.
  function viewportBox(viewer) {
    const camera = viewer?.camera;
    const canvas = viewer?.scene.canvas;
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
      const radius = Math.max(1000, 2 * range);
      const latitude = Cesium.Math.toDegrees(location.latitude);
      const longitude = Cesium.Math.toDegrees(location.longitude);
      const latSpan = radius / 111000;
      const lonSpan = latSpan / Math.cos(location.latitude);
      if (
        !Number.isFinite(latSpan + lonSpan) ||
        2 * Math.max(latSpan, lonSpan) > MAX_VIEWPORT_DEGREES ||
        Math.abs(latitude) + latSpan > 90 ||
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
    // Rectangle-only viewers retain the same bounded-area contract.
    const rectangle = viewer?.camera?.computeViewRectangle(
      viewer.scene.globe.ellipsoid,
    );
    if (!rectangle) return null;
    const south = Cesium.Math.toDegrees(rectangle.south);
    const north = Cesium.Math.toDegrees(rectangle.north);
    const west = Cesium.Math.toDegrees(rectangle.west);
    const east = Cesium.Math.toDegrees(rectangle.east);
    if (
      !Number.isFinite(south + north + west + east) ||
      east <= west ||
      north - south > MAX_VIEWPORT_DEGREES ||
      east - west > MAX_VIEWPORT_DEGREES
    )
      return null;
    return { south, west, north, east };
  }

  function clearRendered() {
    if (state.dataSource?.entities) state.dataSource.entities.removeAll();
    removeEntityContextsForLayer(LAYER_ID);
  }

  function hideOnMapCredit() {
    clearTimeout(state.creditTimer);
    state.creditTimer = null;
    if (state.credit)
      state.viewer?.creditDisplay?.removeStaticCredit(state.credit);
    governorRequestRender('alpr-credit');
  }

  function presentOnMapCredit() {
    if (!state.enabled || state.creditPresented || !state.credit) return;
    state.creditPresented = true;
    state.viewer.creditDisplay?.addStaticCredit(state.credit);
    state.creditTimer = setTimeout(hideOnMapCredit, CREDIT_DISPLAY_MS);
    governorRequestRender('alpr-credit');
  }

  function renderRecords() {
    const selectedContext = getSelectedEntityContext();
    const box = viewportBox(state.viewer);
    const visible = box
      ? state.records
          .filter((record) =>
            boxContains(box, {
              south: record.latitude,
              north: record.latitude,
              west: record.longitude,
              east: record.longitude,
            }),
          )
          .slice(0, MAX_RENDERED)
      : [];
    // A refresh may retain its own selection, never reclaim one cleared or
    // replaced by an aircraft, another layer, or a voice action.
    if (
      selectedContext?.layerId !== LAYER_ID ||
      selectedContext.id !== state.selectedId ||
      !visible.some((record) => record.id === state.selectedId)
    ) {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
    }
    governorRequestRender('alpr-render');
    const visibleIds = new Set(visible.map((record) => record.id));
    for (const entity of [...state.dataSource.entities.values]) {
      if (!visibleIds.has(entity.id)) state.dataSource.entities.remove(entity);
    }
    removeEntityContextsForLayer(LAYER_ID, { retainIds: visibleIds });
    for (const record of visible) {
      const existing = state.dataSource.entities.getById(record.id);
      if (existing?.gevAlprRecord === record) {
        existing.point.pixelSize = record.id === state.selectedId ? 12 : 8;
        existing.point.color =
          record.id === state.selectedId ? Cesium.Color.WHITE : markerColor();
        continue;
      }
      const color = markerColor();
      const selected = record.id === state.selectedId;
      const position = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
      );
      const entityDef = {
        id: record.id,
        position,
        point: {
          pixelSize: selected ? 12 : 8,
          color: selected ? Cesium.Color.WHITE : color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      };
      if (Number.isFinite(record.directionDeg)) {
        const tip = destinationPointDeg(
          record.latitude,
          record.longitude,
          record.directionDeg,
          DIRECTION_CONE_M,
        );
        entityDef.polyline = {
          positions: [
            position,
            Cesium.Cartesian3.fromDegrees(tip.longitude, tip.latitude),
          ],
          width: 2,
          material: color.withAlpha(0.85),
          clampToGround: true,
        };
      }
      let entity = existing;
      // Keep the Cesium entity and its ground-clamping subscription while its
      // geometry is unchanged. Updating metadata must not rebuild the marker.
      const previous = entity?.gevAlprRecord;
      if (!entity) entity = state.dataSource.entities.add(entityDef);
      else {
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude
        )
          entity.position = position;
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude ||
          previous.directionDeg !== record.directionDeg
        )
          entity.polyline = entityDef.polyline;
        entity.point.pixelSize = selected ? 12 : 8;
        entity.point.color = selected ? Cesium.Color.WHITE : color;
      }
      entity.gevAlprRecord = record;
      entity.gevTrackedId = record.id;
      // The mapped camera datum has no elevation; it is not the clamped marker's
      // visual anchor. Only the selected marker samples the rendered surface,
      // at most once per second, through Cesium's public height APIs.
      entity.gevAlprDisplayPosition ??= null;
      entity.gevDisplayPosition = () => entity.gevAlprDisplayPosition;
      entity.gevLabelModel = {
        title: 'ALPR CAMERA',
        details: [
          record.manufacturer ? `Manufacturer: ${record.manufacturer}` : null,
          record.operator ? `Operator: ${record.operator}` : null,
          record.cameraType ? `Type: ${record.cameraType}` : null,
          `Source: ${source.attribution?.name || source.label || 'Camera source'}`,
        ].filter(Boolean),
        accent: color.toCssColorString(),
      };
      registerEntityContext(entity, {
        id: record.id,
        layerId: LAYER_ID,
        dataSource: state.dataSource,
        layerName: 'ALPR Cameras',
        source:
          source.attribution?.description || source.label || 'Camera source',
        label: 'ALPR camera',
        latitude: record.latitude,
        longitude: record.longitude,
        properties: {
          operator: record.operator,
          manufacturer: record.manufacturer,
          cameraType: record.cameraType,
          zone: record.zone,
          directionDeg: record.directionDeg,
          ref: record.ref,
          lastVerified: record.lastVerified,
          osmId: record.osmId,
          sourceTag: record.source,
        },
      });
    }
    const selectedEntity = state.selectedId
      ? state.dataSource.entities.getById(state.selectedId)
      : null;
    if (!selectedEntity) state.selectedId = null;
    updateSelectedAnchor();
    // Start only when mapped data is actually displayed, not while an upstream
    // request or a zoom-in prompt could consume the five-second introduction.
    if (visible.length) presentOnMapCredit();
  }

  function focusNearest() {
    const camera = state.viewer?.camera;
    if (!state.enabled || !camera?.positionWC || state.viewer.trackedEntity)
      return false;
    let nearest = null,
      distance = Infinity;
    for (const entity of state.dataSource.entities.values) {
      const position = entity.position.getValue(Cesium.JulianDate.now());
      const candidate = Cesium.Cartesian3.distanceSquared(
        camera.positionWC,
        position,
      );
      if (candidate < distance) {
        nearest = entity;
        distance = candidate;
      }
    }
    if (!nearest) return false;
    const record = state.recordById.get(nearest.id);
    const location = Cesium.Cartographic.fromDegrees(
      record.longitude,
      record.latitude,
    );
    let height;
    if (state.viewer.scene.sampleHeightSupported) {
      try {
        height = state.viewer.scene.sampleHeight(location, [nearest]);
      } catch {
        /* tiles may still be streaming */
      }
    }
    if (!Number.isFinite(height) && state.viewer.scene.globe.show)
      height = state.viewer.scene.globe.getHeight?.(location);
    if (!Number.isFinite(height) || height < -500 || height > 10000)
      height = cachedGroundFloor(record.latitude, record.longitude);
    const center = Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      Number.isFinite(height) ? height : 0,
    );
    if (!selectRecord(nearest.id)) return false;
    camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 30), {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(
        camera.heading || 0,
        -Math.PI / 4,
        800,
      ),
    });
    governorRequestRender('alpr-focus');
    return true;
  }

  function selectRecord(id) {
    const entity = state.dataSource?.entities.getById(id);
    if (!entity || !state.recordById.has(id)) return false;
    clearSelection();
    state.selectedId = id;
    entity.point.pixelSize = 12;
    entity.point.color = Cesium.Color.WHITE;
    state.lastAnchorSampleAt = 0;
    selectEntityContext(entity);
    updateSelectedAnchor();
    governorRequestRender('alpr-selection');
    return true;
  }

  function clearSelection() {
    const entity = state.selectedId
      ? state.dataSource?.entities.getById(state.selectedId)
      : null;
    const record = state.recordById.get(state.selectedId);
    if (entity && record) {
      entity.point.pixelSize = 8;
      entity.point.color = markerColor();
    }
    state.selectedId = null;
    clearSelectedEntityContextForLayer(LAYER_ID);
    governorRequestRender('alpr-selection');
  }

  function updateSelectedAnchor() {
    if (!state.enabled || !state.selectedId) return;
    const selected = getSelectedEntityContext();
    if (selected?.id !== state.selectedId) {
      clearSelection();
      return;
    }
    const entity = state.dataSource?.entities.getById(state.selectedId);
    const record = state.recordById.get(state.selectedId);
    if (!entity || !record || Date.now() - state.lastAnchorSampleAt < 1000)
      return;
    state.lastAnchorSampleAt = Date.now();
    const scene = state.viewer.scene;
    const location = Cesium.Cartographic.fromDegrees(
      record.longitude,
      record.latitude,
    );
    let height;
    if (scene.sampleHeightSupported) {
      try {
        height = scene.sampleHeight(location, [entity]);
      } catch {
        /* tiles may still be streaming */
      }
    }
    if (!Number.isFinite(height) && scene.globe.show)
      height = scene.globe.getHeight?.(location);
    if (!Number.isFinite(height))
      height = cachedGroundFloor(record.latitude, record.longitude);
    if (!Number.isFinite(height)) return;
    const next = Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      height,
    );
    if (
      !entity.gevAlprDisplayPosition ||
      Cesium.Cartesian3.distance(next, entity.gevAlprDisplayPosition) > 0.1
    ) {
      entity.gevAlprDisplayPosition = next;
      governorRequestRender('alpr-anchor');
    }
  }

  function installInteraction(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state.clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!state.enabled) return;
      const picked = viewer.scene.pick(click.position);
      const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
      if (
        id &&
        state.recordById.has(id) &&
        (id !== state.selectedId || getSelectedEntityContext()?.id !== id)
      )
        selectRecord(id);
      else if (state.selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  return {
    markerColor,
    viewportBox,
    clearRendered,
    hideOnMapCredit,
    presentOnMapCredit,
    renderRecords,
    selectRecord,
    focusNearest,
    clearSelection,
    updateSelectedAnchor,
    installInteraction,
  };
}
