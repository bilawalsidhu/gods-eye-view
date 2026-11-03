import { t } from '../../../i18n/index.js';
import * as geo from '../../../geo/index.js';
import { distanceScale } from '../../../globe/cpuPicks.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { resolvePickId } from '../../../data/pickRegistry.js';
import { boxContains, alprCreditMarkup } from '../model.js';
import { createAlprFloorResolver } from '../floors.js';
import { createAlprNavaraOverlay } from './navaraOverlay.js';
import {
  MARKER_IMAGE,
  SELECTED_IMAGE,
  alprDisplayId,
  alprLabelDetails,
  validAlprGroundHeight,
} from '../visuals.js';
import {
  LAYER_ID,
  MAX_VIEWPORT_DEGREES,
  MAX_RENDERED,
  ALPR_COLOR,
  ALPR_SELECTED_COLOR,
  MARKER_ICON_SIZE,
  SELECTED_MARKER_ICON_SIZE,
  MARKER_FLOOR_LIFT_M,
  MARKER_SCALE_BY_DISTANCE,
} from '../policy.js';

/** Plain marker handles and bounded sprite sets; source ownership stays in the layer. */
export function createAlprNavaraRenderer(engine, { state, services, source }) {
  const markers = new Map();
  const floors = createAlprFloorResolver(services.groundFloor);
  let normal,
    selected,
    initialized = false;
  let visibleRecords = [],
    generation = 0,
    floorRequest = null;
  let removeMove, removeFrame, removeClick, removeCredit;
  let lastCamera = null,
    selectionStartedAt = 0;
  let spritesDirty = false;
  const request = () => engine.render.request('alpr-render');
  const cachedFloor = (record) =>
    services.groundFloor.cachedGroundFloor(record.latitude, record.longitude);
  const sampleHeight = (location) => {
    if (!engine.surface.supported) return undefined;
    try {
      return engine.surface.sampleHeight(location, [normal, selected]);
    } catch {
      return undefined;
    }
  };
  function surfaceHeight(record) {
    const location = geo.cartographic.fromDegrees(
      record.longitude,
      record.latitude,
    );
    let height = sampleHeight(location);
    if (!validAlprGroundHeight(height) && engine.surface.terrainHeightSupported)
      height = engine.surface.terrainHeight(location);
    if (!validAlprGroundHeight(height)) height = cachedFloor(record);
    return height;
  }
  function placement(record) {
    let height = cachedFloor(record);
    const clamped = !validAlprGroundHeight(height);
    if (clamped) height = surfaceHeight(record);
    return {
      clamped,
      resolved: validAlprGroundHeight(height),
      position: geo.cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        validAlprGroundHeight(height) ? height + MARKER_FLOOR_LIFT_M : 0,
      ),
    };
  }
  function viewportBox() {
    const { width, height } = engine.host.size();
    if (!width || !height) return null;
    const focus = engine.camera.pickEllipsoid({ x: width / 2, y: height / 2 });
    if (!focus) return null;
    const location = geo.cartographic.fromCartesian(focus);
    const radius = Math.max(
      1000,
      2 * geo.cartesian3.distance(engine.camera.livePosition, focus),
    );
    const latitude = geo.math.toDegrees(location.latitude);
    const longitude = geo.math.toDegrees(location.longitude);
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
  function viewRecords(records) {
    const box = viewportBox();
    if (!box) return { visible: [], capped: false };
    let visible = records.filter((r) =>
      boxContains(box, {
        south: r.latitude,
        north: r.latitude,
        west: r.longitude,
        east: r.longitude,
      }),
    );
    const capped = visible.length > MAX_RENDERED;
    if (capped) {
      const lat = (box.south + box.north) / 2,
        lon = (box.west + box.east) / 2;
      const scale = Math.cos((lat * Math.PI) / 180);
      visible = visible
        .map((record) => ({
          record,
          d:
            (record.latitude - lat) ** 2 +
            ((record.longitude - lon) * scale) ** 2,
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_RENDERED)
        .map(({ record }) => record);
    }
    return { visible, capped };
  }
  function syncMarker(marker) {
    if (!initialized) return;
    const position =
      marker.canvasOwned && marker.gevAlprCanvasPosition
        ? marker.gevAlprCanvasPosition
        : marker.position;
    const isSelected = marker.id === state.selectedId;
    const scale = marker.canvasOwned
      ? 1
      : distanceScale(
          MARKER_SCALE_BY_DISTANCE,
          geo.cartesian3.distance(engine.camera.livePosition, position),
        );
    const show =
      state.enabled &&
      marker.shown &&
      marker.resolved &&
      engine.projector.horizonVisible(position);
    const alpha = marker.canvasOwned ? 0.01 : 1;
    const previous = marker.drawn;
    if (
      previous &&
      previous.position === position &&
      previous.scale === scale &&
      previous.show === show &&
      previous.alpha === alpha &&
      previous.selected === isSelected
    )
      return;
    marker.drawn = { position, scale, show, alpha, selected: isSelected };
    const fields = {
      position,
      scale,
      show,
      color: [1, 1, 1, alpha],
      cell: 'camera',
      pickId: marker.id,
    };
    normal.set(marker.index, { ...fields, show: show && !isSelected });
    if (isSelected) {
      selected.setCount(1);
      selected.set(0, fields);
    }
    if (!spritesDirty) {
      // Canvas ownership can change during postRender. Navara clears its
      // request flag after that event; wake the next frame afterwards, while
      // retaining GPU uploads in preRender before the buffers are drawn.
      queueMicrotask(requestDirtySprites);
    }
    spritesDirty = true;
  }
  function requestDirtySprites() {
    if (spritesDirty) request();
  }
  function flushSprites() {
    if (!spritesDirty) return;
    normal.commit();
    selected.commit();
    spritesDirty = false;
  }
  const overlay = createAlprNavaraOverlay({
    engine,
    state,
    services,
    markers,
    sampleHeight,
    syncMarker,
    onSurfaceChange: refreshPlacements,
  });
  function refreshPlacements() {
    if (!state.enabled) return;
    generation++;
    floorRequest = null;
    floors.cancel();
    for (const marker of markers.values()) {
      Object.assign(marker, placement(marker.record));
      marker.drawn = null;
      syncMarker(marker);
    }
    resolveFloors();
    request();
  }
  async function prepareFloors(records) {
    const cold = viewRecords(records)
      .visible.filter((r) => !validAlprGroundHeight(cachedFloor(r)))
      .map((r) => ({ lat: r.latitude, lon: r.longitude }));
    if (!cold.length) return;
    try {
      await floors.prepare(cold);
    } catch {
      /* bounded unresolved floors */
    }
  }
  function resolveFloors() {
    if (
      floorRequest ||
      typeof services.groundFloor.resolveGroundFloorCells !== 'function'
    )
      return;
    const batch = [...markers.values()].filter((m) => m.clamped);
    if (!batch.length) return;
    const epoch = generation;
    const promise = Promise.resolve(
      floors.resolve(
        batch.map((m) => ({ lat: m.record.latitude, lon: m.record.longitude })),
      ),
    )
      .catch(() => {})
      .then(() => {
        if (epoch !== generation || floorRequest !== promise) return;
        floorRequest = null;
        if (!state.enabled) return;
        for (const marker of batch) {
          if (markers.get(marker.id) !== marker) continue;
          Object.assign(marker, placement(marker.record));
          syncMarker(marker);
        }
      });
    floorRequest = promise;
  }
  function updateAppearance(marker, active) {
    if (marker.gevLabelModel) {
      marker.gevLabelModel.accent = active ? ALPR_SELECTED_COLOR : ALPR_COLOR;
      marker.gevLabelModel.leaderAnimationStartedAt = active
        ? selectionStartedAt
        : 0;
    }
    syncMarker(marker);
  }
  function clearSelection() {
    const marker = markers.get(state.selectedId);
    state.selectedId = null;
    selectionStartedAt = 0;
    if (initialized) {
      selected.setCount(0);
      selected.commit();
    }
    if (marker) updateAppearance(marker, false);
    overlay.sync(visibleRecords);
    services.context.clearSelectedEntityContextForLayer(LAYER_ID);
    request();
  }
  function updateSelectedAnchor() {
    if (!state.enabled || !state.selectedId) return;
    if (services.context.getSelectedEntityContext()?.id !== state.selectedId) {
      clearSelection();
      return;
    }
    const marker = markers.get(state.selectedId);
    if (!marker) return;
    if (marker.gevAlprCanvasPosition) {
      marker.displayPosition = marker.gevAlprCanvasPosition;
      return;
    }
    if (Date.now() - state.lastAnchorSampleAt < 1000) return;
    state.lastAnchorSampleAt = Date.now();
    const height = surfaceHeight(marker.record);
    if (!validAlprGroundHeight(height)) return;
    const next = geo.cartesian3.fromDegrees(
      marker.record.longitude,
      marker.record.latitude,
      height,
    );
    if (
      !marker.displayPosition ||
      geo.cartesian3.distance(next, marker.displayPosition) > 0.1
    ) {
      marker.displayPosition = next;
      request();
    }
  }
  function selectRecord(id) {
    const marker = markers.get(id);
    if (!marker || !state.recordById.has(id)) return false;
    clearSelection();
    state.selectedId = id;
    selectionStartedAt = performance.now();
    updateAppearance(marker, true);
    state.lastAnchorSampleAt = 0;
    services.context.selectEntityContext(marker);
    updateSelectedAnchor();
    overlay.sync(visibleRecords);
    request();
    return true;
  }
  function registerContext(marker) {
    const record = marker.record;
    marker.gevTrackedId = record.id;
    marker.gevDisplayPosition = () => marker.displayPosition;
    marker.gevLabelModel = {
      title: alprDisplayId(record),
      details: alprLabelDetails(record, source),
      accent: ALPR_COLOR,
      cardStyle: 'tactical',
      selected: true,
      leaderStyle: 'elbow',
      leaderAnimationMs: 440,
      leaderAnimationStartedAt:
        record.id === state.selectedId ? selectionStartedAt : 0,
      leaderDrawRatio: 0.68,
      anchorRadiusPx: SELECTED_MARKER_ICON_SIZE / 2,
      anchorRadiusScale: null,
    };
    services.context.registerEntityContext(marker, {
      id: record.id,
      layerId: LAYER_ID,
      layerName: 'ALPR Cameras',
      source:
        source.attribution?.description || source.label || 'Camera source',
      label: t('ALPR camera'),
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
  function countOnScreen() {
    const { width, height } = engine.host.size();
    let count = 0;
    for (const marker of markers.values()) {
      if (!engine.projector.horizonVisible(marker.position)) continue;
      const p = engine.projector.worldToWindow(marker.position);
      if (p && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) count++;
    }
    return count;
  }
  function hideOnMapCredit() {
    removeCredit?.();
    removeCredit = null;
  }
  function presentOnMapCredit() {
    if (!state.enabled || removeCredit) return;
    const markup = alprCreditMarkup(source.attribution);
    if (markup) removeCredit = engine.credits.addStatic(markup);
  }
  function renderRecords() {
    const { visible, capped } = viewRecords(state.records);
    state.renderSaturated = capped;
    visibleRecords = visible;
    const current = services.context.getSelectedEntityContext();
    if (
      current?.layerId !== LAYER_ID ||
      current.id !== state.selectedId ||
      !visible.some((r) => r.id === state.selectedId)
    )
      clearSelection();
    const ids = new Set(visible.map((r) => r.id));
    let changed = false;
    for (const id of markers.keys())
      if (!ids.has(id)) {
        markers.delete(id);
        changed = true;
      }
    services.context.removeEntityContextsForLayer(LAYER_ID, { retainIds: ids });
    for (const record of visible) {
      let marker = markers.get(record.id);
      if (!marker) {
        marker = {
          id: record.id,
          record,
          ...placement(record),
          shown: true,
          canvasOwned: false,
          displayPosition: null,
        };
        markers.set(record.id, marker);
        changed = true;
      } else if (marker.record !== record) {
        const previous = marker.record;
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude
        ) {
          Object.assign(marker, placement(record));
          marker.displayPosition = null;
          marker.gevAlprCanvasPosition = null;
        }
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude ||
          previous.directionDeg !== record.directionDeg
        ) {
          marker.gevAlprCanvasPosition = null;
          marker.gevAlprWedge = null;
        }
        marker.record = record;
      }
      registerContext(marker);
    }
    normal.setCount(markers.size);
    let index = 0;
    for (const marker of markers.values()) {
      marker.index = index++;
      marker.drawn = null;
      updateAppearance(marker, marker.id === state.selectedId);
    }
    flushSprites();
    if (changed) state.renderRevision++;
    state.onScreen = countOnScreen();
    resolveFloors();
    updateSelectedAnchor();
    overlay.sync(visible);
    const chosen = markers.get(state.selectedId);
    if (chosen) services.overlays?.refreshReadout?.(chosen);
    if (visible.length) presentOnMapCredit();
    else hideOnMapCredit();
    request();
  }
  function clearRendered({ retainContext = false } = {}) {
    hideOnMapCredit();
    generation++;
    floors.cancel();
    floorRequest = null;
    overlay.clear();
    visibleRecords = [];
    markers.clear();
    if (initialized) {
      normal.setCount(0);
      selected.setCount(0);
      normal.commit();
      selected.commit();
      spritesDirty = false;
    }
    if (!retainContext) services.context.removeEntityContextsForLayer(LAYER_ID);
  }
  function frame() {
    const camera = engine.camera.livePosition;
    if (
      !lastCamera ||
      !geo.cartesian3.equalsEpsilon(camera, lastCamera, 0, 0.00001)
    ) {
      lastCamera = { ...camera };
      for (const marker of markers.values()) syncMarker(marker);
    }
    flushSprites();
    updateSelectedAnchor();
  }
  return {
    get ready() {
      return initialized;
    },
    count: () => markers.size,
    following: () => engine.camera.following(),
    viewportBox,
    prepareFloors,
    renderRecords,
    clearRendered,
    clearSelection,
    hideOnMapCredit,
    init(_viewer, { onMove }) {
      if (initialized) throw new Error('ALPR renderer is already initialized');
      const create = (id, sizePx, capacity, image, order) =>
        engine.movers.createSet({
          id,
          kind: 'sprite',
          capacity,
          order,
          pickable: true,
          depthTest: 'always',
          sharpen: true,
          sprite: {
            sizePx,
            atlas: { url: image, cells: { camera: [0, 0, 1, 1] } },
          },
        });
      normal = create(
        LAYER_ID,
        MARKER_ICON_SIZE,
        MAX_RENDERED,
        MARKER_IMAGE,
        50,
      );
      selected = create(
        'alpr-selected',
        SELECTED_MARKER_ICON_SIZE,
        1,
        SELECTED_IMAGE,
        51,
      );
      normal.setCount(0);
      selected.setCount(0);
      normal.commit();
      selected.commit();
      initialized = true;
      removeMove = engine.camera.moveEnd.addEventListener(onMove);
      removeFrame = engine.frames.preRender.addEventListener(frame);
      overlay.init();
    },
    setVisible(value) {
      removeClick?.();
      removeClick = null;
      if (value)
        removeClick = selectionDispatcherFor(engine).register(LAYER_ID, {
          owns: (id) => state.recordById.has(id),
          onClick({ position, picked }) {
            if (!state.enabled) return;
            const id = overlay.pick(position) || resolvePickId(picked);
            if (
              id &&
              state.recordById.has(id) &&
              (id !== state.selectedId ||
                services.context.getSelectedEntityContext()?.id !== id)
            )
              selectRecord(id);
            else if (state.selectedId) clearSelection();
          },
        });
    },
    focusNearest() {
      if (!state.enabled || engine.camera.following()) return false;
      let nearest,
        distance = Infinity;
      for (const marker of markers.values()) {
        const next = geo.cartesian3.distanceSquared(
          engine.camera.livePosition,
          marker.position,
        );
        if (next < distance) {
          nearest = marker;
          distance = next;
        }
      }
      if (!nearest || !selectRecord(nearest.id)) return false;
      const height = surfaceHeight(nearest.record);
      const center = geo.cartesian3.fromDegrees(
        nearest.record.longitude,
        nearest.record.latitude,
        validAlprGroundHeight(height) ? height : 0,
      );
      engine.camera.flyToSphere(
        { center, radius: 30 },
        {
          duration: 1.2,
          heading: engine.camera.pose().heading || 0,
          pitch: -Math.PI / 4,
          range: 800,
        },
      );
      request();
      return true;
    },
    destroy(options) {
      if (!initialized) return;
      clearRendered(options);
      overlay.destroy();
      removeClick?.();
      removeClick = null;
      removeMove?.();
      removeMove = null;
      removeFrame?.();
      removeFrame = null;
      normal?.destroy();
      selected?.destroy();
      initialized = false;
      lastCamera = null;
    },
  };
}
