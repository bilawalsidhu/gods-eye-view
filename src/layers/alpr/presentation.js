import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  LAYER_ID,
  MAX_VIEWPORT_DEGREES,
  MAX_RENDERED,
  ALPR_COLOR,
  ALPR_SELECTED_COLOR,
  MARKER_ICON_SIZE,
  SELECTED_MARKER_ICON_SIZE,
  CREDIT_DISPLAY_MS,
} from './policy.js';
import { boxContains } from './model.js';
import { createAlprOverlay } from './overlay.js';
import {
  MARKER_IMAGE,
  SELECTED_IMAGE,
  alprDisplayId,
  alprLabelDetails,
  directionWedgePositions,
  validAlprGroundHeight,
} from './visuals.js';

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
  const overlay = createAlprOverlay({ state, services });
  let visibleRecords = [];
  let selectionStartedAt = 0;

  function updateAppearance(entity, selected) {
    const color = Cesium.Color.fromCssColorString(
      selected ? ALPR_SELECTED_COLOR : ALPR_COLOR,
    );
    entity.billboard.image = selected ? SELECTED_IMAGE : MARKER_IMAGE;
    entity.billboard.width = entity.billboard.height = selected
      ? SELECTED_MARKER_ICON_SIZE
      : MARKER_ICON_SIZE;
    if (entity.polyline) {
      entity.polyline.width = selected ? 3 : 1.75;
      entity.polyline.material = color.withAlpha(selected ? 0.98 : 0.82);
    }
    if (entity.polygon)
      entity.polygon.material = color.withAlpha(selected ? 0.8 : 0.2);
    if (entity.gevLabelModel) {
      entity.gevLabelModel.accent = color.toCssColorString();
      entity.gevLabelModel.leaderAnimationStartedAt = selected
        ? selectionStartedAt
        : 0;
    }
  }

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
    overlay.clear();
    visibleRecords = [];
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
    visibleRecords = visible;
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
        updateAppearance(existing, record.id === state.selectedId);
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
        billboard: {
          image: selected ? SELECTED_IMAGE : MARKER_IMAGE,
          width: selected ? SELECTED_MARKER_ICON_SIZE : MARKER_ICON_SIZE,
          height: selected ? SELECTED_MARKER_ICON_SIZE : MARKER_ICON_SIZE,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(350, 1.15, 4_000_000, 0.48),
        },
      };
      const wedge = directionWedgePositions(record);
      if (wedge) {
        entityDef.polyline = {
          positions: [wedge[1], position, wedge[2]],
          width: selected ? 3 : 1.75,
          material: color.withAlpha(0.82),
          clampToGround: true,
        };
        entityDef.polygon = {
          hierarchy: wedge,
          material: color.withAlpha(0.2),
          height: 0,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          classificationType: Cesium.ClassificationType.BOTH,
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
        ) {
          entity.position = position;
          entity.gevAlprCanvasPosition = null;
          entity.gevAlprDisplayPosition = null;
        }
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude ||
          previous.directionDeg !== record.directionDeg
        ) {
          entity.polyline = entityDef.polyline;
          entity.polygon = entityDef.polygon;
          entity.gevAlprCanvasPosition = null;
          entity.gevAlprWedge = null;
        }
      }
      entity.gevAlprRecord = record;
      entity.gevTrackedId = record.id;
      // The mapped camera datum has no elevation; it is not the clamped marker's
      // visual anchor. Only the selected marker samples the rendered surface,
      // at most once per second, through Cesium's public height APIs.
      entity.gevAlprDisplayPosition ??= null;
      entity.gevDisplayPosition = () => entity.gevAlprDisplayPosition;
      entity.gevLabelModel = {
        title: alprDisplayId(record),
        details: alprLabelDetails(record, source),
        accent: color.toCssColorString(),
        cardStyle: 'tactical',
        selected: true,
        leaderStyle: 'elbow',
        leaderAnimationMs: 440,
        leaderAnimationStartedAt: selected ? selectionStartedAt : 0,
        leaderDrawRatio: 0.68,
        anchorRadiusPx: SELECTED_MARKER_ICON_SIZE / 2,
        anchorRadiusScale: null,
      };
      updateAppearance(entity, selected);
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
    overlay.sync(visible);
    if (selectedEntity) services.overlays?.refreshReadout?.(selectedEntity);
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
    if (!validAlprGroundHeight(height) && state.viewer.scene.globe.show)
      height = state.viewer.scene.globe.getHeight?.(location);
    if (!validAlprGroundHeight(height))
      height = cachedGroundFloor(record.latitude, record.longitude);
    const center = Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      validAlprGroundHeight(height) ? height : 0,
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
    selectionStartedAt = globalThis.performance?.now?.() ?? Date.now();
    updateAppearance(entity, true);
    state.lastAnchorSampleAt = 0;
    selectEntityContext(entity);
    updateSelectedAnchor();
    overlay.sync(visibleRecords);
    governorRequestRender('alpr-selection');
    return true;
  }

  function clearSelection() {
    const entity = state.selectedId
      ? state.dataSource?.entities.getById(state.selectedId)
      : null;
    const record = state.recordById.get(state.selectedId);
    if (entity && record) updateAppearance(entity, false);
    state.selectedId = null;
    selectionStartedAt = 0;
    overlay.sync(visibleRecords);
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
    if (entity?.gevAlprCanvasPosition) {
      entity.gevAlprDisplayPosition = entity.gevAlprCanvasPosition;
      return;
    }
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
    if (!validAlprGroundHeight(height) && scene.globe.show)
      height = scene.globe.getHeight?.(location);
    if (!validAlprGroundHeight(height))
      height = cachedGroundFloor(record.latitude, record.longitude);
    if (!validAlprGroundHeight(height)) return;
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
      const id =
        overlay.pick(click.position) ||
        (typeof picked?.id?.id === 'string' ? picked.id.id : null);
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
    initOverlay: () => overlay.init(),
    destroyOverlay: () => overlay.destroy(),
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
